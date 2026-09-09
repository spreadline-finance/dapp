import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { feeDistributorAbi } from "../src/lib/fee-distributor-contract";
import { encodeRewardRequest, prepareRewardAction, rewardPlanMatches, sendRewardPlan, validateRewardPolicy } from "../src/lib/rewards-transactions";
import type { RewardsSnapshot, RewardPolicy, RewardsRequest } from "../src/lib/rewards-types";
import { walletSubmissions, type WalletProvider } from "../src/lib/wallet-submission";

const account = `0x${"1".repeat(40)}` as Address;
const distributor = `0x${"2".repeat(40)}` as Address;
const alternate = `0x${"3".repeat(40)}` as Address;
const txHash = `0x${"a".repeat(64)}` as Hex;
const now = 1800000000000;
const policy: RewardPolicy = { holderBps: 7500, devBps: 500, treasuryBps: 2000, intervalSeconds: 900, rootDelaySeconds: 900, minimumIncome: "1000", devWallet: account, treasuryWallet: alternate };
function state(): RewardsSnapshot {
  return { status: "ready", message: "Ready", chainId: 4663, fetchedAt: new Date(now).toISOString(), blockNumber: "1000", blockTimestamp: new Date(now).toISOString(), distributor: { address: distributor, owner: account, pendingOwner: zeroAddress, operator: alternate, guardian: alternate, paused: true, holderToken: alternate, holderTokenSymbol: "SPREAD", holderTokenDecimals: 18, rewardAsset: zeroAddress, rewardSymbol: "ETH", rewardDecimals: 18, ponsEscrow: alternate, totalPonsCollected: "1000", availableIncome: "1000", totalReserved: "1000", totalHolderAllocated: "750", totalHolderPaid: "0", totalDevAllocated: "50", totalDevPaid: "0", totalTreasuryAllocated: "200", totalTreasuryPaid: "0", nextEpochId: "2", lastProposedAt: 0, policyVersion: "1", policy: { ...policy }, escrowCredit: "1000" }, wallet: { address: account, holderBalance: "10", pendingDev: "50", pendingTreasury: "0", claims: [{ epochId: "1", account, weight: "10", proof: [], amount: "750", claimed: false }], proofsStatus: "ready", proofsMessage: "" }, epochs: [{ id: "1", root: txHash, manifestHash: txHash, snapshotBlockHash: txHash, snapshotBlock: "900", totalEligibleWeight: "10", grossIncome: "1000", holderBudget: "750", holderPaid: "0", devBudget: "50", treasuryBudget: "200", devWallet: account, treasuryWallet: alternate, policyVersion: "1", proposedAt: now / 1000 - 1800, readyAt: now / 1000 - 900, activatedAt: now / 1000 - 800, state: "active" }], nextEpochCursor: null, events: [], eventsError: null, manifestsAvailable: true };
}
function provider(overrides: Partial<Record<string, (params: unknown[]) => unknown | Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const value: WalletProvider = { request: async ({ method, params = [] }) => {
    calls.push(method);
    if (overrides[method]) return overrides[method]!(params);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_accounts") return [account];
    if (method === "eth_getCode") return "0x60006000";
    if (method === "eth_call") return "0x";
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_sendTransaction") return txHash;
    throw new Error(`Unexpected RPC: ${method}`);
  } };
  return { value, calls };
}
test("reward policy enforces complete distribution split and scheduling bounds", () => {
  validateRewardPolicy(policy, distributor);
  for (const change of [{ holderBps: 7499 }, { holderBps: 0, devBps: 8000 }, { devBps: 500.1 }, { intervalSeconds: 59 }, { intervalSeconds: 2592001 }, { rootDelaySeconds: 899 }, { rootDelaySeconds: 604801 }, { minimumIncome: "0" }, { minimumIncome: "1.5" }, { minimumIncome: (1n << 128n).toString() }, { devWallet: zeroAddress }, { treasuryWallet: distributor }]) assert.throws(() => validateRewardPolicy({ ...policy, ...change }, distributor));
  validateRewardPolicy({ ...policy, minimumIncome: ((1n << 128n) - 1n).toString(), intervalSeconds: 2592000, rootDelaySeconds: 604800 }, distributor);
});
test("reward preparation simulates named policy changes without requesting a signature", async () => {
  const rpc = provider();
  const plan = await prepareRewardAction(rpc.value, state(), account, { kind: "policy", policy }, () => now);
  const decoded = decodeFunctionData({ abi: feeDistributorAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, "setPolicy");
  assert.equal(plan.transaction.value, "0x0"); assert.equal(plan.transaction.to, distributor);
  assert.ok(rpc.calls.includes("eth_getCode")); assert.ok(rpc.calls.includes("eth_call"));
  assert.ok(!rpc.calls.includes("eth_sendTransaction"));
});
test("reward preparation rejects stale blocks, cached snapshots, wrong chain and wallet before RPC", async () => {
  const variants = [state(), state(), state(), state(), state(), state()];
  variants[0].fetchedAt = new Date(now - 30001).toISOString();
  variants[1].blockTimestamp = new Date(now - 120001).toISOString();
  variants[2].chainId = 1;
  variants[3].wallet!.address = alternate;
  variants[4].dataStatus = { state: "cached", reason: "cached", retryAt: new Date(now).toISOString() };
  variants[5].status = "unconfigured";
  for (const snapshot of variants) { const rpc = provider(); await assert.rejects(prepareRewardAction(rpc.value, snapshot, account, { kind: "collect" }, () => now), /fresh, verified/); assert.deepEqual(rpc.calls, []); }
});
test("reward owner controls reject a nonowner and guardians cannot unpause", async () => {
  const snapshot = state(); snapshot.distributor!.owner = alternate; snapshot.distributor!.guardian = account;
  for (const request of [{ kind: "policy", policy }, { kind: "operator", address: alternate }, { kind: "guardian", address: alternate }, { kind: "bind-token", address: alternate }, { kind: "propose-owner", address: alternate }] satisfies RewardsRequest[]) await assert.rejects(prepareRewardAction(provider().value, snapshot, account, request, () => now), /Only the distributor owner/);
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "pause", paused: false }, () => now), /Only the owner can resume/);
  await prepareRewardAction(provider().value, snapshot, account, { kind: "pause", paused: true }, () => now);
});
test("reward claim and cash withdrawal remain available while new distributions are paused", async () => {
  const snapshot = state();
  const plan = await prepareRewardAction(provider().value, snapshot, account, { kind: "claim", claim: snapshot.wallet!.claims[0] }, () => now);
  const decoded = decodeFunctionData({ abi: feeDistributorAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, "claim"); assert.deepEqual(decoded.args, [1n, account, 10n, []]);
  const cash = await prepareRewardAction(provider().value, snapshot, account, { kind: "withdraw-cash" }, () => now);
  assert.deepEqual(decodeFunctionData({ abi: feeDistributorAbi, data: cash.transaction.data }).args, [account]);
});
test("reward holder can redirect only their own allocation to a reviewed nonzero receiver", async () => {
  const snapshot = state(); const claim = snapshot.wallet!.claims[0];
  const rpc = provider();
  const plan = await prepareRewardAction(rpc.value, snapshot, account, { kind: "claim-to", claim, receiver: alternate }, () => now);
  const decoded = decodeFunctionData({ abi: feeDistributorAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, "claimTo"); assert.deepEqual(decoded.args, [1n, 10n, [], alternate]);
  assert.ok(!rpc.calls.includes("eth_sendTransaction"));
  for (const receiver of [zeroAddress, distributor]) await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "claim-to", claim, receiver }, () => now), /valid wallet or contract address/);
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "claim-to", claim: { ...claim, account: alternate }, receiver: account }, () => now), /another wallet/);
  assert.equal(rewardPlanMatches({ ...plan, request: { kind: "claim-to", claim, receiver: account } }, account, distributor), false);
});
test("developer or treasury cash can be redirected without changing the allocation owner", async () => {
  const snapshot = state();
  const plan = await prepareRewardAction(provider().value, snapshot, account, { kind: "withdraw-cash", receiver: alternate }, () => now);
  const decoded = decodeFunctionData({ abi: feeDistributorAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, "withdrawCash"); assert.deepEqual(decoded.args, [alternate]); assert.equal(plan.transaction.from, account);
  assert.equal(rewardPlanMatches({ ...plan, request: { kind: "withdraw-cash", receiver: account } }, account, distributor), false);
  for (const receiver of [zeroAddress, distributor]) await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "withdraw-cash", receiver }, () => now), /valid wallet or contract address/);
  snapshot.wallet!.pendingDev = "0";
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "withdraw-cash", receiver: alternate }, () => now), /no developer or treasury allocation/);
});
test("manual Pons fee sweeps are fixed distributor calls restricted to owner or operator", async () => {
  for (const [kind, functionName] of [["sweep-curve", "sweepCurveFees"], ["sweep-pool", "sweepPoolFees"]] as const) {
    const snapshot = state(); const rpc = provider();
    const plan = await prepareRewardAction(rpc.value, snapshot, account, { kind }, () => now);
    const decoded = decodeFunctionData({ abi: feeDistributorAbi, data: plan.transaction.data });
    assert.equal(decoded.functionName, functionName); assert.equal(plan.transaction.to, distributor); assert.equal(plan.transaction.value, "0x0"); assert.ok(!rpc.calls.includes("eth_sendTransaction"));
    snapshot.distributor!.owner = alternate;
    await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind }, () => now), /Only the owner or distribution operator/);
    snapshot.distributor!.operator = account;
    await prepareRewardAction(provider().value, snapshot, account, { kind }, () => now);
    const wrongPhase = provider({ eth_call: () => { throw new Error("invalid launch phase"); } });
    await assert.rejects(prepareRewardAction(wrongPhase.value, snapshot, account, { kind }, () => now), /launch phase/); assert.ok(!wrongPhase.calls.includes("eth_sendTransaction"));
  }
});
test("reward claims reject another recipient, changed proof, changed amount and already paid claims", async () => {
  const snapshot = state(); const claim = snapshot.wallet!.claims[0];
  for (const changed of [{ ...claim, account: alternate }, { ...claim, weight: "11" }, { ...claim, amount: "751" }, { ...claim, proof: [txHash] }]) await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "claim", claim: changed }, () => now));
  snapshot.wallet!.claims[0].claimed = true;
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "claim", claim }, () => now), /current claim proof/);
  assert.throws(() => encodeRewardRequest({ kind: "claim", claim: { ...claim, proof: Array.from({ length: 65 }, () => txHash) } }, account, distributor), /claim proof/);
});
test("reward epoch activation enforces pending state, review time and pause status", async () => {
  const snapshot = state();
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "activate", epochId: "1" }, () => now), /no longer awaiting/);
  snapshot.epochs[0].state = "proposed";
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "activate", epochId: "1" }, () => now), /paused/);
  snapshot.distributor!.paused = false; snapshot.epochs[0].readyAt = now / 1000 + 60;
  await assert.rejects(prepareRewardAction(provider().value, snapshot, account, { kind: "activate", epochId: "1" }, () => now), /review period/);
  snapshot.epochs[0].readyAt = now / 1000;
  await prepareRewardAction(provider().value, snapshot, account, { kind: "activate", epochId: "1" }, () => now);
});
test("reward preparation checks deployment and simulation before signing", async () => {
  for (const code of ["0x", "0x00", null]) await assert.rejects(prepareRewardAction(provider({ eth_getCode: () => code }).value, state(), account, { kind: "collect" }, () => now), /No distributor/);
  const rpc = provider({ eth_call: () => { throw new Error("execution reverted"); } });
  await assert.rejects(prepareRewardAction(rpc.value, state(), account, { kind: "collect" }, () => now), /reverted/);
  assert.ok(!rpc.calls.includes("eth_sendTransaction"));
});
test("reward plan rejects tampered targets, value, calldata, role and gas", async () => {
  const plan = await prepareRewardAction(provider().value, state(), account, { kind: "collect" }, () => now);
  assert.equal(rewardPlanMatches(plan, account, distributor), true);
  for (const change of [{ to: alternate }, { from: alternate }, { value: "0x1" }, { data: "0x" }, { gas: "0xffffff" }, { chainId: "0x1" }]) assert.equal(rewardPlanMatches({ ...plan, transaction: { ...plan.transaction, ...change } } as typeof plan, account, distributor), false);
  assert.equal(rewardPlanMatches({ ...plan, request: { kind: "pause", paused: false } }, account, distributor), false);
});
test("reward send rechecks account after simulation and releases the wallet submission lock", async () => {
  const plan = await prepareRewardAction(provider().value, state(), account, { kind: "collect" }, () => now);
  let changed = false;
  const rpc = provider({ eth_call: () => { changed = true; return "0x"; }, eth_accounts: () => [changed ? alternate : account] });
  await assert.rejects(sendRewardPlan(rpc.value, plan, account, distributor, () => now), /network changed/);
  assert.ok(!rpc.calls.includes("eth_sendTransaction")); assert.equal(walletSubmissions.has(rpc.value), false);
});
test("reward send rejects duplicate requests and expiry during the last simulation", async () => {
  const plan = await prepareRewardAction(provider().value, state(), account, { kind: "collect" }, () => now);
  const rpc = provider(); walletSubmissions.add(rpc.value);
  try { await assert.rejects(sendRewardPlan(rpc.value, plan, account, distributor, () => now), /already in progress/); } finally { walletSubmissions.delete(rpc.value); }
  let clock = now; const late = provider({ eth_call: () => { clock += 31000; return "0x"; } });
  await assert.rejects(sendRewardPlan(late.value, plan, account, distributor, () => clock), /expired/);
  assert.ok(!late.calls.includes("eth_sendTransaction"));
  assert.equal(await sendRewardPlan(rpc.value, plan, account, distributor, () => now), txHash);
  assert.equal(rpc.calls.filter((method) => method === "eth_sendTransaction").length, 1);
});
