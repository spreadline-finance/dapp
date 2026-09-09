import { test } from "node:test";
import assert from "node:assert/strict";
import { apiContractOrigin, checkApiContract, validateApiContract } from "../scripts/check-api-contract.mjs";
import { deploymentConfig } from "../config/deployment";
import contract from "../config/api-contract.json";

const healthy = () => ({ status: "ok", ...contract, capabilities: [...contract.capabilities] });
const environment = { VERCEL: "1", SPREADLINE_API_ORIGIN: "https://example.workers.dev" };

test("API contract rejects the old healthy Worker and incompatible versions/capabilities", () => {
  assert.throws(() => validateApiContract({ status: "ok", chainId: 4663, rpcTier: "public" }), /contract v2.*Deploy/);
  for (const apiVersion of [1, 3, "2", null]) assert.throws(() => validateApiContract({ ...healthy(), apiVersion }), /contract v2/);
  for (const capabilities of [undefined, "desk,rewards,wallet-trading", ["wallet-trading"], ["desk", "rewards"]])
    assert.throws(() => validateApiContract({ ...healthy(), capabilities }), /missing required capabilities/);
  for (const value of [null, [], { ...healthy(), status: "degraded" }, { ...healthy(), chainId: 1 }])
    assert.throws(() => validateApiContract(value), /not a healthy Robinhood Chain service/);
  assert.equal(validateApiContract(healthy()), true);
  assert.equal(validateApiContract({ ...healthy(), capabilities: [...contract.capabilities, "future-addition"] }), true);
});

test("API contract preflight shares deployment-origin restrictions and never echoes invalid secrets", () => {
  assert.equal(apiContractOrigin(environment), deploymentConfig(environment).apiOrigin);
  const secret = "do-not-print-this-secret";
  for (const origin of [undefined, `https://user:${secret}@example.com`, `https://example.com?key=${secret}`, `invalid-${secret}`,
    "http://localhost:8787", "https://127.0.0.1", "https://[::1]", "https://example.com/api", "https://example.com/#fragment", "https://spredline.vercel.app"]) {
    const env = { ...environment, SPREADLINE_API_ORIGIN: origin };
    assert.throws(() => deploymentConfig(env));
    assert.throws(() => apiContractOrigin(env), (error: Error) => !error.message.includes(secret) && /SPREADLINE_API_ORIGIN/.test(error.message));
  }
  for (const field of ["NEXT_PUBLIC_SITE_URL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) {
    const env = { ...environment, [field]: field === "NEXT_PUBLIC_SITE_URL" ? environment.SPREADLINE_API_ORIGIN : "example.workers.dev" };
    assert.throws(() => apiContractOrigin(env), /not the frontend/);
  }
});

test("API contract preflight skips local builds and checks only the configured Worker health for Vercel", async () => {
  let calls = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://example.workers.dev/api/health");
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
    return Response.json(healthy());
  };
  assert.deepEqual(await checkApiContract({}, fetcher), { skipped: true });
  assert.deepEqual(await checkApiContract({ VERCEL: "0", SPREADLINE_API_ORIGIN: "invalid" }, fetcher), { skipped: true });
  assert.equal(calls, 0);
  assert.deepEqual(await checkApiContract(environment, fetcher), { skipped: false, apiVersion: 2 });
  assert.equal(calls, 1);
});

test("API contract errors report actionable HTTP/JSON/transport failures without upstream content", async () => {
  const secret = "private-upstream-value";
  await assert.rejects(checkApiContract(environment, async () => new Response(secret, { status: 503 })), /HTTP 503.*Deploy/);
  await assert.rejects(checkApiContract(environment, async () => new Response(`<html>${secret}</html>`)), (error: Error) => /valid JSON/.test(error.message) && !error.message.includes(secret));
  await assert.rejects(checkApiContract(environment, async () => { throw new Error(`connect failed https://${secret}.example`); }), (error: Error) => /unreachable or timed out/.test(error.message) && !error.message.includes(secret));
  await assert.rejects(checkApiContract(environment, async () => new Response(" ".repeat(65537))), /response is too large/);
  await assert.rejects(checkApiContract(environment, async () => Response.json({ status: "ok", chainId: 4663 })), /contract v2/);
});

test("API contract ten-second deadline includes a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => { reading = resolve; });
  const request = checkApiContract(environment, async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    init.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    reading();
  } })));
  const assertion = assert.rejects(request, /timed out after 10 seconds.*Deploy/);
  await ready;
  t.mock.timers.tick(10000);
  await assertion;
});
