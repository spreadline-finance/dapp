import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, type Address } from "viem";
import { deskVaultAbi } from "../src/lib/desk-contract";
import { parseDeskAssets, sharesFromPercent, prepareDeskAction, sendDeskPlan } from "../src/lib/desk-transactions";
import { deskPriceIsFresh, deskProfitFloor } from "../src/lib/desk-economics";
import { CHAIN_ID, SWAP_ROUTER, USDG } from "../src/lib/market-types";
import type { DeskSnapshot } from "../src/lib/desk-types";
import type { WalletProvider } from "../src/lib/wallet-submission";
import { walletSubmissions } from "../src/lib/wallet-submission";

const account = `0x${"1".repeat(40)}` as Address;
const vaultAddress = `0x${"2".repeat(40)}` as Address;
const hash = `0x${"a".repeat(64)}`;
const now = 1800000000000;
function snapshot(): DeskSnapshot {
  return { chainId: CHAIN_ID, fetchedAt: new Date(now).toISOString(), blockNumber: "100", blockTimestamp: new Date(now).toISOString(), status: "ready", message: "Ready",
    policy: { rewardShareBps: 7500, retainedShareBps: 2500, strategy: "atomic-arbitrage" },
    vault: { address: vaultAddress, operator: account, settlement: USDG, router: SWAP_ROUTER, managedAssets: "1000000000", totalShares: "1000000000000000", totalRewardsReserved: "750000", totalRealizedProfit: "1000000", totalClaimed: "0", maxTradeAssets: "100000000", paused: true },
    wallet: { address: account, shares: "1000000000000", redeemableAssets: "1000000", claimableAssets: "750000", assetBalance: "10000000", allowance: "10000000" },
    events: [], eventsFromBlock: "100", eventsError: null };
}
function provider(overrides: Partial<Record<string, (params: unknown[]) => unknown | Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const value: WalletProvider = { request: async ({ method, params = [] }) => {
    calls.push(method);
    if (overrides[method]) return overrides[method]!(params);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_accounts") return [account];
    if (method === "eth_call") return (params[0] as {data: string}).data.startsWith("0x095ea7b3") ? encodeAbiParameters([{type:"bool"}], [true]) : encodeAbiParameters([{ type: "uint256" }], [1000000000000n]);
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_sendTransaction") return hash;
    throw new Error(`Unexpected ${method}`);
  } };
  return { value, calls };
}

test("desk monetary inputs preserve smallest units and reject truncation/exponential forms", () => {
  assert.equal(parseDeskAssets("0.000001"), 1n);
  assert.equal(parseDeskAssets("123456789.123456"), 123456789123456n);
  for (const amount of ["0", "-1", "1e3", "0.0000001", "01", "1.", "Infinity", " 1"]) assert.throws(() => parseDeskAssets(amount));
  assert.equal(sharesFromPercent("1000000000000", "33.33"), 333300000000n);
  assert.equal(sharesFromPercent("123", "100"), 123n);
  for (const percent of ["0", "100.01", "-1", ".01", "1.001"]) assert.throws(() => sharesFromPercent("1000", percent));
});

test("desk deposit approval remains a separate permission action, including zero-reset", async () => {
  for (const [allowance, expected] of [["0", "approval"], ["1", "reset-approval"]]) {
    const state = snapshot(); state.wallet!.allowance = allowance;
    const rpc = provider();
    const plan = await prepareDeskAction(rpc.value, state, account, "deposit", "2", () => now);
    assert.equal(plan.kind, expected); assert.equal(plan.transaction.to, USDG); assert.equal(plan.assets, "2000000");
    assert.ok(!rpc.calls.includes("eth_sendTransaction"));
  }
});

test("desk funded deposit simulation binds receiver and minimum shares without sending", async () => {
  const rpc = provider();
  const plan = await prepareDeskAction(rpc.value, snapshot(), account, "deposit", "2", () => now);
  const decoded = decodeFunctionData({ abi: deskVaultAbi, data: plan.transaction.data });
  assert.equal(decoded.functionName, "deposit");
  assert.deepEqual(decoded.args, [2000000n, account, 999000000000n]);
  assert.equal(plan.transaction.to, vaultAddress); assert.equal(plan.kind, "deposit");
  assert.equal(plan.transaction.gas, "0x1d4c0");
  assert.ok(!rpc.calls.includes("eth_sendTransaction"));
});

test("desk withdraw uses a share percentage and contract preview rather than a floating point NAV", async () => {
  const rpc = provider({ eth_call: () => encodeAbiParameters([{ type: "uint256" }], [3000000n]) });
  const plan = await prepareDeskAction(rpc.value, snapshot(), account, "withdraw", "50", () => now);
  const decoded = decodeFunctionData({ abi: deskVaultAbi, data: plan.transaction.data });
  assert.deepEqual(decoded.args, [500000000000n, account, 2997000n]);
  assert.equal(plan.assets, "3000000");
});

test("desk rejects stale, cached, mismatched and unfunded snapshots before signing", async () => {
  const variants = [snapshot(), snapshot(), snapshot(), snapshot(), snapshot(), snapshot()];
  variants[0].fetchedAt = new Date(now - 30001).toISOString();
  variants[1].dataStatus = { state: "cached", reason: "stale", retryAt: new Date(now).toISOString() };
  variants[2].vault!.settlement = vaultAddress;
  variants[3].wallet!.address = vaultAddress;
  variants[4].status = "unconfigured";
  variants[5].chainId = 1;
  for (const state of variants) {
    const rpc = provider();
    await assert.rejects(prepareDeskAction(rpc.value, state, account, "deposit", "2", () => now), /verified vault snapshot/);
    assert.deepEqual(rpc.calls, []);
  }
  await assert.rejects(prepareDeskAction(provider().value, snapshot(), account, "deposit", "11", () => now), /balance/);
});

test("desk blocks wallet network changes and simulation failures without broadcasting", async () => {
  const wrong = provider({ eth_chainId: () => "0x1" });
  await assert.rejects(prepareDeskAction(wrong.value, snapshot(), account, "claim", "", () => now), /network changed/);
  assert.ok(!wrong.calls.includes("eth_sendTransaction"));
  const failed = provider({ eth_call: () => { throw new Error("execution reverted"); } });
  await assert.rejects(prepareDeskAction(failed.value, snapshot(), account, "claim", "", () => now), /reverted/);
  assert.ok(!failed.calls.includes("eth_sendTransaction"));
});

test("desk sending rechecks account after simulation and cannot duplicate a pending wallet request", async () => {
  const plan = await prepareDeskAction(provider().value, snapshot(), account, "claim", "", () => now);
  let changed = false;
  const rpc = provider({ eth_accounts: () => [changed ? vaultAddress : account], eth_call: () => { changed = true; return "0x"; } });
  await assert.rejects(sendDeskPlan(rpc.value, plan, account, vaultAddress, () => now), /account or network changed/);
  assert.ok(!rpc.calls.includes("eth_sendTransaction")); assert.ok(!walletSubmissions.has(rpc.value));
  walletSubmissions.add(rpc.value);
  try { await assert.rejects(sendDeskPlan(rpc.value, plan, account, vaultAddress, () => now), /in progress/); }
  finally { walletSubmissions.delete(rpc.value); }
});

test("desk sends one explicit action and rejects preview expiry during the last simulation", async () => {
  const rpc = provider(); const plan = await prepareDeskAction(rpc.value, snapshot(), account, "claim", "", () => now);
  assert.equal(await sendDeskPlan(rpc.value, plan, account, vaultAddress, () => now), hash);
  assert.equal(rpc.calls.filter((method) => method === "eth_sendTransaction").length, 1);
  let time = now;
  const late = provider({ eth_call: () => { time += 31000; return "0x"; } });
  await assert.rejects(sendDeskPlan(late.value, plan, account, vaultAddress, () => time), /expired/);
  assert.ok(!late.calls.includes("eth_sendTransaction"));
});

test("desk operator cost floor rounds up and requires recent price evidence", () => {
  assert.equal(deskProfitFloor(100000n, 1000000000n, 3000000000n, 1000000n), 1300000n);
  assert.equal(deskProfitFloor(1n, 1n, 1n, 1n), 2n);
  assert.throws(() => deskProfitFloor(1n, 0n, 1n, 1n));
  assert.equal(deskPriceIsFresh(now - 300000, now), true);
  assert.equal(deskPriceIsFresh(now - 300001, now), false);
  assert.equal(deskPriceIsFresh(now + 5001, now), false);
  assert.equal(deskPriceIsFresh(NaN, now), false);
});

test("desk rejects false token approvals and tampered signing payloads", async () => {
  const state = snapshot(); state.wallet!.allowance = "0";
  const refused = provider({ eth_call: () => encodeAbiParameters([{ type: "bool" }], [false]) });
  await assert.rejects(prepareDeskAction(refused.value, state, account, "deposit", "2", () => now), /refused/);
  assert.ok(!refused.calls.includes("eth_sendTransaction"));
  const approval = await prepareDeskAction(provider().value, state, account, "deposit", "2", () => now);
  await assert.rejects(sendDeskPlan(refused.value, approval, account, vaultAddress, () => now), /refused/);
  const valid = await prepareDeskAction(provider().value, snapshot(), account, "deposit", "2", () => now);
  for (const mutation of [
    { ...valid, transaction: { ...valid.transaction, to: account } },
    { ...valid, transaction: { ...valid.transaction, from: vaultAddress } },
    { ...valid, transaction: { ...valid.transaction, value: "0x1" } },
    { ...valid, transaction: { ...valid.transaction, chainId: "0x1" } },
    { ...valid, minimum: "1" },
    { ...valid, assets: "9000000" },
  ]) {
    const rpc = provider();
    await assert.rejects(sendDeskPlan(rpc.value, mutation as typeof valid, account, vaultAddress, () => now), /changed or expired/);
    assert.deepEqual(rpc.calls, []);
  }
});
