const config = require("../config");
const { fetchJsonWithTimeout } = require("../utils/withTimeout");

async function checkContractVerification(network, address) {
  const url =
    `${network.explorerApi}?chainid=${network.chainId}&module=contract&action=getsourcecode` +
    `&address=${address}&apikey=${config.etherscanApiKey}`;
  const data = await fetchJsonWithTimeout(url);

  if (data && data.__rateLimited) {
    return { verified: null, rateLimited: true, riskyFunctions: [], abiText: "" };
  }
  const entry = data?.result?.[0];
  if (!entry || !entry.SourceCode) {
    return { verified: false, rateLimited: false, riskyFunctions: [], abiText: "" };
  }
  const abiText = (entry.ABI || "").toLowerCase();
  return { verified: true, rateLimited: false, riskyFunctions: null, abiText };
}

async function fetchTopHolderPct(network, tokenAddress, poolAddress) {
  // Note: Etherscan's token-holder-list endpoint is restricted to paid plans
  // on many of their chains. If it's unavailable here, we say so explicitly
  // (available: false) rather than silently treating it as safe.
  const url =
    `${network.explorerApi}?chainid=${network.chainId}&module=token&action=tokenholderlist` +
    `&contractaddress=${tokenAddress}&page=1&offset=10&apikey=${config.etherscanApiKey}`;
  const data = await fetchJsonWithTimeout(url);

  if (data && data.__rateLimited) {
    return { pct: null, holder: null, available: null, rateLimited: true };
  }
  if (!data || data.status !== "1" || !Array.isArray(data.result)) {
    return { pct: null, holder: null, available: false, rateLimited: false };
  }

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  let top = { pct: null, holder: null };
  let sawAnyHolder = false;
  for (const item of data.result) {
    const holderAddress = (item.TokenHolderAddress || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    sawAnyHolder = true;
    const pct = Number(item.TokenHolderPercentage ?? NaN);
    if (Number.isNaN(pct)) continue;
    if (top.pct === null || pct > top.pct) {
      top = { pct, holder: holderAddress };
    }
  }

  if (!sawAnyHolder) {
    return { pct: 0, holder: null, available: true, rateLimited: false };
  }

  return { pct: top.pct, holder: top.holder, available: true, rateLimited: false };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
