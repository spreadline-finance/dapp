import { sourceIsCurrent } from "./live-freshness";

export type RewardUsdPrice = { asset: "ETH"; currency: "USD"; price: string; source: "Coinbase"; fetchedAt: string };
const decimalPrice = /^(0|[1-9]\d{0,11})(\.\d{1,18})?$/;
export function rewardPriceIsCurrent(quote: RewardUsdPrice | null | undefined, asset: string, now: number): quote is RewardUsdPrice {
  return !!quote && quote.asset === asset && quote.currency === "USD" && quote.source === "Coinbase"
    && typeof quote.price === "string" && decimalPrice.test(quote.price) && BigInt(quote.price.replace(".", "")) > BigInt(0)
    && sourceIsCurrent(quote.fetchedAt, now, 120000);
}

/** Display-only conversion: retain exact raw units until rounding the USD estimate. */
export function rewardUsdValue(raw: string | null | undefined, decimals: number, quote: RewardUsdPrice | null | undefined, asset: string, now: number): string | null {
  if (!rewardPriceIsCurrent(quote, asset, now) || raw == null || !/^(0|[1-9]\d{0,77})$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const [whole, fraction = ""] = quote.price.split(".");
  const numerator = BigInt(raw) * BigInt(whole + fraction);
  const denominator = BigInt(10) ** BigInt(decimals + fraction.length);
  const places = numerator * BigInt(100) < denominator && numerator > BigInt(0) ? 6 : 2;
  const scale = BigInt(10) ** BigInt(places);
  const rounded = (numerator * scale * BigInt(2) + denominator) / (denominator * BigInt(2));
  if (rounded === BigInt(0) && numerator > BigInt(0)) return "<$0.000001";
  const dollars = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (rounded % scale).toString().padStart(places, "0");
  return `≈ $${dollars}.${places === 6 ? cents.replace(/0+$/, "") || "00" : cents}`;
}
