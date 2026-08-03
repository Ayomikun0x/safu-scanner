const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI, ERC20_ABI, POOL_ABI, POSITION_MANAGER_ABI } = require("./abis");
const db = require("./db");
const blockscout = require("./explorers/blockscout");
const etherscan = require("./explorers/etherscan");
const telegram = require("./telegram");

let ethPriceCache = { value: null, fetchedAt: 0 };
const ETH_PRICE_TTL_MS = 5 * 60 * 1000;

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
  return ethPriceCache.value;
}

function formatCompactUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

const RISKY_FUNCTION_KEYWORDS = [
  "mint", "blacklist", "blocklist", "pause", "freeze", "setfee",
  "excludefromfee", "setmaxtx", "setmaxwallet", "rescuetoken",
  "withdrawtoken", "setrouter",
];

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb";

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

const networkContext = new Map();

function getContext(network) {
  if (networkContext.has(network.key)) return networkContext.get(network.key);

  const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, {
    staticNetwork: true,
  });
  const factory = new ethers.Contract(network.factoryAddress, FACTORY_ABI, provider);
  const positionManager = new ethers.Contract(
    network.positionManagerAddress,
    POSITION_MANAGER_ABI,
    provider
  );

  const ctx = { provider, factory, positionManager };
  networkContext.set(network.key, ctx);
  return ctx;
}

function getExplorerClient(network) {
  return network.explorerType === "etherscan" ? etherscan : blockscout;
}

async function checkContractVerification(network, address) {
  const client = getExplorerClient(network);
  const result = await client.checkContractVerification(network, address);
  if (!result.verified) return { verified: false, riskyFunctions: [] };

  const riskyFunctions = RISKY_FUNCTION_KEYWORDS.filter((kw) =>
    (result.abiText || "").includes(kw)
  );
  return { verified: true, riskyFunctions };
}

async function checkIsProxy(network, address) {
  try {
    const { provider } = getContext(network);
    const slotValue = await provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT);
    return slotValue !== ethers.ZeroHash;
  } catch (err) {
    return false;
  }
}

async function findLpLockStatus(network, poolAddress, fromBlock) {
  const { provider, positionManager } = getContext(network);
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
      if (network.knownLockerContracts.has(currentOwner)) {
        return { status: "locked", owner: currentOwner };
      }
      return { status: "unlocked", owner: currentOwner };
    }
  } catch (err) {
    console.error("LP lock check failed:", err.message);
  }
  return { status: "unknown", owner: null };
}

async function analyzeNewToken(network, newTokenAddress, baseTokenAddress, poolAddress, blockNumber) {
  const { provider } = getContext(network);
  const token = new ethers.Contract(newTokenAddress, ERC20_ABI, provider);
  const baseToken = new ethers.Contract(baseTokenAddress, ERC20_ABI, provider);

  const block = await provider.getBlock(blockNumber).catch(() => null);
  const launchedAt = block ? block.timestamp * 1000 : Date.now();

  const [name, symbol, decimals, totalSupply, baseBalanceInPool, baseSymbol, newTokenBalanceInPool] =
    await Promise.all([
      token.name().catch(() => "Unknown"),
      token.symbol().catch(() => "???"),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => 0n),
      baseToken.balanceOf(poolAddress).catch(() => 0n),
      baseToken.symbol().catch(() => network.baseAssetSymbolFallback),
      token.balanceOf(poolAddress).catch(() => 0n),
    ]);

  const verification = await checkContractVerification(network, newTokenAddress);
  const isProxy = await checkIsProxy(network, newTokenAddress);

  const client = getExplorerClient(network);
  const topHolderRaw = await client.fetchTopHolderPct(network, newTokenAddress, poolAddress);

  const lpLock = await findLpLockStatus(network, poolAddress, blockNumber);

  const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));
  const newTokenReserveFormatted = Number(ethers.formatUnits(newTokenBalanceInPool, decimals));
  const totalSupplyFormatted = Number(ethers.formatUnits(totalSupply, decimals));

  let priceUsd = null;
  let marketCapUsd = null;

  if (newTokenReserveFormatted > 0) {
    const priceInBase = baseLiquidityFormatted / newTokenReserveFormatted;

    if (network.usdStableBases.has(baseTokenAddress.toLowerCase())) {
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
    !isProxy &&
    topHolderRaw.pct !== null &&
    topHolderRaw.pct < config.safuMaxDeployerPct &&
    baseLiquidityFormatted >= config.safuMinLiquidityEth;

  return {
    chain: network.key,
    chainLabel: network.label,
    explorerAddressBase: network.explorerAddressBase,
    uniswapPoolUrlBase: network.uniswapPoolUrlBase,
    tokenAddress: newTokenAddress.toLowerCase(),
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    poolAddress: poolAddress.toLowerCase(),
    baseTokenAddress: baseTokenAddress.toLowerCase(),
    baseSymbol,
    baseLiquidity: baseLiquidityFormatted,
    priceUsd,
    marketCapUsd,
    verified: verification.verified,
    riskyFunctions: verification.riskyFunctions,
    isProxy,
    topHolderAddress: topHolderRaw.holder,
    topHolderPct: topHolderRaw.pct,
    topHolderDataAvailable: topHolderRaw.available !== false,
    lpLockStatus: lpLock.status,
    lpOwner: lpLock.owner,
    isSafu,
    blockNumber,
    launchedAt,
    scannedAt: Date.now(),
  };
}

async function refreshKnownTokenPrices(network) {
  const { provider } = getContext(network);
  const known = db.getAll().filter((t) => t.chain === network.key);
  if (known.length === 0) return;

  const REFRESH_BATCH_SIZE = 10;
  for (let i = 0; i < known.length; i += REFRESH_BATCH_SIZE) {
    const batch = known.slice(i, i + REFRESH_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (record) => {
        try {
          if (!record.baseTokenAddress) return;

          const token = new ethers.Contract(record.tokenAddress, ERC20_ABI, provider);
          const baseToken = new ethers.Contract(record.baseTokenAddress, ERC20_ABI, provider);

          const [newTokenBalanceInPool, baseBalanceInPool] = await Promise.all([
            token.balanceOf(record.poolAddress).catch(() => null),
            baseToken.balanceOf(record.poolAddress).catch(() => null),
          ]);

          if (newTokenBalanceInPool === null || baseBalanceInPool === null) return;

          const newTokenReserveFormatted = Number(
            ethers.formatUnits(newTokenBalanceInPool, record.decimals)
          );
          const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));

          if (newTokenReserveFormatted <= 0) return;

          const priceInBase = baseLiquidityFormatted / newTokenReserveFormatted;
          const totalSupplyFormatted = Number(
            ethers.formatUnits(record.totalSupply, record.decimals)
          );

          let priceUsd = null;
          if (network.usdStableBases.has(record.baseTokenAddress)) {
            priceUsd = priceInBase;
          } else {
            const ethUsd = await getEthUsdPrice();
            if (ethUsd) priceUsd = priceInBase * ethUsd;
          }

          const marketCapUsd = priceUsd !== null ? priceUsd * totalSupplyFormatted : null;

          const newIsSafu =
            record.verified &&
            record.riskyFunctions.length === 0 &&
            !record.isProxy &&
            record.topHolderPct !== null &&
            record.topHolderPct < config.safuMaxDeployerPct &&
            baseLiquidityFormatted >= config.safuMinLiquidityEth;

          const updatedRecord = {
            ...record,
            baseLiquidity: baseLiquidityFormatted,
            priceUsd,
            marketCapUsd,
            isSafu: newIsSafu,
          };

          if (newIsSafu && !record.isSafu && !record.alertedAt) {
            updatedRecord.alertedAt = Date.now();
            telegram.sendSafuAlert(updatedRecord);
          }

          db.upsertToken(updatedRecord);
        } catch (err) {
          // Skip this token's refresh silently -- next cycle will retry.
        }
      })
    );
  }
}

async function scanNetwork(network) {
  const { provider, factory } = getContext(network);
  const currentBlock = await provider.getBlockNumber();

  console.log(`[${network.label}] Refreshing prices for already-known tokens...`);
  await refreshKnownTokenPrices(network);

  const lastScanned = db.getLastScannedBlock(network.key);
  const fromBlock = lastScanned
    ? lastScanned + 1
    : Math.max(0, currentBlock - network.initialLookbackBlocks);

  if (fromBlock > currentBlock) {
    return { network: network.key, scanned: 0, newTokens: 0 };
  }

  console.log(
    `[${network.label}] Scanning blocks ${fromBlock} -> ${currentBlock} (${currentBlock - fromBlock} blocks)`
  );
  const filter = factory.filters.PoolCreated();
  const logs = await getLogsChunked(factory, filter, fromBlock, currentBlock);
  console.log(`[${network.label}] Found ${logs.length} pool(s) created in this window`);

  let newTokenCount = 0;
  let skippedNotBasePair = 0;

  const candidates = [];
  for (const log of logs) {
    const { token0, token1, pool } = log.args;
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();

    const t0IsBase = network.knownBaseTokens.has(t0);
    const t1IsBase = network.knownBaseTokens.has(t1);

    if (t0IsBase === t1IsBase) {
      skippedNotBasePair += 1;
      continue;
    }

    candidates.push({
      newToken: t0IsBase ? t1 : t0,
      baseToken: t0IsBase ? t0 : t1,
      pool,
      blockNumber: log.blockNumber,
    });
  }

  const BATCH_SIZE = 8;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((c) => analyzeNewToken(network, c.newToken, c.baseToken, c.pool, c.blockNumber))
    );

    results.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        const record = result.value;
        if (record.isSafu) {
          record.alertedAt = Date.now();
          telegram.sendSafuAlert(record);
        }
        db.upsertToken(record);
        newTokenCount += 1;
        console.log(`[${network.label}] Recorded: ${record.symbol} (${record.tokenAddress})`);
      } else {
        console.error(`[${network.label}] Failed to analyze token ${batch[idx].newToken}:`, result.reason?.message);
      }
    });
  }

  db.setLastScannedBlock(network.key, currentBlock);

  console.log(
    `[${network.label}] Scan summary: ${logs.length} pools found, ${skippedNotBasePair} skipped (wrong pair), ` +
    `${newTokenCount} recorded`
  );

  return { network: network.key, scanned: logs.length, newTokens: newTokenCount };
}

let scanInProgress = false;

async function scanOnce() {
  if (scanInProgress) {
    console.log("Scan already in progress, skipping this trigger.");
    return { scanned: 0, newTokens: 0, skipped: true };
  }

  scanInProgress = true;
  try {
    const settled = await Promise.allSettled(
      config.networks.map((network) => scanNetwork(network))
    );

    const results = settled.map((outcome, i) => {
      const network = config.networks[i];
      if (outcome.status === "fulfilled") return outcome.value;
      console.error(`[${network.label}] Network scan failed:`, outcome.reason?.message);
      return { network: network.key, scanned: 0, newTokens: 0, error: outcome.reason?.message };
    });

    return {
      scanned: results.reduce((sum, r) => sum + r.scanned, 0),
      newTokens: results.reduce((sum, r) => sum + r.newTokens, 0),
      perNetwork: results,
    };
  } finally {
    scanInProgress = false;
  }
}

module.exports = { scanOnce };
