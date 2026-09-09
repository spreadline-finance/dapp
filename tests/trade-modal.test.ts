import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { CHAIN_ID, SWAP_ROUTER, USDG, type StockAsset } from "../src/lib/market-types";
import { approvalCall, minimumOutput, swapCall, type SwapQuote, type TradePlan } from "../src/lib/trading";
import type { TransactionRecord } from "../src/lib/transactions";
import type { WalletState } from "../src/components/wallet";
import type { TradeModal } from "../src/components/trade-modal";

type ModalProps = Parameters<typeof TradeModal>[0];
type Element = ReactElement<Record<string, unknown>>;
const clockStart = Date.parse("2026-09-09T16:00:00Z");
const account = `0x${"1".repeat(40)}` as Address;
const secondAccount = `0x${"2".repeat(40)}` as Address;
const asset: StockAsset = { symbol: "NVDA", name: "NVIDIA", address: `0x${"3".repeat(40)}`, decimals: 18, multiplier: "1", logo: null, active: true };
const approvalHash = `0x${"a".repeat(64)}` as Hex;
const swapHash = `0x${"b".repeat(64)}` as Hex;

function quoteFixture(params = new URLSearchParams(), now = clockStart): SwapQuote {
  const side = params.get("side") === "sell" ? "sell" : "buy";
  const amount = params.get("amount") ?? "100";
  const inputDecimals = side === "buy" ? 6 : 18, outputDecimals = side === "buy" ? 18 : 6;
  const output = side === "buy" ? 10n ** 18n : 100000000n;
  const slippageBps = Number(params.get("slippageBps") ?? 50), minimum = minimumOutput(output, slippageBps);
  return { symbol: asset.symbol, side, amountIn: amount, amountInRaw: String(parseUnits(amount, inputDecimals)),
    tokenIn: side === "buy" ? USDG : asset.address, tokenOut: side === "buy" ? asset.address : USDG, inputDecimals, outputDecimals,
    blockNumber: "100", blockTimestamp: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 20000).toISOString(),
    slippageBps, attempted: 1, failed: 0,
    routes: [{ fee: 500, pool: `0x${"4".repeat(40)}`, amountOut: formatUnits(output, outputDecimals), amountOutRaw: String(output), minimumOut: formatUnits(minimum, outputDecimals), minimumOutRaw: String(minimum), priceUSDG: 100 }] };
}
function planFixture(params: URLSearchParams, status: "approval_required" | "ready", now: number): TradePlan {
  const quote = quoteFixture(params, now), trader = params.get("address") as Address, deadline = now / 1000 + 120;
  return { quote, account: trader, chainId: CHAIN_ID, inputBalance: "10000", nativeBalance: "1", allowance: status === "ready" ? "10000" : "0",
    status, expiresAt: quote.expiresAt, deadline: status === "ready" ? deadline : undefined, gasEstimateETH: "0.0001",
    transaction: { from: trader, to: status === "ready" ? SWAP_ROUTER : quote.tokenIn,
      data: status === "ready" ? swapCall(quote, trader, deadline) : approvalCall(quote), value: "0x0", gas: "0x493e0" } };
}

let compiled: Promise<string> | undefined;
function modalBundle() {
  return compiled ??= build({ stdin: { contents: 'export { TradeModal, __TestTradeFlow } from "./src/components/trade-modal"; export { recordTransaction } from "./src/lib/transactions";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "trade-modal-component-harness", setup(builder) {
      builder.onResolve({ filter: /^react$/ }, (args) => /\/(components\/trade-modal\.tsx|lib\/transactions\.ts)$/.test(args.importer) ? { path: "hooks", namespace: "test" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const { useState, useRef, useEffect, useSyncExternalStore } = globalThis.testHooks;", loader: "js" }));
      // Expose the real private session only inside this compiled test bundle.
      builder.onLoad({ filter: /\/src\/components\/trade-modal\.tsx$/ }, async (args) => ({ contents: `${await readFile(args.path, "utf8")}\nexport { TradeFlow as __TestTradeFlow };`, loader: "tsx", resolveDir: `${process.cwd()}/src/components` }));
    } }] }).then((output) => output.outputFiles[0].text);
}

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? nodeText(node.props.children) : "";
}

// Only React's render bookkeeping is simulated. The actual modal, quote/plan
// validators, API client, wallet sender, receipt reader, and transaction log run.
async function mountModal(options: { connected?: boolean; amount?: string; slippage?: number; approval?: boolean; initialQuote?: SwapQuote } = {}) {
  let active: ReturnType<typeof instance> | undefined;
  let now = clockStart, nextPlanApproval = !!options.approval, confirmed = false;
  let delayedHash: Promise<Hex> | undefined;
  let flow: ReturnType<typeof instance> | undefined, flowKey: string | null | undefined;
  let modalTree: ReactNode, flowTree: ReactNode, flowProps: Record<string, unknown> = {};
  const storage = new Map<string, string>(), timers = new Map<number, () => void>();
  const requests: URL[] = [], sends: unknown[] = [], methodCalls: string[] = [];
  let timerId = 0;
  function instance() {
    const values: unknown[] = [];
    const effects = new Map<number, { deps?: unknown[]; cleanup?: () => void }>();
    let cursor = 0, alive = true, dirty = false;
    let queued: (() => void)[] = [];
    const runner = {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
        return [values[index], (value: unknown) => { if (!alive) return; const next = typeof value === "function" ? value(values[index]) : value; if (!Object.is(values[index], next)) { values[index] = next; dirty = true; } }];
      },
      useRef(initial: unknown) { const index = cursor++; return values[index] ??= { current: initial }; },
      useEffect(effect: () => void | (() => void), deps?: unknown[]) {
        const index = cursor++, previous = effects.get(index);
        if (deps && previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
        queued.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: effect() || undefined }); });
      },
      render(component: () => ReactNode) {
        let tree: ReactNode;
        for (let pass = 0; pass < 8; pass++) {
          dirty = false; cursor = 0; active = runner; tree = component(); active = undefined;
          const work = queued; queued = []; work.forEach((effect) => effect());
          if (!dirty) return tree;
        }
        throw new Error("Modal render did not settle.");
      },
      unmount() { alive = false; effects.forEach((effect) => effect.cleanup?.()); },
    };
    return runner;
  }
  const testHooks = {
    useState: (initial: unknown) => active!.useState(initial),
    useRef: (initial: unknown) => active!.useRef(initial),
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => active!.useEffect(effect, deps),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
  const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    methodCalls.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_accounts") return [props.wallet.account];
    if (method === "eth_sendTransaction") { sends.push(params?.[0]); return delayedHash ?? (sends.length === 1 && options.approval ? approvalHash : swapHash); }
    if (method === "eth_getTransactionReceipt") return confirmed ? { transactionHash: params?.[0], from: account, status: "0x1", blockNumber: "0x101" } : null;
    throw new Error(`Unexpected mock wallet request: ${method}`);
  } };
  const connectedWallet = (trader = account): WalletState => ({ wallets: [], selected: { info: { uuid: "test-provider", name: "Test wallet" }, provider }, account: trader, chainId: CHAIN_ID,
    demoWallets: [], demoWallet: null, selectDemoWallet: () => false, error: "", pending: false, connect: async () => {}, switchNetwork: async () => {}, switchAccount: async () => {}, disconnect: () => {} });
  let props: ModalProps = { asset, now, wallet: options.connected === false ? { ...connectedWallet(), account: null, selected: null, chainId: null } : connectedWallet(), open: true,
    side: "buy", amount: options.amount ?? "100", slippage: options.slippage ?? 50, initialQuote: options.initialQuote,
    onOpenChange: (open) => { props = { ...props, open }; }, onDraftChange: (draft) => { props = { ...props, ...draft }; } };
  const bundleModule = { exports: {} as { TradeModal: typeof TradeModal; __TestTradeFlow: (props: Record<string, unknown>) => ReactNode; recordTransaction: (record: TransactionRecord) => void } };
  const timeout = (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; };
  class ClockDate extends Date { constructor(value?: string | number) { super(value ?? now); } static now() { return now; } }
  let quoteFailure = 0;
  runInNewContext(await modalBundle(), { module: bundleModule, exports: bundleModule.exports, require: createRequire(import.meta.url), testHooks, console,
    Date: ClockDate, URLSearchParams, AbortController, DOMException, Response, Headers,
    setTimeout: timeout, clearTimeout: (id: number) => timers.delete(id),
    window: { setTimeout: timeout, clearTimeout: (id: number) => timers.delete(id) }, document: { getElementById: () => null },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: async (input: string) => {
      const url = new URL(input, "https://spreadline.test"); requests.push(url);
      if (url.pathname === "/api/swap-quote") return Response.json({ ...quoteFixture(url.searchParams, now), failed: quoteFailure });
      if (url.pathname === "/api/trade-plan") return Response.json(planFixture(url.searchParams, nextPlanApproval ? "approval_required" : "ready", now));
      throw new Error(`Unexpected mock API: ${url.pathname}`);
    },
  });
  const wrapper = instance();
  function render() {
    props = { ...props, now };
    modalTree = wrapper.render(() => bundleModule.exports.TradeModal(props));
    const child = elements(modalTree).find((node) => node.type === bundleModule.exports.__TestTradeFlow);
    assert.ok(child, "actual wrapper renders the wallet-keyed trade session");
    if (!flow || flowKey !== child.key) { flow?.unmount(); flow = instance(); flowKey = child.key; }
    flowProps = child.props;
    flowTree = flow.render(() => bundleModule.exports.__TestTradeFlow(flowProps));
    return flowTree;
  }
  const flush = async () => { for (let pass = 0; pass < 5; pass++) { await new Promise<void>((resolve) => setImmediate(resolve)); render(); } };
  const buttons = (label: RegExp) => elements(flowTree).filter((node) => node.type === "button" && label.test(nodeText(node)));
  const click = async (label: RegExp) => { const button = buttons(label)[0]; assert.ok(button, `Button ${label} exists. Rendered: ${nodeText(flowTree)}`); assert.ok(!button.props.disabled, `Button ${label} is enabled`); (button.props.onClick as () => void)(); await flush(); };
  const review = async () => { const checkbox = elements(flowTree).find((node) => node.type === "input" && node.props.type === "checkbox"); assert.ok(checkbox); assert.ok(!checkbox.props.disabled); (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } }); await flush(); };
  render();
  return { render, flush, click, review, buttons, requests, sends, methodCalls,
    text: () => nodeText(flowTree), flowProps: () => flowProps,
    wallet: (trader: Address) => { props = { ...props, wallet: connectedWallet(trader) }; render(); },
    demo: () => { props = { ...props, wallet: { ...connectedWallet(), account: null, selected: null, chainId: null, demoWallet: { id: "test-demo", name: "Demo", description: "Synthetic test", balances: {} } } }; render(); },
    advance: (milliseconds: number) => { now += milliseconds; render(); },
    partialQuote: () => { quoteFailure = 1; },
    approveConfirmed: () => { confirmed = true; nextPlanApproval = false; },
    holdWallet: (hash: Promise<Hex>) => { delayedHash = hash; },
    addRecord: (record: TransactionRecord) => { bundleModule.exports.recordTransaction(record); render(); },
    records: () => JSON.parse(storage.get("spreadline.transactions.v1") ?? "[]") as TransactionRecord[],
    close: () => { const root = elements(modalTree)[0]; (root.props.onOpenChange as (open: boolean) => void)(false); render(); return props.open; },
    unmount: () => { flow?.unmount(); wrapper.unmount(); timers.clear(); },
  };
}

test("trade modal retains the exact draft and public quote across wallet connection while discarding account-bound plans", async () => {
  const h = await mountModal({ connected: false, amount: "125.123456", slippage: 100 });
  try {
    await h.click(/^Get quote$/);
    assert.match(h.text(), /Review your quote/);
    h.wallet(account); await h.flush();
    assert.match(h.text(), /Review your quote/);
    assert.equal(h.flowProps().amount, "125.123456"); assert.equal(h.flowProps().slippage, 100);
    assert.equal(h.requests.filter((url) => url.pathname === "/api/swap-quote").length, 1);
    await h.click(/^Prepare trade$/);
    assert.match(h.text(), /Confirm your trade/);
    h.wallet(secondAccount); await h.flush();
    assert.match(h.text(), /Review your quote/);
    assert.equal(h.buttons(/^Confirm swap in wallet$/).length, 0);
    assert.equal(h.flowProps().amount, "125.123456");
    assert.equal(h.requests.filter((url) => url.pathname === "/api/trade-plan").length, 1, "account change does not prepare or sign automatically");
    assert.equal(h.sends.length, 0);
  } finally { h.unmount(); }
});

test("opening from a fresh matching card quote starts at Review while expired or mismatched quotes start at Amount", async () => {
  for (const kind of ["fresh", "expired", "mismatched"] as const) {
    const initialQuote = quoteFixture();
    if (kind === "expired") initialQuote.expiresAt = new Date(clockStart - 1).toISOString();
    if (kind === "mismatched") initialQuote.slippageBps = 100;
    const h = await mountModal({ initialQuote });
    try {
      assert.equal(/Review your quote/.test(h.text()), kind === "fresh", kind);
      assert.equal(h.buttons(/^Prepare trade$/).length, kind === "fresh" ? 1 : 0, kind);
      assert.equal(h.requests.length, 0, "opening the dialog never silently fetches or prepares a trade");
      assert.equal(h.sends.length, 0);
    } finally { h.unmount(); }
  }
});

test("confirmed approval requires a fresh plan and a separate reviewed swap submission", async () => {
  const h = await mountModal({ approval: true });
  try {
    await h.click(/^Get quote$/); await h.click(/^Prepare trade$/);
    assert.equal(h.buttons(/^Approve USDG in wallet$/)[0]?.props.disabled, true);
    await h.review(); await h.click(/^Approve USDG in wallet$/);
    assert.equal(h.sends.length, 1); assert.equal(h.records()[0].kind, "approval");
    h.approveConfirmed(); await h.click(/^Check confirmation$/);
    assert.equal(h.records()[0].status, "confirmed");
    assert.equal(h.sends.length, 1, "receipt confirmation never auto-submits a swap");
    assert.equal(h.requests.length, 2, "receipt confirmation does not reuse or silently refresh the plan");
    await h.click(/^Prepare swap$/);
    assert.equal(h.requests.filter((url) => url.pathname === "/api/trade-plan").length, 2);
    assert.equal(h.sends.length, 1);
    assert.equal(h.buttons(/^Confirm swap in wallet$/)[0]?.props.disabled, true, "fresh plan needs its own consent");
    await h.review(); await h.click(/^Confirm swap in wallet$/);
    assert.equal(h.sends.length, 2);
    assert.ok(h.records().some((record) => record.kind === "swap" && record.status === "submitted"));
  } finally { h.unmount(); }
});

test("expired plans, partial quotes, pending transactions and demos cannot request wallet signing", async () => {
  for (const kind of ["expired", "partial", "pending", "demo"] as const) {
    const h = await mountModal();
    try {
      if (kind === "partial") h.partialQuote();
      if (kind === "demo") h.demo();
      if (kind === "pending") h.addRecord({ hash: swapHash, account, symbol: asset.symbol, side: "buy", amount: "100", kind: "swap", status: "submitted", submittedAt: new Date(clockStart).toISOString() });
      if (kind !== "pending") await h.click(/^Get quote$/);
      if (kind === "expired") { await h.click(/^Prepare trade$/); await h.review(); h.advance(20001); }
      assert.ok(h.buttons(/^(Approve .+ in wallet|Confirm swap in wallet)$/).every((button) => button.props.disabled), kind);
      if (kind !== "expired") assert.ok(h.buttons(/^Prepare trade$/).every((button) => button.props.disabled), kind);
      assert.equal(h.methodCalls.includes("eth_sendTransaction"), false, kind);
      assert.equal(h.requests.filter((url) => url.pathname === "/api/trade-plan").length, kind === "expired" ? 1 : 0, kind);
    } finally { h.unmount(); }
  }
});

test("a wallet hash returned after modal unmount is durably recorded for the captured account", async () => {
  const h = await mountModal();
  let release!: (hash: Hex) => void;
  const delayed = new Promise<Hex>((resolve) => { release = resolve; });
  try {
    await h.click(/^Get quote$/); await h.click(/^Prepare trade$/); await h.review();
    h.holdWallet(delayed);
    await h.click(/^Confirm swap in wallet$/);
    assert.equal(h.sends.length, 1); assert.equal(h.records().length, 0);
    assert.equal(h.close(), true, "dialog cannot close during the wallet request");
    h.unmount(); release(swapHash);
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.records().length, 1);
    assert.deepEqual({ hash: h.records()[0].hash, account: h.records()[0].account, amount: h.records()[0].amount, status: h.records()[0].status },
      { hash: swapHash, account, amount: "100", status: "submitted" });
  } finally { release?.(swapHash); h.unmount(); }
});
