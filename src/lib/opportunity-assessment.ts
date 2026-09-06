import type { QuoteBook } from "./market-types";

export function parseAssumedCost(input: string): number | null {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(input)) return null;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 && value <= 100000 ? value : null;
}
export function assessQuote(quote: QuoteBook, assumedCost: number | null, now: number) {
  const best = quote.routes.reduce<QuoteBook["routes"][number] | undefined>((current, route) =>
    !current || Number(route.surplus) > Number(current.surplus) ? route : current, undefined);
  const incomplete = quote.failed > 0;
  const expired = !Number.isFinite(Date.parse(quote.expiresAt)) || now >= Date.parse(quote.expiresAt);
  const difference = best ? Number(best.surplus) : null;
  const cost = assumedCost !== null && Number.isFinite(assumedCost) && assumedCost >= 0 ? assumedCost : null;
  const scenario = difference !== null && cost !== null ? difference - cost : null;
  const headline = !best
    ? quote.availability === "no_pools" ? "No supported pools found."
      : quote.availability === "one_active_pool" ? "This needs a second active pool."
        : quote.availability === "no_active_pools" ? "The supported pools have no active liquidity."
          : "There is not enough data for a result."
    : incomplete ? "The route comparison is incomplete."
      : difference! < 0 ? "This round trip loses before execution costs."
        : difference === 0 ? "This quote breaks even before execution costs."
        : scenario !== null && scenario <= 0 ? "The assumed costs use up the price difference."
          : "Positive quote. Profit is still unproven.";
  return { best, incomplete, expired, difference, scenario, headline,
    kind: !best ? "missing" : incomplete ? "incomplete" : difference! < 0 ? "negative" : difference === 0 ? "break_even" : "candidate",
    extraCostBudget: difference !== null ? Math.max(0, difference) : null } as const;
}
