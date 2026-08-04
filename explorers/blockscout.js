const { fetchJsonWithTimeout } = require("../utils/withTimeout");

async function checkContractVerification(network, address) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/smart-contracts/${address}`);

  if (data && data.__rateLimited) {
    return { verified: null, rateLimited: true, riskyFunctions: [], abiText: "" };
  }
  if (!data) {
    return { verified: false, rateLimited: false, riskyFunctions: [], abiText: "" };
  }
  const abiText = JSON.stringify(data.abi || []).toLowerCase();
  return { verified: true, rateLimited: false, riskyFunctions: null, abiText };
}

async function fetchTopHolderPct(network, tokenAddress, poolAddress) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/tokens/${tokenAddress}/holders`);

  if (data && data.__rateLimited) {
    return { pct: null, holder: null, available: null, rateLimited: true };
  }
  if (!data || !Array.isArray(data.items)) {
    return { pct: null, holder: null, available: true, rateLimited: false };
  }

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  let top = { pct: null, holder: null };
  for (const item of data.items) {
    const holderAddress = (item.address?.hash || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    const pct = Number(item.percentage ?? item.token_id_percentage ?? NaN);
    if (Number.isNaN(pct)) continue;
    if (top.pct === null || pct > top.pct) {
      top = { pct, holder: holderAddress };
    }
  }
  return { pct: top.pct, holder: top.holder, available: true, rateLimited: false };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
