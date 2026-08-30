const fs = require("fs");
const path = require("path");
const DB_FILE = path.join(__dirname, "data.json");
function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { tokens: {}, lastScannedBlock: null, deployers: {}, snipers: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!data.deployers) data.deployers = {};
    if (!data.snipers) data.snipers = {};
    return data;
  } catch (err) {
    console.error("Failed to read data.json, starting fresh:", err.message);
    return { tokens: {}, lastScannedBlock: null, deployers: {}, snipers: {} };
  }
}
function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function getAll() {
  const data = load();
  return Object.values(data.tokens).sort((a, b) => b.scannedAt - a.scannedAt);
}
function upsertToken(record) {
  const data = load();
  const key = `${record.chain}:${record.tokenAddress}`;
  data.tokens[key] = record;
  save(data);
}
function getLastScannedBlock(networkKey) {
  const data = load();
  return (data.lastScanned && data.lastScanned[networkKey]) || null;
}
function setLastScannedBlock(networkKey, blockNumber) {
  const data = load();
  if (!data.lastScanned) data.lastScanned = {};
  data.lastScanned[networkKey] = blockNumber;
  save(data);
}
// --- Deployer reputation ---
// Tracks, per deployer wallet, every token launched through this scanner,
// which ones were later confirmed rugged, and which ones hit a "pump"
// multiple (price rose to >= PUMP_WATCH_MULTIPLE x its launch price) before
// anything happened to it either way. Combining rugged + hit2x lets us spot
// a specific repeat pattern: a deployer whose tokens reliably pump before
// they rug -- worth watching, but never treated as a safety signal.
function getDeployerRecord(deployerAddress) {
  if (!deployerAddress) return { totalLaunches: 0, ruggedCount: 0, hit2xCount: 0 };
  const data = load();
  const rec = data.deployers[deployerAddress.toLowerCase()];
  if (!rec) return { totalLaunches: 0, ruggedCount: 0, hit2xCount: 0 };
  return {
    totalLaunches: (rec.launches || []).length,
    ruggedCount: (rec.ruggedTokens || []).length,
    hit2xCount: (rec.hit2xTokens || []).length,
  };
}
function recordDeployerLaunch(deployerAddress, tokenKey) {
  if (!deployerAddress) return;
  const data = load();
  const key = deployerAddress.toLowerCase();
  if (!data.deployers[key]) data.deployers[key] = { launches: [], ruggedTokens: [], hit2xTokens: [] };
  if (!data.deployers[key].launches.includes(tokenKey)) {
    data.deployers[key].launches.push(tokenKey);
  }
  save(data);
}
function markDeployerRugged(deployerAddress, tokenKey) {
  if (!deployerAddress) return;
  const data = load();
  const key = deployerAddress.toLowerCase();
  if (!data.deployers[key]) data.deployers[key] = { launches: [], ruggedTokens: [], hit2xTokens: [] };
  if (!data.deployers[key].ruggedTokens.includes(tokenKey)) {
    data.deployers[key].ruggedTokens.push(tokenKey);
  }
  save(data);
}
function recordDeployerHit2x(deployerAddress, tokenKey) {
  if (!deployerAddress) return;
  const data = load();
  const key = deployerAddress.toLowerCase();
  if (!data.deployers[key]) data.deployers[key] = { launches: [], ruggedTokens: [], hit2xTokens: [] };
  if (!data.deployers[key].hit2xTokens.includes(tokenKey)) {
    data.deployers[key].hit2xTokens.push(tokenKey);
  }
  save(data);
}

// --- Sniper wallet tracking ---
// Tracks, per wallet, every token launch (across all chains) where that
// wallet showed up as a notable early buyer (>=1% of supply within the
// early-sniper window). A wallet that keeps appearing early across many
// DIFFERENT launches is a repeat-sniper pattern worth surfacing -- distinct
// from a single token's one-off early-buyer concentration score.
function getSniperRecord(walletAddress) {
  if (!walletAddress) return { launchesCount: 0, tokenKeys: [] };
  const data = load();
  const rec = data.snipers[walletAddress.toLowerCase()];
  if (!rec) return { launchesCount: 0, tokenKeys: [] };
  return { launchesCount: (rec.tokenKeys || []).length, tokenKeys: rec.tokenKeys || [] };
}
function recordSniperSighting(walletAddress, tokenKey) {
  if (!walletAddress) return;
  const data = load();
  const key = walletAddress.toLowerCase();
  if (!data.snipers[key]) data.snipers[key] = { tokenKeys: [] };
  if (!data.snipers[key].tokenKeys.includes(tokenKey)) {
    data.snipers[key].tokenKeys.push(tokenKey);
  }
  save(data);
}
function getRepeatSnipers(minLaunches) {
  const data = load();
  return Object.entries(data.snipers)
    .map(([wallet, rec]) => ({
      wallet,
      launchesCount: (rec.tokenKeys || []).length,
      tokenKeys: rec.tokenKeys || [],
    }))
    .filter((s) => s.launchesCount >= minLaunches)
    .sort((a, b) => b.launchesCount - a.launchesCount);
}

module.exports = {
  getAll,
  upsertToken,
  getLastScannedBlock,
  setLastScannedBlock,
  getDeployerRecord,
  recordDeployerLaunch,
  markDeployerRugged,
  recordDeployerHit2x,
  getSniperRecord,
  recordSniperSighting,
  getRepeatSnipers,
};
