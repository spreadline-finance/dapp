import { test } from "node:test";
import assert from "node:assert/strict";
import { rewardUsdValue } from "../src/lib/rewards-usd";
import { parseRewardPrice, REWARD_PRICE_URL } from "../server/rewards-price";
import worker from "../server/worker";
const now = Date.now();
const quote = (price = "2463.985") => parseRewardPrice({ data: { base: "ETH", currency: "USD", amount: price } }, new Date(now).toISOString(), now);

test("USD conversions preserve tiny payouts, exact large balances, zero and cents", () => {
  const price = quote();
  assert.equal(rewardUsdValue("1000000000000000000", 18, price, "ETH", now), "≈ $2,463.99");
  assert.equal(rewardUsdValue("1000000000", 18, price, "ETH", now), "≈ $0.000002");
  assert.equal(rewardUsdValue("4497", 18, price, "ETH", now), "<$0.000001");
  assert.equal(rewardUsdValue("0", 18, price, "ETH", now), "≈ $0.00");
  assert.equal(rewardUsdValue("4274999995503", 18, price, "ETH", now), "≈ $0.01");
  assert.equal(rewardUsdValue("9007199254740993000000000000000000", 18, quote("1"), "ETH", now), "≈ $9,007,199,254,740,993.00");
});

test("missing, expired and mismatched USD quotes never invent dollar values or assume a USDG peg", () => {
  for (const price of [null, undefined, { ...quote(), fetchedAt: new Date(now - 120001).toISOString() }, { ...quote(), fetchedAt: new Date(now + 10001).toISOString() }]) {
    assert.equal(rewardUsdValue("1000000000", 18, price, "ETH", now), null);
  }
  assert.equal(rewardUsdValue("1000000", 6, quote(), "USDG", now), null);
  for (const raw of [undefined, null, "", "-1", "1.5", "1e9", "01"]) assert.equal(rewardUsdValue(raw, 18, quote(), "ETH", now), null);
});

test("price provider identity, timestamp and decimal amounts must be valid", () => {
  for (const amount of ["0", "-1", "Infinity", "NaN", "1e3", "01", "", 2500, "9".repeat(100)]) {
    assert.throws(() => parseRewardPrice({ data: { base: "ETH", currency: "USD", amount } }, new Date(now).toISOString(), now));
  }
  for (const data of [{ base: "BTC", currency: "USD", amount: "2500" }, { base: "ETH", currency: "EUR", amount: "2500" }]) assert.throws(() => parseRewardPrice({ data }, new Date(now).toISOString(), now));
  assert.throws(() => parseRewardPrice({ data: { base: "ETH", currency: "USD", amount: "2500" } }, "bad date", now));
});

test("USD route uses a fixed public source, caches it and rejects caller-selected inputs", async t => {
  const originalCache = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const saved = new Map<string, Response>();
  const cache = { match: async (key: Request) => saved.get(key.url)?.clone(), put: async (key: Request, response: Response) => { saved.set(key.url, response.clone()); } };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => cache } });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(String(url));
    return Response.json({ data: { base: "ETH", currency: "USD", amount: "2463.985" } });
  });
  try {
    const pending: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as ExecutionContext;
    for (let i = 0; i < 2; i++) {
      const response = await worker.fetch(new Request("https://dapp.example/api/reward-price"), {} as Env, context);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const data = await response.json();
      assert.equal(data.price, "2463.985");
      assert.equal(data.asset, "ETH");
      await Promise.all(pending);
    }
    assert.deepEqual(calls, [REWARD_PRICE_URL]);
    for (const query of ["symbol=BTC", "url=https://attacker.example", "date=2020-01-01"]) {
      assert.equal((await worker.fetch(new Request(`https://dapp.example/api/reward-price?${query}`), {} as Env, context)).status, 400);
    }
    assert.equal((await worker.fetch(new Request("https://dapp.example/api/reward-price", { method: "POST" }), {} as Env, context)).status, 405);
    assert.equal(calls.length, 1);
  } finally {
    if (originalCache) Object.defineProperty(globalThis, "caches", originalCache);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
