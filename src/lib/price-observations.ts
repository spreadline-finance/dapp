import { useCallback, useSyncExternalStore } from "react";
import type { PriceBook, StockAsset } from "./market-types";
import { appendObservation, type PriceObservation } from "./chart-data";

// A bounded, tab-local record of actual issuer observations. No historical feed
// or persistence is implied, and no wallet data is recorded here.
const records = new Map<string, readonly PriceObservation[]>();
const listeners = new Set<() => void>();
const empty: readonly PriceObservation[] = [];
function subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
export function recordPrices(book: PriceBook, assets: StockAsset[]) {
  let changed = false;
  for (const quote of book.quotes) {
    const asset = assets.find((a) => a.symbol === quote.symbol);
    if (!asset) continue;
    const before = records.get(quote.symbol) ?? empty;
    const after = appendObservation(before, quote, asset.multiplier);
    if (before !== after) { records.set(quote.symbol, after); changed = true; }
  }
  while (records.size > 200) { records.delete(records.keys().next().value!); changed = true; }
  if (changed) listeners.forEach((listener) => listener());
}
export function usePriceObservations(symbol: string) {
  return useSyncExternalStore(subscribe, useCallback(() => records.get(symbol) ?? empty, [symbol]), () => empty);
}
