import type { QuoteBook, RouteQuote } from "./market-types";

export const ARBITRAGE_INTERVAL = 15000;
export const ROUTE_FEES = [100, 500, 3000, 10000] as const;
export const routeKey = (route: RouteQuote) => `${route.buyPool.toLowerCase()}:${route.sellPool.toLowerCase()}`;
export function rankedRoutes(quote?: QuoteBook) {
  return [...(quote?.routes ?? [])].filter((route) => Number.isFinite(Number(route.surplus)) && Number.isFinite(Number(route.amountOut)))
    .sort((a, b) => Number(b.surplus) - Number(a.surplus));
}
export function quoteMatchesSelection(quote: QuoteBook, symbol: string, amount: string) {
  return quote.symbol === symbol && Number(quote.amountIn) === Number(amount) && Number(amount) > 0 && quote.executionEnabled === false;
}
export function quoteLife(quote: QuoteBook | undefined, now: number) {
  if (!quote) return { fresh: false, remaining: 0, fraction: 0 };
  const end = Date.parse(quote.expiresAt), start = Date.parse(quote.blockTimestamp);
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start && now >= start;
  const remaining = valid ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
  return { fresh: remaining > 0, remaining, fraction: valid ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0 };
}
export function monitorRetryDelay(failures: number) { return Math.min(300000, ARBITRAGE_INTERVAL * 2 ** Math.min(5, Math.max(1, failures))); }
export type QuoteSample = { id: string; time: number; block: string; value: number | null; partial: boolean };
export function quoteSamples(quotes: readonly QuoteBook[], symbol: string, amount: string): QuoteSample[] {
  const unique = new Map<string, QuoteBook>();
  for (const quote of quotes) {
    if (quoteMatchesSelection(quote, symbol, amount) && Number.isFinite(Date.parse(quote.blockTimestamp)) && !unique.has(quote.blockHash)) unique.set(quote.blockHash, quote);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.blockTimestamp) - Date.parse(b.blockTimestamp)).slice(-40).map((quote) => ({
    id: quote.blockHash, time: Date.parse(quote.blockTimestamp), block: quote.blockNumber,
    value: quote.failed ? null : rankedRoutes(quote)[0] ? Number(rankedRoutes(quote)[0].surplus) : null,
    partial: quote.failed > 0,
  }));
}
export function sampleSegments(samples: QuoteSample[]) {
  const segments: QuoteSample[][] = [];
  for (const point of samples) {
    if (point.value === null) { if (segments.at(-1)?.length) segments.push([]); continue; }
    // A missing refresh is a gap, never invented continuous observations.
    const previous = segments.at(-1)?.at(-1);
    if (!segments.length || (previous && point.time - previous.time > ARBITRAGE_INTERVAL * 3)) segments.push([]);
    segments.at(-1)!.push(point);
  }
  return segments.filter((segment) => segment.length);
}
