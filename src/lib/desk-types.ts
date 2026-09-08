import type { SnapshotStatus } from "./market-types";

/** Asset amounts are base-10 integer strings in USDG's six decimal places. */
export type DeskWalletPosition = {
  address: `0x${string}`;
  shares: string;
  redeemableAssets: string;
  claimableAssets: string;
  assetBalance: string;
  allowance: string;
};

export type DeskEvent = {
  id: string;
  kind: "deposit" | "withdrawal" | "profit" | "claim";
  transactionHash: `0x${string}`;
  blockNumber: string;
  account: `0x${string}` | null;
  assets: string;
  rewards: string | null;
  retained: string | null;
};

export interface DeskSnapshot extends SnapshotStatus {
  chainId: number;
  fetchedAt: string;
  blockNumber: string | null;
  blockTimestamp: string | null;
  status: "unconfigured" | "ready" | "unavailable";
  message: string;
  policy: { rewardShareBps: 7500; retainedShareBps: 2500; strategy: "atomic-arbitrage" };
  vault: {
    address: `0x${string}`;
    operator: `0x${string}`;
    settlement: `0x${string}`;
    router: `0x${string}`;
    managedAssets: string;
    totalShares: string;
    totalRewardsReserved: string;
    totalRealizedProfit: string;
    totalClaimed: string;
    maxTradeAssets: string;
    paused: boolean;
  } | null;
  wallet: DeskWalletPosition | null;
  events: DeskEvent[];
  eventsFromBlock: string | null;
  eventsError: string | null;
}

export interface DeskPoolBoard extends SnapshotStatus {
  symbol: string;
  tokenAddress: `0x${string}`;
  fetchedAt: string;
  blockNumber: string;
  blockTimestamp: string;
  reference: { bid: number; ask: number; generatedAt: string; halted: boolean } | null;
  pools: {
    address: `0x${string}`;
    fee: number;
    liquidity: string;
    active: boolean;
    priceUSDG: number | null;
    /** Spot mark vs issuer midpoint; not an executable net return. */
    spreadBps: number | null;
  }[];
  failedReads: number;
}

export type DeskHistoryPoint = {
  observedAt: string;
  blockNumber: string;
  poolAddress: `0x${string}`;
  priceUSDG: number | null;
  spreadBps: number | null;
  active: boolean;
  referenceGeneratedAt: string | null;
};

export interface DeskHistory {
  symbol: string;
  fetchedAt: string;
  status: "ready" | "empty" | "unavailable";
  message: string;
  points: DeskHistoryPoint[];
}
