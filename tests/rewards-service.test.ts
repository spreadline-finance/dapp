import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress, type Address } from "viem";
import { createRewardsService } from "../server/rewards-service";
import { validateRewardsReport } from "../src/lib/rewards-report";
import type { RewardsReport } from "../src/lib/rewards-types";
import { USDG } from "../src/lib/market-types";

const alice = "0x1111111111111111111111111111111111111111" as Address;
const feeWallet = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x3333333333333333333333333333333333333333" as Address;
const bob = "0x4444444444444444444444444444444444444444" as Address;
const hash = `0x${"a".repeat(64)}` as const;
const endpoint = "https://private-deployment.example/v1/rewards";
const config = { REWARDS_REPORT_URL: endpoint };

function document(now = Date.now()): RewardsReport {
  const updatedAt = new Date(now).toISOString();
  return {
    version: 1, model: "wallet-keeper", chainId: 4663, token, tokenSymbol: "SPREAD", tokenDecimals: 18,
    rewardAsset: { address: zeroAddress, symbol: "ETH", decimals: 18 }, feeWallet,
    holderBps: 7500, developerBps: 2500, intervalSeconds: 900, status: "ready", statusReason: "none",
    updatedAt, nextRunAt: new Date(now + 900_000).toISOString(), balanceAsOfBlock: "110",
    totals: { collected: "7", allocatedToHolders: "3", paidToHolders: "1", reservedForHolders: "2", retainedByDeveloper: "1", unallocated: "3" },
    exclusions: [{ address: zeroAddress, reason: "Burn address" }],
    epochs: [
      { id: "2", snapshotBlock: "102", snapshotHash: hash, eligibleSupply: "4", cumulativeCollectedBefore: "2", holderBudget: "2", collected: "2", createdAt: new Date(now - 1000).toISOString(), paid: "0", remaining: "2", status: "scheduled" },
      { id: "1", snapshotBlock: "101", snapshotHash: hash, eligibleSupply: "4", cumulativeCollectedBefore: "0", holderBudget: "1", collected: "2", createdAt: new Date(now - 901_000).toISOString(), paid: "1", remaining: "0", status: "completed" },
    ], nextCursor: null, wallet: null,
  };
}
function personal(address = alice, now = Date.now()): RewardsReport {
  const report = document(now);
  report.wallet = { address, tokenBalance: "30", eligibleWeight: "3", totalEligibleWeight: "4", snapshotEpochId: "2", earned: "3", paid: "1", pending: "2",
    receipts: [{ epochId: "1", amount: "1", transactionHash: hash, blockNumber: "105", confirmedAt: new Date(now - 1000).toISOString(), status: "confirmed" }] };
  return report;
}
function mockReports(make: (url: URL) => unknown = url => url.searchParams.has("wallet") ? personal(url.searchParams.get("wallet") as Address) : document()) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    return Response.json(make(url));
  };
  return { fetcher, calls };
}

test("unconfigured automatic rewards expose missing data without fake zero balances or network calls", async () => {
  const mock = mockReports();
  const result = await createRewardsService({}, mock.fetcher).snapshot(alice);
  assert.equal(result.status, "unconfigured"); assert.equal(result.report, null); assert.equal(mock.calls.length, 0);
  assert.deepEqual(Object.keys(result).sort(), ["chainId", "fetchedAt", "message", "report", "status"]);
  assert.match(result.message, /No earnings or payment totals are available/);
});

test("75 percent cumulative rounding carry, unallocated receipts and 25 percent remainder reconcile", () => {
  const report = validateRewardsReport(document());
  assert.equal(report.epochs[0].holderBudget, "2", "This epoch includes a carried raw unit from an earlier receipt.");
  assert.equal(report.totals.allocatedToHolders, "3");
  assert.equal(report.totals.retainedByDeveloper, "1");
  assert.equal(report.totals.unallocated, "3", "Collected income awaiting a snapshot is not falsely reported as an earned allocation.");
});

test("wallet requests are read-only, address-bound, identity-checked and never shared or cached", async () => {
  const mock = mockReports(); const service = createRewardsService(config, mock.fetcher);
  const [a, b] = await Promise.all([service.snapshot(alice), service.snapshot(bob)]);
  assert.equal(a.status, "reported"); assert.equal(a.report?.wallet?.address, alice);
  assert.equal(b.report?.wallet?.address, bob);
  assert.equal(a.report?.wallet?.tokenBalance, "30"); assert.equal(a.report?.wallet?.eligibleWeight, "3");
  assert.equal(a.report?.wallet?.paid, "1"); assert.equal(a.report?.wallet?.pending, "2");
  assert.match(a.message, /not been independently verified/);
  await service.snapshot(alice);
  assert.equal(mock.calls.length, 6, "Each lookup fetches a fresh public identity and its own wallet report.");
  for (const { url, init } of mock.calls) {
    assert.equal(url.origin + url.pathname, endpoint); assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual"); assert.equal(init?.cache, "no-store"); assert.equal(init?.body, undefined);
    assert.ok(init?.signal); assert.deepEqual(init?.headers, { accept: "application/json", "cache-control": "no-store" });
    assert.deepEqual([...url.searchParams.keys()].filter(key => key !== "wallet"), []);
  }
});

test("the creator fee wallet can earn holder rewards in addition to the retained developer remainder", async () => {
  const mock = mockReports();
  const result = await createRewardsService(config, mock.fetcher).snapshot(feeWallet);
  assert.equal(result.status, "reported");
  assert.equal(result.report?.wallet?.address, feeWallet);
  assert.equal(result.report?.wallet?.eligibleWeight, "3");
  assert.equal(result.report?.wallet?.earned, "3");
  assert.equal(result.report?.totals.retainedByDeveloper, "1");
  assert.ok(!result.report?.exclusions.some(entry => entry.address.toLowerCase() === feeWallet.toLowerCase()));
});

test("older page cursors are exclusive and lifetime totals do not shrink", async () => {
  const mock = mockReports(url => {
    const report = url.searchParams.has("wallet") ? personal() : document();
    if (url.searchParams.has("before")) report.epochs = report.epochs.slice(1);
    return report;
  });
  const result = await createRewardsService(config, mock.fetcher).snapshot(alice, 2n);
  assert.equal(result.status, "reported"); assert.deepEqual(result.report?.epochs.map(epoch => epoch.id), ["1"]);
  assert.equal(result.report?.totals.allocatedToHolders, "3"); assert.equal(result.report?.wallet?.earned, "3");
  assert.equal(mock.calls.filter(call => call.url.searchParams.get("before") === "2").length, 1);
  const invalid = mockReports();
  assert.equal((await createRewardsService(config, invalid.fetcher).snapshot(alice, "2")).status, "unavailable");
});

test("wrong chain, fee ratio, token identity and reward asset metadata fail closed", () => {
  const changes: ((report: RewardsReport) => void)[] = [
    report => { Object.assign(report, { chainId: 1 }); }, report => { Object.assign(report, { holderBps: 7000, developerBps: 3000 }); },
    report => { Object.assign(report, { intervalSeconds: 86400 }); }, report => { report.token = feeWallet; },
    report => { report.rewardAsset.address = bob; }, report => { report.rewardAsset.decimals = 6; },
    report => { report.feeWallet = zeroAddress; }, report => { report.token = zeroAddress; },
  ];
  for (const change of changes) { const report = document(); change(report); assert.throws(() => validateRewardsReport(report)); }
  const usd = document(); usd.rewardAsset = { address: USDG, symbol: "USDG", decimals: 6 };
  assert.equal(validateRewardsReport(usd).rewardAsset.symbol, "USDG");
});

test("reported fee totals cannot overallocate, erase liabilities or redirect carried units", () => {
  const changes: ((report: RewardsReport) => void)[] = [
    report => { report.totals.paidToHolders = "4"; }, report => { report.totals.reservedForHolders = "0"; },
    report => { report.totals.retainedByDeveloper = "2"; }, report => { report.totals.allocatedToHolders = "2"; },
    report => { report.totals.unallocated = "8"; }, report => { report.epochs[0].holderBudget = "1"; },
    report => { report.epochs[0].cumulativeCollectedBefore = "1"; }, report => { report.epochs[0].remaining = "0"; },
    report => { report.epochs[0].status = "completed"; }, report => { report.epochs[1].cumulativeCollectedBefore = "2"; },
    report => { report.epochs[1].id = "2"; }, report => { report.nextCursor = "9"; },
  ];
  for (const change of changes) { const report = document(); change(report); assert.throws(() => validateRewardsReport(report)); }
});

test("raw money values reject floats, exponents, signs, leading zeros and uint256 overflow", () => {
  for (const invalid of ["1.5", "1e18", "-1", "+1", "01", "", "9".repeat(1000), String(1n << 256n), 1]) {
    const report = document(); Object.assign(report.totals, { collected: invalid });
    assert.throws(() => validateRewardsReport(report));
  }
});

test("wallet allocations, snapshot shares and confirmed receipts cannot contradict totals", () => {
  const changes: ((report: RewardsReport) => void)[] = [
    report => { report.wallet!.earned = "4"; }, report => { report.wallet!.paid = "2"; },
    report => { report.wallet!.eligibleWeight = "5"; }, report => { report.wallet!.totalEligibleWeight = "5"; },
    report => { report.wallet!.snapshotEpochId = null; }, report => { report.wallet!.receipts[0].amount = "2"; },
    report => { report.wallet!.receipts.push(report.wallet!.receipts[0]); }, report => { report.wallet!.receipts[0].blockNumber = "111"; },
    report => { Object.assign(report.wallet!.receipts[0], { status: "submitted" }); },
  ];
  for (const change of changes) { const report = personal(); change(report); assert.throws(() => validateRewardsReport(report)); }
});

test("a lookup for another wallet or different deployment cannot contaminate dashboard data", async () => {
  for (const make of [
    (url: URL) => url.searchParams.has("wallet") ? personal(bob) : document(),
    (url: URL) => { const report = url.searchParams.has("wallet") ? personal() : document(); if (report.wallet) report.token = bob; return report; },
    (url: URL) => { const report = url.searchParams.has("wallet") ? personal() : document(); if (report.wallet) report.feeWallet = bob; return report; },
    () => personal(),
  ]) {
    const result = await createRewardsService(config, mockReports(make).fetcher).snapshot(alice);
    assert.equal(result.status, "unavailable"); assert.equal(result.report, null);
  }
});

test("stale reports retain clearly labeled historical data while future reports are rejected", async () => {
  const stale = await createRewardsService(config, mockReports(() => document(Date.now() - 21 * 60_000)).fetcher).snapshot();
  assert.equal(stale.status, "stale"); assert.equal(stale.report?.totals.paidToHolders, "1"); assert.match(stale.message, /out of date/);
  const future = await createRewardsService(config, mockReports(() => document(Date.now() + 120_000)).fetcher).snapshot();
  assert.equal(future.status, "unavailable"); assert.equal(future.report, null);
});

test("invalid targets, wallet addresses and cursors never issue an upstream request", async () => {
  for (const url of ["file:///etc/passwd", "http://remote.example/v1/rewards", "https://user:secret@remote.example/v1/rewards", `${endpoint}?secret=hidden`, `${endpoint}#private`]) {
    const mock = mockReports(); const result = await createRewardsService({ REWARDS_REPORT_URL: url }, mock.fetcher).snapshot();
    assert.equal(result.status, "unavailable"); assert.equal(mock.calls.length, 0); assert.ok(!JSON.stringify(result).includes(url));
  }
  for (const cursor of ["0", "-1", "2&target=https://evil.test", "9".repeat(17)]) {
    const mock = mockReports(); assert.equal((await createRewardsService(config, mock.fetcher).snapshot(alice, cursor)).status, "unavailable"); assert.equal(mock.calls.length, 0);
  }
  const mock = mockReports(); assert.equal((await createRewardsService(config, mock.fetcher).snapshot("http://evil.test" as Address)).status, "unavailable"); assert.equal(mock.calls.length, 0);
});

test("upstream errors, redirects and accidental private journal fields are never exposed", async () => {
  const secret = "private-signing-key-and-internal-url";
  const responses: (typeof fetch)[] = [
    async () => { throw new Error(`${endpoint}/${secret}`); },
    async () => new Response(secret, { status: 503 }),
    async () => Response.redirect(`https://internal.example/${secret}`),
    async () => Response.json({ ...document(), operatorKey: secret }),
    async () => Response.json({ ...document(), wallet: { ...personal().wallet, pendingTransaction: { raw: secret } } }),
  ];
  for (const fetcher of responses) {
    const result = await createRewardsService(config, fetcher).snapshot();
    assert.equal(result.status, "unavailable"); assert.equal(result.report, null);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(endpoint));
  }
});

test("oversized and malformed response streams are bounded and cancelled", async () => {
  let cancelled = false;
  const oversized: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(512_001)); }, cancel() { cancelled = true; },
  }));
  assert.equal((await createRewardsService(config, oversized).snapshot()).status, "unavailable"); assert.equal(cancelled, true);
  const longHeader: typeof fetch = async () => new Response("{}", { headers: { "content-length": "9999999999999" } });
  assert.equal((await createRewardsService(config, longHeader).snapshot()).status, "unavailable");
  const malformed: typeof fetch = async () => new Response(new Uint8Array([0xff, 0xff]));
  assert.equal((await createRewardsService(config, malformed).snapshot()).status, "unavailable");
});

test("unbounded history and arbitrary exclusion data are rejected", () => {
  const report = document(); report.epochs = Array.from({ length: 21 }, () => report.epochs[0]);
  assert.throws(() => validateRewardsReport(report));
  for (const reason of ["http://private.example/secret", "line\nsecret", "x".repeat(181)]) {
    const report = document(); report.exclusions[0].reason = reason; assert.throws(() => validateRewardsReport(report));
  }
  const duplicate = document(); duplicate.exclusions.push(duplicate.exclusions[0]); assert.throws(() => validateRewardsReport(duplicate));
});

test("30-second test reports are accepted without changing the fee policy", async () => {
  const mock = mockReports(() => ({ ...document(), intervalSeconds: 30 }));
  const result = await createRewardsService(config, mock.fetcher).snapshot();
  assert.equal(result.status, "reported");
  assert.equal(result.report?.intervalSeconds, 30);
  assert.equal(result.report?.holderBps, 7500);
});

import { distributionCountdown, estimatedAdditionalReward } from "../src/lib/rewards-preview";

test("distribution countdown ticks and never invents another schedule when overdue or blocked", () => {
  const now = Date.now(), report = document(now);
  assert.equal(distributionCountdown(report, now, false), "15m 00s");
  assert.equal(distributionCountdown(report, now + 1000, false), "14m 59s");
  assert.equal(distributionCountdown(report, now + 900000, false), "Due · awaiting service update");
  report.status = "attention";
  assert.equal(distributionCountdown(report, now, false), "Delayed · needs attention");
  report.status = "paused";
  assert.equal(distributionCountdown(report, now, false), "Paused");
  assert.equal(distributionCountdown(report, now, true), "Awaiting service update");
  report.status = "ready"; report.nextRunAt = new Date(now + 30000).toISOString();
  assert.equal(distributionCountdown(report, now, false), "0m 30s");
  report.nextRunAt = null;
  assert.equal(distributionCountdown(report, now, false), "Awaiting schedule");
});

test("reward estimate separates pending allocations and respects cumulative rounding and missing snapshots", () => {
  const report = personal();
  // 75% of 7 minus 75% of 4 = 2 additional raw units; wallet owns 3/4.
  assert.equal(estimatedAdditionalReward(report, false), "1");
  assert.equal(report.wallet!.pending, "2");
  assert.equal(estimatedAdditionalReward(report, true), null);
  report.wallet!.snapshotEpochId = null;
  assert.equal(estimatedAdditionalReward(report, false), null);
  report.wallet!.snapshotEpochId = "2";
  report.wallet!.eligibleWeight = "0";
  assert.equal(estimatedAdditionalReward(report, false), "0");
});

import { distributionTotals } from "../src/lib/rewards-preview";
test("overall pending includes only unpaid allocations and the unallocated holder share, with cumulative rounding", () => {
  const report = document();
  assert.deepEqual(distributionTotals(report), { paid: "1", allocatedPending: "2", awaitingAllocation: "2", pending: "4" });
  // Paging and wallet selection cannot change lifetime amounts.
  report.epochs = [];
  report.wallet = null;
  assert.equal(distributionTotals(report).pending, "4");
  report.totals = { collected: "100", allocatedToHolders: "75", paidToHolders: "75", reservedForHolders: "0", retainedByDeveloper: "25", unallocated: "0" };
  assert.deepEqual(distributionTotals(report), { paid: "75", allocatedPending: "0", awaitingAllocation: "0", pending: "0" });
});
