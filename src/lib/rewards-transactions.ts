import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { feeDistributorAbi } from "./fee-distributor-contract";
import { CHAIN_ID } from "./market-types";
import type { RewardPolicy, RewardsRequest, RewardsSnapshot } from "./rewards-types";
import { walletSubmissions, type WalletProvider } from "./wallet-submission";

export type RewardsPlan = {
  account: Address; distributor: Address; request: RewardsRequest; expiresAt: number;
  transaction: { from: Address; to: Address; data: Hex; value: "0x0"; gas: Hex; chainId: "0x1237" };
};
const maxAccounting = (BigInt(1) << BigInt(128)) - BigInt(1);
const integer = (value: string) => /^\d{1,78}$/.test(value) && BigInt(value) <= maxAccounting;
function recipient(value: string, distributor?: Address) {
  if (!isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress || value.toLowerCase() === distributor?.toLowerCase()) throw new Error("Enter a valid wallet or contract address distinct from the distributor.");
}
export function validateRewardPolicy(policy: RewardPolicy, distributor?: Address) {
  const shares = [policy.holderBps, policy.devBps, policy.treasuryBps];
  if (shares.some((value) => !Number.isInteger(value) || value < 0 || value > 10000) || policy.holderBps === 0 || shares.reduce((sum, value) => sum + value, 0) !== 10000) throw new Error("The holder, developer and treasury shares must total 100%, with a positive holder share.");
  if (!Number.isInteger(policy.intervalSeconds) || policy.intervalSeconds < 60 || policy.intervalSeconds > 2592000) throw new Error("The distribution interval must be between 1 minute and 30 days.");
  if (!Number.isInteger(policy.rootDelaySeconds) || policy.rootDelaySeconds < 900 || policy.rootDelaySeconds > 604800) throw new Error("The review delay must be between 15 minutes and 7 days.");
  if (!integer(policy.minimumIncome) || BigInt(policy.minimumIncome) === BigInt(0)) throw new Error("The minimum distribution amount must be positive and within the contract limit.");
  recipient(policy.devWallet, distributor); recipient(policy.treasuryWallet, distributor);
}
/** Encodes only named distributor operations. No arbitrary target, calldata or value is accepted. */
export function encodeRewardRequest(request: RewardsRequest, account: Address, distributor: Address): Hex {
  if (request.kind === "collect") return encodeFunctionData({ abi: feeDistributorAbi, functionName: "collectPonsFees" });
  if (request.kind === "sweep-curve" || request.kind === "sweep-pool") return encodeFunctionData({ abi: feeDistributorAbi, functionName: request.kind === "sweep-curve" ? "sweepCurveFees" : "sweepPoolFees" });
  if (request.kind === "withdraw-cash") {
    const receiver = request.receiver ?? account; recipient(receiver, distributor);
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: "withdrawCash", args: [receiver] });
  }
  if (request.kind === "claim" || request.kind === "claim-to") {
    const claim = request.claim;
    if (claim.account.toLowerCase() !== account.toLowerCase() || !integer(claim.epochId) || BigInt(claim.epochId) === BigInt(0) || !integer(claim.weight) || BigInt(claim.weight) === BigInt(0) || claim.proof.length > 64 || claim.proof.some((item) => !/^0x[\da-f]{64}$/i.test(item))) throw new Error("This claim proof is invalid or belongs to another wallet.");
    if (request.kind === "claim-to") {
      recipient(request.receiver, distributor);
      return encodeFunctionData({ abi: feeDistributorAbi, functionName: "claimTo", args: [BigInt(claim.epochId), BigInt(claim.weight), claim.proof, request.receiver] });
    }
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: "claim", args: [BigInt(claim.epochId), account, BigInt(claim.weight), claim.proof] });
  }
  if (request.kind === "policy") {
    validateRewardPolicy(request.policy, distributor);
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: "setPolicy", args: [{ ...request.policy, intervalSeconds: BigInt(request.policy.intervalSeconds), rootDelaySeconds: BigInt(request.policy.rootDelaySeconds), minimumIncome: BigInt(request.policy.minimumIncome) }] });
  }
  if (request.kind === "pause") {
    if (typeof request.paused !== "boolean") throw new Error("Choose a valid pause state.");
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: "setPaused", args: [request.paused] });
  }
  if (request.kind === "cancel" || request.kind === "activate") {
    if (!integer(request.epochId) || BigInt(request.epochId) === BigInt(0)) throw new Error("Select a valid distribution.");
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: request.kind === "cancel" ? "cancelEpoch" : "activateEpoch", args: [BigInt(request.epochId)] });
  }
  if (request.kind === "accept-owner") return encodeFunctionData({ abi: feeDistributorAbi, functionName: "acceptOwnership" });
  if (request.kind === "operator" || request.kind === "guardian" || request.kind === "bind-token" || request.kind === "propose-owner") {
    recipient(request.address, distributor);
    return encodeFunctionData({ abi: feeDistributorAbi, functionName: request.kind === "operator" ? "setOperator" : request.kind === "guardian" ? "setGuardian" : request.kind === "bind-token" ? "bindHolderToken" : "transferOwnership", args: [request.address] });
  }
  throw new Error("This reward action is not supported.");
}
async function checkWallet(provider: WalletProvider, account: Address) {
  const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
  if (typeof chain !== "string" || !/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(CHAIN_ID) || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error("Your wallet account or network changed. Connect to Robinhood Chain and prepare again.");
}
function checkPermission(snapshot: RewardsSnapshot, account: Address, request: RewardsRequest) {
  const distributor = snapshot.distributor!;
  const owner = distributor.owner.toLowerCase() === account.toLowerCase();
  const guardian = distributor.guardian.toLowerCase() === account.toLowerCase();
  if ((request.kind === "sweep-curve" || request.kind === "sweep-pool") && !owner && distributor.operator.toLowerCase() !== account.toLowerCase()) throw new Error("Only the owner or distribution operator can sweep Pons fees.");
  if (["policy", "operator", "guardian", "bind-token", "propose-owner"].includes(request.kind) && !owner) throw new Error("Only the distributor owner can make this change.");
  if (request.kind === "pause" && !owner && !(guardian && request.paused)) throw new Error("Only the owner can resume distributions; the owner or guardian may pause them.");
  if (request.kind === "accept-owner" && distributor.pendingOwner.toLowerCase() !== account.toLowerCase()) throw new Error("This wallet is not the pending distributor owner.");
  if (request.kind === "cancel" && !owner && !guardian) throw new Error("Only the owner or guardian can cancel a proposed distribution.");
  if (request.kind === "bind-token" && distributor.holderToken.toLowerCase() !== zeroAddress) throw new Error("The holder token has already been bound and cannot be replaced.");
  if (request.kind === "activate" || request.kind === "cancel") {
    const epoch = snapshot.epochs.find((item) => item.id === request.epochId);
    if (!epoch || epoch.state !== "proposed") throw new Error("This distribution is no longer awaiting activation.");
    if (request.kind === "activate" && (distributor.paused || Math.floor(Date.parse(snapshot.blockTimestamp ?? "") / 1000) < epoch.readyAt)) throw new Error("This distribution is paused or its public review period has not finished.");
  }
  if (request.kind === "claim" || request.kind === "claim-to") {
    const claim = snapshot.wallet?.claims.find((item) => item.epochId === request.claim.epochId && item.account.toLowerCase() === account.toLowerCase());
    if (!claim || claim.claimed || !integer(claim.amount) || BigInt(claim.amount) === BigInt(0) || JSON.stringify(claim.proof) !== JSON.stringify(request.claim.proof) || claim.weight !== request.claim.weight || claim.amount !== request.claim.amount) throw new Error("Refresh your rewards to obtain a current claim proof.");
  }
  if (request.kind === "withdraw-cash" && (!snapshot.wallet || BigInt(snapshot.wallet.pendingDev) + BigInt(snapshot.wallet.pendingTreasury) <= BigInt(0))) throw new Error("This wallet has no developer or treasury allocation available to withdraw.");
}
export async function prepareRewardAction(provider: WalletProvider, snapshot: RewardsSnapshot, account: Address, request: RewardsRequest, clock = Date.now): Promise<RewardsPlan> {
  const time = Date.parse(snapshot.fetchedAt), blockTime = Date.parse(snapshot.blockTimestamp ?? "");
  if (snapshot.status !== "ready" || snapshot.chainId !== CHAIN_ID || !snapshot.distributor || snapshot.dataStatus || !Number.isFinite(time) || clock() - time > 30000 || time > clock() + 5000 || !Number.isFinite(blockTime) || clock() - blockTime > 120000 || blockTime > clock() + 5000 || snapshot.wallet?.address.toLowerCase() !== account.toLowerCase()) throw new Error("A fresh, verified reward snapshot for this wallet is required. Refresh the page.");
  recipient(account); recipient(snapshot.distributor.address);
  checkPermission(snapshot, account, request);
  const data = encodeRewardRequest(request, account, snapshot.distributor.address);
  await checkWallet(provider, account);
  const transaction = { from: account, to: snapshot.distributor.address, data, value: "0x0" as const, chainId: "0x1237" as const };
  const code = await provider.request({ method: "eth_getCode", params: [transaction.to, "latest"] });
  if (typeof code !== "string" || !/^0x[\da-f]+$/i.test(code) || /^0x0*$/i.test(code)) throw new Error("No distributor contract was found at the configured address.");
  await provider.request({ method: "eth_call", params: [transaction, "latest"] });
  const estimate = await provider.request({ method: "eth_estimateGas", params: [transaction] });
  if (typeof estimate !== "string" || !/^0x[\da-f]+$/i.test(estimate) || BigInt(estimate) <= BigInt(0) || BigInt(estimate) > BigInt(2000000)) throw new Error("The wallet returned an invalid gas estimate.");
  await checkWallet(provider, account);
  if (clock() - time > 30000) throw new Error("The reward snapshot expired while preparing. Refresh and try again.");
  return { account, distributor: transaction.to, request: structuredClone(request), expiresAt: clock() + 30000, transaction: { ...transaction, gas: `0x${(BigInt(estimate) * BigInt(120) / BigInt(100)).toString(16)}` } };
}
export function rewardPlanMatches(plan: RewardsPlan, account: Address, distributor: Address) {
  try {
    recipient(account); recipient(distributor);
    return plan.account.toLowerCase() === account.toLowerCase() && plan.distributor.toLowerCase() === distributor.toLowerCase() && plan.transaction.from.toLowerCase() === account.toLowerCase() && plan.transaction.to.toLowerCase() === distributor.toLowerCase() && plan.transaction.value === "0x0" && plan.transaction.chainId === "0x1237" && /^0x[\da-f]+$/i.test(plan.transaction.gas) && BigInt(plan.transaction.gas) > BigInt(0) && BigInt(plan.transaction.gas) <= BigInt(2400000) && plan.transaction.data.toLowerCase() === encodeRewardRequest(plan.request, account, distributor).toLowerCase();
  } catch { return false; }
}
export async function sendRewardPlan(provider: WalletProvider, plan: RewardsPlan, account: Address, distributor: Address, clock = Date.now): Promise<Hex> {
  if (walletSubmissions.has(provider)) throw new Error("Complete the wallet request already in progress first.");
  walletSubmissions.add(provider);
  try {
    if (!rewardPlanMatches(plan, account, distributor) || !Number.isFinite(plan.expiresAt) || plan.expiresAt <= clock()) throw new Error("This reward preview changed or expired. Prepare it again.");
    await checkWallet(provider, account);
    await provider.request({ method: "eth_call", params: [plan.transaction, "latest"] });
    await checkWallet(provider, account);
    if (plan.expiresAt <= clock()) throw new Error("This reward preview expired. Prepare it again.");
    const hash = await provider.request({ method: "eth_sendTransaction", params: [plan.transaction] });
    if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("No transaction hash was returned. Check your wallet before trying again.");
    return hash as Hex;
  } finally { walletSubmissions.delete(provider); }
}
