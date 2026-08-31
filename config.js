require("dotenv").config();
const shared = {
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 5),
  safuMaxDeployerPct: Number(process.env.SAFU_MAX_DEPLOYER_PCT || 5),
  safuMinLiquidityEth: Number(process.env.SAFU_MIN_LIQUIDITY_ETH || 1),
  safuMaxEarlyConcentrationPct: Number(process.env.SAFU_MAX_EARLY_CONCENTRATION_PCT || 30),
  earlySniperWindowBlocks: Number(process.env.EARLY_SNIPER_WINDOW_BLOCKS || 5),
  sniperFlagMinPct: Number(process.env.SNIPER_FLAG_MIN_PCT || 15),
  sniperRepeatMinLaunches: Number(process.env.SNIPER_REPEAT_MIN_LAUNCHES || 3),
  pumpWatchMinLiquidityEth: Number(process.env.PUMP_WATCH_MIN_LIQUIDITY_ETH || 0.5),
  pumpWatchMinTrades: Number(process.env.PUMP_WATCH_MIN_TRADES || 10),
  pumpWatchMinLaunches: Number(process.env.PUMP_WATCH_MIN_LAUNCHES || 10),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me-please",
  sessionSecret: process.env.SESSION_SECRET || "insecure-dev-secret",
  port: Number(process.env.PORT || 3000),
  burnAddresses: new Set([
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]),
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  telegramEnabled: process.env.TELEGRAM_ENABLED !== "false",
};

// Derives a wss:// URL from an https:// RPC URL when no explicit RH_WS_URL
// is provided. Works for the common case (Alchemy, and most providers)
// where the WebSocket endpoint lives at the same host/path, just a
// different scheme.
function deriveWsUrl(explicitWsUrl, httpUrl) {
  if (explicitWsUrl) return explicitWsUrl;
  if (!httpUrl) return null;
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice("https://".length);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice("http://".length);
  return null;
}

const robinhoodRpcUrl = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const networks = [
  {
    key: "robinhood",
    label: "Robinhood Chain",
    rpcUrl: robinhoodRpcUrl,
    wsUrl: deriveWsUrl(process.env.RH_WS_URL, robinhoodRpcUrl),
    // Switched back to block-range polling: Robinhood Chain is very new,
    // and Alchemy's log-subscription feature (eth_subscribe("logs", ...))
    // isn't confirmed supported for it yet -- the WebSocket connects fine,
    // but never actually delivers PoolCreated events. Polling in small
    // chunks (see logChunkSize) avoids depending on that feature entirely.
    // The WebSocket listener (robinhoodListener.js) still runs alongside
    // this as a bonus/backup in case subscriptions start
