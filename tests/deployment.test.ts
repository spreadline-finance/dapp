import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentConfig } from "../config/deployment";
import { getData, DataError } from "../src/lib/live-api";

test("deployment preserves local API and Cloudflare static export", () => {
  assert.deepEqual(deploymentConfig({ NODE_ENV: "development", VERCEL: "1" }), { staticExport: false, apiOrigin: "http://127.0.0.1:8787" });
  assert.deepEqual(deploymentConfig({ NODE_ENV: "production" }), { staticExport: true, apiOrigin: undefined });
});
test("Vercel requires a separate public API origin", () => {
  assert.throws(() => deploymentConfig({ VERCEL: "1" }), /SPREADLINE_API_ORIGIN/);
  for (const origin of ["http://localhost:8787", "https://127.0.0.1", "https://user:secret@example.com", "https://example.com/api", "https://example.com?key=secret", "https://example.com/#fragment", "https://spredline.vercel.app"]) {
    assert.throws(() => deploymentConfig({ VERCEL: "1", SPREADLINE_API_ORIGIN: origin }));
  }
  assert.deepEqual(deploymentConfig({ VERCEL: "1", SPREADLINE_API_ORIGIN: "https://example.workers.dev/" }), { staticExport: false, apiOrigin: "https://example.workers.dev" });
});
test("HTML API 404 reports service unavailable instead of reconnecting", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } });
  try {
    await assert.rejects(getData("deployment-test-missing-api"), (error: unknown) => error instanceof DataError && error.status === 404 && /unavailable on this deployment/.test(error.message));
  } finally { globalThis.fetch = previous; }
});
