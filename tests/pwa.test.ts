import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import manifest from "../src/app/manifest";

function serviceWorker(networkFails = false) {
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  const cached: string[] = [], deleted: string[] = [], requested: string[] = [];
  const offline = new Response("offline fallback", { headers: { "Content-Type": "text/html" } });
  let claimed = false;
  const worker = {
    location: { origin: "http://127.0.0.1:3000" },
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => events.set(name, handler),
    clients: { claim: async () => { claimed = true; } },
    skipWaiting: () => { throw new Error("Must not replace the worker under an active wallet flow"); },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: worker, URL, Response,
    caches: {
      open: async () => ({ addAll: async (paths: string[]) => { cached.push(...paths); } }),
      match: async (key: string | { url: string }) => (typeof key === "string" ? key : key.url) === "/offline.html" ? offline.clone() : undefined,
      keys: async () => ["spreadline-offline-v0", "spreadline-offline-v1", "another-app-cache", "private-user-cache"],
      delete: async (key: string) => { deleted.push(key); return true; },
    },
    fetch: async (request: { url: string }) => { requested.push(request.url); if (networkFails) throw new Error("offline"); return new Response("fresh network"); },
  });
  async function lifecycle(name: string) { let work: Promise<unknown> | undefined; events.get(name)!({ waitUntil: (value: Promise<unknown>) => { work = value; } }); await work; }
  function fetchEvent(path: string, method = "GET", mode = "cors") {
    let response: Promise<Response> | undefined;
    events.get("fetch")!({ request: { url: new URL(path, worker.location.origin).href, method, mode }, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  }
  return { lifecycle, fetchEvent, cached, deleted, requested, claimed: () => claimed };
}

test("PWA never intercepts APIs, wallet RPC, mutations or executable app assets", () => {
  const sw = serviceWorker(true);
  for (const path of ["/api", "/api/lending/position?address=0xabc", "/api/lending/plan", "/api/trade/plan", "https://rpc.mainnet.chain.robinhood.com/", "/_next/static/chunks/app.js", "/app?_rsc=payload"]) assert.equal(sw.fetchEvent(path), undefined, path);
  assert.equal(sw.fetchEvent("/api/lending/position", "GET", "navigate"), undefined);
  assert.equal(sw.fetchEvent("/app", "POST", "navigate"), undefined);
  assert.equal(sw.fetchEvent("https://example.com/app", "GET", "navigate"), undefined);
  assert.equal(sw.requested.length, 0);
});

test("PWA navigations use the network and fall back only to a non-trading offline document", async () => {
  const online = serviceWorker();
  assert.equal(await (await online.fetchEvent("/app?view=lending", "GET", "navigate"))?.text(), "fresh network");
  assert.equal(online.cached.length, 0, "Never persist visited application documents");
  const offline = serviceWorker(true);
  assert.equal(await (await offline.fetchEvent("/app?view=lending", "GET", "navigate"))?.text(), "offline fallback");
  assert.equal(offline.cached.length, 0);
});

test("PWA installation caches only the offline page/icons and preserves unrelated caches", async () => {
  const sw = serviceWorker();
  await sw.lifecycle("install");
  assert.deepEqual(sw.cached, ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"]);
  await sw.lifecycle("activate");
  assert.deepEqual(sw.deleted, ["spreadline-offline-v0"]);
  assert.equal(sw.claimed(), true);
});

test("PWA manifest opens the workspace with valid branded PNG icons and useful shortcuts", () => {
  const value = manifest();
  assert.equal(value.start_url, "/app");
  assert.equal(value.display, "standalone");
  assert.equal(value.scope, "/");
  assert.ok(value.icons?.some((icon) => icon.purpose === "maskable"));
  for (const icon of value.icons ?? []) {
    const file = readFileSync(`public${icon.src}`), [width, height] = icon.sizes!.split("x").map(Number);
    assert.equal(file.subarray(1, 4).toString(), "PNG");
    assert.equal(file.readUInt32BE(16), width);
    assert.equal(file.readUInt32BE(20), height);
  }
  assert.ok(value.shortcuts?.some((shortcut) => shortcut.url === "/app?view=lending"));
  const og = readFileSync("public/og.png");
  assert.equal(og.readUInt32BE(16), 1200); assert.equal(og.readUInt32BE(20), 630);
});
