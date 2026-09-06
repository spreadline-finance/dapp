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
  pendingMultiplier: decimal.nullable().catch(null),
  pendingMultiplierEffectiveTime: z.string().datetime({ offset: true }).nullable().catch(null),
  tradingCapabilities: z.object({
    fractionalTradability: z.string().max(50).nullable().catch(null),
    allDayTradability: z.string().max(50).nullable().catch(null),
    extendedHoursFractionalTradability: z.boolean().nullable().catch(null),
  }).nullable().catch(null),
});
const priceSchema = z
  .object({
    tokenSymbol: z.string(),
    bid: decimal,
    ask: decimal,
    generatedAt: z.string().datetime({ offset: true }),
    isTradingHalt: z.boolean(),
    currency: z.literal("USD"),
    dailyTradingVolume: decimal.nullable().catch(null),
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
      pendingMultiplier: a.pendingMultiplier,
      pendingMultiplierEffectiveTime: a.pendingMultiplierEffectiveTime,
      tradingCapabilities: a.tradingCapabilities,
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
            dailyTradingVolume: p.data.dailyTradingVolume,
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
export function parseCorporateActions(value: unknown) {
  const raw = z.object({ corpActions: z.array(z.unknown()).max(3000) }).parse(value);
  const schema = z.object({ id: z.string().max(120).optional(), tokenSymbol: z.string().regex(/^[A-Z0-9.\-]{1,20}$/), type: z.string().max(100), status: z.string().max(100), deployments: z.array(z.object({ chainId: z.number() })), processDate: z.object({ year: z.number().int().min(2000).max(2200), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).nullable().optional(), details: z.record(z.string(), z.unknown()).optional() });
  return raw.corpActions.flatMap((item) => {
    const parsed = schema.safeParse(item);
    if (!parsed.success || !parsed.data.deployments.some((d) => d.chainId === CHAIN_ID)) return [];
    const a = parsed.data, type = a.type.replace("CORPORATE_ACTION_TYPE_", "");
    const d = a.processDate;
    const date = d && new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCMonth() === d.month - 1 ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;
    let detail: string | null = null;
    if (type === "CASH_DIVIDEND" || type === "STOCK_DIVIDEND") {
      const rate = z.object({ rate: decimal }).safeParse(a.details?.[type === "CASH_DIVIDEND" ? "cashDividend" : "stockDividend"]);
      if (rate.success) detail = type === "CASH_DIVIDEND" ? `${rate.data.rate} USD per underlying share` : `${rate.data.rate} shares per underlying share`;
    } else if (type === "FORWARD_SPLIT" || type === "REVERSE_SPLIT") {
      const rates = z.object({ oldRate: decimal, newRate: decimal }).safeParse(a.details?.[type === "FORWARD_SPLIT" ? "forwardSplit" : "reverseSplit"]);
      if (rates.success) detail = `${rates.data.oldRate} → ${rates.data.newRate} underlying shares`;
    }
    return [{ id: a.id, symbol: a.tokenSymbol, type, status: a.status.replace("CORPORATE_ACTION_STATUS_", ""), date, detail }];
  });
}
