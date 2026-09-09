import type { PriceBook } from "./market-types";

export const LIVE_QUERY_DEFAULTS = {
  retry: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  gcTime: 30 * 60 * 1000,
  refetchIntervalInBackground: false,
} as const;

export function workspaceReads(view: string) {
  return {
    registry: !["rewards", "learn", "activity", "infrastructure"].includes(view),
    network: ["terminal", "markets", "infrastructure"].includes(view),
    prices: view === "terminal" || view === "markets",
    priceInterval: view === "terminal" ? 15000 : 60000,
  };
}

export function sourceIsCurrent(timestamp: string | null | undefined, now: number, maxAge: number) {
  if (!timestamp || !Number.isFinite(now) || now <= 0) return false;
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -10000 && age <= maxAge;
}

/** Retain a failed symbol's actual observation; never turn it into a new tick. */
export function preservePriceObservations(previous: PriceBook | undefined, next: PriceBook): PriceBook {
  if (!previous || !next.unavailableSymbols?.length) return next;
  const retained = previous.quotes.filter((quote) => next.unavailableSymbols!.includes(quote.symbol) && !next.quotes.some((current) => current.symbol === quote.symbol));
  if (!retained.length) return next;
  return {
    ...next,
    quotes: [...next.quotes, ...retained],
    cachedSymbols: [...new Set([...(next.cachedSymbols ?? []), ...retained.map((quote) => quote.symbol)])],
    fetchedAt: Date.parse(previous.fetchedAt) < Date.parse(next.fetchedAt) ? previous.fetchedAt : next.fetchedAt,
  };
}
