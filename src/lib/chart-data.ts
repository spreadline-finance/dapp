import type { ReferencePrice } from "./market-types";

export type PriceObservation = { time: number; bid: number; ask: number; midpoint: number; multiplier: string };
export function appendObservation(points: readonly PriceObservation[], quote: ReferencePrice, multiplier: string): readonly PriceObservation[] {
  const time = Date.parse(quote.generatedAt);
  const bid = Number(quote.bid) * Number(multiplier);
  const ask = Number(quote.ask) * Number(multiplier);
  if (quote.halted || !Number.isFinite(time) || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return points;
  // A multiplier change is a corporate-action boundary, not a price move.
  const series = points.length && points[points.length - 1].multiplier !== multiplier ? [] : points;
  if (series.some((point) => point.time === time)) return series;
  return [...series, { time, bid, ask, midpoint: (bid + ask) / 2, multiplier }].sort((a, b) => a.time - b.time).slice(-120);
}

export type ModelAssumptions = { gapBps: number; feeBps: number; depth: number; gas: number };
export function modelRoundTrip(amount: number, { gapBps, feeBps, depth, gas }: ModelAssumptions) {
  // Educational constant-product approximation: two equal-depth pools,
  // fee on each leg, a static initial price ratio, and an assumed gas cost.
  const fee = feeBps / 10000;
  const ratio = 1 + gapBps / 10000;
  const afterBuyFee = amount * (1 - fee);
  const tokens = afterBuyFee / (1 + afterBuyFee / depth);
  const proceeds = tokens * ratio * (1 - fee);
  const returned = proceeds / (1 + proceeds / depth);
  const beforeImpact = amount * ratio * (1 - fee) ** 2;
  const gross = amount * gapBps / 10000;
  return { amount, gross, fees: amount * ratio - beforeImpact, impact: beforeImpact - returned, gas, net: returned - amount - gas };
}
