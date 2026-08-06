const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI, ERC20_ABI, POOL_ABI, POSITION_MANAGER_ABI } = require("./abis");
const db = require("./db");
const blockscout = require("./explorers/blockscout");
const etherscan = require("./explorers/etherscan");
const telegram = require("./telegram");
const { withTimeout, fetchJsonWithTimeout } = require("./utils/withTimeout");

let ethPriceCache = { value: null, fetchedAt: 0 };
const ETH_PRICE_TTL_MS = 5 * 60 * 1000;

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
  "mint", "blacklist", "blocklist", "pause", "freeze", "setfee",
  "excludefromfee", "setmaxtx", "setmaxwallet", "rescuetoken",
  "withdrawtoken", "setrouter",
];

const LOCKER_RISK_KEYWORDS = [
  "emergencywithdraw", "emergencyexit", "forceunlock", "forcewithdraw",
  "adminwithdraw", "adminunlock", "ownerwithdraw", "ownerunlock",
  "backdoor", "rescue", "overrideunlock", "bypasslock",
];

const SPOOF_KEYWORDS = [
  "safu", "verified", "audited", "audit", "locked", "renounced",
  "official", "dyor", "rug", "scam", "legit",
];

const MAX_NAME_LENGTH = 40;
const MAX_SYMBOL_LENGTH = 15;
const MAX_RECHECK_ATTEMPTS = 5;
const LIQUIDITY_COLLAPSE_RATIO = 0.2;
const PUMP_WATCH_MULTIPLE = 2; // price hitting 2x its launch price triggers "pumped" tracking

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

const OWNERSHIP_ABI = ["function owner() view returns (address)"];
const TRANSFER_EVENT_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const SWAP_EVENT_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

// Counts actual swap transactions on a pool between two blocks. Used as a
// guard before flagging a "hit 2x" pattern -- a price that technically
// crossed 2x on one or two thin trades isn't the same signal as real trading
// volume pushing it there, so we require a minimum trade count too.
async function countPoolSwaps(network, poolAddress, fromBlock, toBlock) {
  try {
    const { provider } = getContext(network);
    const poolEvents = new ethers.Contract(poolAddress, SWAP_EVENT_ABI, provider);
    const filter = poolEvents.filters.Swap();
    const logs = await getLogsChunked(poolEvents, filter, fromBlock, toBlock, network.logChunkSize);
    return logs.length;
  } catch (err) {
    return 0;
  }
}

const DEPLOYER_GETTER_ABI = ["function deployer() view returns (address)"];

async function getOnChainDeployer(network, tokenAddress) {
  try {
    const { provider } = getContext(network);
    const contract = new ethers.Contract(tokenAddress, DEPLOYER_GETTER_ABI, provider);
    const deployer = await withTimeout(contract.deployer(), 10000, "token.deployer()");
    return deployer.toLowerCase();
  } catch (err) {
    return null;
  }
}

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
  if (result.rateLimited) return { verified: null, riskyFunctions: [], rateLimited: true };
  if (!result.verified) return { verified: false, riskyFunctions: [], rateLimited: false };

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

async function checkOwnershipRenounced(network, address) {
  try {
    const { provider } = getContext(network);
    const contract = new ethers.Contract(address, OWNERSHIP_ABI, provider);
    const owner = await withTimeout(contract.owner(), 12000, "owner()");
    return owner.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  } catch (err) {
    return null;
  }
}

async function findEarlySnipers(network, tokenAddress, poolAddress, launchBlock, totalSupplyFormatted, decimals) {
  try {
    const { provider } = getContext(network);
    const tokenEvents = new ethers.Contract(tokenAddress, TRANSFER_EVENT_ABI, provider);
    const toBlock = launchBlock + config.earlySniperWindowBlocks;
    const filter = tokenEvents.filters.Transfer();
    const logs = await getLogsChunked(tokenEvents, filter, launchBlock, toBlock, network.logChunkSize);

    const excluded = new Set([
      poolAddress.toLowerCase(),
      ethers.ZeroAddress.toLowerCase(),
      "0x000000000000000000000000000000000000dead",
    ]);

    const net = new Map();
    for (const log of logs) {
      const to = log.args.to.toLowerCase();
      const from = log.args.from.toLowerCase();
      const amount = Number(ethers.formatUnits(log.args.value, decimals));

      if (!excluded.has(to)) {
        net.set(to, (net.get(to) || 0) + amount);
      }
      if (!excluded.has(from)) {
        net.set(from, (net.get(from) || 0) - amount);
      }
    }

    const positiveHolders = [...net.entries()].filter(([, amount]) => amount > 0);

    if (totalSupplyFormatted <= 0 || positiveHolders.length === 0) {
      return { pct: 0, wallets: 0, windowBlocks: config.earlySniperWindowBlocks };
    }

    const sorted = positiveHolders.map(([, amount]) => amount).sort((a, b) => b - a);
    const topFew = sorted.slice(0, 3).reduce((sum, v) => sum + v, 0);
    const pct = Math.min((topFew / totalSupplyFormatted) * 100, 100);

    return { pct, wallets: positiveHolders.length, windowBlocks: config.earlySniperWindowBlocks };
  } catch (err) {
    return { pct: null, wallets: null, windowBlocks: config.earlySniperWindowBlocks };
  }
}

const lockerSafetyCache = new Map();

async function checkLockerContractSafety(network, lockerAddress) {
  const cacheKey = `${network.key}:${lockerAddress.toLowerCase()}`;
  if (lockerSafetyCache.has(cacheKey)) return lockerSafetyCache.get(cacheKey);

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
          return { status: "locked-recheck-needed", owner: currentOwner, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: true };
        }
        let status;
        if (!safety.verified) status = "locked-unverified";
        else if (safety.hasEarlyExitRisk) status = "locked-risky";
        else status = "locked";
        return { status, owner: currentOwner, lockerVerified: safety.verified, lockerRiskyFunctions: safety.riskyFunctions, rateLimitedLocker: false };
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

async function runSafetyChecks(network, tokenAddress, poolAddress, blockNumber, totalSupplyFormatted, decimals, totalSupplyRaw) {
  const client = getExplorerClient(network);
  const [verification, isProxy, topHolderRaw, lpLock, ownershipRenounced, creatorResult, earlySnipers, onChainDeployer] = await Promise.all([
    withTimeout(checkContractVerification(network, tokenAddress), 20000, "checkContractVerification")
      .catch(() => ({ verified: false, riskyFunctions: [], rateLimited: false })),
    withTimeout(checkIsProxy(network, tokenAddress), 15000, "checkIsProxy").catch(() => false),
    withTimeout(client.fetchTopHolderPct(network, tokenAddress, poolAddress, totalSupplyRaw), 20000, "fetchTopHolderPct")
      .catch(() => ({ pct: null, holder: null, available: false, rateLimited: false })),
    withTimeout(findLpLockStatus(network, poolAddress, blockNumber), 25000, "findLpLockStatus")
      .catch(() => ({ status: "unknown", owner: null, lockerVerified: null, lockerRiskyFunctions: [], rateLimitedLocker: false })),
    withTimeout(checkOwnershipRenounced(network, tokenAddress), 15000, "checkOwnershipRenounced").catch(() => null),
    withTimeout(client.getContractCreator(network, tokenAddress), 15000, "getContractCreator")
      .catch(() => ({ creator: null, rateLimited: false })),
    withTimeout(
      findEarlySnipers(network, tokenAddress, poolAddress, blockNumber, totalSupplyFormatted, decimals),
      20000, "findEarlySnipers"
    ).catch(() => ({ pct: null, wallets: null, windowBlocks: config.earlySniperWindowBlocks })),
    withTimeout(getOnChainDeployer(network, tokenAddress), 10000, "getOnChainDeployer").catch(() => null),
  ]);

  const rateLimitedAny =
    verification.rateLimited === true ||
    topHolderRaw.rateLimited === true ||
    lpLock.rateLimitedLocker === true ||
    creatorResult.rateLimited === true;

  const resolvedDeployer = onChainDeployer || creatorResult.creator;

  return { verification, isProxy, topHolderRaw, lpLock, ownershipRenounced, creatorResult, earlySnipers, rateLimitedAny, resolvedDeployer };
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
      withTimeout(token.name(), 15000, "token.name").catch(() => { nameOk = false; return "Unknown"; }),
      withTimeout(token.symbol(), 15000, "token.symbol").catch(() => { symbolOk = false; return "???"; }),
      withTimeout(token.decimals(), 15000, "token.decimals").catch(() => 18),
      withTimeout(token.totalSupply(), 15000, "token.totalSupply").catch(() => 0n),
      withTimeout(baseToken.balanceOf(poolAddress), 15000, "baseToken.balanceOf").catch(() => 0n),
      withTimeout(baseToken.symbol(), 15000, "baseToken.symbol").catch(() => network.baseAssetSymbolFallback),
      withTimeout(token.balanceOf(poolAddress), 15000, "token.balanceOf").catch(() => 0n),
    ]);

  const name = sanitizeIdentity(rawName, MAX_NAME_LENGTH);
  const symbol = sanitizeIdentity(rawSymbol, MAX_SYMBOL_LENGTH);
  const spoofedIdentity = looksSpoofed(name, symbol);
  const totalSupplyFormatted = Number(ethers.formatUnits(totalSupply, decimals));

  const { verification, isProxy, topHolderRaw, lpLock, ownershipRenounced, earlySnipers, rateLimitedAny, resolvedDeployer } =
    await runSafetyChecks(network, newTokenAddress, poolAddress, blockNumber, totalSupplyFormatted, decimals, totalSupply.toString());

  const deployerAddress = resolvedDeployer;
  const deployerRecord = deployerAddress ? db.getDeployerRecord(deployerAddress) : { totalLaunches: 0, ruggedCount: 0, hit2xCount: 0 };

  const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));
  const newTokenReserveFormatted = Number(ethers.formatUnits(newTokenBalanceInPool, decimals));

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
    if (priceUsd !== null) marketCapUsd = priceUsd * totalSupplyFormatted;
  }

  const topHolderOk =
    topHolderRaw.available === false ? true : topHolderRaw.pct !== null && topHolderRaw.pct < config.safuMaxDeployerPct;
  const ownershipOk = ownershipRenounced !== false;
  const deployerOk = deployerRecord.ruggedCount === 0;
  const snipingOk = earlySnipers.pct === null ? true : earlySnipers.pct < config.safuMaxEarlyConcentrationPct;

  const isSafu =
    verification.verified === true &&
    verification.riskyFunctions.length === 0 &&
    !isProxy &&
    topHolderOk &&
    baseLiquidityFormatted >= config.safuMinLiquidityEth &&
    nameOk && symbolOk && !spoofedIdentity &&
    isLpTrulyLocked(lpLock.status) &&
    ownershipOk &&
    deployerOk &&
    snipingOk;

  // Pump Watch: this deployer has a proven track record of rugging AND
  // pumping tokens to 2x+ first. This is a historical pattern flag, entirely
  // separate from isSafu -- it says nothing about THIS token's own safety,
  // only about what this wallet has done before.
const isPumpWatch =
    deployerRecord.ruggedCount > 0 &&
    deployerRecord.hit2xCount > 0 &&
    baseLiquidityFormatted >= config.pumpWatchMinLiquidityEth;

  return {
    chain: network.key,
    chainLabel: network.label,
    explorerAddressBase: network.explorerAddressBase,
    uniswapPoolUrlBase: network.uniswapPoolUrlBase,
    tokenAddress: newTokenAddress.toLowerCase(),
    name, symbol, nameOk, symbolOk, spoofedIdentity,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    poolAddress: poolAddress.toLowerCase(),
    baseTokenAddress: baseTokenAddress.toLowerCase(),
    baseSymbol,
    baseLiquidity: baseLiquidityFormatted,
    priceUsd, marketCapUsd,
    launchPriceUsd: priceUsd,
    peakPriceUsd: priceUsd,
    hit2xFlagged: false,
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
    ownershipRenounced,
    deployerAddress,
    deployerLaunches: deployerRecord.totalLaunches,
    deployerRuggedCount: deployerRecord.ruggedCount,
    deployerHit2xCount: deployerRecord.hit2xCount,
    earlySniperPct: earlySnipers.pct,
    earlySniperWallets: earlySnipers.wallets,
    isSafu,
    isPumpWatch,
    pumpWatchAlertedAt: null,
    needsRecheck: rateLimitedAny,
    recheckAttempts: 0,
    peakLiquidity: baseLiquidityFormatted,
    wasEverLocked: isLpTrulyLocked(lpLock.status),
    ruggedFlagged: false,
    blockNumber, launchedAt, scannedAt: Date.now(),
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
            withTimeout(token.balanceOf(record.poolAddress), 15000, "refresh balanceOf").catch(() => null),
            withTimeout(baseToken.balanceOf(record.poolAddress), 15000, "refresh baseToken balanceOf").catch(() => null),
          ]);

          if (newTokenBalanceInPool === null || baseBalanceInPool === null) return;

          const newTokenReserveFormatted = Number(ethers.formatUnits(newTokenBalanceInPool, record.decimals));
          const baseLiquidityFormatted = Number(ethers.formatUnits(baseBalanceInPool, 18));
          if (newTokenReserveFormatted <= 0) return;

          const priceInBase = baseLiquidityFormatted / newTokenReserveFormatted;
          const totalSupplyFormatted = Number(ethers.formatUnits(record.totalSupply, record.decimals));

          let priceUsd = null;
          if (network.usdStableBases.has(record.baseTokenAddress)) {
            priceUsd = priceInBase;
          } else {
            const ethUsd = await getEthUsdPrice();
            if (ethUsd) priceUsd = priceInBase * ethUsd;
          }
          const marketCapUsd = priceUsd !== null ? priceUsd * totalSupplyFormatted : null;

          let updatedRecord = { ...record, baseLiquidity: baseLiquidityFormatted, priceUsd, marketCapUsd };

          if (record.needsRecheck && (record.recheckAttempts || 0) < MAX_RECHECK_ATTEMPTS) {
            const { verification, isProxy, topHolderRaw, lpLock, ownershipRenounced, earlySnipers, rateLimitedAny, resolvedDeployer } =
              await runSafetyChecks(network, record.tokenAddress, record.poolAddress, record.blockNumber, totalSupplyFormatted, record.decimals, record.totalSupply);

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
              ownershipRenounced,
              deployerAddress: resolvedDeployer || record.deployerAddress,
              earlySniperPct: earlySnipers.pct,
              earlySniperWallets: earlySnipers.wallets,
              needsRecheck: rateLimitedAny,
              recheckAttempts: (record.recheckAttempts || 0) + 1,
            };
          }

          // Track peak price and flag a "hit 2x" event on this deployer the
          // first time this token's price reaches PUMP_WATCH_MULTIPLE x its
          // launch price. Only fires once per token (hit2xFlagged guards it).
          const launchPriceUsd = record.launchPriceUsd ?? null;
          const peakPriceUsd = Math.max(record.peakPriceUsd || 0, priceUsd || 0);
          updatedRecord.peakPriceUsd = peakPriceUsd;
          updatedRecord.hit2xFlagged = record.hit2xFlagged || false;

if (
            !updatedRecord.hit2xFlagged &&
            launchPriceUsd &&
            peakPriceUsd >= launchPriceUsd * PUMP_WATCH_MULTIPLE &&
            record.deployerAddress
          ) {
            const currentBlock = await withTimeout(provider.getBlockNumber(), 15000, "getBlockNumber for trade count").catch(() => null);
            const tradeCount = currentBlock
              ? await countPoolSwaps(network, record.poolAddress, record.blockNumber, currentBlock)
              : 0;

            if (tradeCount >= config.pumpWatchMinTrades) {
              const tokenKey = `${record.chain}:${record.tokenAddress}`;
              db.recordDeployerHit2x(record.deployerAddress, tokenKey);
              updatedRecord.hit2xFlagged = true;
              console.log(`[${network.label}] ${record.symbol} (${record.tokenAddress}) hit ${PUMP_WATCH_MULTIPLE}x with ${tradeCount} trades -- deployer ${record.deployerAddress} pattern updated.`);
            }
            // If trade count isn't there yet, price stays >= 2x and this
            // check will simply run again next cycle until it clears (or
            // never does, if it was a thin-volume spike).
          }

          const peakLiquidity = Math.max(record.peakLiquidity || 0, baseLiquidityFormatted);
          const wasEverLocked = record.wasEverLocked || isLpTrulyLocked(record.lpLockStatus);
          updatedRecord.peakLiquidity = peakLiquidity;
          updatedRecord.wasEverLocked = wasEverLocked;

          const nowLocked = isLpTrulyLocked(updatedRecord.lpLockStatus);
          const liquidityCollapsed =
            peakLiquidity >= config.safuMinLiquidityEth && baseLiquidityFormatted < peakLiquidity * LIQUIDITY_COLLAPSE_RATIO;
          const lockPulled = wasEverLocked && !nowLocked;

          if ((liquidityCollapsed || lockPulled) && !record.ruggedFlagged && record.deployerAddress) {
            const tokenKey = `${record.chain}:${record.tokenAddress}`;
            db.markDeployerRugged(record.deployerAddress, tokenKey);
            updatedRecord.ruggedFlagged = true;
            console.warn(`[${network.label}] Flagged ${record.symbol} (${record.tokenAddress}) as rugged -- deployer ${record.deployerAddress} reputation updated.`);
          } else {
            updatedRecord.ruggedFlagged = record.ruggedFlagged || false;
          }

          const deployerRecord = updatedRecord.deployerAddress
            ? db.getDeployerRecord(updatedRecord.deployerAddress)
            : { totalLaunches: 0, ruggedCount: 0, hit2xCount: 0 };
          updatedRecord.deployerLaunches = deployerRecord.totalLaunches;
          updatedRecord.deployerRuggedCount = deployerRecord.ruggedCount;
          updatedRecord.deployerHit2xCount = deployerRecord.hit2xCount;

          const topHolderOk =
            updatedRecord.topHolderDataAvailable === false
              ? true
              : updatedRecord.topHolderPct !== null && updatedRecord.topHolderPct < config.safuMaxDeployerPct;
          const ownershipOk = updatedRecord.ownershipRenounced !== false;
          const deployerOk = deployerRecord.ruggedCount === 0;
          const snipingOk =
            updatedRecord.earlySniperPct === null || updatedRecord.earlySniperPct === undefined
              ? true
              : updatedRecord.earlySniperPct < config.safuMaxEarlyConcentrationPct;

          const newIsSafu =
            updatedRecord.verified === true &&
            updatedRecord.riskyFunctions.length === 0 &&
            !updatedRecord.isProxy &&
            topHolderOk &&
            baseLiquidityFormatted >= config.safuMinLiquidityEth &&
            updatedRecord.nameOk !== false &&
            updatedRecord.symbolOk !== false &&
            !updatedRecord.spoofedIdentity &&
            isLpTrulyLocked(updatedRecord.lpLockStatus) &&
            ownershipOk && deployerOk && snipingOk;

          updatedRecord.isSafu = newIsSafu;

          if (newIsSafu && !record.isSafu && !record.alertedAt) {
            updatedRecord.alertedAt = Date.now();
            telegram.sendSafuAlert(updatedRecord);
          }

          const newIsPumpWatch =
            deployerRecord.ruggedCount > 0 &&
            deployerRecord.hit2xCount > 0 &&
            baseLiquidityFormatted >= config.pumpWatchMinLiquidityEth;
          updatedRecord.isPumpWatch = newIsPumpWatch;

          if (newIsPumpWatch && !record.isPumpWatch && !record.pumpWatchAlertedAt) {
            updatedRecord.pumpWatchAlertedAt = Date.now();
            telegram.sendPumpWatchAlert(updatedRecord);
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
  const fromBlock = lastScanned ? lastScanned + 1 : Math.max(0, currentBlock - network.initialLookbackBlocks);

  if (fromBlock > currentBlock) return { network: network.key, scanned: 0, newTokens: 0 };

  console.log(`[${network.label}] Scanning blocks ${fromBlock} -> ${currentBlock} (${currentBlock - fromBlock} blocks)`);
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
    if (t0IsBase === t1IsBase) { skippedNotBasePair += 1; continue; }
    candidates.push({ newToken: t0IsBase ? t1 : t0, baseToken: t0IsBase ? t0 : t1, pool, blockNumber: log.blockNumber });
  }

  const { provider: precheckProvider } = getContext(network);
  const PRECHECK_CONCURRENCY = 10;
  for (let i = 0; i < candidates.length; i += PRECHECK_CONCURRENCY) {
    const slice = candidates.slice(i, i + PRECHECK_CONCURRENCY);
    await Promise.all(
      slice.map(async (c) => {
        try {
          const baseToken = new ethers.Contract(c.baseToken, ERC20_ABI, precheckProvider);
          const bal = await withTimeout(baseToken.balanceOf(c.pool), 15000, "precheck balanceOf");
          c.quickLiquidity = Number(ethers.formatUnits(bal, 18));
        } catch { c.quickLiquidity = 0; }
      })
    );
  }
  candidates.sort((a, b) => b.quickLiquidity - a.quickLiquidity);

  const BATCH_SIZE = 6;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    // Each token handles its own db write and alert(s) the moment ITS OWN
    // analysis resolves -- not after waiting for the rest of the batch. That
    // wait was silent, unnecessary Telegram delay: a fast token used to sit
    // blocked behind whichever batch-mate happened to be slowest.
    const batchPromises = batch.map((c) =>
      withTimeout(
        analyzeNewToken(network, c.newToken, c.baseToken, c.pool, c.blockNumber),
        60000,
        `analyzeNewToken ${c.newToken}`
      )
        .then((record) => {
          const tokenKey = `${record.chain}:${record.tokenAddress}`;
          if (record.deployerAddress) db.recordDeployerLaunch(record.deployerAddress, tokenKey);

          if (record.isSafu) {
            record.alertedAt = Date.now();
            telegram.sendSafuAlert(record);
          }
          if (record.isPumpWatch) {
            record.pumpWatchAlertedAt = Date.now();
            telegram.sendPumpWatchAlert(record);
          }

          db.upsertToken(record);
          newTokenCount += 1;
          console.log(`[${network.label}] Recorded: ${record.symbol} (${record.tokenAddress})`);
        })
        .catch((err) => {
          console.error(`[${network.label}] Failed to analyze token ${c.newToken}:`, err.message);
        })
    );

    await Promise.allSettled(batchPromises);
  }

  db.setLastScannedBlock(network.key, currentBlock);
  console.log(`[${network.label}] Scan summary: ${logs.length} pools found, ${skippedNotBasePair} skipped (wrong pair), ${newTokenCount} recorded`);

  return { network: network.key, scanned: logs.length, newTokens: newTokenCount };
}

let scanInProgress = false;

function forceResetScanLock() {
  if (scanInProgress) console.warn("Forcing scan lock reset -- previous scan was abandoned by the outer watchdog.");
  scanInProgress = false;
}

async function scanOnce() {
  if (scanInProgress) {
    console.log("Scan already in progress, skipping this trigger.");
    return { scanned: 0, newTokens: 0, skipped: true };
  }

  scanInProgress = true;
  try {
    const settled = await Promise.allSettled(config.networks.map((network) => scanNetwork(network)));
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
