const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI, ERC20_ABI, POOL_ABI, POSITION_MANAGER_ABI } = require("./abis");
const db = require("./db");

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
  staticNetwork: true,
});

const factory = new ethers.Contract(config.factoryAddress, FACTORY_ABI, provider);
const positionManager = new ethers.Contract(
  config.positionManagerAddress,
  POSITION_MANAGER_ABI,
  provider
);

// Function name fragments that, if present in a verified contract's ABI,
// mean the owner/deployer can do something that puts your funds at risk.
const RISKY_FUNCTION_KEYWORDS = [
  "mint",
  "blacklist",
  "blocklist",
  "pause",
  "freeze",
  "setfee",
  "excludefromfee",
  "setmaxtx",
  "setmaxwallet",
  "rescuetoken",
  "withdrawtoken",
  "setrouter",
];

// Chunk eth_getLogs calls so we don't blow past provider block-range limits.
const LOG_CHUNK_SIZE = 2000;

async function getLogsChunked(contract, eventFilter, fromBlock, toBlock) {
  const allLogs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + LOG_CHUNK_SIZE - 1, toBlock);
    try {
      const logs = await contract.queryFilter(eventFilter, start, end);
      allLogs.push(...logs);
    } catch (err) {
      console.error(`Log fetch failed for blocks ${start}-${end}:`, err.message);
    }
    start = end + 1;
  }
  return allLogs;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function checkContractVerification(address) {
  const data = await fetchJson(`${config.explorerApi}/smart-contracts/${address}`);
  if (!data) return { verified: false, riskyFunctions: [], creator: null };

  const abiText = JSON.stringify(data.abi || []).toLowerCase();
  const riskyFunctions = RISKY_FUNCTION_KEYWORDS.filter((kw) => abiText.includes(kw));

  return {
    verified: true,
    riskyFunctions,
    creator: (data.creator_address_hash || null),
  };
}

async function findLpLockStatus(poolAddress, fromBlock) {
  // Look for NFT (LP position) mints shortly after pool creation, then
  // check where that position NFT currently lives.
  try {
    const toBlock = fromBlock + 200;
    const mintFilter = positionManager.filters.Transfer(ethers.ZeroAddress, null, null);
    const mintLogs = await getLogsChunked(positionManager, mintFilter, fromBlock, toBlock);

    for (const log of mintLogs) {
      const tokenId = log.args.tokenId;
      let pos;
      try {
        pos = await positionManager.positions(tokenId);
      } catch {
        continue;
      }
      // Rough match: does this position reference tokens from our pool?
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [poolToken0, poolToken1] = await Promise.all([
        poolContract.token0(),
        poolContract.token1(),
      ]);
      if (
        pos.token0.toLowerCase() !== poolToken0.toLowerCase() ||
        pos.token1.toLowerCase() !== poolToken1.toLowerCase()
      ) {
        continue;
      }

      const currentOwner = (await positionManager.ownerOf(tokenId)).toLowerCase();
      if (config.burnAddresses.has(currentOwner)) {
        return { status: "burned", owner: currentOwner };
      }
      if (config.knownLockerContracts.has(currentOwner)) {
        return { status: "locked", owner: currentOwner };
      }
      return { status: "unlocked", owner: currentOwner };
    }
  } catch (err) {
    console.error("LP lock check failed:", err.message);
  }
  return { status: "unknown", owner: null };
}

async function analyzeNewToken(newTokenAddress, baseTokenAddress, poolAddress, blockNumber) {
  const token = new ethers.Contract(newTokenAddress, ERC20_ABI, provider);
  const baseToken = new ethers.Contract(baseTokenAddress, ERC20_ABI, provider);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

  const [name, symbol, decimals, totalSupply, baseBalanceInPool, baseSymbol] =
    await Promise.all([
      token.name().catch(() => "Unknown"),
      token.symbol().catch(() => "???"),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => 0n),
      baseToken.balanceOf(poolAddress).catch(() => 0n),
      baseToken.symbol().catch(() => "?"),
    ]);

  const verification = await checkContractVerification(newTokenAddress);

  let creatorHoldingPct = null;
  if (verification.creator) {
    try {
      const creatorBalance = await token.balanceOf(verification.creator);
      if (totalSupply > 0n) {
        creatorHoldingPct = Number((creatorBalance * 10000n) / totalSupply) / 100;
      }
    } catch {
      creatorHoldingPct = null;
    }
  }

  const lpLock = await findLpLockStatus(poolAddress, blockNumber);

  const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));

  const isSafu =
    verification.verified &&
    verification.riskyFunctions.length === 0 &&
    creatorHoldingPct !== null &&
    creatorHoldingPct < config.safuMaxDeployerPct &&
    lpLock.status !== "unlocked";

  return {
    tokenAddress: newTokenAddress.toLowerCase(),
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    poolAddress: poolAddress.toLowerCase(),
    baseSymbol,
    baseLiquidity: baseLiquidityFormatted,
    verified: verification.verified,
    riskyFunctions: verification.riskyFunctions,
    creator: verification.creator,
    creatorHoldingPct,
    lpLockStatus: lpLock.status,
    lpOwner: lpLock.owner,
    isSafu,
    blockNumber,
    scannedAt: Date.now(),
  };
}

async function scanOnce() {
  const currentBlock = await provider.getBlockNumber();
  let fromBlock = db.getLastScannedBlock();

  if (!fromBlock) {
    // First run: only look back a modest window so we don't hammer the RPC.
    fromBlock = currentBlock - 5000;
  } else {
    fromBlock = fromBlock + 1;
  }

  if (fromBlock > currentBlock) {
    return { scanned: 0, newTokens: 0 };
  }

  console.log(`Scanning blocks ${fromBlock} -> ${currentBlock}`);
  const filter = factory.filters.PoolCreated();
  const logs = await getLogsChunked(factory, filter, fromBlock, currentBlock);

  let newTokenCount = 0;

  for (const log of logs) {
    const { token0, token1, pool } = log.args;
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    const t0IsBase = config.knownBaseTokens.has(t0);
    const t1IsBase = config.knownBaseTokens.has(t1);

    // Only process pools where exactly one side is a known base asset
    // (i.e. a new token paired against ETH/WETH/USDG).
    if (t0IsBase === t1IsBase) continue;

    const newToken = t0IsBase ? t1 : t0;
    const baseToken = t0IsBase ? t0 : t1;

    try {
      const record = await analyzeNewToken(newToken, baseToken, pool, log.blockNumber);

      if (record.baseLiquidity < config.minLiquidityEth) {
        continue; // too thin to matter
      }

      db.upsertToken(record);
      newTokenCount += 1;
      console.log(`New token recorded: ${record.symbol} (${record.tokenAddress})`);
    } catch (err) {
      console.error(`Failed to analyze token ${newToken}:`, err.message);
    }
  }

  db.setLastScannedBlock(currentBlock);
  return { scanned: logs.length, newTokens: newTokenCount };
}

module.exports = { scanOnce };
