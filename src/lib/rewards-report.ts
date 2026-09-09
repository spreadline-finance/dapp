import { z } from "zod";
import { getAddress, isAddress, zeroAddress } from "viem";
import { USDG } from "./market-types";
import type { RewardsReport } from "./rewards-types";

const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
const raw = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) <= UINT256_MAX);
const positiveRaw = raw.refine(value => BigInt(value) > BigInt(0));
const id = z.string().regex(/^[1-9]\d{0,15}$/);
const address = z.string().refine(value => isAddress(value, { strict: false })).transform(value => getAddress(value));
const nonzeroAddress = address.refine(value => value !== zeroAddress);
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/).transform(value => value.toLowerCase() as `0x${string}`);
const timestamp = z.string().datetime({ offset: true }).max(40);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const holderShare = (value: bigint) => value * BigInt(7500) / BigInt(10000);
const epochSchema = z.object({
  id, snapshotBlock: positiveRaw, snapshotHash: hash, eligibleSupply: positiveRaw,
  cumulativeCollectedBefore: raw, holderBudget: raw, collected: positiveRaw,
  createdAt: timestamp, paid: raw, remaining: raw,
  status: z.enum(["scheduled", "paying", "completed", "attention"]),
}).strict();
const walletSchema = z.object({
  address: nonzeroAddress, tokenBalance: raw, eligibleWeight: raw, totalEligibleWeight: raw,
  snapshotEpochId: id.nullable(), earned: raw, paid: raw, pending: raw,
  receipts: z.array(z.object({ epochId: id, amount: positiveRaw, transactionHash: hash, blockNumber: positiveRaw, confirmedAt: timestamp.nullable(), status: z.literal("confirmed") }).strict()).max(50),
}).strict();
const reportSchema = z.object({
  version: z.literal(1), model: z.literal("wallet-keeper"), chainId: z.literal(4663),
  token: nonzeroAddress, tokenSymbol: z.string().min(1).max(32).regex(/^[\p{L}\p{N}$._ -]+$/u), tokenDecimals: z.number().int().min(0).max(18),
  rewardAsset: z.object({ address, symbol: z.enum(["ETH", "USDG"]), decimals: z.union([z.literal(6), z.literal(18)]) }).strict(),
  feeWallet: nonzeroAddress, holderBps: z.literal(7500), developerBps: z.literal(2500), intervalSeconds: z.union([z.literal(30), z.literal(900)]),
  status: z.enum(["ready", "paused", "attention"]),
  statusReason: z.enum(["none", "paused", "insufficient-funds", "gas-unavailable", "rpc-unavailable", "payment-pending", "operator-attention"]),
  updatedAt: timestamp, nextRunAt: timestamp.nullable(), balanceAsOfBlock: positiveRaw,
  totals: z.object({ collected: raw, allocatedToHolders: raw, paidToHolders: raw, reservedForHolders: raw, retainedByDeveloper: raw, unallocated: raw }).strict(),
  exclusions: z.array(z.object({ address, reason: z.string().min(1).max(180).refine(value => !/[\r\n\u0000-\u001f]|:\/\//.test(value)) }).strict()).max(200),
  epochs: z.array(epochSchema).max(20), nextCursor: id.nullable(), wallet: walletSchema.nullable(),
}).strict();

/** Validate reported arithmetic and identity, without claiming independent receipt verification. */
export function validateRewardsReport(value: unknown): RewardsReport {
  const report = reportSchema.parse(value);
  const require = (condition: boolean, message: string) => { if (!condition) throw new Error(`Invalid reward report: ${message}.`); };
  require(!same(report.token, report.feeWallet) && !same(report.token, report.rewardAsset.address), "token identity");
  require(report.rewardAsset.symbol === "ETH" ? same(report.rewardAsset.address, zeroAddress) && report.rewardAsset.decimals === 18
    : same(report.rewardAsset.address, USDG) && report.rewardAsset.decimals === 6, "reward asset identity");
  const totals = report.totals;
  const collected = BigInt(totals.collected), unallocated = BigInt(totals.unallocated);
  const allocated = BigInt(totals.allocatedToHolders), paid = BigInt(totals.paidToHolders), reserve = BigInt(totals.reservedForHolders);
  require(unallocated <= collected, "unallocated income exceeds collection");
  const booked = collected - unallocated;
  require(allocated === holderShare(booked), "cumulative holder allocation must equal 75 percent with carried rounding");
  require(BigInt(totals.retainedByDeveloper) === booked - allocated, "developer remainder");
  require(paid + reserve === allocated, "paid and outstanding allocations must reconcile");
  require(new Set(report.exclusions.map(entry => entry.address.toLowerCase())).size === report.exclusions.length, "duplicate exclusion");
  let previousId: bigint | undefined, previousCumulative: bigint | undefined;
  let pageAllocated = BigInt(0), pagePaid = BigInt(0), pageRemaining = BigInt(0);
  for (const epoch of report.epochs) {
    const epochId = BigInt(epoch.id), before = BigInt(epoch.cumulativeCollectedBefore), gross = BigInt(epoch.collected), budget = BigInt(epoch.holderBudget);
    require(previousId === undefined || epochId < previousId, "epochs must be unique and newest first");
    require(before + gross <= booked, "epoch collection exceeds lifetime booked income");
    require(previousCumulative === undefined || before + gross <= previousCumulative, "epoch collection ranges overlap");
    require(budget === holderShare(before + gross) - holderShare(before), "epoch holder budget and carry");
    require(BigInt(epoch.paid) + BigInt(epoch.remaining) === budget, "epoch paid and outstanding allocation");
    require(epoch.status !== "completed" || epoch.remaining === "0", "completed epoch still has unpaid holders");
    require(BigInt(epoch.snapshotBlock) <= BigInt(report.balanceAsOfBlock), "snapshot beyond balance block");
    require(Date.parse(epoch.createdAt) <= Date.parse(report.updatedAt), "epoch after report timestamp");
    previousId = epochId; previousCumulative = before;
    pageAllocated += budget; pagePaid += BigInt(epoch.paid); pageRemaining += BigInt(epoch.remaining);
  }
  require(pageAllocated <= allocated && pagePaid <= paid && pageRemaining <= reserve, "page exceeds lifetime totals");
  require(report.nextCursor === null || report.epochs.length > 0 && report.nextCursor === report.epochs.at(-1)?.id, "exclusive pagination cursor");
  if (report.wallet) {
    const wallet = report.wallet;
    require(BigInt(wallet.earned) === BigInt(wallet.paid) + BigInt(wallet.pending), "wallet paid and outstanding rewards");
    require(BigInt(wallet.earned) <= allocated && BigInt(wallet.paid) <= paid && BigInt(wallet.pending) <= reserve, "wallet exceeds lifetime totals");
    require(BigInt(wallet.eligibleWeight) <= BigInt(wallet.totalEligibleWeight), "wallet snapshot weight");
    require(wallet.snapshotEpochId !== null || wallet.eligibleWeight === "0" && wallet.totalEligibleWeight === "0", "wallet has weight without snapshot");
    require(wallet.snapshotEpochId === null || BigInt(wallet.totalEligibleWeight) > BigInt(0), "snapshot missing eligible supply");
    const snapshot = report.epochs.find(epoch => epoch.id === wallet.snapshotEpochId);
    if (snapshot) require(wallet.totalEligibleWeight === snapshot.eligibleSupply, "wallet snapshot denominator differs");
    const keys = wallet.receipts.map(receipt => `${receipt.epochId}/${receipt.transactionHash.toLowerCase()}`);
    require(new Set(keys).size === keys.length, "duplicate wallet payment receipt");
    require(wallet.receipts.reduce((sum, receipt) => sum + BigInt(receipt.amount), BigInt(0)) <= BigInt(wallet.paid), "receipt page exceeds wallet payments");
    require(wallet.receipts.every(receipt => BigInt(receipt.blockNumber) <= BigInt(report.balanceAsOfBlock)
      && (receipt.confirmedAt === null || Date.parse(receipt.confirmedAt) <= Date.parse(report.updatedAt))), "receipt outside report block or time");
  }
  return report;
}

/** A wallet lookup must retain the same configured public deployment identity. */
export function sameRewardsReportIdentity(left: RewardsReport, right: RewardsReport): boolean {
  return left.version === right.version && left.model === right.model && left.chainId === right.chainId
    && same(left.token, right.token) && left.tokenSymbol === right.tokenSymbol && left.tokenDecimals === right.tokenDecimals
    && same(left.feeWallet, right.feeWallet) && same(left.rewardAsset.address, right.rewardAsset.address)
    && left.rewardAsset.symbol === right.rewardAsset.symbol && left.rewardAsset.decimals === right.rewardAsset.decimals
    && left.holderBps === right.holderBps && left.developerBps === right.developerBps && left.intervalSeconds === right.intervalSeconds;
}
