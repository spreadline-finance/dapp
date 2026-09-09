import type { RewardsReport } from "./rewards-types";

export function distributionCountdown(report: RewardsReport, now: number, stale: boolean): string {
  if (stale || !now) return "Awaiting service update";
  if (report.status === "paused") return "Paused";
  if (report.status === "attention" || report.statusReason === "operator-attention") return "Delayed · needs attention";
  if (report.statusReason !== "none") return "Waiting for service readiness";
  if (!report.nextRunAt) return "Awaiting schedule";
  const seconds = Math.ceil((Date.parse(report.nextRunAt) - now) / 1000);
  if (!Number.isFinite(seconds)) return "Awaiting schedule";
  if (seconds <= 0) return "Due · awaiting service update";
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}h ` : ""}${Math.floor(seconds % 3600 / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Additional unallocated income only; preserve the keeper's cumulative 75% rounding. */
export function estimatedAdditionalReward(report: RewardsReport, stale: boolean): string | null {
  const wallet = report.wallet;
  if (stale || !wallet?.snapshotEpochId || BigInt(wallet.totalEligibleWeight) === BigInt(0)) return null;
  if (report.exclusions.some(entry => entry.address.toLowerCase() === wallet.address.toLowerCase())) return "0";
  const collected = BigInt(report.totals.collected);
  const booked = collected - BigInt(report.totals.unallocated);
  const budget = collected * BigInt(7500) / BigInt(10000) - booked * BigInt(7500) / BigInt(10000);
  return (budget * BigInt(wallet.eligibleWeight) / BigInt(wallet.totalEligibleWeight)).toString();
}

/** Lifetime holder totals from validated keeper accounting, independent of the loaded epoch page. */
export function distributionTotals(report: RewardsReport) {
  const paid = BigInt(report.totals.paidToHolders);
  const allocatedPending = BigInt(report.totals.reservedForHolders);
  const collected = BigInt(report.totals.collected);
  const booked = collected - BigInt(report.totals.unallocated);
  const awaitingAllocation = collected * BigInt(7500) / BigInt(10000) - booked * BigInt(7500) / BigInt(10000);
  return { paid: String(paid), allocatedPending: String(allocatedPending), awaitingAllocation: String(awaitingAllocation), pending: String(allocatedPending + awaitingAllocation) };
}
