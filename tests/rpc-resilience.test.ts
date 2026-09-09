import assert from "node:assert/strict";
import test from "node:test";
import {
  BaseError,
  HttpRequestError,
  ResponseBodyTooLargeError,
  createPublicClient,
  type HttpTransportConfig,
} from "viem";
import { requestTransport } from "../server/rpc";

type RPC = { id: number; method: string; params?: unknown[] };
type FetchRPC = NonNullable<HttpTransportConfig["fetchFn"]>;
const account = "0x1111111111111111111111111111111111111111";
const call = { method: "eth_call", params: [{ to: account, data: "0x12345678" }, "0x10"] } as const;

function requests(init?: RequestInit): RPC[] {
  return JSON.parse(String(init?.body)) as RPC[];
}

function success(batch: RPC[], value = "0x1") {
  return Response.json(batch.map(({ id }) => ({ jsonrpc: "2.0", id, result: value })));
}

function httpCause(error: unknown, status: number) {
  return error instanceof BaseError
    ? error.walk((cause) => cause instanceof HttpRequestError && cause.status === status)
    : undefined;
}

test("concurrent identical RPC reads are coalesced, but settled and changed-block reads stay fresh", async () => {
  const batches: RPC[][] = [];
  const client = createPublicClient({
    transport: requestTransport("https://rpc-dedupe.test", async (_input, init) => {
      const batch = requests(init);
      batches.push(batch);
      return success(batch, `0x${batches.length}`);
    }),
  });

  assert.deepEqual(await Promise.all([client.request(call), client.request(call), client.request(call)]), ["0x1", "0x1", "0x1"]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);

  // A later read of the same block must observe a new provider response. This
  // transport does not reuse completed reads for quotes or reorg validation.
  assert.equal(await client.request(call), "0x2");
  assert.equal(batches.length, 2);
  const otherBlock = { ...call, params: [call.params[0], "0x11"] } as const;
  const otherContract = { ...call, params: [{ ...call.params[0], to: "0x2222222222222222222222222222222222222222" }, "0x10"] } as const;
  await Promise.all([client.request(call), client.request(otherBlock), client.request(otherContract)]);
  assert.equal(batches.length, 3);
  assert.equal(batches[2].length, 3);
});

test("explicit no-dedupe reads and transaction submissions remain separate RPC calls", async () => {
  const batches: RPC[][] = [];
  const client = createPublicClient({
    transport: requestTransport("https://rpc-no-dedupe.test", async (_input, init) => {
      const batch = requests(init);
      batches.push(batch);
      return success(batch);
    }),
  });
  await Promise.all([client.request(call, { dedupe: false }), client.request(call, { dedupe: false })]);
  assert.equal(batches[0].length, 2);
  // No wallet is used: the fake provider proves this transport never merges a
  // mutation, even if a caller accidentally asks for deduplication.
  const submission = { method: "eth_sendRawTransaction", params: ["0x1234"] } as const;
  await Promise.all([client.request(submission, { dedupe: true }), client.request(submission, { dedupe: true })]);
  assert.equal(batches[1].length, 2);
});

test("block rechecks fetch a new hash and concurrent latest reads retain Viem's freshness override", async () => {
  const batches: RPC[][] = [];
  const client = createPublicClient({
    transport: requestTransport("https://rpc-block-recheck.test", async (_input, init) => {
      const batch = requests(init);
      batches.push(batch);
      return Response.json(batch.map(({ id }) => ({ jsonrpc: "2.0", id, result: {
        number: "0x10", timestamp: "0x100", hash: `0x${String(batches.length).repeat(64)}`, transactions: [],
      } })));
    }),
  });
  const first = await client.getBlock({ blockNumber: 16n });
  const recheck = await client.getBlock({ blockNumber: 16n });
  assert.notEqual(recheck.hash, first.hash);
  assert.equal(batches.length, 2);
  await Promise.all([client.getBlock({ blockTag: "latest" }), client.getBlock({ blockTag: "latest" })]);
  assert.equal(batches[2].length, 2);
  assert.ok(batches[2].every(({ params }) => params?.[0] === "latest"));
});

test("separate clients made from the same RPC factory keep reads and failures isolated", async (t) => {
  t.mock.method(console, "error", () => {});
  const batches: RPC[][] = [];
  const fetchRPC: FetchRPC = async (_input, init) => {
    const batch = requests(init);
    batches.push(batch);
    return batches.length === 1
      ? Response.json({ error: { code: -32005, message: "limited" } }, { status: 429 })
      : success(batch, "0x2");
  };
  const transport = requestTransport("https://rpc-isolated.test", fetchRPC);
  const first = createPublicClient({ transport });
  const second = createPublicClient({ transport });
  const results = await Promise.allSettled([first.request(call), second.request(call)]);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((batch) => batch.length === 1));
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results[1], { status: "fulfilled", value: "0x2" });
  assert.equal(await second.request(call), "0x2");
  assert.equal(batches.length, 3);
});

test("HTTP-200 singleton RPC rate limits preserve Retry-After and stop later request stages", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const code of [-32005, 429]) {
    let fetches = 0;
    const client = createPublicClient({
      transport: requestTransport(`https://rpc-singleton-${code}.test`, async () => {
        fetches++;
        return Response.json({ jsonrpc: "2.0", id: null, error: { code, message: "limited" } }, { headers: { "retry-after": "7" } });
      }),
    });
    const check = (error: unknown) => {
      const cause = httpCause(error, 429);
      assert.ok(cause instanceof HttpRequestError);
      assert.equal(cause.headers?.get("retry-after"), "7");
      return true;
    };
    await assert.rejects(client.request(call), check);
    await assert.rejects(client.getChainId(), check);
    assert.equal(fetches, 1);
  }
});

test("an HTTP 429 preserves date Retry-After without retrying or calling later stages", async (t) => {
  t.mock.method(console, "error", () => {});
  let fetches = 0;
  const retryAfter = "Wed, 09 Sep 2026 18:00:00 GMT";
  const client = createPublicClient({
    transport: requestTransport("https://rpc-http429.test", async () => {
      fetches++;
      return new Response("provider busy", { status: 429, headers: { "retry-after": retryAfter } });
    }),
  });
  await assert.rejects(client.request(call), (error) => {
    const cause = httpCause(error, 429);
    assert.ok(cause instanceof HttpRequestError);
    assert.equal(cause.headers?.get("retry-after"), retryAfter);
    return true;
  });
  await assert.rejects(client.getGasPrice());
  assert.equal(fetches, 1);
});

test("mixed RPC batches retain successful members and rate-limit headers on failed members", async (t) => {
  t.mock.method(console, "error", () => {});
  let fetches = 0;
  const client = createPublicClient({
    transport: requestTransport("https://rpc-mixed.test", async (_input, init) => {
      fetches++;
      const batch = requests(init);
      return Response.json(batch.map(({ id }, index) => index === 0
        ? { jsonrpc: "2.0", id, result: "0x12" }
        : { jsonrpc: "2.0", id, error: { code: -32005, message: "limited" } }), { headers: { "retry-after": "3" } });
    }),
  });
  const results = await Promise.allSettled([client.request(call), client.getGasPrice()]);
  assert.deepEqual(results[0], { status: "fulfilled", value: "0x12" });
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") {
    const cause = httpCause(results[1].reason, 429);
    assert.ok(cause instanceof HttpRequestError);
    assert.equal(cause.headers?.get("retry-after"), "3");
  }
  await assert.rejects(client.getChainId());
  assert.equal(fetches, 1);
});

test("ordinary RPC reverts and HTTP failures do not become a rate-limit circuit", async (t) => {
  t.mock.method(console, "error", () => {});
  let fetches = 0;
  const client = createPublicClient({
    transport: requestTransport("https://rpc-other-errors.test", async (_input, init) => {
      fetches++;
      if (fetches === 1) return new Response("unavailable", { status: 503, headers: { "retry-after": "2" } });
      const batch = requests(init);
      if (fetches === 2) return Response.json(batch.map(({ id }) => ({ jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } })));
      return success(batch, "0x5");
    }),
  });
  await assert.rejects(client.request(call), (error) => httpCause(error, 503) instanceof HttpRequestError);
  await assert.rejects(client.request(call), (error) => !(httpCause(error, 429) instanceof HttpRequestError));
  assert.equal(await client.request(call), "0x5");
  assert.equal(fetches, 3);
});

test("RPC envelope inspection keeps the response byte limit and cancels oversized streams", async () => {
  let cancelled = false;
  const client = createPublicClient({
    transport: requestTransport("https://rpc-size-limit.test", async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
        controller.enqueue(new Uint8Array(1_000_001));
      },
      cancel() { cancelled = true; },
    }))),
  });
  await assert.rejects(client.request(call), (error) => error instanceof BaseError && error.walk((cause) => cause instanceof ResponseBodyTooLargeError) instanceof ResponseBodyTooLargeError);
  assert.equal(cancelled, true);
});
