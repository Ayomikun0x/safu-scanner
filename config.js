require("dotenv").config();

module.exports = {
  rpcUrl: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  chainId: 4663,
  factoryAddress: (process.env.FACTORY_ADDRESS || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa").toLowerCase(),
  positionManagerAddress: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  explorerApi: process.env.EXPLORER_API || "https://robinhoodchain.blockscout.com/api/v2",
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 5),
  minLiquidityEth: Number(process.env.MIN_LIQUIDITY_ETH || 0.5),

  // Robinhood Chain produces blocks roughly every 0.1s, so block counts here go
  // much further than on slower chains. Default covers ~90 minutes of history
  // on a fresh start (no previously stored scan position).
  initialLookbackBlocks: Number(process.env.INITIAL_LOOKBACK_BLOCKS || 54000),

  // A token counts as "SAFU" (shown on the filtered side) only if all of these hold:
  // - contract source is verified
  // - no risky functions (mint/blacklist/pause/etc.) found
  // - deployer wallet holds less than this % of supply
  // - LP status is anything except "unlocked" (burned/locked/unknown all pass)
 safuMaxDeployerPct: Number(process.env.SAFU_MAX_DEPLOYER_PCT || 5),

  // Minimum liquidity (in the base asset, e.g. WETH) for a token to count as
  // SAFU. "All launches" still shows everything regardless of this value.
  safuMinLiquidityEth: Number(process.env.SAFU_MIN_LIQUIDITY_ETH || 1),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me-please",
  sessionSecret: process.env.SESSION_SECRET || "insecure-dev-secret",
  port: Number(process.env.PORT || 3000),

  // Tokens we treat as "the pair", not "the new token", when a pool is created.
  knownBaseTokens: new Set([
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // native ETH placeholder
  ]),

  // Addresses that count as "liquidity burned" if the LP position NFT ends up there.
  burnAddresses: new Set([
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
  ]),

  // Known third-party liquidity locker contracts on Robinhood Chain.
  // Empty by default since none are confirmed yet -- add addresses here as you
  // identify them (e.g. from UNCX or similar) and the scanner will recognize them.
  knownLockerContracts: new Set([
    // "0x...uncxLockerAddress"
  ]),
};
