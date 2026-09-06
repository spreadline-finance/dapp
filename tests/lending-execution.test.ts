import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, zeroAddress, type Hex, type Address } from "viem";
import { MORPHO, BUNDLER, LENDING_ADAPTER, VAULT_V2_FACTORY, WAD, RAY, lendingTokenAbi, vaultAbi, vaultFactoryAbi, morphoAbi, lendingAdapterAbi, bundlerAbi, accrueBlue, blueAssets, blueShares, lendingBounds, lendingCall, lendingPlanMatches, marketIdentity, parseLendingAmount, validLendingId, type LendingPosition, type LendingIntent, type LendingPlan, type ExpectedLending } from "../src/lib/lending-execution";
import { recordLendingTransaction, sendPreparedLending } from "../src/lib/lending-transactions";
import { walletSubmissions } from "../src/lib/wallet-submission";
import { readReceipt } from "../src/lib/transactions";
import { createLendingExecutionService } from "../server/lending-execution-service";
import { createLendingService } from "../server/lending-service";
import { discoverLendingPositions } from "../server/lending-positions-service";
import worker from "../server/worker";
import { USDG } from "../src/lib/market-types";

const account = "0x1111111111111111111111111111111111111111" as const, vault = "0x2222222222222222222222222222222222222222" as const;
const fixedTime = Date.parse("2026-09-06T10:00:00Z");
function fixture(operation: "deposit" | "withdraw" = "deposit", all = false) {
  const intent: LendingIntent = { kind: "vault", id: vault, operation, amount: all ? "0" : "100", all, slippageBps: 50 };
  const position: LendingPosition = { kind: "vault", id: vault, account, chainId: 4663, asset: { address: USDG, symbol: "USDG", decimals: 6 }, shareDecimals: 18, sharesRaw: "200000000000000000000", assetsRaw: "200000000", walletBalanceRaw: "500000000", nativeBalanceRaw: "1000000000000000000", assetAllowanceRaw: "500000000", shareAllowanceRaw: "200000000000000000000", authorized: false, liquidityRaw: null, blockNumber: "12", blockTimestamp: new Date(fixedTime).toISOString(), fetchedAt: new Date(fixedTime).toISOString() };
  const bounds = lendingBounds(operation, all, all ? 200000000n : 100000000n, all ? 200000000000000000000n : 100000000000000000000n, BigInt(position.sharesRaw), 50);
  const plan: LendingPlan = { intent, position, bounds, status: "ready", reason: "Test", expiresAt: new Date(fixedTime + 30000).toISOString(), gasEstimateETH: "0.001", transaction: { from: account, to: BUNDLER, data: lendingCall(intent, position, bounds), value: "0x0", gas: "0x493e0" } };
  const expected: ExpectedLending = { ...intent, account, asset: USDG, assetDecimals: 6 };
  return { plan, expected };
}
test("lending amount parsing and IDs reject rounding, invalid kinds and empty targets", () => {
  assert.equal(parseLendingAmount("0.000001", 6), 1n);
  for (const v of ["0", "-1", "1e2", "0.0000001", "10000001", "NaN"]) assert.throws(() => parseLendingAmount(v, 6));
  assert.equal(validLendingId("vault", vault), true); assert.equal(validLendingId("market", vault), false);
  assert.equal(validLendingId("bad" as "vault", vault), false); assert.equal(validLendingId("vault", zeroAddress), false);
});
test("Blue valuation matches core integer accrual with fees, virtual shares and asymmetric rounding", () => {
  const state = { totalSupplyAssets: 1000000000n, totalSupplyShares: 1000000000000000n, totalBorrowAssets: 500000000n, totalBorrowShares: 500000000000000n, lastUpdate: 100n, fee: WAD / 10n };
  const next = accrueBlue(state, 1000000000000n, 1100n);
  assert.equal(next.totalSupplyAssets, 1000500250n); assert.equal(next.feeShares, 50002487630n);
  assert.equal(next.totalSupplyShares, 1000050002487630n); assert.equal(next.totalBorrowAssets, 500500250n);
  assert.equal(blueAssets(100000000000000n, next), 100045022n);
  assert.equal(blueAssets(100000000000000n + next.feeShares, next), 100095047n);
  assert.equal(blueShares(100000000n, next), 99954997761177n);
  assert.equal(blueShares(100000000n, next, true), 99954997761178n);
  assert.equal(accrueBlue(state, 0n, 1100n).totalSupplyAssets, state.totalSupplyAssets);
  assert.throws(() => accrueBlue(state, 1n, 99n));
});
test("share-price guards express the exact effective receive and burn bounds across decimal scales", () => {
  for (const [a, s] of [[100000000n, 100000000000000000000n], [100000000n, 99954997761177n], [13n, 9n]]) {
    const deposit = lendingBounds("deposit", false, a, s, s * 2n, 50), dp = BigInt(deposit.priceLimitRaw), min = BigInt(deposit.minimumSharesRaw);
    assert.ok((a * RAY + min - 1n) / min <= dp);
    if (min > 1n) assert.ok((a * RAY + min - 2n) / (min - 1n) > dp);
    const withdraw = lendingBounds("withdraw", false, a, s, s * 2n, 50), wp = BigInt(withdraw.priceLimitRaw), max = BigInt(withdraw.maximumSharesRaw);
    assert.ok(a * RAY / max >= wp); assert.ok(a * RAY / (max + 1n) < wp);
    const redeem = lendingBounds("withdraw", true, a, s, s, 50), received = BigInt(redeem.minimumAssetsRaw), rp = BigInt(redeem.priceLimitRaw);
    assert.ok(received * RAY / s >= rp); assert.ok((received - 1n) * RAY / s < rp);
  }
  assert.throws(() => lendingBounds("withdraw", false, 100n, 100n, 0n, 50));
});
test("vault bundles use exact transfers, receivers, share approvals and guarded exit methods", () => {
  for (const [op, all, method] of [["deposit", false, "erc4626Deposit"], ["withdraw", false, "erc4626Withdraw"], ["withdraw", true, "erc4626Redeem"]] as const) {
    const { plan, expected } = fixture(op, all);
    assert.equal(lendingPlanMatches(plan, expected, fixedTime), true);
    const outer = decodeFunctionData({ abi: bundlerAbi, data: plan.transaction!.data });
    const calls = outer.args[0]; assert.equal(calls.length, op === "deposit" ? 2 : 1);
    assert.ok(calls.every((c) => c.to.toLowerCase() === LENDING_ADAPTER.toLowerCase() && !c.skipRevert && c.value === 0n));
    const action = decodeFunctionData({ abi: lendingAdapterAbi, data: calls[calls.length - 1].data });
    assert.equal(action.functionName, method);
    if (op === "deposit") { const transfer = decodeFunctionData({ abi: lendingAdapterAbi, data: calls[0].data }); assert.equal(transfer.functionName, "erc20TransferFrom"); assert.deepEqual(transfer.args, [USDG, LENDING_ADAPTER, 100000000n]); }
  }
});
test("wallet lending validation rejects tampered identity, funding, permissions, guards and expired data", () => {
  const { plan, expected } = fixture();
  for (const mutate of [
    (p: LendingPlan) => { p.position.walletBalanceRaw = "0"; }, (p: LendingPlan) => { p.position.assetAllowanceRaw = "0"; },
    (p: LendingPlan) => { p.position.nativeBalanceRaw = "0"; }, (p: LendingPlan) => { p.transaction!.to = account; },
    (p: LendingPlan) => { p.position.asset.decimals = 18; }, (p: LendingPlan) => { p.transaction!.value = "0x1" as "0x0"; },
    (p: LendingPlan) => { p.bounds.minimumSharesRaw = "1"; }, (p: LendingPlan) => { p.position.chainId = 1 as 4663; },
    (p: LendingPlan) => { p.transaction!.data = "0x"; }, (p: LendingPlan) => { p.gasEstimateETH = "0"; },
  ]) { const copy = structuredClone(plan); mutate(copy); assert.equal(lendingPlanMatches(copy, expected, fixedTime), false); }
  assert.equal(lendingPlanMatches(plan, expected, fixedTime + 30000), false);
  const exit = fixture("withdraw"); exit.plan.position.shareAllowanceRaw = "0"; assert.equal(lendingPlanMatches(exit.plan, exit.expected, fixedTime), false);
  exit.plan.position.shareAllowanceRaw = "200000000000000000000"; exit.plan.position.liquidityRaw = "1"; assert.equal(lendingPlanMatches(exit.plan, exit.expected, fixedTime), false);
});
test("Blue withdrawal explicitly requires persistent authorization and hashes full market parameters", () => {
  const { plan, expected } = fixture("withdraw");
  const params = { loanToken: USDG as Address, collateralToken: vault, oracle: vault, irm: vault, lltv: "860000000000000000" };
  const id = marketIdentity(params); plan.intent.kind = plan.position.kind = expected.kind = "market"; plan.intent.id = plan.position.id = expected.id = id; plan.position.params = params;
  plan.transaction!.data = lendingCall(plan.intent, plan.position, plan.bounds);
  assert.equal(lendingPlanMatches(plan, expected, fixedTime), false);
  plan.status = "authorization_required"; plan.transaction!.to = MORPHO; plan.transaction!.data = encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [LENDING_ADAPTER, true] });
  assert.equal(lendingPlanMatches(plan, expected, fixedTime), true);
  plan.position.authorized = true; assert.equal(lendingPlanMatches(plan, expected, fixedTime), false);
});
test("lending send checks account and chain, shares the swap lock, and submits only one explicit step", async () => {
  const { plan, expected } = fixture(); let requests = 0, holds = 0;
  const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => { if (method === "eth_chainId") return "0x1237"; if (method === "eth_accounts") return [account]; requests++; assert.equal(method, "eth_sendTransaction"); assert.deepEqual(params, [{ ...plan.transaction, chainId: "0x1237" }]); return `0x${"3".repeat(64)}`; } };
  await sendPreparedLending(provider, plan, expected, () => { holds++; }, () => fixedTime);
  assert.equal(requests, 1); assert.equal(holds, 1);
  walletSubmissions.add(provider); await assert.rejects(sendPreparedLending(provider, plan, expected, () => {}, () => fixedTime), /already awaiting/); walletSubmissions.delete(provider);
  await assert.rejects(sendPreparedLending({ request: async () => "0x1" }, plan, expected, () => {}, () => fixedTime), /account or network/);
  let time = fixedTime;
  await assert.rejects(sendPreparedLending({ request: async ({ method }) => { time += 20000; return method === "eth_chainId" ? "0x1237" : [account]; } }, plan, expected, () => {}, () => time), /expired/);
});
test("a submitted lending record survives unresolved navigation and receipts verify the destination", async (t) => {
  const stored = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const record = { id: "attempt-1", account, to: BUNDLER, target: vault, targetKind: "vault" as const, label: "Test", symbol: "USDG", amount: "100", kind: "deposit" as const, status: "awaiting_wallet" as const, submittedAt: new Date().toISOString() };
  recordLendingTransaction(record); recordLendingTransaction({ ...record, status: "unresolved" });
  const hash = `0x${"3".repeat(64)}` as Hex; recordLendingTransaction({ ...record, hash, status: "submitted" });
  assert.equal(JSON.parse(stored.get("spreadline.lending.transactions.v1")!)[0].hash, hash);
  const provider = { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : { transactionHash: hash, from: account, to: account, status: "0x1", blockNumber: "0xc" } };
  await assert.rejects(readReceipt(provider, { ...record, hash }), /did not match/);
});

type RpcRequest = { id: number; method: string; params: unknown[] };
function mockRpc(t: Parameters<Parameters<typeof test>[1]>[0], options: { allowance?: bigint; shareAllowance?: bigint; wallet?: bigint; shares?: bigint; stale?: boolean; chain?: string; reset?: boolean; simulationFails?: boolean } = {}) {
  const calls: { to: string; data: Hex }[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), batch = Array.isArray(body) ? body : [body];
    const results = batch.map((r: RpcRequest) => {
      let result: unknown;
      if (r.method === "eth_chainId") result = options.chain ?? "0x1237";
      else if (r.method === "eth_getBlockByNumber") result = { number: "0xc", timestamp: `0x${(Math.floor(Date.now() / 1000) - (options.stale ? 60 : 0)).toString(16)}`, hash: `0x${"1".repeat(64)}`, transactions: [], gasLimit: "0x1000000", gasUsed: "0x0" };
      else if (r.method === "eth_getBalance") result = "0xde0b6b3a7640000";
      else if (r.method === "eth_gasPrice") result = "0x3b9aca00";
      else if (r.method === "eth_estimateGas") result = "0x30d40";
      else if (r.method === "eth_call") {
        const tx = r.params[0] as { to: string; data: Hex }; calls.push(tx);
        if (tx.to.toLowerCase() === BUNDLER.toLowerCase()) {
          if (options.simulationFails) return { id: r.id, jsonrpc: "2.0", error: { code: 3, message: "execution reverted", data: "0x" } };
          result = "0x";
        } else {
          const abi = tx.to.toLowerCase() === LENDING_ADAPTER.toLowerCase() ? lendingAdapterAbi : tx.to.toLowerCase() === VAULT_V2_FACTORY.toLowerCase() ? vaultFactoryAbi : [...lendingTokenAbi, ...vaultAbi];
          const decoded = decodeFunctionData({ abi, data: tx.data });
          const fn = decoded.functionName;
          let value: unknown;
          if (fn === "BUNDLER3") value = BUNDLER; else if (fn === "MORPHO") value = MORPHO; else if (fn === "isVaultV2") value = true;
          else if (fn === "asset") value = USDG; else if (fn === "decimals") value = tx.to.toLowerCase() === USDG.toLowerCase() ? 6 : 18; else if (fn === "symbol") value = "USDG";
          else if (fn === "balanceOf") value = tx.to.toLowerCase() === USDG.toLowerCase() ? options.wallet ?? 500000000n : options.shares ?? 200000000000000000000n;
          else if (fn === "allowance") value = tx.to.toLowerCase() === USDG.toLowerCase() ? options.allowance ?? 500000000n : options.shareAllowance ?? 200000000000000000000n;
          else if (fn === "previewRedeem") value = BigInt(decoded.args![0] as bigint) / 1000000000000n;
          else if (fn === "previewDeposit" || fn === "previewWithdraw") value = BigInt(decoded.args![0] as bigint) * 1000000000000n;
          else if (fn === "approve") { if (options.reset && decoded.args![1] !== 0n) return { id: r.id, jsonrpc: "2.0", error: { code: 3, message: "execution reverted", data: "0x" } }; value = true; }
          else throw new Error(`Unexpected RPC function ${fn}`);
          result = encodeFunctionResult({ abi, functionName: fn, result: value as never });
        }
      } else throw new Error(`Unexpected RPC method ${r.method}`);
      return { id: r.id, jsonrpc: "2.0", result };
    });
    return Response.json(Array.isArray(body) ? results : results[0]);
  }); return calls;
}
const metadata = (restricted = false) => ({ markets: async () => { throw new Error("Indexer unavailable"); }, vaults: async () => ({ vaults: [{ address: vault, warnings: restricted ? [{ type: "deposit_disabled", level: "RED" }] : [], gated: false }] }) }) as unknown as ReturnType<typeof createLendingService>;
test("native preparation produces approvals first, then a fresh simulated deposit after allowance", async (t) => {
  const { plan: { intent }, expected } = fixture();
  const calls = mockRpc(t, { allowance: 0n });
  const first = await createLendingExecutionService("https://rpc.test", metadata()).plan(intent, account);
  assert.equal(first.status, "approval_required"); assert.equal(first.approvalAmountRaw, "100000000"); assert.equal(first.transaction?.to.toLowerCase(), USDG.toLowerCase());
  assert.equal(calls.some((c) => c.to.toLowerCase() === BUNDLER.toLowerCase()), false);
  t.mock.restoreAll(); const later = mockRpc(t);
  const second = await createLendingExecutionService("https://rpc.test", metadata()).plan(intent, account);
  assert.equal(second.status, "ready"); assert.equal(lendingPlanMatches(second, expected), true);
  assert.ok(later.some((c) => c.to.toLowerCase() === BUNDLER.toLowerCase()));
});
test("nonzero allowance reset is explicit and never bypasses fresh simulation", async (t) => {
  mockRpc(t, { allowance: 1n, reset: true });
  const first = await createLendingExecutionService("https://rpc.test", metadata()).plan(fixture().plan.intent, account);
  assert.equal(first.status, "approval_reset_required"); assert.equal(first.approvalAmountRaw, "0");
  assert.equal(lendingPlanMatches(first, fixture().expected), true);
});
test("vault exits remain functional during indexer failure and ignore V2 maxWithdraw zero semantics", async (t) => {
  const calls = mockRpc(t);
  const exit = fixture("withdraw", true);
  const result = await createLendingExecutionService("https://rpc.test", metadata(true)).plan(exit.plan.intent, account);
  assert.equal(result.status, "ready"); assert.equal(lendingPlanMatches(result, exit.expected), true);
  assert.ok(calls.some((c) => c.to.toLowerCase() === BUNDLER.toLowerCase()));
});
test("preparation rejects restricted deposits, stale blocks, funding shortages and reverted exact exits", async (t) => {
  let calls = mockRpc(t);
  await assert.rejects(createLendingExecutionService("https://rpc.test", metadata(true)).plan(fixture().plan.intent, account), /restricted/);
  assert.equal(calls.length, 0);
  for (const [options, message, operation] of [[{ stale: true }, /fresh enough/, "deposit"], [{ wallet: 0n }, /not have enough/, "deposit"], [{ shares: 0n }, /exceeds/, "withdraw"], [{ chain: "0x1" }, /did not match/, "deposit"], [{ simulationFails: true }, /revert/i, "withdraw"]] as const) {
    t.mock.restoreAll(); calls = mockRpc(t, options);
    await assert.rejects(createLendingExecutionService("https://rpc.test", metadata()).plan(fixture(operation).plan.intent, account), message);
  }
});
test("lending private API rejects invalid inputs before caches or providers", async () => {
  for (const query of ["kind=other&id=" + vault, "kind=market&id=" + vault, "kind=vault&id=" + vault + "&operation=borrow&amount=1", "kind=vault&id=" + vault + "&operation=deposit&amount=1&all=true", "kind=vault&id=" + vault + "&operation=deposit&amount=1&slippageBps=999"]) {
    const response = await worker.fetch(new Request(`https://spreadline.test/api/lending/plan?address=${account}&${query}`), {} as Env, {} as ExecutionContext);
    assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("wallet discovery validates account identity and keeps API failures distinct from empty positions", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).includes("graphql") ? Response.json({ data: { marketPositions: { items: [], pageInfo: { countTotal: 0 } } } }) : Response.json({ params: { user_address: vault }, data: [], cursor: null }));
  const result = await discoverLendingPositions(account, (r) => r.json());
  assert.equal(result.positions.length, 0); assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /Vault/);
});

test("private lending plans ignore public snapshots and return fresh preparation failures without cache writes", async (t) => {
  mockRpc(t, { stale: true });
  const path = `/api/lending/plan?kind=vault&id=${vault}&operation=withdraw&amount=100&all=false&slippageBps=50&address=${account}`;
  const entries = new Map<string, Response>(); const origin = "https://spreadline.test";
  for (const prefix of ["/__response-v2/", "/__last-good/", "/__cooldown/"]) entries.set(origin + prefix + encodeURIComponent(path), Response.json({ ...fixture("withdraw").plan, status: 429, retryAt: Date.now() + 60000, message: "Cached private response" }));
  let writes = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => ({ match: async (r: Request) => entries.get(r.url)?.clone(), put: async () => { writes++; } }) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "caches", previous); else Reflect.deleteProperty(globalThis, "caches"); });
  const statement = { bind: () => statement, first: async () => ({ count: 1 }), run: async () => ({}) };
  const response = await worker.fetch(new Request(origin + path), { SPREADLINE_DB: { prepare: () => statement } } as unknown as Env, { waitUntil: () => {} } as unknown as ExecutionContext);
  assert.equal(response.status, 422); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match((await response.json() as { error: string }).error, /fresh enough/); assert.equal(writes, 0);
});

test("token artwork is bound to canonical chain and contract, not a supplied ticker", async () => {
  const { tokenLogo, TOKEN_LOGOS } = await import("../src/lib/token-logos");
  const { existsSync } = await import("node:fs");
  for (const [address, path] of Object.entries(TOKEN_LOGOS)) {
    assert.match(address, /^0x[\da-f]{40}$/); assert.equal(existsSync(`public${path}`), true);
    assert.equal(tokenLogo(address.toUpperCase().replace("0X", "0x"))?.src, path);
    assert.equal(tokenLogo(address, [], 1), undefined);
  }
  assert.equal(tokenLogo("0x3333333333333333333333333333333333333333"), undefined);
  assert.equal(tokenLogo("USDG"), undefined);
  const stock = { address: vault, symbol: "NVDA" };
  assert.equal(tokenLogo(vault, [stock])?.src, "/logos/stocks/NVDA.png");
  assert.equal(tokenLogo(account, [stock]), undefined);
});
