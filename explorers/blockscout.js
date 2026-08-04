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
    // Genuine failure or unsupported endpoint on this chain's explorer --
    // be honest that we don't know, rather than quietly implying "checked,
    // no risk found" (which is what silently defaulting pct to null while
    // saying available:true effectively did before).
    return { pct: null, holder: null, available: false, rateLimited: false };
  }

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  let top = { pct: null, holder: null };
  let sawAnyHolder = false;
  for (const item of data.items) {
    const holderAddress = (item.address?.hash || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    sawAnyHolder = true;
    const pct = Number(item.percentage ?? item.token_id_percentage ?? NaN);
    if (Number.isNaN(pct)) continue;
    if (top.pct === null || pct > top.pct) {
      top = { pct, holder: holderAddress };
    }
  }

  // We got a real, valid holder list back, but nobody besides the pool/burn
  // addresses holds any supply yet (e.g. a token that's brand new and
  // hasn't had any external buys). That's genuinely 0% concentration risk,
  // not a failed lookup -- report it as such instead of leaving it null.
  if (!sawAnyHolder) {
    return { pct: 0, holder: null, available: true, rateLimited: false };
  }

  return { pct: top.pct, holder: top.holder, available: true, rateLimited: false };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
