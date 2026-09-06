import { z } from "zod";
import { getAddress, isAddress, parseUnits } from "viem";
import type { StockAsset, ReferencePrice } from "../src/lib/market-types";
import { CHAIN_ID } from "../src/lib/market-types";
const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0);
const address = z.string().refine((v) => isAddress(v, { strict: false }));
const deployment = z.object({
  contractAddress: address,
  chainId: z.number().int(),
});
const assetSchema = z.object({
  tokenSymbol: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9.\-]+$/),
  tokenName: z.string().min(1).max(180),
  deployments: z.array(deployment),
  currentMultiplier: decimal,
  logoUrl: z.string().optional(),
  status: z.string(),
  tokenDecimals: z.number().int().min(0).max(36).optional(),
});
const priceSchema = z
  .object({
    tokenSymbol: z.string(),
    bid: decimal,
    ask: decimal,
    generatedAt: z.string().datetime({ offset: true }),
    isTradingHalt: z.boolean(),
    currency: z.literal("USD"),
  })
  .refine((q) => Number(q.ask) >= Number(q.bid));
export function parseCatalog(value: unknown): {
  assets: StockAsset[];
  rejected: number;
} {
  const raw = z.object({ assets: z.array(z.unknown()).max(3000) }).parse(value);
  let rejected = 0;
  const result: StockAsset[] = [];
  const seen = new Set<string>();
  for (const item of raw.assets) {
    const parsed = assetSchema.safeParse(item);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const a = parsed.data;
    const dep = a.deployments.find((d) => d.chainId === CHAIN_ID);
    if (!dep) continue;
    const canonical = getAddress(dep.contractAddress.toLowerCase());
    if (seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    let logo: null | string = null;
    try {
      const url = new URL(a.logoUrl || "");
      if (url.origin === "https://cdn.robinhood.com") logo = url.href;
    } catch {}
    result.push({
      symbol: a.tokenSymbol,
      name: a.tokenName.replace(" • Robinhood Token", ""),
      address: canonical,
      decimals: a.tokenDecimals ?? 18,
      multiplier: a.currentMultiplier,
      logo,
      active: a.status === "ASSET_STATUS_ACTIVE",
    });
  }
  if (!result.length)
    throw new Error(
      "The official registry did not return valid Robinhood Chain assets.",
    );
  return {
    assets: result.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    rejected,
  };
}
export function parsePrices(value: unknown): ReferencePrice[] {
  const raw = z.object({ quotes: z.array(z.unknown()).max(3000) }).parse(value);
  return raw.quotes.flatMap((item) => {
    const p = priceSchema.safeParse(item);
    return p.success
      ? [
          {
            symbol: p.data.tokenSymbol,
            bid: p.data.bid,
            ask: p.data.ask,
            generatedAt: p.data.generatedAt,
            halted: p.data.isTradingHalt,
            currency: p.data.currency,
          },
        ]
      : [];
  });
}
export function parseTradeSize(value: string | null, decimals: number) {
  if (!value || !/^\d{1,7}(\.\d{1,6})?$/.test(value))
    throw new Error(
      "Enter an amount from 1 to 100,000 USDG, with at most 6 decimal places.",
    );
  const amount = parseUnits(value, decimals);
  if (
    amount < 10n ** BigInt(decimals) ||
    amount > 100000n * 10n ** BigInt(decimals)
  )
    throw new Error("Trade size must be between 1 and 100,000 USDG.");
  return amount;
}
export function parseSymbol(value: string | null) {
  if (!value || !/^[A-Z0-9.\-]{1,20}$/.test(value))
    throw new Error("Choose a valid Stock Token.");
  return value;
}
export function validWallet(value: string | null) {
  if (!value || !isAddress(value, { strict: false }))
    throw new Error("Enter a valid EVM wallet address.");
  return getAddress(value.toLowerCase());
}
export function quoteIsFresh(expiresAt: string, now = Date.now()) {
  return Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now;
}
