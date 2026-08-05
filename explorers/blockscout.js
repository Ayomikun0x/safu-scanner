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

// FIXED: Blockscout's holders endpoint does NOT return a percentage field at
// all -- confirmed against a real response, which only has {address, token_id,
// value}. "value" is the holder's raw token balance. We now calculate the
// percentage ourselves against total supply, using BigInt math to avoid
// precision loss on very large token supplies (often ~1e27 for 18-decimal
// tokens with billions of whole units).
async function fetchTopHolderPct(network, tokenAddress, poolAddress, totalSupplyRaw) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/tokens/${tokenAddress}/holders`);

  if (data && data.__rateLimited) {
    return { pct: null, holder: null, available: null, rateLimited: true };
  }
  if (!data || !Array.isArray(data.items)) {
    return { pct: null, holder: null, available: false, rateLimited: false };
  }

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  let totalSupplyBig = null;
  try {
    if (totalSupplyRaw) totalSupplyBig = BigInt(totalSupplyRaw);
  } catch {
    totalSupplyBig = null;
  }

  let top = { pct: null, holder: null };
  let sawAnyHolder = false;

  for (const item of data.items) {
    const holderAddress = (item.address?.hash || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    sawAnyHolder = true;

    if (!totalSupplyBig || totalSupplyBig === 0n) continue;

    let pct;
    try {
      const valueBig = BigInt(item.value || "0");
      // Multiply by 1,000,000 before dividing to keep 4 decimal places of
      // precision through integer (BigInt) division, then scale back down.
      pct = Number((valueBig * 1000000n) / totalSupplyBig) / 10000;
    } catch {
      continue;
    }

    if (top.pct === null || pct > top.pct) {
      top = { pct, holder: holderAddress };
    }
  }

  if (!sawAnyHolder) {
    return { pct: 0, holder: null, available: true, rateLimited: false };
  }

  // Holders were found but we couldn't compute a percentage for any of them
  // (e.g. totalSupplyRaw wasn't available) -- genuinely unknown, not zero risk.
  if (top.pct === null) {
    return { pct: null, holder: null, available: false, rateLimited: false };
  }

  return { pct: top.pct, holder: top.holder, available: true, rateLimited: false };
}

async function getContractCreator(network, address) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/addresses/${address}`);
  if (data && data.__rateLimited) return { creator: null, rateLimited: true };
  const creator = data?.creator_address_hash || null;
  return { creator: creator ? creator.toLowerCase() : null, rateLimited: false };
}

module.exports = { checkContractVerification, fetchTopHolderPct, getContractCreator };
