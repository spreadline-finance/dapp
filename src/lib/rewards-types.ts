import type { Address, Hex } from "viem";
import type { SnapshotStatus } from "./market-types";

export type RewardPolicy = {
  holderBps: number; devBps: number; treasuryBps: number;
  intervalSeconds: number; rootDelaySeconds: number; minimumIncome: string;
  devWallet: Address; treasuryWallet: Address;
};
export type RewardEpoch = {
  id: string; root: Hex; manifestHash: Hex; snapshotBlockHash: Hex; snapshotBlock: string;
  totalEligibleWeight: string; grossIncome: string; holderBudget: string; holderPaid: string;
  devBudget: string; treasuryBudget: string; devWallet: Address; treasuryWallet: Address;
  policyVersion: string; proposedAt: number; readyAt: number; activatedAt: number;
  state: "proposed" | "active" | "cancelled";
};
export type RewardClaim = {
  epochId: string; account: Address; weight: string; proof: Hex[]; amount: string; claimed: boolean;
};
export type RewardReceipt = {
  id: string; kind: "collected" | "proposed" | "activated" | "cancelled" | "holder-paid" | "dev-paid" | "treasury-paid" | "policy";
  transactionHash: Hex; blockNumber: string; account: Address | null; amount: string | null; epochId: string | null;
};
export interface RewardsSnapshot extends SnapshotStatus {
  status: "unconfigured" | "ready" | "unavailable"; message: string;
  chainId: number; fetchedAt: string; blockNumber: string | null; blockTimestamp: string | null;
  distributor: null | {
    address: Address; owner: Address; pendingOwner: Address; operator: Address; guardian: Address; paused: boolean;
    holderToken: Address; holderTokenSymbol: string; holderTokenDecimals: number;
    rewardAsset: Address; rewardSymbol: string; rewardDecimals: number; ponsEscrow: Address;
    totalPonsCollected: string; availableIncome: string; totalReserved: string;
    totalHolderAllocated: string; totalHolderPaid: string; totalDevAllocated: string; totalDevPaid: string; totalTreasuryAllocated: string; totalTreasuryPaid: string;
    nextEpochId: string; lastProposedAt: number; policyVersion: string; policy: RewardPolicy;
    escrowCredit: string | null;
  };
  wallet: null | { address: Address; holderBalance: string; pendingDev: string; pendingTreasury: string; claims: RewardClaim[]; proofsStatus: "ready" | "unavailable" | "empty"; proofsMessage: string };
  epochs: RewardEpoch[]; nextEpochCursor: string | null; events: RewardReceipt[]; eventsError: string | null;
  manifestsAvailable: boolean;
}
export type PonsLaunchState = {
  status: "ready" | "unavailable"; message: string; fetchedAt: string; blockNumber: string | null;
  chainId: number; factory: Address; escrow: Address; hook: Address;
  launchEnabled: boolean | null; canLaunch: boolean | null; maxCreatorTaxBps: number | null; launchFeeWei: string | null;
  officialLaunchUrl: string; docsUrl: string;
  quoteAssets: { address: Address; symbol: string; decimals: number; approved: boolean | null; phantomQuoteRaw: string | null; graduationThresholdRaw: string | null }[];
  blockTimestamp: string | null; blockHash: Hex | null; runtimeVerified: boolean;
  launcher: Address | null;
  configs: { id: string; supplyRaw: string; curveFeeBps: number; phantomQuoteRaw: string; graduationThresholdRaw: string; poolFee: number; tickSpacing: number; enabled: boolean }[];
  feePolicy: { protocolFeeRecipient: Address; protocolFeeShareBps: number; buybackBurnBps: number; hookFeeBps: number; maxInternalPriceImpactBps: number } | null;
  launchQuotes: { configId: string; pairToken: Address; expectedEconomics: Hex }[];
};
export type RewardsRequest =
  | { kind: "collect" }
  | { kind: "sweep-curve" }
  | { kind: "sweep-pool" }
  | { kind: "claim"; claim: RewardClaim }
  | { kind: "claim-to"; claim: RewardClaim; receiver: Address }
  | { kind: "withdraw-cash"; receiver?: Address }
  | { kind: "policy"; policy: RewardPolicy }
  | { kind: "operator"; address: Address }
  | { kind: "guardian"; address: Address }
  | { kind: "pause"; paused: boolean }
  | { kind: "cancel"; epochId: string }
  | { kind: "activate"; epochId: string }
  | { kind: "bind-token"; address: Address }
  | { kind: "propose-owner"; address: Address }
  | { kind: "accept-owner" };

export type LaunchDraft = {
  name: string; symbol: string; description: string; imageURI: string;
  website: string; twitter: string; telegram: string;
  owner: string; operator: string; guardian?: string; developerWallet: string; treasuryWallet: string;
  creatorTaxBps: number; rewardAsset: string; developerBuy: string;
  buybackEnabled: boolean; launchConfigId: string;
  holderBps: number; devBps: number; treasuryBps: number;
  intervalSeconds: number; rootDelaySeconds: number; minimumIncome: string;
};
