const config = require("../config");

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function checkContractVerification(network, address) {
  const url =
    `${network.explorerApi}?chainid=${network.chainId}&module=contract&action=getsourcecode` +
    `&address=${address}&apikey=${config.etherscanApiKey}`;
  const data = await fetchJson(url);

  const entry = data?.result?.[0];
  if (!entry || !entry.SourceCode) {
    return { verified: false, riskyFunctions: [], abiText: "" };
  }

  const abiText = (entry.ABI || "").toLowerCase();
  return { verified: true, riskyFunctions: null, abiText };
}

async function fetchTopHolderPct(network, tokenAddress, poolAddress) {
  // Note: Etherscan's token-holder-list endpoint is restricted to paid plans
  // on many of their chains. If it's unavailable here, we say so explicitly
  // (available: false) rather than silently treating it as safe.
  const url =
    `${network.explorerApi}?chainid=${network.chainId}&module=token&action=tokenholderlist` +
    `&contractaddress=${tokenAddress}&page=1&offset=10&apikey=${config.etherscanApiKey}`;
  const data = await fetchJson(url);

  if (!data || data.status !== "1" || !Array.isArray(data.result)) {
    return { pct: null, holder: null, available: false };
  }

  const excluded = new Set([
    poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]);

  for (const item of data.result) {
    const holderAddress = (item.TokenHolderAddress || "").toLowerCase();
    if (!holderAddress || excluded.has(holderAddress)) continue;
    const pct = Number(item.TokenHolderPercentage ?? null);
    return {
      pct: Number.isNaN(pct) ? null : pct,
      holder: holderAddress,
      available: true,
    };
  }

  return { pct: null, holder: null, available: true };
}

module.exports = { checkContractVerification, fetchTopHolderPct };
