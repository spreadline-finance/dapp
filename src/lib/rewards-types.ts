import type { Address, Hex } from "viem";

/** Public statements from the private payout service, not independently verified chain balances. */
export type RewardsReport = {
  version: 1;
  model: "wallet-keeper";
  chainId: 4663;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  rewardAsset: { address: Address; symbol: "ETH" | "USDG"; decimals: 6 | 18 };
  feeWallet: Address;
  holderBps: 7500;
  developerBps: 2500;
  intervalSeconds: 900;
  status: "ready" | "paused" | "attention";
  statusReason: "none" | "paused" | "insufficient-funds" | "gas-unavailable" | "rpc-unavailable" | "payment-pending" | "operator-attention";
  updatedAt: string;
  nextRunAt: string | null;
  balanceAsOfBlock: string;
  totals: {
    collected: string;
    allocatedToHolders: string;
    paidToHolders: string;
    reservedForHolders: string;
    retainedByDeveloper: string;
    unallocated: string;
  };
  exclusions: { address: Address; reason: string }[];
  epochs: RewardReportEpoch[];
  nextCursor: string | null;
  wallet: RewardReportWallet | null;
};
export type RewardReportEpoch = {
  id: string;
  snapshotBlock: string;
  snapshotHash: Hex;
  eligibleSupply: string;
  cumulativeCollectedBefore: string;
  holderBudget: string;
  collected: string;
  createdAt: string;
  paid: string;
  remaining: string;
  status: "scheduled" | "paying" | "completed" | "attention";
};
export type RewardReportWallet = {
  address: Address;
  tokenBalance: string;
  eligibleWeight: string;
  totalEligibleWeight: string;
  snapshotEpochId: string | null;
  earned: string;
  paid: string;
  pending: string;
  receipts: { epochId: string; amount: string; transactionHash: Hex; blockNumber: string; confirmedAt: string | null; status: "confirmed" }[];
};
export type RewardsSnapshot = {
  status: "reported" | "stale" | "unconfigured" | "unavailable";
  message: string;
  chainId: 4663;
  fetchedAt: string;
  report: RewardsReport | null;
};
