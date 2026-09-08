import "./deployment.test";
import "./pwa.test";
import "./position-planner.test";
import "./demo-wallet.test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  parseCatalog,
  parsePrices,
  parseTradeSize,
  quoteIsFresh,
  validWallet,
  parseCorporateActions,
} from "../server/validation";
import { consumeBudget } from "../server/rate-limit";
import { createMarketService } from "../server/market-service";
import worker, { readBoundedJSON } from "../server/worker";
import { CHAIN_ID, PUBLIC_RPC } from "../src/lib/market-types";
import { requestTransport } from "../server/rpc";
import { createPublicClient, BaseError, HttpRequestError, decodeFunctionData, formatUnits, type Address } from "viem";
import { assessQuote, parseAssumedCost } from "../src/lib/opportunity-assessment";
import { mergeObservations, parseJournal, type ResearchObservation } from "../src/lib/research-journal";
import type { QuoteBook } from "../src/lib/market-types";
import { SWAP_ROUTER, USDG } from "../src/lib/market-types";
import { approvalAbi, approvalCall, minimumOutput, parseSwapAmount, planMatches, routerAbi, swapCall, uniswapLink, type SwapQuote, type TradePlan } from "../src/lib/trading";
import { readReceipt, sendPreparedTrade, type TransactionRecord } from "../src/lib/transactions";
import { createLendingService, parseLendingMarkets, parseLendingVaults, parseLendingHistory } from "../server/lending-service";
import { depositDisabled, lendingLink, lendingProjection } from "../src/lib/lending";

const lendingId = `0x${"7".repeat(64)}`;
const lendingAsset = { address: USDG, symbol: "USDG", decimals: 6 };
const lendingTimestamp = "2026-09-06T12:00:00.000Z";
const lendingMarketFixture = () => ({ marketId: lendingId, listed: true, morphoBlue: { chain: { id: 4663 } }, lltv: "860000000000000000", loanAsset: lendingAsset, collateralAsset: { address: `0x${"8".repeat(40)}`, symbol: "NVDA", decimals: 18 }, warnings: [], state: { timestamp: Date.parse(lendingTimestamp) / 1000, supplyApy: .04, borrowApy: .05, supplyAssetsUsd: 1000, borrowAssetsUsd: 800, liquidityAssetsUsd: 200, utilization: .8 } });
const lendingPage = (items: unknown[]) => ({ items, pageInfo: { countTotal: items.length } });
const lendingVaultFixture = () => ({ address: `0x${"6".repeat(40)}`, name: "Example USDG", listed: true, asset: lendingAsset, chain: { id: 4663 }, netApyExcludingRewards: .038, netApy: .07, totalAssetsUsd: 1000, liquidityUsd: 0, performanceFee: .1, managementFee: .005, curators: { items: [{ name: "Example curator" }] }, warnings: [{ type: "deposit_disabled", level: "RED" }], gatesConfig: { receiveSharesGate: { address: null }, receiveAssetsGate: { address: null }, sendSharesGate: { address: null }, sendAssetsGate: { address: null } } });

test("lending data validates chain and identity while preserving zero liquidity and fractional rates", () => {
  const original = lendingMarketFixture();
  const data = parseLendingMarkets(lendingPage([original, { ...original, morphoBlue: { chain: { id: 1 } } }, { ...original, marketId: "bad" }]), lendingTimestamp);
  assert.equal(data.rejected, 2);
  assert.equal(data.markets[0].lltv, .86);
  assert.equal(data.markets[0].supplyApy, .04);
  assert.equal(data.markets[0].updatedAt, lendingTimestamp);
  const illiquid = parseLendingMarkets(lendingPage([{ ...original, state: { ...original.state, liquidityAssetsUsd: 0, supplyApy: 0 } }])).markets[0];
  assert.equal(illiquid.liquidityUsd, 0); assert.equal(illiquid.supplyApy, 0);
  const unknown = parseLendingMarkets(lendingPage([{ ...original, state: null }])).markets[0];
  assert.equal(unknown.liquidityUsd, null); assert.equal(unknown.supplyApy, null);
  assert.throws(() => parseLendingMarkets(lendingPage([{ ...original, lltv: "1000000000000000001" }])));
});
test("vault yields exclude incentives and deposit-disabled metadata is separate from contract gates", () => {
  const data = parseLendingVaults({ vaultV2s: lendingPage([lendingVaultFixture()]), vaults: lendingPage([]) });
  const vault = data.vaults[0];
  assert.equal(vault.netApy, .038); assert.equal(vault.gated, false); assert.equal(depositDisabled(vault), true);
  assert.equal(vault.liquidityUsd, 0); assert.equal(vault.performanceFee, .1);
  assert.equal(depositDisabled({ ...vault, warnings: [] }), false);
  assert.equal(depositDisabled({ ...vault, warnings: [], gated: true }), true);
  assert.throws(() => parseLendingVaults({ vaultV2s: lendingPage([{ ...lendingVaultFixture(), chain: { id: 1 } }]), vaults: lendingPage([]) }));
});
test("yield history keeps real timestamps, sorts and deduplicates while rejecting a mismatched market", () => {
  const end = Date.parse(lendingTimestamp) / 1000;
  const raw = { marketId: lendingId, historicalState: { supplyApy: [{ x: end, y: .04 }, { x: end - 86400, y: .03 }, { x: end - 86400, y: .03 }, { x: end - 172800, y: null }, { x: end + 86400, y: .06 }] } };
  const result = parseLendingHistory(raw, lendingId, lendingTimestamp);
  assert.deepEqual(result.points, [{ time: (end - 86400) * 1000, apy: .03 }, { time: end * 1000, apy: .04 }]);
  assert.throws(() => parseLendingHistory(raw, `0x${"9".repeat(64)}`, lendingTimestamp));
});
test("lending illustration respects APY compounding and missing rates cannot become promised returns", () => {
  assert.ok(Math.abs(lendingProjection("1000", .05, 365)! - 50) < 1e-9);
  assert.ok(Math.abs(lendingProjection("1000", .05, 30)! - 1000 * (1.05 ** (30 / 365) - 1)) < 1e-9);
  assert.equal(lendingProjection("1000", 0, 30), 0);
  for (const input of ["0", "-1", "NaN", "1e3", "10000001"]) assert.equal(lendingProjection(input, .05, 30), null);
  assert.equal(lendingProjection("1000", null, 30), null);
  assert.equal(lendingProjection("1000", Infinity, 30), null);
  assert.equal(lendingLink("market", lendingId), `https://app.morpho.org/robinhood-chain/market/${lendingId}`);
  assert.equal(lendingLink("vault", "https://evil.test"), null);
});
test("Morpho GraphQL errors reject partial data and requests remain fixed to the public chain-scoped API", async (t) => {
  let partial = true;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.morpho.org/graphql");
    const request = JSON.parse(String(init?.body));
    assert.match(request.query, /chainId_in:\[4663\]/);
    return Response.json({ data: { markets: lendingPage([lendingMarketFixture()]) }, ...(partial ? { errors: [{ message: "Indexer lag" }] } : {}) });
  });
  const service = createLendingService(readBoundedJSON);
  await assert.rejects(service.markets(), /complete lending response/);
  partial = false;
  assert.equal((await service.markets()).markets.length, 1);
});

const testTrader = `0x${"3".repeat(40)}` as Address;
const testStock = `0x${"4".repeat(40)}` as Address;
const tradeTime = Date.parse("2026-09-06T00:00:02Z");
function swapFixture(side: "buy" | "sell" = "buy"): SwapQuote {
  const output = side === "buy" ? 10n ** 18n : 100000000n;
  const outputDecimals = side === "buy" ? 18 : 6;
  return { symbol: "NVDA", side, amountIn: side === "buy" ? "100" : "1", amountInRaw: side === "buy" ? "100000000" : "1000000000000000000", tokenIn: side === "buy" ? USDG : testStock, tokenOut: side === "buy" ? testStock : USDG, inputDecimals: side === "buy" ? 6 : 18, outputDecimals, blockNumber: "123", blockTimestamp: "2026-09-06T00:00:00Z", fetchedAt: "2026-09-06T00:00:01Z", expiresAt: "2026-09-06T00:00:20Z", slippageBps: 50, attempted: 1, failed: 0, routes: [{ fee: 500, pool: testStock, amountOut: formatUnits(output, outputDecimals), amountOutRaw: String(output), minimumOut: formatUnits(minimumOutput(output, 50), outputDecimals), minimumOutRaw: String(minimumOutput(output, 50)), priceUSDG: 100 }] };
}
function planFixture(status: "ready" | "approval_required" = "ready", side: "buy" | "sell" = "buy"): TradePlan {
  const quote = swapFixture(side), deadline = tradeTime / 1000 + 120;
  return { quote, account: testTrader, chainId: CHAIN_ID, inputBalance: "10000", nativeBalance: "1", allowance: status === "ready" ? "10000" : "0", status, expiresAt: quote.expiresAt, deadline: status === "ready" ? deadline : undefined, transaction: { from: testTrader, to: status === "ready" ? SWAP_ROUTER : quote.tokenIn, data: status === "ready" ? swapCall(quote, testTrader, deadline) : approvalCall(quote), value: "0x0", gas: "0x493e0" } };
}
const tradeExpected = { account: testTrader, stock: testStock, stockDecimals: 18, side: "buy" as const, amount: "100", slippageBps: 50 };

test("one-way inputs respect input-token decimals and minimum receive rounds down without zero", () => {
  assert.equal(parseSwapAmount("0.000001", 6), 1n);
  assert.equal(parseSwapAmount("0.1", 18), 100000000000000000n);
  for (const value of ["0", "-1", "1e2", "100001", "1.0000001"]) assert.throws(() => parseSwapAmount(value, 6));
  assert.throws(() => parseSwapAmount("0.01", 0));
  assert.equal(minimumOutput(101n, 50), 100n);
  for (const bps of [0, -1, 101, .5]) assert.throws(() => minimumOutput(100n, bps));
  assert.throws(() => minimumOutput(1n, 50));
});
test("wallet swap calldata binds the recipient, canonical pair, exact input, minimum and enforced deadline", () => {
  const plan = planFixture();
  const outer = decodeFunctionData({ abi: routerAbi, data: plan.transaction!.data });
  assert.equal(outer.functionName, "multicall");
  if (outer.functionName !== "multicall") return;
  assert.equal(outer.args[0], BigInt(plan.deadline!)); assert.equal(outer.args[1].length, 1);
  const inner = decodeFunctionData({ abi: routerAbi, data: outer.args[1][0] });
  assert.equal(inner.functionName, "exactInputSingle");
  if (inner.functionName !== "exactInputSingle") return;
  assert.equal(inner.args[0].recipient.toLowerCase(), testTrader);
  assert.equal(inner.args[0].tokenIn.toLowerCase(), USDG.toLowerCase());
  assert.equal(inner.args[0].tokenOut.toLowerCase(), testStock);
  assert.equal(inner.args[0].amountIn, 100000000n);
  assert.equal(inner.args[0].amountOutMinimum, 995000000000000000n);
  assert.equal(planMatches(plan, tradeExpected, tradeTime), true);
  assert.equal(planMatches(planFixture("ready", "sell"), { ...tradeExpected, side: "sell", amount: "1" }, tradeTime), true);
});
test("approval is exact and malformed or stale transaction plans cannot pass the wallet review", () => {
  const plan = planFixture("approval_required");
  const decoded = decodeFunctionData({ abi: approvalAbi, data: plan.transaction!.data });
  assert.equal(decoded.functionName, "approve");
  assert.equal(decoded.args[0].toLowerCase(), SWAP_ROUTER);
  assert.equal(decoded.args[1], 100000000n);
  assert.equal(planMatches(plan, tradeExpected, tradeTime), true);
  for (const tamper of [
    (p: TradePlan) => { p.quote.amountInRaw = "999000000"; p.transaction!.data = approvalCall(p.quote); },
    (p: TradePlan) => { p.quote.tokenIn = testStock; p.transaction!.to = testStock; },
    (p: TradePlan) => { p.quote.inputDecimals = 18; },
    (p: TradePlan) => { p.quote.expiresAt = "invalid"; },
    (p: TradePlan) => { p.account = testStock; },
    (p: TradePlan) => { p.quote.routes[0].minimumOut = "999"; },
    (p: TradePlan) => { p.quote.failed = 1; },
  ]) { const copy = structuredClone(plan); tamper(copy); assert.equal(planMatches(copy, tradeExpected, tradeTime), false); }
  assert.equal(planMatches(plan, tradeExpected, Date.parse(plan.expiresAt)), false);
  assert.equal(planMatches(planFixture(), { ...tradeExpected, slippageBps: 100 }, tradeTime), false);
});
test("wallet submission rechecks identity and expiry and excludes concurrent prompts", async () => {
  let sends = 0;
  const wrong = { request: async ({ method }: { method: string }) => { if (method === "eth_sendTransaction") sends++; return method === "eth_chainId" ? "0x1" : [testTrader]; } };
  await assert.rejects(sendPreparedTrade(wrong, planFixture(), tradeExpected, () => tradeTime), /chain changed/);
  assert.equal(sends, 0);
  let clockReads = 0;
  const expires = { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : [testTrader] };
  await assert.rejects(sendPreparedTrade(expires, planFixture(), tradeExpected, () => ++clockReads === 1 ? tradeTime : tradeTime + 30000), /expired/);
  let resolveSend!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { resolveSend = resolve; });
  const provider = { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : method === "eth_accounts" ? [testTrader] : pending };
  const first = sendPreparedTrade(provider, planFixture(), tradeExpected, () => tradeTime);
  await assert.rejects(sendPreparedTrade(provider, planFixture(), tradeExpected, () => tradeTime), /already awaiting/);
  resolveSend(`0x${"a".repeat(64)}`);
  assert.equal(await first, `0x${"a".repeat(64)}`);
  const extended = planFixture();
  Object.assign(extended.transaction!, { authorizationList: ["unexpected"], nonce: "0x99" });
  let sent: unknown;
  const capture = { request: async ({ method, params }: { method: string; params?: unknown[] }) => { if (method === "eth_chainId") return "0x1237"; if (method === "eth_accounts") return [testTrader]; sent = params?.[0]; return `0x${"b".repeat(64)}`; } };
  await sendPreparedTrade(capture, extended, tradeExpected, () => tradeTime);
  assert.deepEqual(Object.keys(sent as object).sort(), ["chainId", "data", "from", "gas", "to", "value"]);
});
test("receipts distinguish pending, confirmed and reverted and reject mismatched sender/hash", async () => {
  const record: TransactionRecord = { hash: `0x${"a".repeat(64)}`, account: testTrader, symbol: "NVDA", side: "buy", amount: "100", kind: "swap", status: "submitted", submittedAt: "2026-09-06T00:00:00.000Z" };
  const receipt = { transactionHash: record.hash, from: testTrader, status: "0x1", blockNumber: "0x123" };
  const provider = (value: unknown) => ({ request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x1237" : value });
  assert.equal(await readReceipt(provider(null), record), null);
  assert.equal((await readReceipt(provider(receipt), record))?.status, "confirmed");
  assert.equal((await readReceipt(provider(receipt), { ...record, status: "unresolved" }))?.status, "confirmed");
  assert.equal((await readReceipt(provider({ ...receipt, status: "0x0" }), record))?.status, "reverted");
  await assert.rejects(readReceipt(provider({ ...receipt, from: testStock }), record), /did not match/);
  await assert.rejects(readReceipt(provider({ ...receipt, transactionHash: `0x${"b".repeat(64)}` }), record), /did not match/);
});
test("Uniswap handoff uses the selected direction and documented input parameters", () => {
  const link = new URL(uniswapLink(testStock, "sell", "0.5"));
  const params = new URLSearchParams(link.hash.split("?")[1]);
  assert.equal(link.origin, "https://app.uniswap.org"); assert.equal(params.get("chain"), "robinhood");
  assert.equal(params.get("inputCurrency"), testStock); assert.equal(params.get("outputCurrency"), USDG);
  assert.equal(params.get("field"), "input"); assert.equal(params.get("value"), "0.5");
});

// Synthetic inputs exercise decision boundaries, not observed market returns.
function assessmentFixture(surplus = "2"): QuoteBook {
  return {
    symbol: "NVDA", amountIn: "1000", settlementDecimals: 6,
    blockNumber: "100", blockHash: `0x${"1".repeat(64)}`,
    blockTimestamp: "2026-09-06T00:00:00Z", fetchedAt: "2026-09-06T00:00:01Z", expiresAt: "2026-09-06T00:00:20Z",
    routes: [{ buyFee: 500, sellFee: 3000, buyPool: `0x${"1".repeat(40)}`, sellPool: `0x${"2".repeat(40)}`, amountOut: String(1000 + Number(surplus)), surplus, gasUnits: "230000", crossedTicks: [1, 1] }],
    attempted: 1, failed: 0, executionEnabled: false,
  };
}
const assessmentNow = Date.parse("2026-09-06T00:00:02Z");

test("a positive quote with unknown execution costs remains a research candidate", () => {
  const result = assessQuote(assessmentFixture(), null, assessmentNow);
  assert.equal(result.kind, "candidate");
  assert.equal(result.scenario, null);
  assert.equal(result.extraCostBudget, 2);
  assert.match(result.headline, /unproven/);
  assert.equal(result.expired, false);
});
test("cost scenarios subtract only the additional assumption and preserve break-even boundaries", () => {
  assert.equal(parseAssumedCost(""), null);
  assert.equal(parseAssumedCost("0"), 0);
  for (const input of ["-1", "Infinity", "1e3", "100001", "0.0000001"]) assert.equal(parseAssumedCost(input), null);
  assert.equal(assessQuote(assessmentFixture(), 1.5, assessmentNow).scenario, .5);
  assert.equal(assessQuote(assessmentFixture(), 3, assessmentNow).scenario, -1);
  assert.match(assessQuote(assessmentFixture(), 2, assessmentNow).headline, /use up/);
  const flat = assessQuote(assessmentFixture("0"), null, assessmentNow);
  assert.equal(flat.kind, "break_even");
  assert.match(flat.headline, /breaks even/);
  assert.equal(assessQuote(assessmentFixture("-0.000001"), null, assessmentNow).kind, "negative");
});
test("comparison selects the actual best route and never hides partial failures or expiry", () => {
  const book = assessmentFixture("-3");
  book.routes.push(assessmentFixture("2").routes[0]); book.attempted = 3; book.failed = 1;
  const result = assessQuote(book, null, Date.parse(book.expiresAt));
  assert.equal(result.difference, 2);
  assert.equal(result.kind, "incomplete");
  assert.equal(result.expired, true);
});
test("missing pools are distinct from a failed simulation and do not become zero returns", () => {
  const book = { ...assessmentFixture(), routes: [], attempted: 0, availability: "one_active_pool" as const };
  const result = assessQuote(book, 1, assessmentNow);
  assert.equal(result.difference, null); assert.equal(result.scenario, null);
  assert.equal(result.kind, "missing"); assert.match(result.headline, /second active pool/);
  assert.match(assessQuote({ ...book, availability: "simulations_failed", failed: 2, attempted: 2 }, null, assessmentNow).headline, /not enough data/);
});
function observationFixture(id: string, quote = assessmentFixture()): ResearchObservation {
  return { id, symbol: quote.symbol, amount: quote.amountIn, checkedAt: quote.fetchedAt, quote, assumedCost: null };
}
test("research storage rejects malformed, mismatched or nonnumeric observations", () => {
  const valid = observationFixture("valid");
  const failed = { ...valid, id: "failure", quote: undefined, error: "Provider cooldown" };
  assert.equal(parseJournal([valid, failed]).length, 2);
  assert.equal(parseJournal([{ ...valid, symbol: "AAPL" }, { ...valid, amount: "100" }, { ...valid, amount: "" }, { ...valid, quote: undefined }]).length, 0);
  assert.deepEqual(parseJournal(null), []);
});
test("journal merges other-tab records and deduplicates the same pinned quote at equivalent amounts", () => {
  const a = observationFixture("a");
  const duplicate = { ...a, id: "duplicate", amount: "1000.0", checkedAt: "2026-09-06T00:00:02Z" };
  const b = observationFixture("b", { ...assessmentFixture(), symbol: "AAPL" });
  const failed = { ...a, id: "failed", quote: undefined, error: "Rate limited" };
  const merged = mergeObservations([duplicate], [a], [b, failed]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, "duplicate");
  assert.ok(merged.some((r) => r.id === "b"));
  assert.ok(merged.some((r) => r.id === "failed"));
  const many = Array.from({ length: 110 }, (_, i) => ({ ...failed, id: String(i) }));
  assert.equal(mergeObservations(many).length, 100);
});

test("RPC rate limits survive malformed batch error responses as an HTTP status", async (t) => {
  t.mock.method(console, "error", () => {});
  const client = createPublicClient({
    transport: requestTransport("https://rpc.test", async () =>
      Response.json(
        { error: { code: -32005, message: "rate limited" } },
        { status: 429 },
      ),
    ),
  });
  await assert.rejects(
    client.getChainId(),
    (error) =>
      error instanceof BaseError &&
      error.walk(
        (cause) => cause instanceof HttpRequestError && cause.status === 429,
      ) instanceof HttpRequestError,
  );
});

test("hosted API uses an isolated named cache when default cache access is forbidden", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let opened = "";
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      get default() {
        throw new Error("Default cache is forbidden in a dispatch namespace");
      },
      open: async (name: string) => {
        opened = name;
        return { match: async () => Response.json({ chainId: CHAIN_ID }) };
      },
    },
  });
  try {
    const response = await worker.fetch(
      new Request("https://spreadline.test/api/network"),
      {} as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    assert.equal(opened, "spreadline-live-v1");
  } finally {
    if (original) Object.defineProperty(globalThis, "caches", original);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});

test("RPC calls batch within one request and remain isolated across concurrent requests", async () => {
  const batches: { context: string; methods: string[] }[] = [];
  const makeClient = (context: string) =>
    createPublicClient({
      transport: requestTransport("https://rpc.test", async (_input, init) => {
        const requests = JSON.parse(String(init?.body)) as {
          method: string;
          id: number;
        }[];
        batches.push({ context, methods: requests.map((r) => r.method) });
        return Response.json(
          requests.map((r) => ({
            jsonrpc: "2.0",
            id: r.id,
            result: r.method === "eth_chainId" ? "0x1237" : "0x1",
          })),
        );
      }),
    });
  const a = makeClient("a");
  const b = makeClient("b");
  const results = await Promise.all([
    a.getChainId(),
    a.getGasPrice(),
    b.getChainId(),
    b.getGasPrice(),
  ]);
  assert.deepEqual(results, [4663, 1n, 4663, 1n]);
  assert.equal(batches.length, 2);
  assert.deepEqual(new Set(batches.map((r) => r.context)), new Set(["a", "b"]));
  assert.ok(batches.every((r) => r.methods.length === 2));
});

const canonical = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const asset = {
  tokenSymbol: "NVDA",
  tokenName: "NVIDIA • Robinhood Token",
  deployments: [{ chainId: CHAIN_ID, contractAddress: canonical }],
  currentMultiplier: "1.0005",
  status: "ASSET_STATUS_ACTIVE",
  tokenDecimals: 18,
  logoUrl: "https://cdn.robinhood.com/token.svg",
};
const quote = {
  tokenSymbol: "NVDA",
  bid: "100.12",
  ask: "100.14",
  generatedAt: "2026-09-05T22:09:14.845414032Z",
  isTradingHalt: false,
  currency: "USD",
};

test("Robinhood enrichment preserves source semantics without treating missing volume as zero", () => {
  const enriched = parseCatalog({ assets: [{ ...asset, pendingMultiplier: "2", pendingMultiplierEffectiveTime: "2026-09-07T00:00:00Z", tradingCapabilities: { allDayTradability: "position_closing_only", fractionalTradability: null, extendedHoursFractionalTradability: false } }] }).assets[0];
  assert.equal(enriched.pendingMultiplier, "2");
  assert.equal(enriched.tradingCapabilities?.fractionalTradability, null);
  assert.equal(enriched.tradingCapabilities?.extendedHoursFractionalTradability, false);
  assert.equal(parsePrices({ quotes: [{ ...quote, dailyTradingVolume: "0" }] })[0].dailyTradingVolume, null);
  assert.equal(parsePrices({ quotes: [{ ...quote, dailyTradingVolume: "123.5" }] })[0].dailyTradingVolume, "123.5");
});
test("corporate actions retain relevant details beyond 30 rows and distinguish invalid processing dates", () => {
  const action = { tokenSymbol: "NVDA", type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND", status: "CORPORATE_ACTION_STATUS_IN_PROGRESS", deployments: [{ chainId: CHAIN_ID }], processDate: { year: 2026, month: 9, day: 30 }, details: { cashDividend: { rate: "0.01" } } };
  const result = parseCorporateActions({ corpActions: [...Array.from({ length: 40 }, () => ({ ...action, tokenSymbol: "AAPL" })), action] });
  assert.equal(result.length, 41); assert.equal(result[40].symbol, "NVDA");
  assert.equal(result[40].detail, "0.01 USD per underlying share");
  assert.equal(result[40].date, "2026-09-30");
  assert.equal(parseCorporateActions({ corpActions: [{ ...action, processDate: { year: 2026, month: 2, day: 31 } }] })[0].date, null);
  assert.deepEqual(parseCorporateActions({ corpActions: [{ ...action, deployments: [{ chainId: 1 }] }] }), []);
});
test("trade API validates address, side, decimal size and slippage before providers", async () => {
  for (const path of [
    "/api/swap-quote?symbol=NVDA&side=both&amount=100",
    "/api/swap-quote?symbol=NVDA&side=buy&amount=100&slippageBps=10000",
    "/api/swap-quote?symbol=NVDA&side=sell&amount=1e3",
    "/api/trade-plan?symbol=NVDA&side=buy&amount=100&slippageBps=50",
    "/api/trade-plan?symbol=NVDA&side=buy&amount=100&address=invalid",
    "/api/trade-plan?symbol=NVDA&side=buy&amount=100&to=0x123",
  ]) { const response = await worker.fetch(new Request(`https://spreadline.test${path}`), {} as Env, {} as ExecutionContext); assert.equal(response.status, 400, path); }
});

test("registry uses chain ID and contract address, ignoring testnet and invalid records", () => {
  const parsed = parseCatalog({
    assets: [
      asset,
      {
        ...asset,
        deployments: [{ chainId: 46630, contractAddress: canonical }],
      },
      {
        ...asset,
        deployments: [{ chainId: CHAIN_ID, contractAddress: "not-an-address" }],
      },
    ],
  });
  assert.equal(parsed.assets.length, 1);
  assert.equal(parsed.rejected, 1);
  assert.equal(parsed.assets[0].address.toLowerCase(), canonical.toLowerCase());
  assert.equal(parsed.assets[0].multiplier, "1.0005");
});

test("registry rejects empty usable data and drops untrusted image hosts", () => {
  assert.throws(() => parseCatalog({ assets: [] }));
  assert.equal(
    parseCatalog({
      assets: [
        {
          ...asset,
          logoUrl: "https://cdn.robinhood.com.attacker.test/token.svg",
        },
      ],
    }).assets[0].logo,
    null,
  );
  assert.throws(() =>
    parseCatalog({ assets: [{ ...asset, currentMultiplier: "NaN" }] }),
  );
});

test("price feed retains source timestamps and halted state and rejects crossed or malformed quotes", () => {
  const data = parsePrices({
    quotes: [
      quote,
      { ...quote, ask: "99" },
      { ...quote, generatedAt: "yesterday" },
      { ...quote, bid: "0" },
    ],
  });
  assert.deepEqual(data, [
    {
      symbol: "NVDA",
      bid: "100.12",
      ask: "100.14",
      generatedAt: quote.generatedAt,
      halted: false,
      currency: "USD",
      dailyTradingVolume: null,
    },
  ]);
  assert.equal(
    parsePrices({ quotes: [{ ...quote, isTradingHalt: true }] })[0].halted,
    true,
  );
});

test("cached source metadata is preserved instead of renewing the apparent freshness", async () => {
  const fetchedAt = "2026-09-05T21:00:00.000Z";
  const service = createMarketService(PUBLIC_RPC, async (url) => ({
    value: url.endsWith("/assets") ? { assets: [asset] } : { quotes: [quote] },
    fetchedAt,
  }));
  assert.equal((await service.catalog()).fetchedAt, fetchedAt);
  assert.equal((await service.prices()).fetchedAt, fetchedAt);
});

test("USDG input preserves micro-units and rejects rounding, exponent and oversized inputs", () => {
  assert.equal(parseTradeSize("1000.000001", 6), 1000000001n);
  assert.equal(parseTradeSize("100000", 6), 100000000000n);
  for (const input of [
    "0",
    "0.999999",
    "-1",
    "100000.000001",
    "1.0000001",
    "1e3",
    "NaN",
    "",
    "1,000",
  ])
    assert.throws(() => parseTradeSize(input, 6));
});

test("quotes expire at their exact deadline and malformed wallet addresses are rejected", () => {
  const deadline = Date.parse("2026-09-06T00:00:20.000Z");
  assert.equal(
    quoteIsFresh(new Date(deadline).toISOString(), deadline - 1),
    true,
  );
  assert.equal(quoteIsFresh(new Date(deadline).toISOString(), deadline), false);
  assert.equal(quoteIsFresh("invalid"), false);
  assert.throws(() => validWallet("alice.eth"));
  assert.equal(validWallet(canonical).toLowerCase(), canonical.toLowerCase());
});

test("request budgets enforce atomic limits, reset each minute and store no raw IP", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE request_budgets (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)",
  );
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: (string | number)[]) => ({
        first: async () => sqlite.prepare(sql).get(...params),
      }),
    }),
  } as unknown as D1Database;
  const now = 600000;
  const results = await Promise.all(
    Array.from({ length: 14 }, () =>
      consumeBudget(db, "203.0.113.7", "/api/quote", 10, now),
    ),
  );
  assert.equal(results.filter((r) => r.allowed).length, 10);
  assert.equal(
    (await consumeBudget(db, "203.0.113.7", "/api/portfolio", 10, now)).allowed,
    true,
  );
  assert.equal(
    (await consumeBudget(db, "203.0.113.7", "/api/quote", 10, now + 60000))
      .allowed,
    true,
  );
  const keys = sqlite.prepare("SELECT key FROM request_budgets").all();
  assert.ok(keys.every((row) => /^[a-f0-9]{64}$/.test(String(row.key))));
  sqlite.close();
});

test("upstream reader fails closed on HTTP errors, invalid JSON and oversized streamed responses", async () => {
  await assert.rejects(readBoundedJSON(new Response("{}", { status: 429 })));
  await assert.rejects(readBoundedJSON(new Response("<html>not JSON</html>")));
  await assert.rejects(
    readBoundedJSON(
      new Response("{}", { headers: { "content-length": "2000001" } }),
    ),
  );
  await assert.rejects(
    readBoundedJSON(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2000001));
            controller.close();
          },
        }),
      ),
    ),
  );
  assert.deepEqual(await readBoundedJSON(new Response('{"ok":true}')), {
    ok: true,
  });
});

test("API rejects invalid methods and queries before reaching data providers", async () => {
  const env = {} as Env;
  const ctx = {} as ExecutionContext;
  const cases = [
    ["/api/quote", "POST", 405],
    ["/api/unknown", "GET", 404],
    ["/api/quote?symbol=NVDA&amount=100001", "GET", 400],
    [
      "/api/quote?symbol=NVDA&amount=1000&rpc=https://malicious.test",
      "GET",
      400,
    ],
    ["/api/portfolio?address=invalid", "GET", 400],
  ] as const;
  for (const [path, method, expected] of cases)
    assert.equal(
      (
        await worker.fetch(
          new Request("https://spreadline.test" + path, { method }),
          env,
          ctx,
        )
      ).status,
      expected,
    );
  const health = await worker.fetch(
    new Request("https://spreadline.test/api/health"),
    env,
    ctx,
  );
  assert.equal(
    ((await health.json()) as { rpcTier: string }).rpcTier,
    "public",
  );
});

// The price universe endpoint has a different quota from symbol-scoped reads.
test("symbol prices use bounded concurrency, preserve partial results and reject mismatched symbols", async () => {
  const urls: string[] = [];
  let running = 0, peak = 0;
  const service = createMarketService(PUBLIC_RPC, async (url) => {
    urls.push(url);
    running++; peak = Math.max(peak, running);
    await Promise.resolve(); running--;
    const symbol = url.split("/").pop();
    if (symbol === "TSLA") throw new Error("provider cooling down");
    return { value: { quotes: [{ ...quote, tokenSymbol: symbol === "META" ? "OTHER" : symbol }] }, fetchedAt: "2026-09-05T21:00:00.000Z", cached: symbol === "AAPL" };
  });
  const book = await service.prices(["NVDA", "AAPL", "TSLA", "META"]);
  assert.equal(peak, 3);
  assert.ok(urls.every((url) => /\/prices\/[A-Z]+$/.test(url)));
  assert.deepEqual(book.quotes.map((q) => q.symbol), ["NVDA", "AAPL"]);
  assert.deepEqual(book.unavailableSymbols, ["TSLA", "META"]);
  assert.deepEqual(book.cachedSymbols, ["AAPL"]);
  assert.equal(book.quotes[0].generatedAt, quote.generatedAt);
  await assert.rejects(service.prices(["TSLA"]), /provider cooling down/);
});

test("API rejects empty, oversized and invalid symbol lists before any provider read", async () => {
  for (const symbols of ["", "NVDA,", "../prices", Array.from({ length: 17 }, (_, i) => `A${i}`).join(",")]) {
    const response = await worker.fetch(new Request(`https://spreadline.test/api/prices?symbols=${encodeURIComponent(symbols)}`), {} as Env, {} as ExecutionContext);
    assert.equal(response.status, 400);
  }
});

async function withTestCache(run: (entries: Map<string, Response>, context: ExecutionContext) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const entries = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    open: async () => ({
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()); },
    }),
  } });
  try { await run(entries, { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext); await Promise.all(pending); }
  finally { if (original) Object.defineProperty(globalThis, "caches", original); else Reflect.deleteProperty(globalThis, "caches"); }
}

test("server cooldown suppresses repeated upstream failures and returns Retry-After", async (t) => {
  let calls = 0;
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "limited" }, { status: 429, headers: { "retry-after": "120" } }); });
  await withTestCache(async (_entries, context) => {
    const request = new Request("https://spreadline.test/api/prices?symbols=NVDA,NVDA");
    const first = await worker.fetch(request, {} as Env, context);
    const again = await worker.fetch(request, {} as Env, context);
    assert.equal(first.status, 429); assert.equal(again.status, 429);
    assert.equal(first.headers.get("retry-after"), "120");
    assert.equal(calls, 1, "deduplication and cooldown prevent repeat source reads");
  });
});

test("last successful prices survive partial outages with original timestamps and cached labels", async (t) => {
  let failing = false, calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return failing ? Response.json({}, { status: 429 }) : Response.json({ quotes: [quote] });
  });
  await withTestCache(async (entries, context) => {
    const request = new Request("https://spreadline.test/api/prices?symbols=NVDA");
    const initial = await (await worker.fetch(request, {} as Env, context)).json();
    // Expire only fresh caches, retaining the source observation.
    for (const key of entries.keys()) if (new URL(key).pathname.startsWith("/__response-v2/") || new URL(key).pathname.startsWith("/__source-cache/")) entries.delete(key);
    failing = true;
    const next = await worker.fetch(request, {} as Env, context);
    const retained = await next.json();
    assert.equal(next.status, 200);
    assert.deepEqual(retained.cachedSymbols, ["NVDA"]);
    assert.deepEqual(retained.quotes, initial.quotes);
    assert.equal(retained.fetchedAt, initial.fetchedAt);
    assert.equal(calls, 2);
  });
});

import { getData, DataError, retryDeadline, pollingInterval } from "../src/lib/live-api";
import { appendObservation, modelRoundTrip } from "../src/lib/chart-data";

test("client cooldown covers repeated manual reads and accepts both Retry-After formats", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "Please wait" }, { status: 429, headers: { "retry-after": "90" } }); });
  const path = "test-cooldown?unique=1";
  await assert.rejects(getData(path), DataError);
  await assert.rejects(getData(path), DataError);
  assert.equal(calls, 1);
  const now = Date.parse("2026-09-05T21:00:00Z");
  assert.equal(retryDeadline("90", now), now + 90000);
  assert.equal(retryDeadline("Sat, 05 Sep 2026 21:02:00 GMT", now), now + 120000);
  assert.ok(pollingInterval(30000, new DataError("wait", 429, Date.now() + 120000), 1) >= 120000);
});

test("chart observations deduplicate issuer timestamps and reset at multiplier changes", () => {
  const q = parsePrices({ quotes: [quote] })[0];
  const first = appendObservation([], q, "0.5");
  assert.equal(first[0].bid, Number(quote.bid) * .5);
  assert.equal(appendObservation(first, q, "0.5"), first);
  assert.equal(appendObservation(first, { ...q, halted: true }, "0.5"), first);
  const second = appendObservation(first, { ...q, generatedAt: "2026-09-05T22:01:00.000Z" }, "0.25");
  assert.equal(second.length, 1);
  assert.equal(second[0].bid, Number(quote.bid) * .25);
});

test("strategy model reconciles the cost breakdown and responds to costs and depth", () => {
  const assumptions = { gapBps: 80, feeBps: 5, depth: 1000000, gas: 1 };
  const result = modelRoundTrip(1000, assumptions);
  assert.ok(Math.abs(result.net - (result.gross - result.fees - result.impact - result.gas)) < 1e-9);
  assert.ok(modelRoundTrip(1000, { ...assumptions, gapBps: 0 }).net < 0);
  assert.ok(modelRoundTrip(1000, { ...assumptions, feeBps: 30 }).net < result.net);
  assert.ok(modelRoundTrip(1000, { ...assumptions, depth: 250000 }).net < result.net);
  assert.ok(Math.abs(modelRoundTrip(1000, { ...assumptions, gas: 2 }).net - result.net + 1) < 1e-9);
});

test("expired quotes and private wallet data are never served from stale or public caches", async () => {
  await withTestCache(async (entries, context) => {
    for (const path of ["/api/quote?symbol=NVDA&amount=1000", "/api/swap-quote?symbol=NVDA&side=buy&amount=100&slippageBps=50", "/api/portfolio?address=0x1111111111111111111111111111111111111111", "/api/trade-plan?symbol=NVDA&side=buy&amount=100&slippageBps=50&address=0x1111111111111111111111111111111111111111"]) {
      const origin = "https://spreadline.test";
      const url = origin + path;
      entries.set(origin + "/__cooldown/" + encodeURIComponent(path), Response.json({ status: 429, retryAt: Date.now() + 60000, message: "Provider cooldown" }));
      entries.set(origin + "/__last-good/" + encodeURIComponent(path), Response.json({ expiresAt: "2026-01-01T00:00:00Z", routes: [{ surplus: "99" }] }));
      const privatePath = path.startsWith("/api/portfolio") || path.startsWith("/api/trade-plan");
      const publicKey = origin + "/__response-v2/" + encodeURIComponent(path);
      entries.set(publicKey, Response.json({ expiresAt: privatePath ? new Date(Date.now() + 60000).toISOString() : "2026-01-01T00:00:00Z", routes: [{ surplus: "99" }] }));
      const response = await worker.fetch(new Request(url), {} as Env, context);
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal("routes" in await response.json(), false);
    }
  });
});

test("aborting response JSON does not poison the healthy endpoint with a cooldown", async (t) => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls > 1) return Response.json({ ok: true });
    const response = Response.json({ ok: true });
    response.json = async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); };
    return response;
  });
  await assert.rejects(getData("test-abort-body", controller.signal), { name: "AbortError" });
  assert.deepEqual(await getData("test-abort-body"), { ok: true });
  assert.equal(calls, 2);
});

test("a cached snapshot respects its resume time without another client request", async (t) => {
  let calls = 0;
  const body = { fetchedAt: "2026-09-05T21:00:00Z", dataStatus: { state: "cached", retryAt: new Date(Date.now() + 60000).toISOString() } };
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(body); });
  assert.deepEqual(await getData("test-paused-snapshot"), body);
  assert.deepEqual(await getData("test-paused-snapshot"), body);
  assert.equal(calls, 1);
});

import "./lending-execution.test";

import "./arbitrage-monitor.test";
