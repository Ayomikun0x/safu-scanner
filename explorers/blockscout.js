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
  for (const item of data.items) {
    const holderAddress = (item.address?.hash || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    const pct = Number(item.percentage ?? item.token_id_percentage ?? null);
    if (!Number.isNaN(pct) && pct !== null) {
      return { pct, holder: holderAddress, available: true };
    }
    return { pct: null, holder: holderAddress, available: true };
  }
  return { pct: null, holder: null, available: true };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
