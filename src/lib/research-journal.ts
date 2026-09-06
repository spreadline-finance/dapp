"use client";
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import type { QuoteBook } from "./market-types";

export type ResearchObservation = {
  id: string;
  checkedAt: string;
  symbol: string;
  amount: string;
  quote?: QuoteBook;
  error?: string;
  assumedCost: number | null;
};
const KEY = "spreadline.research.v1";
const numeric = z.string().regex(/^-?\d+(\.\d+)?$/).max(100).refine((value) => Number.isFinite(Number(value)));
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const quoteSchema = z.object({
  symbol: z.string().max(20), amountIn: numeric, settlementDecimals: z.number().int().min(0).max(36),
  blockNumber: z.string().regex(/^\d+$/), blockTimestamp: timestamp, blockHash: z.string().max(100),
  fetchedAt: timestamp, expiresAt: timestamp, executionEnabled: z.literal(false),
  attempted: z.number().int().min(0).max(12), failed: z.number().int().min(0).max(12),
  routes: z.array(z.object({ buyFee: z.number(), sellFee: z.number(), buyPool: address, sellPool: address,
    amountOut: numeric, surplus: numeric, gasUnits: numeric, crossedTicks: z.array(z.number()).max(2) })).max(12),
  coverage: z.object({ venue: z.literal("Uniswap V3"), feeTiers: z.array(z.number()).max(4), discoveredPools: z.number(), activePools: z.number() }).optional(),
  availability: z.enum(["quoted", "no_pools", "one_active_pool", "no_active_pools", "simulations_failed"]).optional(),
});
const recordSchema = z.object({ id: z.string().max(120), checkedAt: timestamp, symbol: z.string().regex(/^[A-Z0-9.\-]{1,20}$/),
  amount: numeric, quote: quoteSchema.optional(), error: z.string().max(500).optional(), assumedCost: z.number().min(0).max(100000).nullable() });
export function parseJournal(value: unknown): ResearchObservation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const parsed = recordSchema.safeParse(item);
    if (!parsed.success) return [];
    const r = parsed.data;
    if (r.quote && (r.symbol !== r.quote.symbol || Number(r.amount) !== Number(r.quote.amountIn))) return [];
    return r.quote || r.error ? [r] : [];
  });
}
export function mergeObservations(...sources: ResearchObservation[][]): ResearchObservation[] {
  const seenIds = new Set<string>();
  const seenQuotes = new Set<string>();
  return sources.flat().sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt)).filter((record) => {
    const key = record.quote ? `${record.symbol}:${Number(record.amount)}:${record.quote.blockHash}` : null;
    if (seenIds.has(record.id) || (key && seenQuotes.has(key))) return false;
    seenIds.add(record.id);
    if (key) seenQuotes.add(key);
    return true;
  }).slice(0, 100);
}
const serverSnapshot = { records: [] as ResearchObservation[], storageMessage: "", hydrated: false };
let snapshot = serverSnapshot;
const listeners = new Set<() => void>();
function notify() { listeners.forEach((listener) => listener()); }
function onStorage(event: StorageEvent) {
  if (event.key !== KEY) return;
  try {
    snapshot = { ...snapshot, records: event.newValue ? mergeObservations(parseJournal(JSON.parse(event.newValue)), snapshot.records) : [] };
    notify();
  } catch { /* A malformed external write must not replace valid observations. */ }
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("storage", onStorage); };
}
function hydrate() {
  if (snapshot.hydrated) return;
  try {
    const raw = localStorage.getItem(KEY);
    snapshot = { records: raw ? parseJournal(JSON.parse(raw)) : [], storageMessage: "", hydrated: true };
  } catch { snapshot = { records: [], storageMessage: "Browser storage is unavailable. Export observations to keep them.", hydrated: true }; }
  notify();
}
export function saveObservation(record: ResearchObservation) {
  hydrate();
  const validated = parseJournal([record]);
  if (!validated.length) return;
  let stored: ResearchObservation[] = [];
  try { stored = parseJournal(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { /* Preserve in-memory observations when storage is unavailable. */ }
  // Merge other tabs, and count an identical pinned quote only once.
  const records = mergeObservations(validated, snapshot.records, stored);
  snapshot = { ...snapshot, records };
  try { localStorage.setItem(KEY, JSON.stringify(records)); }
  catch { snapshot = { ...snapshot, storageMessage: "Could not save in this browser. Export observations to keep them." }; }
  notify();
}
export function useResearchJournal() {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => serverSnapshot);
  useEffect(hydrate, []);
  return value;
}
export function exportJournal(records: ResearchObservation[]) {
  const data = { kind: "Spreadline quote observations — no executed trades", exportedAt: new Date().toISOString(),
    limitations: "Four Uniswap V3 fee tiers and USDG pairs only. Quotes expire. Pool fees and price impact are included; full execution costs are unknown. Assumed costs are scenarios. Observations must not be summed as earnings.", records };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `spreadline-research-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
