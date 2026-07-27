const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI, ERC20_ABI, POOL_ABI, POSITION_MANAGER_ABI } = require("./abis");
const db = require("./db");

// Simple in-memory cache for ETH/USD so we don't hit the price API on every token.
let ethPriceCache = { value: null, fetchedAt: 0 };
const ETH_PRICE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getEthUsdPrice() {
  const now = Date.now();
  if (ethPriceCache.value && now - ethPriceCache.fetchedAt < ETH_PRICE_TTL_MS) {
    return ethPriceCache.value;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const data = await res.json();
    const price = data?.ethereum?.usd;
    if (price) {
      ethPriceCache = { value: price, fetchedAt: now };
      return price;
    }
  } catch (err) {
    console.error("ETH price fetch failed:", err.message);
  }
  return ethPriceCache.value; // fall back to stale cache if the fetch failed
}

// Stablecoins we treat as ~$1 directly, so we don't need a price lookup for them.
const USD_STABLE_BASES = new Set([
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
]);

function formatCompactUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

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
  if (!data) return { verified: false, riskyFunctions: [] };

  const abiText = JSON.stringify(data.abi || []).toLowerCase();
  const riskyFunctions = RISKY_FUNCTION_KEYWORDS.filter((kw) => abiText.includes(kw));

  return { verified: true, riskyFunctions };
}

async function fetchTopHolderPct(tokenAddress, poolAddress) {
  const data = await fetchJson(`${config.explorerApi}/tokens/${tokenAddress}/holders`);
  if (!data || !Array.isArray(data.items)) return { pct: null, holder: null };

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  for (const item of data.items) {
    const holderAddress = (item.address?.hash || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;

    const pct = Number(item.percentage ?? item.token_id_percentage ?? null);
    if (!Number.isNaN(pct) && pct !== null) {
      return { pct, holder: holderAddress };
    }
    // Fallback if the API doesn't give a percentage directly.
    return { pct: null, holder: holderAddress };
  }

  return { pct: null, holder: null };
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

  const [name, symbol, decimals, totalSupply, baseBalanceInPool, baseSymbol, newTokenBalanceInPool] =
    await Promise.all([
      token.name().catch(() => "Unknown"),
      token.symbol().catch(() => "???"),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => 0n),
      baseToken.balanceOf(poolAddress).catch(() => 0n),
      baseToken.symbol().catch(() => "?"),
      token.balanceOf(poolAddress).catch(() => 0n),
    ]);

  const verification = await checkContractVerification(newTokenAddress);
  const topHolder = await fetchTopHolderPct(newTokenAddress, poolAddress);

  const lpLock = await findLpLockStatus(poolAddress, blockNumber);

  const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));
  const newTokenReserveFormatted = Number(ethers.formatUnits(newTokenBalanceInPool, decimals));
  const totalSupplyFormatted = Number(ethers.formatUnits(totalSupply, decimals));

  let priceUsd = null;
  let marketCapUsd = null;

  if (newTokenReserveFormatted > 0) {
    const priceInBase = baseLiquidityFormatted / newTokenReserveFormatted;

    if (USD_STABLE_BASES.has(baseTokenAddress.toLowerCase())) {
      priceUsd = priceInBase;
    } else {
      const ethUsd = await getEthUsdPrice();
      if (ethUsd) priceUsd = priceInBase * ethUsd;
    }

    if (priceUsd !== null) {
      marketCapUsd = priceUsd * totalSupplyFormatted;
    }
  }

  const isSafu =
    verification.verified &&
    verification.riskyFunctions.length === 0 &&
    topHolder.pct !== null &&
    topHolder.pct < config.safuMaxDeployerPct;

  return {
    tokenAddress: newTokenAddress.toLowerCase(),
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    poolAddress: poolAddress.toLowerCase(),
    baseSymbol,
    baseLiquidity: baseLiquidityFormatted,
    priceUsd,
    marketCapUsd,
    verified: verification.verified,
    riskyFunctions: verification.riskyFunctions,
    topHolderAddress: topHolder.holder,
    topHolderPct: topHolder.pct,
    lpLockStatus: lpLock.status,
    lpOwner: lpLock.owner,
    isSafu,
    blockNumber,
    scannedAt: Date.now(),
  };
}

async function scanOnce() {
  const currentBlock = await provider.getBlockNumber();
  // Always scan a fresh fixed window rather than relying on a persisted
  // "last scanned block" -- simpler, and avoids depending on disk state
  // surviving between requests on hosts with ephemeral storage.
  const fromBlock = Math.max(0, currentBlock - config.initialLookbackBlocks);

  console.log(`Scanning blocks ${fromBlock} -> ${currentBlock} (${currentBlock - fromBlock} blocks)`);
  const filter = factory.filters.PoolCreated();
  const logs = await getLogsChunked(factory, filter, fromBlock, currentBlock);
  console.log(`Found ${logs.length} pool(s) created in this window`);

  let newTokenCount = 0;
  let skippedNotBasePair = 0;

  for (const log of logs) {
    const { token0, token1, pool } = log.args;
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    const t0IsBase = config.knownBaseTokens.has(t0);
    const t1IsBase = config.knownBaseTokens.has(t1);

    // Only process pools where exactly one side is a known base asset
    // (i.e. a new token paired against ETH/WETH/USDG).
    if (t0IsBase === t1IsBase) {
      skippedNotBasePair += 1;
      continue;
    }

    const newToken = t0IsBase ? t1 : t0;
    const baseToken = t0IsBase ? t0 : t1;

    try {
      const record = await analyzeNewToken(newToken, baseToken, pool, log.blockNumber);

      db.upsertToken(record);
      newTokenCount += 1;
      console.log(`New token recorded: ${record.symbol} (${record.tokenAddress})`);
    } catch (err) {
      console.error(`Failed to analyze token ${newToken}:`, err.message);
    }
  }

  console.log(
    `Scan summary: ${logs.length} pools found, ${skippedNotBasePair} skipped (not paired with WETH/USDG), ` +
    `${newTokenCount} recorded`
  );

  return { scanned: logs.length, newTokens: newTokenCount };
}

module.exports = { scanOnce };
