const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI, ERC20_ABI, POOL_ABI, POSITION_MANAGER_ABI } = require("./abis");
const db = require("./db");
const blockscout = require("./explorers/blockscout");
const etherscan = require("./explorers/etherscan");
const telegram = require("./telegram");
const { withTimeout, fetchJsonWithTimeout } = require("./utils/withTimeout");

// Simple in-memory cache for ETH/USD so we don't hit the price API on every token.
let ethPriceCache = { value: null, fetchedAt: 0 };
const ETH_PRICE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getEthUsdPrice() {
  const now = Date.now();
  if (ethPriceCache.value && now - ethPriceCache.fetchedAt < ETH_PRICE_TTL_MS) {
    return ethPriceCache.value;
  }
  const data = await fetchJsonWithTimeout(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
  );
  const price = data?.ethereum?.usd;
  if (price) {
    ethPriceCache = { value: price, fetchedAt: now };
    return price;
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

// Function name fragments that, if present in a *locker* contract's verified
// source, suggest the deployer (or some privileged role) can pull the LP
// tokens out before the stated unlock time -- i.e. the "lock" isn't really
// enforced by the contract, just by convention. Same limitation as
// RISKY_FUNCTION_KEYWORDS above: it's a name match, not proof of reachability.
const LOCKER_RISK_KEYWORDS = [
  "emergencywithdraw",
  "emergencyexit",
  "forceunlock",
  "forcewithdraw",
  "adminwithdraw",
  "adminunlock",
  "ownerwithdraw",
  "ownerunlock",
  "backdoor",
  "rescue",
  "overrideunlock",
  "bypasslock",
];

// EIP-1967 standard storage slot where upgradeable (proxy) contracts store
// their real logic address. Works the same way on any EVM chain.
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb";

// Chunk eth_getLogs calls so we don't blow past provider block-range limits.
const DEFAULT_LOG_CHUNK_SIZE = 2000;

async function getLogsChunked(contract, eventFilter, fromBlock, toBlock, chunkSize = DEFAULT_LOG_CHUNK_SIZE) {
  const allLogs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const logs = await withTimeout(
        contract.queryFilter(eventFilter, start, end),
        20000,
        `queryFilter blocks ${start}-${end}`
      );
      allLogs.push(...logs);
    } catch (err) {
      console.error(`Log fetch failed for blocks ${start}-${end}:`, err.message);
    }
    start = end + 1;
  }
  return allLogs;
}

// Cache one ethers provider + contract set per network so we don't recreate
// them on every single token check.
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
    const slotValue = await withTimeout(
      provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT),
      15000,
      "getStorage"
    );
    return slotValue !== ethers.ZeroHash;
  } catch (err) {
    return false;
  }
}

// Locker contracts are reused across every token that locks LP with the same
// service (e.g. Pons), so we only ever need to check each locker *address*
// once per process lifetime -- cache the result instead of re-hitting the
// explorer API on every single token that happens to use it.
const lockerSafetyCache = new Map(); // key: `${network.key}:${lockerAddress}`

async function checkLockerContractSafety(network, lockerAddress) {
  const cacheKey = `${network.key}:${lockerAddress.toLowerCase()}`;
  if (lockerSafetyCache.has(cacheKey)) {
    return lockerSafetyCache.get(cacheKey);
  }

  let result;
  try {
    const client = getExplorerClient(network);
    const verification = await client.checkContractVerification(network, lockerAddress);
    if (!verification.verified) {
      result = { verified: false, hasEarlyExitRisk: false, riskyFunctions: [] };
    } else {
      const riskyFunctions = LOCKER_RISK_KEYWORDS.filter((kw) =>
        (verification.abiText || "").includes(kw)
      );
      result = { verified: true, hasEarlyExitRisk: riskyFunctions.length > 0, riskyFunctions };
    }
  } catch (err) {
    console.error("Locker safety check failed:", err.message);
    result = { verified: false, hasEarlyExitRisk: false, riskyFunctions: [] };
  }

  lockerSafetyCache.set(cacheKey, result);
  return result;
}

async function findLpLockStatus(network, poolAddress, fromBlock) {
  const { provider, positionManager } = getContext(network);
  try {
    const toBlock = fromBlock + 200;
    const mintFilter = positionManager.filters.Transfer(ethers.ZeroAddress, null, null);
    const mintLogs = await getLogsChunked(positionManager, mintFilter, fromBlock, toBlock, network.logChunkSize);

    for (const log of mintLogs) {
      const tokenId = log.args.tokenId;
      let pos;
      try {
        pos = await withTimeout(positionManager.positions(tokenId), 15000, "positions");
      } catch {
        continue;
      }
      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const [poolToken0, poolToken1] = await Promise.all([
        withTimeout(poolContract.token0(), 15000, "pool.token0"),
        withTimeout(poolContract.token1(), 15000, "pool.token1"),
      ]);
      if (
        pos.token0.toLowerCase() !== poolToken0.toLowerCase() ||
        pos.token1.toLowerCase() !== poolToken1.toLowerCase()
      ) {
        continue;
      }

      const currentOwner = (
        await withTimeout(positionManager.ownerOf(tokenId), 15000, "ownerOf")
      ).toLowerCase();

      if (config.burnAddresses.has(currentOwner)) {
        return { status: "burned", owner: currentOwner, lockerVerified: null, lockerRiskyFunctions: [] };
      }
      if (network.knownLockerContracts.has(currentOwner)) {
        const safety = await checkLockerContractSafety(network, currentOwner);
        let status;
        if (!safety.verified) {
          // Known locker address, but we can't read its source to confirm
          // the lock actually holds -- don't blindly call this "locked".
          status = "locked-unverified";
        } else if (safety.hasEarlyExitRisk) {
          status = "locked-risky";
        } else {
          status = "locked";
        }
        return {
          status,
          owner: currentOwner,
          lockerVerified: safety.verified,
          lockerRiskyFunctions: safety.riskyFunctions,
        };
      }
      return { status: "unlocked", owner: currentOwner, lockerVerified: null, lockerRiskyFunctions: [] };
    }
  } catch (err) {
    console.error("LP lock check failed:", err.message);
  }
  return { status: "unknown", owner: null, lockerVerified: null, lockerRiskyFunctions: [] };
}

async function analyzeNewToken(network, newTokenAddress, baseTokenAddress, poolAddress, blockNumber) {
  const { provider } = getContext(network);
  const token = new ethers.Contract(newTokenAddress, ERC20_ABI, provider);
  const baseToken = new ethers.Contract(baseTokenAddress, ERC20_ABI, provider);

  const block = await withTimeout(provider.getBlock(blockNumber), 15000, "getBlock").catch(() => null);
  const launchedAt = block ? block.timestamp * 1000 : Date.now();

  const [name, symbol, decimals, totalSupply, baseBalanceInPool, baseSymbol, newTokenBalanceInPool] =
    await Promise.all([
      withTimeout(token.name(), 15000, "token.name").catch(() => "Unknown"),
      withTimeout(token.symbol(), 15000, "token.symbol").catch(() => "???"),
      withTimeout(token.decimals(), 15000, "token.decimals").catch(() => 18),
      withTimeout(token.totalSupply(), 15000, "token.totalSupply").catch(() => 0n),
      withTimeout(baseToken.balanceOf(poolAddress), 15000, "baseToken.balanceOf").catch(() => 0n),
      withTimeout(baseToken.symbol(), 15000, "baseToken.symbol").catch(() => network.baseAssetSymbolFallback),
      withTimeout(token.balanceOf(poolAddress), 15000, "token.balanceOf").catch(() => 0n),
    ]);

  // These four checks are all independent of each other (and of the block
  // data above), so run them concurrently instead of one after another --
  // each is also individually timeout-guarded so one hung explorer/RPC call
  // can't stall this token (or the whole batch it's part of) indefinitely.
  const client = getExplorerClient(network);
  const [verification, isProxy, topHolderRaw, lpLock] = await Promise.all([
    withTimeout(checkContractVerification(network, newTokenAddress), 20000, "checkContractVerification")
      .catch(() => ({ verified: false, riskyFunctions: [] })),
    withTimeout(checkIsProxy(network, newTokenAddress), 15000, "checkIsProxy").catch(() => false),
    withTimeout(client.fetchTopHolderPct(network, newTokenAddress, poolAddress), 20000, "fetchTopHolderPct")
      .catch(() => ({ pct: null, holder: null, available: false })),
    withTimeout(findLpLockStatus(network, poolAddress, blockNumber), 25000, "findLpLockStatus")
      .catch(() => ({ status: "unknown", owner: null, lockerVerified: null, lockerRiskyFunctions: [] })),
  ]);

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
    lpLockerVerified: lpLock.lockerVerified,
    lpLockerRiskyFunctions: lpLock.lockerRiskyFunctions,
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
          if (!record.baseTokenAddress) return; // older record from before this field existed

          const token = new ethers.Contract(record.tokenAddress, ERC20_ABI, provider);
          const baseToken = new ethers.Contract(record.baseTokenAddress, ERC20_ABI, provider);

          const [newTokenBalanceInPool, baseBalanceInPool] = await Promise.all([
            withTimeout(token.balanceOf(record.poolAddress), 15000, "refresh balanceOf").catch(() => null),
            withTimeout(baseToken.balanceOf(record.poolAddress), 15000, "refresh baseToken balanceOf").catch(() => null),
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
  const currentBlock = await withTimeout(provider.getBlockNumber(), 15000, "getBlockNumber");

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
  const logs = await getLogsChunked(factory, filter, fromBlock, currentBlock, network.logChunkSize);
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

  // Fast pre-check: grab just the base-token liquidity for every candidate
  // (one cheap call each, done at high concurrency) so we can process the
  // most promising -- most likely to already be SAFU -- tokens first. This
  // gets alerts out sooner instead of them waiting behind a pile of
  // low-liquidity noise processed in arbitrary blockchain order.
  const { provider: precheckProvider } = getContext(network);
  const PRECHECK_CONCURRENCY = 25;
  for (let i = 0; i < candidates.length; i += PRECHECK_CONCURRENCY) {
    const slice = candidates.slice(i, i + PRECHECK_CONCURRENCY);
    await Promise.all(
      slice.map(async (c) => {
        try {
          const baseToken = new ethers.Contract(c.baseToken, ERC20_ABI, precheckProvider);
          const bal = await withTimeout(baseToken.balanceOf(c.pool), 15000, "precheck balanceOf");
          c.quickLiquidity = Number(ethers.formatUnits(bal, 18));
        } catch {
          c.quickLiquidity = 0;
        }
      })
    );
  }
  candidates.sort((a, b) => b.quickLiquidity - a.quickLiquidity);

  // Analyze tokens in small parallel batches instead of one at a time --
  // a single sequential pass over hundreds of pools could take hours.
  // Each token also gets its own outer timeout as a second line of defense,
  // on top of the timeouts already inside analyzeNewToken itself.
  const BATCH_SIZE = 12;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((c) =>
        withTimeout(
          analyzeNewToken(network, c.newToken, c.baseToken, c.pool, c.blockNumber),
          60000,
          `analyzeNewToken ${c.newToken}`
        )
      )
    );

    results.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        const record = result.value;
        if (record.isSafu) {
          record.alertedAt = Date.now();
          telegram.sendSafuAlert(record); // fire-and-forget, errors logged internally
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

// Exposed so server.js's outer watchdog can force this back to false if a
// scan ever gets abandoned by the outer timeout ceiling (the promise itself
// keeps running in the background, but we stop waiting on it and treat the
// lock as free again for the next scheduled cycle).
function forceResetScanLock() {
  if (scanInProgress) {
    console.warn("Forcing scan lock reset -- previous scan was abandoned by the outer watchdog.");
  }
  scanInProgress = false;
}

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

module.exports = { scanOnce, forceResetScanLock };
