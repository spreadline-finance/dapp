import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

export type FeeDistributorPolicy = {
  holderBps: number;
  devBps: number;
  treasuryBps: number;
  intervalSeconds: bigint;
  rootDelaySeconds: bigint;
  minimumIncome: bigint;
  devWallet: Address;
  treasuryWallet: Address;
};

/** Source: contracts/src/SpreadlineFeeDistributor.sol. No production deployment is assumed. */
export const feeDistributorAbi = parseAbi([
  "constructor(address holderToken_,address rewardAsset_,address ponsEscrow_,address ponsFactory_,address ponsHook_,address owner_,address operator_,(uint16 holderBps,uint16 devBps,uint16 treasuryBps,uint64 intervalSeconds,uint64 rootDelaySeconds,uint256 minimumIncome,address devWallet,address treasuryWallet) policy_)",
  "function BPS() view returns (uint256)",
  "function MAX_BATCH() view returns (uint256)",
  "function MAX_PROOF() view returns (uint256)",
  "function MAX_ACCOUNTING() view returns (uint256)",
  "function MIN_ROOT_DELAY() view returns (uint64)",
  "function MAX_ROOT_DELAY() view returns (uint64)",
  "function MIN_INTERVAL() view returns (uint64)",
  "function MAX_INTERVAL() view returns (uint64)",
  "function PAYOUT_GAS() view returns (uint256)",
  "function BATCH_CLAIM_GAS() view returns (uint256)",
  "function holderToken() view returns (address)",
  "function rewardAsset() view returns (address)",
  "function ponsEscrow() view returns (address)",
  "function ponsFactory() view returns (address)",
  "function ponsHook() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function paused() view returns (bool)",
  "function policy() view returns (uint16 holderBps,uint16 devBps,uint16 treasuryBps,uint64 intervalSeconds,uint64 rootDelaySeconds,uint256 minimumIncome,address devWallet,address treasuryWallet)",
  "function policyVersion() view returns (uint64)",
  "function lastProposedAt() view returns (uint64)",
  "function nextEpochId() view returns (uint256)",
  "function totalReserved() view returns (uint256)",
  "function totalHolderAllocated() view returns (uint256)",
  "function totalHolderPaid() view returns (uint256)",
  "function totalDevAllocated() view returns (uint256)",
  "function totalDevPaid() view returns (uint256)",
  "function totalTreasuryAllocated() view returns (uint256)",
  "function totalTreasuryPaid() view returns (uint256)",
  "function totalPonsCollected() view returns (uint256)",
  "function totalSuccessfulClaims() view returns (uint256)",
  "function pendingDev(address account) view returns (uint256)",
  "function pendingTreasury(address account) view returns (uint256)",
  "function hasClaimed(uint256 epochId,address account) view returns (bool)",
  "function rewardBalance() view returns (uint256)",
  "function availableIncome() view returns (uint256)",
  "function epochs(uint256 epochId) view returns ((bytes32 root,bytes32 manifestHash,bytes32 snapshotBlockHash,uint256 snapshotBlock,uint256 totalEligibleWeight,uint256 grossIncome,uint256 holderBudget,uint256 holderPaid,uint256 devBudget,uint256 treasuryBudget,address devWallet,address treasuryWallet,uint64 policyVersion,uint64 proposedAt,uint64 readyAt,uint64 activatedAt,uint8 state))",
  "function fund(uint256 amount)",
  "function collectPonsFees() returns (uint256 amount)",
  "function sweepCurveFees()",
  "function sweepPoolFees()",
  "function bindHolderToken(address token)",
  "function proposeEpoch(bytes32 root,uint256 snapshotBlock,bytes32 snapshotBlockHash,bytes32 manifestHash,uint256 totalEligibleWeight,uint256 grossIncome) returns (uint256 epochId)",
  "function activateEpoch(uint256 epochId)",
  "function cancelEpoch(uint256 epochId)",
  "function leafHash(uint256 epochId,address account,uint256 weight) view returns (bytes32)",
  "function claimable(uint256 epochId,address account,uint256 weight,bytes32[] proof) view returns (uint256)",
  "function claim(uint256 epochId,address account,uint256 weight,bytes32[] proof) returns (uint256)",
  "function claimTo(uint256 epochId,uint256 weight,bytes32[] proof,address receiver) returns (uint256)",
  "function distributeClaims((uint256 epochId,address account,uint256 weight,bytes32[] proof)[] claims) returns (uint256 successful,uint256 amount)",
  "function batchClaim((uint256 epochId,address account,uint256 weight,bytes32[] proof) claim) returns (uint256)",
  "function withdrawCash(address receiver) returns (uint256)",
  "function withdrawCashFor(address account) returns (uint256)",
  "function setPolicy((uint16 holderBps,uint16 devBps,uint16 treasuryBps,uint64 intervalSeconds,uint64 rootDelaySeconds,uint256 minimumIncome,address devWallet,address treasuryWallet) nextPolicy)",
  "function setOperator(address nextOperator)",
  "function setGuardian(address nextGuardian)",
  "function setPaused(bool nextPaused)",
  "function transferOwnership(address nextOwner)",
  "function acceptOwnership()",
  "event HolderTokenBound(address indexed holderToken)",
  "event FundingReceived(address indexed sender,uint256 amount)",
  "event PonsFeesCollected(address indexed caller,address indexed asset,uint256 amount)",
  "event PonsFeesSwept(address indexed token,address indexed source,bytes32 indexed poolId)",
  "event PolicyUpdated(uint64 indexed version,uint16 holderBps,uint16 devBps,uint16 treasuryBps,uint64 intervalSeconds,uint64 rootDelaySeconds,uint256 minimumIncome,address devWallet,address treasuryWallet)",
  "event EpochProposed(uint256 indexed epochId,bytes32 indexed root,uint256 snapshotBlock,bytes32 snapshotBlockHash,bytes32 manifestHash,uint256 totalEligibleWeight,uint256 grossIncome,uint256 holderBudget,uint256 devBudget,uint256 treasuryBudget,uint64 policyVersion,uint64 readyAt)",
  "event EpochActivated(uint256 indexed epochId)",
  "event EpochCancelled(uint256 indexed epochId,uint256 releasedIncome)",
  "event HolderPaid(uint256 indexed epochId,address indexed account,address indexed receiver,uint256 amount)",
  "event CashPaid(address indexed account,address indexed receiver,uint256 devAmount,uint256 treasuryAmount)",
  "event ClaimSkipped(uint256 indexed epochId,address indexed account,bytes4 reason)",
  "event BatchCompleted(uint256 attempted,uint256 successful,uint256 amount)",
  "event OperatorUpdated(address indexed operator)",
  "event GuardianUpdated(address indexed guardian)",
  "event PauseUpdated(bool paused)",
  "event OwnershipProposed(address indexed pendingOwner)",
  "event OwnershipTransferred(address indexed owner)",
  "error Unauthorized()",
  "error Reentrancy()",
  "error InvalidConfiguration()",
  "error InvalidAmount()",
  "error InvalidReceiver()",
  "error InvalidSnapshot()",
  "error DistributionPaused()",
  "error TokenNotBound()",
  "error InvalidEpoch()",
  "error RootNotReady()",
  "error IntervalNotElapsed()",
  "error InsufficientIncome()",
  "error InvalidProof()",
  "error AlreadyClaimed()",
  "error EpochBudgetExceeded()",
  "error TransferFailed()",
  "error UnsupportedRewardToken()",
  "error Insolvent()",
  "error InvalidBatch()",
  "error InsufficientBatchGas()",
  "error InvalidPonsLaunch()",
  "error InvalidPonsPhase()",
]);

export const ponsFeeEscrowAbi = parseAbi([
  "function claim()",
  "function claimToken(address token)",
]);

const leafParameters = parseAbiParameters("uint256 chainId,address distributor,uint256 epochId,address account,uint256 weight");

/** Matches Solidity exactly. Sort sibling hashes before hashing each Merkle pair. */
export function feeDistributionLeaf(chainId: bigint, distributor: Address, epochId: bigint, account: Address, weight: bigint): Hex {
  return keccak256(keccak256(encodeAbiParameters(leafParameters, [chainId, distributor, epochId, account, weight])));
}

export function feeDistributionClaimCall(epochId: bigint, account: Address, weight: bigint, proof: readonly Hex[]) {
  if (epochId <= BigInt(0) || weight <= BigInt(0) || proof.length > 64) throw new Error("A valid epoch, holder weight and bounded Merkle proof are required.");
  return encodeFunctionData({ abi: feeDistributorAbi, functionName: "claim", args: [epochId, account, weight, proof] });
}
