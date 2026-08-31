const { ethers } = require("ethers");
const config = require("./config");
const { FACTORY_ABI } = require("./abis");
const { processCandidate } = require("./scanner");
const { withTimeout } = require("./utils/withTimeout");

const BASE_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 2 * 60 * 1000; // 2 minutes
const JITTER_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

let currentProvider = null;
let currentFactory = null;
let reconnectTimer = null; // set whenever a reconnect is already scheduled -- guards against overlapping attempts
let connecting = false; // true while a connection attempt (construction through open/error) is in flight
let reconnectAttempt = 0; // resets to 0 on a successful open; grows on each failure for backoff
let heartbeatTimer = null; // periodic liveness check -- catches a connection that's technically open but silently dead

function getRobinhoodNetwork() {
  const network = config.networks.find((n) => n.key === "robinhood");
  if (!network) throw new Error("robinhood network not found in config.networks");
  if (!network.wsUrl) throw new Error("robinhood network has no wsUrl configured (set RH_WS_URL)");
  return network;
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
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

// Exponential backoff with jitter: 5s, 10s, 20s, 40s, 80s, capped at 2min.
// Jitter avoids every retry landing on the exact same clock tick after a
// shared rate-limit window resets.
function nextReconnectDelay() {
  const exp = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return exp + jitter;
}

function scheduleReconnect(network) {
  // Only one reconnect timer may be pending at a time -- prevents the
  // overlapping-attempt bug where a slow-closing old socket and a
  // newly-scheduled attempt both fire around the same moment.
  if (reconnectTimer) return;

  stopHeartbeat();

  const delay = nextReconnectDelay();
  reconnectAttempt += 1;
  console.warn(`[${network.label}] (live) WebSocket disconnected, reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempt})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startRobinhoodListener().catch((err) => {
      console.error(`[${network.label}] (live) Reconnect attempt failed:`, err.message);
      scheduleReconnect(network);
    });
  }, delay);
}

// Periodically confirms the connection is genuinely responsive, not just
// technically "open". Some networks let a WebSocket go silently dead --
// still open at the socket level, never firing a close/error event -- while
// no longer actually delivering anything. Without this, a stale connection
// could sit "active" forever while missing every new pool.
function startHeartbeat(network, provider) {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    try {
      await withTimeout(provider.getBlockNumber(), HEARTBEAT_TIMEOUT_MS, "heartbeat getBlockNumber");
    } catch (err) {
      console.warn(`[${network.label}] (live) Heartbeat failed, treating connection as dead:`, err.message);
      stopHeartbeat();
      currentProvider = null;
      currentFactory = null;
      try { provider.destroy(); } catch {}
      scheduleReconnect(network);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function startRobinhoodListener() {
  const network = getRobinhoodNetwork();

  // Don't start a second connection attempt while one is already in flight.
  if (connecting) return;
  connecting = true;

  // Tear down any previous socket cleanly before opening a new one.
  stopHeartbeat();
  if (currentFactory) {
    try { currentFactory.removeAllListeners("PoolCreated"); } catch {}
    currentFactory = null;
  }
  if (currentProvider) {
    try { currentProvider.destroy(); } catch {}
    currentProvider = null;
  }

  const provider = new ethers.WebSocketProvider(network.wsUrl, network.chainId);
  const rawSocket = provider.websocket;

  let settled = false;

  const onOpenSuccess = () => {
    if (settled) return;
    settled = true;
    connecting = false;
    reconnectAttempt = 0; // reset backoff after a clean connection
    currentProvider = provider;
    const factory = new ethers.Contract(network.factoryAddress, FACTORY_ABI, provider);
    currentFactory = factory;
    attachFactoryListener(network, factory);
    startHeartbeat(network, provider);
    console.log(`[${network.label}] (live) WebSocket subscription active for new pools.`);
  };

  const onFailure = (reason) => {
    if (settled) {
      // Socket closed after we were already up and running.
      stopHeartbeat();
      currentProvider = null;
      currentFactory = null;
      scheduleReconnect(network);
      return;
    }
    settled = true;
    connecting = false;
    if (reason) console.error(`[${network.label}] (live) WebSocket error:`, reason?.message || reason);
    try { provider.destroy(); } catch {}
    scheduleReconnect(network);
  };

  if (rawSocket) {
    // Most ws-like clients expose onopen/onclose/onerror. Only treat the
    // connection as "active" once onopen actually fires -- constructing the
    // provider doesn't guarantee the handshake succeeded, and Alchemy can
    // reject at the handshake with a 429 before onopen ever fires.
    rawSocket.onopen = onOpenSuccess;
    rawSocket.onclose = () => onFailure(null);
    rawSocket.onerror = (err) => onFailure(err);

    // If the socket is already open by the time we attach handlers (can
    // happen depending on the underlying ws implementation's timing),
    // treat it as success immediately.
    if (rawSocket.readyState === 1 /* OPEN */) {
      onOpenSuccess();
    }
  } else {
    // No raw socket exposed -- fall back to treating construction as
    // success; errors will still surface via the provider's own error
    // event handling in ethers, though we can't distinguish handshake
    // rejection as precisely here.
    onOpenSuccess();
  }
}

module.exports = { startRobinhoodListener };
