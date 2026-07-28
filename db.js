const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { tokens: {}, lastScannedBlock: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to read data.json, starting fresh:", err.message);
    return { tokens: {}, lastScannedBlock: null };
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

module.exports = { getAll, upsertToken, getLastScannedBlock, setLastScannedBlock };
