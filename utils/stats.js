const config = require("../config");

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function isLpTrulyLocked(status) {
  return status === "locked" || status === "burned";
}

// Summarizes db.getAll() into real numbers instead of eyeballing dashboard
// screenshots -- current pass rates, where tokens are actually failing, and
// the real distribution of liquidity/concentration you're seeing, so
// threshold tuning is based on your actual traffic, not guesswork.
function computeStats(tokens) {
  const byChain = {};

  for (const t of tokens) {
    if (!byChain[t.chain]) {
      byChain[t.chain] = {
        chainLabel: t.chainLabel,
        totalTokens: 0,
        safuCount: 0,
        pumpWatchCount: 0,
        liquidityValues: [],
        topHolderValues: [],
        earlySniperValues: [],
        failCounts: {
          notVerified: 0,
          hasRiskyFunctions: 0,
          isProxy: 0,
          topHolderTooHigh: 0,
          topHolderUnavailable: 0,
          liquidityTooLow: 0,
          nameOrSymbolFailed: 0,
          spoofedIdentity: 0,
          lpNotLocked: 0,
          ownershipNotRenounced: 0,
          ownershipUnknown: 0,
          deployerHasRugs: 0,
          earlySnipingTooHigh: 0,
        },
        deployers: {},
      };
    }

    const c = byChain[t.chain];
    c.totalTokens += 1;
    if (t.isSafu) c.safuCount += 1;
    if (t.isPumpWatch) c.pumpWatchCount += 1;

    if (typeof t.baseLiquidity === "number") c.liquidityValues.push(t.baseLiquidity);
    if (t.topHolderPct !== null && t.topHolderPct !== undefined) c.topHolderValues.push(t.topHolderPct);
    if (t.earlySniperPct !== null && t.earlySniperPct !== undefined) c.earlySniperValues.push(t.earlySniperPct);

    if (!t.verified) c.failCounts.notVerified += 1;
    if (t.riskyFunctions && t.riskyFunctions.length > 0) c.failCounts.hasRiskyFunctions += 1;
    if (t.isProxy) c.failCounts.isProxy += 1;

    if (t.topHolderDataAvailable === false) {
      c.failCounts.topHolderUnavailable += 1;
    } else if (t.topHolderPct !== null && t.topHolderPct >= config.safuMaxDeployerPct) {
      c.failCounts.topHolderTooHigh += 1;
    }

    if (typeof t.baseLiquidity === "number" && t.baseLiquidity < config.safuMinLiquidityEth) {
      c.failCounts.liquidityTooLow += 1;
    }

    if (t.nameOk === false || t.symbolOk === false) c.failCounts.nameOrSymbolFailed += 1;
    if (t.spoofedIdentity) c.failCounts.spoofedIdentity += 1;
    if (!isLpTrulyLocked(t.lpLockStatus)) c.failCounts.lpNotLocked += 1;

    if (t.ownershipRenounced === false) c.failCounts.ownershipNotRenounced += 1;
    else if (t.ownershipRenounced === null || t.ownershipRenounced === undefined) c.failCounts.ownershipUnknown += 1;

    if ((t.deployerRuggedCount || 0) > 0) c.failCounts.deployerHasRugs += 1;

    if (
      t.earlySniperPct !== null &&
      t.earlySniperPct !== undefined &&
      t.earlySniperPct >= config.safuMaxEarlyConcentrationPct
    ) {
      c.failCounts.earlySnipingTooHigh += 1;
    }

    if (t.deployerAddress) {
      if (!c.deployers[t.deployerAddress]) {
        c.deployers[t.deployerAddress] = { launches: 0, rugged: 0, hit2x: 0 };
      }
      const d = c.deployers[t.deployerAddress];
      d.launches = Math.max(d.launches, t.deployerLaunches || 0);
      d.rugged = Math.max(d.rugged, t.deployerRuggedCount || 0);
      d.hit2x = Math.max(d.hit2x, t.deployerHit2xCount || 0);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    thresholds: {
      safuMaxDeployerPct: config.safuMaxDeployerPct,
      safuMinLiquidityEth: config.safuMinLiquidityEth,
      safuMaxEarlyConcentrationPct: config.safuMaxEarlyConcentrationPct,
      pumpWatchMinLiquidityEth: config.pumpWatchMinLiquidityEth,
      pumpWatchMinTrades: config.pumpWatchMinTrades,
      pumpWatchMinLaunches: config.pumpWatchMinLaunches,
    },
    byChain: {},
  };

  for (const [chainKey, c] of Object.entries(byChain)) {
    const uniqueDeployers = Object.keys(c.deployers).length;
    const ruggedDeployers = Object.values(c.deployers).filter((d) => d.rugged > 0).length;

    result.byChain[chainKey] = {
      chainLabel: c.chainLabel,
      totalTokens: c.totalTokens,
      safuCount: c.safuCount,
      safuPassRate: c.totalTokens ? +((c.safuCount / c.totalTokens) * 100).toFixed(2) : 0,
      pumpWatchCount: c.pumpWatchCount,
      liquidity: {
        min: c.liquidityValues.length ? Math.min(...c.liquidityValues) : null,
        max: c.liquidityValues.length ? Math.max(...c.liquidityValues) : null,
        average: average(c.liquidityValues),
        median: median(c.liquidityValues),
      },
      topHolderPct: {
        sampleSize: c.topHolderValues.length,
        average: average(c.topHolderValues),
        median: median(c.topHolderValues),
      },
      earlySniperPct: {
        sampleSize: c.earlySniperValues.length,
        average: average(c.earlySniperValues),
        median: median(c.earlySniperValues),
      },
      failReasonCounts: c.failCounts,
      uniqueDeployers,
      deployersWithAtLeastOneRug: ruggedDeployers,
    };
  }

  return result;
}

module.exports = { computeStats };
