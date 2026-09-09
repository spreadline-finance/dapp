import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { createDeskService, deskScheduledSymbol, makeDeskPoolBoard, readDeskHistory } from "../server/desk-service";
import { deskVaultAbi } from "../src/lib/desk-contract";
import { SWAP_ROUTER, TRACKED_SYMBOLS, USDG, type Catalog, type PoolBook, type PriceBook } from "../src/lib/market-types";

const account = "0x1111111111111111111111111111111111111111" as const;
const vault = "0x2222222222222222222222222222222222222222" as const;
const stock = "0x3333333333333333333333333333333333333333" as const;
const code = "0x60006000" as const;
const config = { DESK_VAULT_ADDRESS: vault, DESK_VAULT_CODE_HASH: keccak256(code), DESK_VAULT_DEPLOY_BLOCK: "1" };
const now = Date.parse("2026-09-08T17:00:00Z");
const catalog: Catalog = { assets: [{ symbol: "NVDA", name: "Nvidia", address: stock, decimals: 18, multiplier: "0.5", logo: null, active: true }], fetchedAt: new Date(now).toISOString(), rejected: 0 };
const book: PoolBook = { symbol: "NVDA", blockNumber: "10000", blockTimestamp: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), failedReads: 0, pools: [{ address: vault, fee: 3000, liquidity: "2500", priceUSDG: 51, active: true }] };
const prices: PriceBook = { quotes: [{ symbol: "NVDA", bid: "98", ask: "102", currency: "USD", generatedAt: new Date(now).toISOString(), halted: false }], fetchedAt: new Date(now).toISOString() };
const markets = { catalog: async () => catalog, prices: async () => prices, pools: async () => book };

test("desk pool spreads compare token units and omit stale, halted and inactive opportunities", () => {
  const board = makeDeskPoolBoard(catalog, book, prices, now);
  assert.equal(board.reference?.bid, 49);
  assert.equal(board.reference?.ask, 51);
  assert.ok(Math.abs(board.pools[0].spreadBps! - 200) < 0.000001);
  assert.equal(makeDeskPoolBoard(catalog, book, prices, now + 120001).pools[0].spreadBps, null);
  const retainedReference = makeDeskPoolBoard(catalog, book, { ...prices, cachedSymbols: ["NVDA"] }, now);
  assert.equal(retainedReference.pools[0].spreadBps, null);
  assert.equal(retainedReference.reference?.cached, true);
  assert.equal(retainedReference.reference?.generatedAt, prices.quotes[0].generatedAt);
  const dataStatus = { state: "cached", reason: "Upstream unavailable", retryAt: new Date(now + 60000).toISOString() } as const;
  assert.equal(makeDeskPoolBoard({ ...catalog, dataStatus }, book, prices, now).pools[0].spreadBps, null);
  assert.equal(makeDeskPoolBoard(catalog, { ...book, dataStatus }, prices, now).pools[0].spreadBps, null);
  assert.equal(makeDeskPoolBoard(catalog, book, { ...prices, dataStatus }, now).pools[0].spreadBps, null);
  assert.equal(makeDeskPoolBoard(catalog, book, { ...prices, quotes: [{ ...prices.quotes[0], halted: true }] }, now).pools[0].spreadBps, null);
  assert.equal(makeDeskPoolBoard(catalog, { ...book, pools: [{ ...book.pools[0], active: false }] }, prices, now).pools[0].spreadBps, null);
  assert.equal(makeDeskPoolBoard(catalog, book, null, now).reference, null);
  assert.throws(() => makeDeskPoolBoard({ ...catalog, assets: [] }, book, prices, now), /not active/);
});

test("unconfigured or unverified desk never invents zero balances or makes RPC requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const absent = await createDeskService("https://rpc.test", { ...config, DESK_VAULT_ADDRESS: "" }, markets).snapshot(account);
  assert.equal(absent.status, "unconfigured"); assert.equal(absent.vault, null); assert.equal(absent.wallet, null); assert.equal(absent.blockNumber, null);
  const unverified = await createDeskService("https://rpc.test", { ...config, DESK_VAULT_CODE_HASH: "" }, markets).snapshot(account);
  assert.equal(unverified.status, "unavailable"); assert.equal(unverified.vault, null); assert.match(unverified.message, /verification/);
  const invalid = await createDeskService("https://rpc.test", { ...config, DESK_VAULT_ADDRESS: "0x123" }, markets).snapshot();
  assert.equal(invalid.status, "unavailable");
});

type RPC = { id: number; method: string; params: unknown[] };
function mockDeskRPC(t: Parameters<Parameters<typeof test>[1]>[0], options: { chain?: string; stale?: boolean; code?: Hex; settlement?: Hex; router?: Hex; eventsFail?: boolean } = {}) {
  const calls: RPC[] = [];
  const abi = [...deskVaultAbi, ...parseAbi(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"])];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); const batch: RPC[] = Array.isArray(body) ? body : [body];
    const responses = batch.map((request) => {
      calls.push(request); let result: unknown;
      if (request.method === "eth_chainId") result = options.chain ?? "0x1237";
      else if (request.method === "eth_getBlockByNumber") result = { number: "0x2710", timestamp: `0x${(Math.floor(Date.now() / 1000) - (options.stale ? 180 : 0)).toString(16)}`, hash: `0x${"a".repeat(64)}`, transactions: [], gasLimit: "0x1000000", gasUsed: "0x0" };
      else if (request.method === "eth_getCode") result = options.code ?? code;
      else if (request.method === "eth_getLogs") {
        if (options.eventsFail) return { id: request.id, jsonrpc: "2.0", error: { code: -32005, message: "Logs unavailable" } };
        result = [];
      } else if (request.method === "eth_call") {
        const tx = request.params[0] as { data: Hex };
        const decoded = decodeFunctionData({ abi, data: tx.data });
        const fn = decoded.functionName;
        const values: Record<string, unknown> = { settlement: options.settlement ?? USDG, router: options.router ?? SWAP_ROUTER, operator: account, decimals: 6, managedAssets: 1000000000n, totalShares: 1000000000000000n, totalRewardsReserved: 7500000n, totalRealizedProfit: 10000000n, totalClaimed: 0n, maxTradeAssets: 100000000n, paused: false, REWARD_BPS: 7500n, sharesOf: 100000000000000n, earned: 750000n, balanceOf: 250000000n, allowance: 0n, previewRedeem: 99999999n };
        if (!(fn in values)) throw new Error(`Unexpected read ${fn}`);
        result = encodeFunctionResult({ abi, functionName: fn, result: values[fn] as never });
      } else throw new Error(`Unexpected RPC ${request.method}`);
      return { id: request.id, jsonrpc: "2.0", result };
    });
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  });
  return calls;
}

test("desk verifies code, chain and vault identity and pins every financial read to one block", async (t) => {
  const calls = mockDeskRPC(t);
  const result = await createDeskService("https://rpc.desk.test", config, markets).snapshot(account);
  assert.equal(result.status, "ready"); assert.equal(result.blockNumber, "10000");
  assert.equal(result.wallet?.redeemableAssets, "99999999", "uses vault preview rather than a rounded proportional estimate");
  assert.equal(result.wallet?.claimableAssets, "750000"); assert.equal(result.vault?.totalRealizedProfit, "10000000");
  assert.equal(result.eventsFromBlock, "5001");
  assert.ok(calls.filter((call) => call.method === "eth_call" || call.method === "eth_getCode").every((call) => call.params[1] === "0x2710"));
  const ranges = calls.filter((call) => call.method === "eth_getLogs").map((call) => call.params[0] as { fromBlock: Hex; toBlock: Hex });
  assert.equal(ranges.length, 5);
  assert.ok(ranges.every((range) => BigInt(range.toBlock) - BigInt(range.fromBlock) <= 999n));
});

test("desk refuses stale blocks, unexpected bytecode and mismatched settlement or router", async (t) => {
  for (const options of [{ chain: "0x1" }, { stale: true }, { code: "0x6001" as Hex }, { settlement: stock }, { router: stock }]) {
    mockDeskRPC(t, options);
    const result = await createDeskService("https://rpc.desk.test", config, markets).snapshot(account);
    assert.equal(result.status, "unavailable"); assert.equal(result.vault, null); assert.equal(result.wallet, null);
    t.mock.restoreAll();
  }
});

test("payout event failures remain explicit without erasing verified contract totals", async (t) => {
  mockDeskRPC(t, { eventsFail: true });
  const result = await createDeskService("https://rpc.desk.test", config, markets).snapshot();
  assert.equal(result.status, "ready"); assert.equal(result.vault?.totalRealizedProfit, "10000000");
  assert.deepEqual(result.events, []); assert.match(result.eventsError!, /could not be loaded/);
});

test("scheduled desk coverage rotates every tracked symbol within forty minutes", () => {
  assert.deepEqual(Array.from({ length: TRACKED_SYMBOLS.length }, (_, index) => deskScheduledSymbol(index * 300000)), TRACKED_SYMBOLS);
  assert.equal(deskScheduledSymbol(TRACKED_SYMBOLS.length * 300000), TRACKED_SYMBOLS[0]);
});

test("missing history migration is shown as unavailable rather than a fabricated blank chart", async () => {
  const db = { prepare() { throw new Error("no such table"); } } as D1Database;
  const result = await readDeskHistory(db, "NVDA");
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.points, []); assert.match(result.message, /migration/);
});
