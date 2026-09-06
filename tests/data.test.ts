import "./position-planner.test";
import "./arbitrage-monitor.test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  parseCatalog,
  parsePrices,
  parseTradeSize,
  quoteIsFresh,
  validWallet,
} from "../server/validation";
import { consumeBudget } from "../server/rate-limit";
import { createMarketService } from "../server/market-service";
import worker, { readBoundedJSON } from "../server/worker";
import { CHAIN_ID, PUBLIC_RPC } from "../src/lib/market-types";
import { requestTransport } from "../server/rpc";
import { createPublicClient, BaseError, HttpRequestError } from "viem";

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
