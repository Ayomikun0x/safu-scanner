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

const SPOOF_KEYWORDS = [
  "safu",
  "verified",
  "audited",
  "audit",
  "locked",
  "renounced",
  "official",
  "dyor",
  "rug",
  "scam",
  "legit",
];

const MAX_NAME_LENGTH = 40;
const MAX_SYMBOL_LENGTH = 15;
const MAX_RECHECK_ATTEMPTS = 5;

function sanitizeIdentity(raw, maxLength) {
  const str = String(raw || "").trim();
  return str.length > maxLength ? str.slice(0, maxLength) + "…" : str;
}

function looksSpoofed(name, symbol) {
  const combined = `${name} ${symbol}`.toLowerCase();
  if (/\d+\s*%/.test(combined)) return true;
  return SPOOF_KEYWORDS.some((kw) => combined.includes(kw));
}

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb";

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

  if (result.rateLimited) {
    return { verified: null, riskyFunctions: [], rateLimited: true };
  }
  if (!result.verified) {
    return { verified: false, riskyFunctions: [], rateLimited: false };
  }

  const riskyFunctions = RISKY_FUNCTION_KEYWORDS.filter((kw) =>
    (result.abiText || "").includes(kw)
  );
  return { verified: true, riskyFunctions, rateLimited: false };
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

// Locker safety results are cached per address -- EXCEPT rate-limited
// results, which are deliberately not cached, so a temporary explorer
// rate-limit can't permanently poison every future token that reuses the
// same locker.
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
    if (verification.rateLimited) {
      return { verified: null, hasEarlyExitRisk: false, riskyFunctions: [], rateLimited: true };
    }
    if (!verification.verified) {
      result = { verified: false, hasEarlyExitRisk: false, riskyFunctions: [], rateLimited: false };
    } else {
      const riskyFunctions = LOCKER_RISK_KEYWORDS.filter((kw) =>
        (verification.abiText || "").includes(kw)
      );
      result = { verified: true, hasEarlyExitRisk: riskyFunctions.length > 0, riskyFunctions, rateLimited: false };
    }
  } catch (err) {
    console.error("Locker safety check failed:", err.message);
    result = { verified: false, hasEarlyExitRisk: false, riskyFunctions: [], rateLimited: false };
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
        return { status: "burned", owner: currentOwner, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: false };
      }
      if (network.knownLockerContracts.has(currentOwner)) {
        const safety = await checkLockerContractSafety(network, currentOwner);

        if (safety.rateLimited) {
          // Known locker, but we couldn't confirm its source this cycle due
          // to a rate limit -- not the same as "unverified", so it gets its
          // own status and a retry on the next refresh cycle instead of a
          // permanent verdict.
          return {
            status: "locked-recheck-needed",
            owner: currentOwner,
            lockerVerified: null,
            lockerRiskyFunctions: [],
            rateLimitedLocker: true,
          };
        }

        let status;
        if (!safety.verified) {
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
          rateLimitedLocker: false,
        };
      }
      return { status: "unlocked", owner: currentOwner, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: false };
    }
  } catch (err) {
    console.error("LP lock check failed:", err.message);
  }
  return { status: "unknown", owner: null, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: false };
}

function isLpTrulyLocked(lpLockStatus) {
  return lpLockStatus === "locked" || lpLockStatus === "burned";
}

// Runs the four independent safety checks and reports whether any of them
// hit a rate limit -- used both for a brand-new token's first analysis and
// for re-attempting a previously rate-limited token on a later cycle.
async function runSafetyChecks(network, tokenAddress, poolAddress, blockNumber) {
  const client = getExplorerClient(network);
  const [verification, isProxy, topHolderRaw, lpLock] = await Promise.all([
    withTimeout(checkContractVerification(network, tokenAddress), 20000, "checkContractVerification")
      .catch(() => ({ verified: false, riskyFunctions: [], rateLimited: false })),
    withTimeout(checkIsProxy(network, tokenAddress), 15000, "checkIsProxy").catch(() => false),
    withTimeout(client.fetchTopHolderPct(network, tokenAddress, poolAddress), 20000, "fetchTopHolderPct")
      .catch(() => ({ pct: null, holder: null, available: false, rateLimited: false })),
    withTimeout(findLpLockStatus(network, poolAddress, blockNumber), 25000, "findLpLockStatus")
      .catch(() => ({ status: "unknown", owner: null, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: false })),
  ]);

  const rateLimitedAny =
    verification.rateLimited === true ||
    topHolderRaw.rateLimited === true ||
    lpLock.rateLimitedLocker === true;

  return { verification, isProxy, topHolderRaw, lpLock, rateLimitedAny };
}

async function analyzeNewToken(network, newTokenAddress, baseTokenAddress, poolAddress, blockNumber) {
  const { provider } = getContext(network);
  const token = new ethers.Contract(newTokenAddress, ERC20_ABI, provider);
  const baseToken = new ethers.Contract(baseTokenAddress, ERC20_ABI, provider);

  const block = await withTimeout(provider.getBlock(blockNumber), 15000, "getBlock").catch(() => null);
  const launchedAt = block ? block.timestamp * 1000 : Date.now();

  let nameOk = true;
  let symbolOk = true;

  const [rawName, rawSymbol, decimals, totalSupply, baseBalanceInPool, baseSymbol, newTokenBalanceInPool] =
    await Promise.all([
      withTimeout(token.name(), 15000, "token.name").catch(() => {
        nameOk = false;
        return "Unknown";
      }),
      withTimeout(token.symbol(), 15000, "token.symbol").catch(() => {
        symbolOk = false;
        return "???";
      }),
      withTimeout(token.decimals(), 15000, "token.decimals").catch(() => 18),
      withTimeout(token.totalSupply(), 15000, "token.totalSupply").catch(() => 0n),
      withTimeout(baseToken.balanceOf(poolAddress), 15000, "baseToken.balanceOf").catch(() => 0n),
      withTimeout(baseToken.symbol(), 15000, "baseToken.symbol").catch(() => network.baseAssetSymbolFallback),
      withTimeout(token.balanceOf(poolAddress), 15000, "token.balanceOf").catch(() => 0n),
    ]);

  const name = sanitizeIdentity(rawName, MAX_NAME_LENGTH);
  const symbol = sanitizeIdentity(rawSymbol, MAX_SYMBOL_LENGTH);
  const spoofedIdentity = looksSpoofed(name, symbol);

  const { verification, isProxy, topHolderRaw, lpLock, rateLimitedAny } = await runSafetyChecks(
    network,
    newTokenAddress,
    poolAddress,
    blockNumber
  );

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
    verification.verified === true &&
    verification.riskyFunctions.length === 0 &&
    !isProxy &&
    topHolderRaw.pct !== null &&
    topHolderRaw.pct < config.safuMaxDeployerPct &&
    baseLiquidityFormatted >= config.safuMinLiquidityEth &&
    nameOk &&
    symbolOk &&
    !spoofedIdentity &&
    isLpTrulyLocked(lpLock.status);

  return {
    chain: network.key,
    chainLabel: network.label,
    explorerAddressBase: network.explorerAddressBase,
    uniswapPoolUrlBase: network.uniswapPoolUrlBase,
    tokenAddress: newTokenAddress.toLowerCase(),
    name,
    symbol,
    nameOk,
    symbolOk,
    spoofedIdentity,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    poolAddress: poolAddress.toLowerCase(),
    baseTokenAddress: baseTokenAddress.toLowerCase(),
    baseSymbol,
    baseLiquidity: baseLiquidityFormatted,
    priceUsd,
    marketCapUsd,
    verified: verification.verified === true,
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
    needsRecheck: rateLimitedAny,
    recheckAttempts: 0,
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

          let updatedRecord = { ...record, baseLiquidity: baseLiquidityFormatted, priceUsd, marketCapUsd };

          // If this token's original analysis got rate-limited, retry the
          // FULL safety check (not just price) here -- this loop already
          // runs every scan cycle, so a temporary rate-limit now gets a real
          // second (third, fourth...) chance instead of being stuck wrong
          // forever, up to a small attempt cap so a persistently-broken
          // lookup doesn't retry indefinitely.
          if (record.needsRecheck && (record.recheckAttempts || 0) < MAX_RECHECK_ATTEMPTS) {
            const { verification, isProxy, topHolderRaw, lpLock, rateLimitedAny } = await runSafetyChecks(
              network,
              record.tokenAddress,
              record.poolAddress,
              record.blockNumber
            );

            updatedRecord = {
              ...updatedRecord,
              verified: verification.verified === true,
              riskyFunctions: verification.riskyFunctions,
              isProxy,
              topHolderAddress: topHolderRaw.holder,
              topHolderPct: topHolderRaw.pct,
              topHolderDataAvailable: topHolderRaw.available !== false,
              lpLockStatus: lpLock.status,
              lpOwner: lpLock.owner,
              lpLockerVerified: lpLock.lockerVerified,
              lpLockerRiskyFunctions: lpLock.lockerRiskyFunctions,
              needsRecheck: rateLimitedAny,
              recheckAttempts: (record.recheckAttempts || 0) + 1,
            };

            if (!rateLimitedAny) {
              console.log(
                `[${network.label}] Recheck resolved for ${record.symbol} (${record.tokenAddress}) after ${updatedRecord.recheckAttempts} attempt(s)`
              );
            } else if (updatedRecord.recheckAttempts >= MAX_RECHECK_ATTEMPTS) {
              console.warn(
                `[${network.label}] Giving up recheck for ${record.symbol} (${record.tokenAddress}) after ${MAX_RECHECK_ATTEMPTS} attempts -- explorer still rate-limiting`
              );
            }
          }

          const newIsSafu =
            updatedRecord.verified === true &&
            updatedRecord.riskyFunctions.length === 0 &&
            !updatedRecord.isProxy &&
            updatedRecord.topHolderPct !== null &&
            updatedRecord.topHolderPct < config.safuMaxDeployerPct &&
            baseLiquidityFormatted >= config.safuMinLiquidityEth &&
            updatedRecord.nameOk !== false &&
            updatedRecord.symbolOk !== false &&
            !updatedRecord.spoofedIdentity &&
            isLpTrulyLocked(updatedRecord.lpLockStatus);

          updatedRecord.isSafu = newIsSafu;

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
