import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { canActivateDemo, demoBalance } from "../src/lib/demo-wallet";
import { DEMO_WALLETS } from "../src/lib/demo-wallet-presets";
import { walletSubmissions } from "../src/lib/wallet-submission";
import { parsePlannerAmount, plannerSizes } from "../src/lib/position-planner";
import { TRACKED_SYMBOLS } from "../src/lib/market-types";
import type { WalletState } from "../src/components/wallet";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("demo activation requires development plus an exact loopback host", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
    assert.equal(canActivateDemo("development", host, false), true, host);
    for (const environment of ["production", "test", undefined]) assert.equal(canActivateDemo(environment, host, false), false);
    assert.equal(canActivateDemo("development", host, true), false);
  }
  for (const host of ["localhost.example.com", "127.0.0.1.example.com", "192.168.1.2", "0.0.0.0", "spreadline.com", "", "localhost:3000"]) assert.equal(canActivateDemo("development", host, false), false, host);
});

test("any in-flight real submission blocks demo, including providers from another mount", () => {
  const provider = { request: async () => undefined };
  walletSubmissions.add(provider);
  try { assert.equal(canActivateDemo("development", "localhost", false), false); }
  finally { walletSubmissions.delete(provider); }
  assert.equal(canActivateDemo("development", "localhost", false), true);
});

test("presets contain inert exact quantities and preserve fractional exit precision", () => {
  assert.equal(new Set(DEMO_WALLETS.map((wallet) => wallet.id)).size, 3);
  for (const wallet of DEMO_WALLETS) {
    assert.deepEqual(Object.keys(wallet).sort(), ["balances", "description", "id", "name"]);
    assert.ok(Object.isFrozen(wallet) && Object.isFrozen(wallet.balances));
    for (const symbol of ["ETH", "USDG", ...TRACKED_SYMBOLS]) {
      const value = demoBalance(wallet, symbol);
      assert.match(value, /^\d+(\.\d+)?$/);
      if (Number(value) > 0) assert.ok(parsePlannerAmount(value, symbol === "USDG" ? 6 : 18) > 0);
    }
    assert.equal(demoBalance(wallet, "UNKNOWN"), "0");
    assert.equal(demoBalance(wallet, "toString"), "0");
  }
  const exact = demoBalance(DEMO_WALLETS[2], "NVDA");
  assert.equal(plannerSizes(exact, 18)[2].amountIn, "0.123456789012345678");
});

const bundles = new Map<string, Promise<string>>();
function walletBundle(environment: string) {
  let result = bundles.get(environment);
  if (!result) {
    result = build({ stdin: { contents: 'export { useWallet } from "./src/components/wallet"; export { walletSubmissions } from "./src/lib/wallet-submission";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": JSON.stringify(environment) }, plugins: [{ name: "wallet-hook-harness", setup(builder) {
      builder.onResolve({ filter: /^react$/ }, (args) => args.importer.endsWith("/components/wallet.tsx") ? { path: "hooks", namespace: "test" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const {useState,useRef,useEffect,useCallback} = globalThis.testHooks;", loader: "js" }));
    } }] }).then((output) => output.outputFiles[0].text);
    bundles.set(environment, result);
  }
  return result;
}

// A deliberately small state/effect harness exercises the actual hook, without
// requiring a browser or substituting its wallet/session business logic.
async function mountWallet(environment = "development", hostname = "localhost") {
  const state: unknown[] = [], refs: { current: unknown }[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  const callbacks = new Map<number, { deps: unknown[]; value: unknown }>();
  let cursor = 0, alive = true;
  let queued: (() => void)[] = [];
  const testHooks = {
    useCallback(value: unknown, deps: unknown[]) {
      const index = cursor++, previous = callbacks.get(index);
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
      callbacks.set(index, { deps, value }); return value;
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value: unknown) => { if (alive) state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; return refs[index] ??= { current: initial }; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, previous = effects.get(index);
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      queued.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: effect() || undefined }); });
    },
  };
  const storage = new Map<string, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const window = Object.assign(new EventTarget(), { location: { hostname },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } },
    setTimeout: (callback: () => void, delay: number) => { const id = setTimeout(callback, delay); timers.add(id); return id; },
    clearTimeout,
  });
  const bundleModule = { exports: {} as { useWallet: () => WalletState; walletSubmissions: Set<unknown> } };
  // No fetch or real provider is supplied.
  runInNewContext(await walletBundle(environment), { module: bundleModule, exports: bundleModule.exports, require: createRequire(import.meta.url), window, Event, CustomEvent, testHooks, console });
  const render = () => { cursor = 0; const value = bundleModule.exports.useWallet(); const work = queued; queued = []; work.forEach((effect) => effect()); return value; };
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); return render(); };
  const unmount = () => { alive = false; effects.forEach((effect) => effect.cleanup?.()); timers.forEach(clearTimeout); };
  const remount = () => { unmount(); state.length = 0; refs.length = 0; effects.clear(); callbacks.clear(); timers.clear(); queued = []; alive = true; return render(); };
  return { render, flush, unmount, remount, window, submissions: bundleModule.exports.walletSubmissions };
}

function providerFixture() {
  const calls: string[] = [], handlers = new Map<string, (value: unknown) => void>();
  let release: (() => void) | undefined;
  const provider = {
    request: async ({ method }: { method: string }) => { calls.push(method); if (method === "eth_requestAccounts" && release === undefined) await new Promise<void>((resolve) => { release = resolve; }); return method === "eth_chainId" ? "0x1237" : ["0x1111111111111111111111111111111111111111"]; },
    on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler); },
    removeListener: (event: string) => { handlers.delete(event); },
  };
  return { option: { info: { uuid: "real", name: "Test wallet" }, provider }, calls, handlers, release: () => release?.() };
}

test("actual wallet hook loads presets without RPC, switches them, then exits with no account", async () => {
  const harness = await mountWallet();
  try {
    assert.equal(harness.render().demoWallets.length, 0, "SSR/initial render has no demos");
    let wallet = await harness.flush();
    assert.equal(wallet.demoWallets.length, 3);
    for (const preset of wallet.demoWallets) {
      assert.equal(wallet.selectDemoWallet(preset.id), true);
      wallet = harness.render();
      assert.equal(wallet.demoWallet?.id, preset.id);
      assert.equal(wallet.account, null); assert.equal(wallet.selected, null); assert.equal(wallet.chainId, null);
    }
    wallet.disconnect(); wallet = harness.render();
    assert.equal(wallet.demoWallet, null); assert.equal(wallet.account, null);
  } finally { harness.unmount(); }
});

test("direct hook activation fails in production/remote dev and production omits fixtures", async () => {
  assert.doesNotMatch(await walletBundle("production"), /A large NVDA holding|0\.123456789012345678/);
  for (const [environment, hostname] of [["production", "localhost"], ["development", "localhost.example.com"], ["development", "192.168.1.10"]]) {
    const harness = await mountWallet(environment, hostname);
    try { harness.render(); const wallet = await harness.flush(); assert.equal(wallet.demoWallets.length, 0); assert.equal(wallet.selectDemoWallet("diversified"), false); assert.equal(harness.render().demoWallet, null); }
    finally { harness.unmount(); }
  }
});

test("pending/late real connection and detached events cannot overwrite a demo session", async () => {
  const harness = await mountWallet(), real = providerFixture();
  try {
    harness.render(); let wallet = await harness.flush();
    const connecting = wallet.connect(real.option);
    wallet = harness.render();
    assert.equal(wallet.selectDemoWallet("diversified"), false, "connection still pending");
    const oldAccounts = real.handlers.get("accountsChanged")!;
    wallet.disconnect(); wallet = harness.render();
    assert.equal(wallet.selectDemoWallet("fractional"), true);
    real.release(); await connecting;
    oldAccounts(["0x2222222222222222222222222222222222222222"]);
    wallet = harness.render();
    assert.equal(wallet.demoWallet?.id, "fractional"); assert.equal(wallet.account, null);
    assert.equal(real.handlers.size, 0); assert.deepEqual(real.calls, ["eth_requestAccounts"]);
    const reconnecting = wallet.connect(real.option); await reconnecting;
    wallet = harness.render();
    assert.equal(wallet.demoWallet, null); assert.equal(wallet.account, "0x1111111111111111111111111111111111111111"); assert.equal(wallet.chainId, 4663);
  } finally { harness.unmount(); }
});

test("demo remains blocked by a submission across wallet-hook remounts", async () => {
  const harness = await mountWallet(), real = providerFixture();
  harness.render(); await harness.flush(); harness.submissions.add(real.option.provider);
  try {
    harness.remount(); let wallet = await harness.flush();
    assert.equal(wallet.selectDemoWallet("diversified"), false);
    harness.submissions.delete(real.option.provider); wallet = harness.render();
    assert.equal(wallet.selectDemoWallet("diversified"), true);
    assert.equal(real.calls.length, 0);
  } finally { harness.submissions.clear(); harness.unmount(); }
});

test("fractional Portfolio action passes its exact amount into the rendered planner", async () => {
  const output = await build({ stdin: { contents: 'export { DemoPortfolio } from "./src/components/demo-portfolio"; export { PositionPlanner } from "./src/components/position-planner";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", loader: { ".css": "empty" } });
  const bundleModule = { exports: {} as {
    DemoPortfolio: typeof import("../src/components/demo-portfolio").DemoPortfolio;
    PositionPlanner: typeof import("../src/components/position-planner").PositionPlanner;
  } };
  let requests = 0;
  runInNewContext(output.outputFiles[0].text, { module: bundleModule, exports: bundleModule.exports, require: createRequire(import.meta.url), fetch: () => { requests++; throw new Error("No address lookup should occur"); } });
  let chosen: { symbol: string; amount?: string } | undefined;
  const portfolio = bundleModule.exports.DemoPortfolio({ wallet: DEMO_WALLETS[2], onPlan: (symbol, amount) => { chosen = { symbol, amount }; } });
  function clickExit(node: ReactNode): boolean {
    if (Array.isArray(node)) return node.some(clickExit);
    if (!isValidElement<{ "aria-label"?: string; onClick?: () => void; children?: ReactNode }>(node)) return false;
    if (node.props["aria-label"] === "Compare exit sizes for NVDA") { node.props.onClick!(); return true; }
    return clickExit(node.props.children);
  }
  assert.equal(clickExit(portfolio), true);
  assert.deepEqual(chosen, { symbol: "NVDA", amount: "0.123456789012345678" });
  const harness = await mountWallet();
  try {
    harness.render(); let wallet = await harness.flush(); wallet.selectDemoWallet("fractional"); wallet = harness.render();
    const html = renderToStaticMarkup(createElement(bundleModule.exports.PositionPlanner, { assets: [], symbol: chosen!.symbol, onSelect: () => {}, wallet, now: 0, registryReady: false, registryError: null, initialAmount: chosen!.amount }));
    assert.match(html, /value="0\.123456789012345678"/);
    assert.match(html, /Use demo holding/);
    assert.doesNotMatch(html, /id="planner-address"|planner-position\?/);
    assert.equal(requests, 0);
  } finally { harness.unmount(); }
});

test("switch account requests account permission and reads the new account without signing", async () => {
  const harness = await mountWallet("production"), real = providerFixture();
  try {
    harness.render(); const connecting = harness.render().connect(real.option); real.release(); await connecting;
    const calls: { method: string; params?: unknown[] }[] = [];
    const next = "0x2222222222222222222222222222222222222222";
    real.option.provider.request = async (request) => { calls.push(request); return request.method === "eth_accounts" ? [next] : []; };
    await harness.render().switchAccount();
    const wallet = harness.render();
    assert.equal(wallet.account, next); assert.equal(wallet.pending, false); assert.equal(wallet.error, "");
    assert.deepEqual(calls.map(call => call.method), ["wallet_requestPermissions", "eth_accounts"]);
    assert.equal(JSON.stringify(calls[0].params), '[{"eth_accounts":{}}]');
  } finally { harness.unmount(); }
});

test("declined or unsupported account changes preserve the current connection", async () => {
  for (const code of [4001, 4200, -32601]) {
    const harness = await mountWallet("production"), real = providerFixture();
    try {
      harness.render(); const connecting = harness.render().connect(real.option); real.release(); await connecting;
      real.option.provider.request = async () => { throw { code }; };
      await harness.render().switchAccount();
      const wallet = harness.render();
      assert.equal(wallet.account, "0x1111111111111111111111111111111111111111");
      assert.equal(wallet.selected?.provider, real.option.provider); assert.equal(wallet.pending, false);
      assert.match(wallet.error, code === 4001 ? /cancelled/ : /wallet extension/);
    } finally { harness.unmount(); }
  }
});

test("late account permission replies cannot reconnect a disconnected wallet", async () => {
  const harness = await mountWallet("production"), real = providerFixture();
  try {
    harness.render(); const connecting = harness.render().connect(real.option); real.release(); await connecting;
    let release!: () => void;
    const calls: string[] = [];
    real.option.provider.request = async ({ method }) => { calls.push(method); await new Promise<void>(resolve => { release = resolve; }); return []; };
    const switching = harness.render().switchAccount();
    assert.equal(harness.render().pending, true);
    harness.render().disconnect(); release(); await switching;
    assert.equal(harness.render().account, null); assert.equal(harness.render().pending, false);
    assert.deepEqual(calls, ["wallet_requestPermissions"]);
  } finally { harness.unmount(); }
});

test("refresh restores the chosen EIP-6963 wallet using authorized accounts, despite a new provider UUID", async () => {
  const harness = await mountWallet("production"), real = providerFixture();
  const first = { ...real.option, info: { ...real.option.info, rdns: "com.example.wallet" } };
  try {
    harness.render(); const connecting = harness.render().connect(first); real.release(); await connecting;
    assert.equal(harness.window.localStorage.getItem("spreadline.wallet.v1"), "rdns:com.example.wallet");
    real.calls.length = 0;
    harness.remount();
    const unrelated = providerFixture();
    harness.window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: unrelated.option }));
    await harness.flush();
    assert.equal(unrelated.calls.length, 0);
    harness.window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { ...first, info: { ...first.info, uuid: "new-page-uuid" } } }));
    await harness.flush(); const wallet = await harness.flush();
    assert.equal(wallet.account, "0x1111111111111111111111111111111111111111");
    assert.equal(wallet.chainId, 4663); assert.equal(wallet.pending, false);
    assert.deepEqual(real.calls, ["eth_accounts", "eth_chainId"]);
    real.handlers.get("accountsChanged")!(["0x2222222222222222222222222222222222222222"]);
    assert.equal(harness.render().account, "0x2222222222222222222222222222222222222222");
    real.handlers.get("chainChanged")!("0x1");
    assert.equal(harness.render().chainId, 1);
  } finally { harness.unmount(); }
});

test("explicit disconnect survives refresh and does not reconnect an announced wallet", async () => {
  const harness = await mountWallet("production"), real = providerFixture();
  try {
    harness.render(); const connecting = harness.render().connect(real.option); real.release(); await connecting;
    harness.render().disconnect(); real.calls.length = 0;
    harness.remount();
    harness.window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: real.option }));
    await harness.flush(); const wallet = await harness.flush();
    assert.equal(wallet.account, null); assert.equal(real.calls.length, 0);
    assert.equal(harness.window.localStorage.getItem("spreadline.wallet.v1"), null);
  } finally { harness.unmount(); }
});

test("locked wallets cannot restore a cached account and delayed restores cannot undo disconnect", async () => {
  const harness = await mountWallet("production"), real = providerFixture();
  try {
    harness.render(); const connecting = harness.render().connect(real.option); real.release(); await connecting;
    real.option.provider.request = async ({ method }) => method === "eth_chainId" ? "0x1237" : [];
    harness.remount();
    harness.window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: real.option }));
    await harness.flush(); let wallet = await harness.flush();
    assert.equal(wallet.account, null); assert.equal(wallet.error, ""); assert.equal(wallet.pending, false);
    let release!: (value: string[]) => void;
    real.option.provider.request = async ({ method }) => method === "eth_chainId" ? "0x1237" : await new Promise<string[]>(resolve => { release = resolve; });
    harness.remount();
    harness.window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: real.option }));
    await harness.flush();
    harness.render().disconnect(); release(["0x1111111111111111111111111111111111111111"]);
    wallet = await harness.flush();
    assert.equal(wallet.account, null); assert.equal(wallet.selected, null); assert.equal(wallet.pending, false);
    assert.equal(real.handlers.size, 0);
  } finally { harness.unmount(); }
});
