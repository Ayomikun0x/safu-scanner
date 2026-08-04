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

  if (!sawAnyHolder) {
    return { pct: 0, holder: null, available: true, rateLimited: false };
  }

  return { pct: top.pct, holder: top.holder, available: true, rateLimited: false };
}

// FIXED: creator info doesn't live on the smart-contracts endpoint at all
// (confirmed by inspecting a real response) -- it's on Blockscout's address
// endpoint instead, under `creator_address_hash`. This is now only a
// fallback path -- scanner.js tries the token's own on-chain deployer()
// getter first, which covers Pons-launched tokens directly without needing
// this endpoint at all.
async function getContractCreator(network, address) {
  const data = await fetchJsonWithTimeout(`${network.explorerApi}/addresses/${address}`);
  if (data && data.__rateLimited) return { creator: null, rateLimited: true };
  const creator = data?.creator_address_hash || null;
  return { creator: creator ? creator.toLowerCase() : null, rateLimited: false };
}

module.exports = { checkContractVerification, fetchTopHolderPct, getContractCreator };
