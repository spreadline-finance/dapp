"use client";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { planMatches, type TradePlan, type TradeSide } from "./trading";
import type { Hex } from "viem";
import { walletSubmissions as sending } from "./wallet-submission";

export type TransactionRecord = { hash: Hex; account: string; symbol: string; side: TradeSide; amount: string; kind: "approval" | "swap"; status: "submitted" | "unresolved" | "confirmed" | "reverted"; submittedAt: string; blockNumber?: string };
type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
const KEY = "spreadline.transactions.v1";
const schema = z.object({ hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), account: z.string().regex(/^0x[a-fA-F0-9]{40}$/), symbol: z.string().max(20), side: z.enum(["buy", "sell"]), amount: z.string().max(40), kind: z.enum(["approval", "swap"]), status: z.enum(["submitted", "unresolved", "confirmed", "reverted"]), submittedAt: z.string().datetime(), blockNumber: z.string().regex(/^\d+$/).optional() });
const initial: { records: TransactionRecord[]; storageError: boolean } = { records: [], storageError: false };
let state = initial, hydrated = false;
const listeners = new Set<() => void>();
function emit() { listeners.forEach((listener) => listener()); }
function parse(value: unknown): TransactionRecord[] {
  return Array.isArray(value) ? value.slice(0, 30).flatMap((item) => { const r = schema.safeParse(item); return r.success ? [{ ...r.data, hash: r.data.hash as Hex }] : []; }) : [];
}
function readStored() { return parse(JSON.parse(localStorage.getItem(KEY) ?? "[]")); }
function hydrate() { if (hydrated) return; hydrated = true; try { state = { records: readStored(), storageError: false }; } catch { state = { records: [], storageError: true }; } emit(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function recordTransaction(record: TransactionRecord) {
  hydrate();
  let stored: TransactionRecord[] = [];
  try { stored = readStored(); } catch { /* Keep in memory if browser storage is blocked. */ }
  const merged = new Map<string, TransactionRecord>();
  [...stored, ...state.records, record].forEach((item) => {
    const current = merged.get(item.hash);
    if (!current || ((current.status === "submitted" || current.status === "unresolved") && (current.status === "submitted" || item.status !== "submitted"))) merged.set(item.hash, item);
  });
  const records = [...merged.values()].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)).slice(0, 30);
  state = { records, storageError: false };
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { state = { ...state, storageError: true }; }
  emit();
}
export function useTransactionLog() { const snapshot = useSyncExternalStore(subscribe, () => state, () => initial); useEffect(hydrate, []); return snapshot; }
export async function sendPreparedTrade(provider: Provider, plan: TradePlan, expected: Parameters<typeof planMatches>[1], clock = Date.now) {
  if (sending.has(provider)) throw new Error("A transaction is already awaiting this wallet. Complete that request first.");
  sending.add(provider);
  try {
  if (!planMatches(plan, expected, clock())) throw new Error("The trade details changed or expired. Prepare a fresh trade.");
  const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
  if (typeof chain !== "string" || Number.parseInt(chain, 16) !== 4663 || !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== expected.account.toLowerCase()) throw new Error("The wallet account or chain changed. Prepare a fresh trade.");
  if (!planMatches(plan, expected, clock())) throw new Error("The preview expired while checking your wallet. Refresh it.");
  const { from, to, data, value, gas } = plan.transaction!;
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data, value, gas, chainId: "0x1237" }] });
  if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("No transaction hash was returned. Check your wallet before trying again.");
  return hash as Hex;
  } finally { sending.delete(provider); }
}
export async function readReceipt<T extends { hash: Hex; account: string; to?: string }>(provider: Provider, record: T) {
  const chain = await provider.request({ method: "eth_chainId" });
  if (typeof chain !== "string" || Number.parseInt(chain, 16) !== 4663) throw new Error("Switch to Robinhood Chain to check this transaction.");
  const raw = await provider.request({ method: "eth_getTransactionReceipt", params: [record.hash] });
  if (!raw) return null;
  const receipt = z.object({ transactionHash: z.string(), from: z.string(), to: z.string().nullable().optional(), status: z.enum(["0x0", "0x1"]), blockNumber: z.string().regex(/^0x[0-9a-f]+$/i) }).parse(raw);
  if (receipt.transactionHash.toLowerCase() !== record.hash.toLowerCase() || receipt.from.toLowerCase() !== record.account.toLowerCase() || record.to && receipt.to?.toLowerCase() !== record.to.toLowerCase()) throw new Error("The transaction receipt did not match this record.");
  return { ...record, status: receipt.status === "0x1" ? "confirmed" as const : "reverted" as const, blockNumber: String(BigInt(receipt.blockNumber)) };
}
