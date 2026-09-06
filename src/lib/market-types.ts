export type StockAsset = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  multiplier: string;
  logo: string | null;
  active: boolean;
  pendingMultiplier?: string | null;
  pendingMultiplierEffectiveTime?: string | null;
  tradingCapabilities?: { fractionalTradability: string | null; allDayTradability: string | null; extendedHoursFractionalTradability: boolean | null } | null;
};
export type ReferencePrice = {
  symbol: string;
  bid: string;
  ask: string;
  generatedAt: string;
  halted: boolean;
  currency: "USD";
  dailyTradingVolume?: string | null;
};
export type SnapshotStatus = {
  dataStatus?: { state: "cached"; reason: string; retryAt: string };
};
export type Catalog = SnapshotStatus & {
  assets: StockAsset[];
  fetchedAt: string;
  rejected: number;
};
export type PriceBook = SnapshotStatus & {
  quotes: ReferencePrice[];
  fetchedAt: string;
  unavailableSymbols?: string[];
  cachedSymbols?: string[];
};
export type NetworkState = SnapshotStatus & {
  chainId: number;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  gasPriceWei: string;
  fetchedAt: string;
  provider: "public" | "dedicated";
  executionEnabled: false;
};
export type Pool = {
  address: `0x${string}`;
  fee: number;
  liquidity: string;
  priceUSDG: number | null;
  active: boolean;
};
export type PoolBook = SnapshotStatus & {
  symbol: string;
  pools: Pool[];
  blockNumber: string;
  blockTimestamp: string;
  fetchedAt: string;
  failedReads: number;
};
export type RouteQuote = {
  buyFee: number;
  sellFee: number;
  buyPool: string;
  sellPool: string;
  amountOut: string;
  surplus: string;
  gasUnits: string;
  crossedTicks: number[];
};
export type QuoteBook = {
  symbol: string;
  amountIn: string;
  settlementDecimals: number;
  blockNumber: string;
  blockTimestamp: string;
  blockHash: string;
  fetchedAt: string;
  expiresAt: string;
  routes: RouteQuote[];
  attempted: number;
  failed: number;
  coverage?: {
    venue: "Uniswap V3";
    feeTiers: number[];
    discoveredPools: number;
    activePools: number;
  };
  availability?: "quoted" | "no_pools" | "one_active_pool" | "no_active_pools" | "simulations_failed";
  executionEnabled: false;
};
export type Portfolio = {
  address: string;
  blockNumber: string;
  fetchedAt: string;
  nativeBalance: string;
  tokens: {
    symbol: string;
    address: string;
    decimals: number;
    balance: string | null;
  }[];
};
export type CorporateActions = SnapshotStatus & {
  items: {
    symbol: string;
    type: string;
    status: string;
    date: string | null;
    id?: string;
    detail?: string | null;
  }[];
  fetchedAt: string;
};
export const CHAIN_ID = 4663;
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;
export const V3_QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as const;
export const SWAP_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2" as const;
export const TRACKED_SYMBOLS = [
  "NVDA",
  "AAPL",
  "TSLA",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "SPY",
];
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export const QUOTE_TTL_MS = 20000;
