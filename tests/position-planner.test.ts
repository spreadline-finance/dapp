import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, formatUnits, parseAbi, zeroAddress, type Hex } from "viem";
import { assessPositionPlan, fullPlannerInputVerified, parsePlannerAmount, plannerSizes, type PositionPlan } from "../src/lib/position-planner";
import { createMarketService } from "../server/market-service";
import worker from "../server/worker";
import { USDG, V3_QUOTER } from "../src/lib/market-types";

const stock = "0x1111111111111111111111111111111111111111" as const;
const pool = "0x2222222222222222222222222222222222222222" as const;
const pool2 = "0x3333333333333333333333333333333333333333" as const;
const blockHash = `0x${"1".repeat(64)}`;
const fixedTime = Date.parse("2026-09-06T12:00:00Z");
const registry = { assets: [{ tokenSymbol: "NVDA", tokenName: "NVIDIA", currentMultiplier: "1", status: "ASSET_STATUS_ACTIVE", tokenDecimals: 18, deployments: [{ chainId: 4663, contractAddress: stock }] }] };

function fixture(side: "buy" | "sell" = "sell"): PositionPlan {
  return { symbol: "NVDA", stock, side, amount: "400", amountRaw: "400", inputDecimals: 0, outputDecimals: 0,
    blockNumber: "12", blockHash, blockTimestamp: new Date(fixedTime).toISOString(), fetchedAt: new Date(fixedTime).toISOString(), expiresAt: new Date(fixedTime + 20000).toISOString(), discoveredPools: 1, activePools: 1, feeTiers: [100, 500, 3000, 10000],
    rows: [100, 200, 400].map((input, i) => ({ percentage: [25, 50, 100][i], amountIn: String(input), amountInRaw: String(input), attempted: 1, failed: 0, status: "quoted", excludedRoutes: [], routes: [{ pool, fee: 500, amountOut: String([100, 199, 396][i]), amountOutRaw: String([100, 199, 396][i]) }] })) };
}

test("planner preserves full 18-decimal holdings and floors only percentage base units", () => {
  const sizes = plannerSizes("1.000000000000000003", 18);
  assert.deepEqual(sizes.map((size) => size.amountInRaw), ["250000000000000000", "500000000000000001", "1000000000000000003"]);
  assert.equal(sizes[2].amountIn, "1.000000000000000003");
  assert.deepEqual(plannerSizes("0.000001", 6).map((size) => size.amountInRaw), ["0", "0", "1"]);
  assert.equal(parsePlannerAmount("100000", 18), 100000n * 10n ** 18n);
  for (const input of ["0", "-1", "1e3", " 1", "1.", "100000.1", "1.0000001", "Infinity"]) assert.throws(() => parsePlannerAmount(input, 6), undefined, input);
});

test("planner uses exact threshold comparisons with the appropriate buy/sell direction", () => {
  assert.equal(assessPositionPlan(fixture(), 50, fixedTime).largest?.percentage, 50);
  assert.equal(assessPositionPlan(fixture("buy"), 50, fixedTime).largest?.percentage, 25);
  const sell = fixture();
  sell.rows[1].amountInRaw = "200000000"; sell.rows[1].routes[0].amountOutRaw = "198999999";
  // Display rounding must not turn 0.5000005% into an eligible 0.50%.
  assert.equal(assessPositionPlan(sell, 50, fixedTime).rows[1].withinLimit, false);
  sell.rows[1].routes[0].amountOutRaw = "202000000";
  assert.ok(assessPositionPlan(sell, 0, fixedTime).rows[1].differenceBps! < 0);
  assert.equal(assessPositionPlan(sell, 0, fixedTime).largest?.percentage, 50);
});

test("expired, partial, missing-baseline and invalid-limit comparisons never highlight a largest size", () => {
  assert.equal(assessPositionPlan(fixture(), 50, fixedTime + 20000).largest, null);
  assert.equal(assessPositionPlan(fixture(), -1, fixedTime).largest, null);
  const partial = fixture(); partial.rows[2].failed = 1;
  assert.equal(assessPositionPlan(partial, 50, fixedTime).largest, null);
  const missing = fixture(); missing.rows[0].routes = []; missing.rows[0].status = "quotes_unavailable";
  assert.ok(assessPositionPlan(missing, 50, fixedTime).rows.every((entry) => entry.differenceBps === null));
  const zero = fixture(); zero.rows[0].routes[0].amountOutRaw = "0";
  assert.equal(assessPositionPlan(zero, 50, fixedTime).largest, null);
});

test("planner excludes default price-limit quotes conservatively in both swap directions", () => {
  const min = 4295128740n, max = 1461446703485210103287273052203988822378723970341n;
  assert.equal(fullPlannerInputVerified(stock, USDG, [min]), false);
  assert.equal(fullPlannerInputVerified(stock, USDG, [min + 1n]), true);
  assert.equal(fullPlannerInputVerified(USDG, stock, [max]), false);
  assert.equal(fullPlannerInputVerified(USDG, stock, [max - 1n]), true);
  assert.throws(() => fullPlannerInputVerified(stock, USDG, []));
  assert.throws(() => fullPlannerInputVerified(stock, USDG, [min - 1n]));
});

const abi = parseAbi([
  "function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)",
  "function getPool(address,address,uint24) view returns(address)",
  "function token0() view returns(address)", "function token1() view returns(address)", "function liquidity() view returns(uint128)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
type Rpc = { id: number; method: string; params: unknown[] };
function mockPlannerRpc(t: TestContext, options: { failed?: boolean; boundary?: boolean; noPools?: boolean; reorg?: boolean; expire?: boolean; rateLimit?: boolean; decimals?: number } = {}) {
  const calls: Rpc[] = [];
  const inputs: bigint[] = [];
  let time = fixedTime;
  t.mock.method(Date, "now", () => time);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("/rhj/assets")) return Response.json(registry);
    const body = JSON.parse(String(init?.body));
    const batch: Rpc[] = Array.isArray(body) ? body : [body];
    calls.push(...batch);
    if (options.rateLimit && batch.some((rpc) => rpc.method === "eth_call" && (rpc.params[0] as { to: string }).to.toLowerCase() === V3_QUOTER.toLowerCase()))
      return Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "120" } });
    const answers = batch.map((rpc) => {
      let result: unknown;
      if (rpc.method === "eth_chainId") result = "0x1237";
      else if (rpc.method === "eth_getBlockByNumber") {
        const final = rpc.params[0] !== "latest";
        if (final && options.expire) time = fixedTime + 20000;
        result = { number: "0xc", timestamp: `0x${(fixedTime / 1000).toString(16)}`, hash: final && options.reorg ? `0x${"2".repeat(64)}` : blockHash, transactions: [], gasLimit: "0x1000000", gasUsed: "0x0" };
      } else if (rpc.method === "eth_getCode") result = "0x6000";
      else if (rpc.method === "eth_call") {
        const tx = rpc.params[0] as { to: string; data: Hex };
        const decoded = decodeFunctionData({ abi, data: tx.data });
        let value: unknown;
        switch (decoded.functionName) {
          case "decimals": value = tx.to.toLowerCase() === USDG.toLowerCase() ? 6 : options.decimals ?? 18; break;
          case "balanceOf": value = 1000000000000000003n; break;
          case "getPool": value = options.noPools ? zeroAddress : decoded.args[2] === 500 ? pool : decoded.args[2] === 3000 ? pool2 : zeroAddress; break;
          case "liquidity": value = 1000000000000000000n; break;
          case "slot0": value = [2n ** 96n, 0, 0, 1, 1, 0, true]; break;
          case "token0": value = stock; break;
          case "token1": value = USDG; break;
          case "quoteExactInput": {
            const input = decoded.args[1]; inputs.push(input);
            const fee = Number.parseInt(decoded.args[0].slice(42, 48), 16);
            if (options.failed && fee === 3000) return { id: rpc.id, jsonrpc: "2.0", error: { code: 3, message: "execution reverted", data: "0x" } };
            const after = options.boundary && fee === 3000 ? 4295128740n : 2n ** 96n;
            value = [input, [after], [0], 100000n]; break;
          }
        }
        result = encodeFunctionResult({ abi, functionName: decoded.functionName, result: value as never });
      } else throw new Error(`Unexpected RPC method: ${rpc.method}`);
      return { id: rpc.id, jsonrpc: "2.0", result };
    });
    return Response.json(Array.isArray(body) ? answers : answers[0]);
  });
  return { calls, inputs };
}
function service(decimals = 18) {
  return createMarketService("https://rpc.planner.test", async () => ({ value: { assets: [{ ...registry.assets[0], tokenDecimals: decimals }] }, fetchedAt: new Date(fixedTime).toISOString() }));
}

test("planner discovers once and pins every quote and metadata read to the same verified block", async (t) => {
  const { calls, inputs } = mockPlannerRpc(t);
  const plan = await service().positionPlan("NVDA", "sell", "1.000000000000000003");
  assert.equal(calls.filter((call) => call.method === "eth_getBlockByNumber" && call.params[0] === "latest").length, 1);
  assert.equal(calls.filter((call) => call.method === "eth_call" && (call.params[0] as { data: string }).data.startsWith("0x1698ee82")).length, 4);
  assert.ok(calls.filter((call) => call.method === "eth_call" || call.method === "eth_getCode").every((call) => call.params[1] === "0xc"));
  assert.deepEqual(inputs.sort((a, b) => a < b ? -1 : 1), [250000000000000000n, 250000000000000000n, 500000000000000001n, 500000000000000001n, 1000000000000000003n, 1000000000000000003n]);
  assert.equal(plan.blockHash, blockHash);
  assert.equal(plan.expiresAt, new Date(fixedTime + 20000).toISOString());
  assert.equal("transaction" in plan, false);
  assert.ok(calls.every((call) => !call.method.includes("send") && !call.method.includes("sign")));
});

test("price-limit exclusions preserve comparison of other pools, while failures withhold the verdict", async (t) => {
  mockPlannerRpc(t, { boundary: true });
  const boundary = await service().positionPlan("NVDA", "sell", "10");
  assert.equal(boundary.rows[0].routes.length, 1); assert.equal(boundary.rows[0].excludedRoutes.length, 1);
  assert.equal(boundary.rows[0].failed, 0);
  assert.equal(assessPositionPlan(boundary, 50, fixedTime).largest?.percentage, 100);
  t.mock.restoreAll(); mockPlannerRpc(t, { failed: true });
  const partial = await service().positionPlan("NVDA", "sell", "10");
  assert.equal(partial.rows[0].failed, 1);
  assert.equal(assessPositionPlan(partial, 50, fixedTime).largest, null);
});

test("planner distinguishes dust, absent pools, reorg and expiration without fabricating outputs", async (t) => {
  mockPlannerRpc(t);
  const dust = await service().positionPlan("NVDA", "sell", "0.000000000000000001");
  assert.deepEqual(dust.rows.map((row) => row.status), ["too_small", "too_small", "quoted"]);
  assert.equal(dust.rows[2].routes[0].amountOutRaw, "1");
  t.mock.restoreAll(); mockPlannerRpc(t, { noPools: true });
  const absent = await service().positionPlan("NVDA", "buy", "1000");
  assert.ok(absent.rows.every((row) => row.status === "no_pools" && row.routes.length === 0));
  for (const [options, message] of [[{ reorg: true }, /block changed/], [{ expire: true }, /expired/]] as const) {
    t.mock.restoreAll(); mockPlannerRpc(t, options);
    await assert.rejects(service().positionPlan("NVDA", "buy", "1000"), message);
  }
});

test("planner propagates provider rate limits and preserves full wallet precision", async (t) => {
  mockPlannerRpc(t, { rateLimit: true }); t.mock.method(console, "error", () => {});
  await assert.rejects(service().positionPlan("NVDA", "sell", "10"), /429|rate limited|HTTP request failed/);
  t.mock.restoreAll(); const { calls } = mockPlannerRpc(t);
  const position = await service().plannerPosition("NVDA", pool);
  assert.equal(position.balance, formatUnits(1000000000000000003n, 18));
  assert.ok(calls.filter((call) => call.method === "eth_call").every((call) => call.params[1] === "0xc"));
  t.mock.restoreAll(); mockPlannerRpc(t, { decimals: 6 });
  await assert.rejects(service(6).positionPlan("NVDA", "sell", "1.0000001"), (error: Error) => error.name === "TradePreparationError");
});

test("planner API rejects invalid precision, oversized amounts, duplicate parameters and signing fields before reads", async () => {
  for (const query of ["symbol=NVDA&side=buy&amount=1.0000001", "symbol=NVDA&side=sell&amount=100001", "symbol=NVDA&side=both&amount=1", "symbol=NVDA&side=buy&amount=1&amount=2", "symbol=NVDA&side=sell&amount=1&to=0x123", "symbol=NVDA&side=sell&amount=1e3"]) {
    const response = await worker.fetch(new Request(`https://planner.test/api/position-plan?${query}`), {} as Env, {} as ExecutionContext);
    assert.equal(response.status, 400, query);
  }
  const response = await worker.fetch(new Request("https://planner.test/api/planner-position?symbol=NVDA&address=invalid"), {} as Env, {} as ExecutionContext);
  assert.equal(response.status, 400);
});

test("planner endpoints bypass public snapshots, remain no-store, and enforce the four-batch admission budget", async (t) => {
  mockPlannerRpc(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const cacheReads: string[] = [], cacheWrites: string[] = [];
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    open: async () => ({
      match: async (request: Request) => { cacheReads.push(request.url); return entries.get(request.url)?.clone(); },
      put: async (request: Request, response: Response) => { cacheWrites.push(request.url); entries.set(request.url, response.clone()); },
    }),
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "caches", original); else Reflect.deleteProperty(globalThis, "caches"); });
  const budgets = new Map<string, number>();
  const db = { prepare: () => ({ bind: (key: string) => ({ first: async () => { const count = (budgets.get(key) ?? 0) + 1; budgets.set(key, count); return { count }; }, run: async () => ({ success: true }) }) }) };
  const env = { ROBINHOOD_RPC_URL: "https://rpc.planner.test", SPREADLINE_DB: db } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  for (let i = 0; i < 5; i++) {
    const result = await worker.fetch(new Request("https://planner.test/api/position-plan?symbol=NVDA&side=sell&amount=10"), env, ctx);
    assert.equal(result.status, i < 4 ? 200 : 429);
    assert.equal(result.headers.get("cache-control"), "no-store");
    if (i === 4) assert.equal(result.headers.get("retry-after"), "60");
  }
  const position = await worker.fetch(new Request(`https://planner.test/api/planner-position?symbol=NVDA&address=${pool}`), env, ctx);
  assert.equal(position.status, 200); assert.equal(position.headers.get("cache-control"), "no-store");
  assert.ok(cacheReads.every((key) => !key.includes("__response") && !key.includes("__last-good") && !key.includes("/__cooldown/")));
  assert.ok(cacheWrites.every((key) => key.includes("__source-cache")));
  await Promise.all(pending);
});
