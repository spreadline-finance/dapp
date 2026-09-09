import type { RewardsReport } from "./rewards-types";
import { sourceIsCurrent } from "./live-freshness";

export function distributionCountdown(report: RewardsReport, now: number, stale: boolean): string {
  if (stale || !now) return "Awaiting service update";
  if (report.statusReason === "payment-pending") return "Confirming transaction";
  if (report.statusReason === "gas-unavailable") return "Waiting for transaction fees";
  if (report.statusReason === "insufficient-funds") return "Waiting for payout funding";
  if (report.statusReason === "rpc-unavailable") return "Waiting for network connection";
  if (report.status === "attention" || report.statusReason === "operator-attention") return "Delayed · needs attention";
  if (report.executionMode === "report-only") return "Payouts not running";
  if (report.executionMode === "manual") return "Every 5 minutes";
  if (report.status === "paused") return "Paused";
  if (report.statusReason !== "none") return "Waiting for service readiness";
  if (!report.nextRunAt) return "Awaiting schedule";
  const seconds = Math.ceil((Date.parse(report.nextRunAt) - now) / 1000);
  if (!Number.isFinite(seconds)) return "Awaiting schedule";
  if (seconds <= 0) return "Due · awaiting service update";
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}h ` : ""}${Math.floor(seconds % 3600 / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function rewardsServiceMessage(report: RewardsReport | null, stale: boolean): string {
  if (!report) return "Token and payout service configuration is pending.";
  if (stale) return "The accounting report is out of date. Displayed totals are the last recorded amounts; a payment time cannot be confirmed.";
  const reasons: Record<RewardsReport["statusReason"], string> = {
    none: "", paused: "", "insufficient-funds": "The payout wallet needs funds before payments can continue.",
    "gas-unavailable": "Distribution is waiting for transaction-fee funding or available gas budget.",
    "rpc-unavailable": "The payout service cannot read the network right now.",
    "payment-pending": "The service is waiting for a submitted transaction to confirm. Payments count as received only after confirmation.",
    "operator-attention": "Rewards are delayed while the payout service catches up.",
  };
  if (reasons[report.statusReason]) return reasons[report.statusReason];
  if (report.status === "attention") return "Rewards are delayed while the payout service catches up.";
  if (report.executionMode === "report-only") return "Rewards reporting is connected, but periodic payouts are not running yet.";
  if (report.executionMode === "manual") return "Rewards are sent periodically every 5 minutes when fees, funding and minimum payout conditions are met. Eligible payments arrive directly in your wallet; you do not need to claim.";
  if (report.status === "paused" || report.statusReason === "paused") return "Automatic distribution checks are paused. Recorded pending rewards remain unpaid until the service resumes.";
  if (BigInt(report.totals.collected) === BigInt(0)) return "No creator fees have been collected into the payout ledger yet. Fees still on Pons are not included in these totals.";
  if (BigInt(report.totals.unallocated) === BigInt(0) && BigInt(report.totals.reservedForHolders) === BigInt(0)) return "Previous holder allocations have been paid. The next check looks for newly available creator fees.";
  return "Every 5 minutes, the payout service checks available fees and sends funded allocations that meet the minimum payout. Pending rewards below the minimum carry forward.";
}

/** Never substitute an old allocation snapshot for a current ownership observation. */
export function currentRewardPosition(report: RewardsReport, now: number) {
  const position = report.wallet?.currentPosition;
  return position && sourceIsCurrent(position.observedAt, now, 60_000) ? position : null;
}

/** Provisional share of collected, unallocated income; existing entitlements are immutable. */
export function estimatedAdditionalReward(report: RewardsReport, stale: boolean, now = Date.now()): string | null {
  const wallet = report.wallet, position = currentRewardPosition(report, now);
  if (stale || !wallet || !position || BigInt(position.totalEligibleWeight) === BigInt(0)) return null;
  if (report.exclusions.some(entry => entry.address.toLowerCase() === wallet.address.toLowerCase())) return "0";
  const collected = BigInt(report.totals.collected);
  const booked = collected - BigInt(report.totals.unallocated);
  const budget = collected * BigInt(7500) / BigInt(10000) - booked * BigInt(7500) / BigInt(10000);
  return (budget * BigInt(position.eligibleWeight) / BigInt(position.totalEligibleWeight)).toString();
}

/** Lifetime holder totals from validated payout accounting, independent of the loaded epoch page. */
export function distributionTotals(report: RewardsReport) {
  const paid = BigInt(report.totals.paidToHolders);
  const allocatedPending = BigInt(report.totals.reservedForHolders);
  const collected = BigInt(report.totals.collected);
  const booked = collected - BigInt(report.totals.unallocated);
  const awaitingAllocation = collected * BigInt(7500) / BigInt(10000) - booked * BigInt(7500) / BigInt(10000);
  return { paid: String(paid), allocatedPending: String(allocatedPending), awaitingAllocation: String(awaitingAllocation), pending: String(allocatedPending + awaitingAllocation) };
}
