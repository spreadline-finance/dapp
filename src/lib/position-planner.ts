import { formatUnits, parseUnits, type Address } from "viem";
import type { TradeSide } from "./trading";

export const PLANNER_PERCENTAGES = [25, 50, 100] as const;
export type PlannerRoute = { pool: Address; fee: number; amountOut: string; amountOutRaw: string };
export type PlannerRow = {
  percentage: number; amountIn: string; amountInRaw: string;
  status: "quoted" | "too_small" | "no_pools" | "no_active_pools" | "quotes_unavailable" | "full_size_unavailable";
  attempted: number; failed: number; routes: PlannerRoute[];
  excludedRoutes: { pool: Address; fee: number; reason: "price_limit" }[];
};
export type PositionPlan = {
  symbol: string; stock: Address; side: TradeSide;
  amount: string; amountRaw: string; inputDecimals: number; outputDecimals: number;
  blockNumber: string; blockHash: string; blockTimestamp: string; fetchedAt: string; expiresAt: string;
  discoveredPools: number; activePools: number; feeTiers: number[];
  rows: PlannerRow[];
};
export type PlannerPosition = {
  address: Address; symbol: string; stock: Address; decimals: number; balance: string;
  blockNumber: string; blockTimestamp: string; fetchedAt: string;
};

// Validate before parseUnits: it otherwise rounds unsupported decimal precision.
export function parsePlannerAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("The planner supports tokens with up to 18 decimals.");
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals)
    throw new Error(`Enter a positive amount with up to ${decimals} decimals.`);
  const amount = parseUnits(value, decimals);
  if (amount <= BigInt(0) || amount > BigInt(100000) * BigInt(10) ** BigInt(decimals))
    throw new Error("Compare an amount above zero and at most 100,000 input tokens.");
  return amount;
}

export function plannerSizes(value: string, decimals: number) {
  const raw = parsePlannerAmount(value, decimals);
  return PLANNER_PERCENTAGES.map((percentage) => {
    const amount = raw * BigInt(percentage) / BigInt(100);
    return { percentage, amountInRaw: String(amount), amountIn: formatUnits(amount, decimals) };
  });
}

// V3 can stop at its price limit before spending the entire exact-input amount.
// QuoterV2 reports output but does not report the actual input spent. A boundary
// result is therefore excluded conservatively from full-size comparisons.
export function fullPlannerInputVerified(tokenIn: string, tokenOut: string, pricesAfter: readonly bigint[]) {
  const min = BigInt("4295128740"), max = BigInt("1461446703485210103287273052203988822378723970341");
  if (pricesAfter.length !== 1 || pricesAfter[0] < min || pricesAfter[0] > max) throw new Error("Invalid single-pool quote price.");
  return pricesAfter[0] !== (BigInt(tokenIn) < BigInt(tokenOut) ? min : max);
}

function priceDifference(side: TradeSide, row: PlannerRow, baseline: PlannerRow) {
  if (row.status !== "quoted" || baseline.status !== "quoted" || row.failed || baseline.failed || !row.routes.length || !baseline.routes.length) return null;
  const input = BigInt(row.amountInRaw), output = BigInt(row.routes[0].amountOutRaw);
  const baseInput = BigInt(baseline.amountInRaw), baseOutput = BigInt(baseline.routes[0].amountOutRaw);
  if ([input, output, baseInput, baseOutput].some((value) => value <= BigInt(0))) return null;
  return side === "buy"
    ? { numerator: input * baseOutput - baseInput * output, denominator: baseInput * output }
    : { numerator: baseOutput * input - output * baseInput, denominator: baseOutput * input };
}

export function assessPositionPlan(plan: PositionPlan, thresholdBps: number, now: number) {
  const baseline = plan.rows.find((row) => row.percentage === 25);
  const fresh = Number.isFinite(Date.parse(plan.expiresAt)) && now < Date.parse(plan.expiresAt);
  const validThreshold = Number.isInteger(thresholdBps) && thresholdBps >= 0 && thresholdBps <= 500;
  const rows = plan.rows.map((row) => {
    const difference = baseline ? priceDifference(plan.side, row, baseline) : null;
    return {
      row,
      differenceBps: difference ? Number(difference.numerator) / Number(difference.denominator) * 10000 : null,
      withinLimit: difference && validThreshold
        ? difference.numerator * BigInt(10000) <= BigInt(thresholdBps) * difference.denominator : null,
    };
  });
  const complete = rows.length === 3 && rows.every(({ row, differenceBps }) => row.status === "quoted" && row.failed === 0 && differenceBps !== null);
  const largest = fresh && complete && validThreshold
    ? [...rows].reverse().find((entry) => entry.withinLimit)?.row ?? null : null;
  return { fresh, complete, rows, largest };
}

export function averagePlannerPrice(plan: PositionPlan, row: PlannerRow) {
  const output = row.routes[0]?.amountOut;
  if (!output || Number(output) <= 0 || Number(row.amountIn) <= 0) return null;
  return plan.side === "buy" ? Number(row.amountIn) / Number(output) : Number(output) / Number(row.amountIn);
}
