require("dotenv").config();

// Global settings shared across every network we scan.
const shared = {
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 5),

  // A token counts as "SAFU" only if all of these hold:
  // - contract source is verified
  // - no risky functions (mint/blacklist/pause/etc.) found
  // - not an upgradeable/proxy contract
  // - top holder (excluding the pool) holds less than this % of supply
  // - liquidity is at least this much of the network's base asset
  safuMaxDeployerPct: Number(process.env.SAFU_MAX_DEPLOYER_PCT || 5),
  safuMinLiquidityEth: Number(process.env.SAFU_MIN_LIQUIDITY_ETH || 1),

  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me-please",
  sessionSecret: process.env.SESSION_SECRET || "insecure-dev-secret",
  port: Number(process.env.PORT || 3000),

  // Addresses that count as "liquidity burned" if the LP position NFT ends up there.
  burnAddresses: new Set([
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000",
  ]),

  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",
};

// Per-network settings. Each network has its own chain, contracts, and
// explorer API -- "explorerType" controls which client code (blockscout.js
// vs etherscan.js) scanner.js uses to talk to it.
const networks = [
  {
    key: "robinhood",
    label: "Robinhood Chain",
    rpcUrl: process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    chainId: 4663,
    factoryAddress: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    positionManagerAddress: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    explorerType: "blockscout",
    explorerApi: "https://robinhoodchain.blockscout.com/api/v2",
    explorerAddressBase: "https://robinhoodchain.blockscout.com/address/",
    uniswapPoolUrlBase: "https://app.uniswap.org/explore/pools/robinhoodchain/",

    // Robinhood Chain produces blocks roughly every 0.1s, so block counts here
    // go much further than on slower chains. ~90 minutes of history.
    initialLookbackBlocks: Number(process.env.RH_INITIAL_LOOKBACK_BLOCKS || 54000),

    baseAssetSymbolFallback: "WETH",
    // Tokens we treat as "the pair", not "the new token", when a pool is created.
    knownBaseTokens: new Set([
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
    ]),
    // Stablecoins we treat as ~$1 directly (skip ETH-price lookup for these).
    usdStableBases: new Set([
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
    ]),
    // Known third-party liquidity locker contracts. Empty until confirmed.
    knownLockerContracts: new Set([]),
  },
  {
    key: "stable",
    label: "Stable Chain",
    rpcUrl: process.env.STABLE_RPC_URL || "https://rpc.stable.xyz",
    chainId: 988,
    factoryAddress: "0x88f0a512ef09175d456bc9547f914f48c013e4aa",
    positionManagerAddress: "0x3bdc3437405f7d801b6036532713fc1f179136a6",
    explorerType: "etherscan",
    explorerApi: "https://api.etherscan.io/v2/api",
    explorerAddressBase: "https://stablescan.xyz/address/",
    uniswapPoolUrlBase: "https://stablescan.xyz/address/", // no Uniswap Explore page for this chain yet

    // Stable chain produces blocks roughly every 0.7s. ~90 minutes of history.
    initialLookbackBlocks: Number(process.env.STABLE_INITIAL_LOOKBACK_BLOCKS || 7700),

    baseAssetSymbolFallback: "USDT0",
    knownBaseTokens: new Set([
      "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0
    ]),
    usdStableBases: new Set([
      "0x779ded0c9e1022225f8e0630b35a9b54be713736", // USDT0 is already ~$1
    ]),
    knownLockerContracts: new Set([]),
  },
];

module.exports = { ...shared, networks };
