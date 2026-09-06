import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteLife, quoteMatchesSelection, quoteSamples, rankedRoutes, sampleSegments } from "../src/lib/arbitrage-monitor";
import { createResearchQuoteClient } from "../src/lib/research-quote-client";
import { DataError } from "../src/lib/live-api";
import type { QuoteBook } from "../src/lib/market-types";

const start = Date.parse("2026-09-06T15:00:00Z");
const pool = (id: string) => `0x${id.repeat(40)}`;
function quote(overrides: Partial<QuoteBook> = {}): QuoteBook {
  return {
    symbol: "NVDA", amountIn: "1000", settlementDecimals: 6, blockNumber: "500", blockHash: "0x500",
    blockTimestamp: new Date(start).toISOString(), fetchedAt: new Date(start + 5000).toISOString(), expiresAt: new Date(start + 20000).toISOString(),
    attempted: 2, failed: 0, executionEnabled: false,
    routes: [
      { buyFee: 500, sellFee: 3000, buyPool: pool("1"), sellPool: pool("2"), amountOut: "995", surplus: "-5", gasUnits: "200000", crossedTicks: [0, 1] },
      { buyFee: 3000, sellFee: 500, buyPool: pool("2"), sellPool: pool("1"), amountOut: "997", surplus: "-3", gasUnits: "210000", crossedTicks: [1, 0] },
    ], ...overrides,
  };
}

test("live quote identity binds token, exact size and research mode; ranking preserves source order", () => {
  const data = quote({ amountIn: "1.500000" });
  assert.equal(quoteMatchesSelection(data, "NVDA", "1.5"), true);
  assert.equal(quoteMatchesSelection(data, "AAPL", "1.5"), false);
  assert.equal(quoteMatchesSelection(data, "NVDA", "2"), false);
  assert.equal(quoteMatchesSelection({ ...data, executionEnabled: true } as unknown as QuoteBook, "NVDA", "1.5"), false);
  assert.equal(rankedRoutes(data)[0].surplus, "-3");
  assert.equal(data.routes[0].surplus, "-5");
});

test("quote freshness consumes source latency and never restarts an expired observation", () => {
  const data = quote();
  assert.deepEqual(quoteLife(data, start + 5000), { fresh: true, remaining: 15, fraction: .75 });
  assert.deepEqual(quoteLife(data, start + 20000), { fresh: false, remaining: 0, fraction: 0 });
  assert.equal(quoteLife({ ...data, fetchedAt: new Date(start + 60000).toISOString() }, start + 60000).fresh, false);
  assert.equal(quoteLife(data, start - 1).fresh, false);
  assert.equal(quoteLife({ ...data, expiresAt: "invalid" }, start).fresh, false);
});

test("history deduplicates blocks and separates token/size combinations without filling missing quotes", () => {
  const point = (seconds: number, overrides: Partial<QuoteBook> = {}) => quote({ blockHash: `0x${seconds}`, blockNumber: String(seconds), blockTimestamp: new Date(start + seconds * 1000).toISOString(), ...overrides });
  const samples = quoteSamples([
    point(90), point(0), point(15, { failed: 1 }), point(30), point(30), point(105, { routes: [] }), point(120),
    point(40, { symbol: "AAPL" }), point(45, { amountIn: "100" }),
  ], "NVDA", "1000.000000");
  assert.deepEqual(samples.map((p) => p.block), ["0", "15", "30", "90", "105", "120"]);
  assert.deepEqual(samples.map((p) => p.value), [-3, null, -3, -3, null, -3]);
  assert.deepEqual(sampleSegments(samples).map((s) => s.map((p) => p.block)), [["0"], ["30"], ["90"], ["120"]]);
  const many = quoteSamples(Array.from({ length: 55 }, (_, index) => point(index * 15)), "NVDA", "1000");
  assert.equal(many.length, 40);
  assert.equal(many[0].block, "225");
});

test("research requests serialize even when the previous RPC exceeds the minimum interval", async () => {
  let now = 0;
  const waits: { at: number; resolve: () => void }[] = [];
  const reads: { symbol: string; at: number; resolve: (q: QuoteBook) => void }[] = [];
  const client = createResearchQuoteClient({ now: () => now,
    sleep: (ms) => new Promise((resolve) => waits.push({ at: now + ms, resolve })),
    read: (symbol) => new Promise((resolve) => reads.push({ symbol, at: now, resolve })),
  });
  const advance = async (at: number) => { now = at; waits.splice(0).forEach((w) => { if (w.at <= now) w.resolve(); else waits.push(w); }); await Promise.resolve(); };
  const signal = new AbortController().signal;
  const first = client.request("NVDA", "1000", signal);
  const second = client.request("AAPL", "1000", signal);
  assert.equal(reads.length, 1);
  await advance(15000);
  assert.equal(reads.length, 1, "An in-flight provider call still owns the admission slot");
  reads[0].resolve(quote());
  await first;
  await advance(15250);
  assert.equal(reads.length, 2);
  assert.ok(reads[1].at - reads[0].at >= 15000);
  reads[1].resolve(quote({ symbol: "AAPL" }));
  await second;
  assert.equal(client.status().inFlight, false);
});

test("a rate-limit deadline is shared across markets and cannot be bypassed by changing size", async () => {
  let now = 0, calls = 0;
  const times: number[] = [];
  const client = createResearchQuoteClient({ now: () => now, sleep: async (ms) => { now += ms; }, read: async (symbol, amount) => {
    calls++; times.push(now);
    if (calls === 1) throw new DataError("Slow down", 429, 120000);
    return quote({ symbol, amountIn: amount });
  } });
  const signal = new AbortController().signal;
  await assert.rejects(client.request("NVDA", "1000", signal), /Slow down/);
  assert.equal(client.status().nextAt, 121000);
  await client.request("AAPL", "500", signal);
  assert.deepEqual(times, [0, 121000]);
  assert.equal(client.status().retryAt, 0);
});

test("repeated provider failures back off across requests and a mismatched result is rejected", async () => {
  let now = 0, calls = 0;
  const times: number[] = [];
  const client = createResearchQuoteClient({ now: () => now, sleep: async (ms) => { now += ms; }, read: async () => {
    calls++; times.push(now);
    if (calls <= 2) throw new Error("Provider unavailable");
    return quote({ amountIn: "99" });
  } });
  const signal = new AbortController().signal;
  await assert.rejects(client.request("NVDA", "1000", signal), /Provider unavailable/);
  await assert.rejects(client.request("NVDA", "1000", signal), /Provider unavailable/);
  await assert.rejects(client.request("NVDA", "1000", signal), /did not match/);
  assert.deepEqual(times, [0, 30000, 90000]);
  assert.equal(client.status().inFlight, false);
});

test("abandoning a queued refresh cancels its timer without making another request or adding provider cooldown", async () => {
  let calls = 0;
  const client = createResearchQuoteClient({ read: async () => { calls++; return quote(); } });
  const controller = new AbortController();
  await client.request("NVDA", "1000", controller.signal);
  const waiting = client.request("NVDA", "1000", controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(client.status().inFlight, false);
  assert.equal(client.status().retryAt, 0);
});
