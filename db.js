const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { tokens: {}, lastScannedBlock: null, deployers: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    if (!data.deployers) data.deployers = {};
    return data;
  } catch (err) {
    console.error("Failed to read data.json, starting fresh:", err.message);
    return { tokens: {}, lastScannedBlock: null, deployers: {} };
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
// Tracks, per deployer wallet address, every token they've launched through
// this scanner and which of those we later confirmed as rugged (liquidity
// collapsed or a locked/burned LP got pulled). This only knows what THIS
// scanner has observed since it started running -- it has no memory of a
// wallet's history from before, and it only becomes useful after some time
// running.

function getDeployerRecord(deployerAddress) {
  if (!deployerAddress) return { totalLaunches: 0, ruggedCount: 0 };
  const data = load();
  const rec = data.deployers[deployerAddress.toLowerCase()];
  if (!rec) return { totalLaunches: 0, ruggedCount: 0 };
  return {
    totalLaunches: (rec.launches || []).length,
    ruggedCount: (rec.ruggedTokens || []).length,
  };
}

function recordDeployerLaunch(deployerAddress, tokenKey) {
  if (!deployerAddress) return;
  const data = load();
  const key = deployerAddress.toLowerCase();
  if (!data.deployers[key]) data.deployers[key] = { launches: [], ruggedTokens: [] };
  if (!data.deployers[key].launches.includes(tokenKey)) {
    data.deployers[key].launches.push(tokenKey);
  }
  save(data);
}

function markDeployerRugged(deployerAddress, tokenKey) {
  if (!deployerAddress) return;
  const data = load();
  const key = deployerAddress.toLowerCase();
  if (!data.deployers[key]) data.deployers[key] = { launches: [], ruggedTokens: [] };
  if (!data.deployers[key].ruggedTokens.includes(tokenKey)) {
    data.deployers[key].ruggedTokens.push(tokenKey);
  }
  save(data);
}

module.exports = {
  getAll,
  upsertToken,
  getLastScannedBlock,
  setLastScannedBlock,
  getDeployerRecord,
  recordDeployerLaunch,
  markDeployerRugged,
};
