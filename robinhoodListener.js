const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI } = require("./abis");
const { processCandidate } = require("./scanner");

const RECONNECT_DELAY_MS = 5000;

let currentProvider = null;
let currentFactory = null;
let reconnecting = false;

function getRobinhoodNetwork() {
  const network = config.networks.find((n) => n.key === "robinhood");
  if (!network) throw new Error("robinhood network not found in config.networks");
  if (!network.wsUrl) throw new Error("robinhood network has no wsUrl configured (set RH_WS_URL)");
  return network;
}

async function handlePoolCreated(network, token0, token1, fee, tickSpacing, pool, event) {
  try {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const t0IsBase = network.knownBaseTokens.has(t0);
    const t1IsBase = network.knownBaseTokens.has(t1);
    if (t0IsBase === t1IsBase) return; // not a base-token pair, skip

    const candidate = {
      newToken: t0IsBase ? t1 : t0,
      baseToken: t0IsBase ? t0 : t1,
      pool,
      blockNumber: event.log.blockNumber,
    };

    console.log(`[${network.label}] (live) New pool detected: ${pool} at block ${candidate.blockNumber}`);
    await processCandidate(network, candidate);
  } catch (err) {
    console.error(`[${network.label}] (live) Failed to process pool event:`, err.message);
  }
}

function attachFactoryListener(network, factory) {
  factory.on("PoolCreated", (token0, token1, fee, tickSpacing, pool, event) => {
    handlePoolCreated(network, token0, token1, fee, tickSpacing, pool, event);
  });
}

function scheduleReconnect(network) {
  if (reconnecting) return;
  reconnecting = true;
  console.warn(`[${network.label}] (live) WebSocket disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
  setTimeout(() => {
    reconnecting = false;
    startRobinhoodListener().catch((err) => {
      console.error(`[${network.label}] (live) Reconnect attempt failed:`, err.message);
      scheduleReconnect(network);
    });
  }, RECONNECT_DELAY_MS);
}

async function startRobinhoodListener() {
  const network = getRobinhoodNetwork();

  // Tear down any previous socket cleanly before opening a new one.
  if (currentFactory) {
    try { currentFactory.removeAllListeners("PoolCreated"); } catch {}
  }
  if (currentProvider) {
    try { currentProvider.destroy(); } catch {}
  }

  const provider = new ethers.WebSocketProvider(network.wsUrl, network.chainId);
  const factory = new ethers.Contract(network.factoryAddress, FACTORY_ABI, provider);

  currentProvider = provider;
  currentFactory = factory;

  // ethers v6's underlying websocket exposes the raw ws client at
  // provider.websocket -- wire up close/error so a dropped connection
  // (idle timeout, network blip, provider restart) gets rediscovered
  // instead of silently going quiet.
  const rawSocket = provider.websocket;
  if (rawSocket) {
    rawSocket.onclose = () => scheduleReconnect(network);
    rawSocket.onerror = (err) => {
      console.error(`[${network.label}] (live) WebSocket error:`, err?.message || err);
    };
  }

  attachFactoryListener(network, factory);
  console.log(`[${network.label}] (live) WebSocket subscription active for new pools.`);
}

module.exports = { startRobinhoodListener };
