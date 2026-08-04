const { fetchJsonWithTimeout } = require("../utils/withTimeout");

async function checkContractVerification(network, address) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/smart-contracts/${address}`);
  if (!data) return { verified: false, riskyFunctions: [], abiText: "" };
  const abiText = JSON.stringify(data.abi || []).toLowerCase();
  return { verified: true, riskyFunctions: null, abiText };
}

async function fetchTopHolderPct(network, tokenAddress, poolAddress) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/tokens/${tokenAddress}/holders`);
  if (!data || !Array.isArray(data.items)) return { pct: null, holder: null, available: true };

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  // Don't assume the API returns holders pre-sorted descending -- scan
  // everything and take the true maximum, so a differently-ordered (or
  // unordered) response can't silently under-report concentration risk.
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
  return { pct: top.pct, holder: top.holder, available: true };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
