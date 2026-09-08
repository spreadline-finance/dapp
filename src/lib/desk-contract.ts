import { encodeFunctionData, parseAbi, type Address } from "viem";

/** SpreadlineVault, compiled from contracts/src/SpreadlineVault.sol. No deployment is assumed. */
export const deskVaultAbi = parseAbi([
  "constructor(address settlement_,address router_,address owner_,address operator_,uint256 maxTradeAssets_)",
  "function settlement() view returns (address)",
  "function router() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function operator() view returns (address)",
  "function VIRTUAL_SHARES() view returns (uint256)",
  "function REWARD_BPS() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function managedAssets() view returns (uint256)",
  "function totalRewardsReserved() view returns (uint256)",
  "function totalRealizedProfit() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function totalWithdrawn() view returns (uint256)",
  "function rewardIndex() view returns (uint256)",
  "function sharesOf(address account) view returns (uint256)",
  "function earned(address account) view returns (uint256)",
  "function allowedTokens(address token) view returns (bool)",
  "function maxTradeAssets() view returns (uint256)",
  "function minimumProfitAssets() view returns (uint256)",
  "function maxDeadlineSeconds() view returns (uint256)",
  "function paused() view returns (bool)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets,address receiver,uint256 minShares) returns (uint256 shares)",
  "function withdraw(uint256 shares,address receiver,uint256 minAssets) returns (uint256 assets)",
  "function claim(address receiver) returns (uint256 assets)",
  "function executeArbitrage(address stock,uint24 buyFee,uint24 sellFee,uint256 assetsIn,uint256 minStockOut,uint256 minProfit,uint256 deadline) returns (uint256 profit)",
  "function setOperator(address nextOperator)",
  "function setAllowedToken(address token,bool allowed)",
  "function setRiskLimits(uint256 maxAssets,uint256 minProfitAssets,uint256 deadlineSeconds)",
  "function setPaused(bool nextPaused)",
  "function transferOwnership(address nextOwner)",
  "function acceptOwnership()",
  "event Deposited(address indexed caller,address indexed receiver,uint256 assets,uint256 shares)",
  "event Withdrawn(address indexed caller,address indexed receiver,uint256 assets,uint256 shares)",
  "event RewardsClaimed(address indexed account,address indexed receiver,uint256 assets)",
  "event ArbitrageExecuted(address indexed operator,address indexed stock,uint24 buyFee,uint24 sellFee,uint256 assetsIn,uint256 profit,uint256 rewards,uint256 retained)",
  "event OperatorUpdated(address indexed operator)",
  "event TokenPermissionUpdated(address indexed token,bool allowed)",
  "event RiskLimitsUpdated(uint256 maxTradeAssets,uint256 minimumProfitAssets,uint256 maxDeadlineSeconds)",
  "event PauseUpdated(bool paused)",
  "event OwnershipProposed(address indexed pendingOwner)",
  "event OwnershipTransferred(address indexed owner)",
  "error Unauthorized()",
  "error InvalidConfiguration()",
  "error InvalidAmount()",
  "error InvalidReceiver()",
  "error Slippage()",
  "error Reentrancy()",
  "error UnsupportedToken()",
  "error ExecutionPaused()",
  "error InvalidRoute()",
  "error Expired()",
  "error InsufficientProfit()",
  "error TokenTransferFailed()",
]);

export function deskDepositCall(assets: bigint, receiver: Address, minShares: bigint) {
  if (assets <= BigInt(0) || minShares <= BigInt(0)) throw new Error("A positive deposit and minimum share amount are required.");
  return encodeFunctionData({ abi: deskVaultAbi, functionName: "deposit", args: [assets, receiver, minShares] });
}

export function deskWithdrawCall(shares: bigint, receiver: Address, minAssets: bigint) {
  if (shares <= BigInt(0) || minAssets <= BigInt(0)) throw new Error("A positive share and minimum asset amount are required.");
  return encodeFunctionData({ abi: deskVaultAbi, functionName: "withdraw", args: [shares, receiver, minAssets] });
}

export function deskClaimCall(receiver: Address) {
  return encodeFunctionData({ abi: deskVaultAbi, functionName: "claim", args: [receiver] });
}
