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
  data.tokens[record.tokenAddress] = record;
  save(data);
}

function getLastScannedBlock() {
  const data = load();
  return data.lastScannedBlock;
}

function setLastScannedBlock(blockNumber) {
  const data = load();
  data.lastScannedBlock = blockNumber;
  save(data);
}

module.exports = { getAll, upsertToken, getLastScannedBlock, setLastScannedBlock };
