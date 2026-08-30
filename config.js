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
    // Robinhood Chain's RPC (Alchemy free tier) caps eth_getLogs to a 10
    // block range, which makes polling for new pools impractical at this
    // chain's block speed. New-pool discovery runs over a WebSocket
    // subscription instead (see robinhoodListener.js); the polling loop
    // below still handles price refresh for already-known Robinhood tokens.
    // NOTE: the WebSocket connection is currently failing at handshake
    // (400 response) -- still needs its own fix, tracked separately.
    pollNewPools: false,
    chainId: 4663,
    factoryAddress: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    positionManagerAddress: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    explorerType: "blockscout",
    explorerApi: "https://robinhoodchain.blockscout.com/api/v2",
    explorerAddressBase: "https://robinhoodchain.blockscout.com/address/",
    uniswapPoolUrlBase: "https://app.uniswap.org/explore/pools/robinhoodchain/",
    initialLookbackBlocks: Number(process.env.RH_INITIAL_LOOKBACK_BLOCKS || 10800),
    logChunkSize: Number(process.env.RH_LOG_CHUNK_SIZE || 10),
    baseAssetSymbolFallback: "WETH",
    knownBaseTokens: new Set([
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    ]),
    usdStableBases: new Set([
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    ]),
    knownLockerContracts: new Set([
      "0x736d76699c26d0d966744cae304c000d471f7f35",
      "0x31ca5e101941a93a7dd6d0497928700625cf54b5",
    ]),
  },
  {
    key: "bsc",
    label: "BSC",
    rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/",
    wsUrl: null,
    // Public BSC nodes are far less restrictive than Alchemy's free tier
    // was for Robinhood Chain, so plain block-range polling works fine
    // here -- no WebSocket listener needed.
    pollNewPools: true,
    chainId: 56,
    factoryAddress: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865", // PancakeSwap V3 Factory
    positionManagerAddress: "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364", // PancakeSwap V3 NonfungiblePositionManager
    explorerType: "etherscan",
    explorerApi: "https://api.etherscan.io/v2/api",
    explorerAddressBase: "https://bscscan.com/address/",
    uniswapPoolUrlBase: "https://bscscan.com/address/",
    initialLookbackBlocks: Number(process.env.BSC_INITIAL_LOOKBACK_BLOCKS || 2000),
    logChunkSize: Number(process.env.BSC_LOG_CHUNK_SIZE || 2000),
    baseAssetSymbolFallback: "WBNB",
    knownBaseTokens: new Set([
      "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
      "0x55d398326f99059ff775485246999027b3197955", // USDT (Binance-Peg BSC-USD)
    ]),
    usdStableBases: new Set([
      "0x55d398326f99059ff775485246999027b3197955",
    ]),
    knownLockerContracts: new Set([]),
  },
];

module.exports = { ...shared, networks };
