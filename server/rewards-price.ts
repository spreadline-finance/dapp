import { z } from "zod";
import { rewardPriceIsCurrent, type RewardUsdPrice } from "../src/lib/rewards-usd";

export const REWARD_PRICE_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const spot = z.object({ data: z.object({ base: z.literal("ETH"), currency: z.literal("USD"), amount: z.string() }) });
export function parseRewardPrice(value: unknown, fetchedAt: string, now = Date.now()): RewardUsdPrice {
  const parsed = spot.parse(value);
  const quote: RewardUsdPrice = { asset: "ETH", currency: "USD", price: parsed.data.amount, source: "Coinbase", fetchedAt };
  if (!rewardPriceIsCurrent(quote, "ETH", now)) throw new Error("Invalid or expired reward price.");
  return quote;
}
