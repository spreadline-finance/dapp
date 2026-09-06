"use client";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import type { Hex } from "viem";
import { lendingPlanMatches, type ExpectedLending, type LendingPlan } from "./lending-execution";
import { walletSubmissions, type WalletProvider } from "./wallet-submission";

const address = z.string().regex(/^0x[\da-f]{40}$/i);
const schema = z.object({ id: z.string().min(1).max(80), hash: z.string().regex(/^0x[\da-f]{64}$/i).optional(), account: address, to: address, target: z.string().regex(/^0x([\da-f]{40}|[\da-f]{64})$/i), targetKind: z.enum(["market", "vault"]), label: z.string().max(180), symbol: z.string().max(40), amount: z.string().max(80), kind: z.enum(["approval", "authorization", "deposit", "withdraw"]), status: z.enum(["awaiting_wallet", "submitted", "unresolved", "confirmed", "reverted", "cancelled"]), submittedAt: z.string().datetime(), blockNumber: z.string().regex(/^\d+$/).optional() });
export type LendingTransaction = Omit<z.infer<typeof schema>, "hash"> & { hash?: Hex };
const KEY = "spreadline.lending.transactions.v1";
const initial: { records: LendingTransaction[]; storageError: boolean } = { records: [], storageError: false };
let state = initial, hydrated = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
function parse(value: unknown): LendingTransaction[] { return Array.isArray(value) ? value.slice(0, 50).flatMap((v) => { const p = schema.safeParse(v); return p.success ? [{ ...p.data, hash: p.data.hash as Hex | undefined }] : []; }) : []; }
const readStored = () => parse(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
function hydrate() { if (hydrated) return; hydrated = true; try { state = { records: readStored(), storageError: false }; } catch { state = { records: [], storageError: true }; } emit(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function recordLendingTransaction(record: LendingTransaction) {
  hydrate();
  let stored: LendingTransaction[] = [];
  try { stored = readStored(); } catch { /* Memory still preserves the record for this session. */ }
  const merged = new Map<string, LendingTransaction>();
  for (const item of [...stored, ...state.records, record]) {
    const old = merged.get(item.id);
    if (!old || !["confirmed", "reverted", "cancelled"].includes(old.status)) merged.set(item.id, item);
  }
  const records = [...merged.values()].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)).slice(0, 50);
  state = { records, storageError: false };
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { state = { ...state, storageError: true }; }
  emit();
}
export function useLendingTransactions() { const snapshot = useSyncExternalStore(subscribe, () => state, () => initial); useEffect(hydrate, []); return snapshot; }
export const lendingPending = (t: LendingTransaction) => t.status === "submitted" || t.status === "awaiting_wallet";
export async function sendPreparedLending(provider: WalletProvider, plan: LendingPlan, expected: ExpectedLending, onWalletRequest: () => void, clock = Date.now) {
  if (walletSubmissions.has(provider)) throw new Error("A transaction is already awaiting this wallet. Complete that request first.");
  walletSubmissions.add(provider);
  try {
    if (!lendingPlanMatches(plan, expected, clock())) throw new Error("The lending details changed or expired. Prepare a fresh preview.");
    const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    if (typeof chain !== "string" || !/^0x[\da-f]+$/i.test(chain) || Number.parseInt(chain, 16) !== 4663 || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== expected.account.toLowerCase()) throw new Error("The wallet account or network changed. Prepare a fresh preview.");
    if (!lendingPlanMatches(plan, expected, clock())) throw new Error("The preview expired while checking your wallet. Refresh it.");
    const { from, to, data, value, gas } = plan.transaction!;
    onWalletRequest(); // Keep a local hold even if navigation happens before the wallet responds.
    const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data, value, gas, chainId: "0x1237" }] });
    if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("No transaction hash was returned. Check your wallet before trying again.");
    return hash as Hex;
  } finally { walletSubmissions.delete(provider); }
}
