import assert from "node:assert/strict";
import test from "node:test";
import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { ageLabel, DataError, pollingInterval } from "../src/lib/live-api";
import { LIVE_QUERY_DEFAULTS, preservePriceObservations, sourceIsCurrent, workspaceReads } from "../src/lib/live-freshness";
import type { PriceBook } from "../src/lib/market-types";

const now = Date.parse("2026-09-09T12:00:00Z");

test("source cooldown retries at its deadline instead of multiplying a slow view's polling interval", () => {
  const error = new DataError("Provider cooling down", 429, now + 45000);
  assert.equal(pollingInterval(300000, error, 6, undefined, now), 46000);
  assert.equal(pollingInterval(300000, error, 6, undefined, now + 50000), 1000);
  assert.equal(pollingInterval(15000, error, 1, new Date(now + 90000).toISOString(), now), 91000);
  assert.equal(pollingInterval(120000, null, 0, new Date(now + 30000).toISOString(), now), 31000);
  assert.equal(pollingInterval(15000, null, 0, "invalid", now), 15000);
  assert.equal(pollingInterval(300000, new Error("Offline"), 8, undefined, now), 120000);
});

test("unrelated workspaces do not request unused chain or issuer price feeds", () => {
  for (const view of ["portfolio", "lending", "desk", "rewards", "learn", "activity", "planner", "routes", "check"]) {
    const reads = workspaceReads(view);
    assert.equal(reads.network, false, `${view} should use its own data source`);
    assert.equal(reads.prices, false, `${view} does not render the issuer price book`);
  }
  assert.equal(workspaceReads("infrastructure").network, true);
  assert.equal(workspaceReads("rewards").registry, false);
  assert.equal(workspaceReads("lending").registry, true);
  assert.equal(workspaceReads("terminal").priceInterval, 15000);
  assert.equal(workspaceReads("markets").priceInterval, 60000);
});

test("a partial quote refresh preserves failed symbols without creating fresh timestamps or replacing good new quotes", () => {
  const previous: PriceBook = { fetchedAt: "2026-09-09T11:59:30Z", quotes: [
    { symbol: "NVDA", bid: "150", ask: "151", currency: "USD", halted: false, generatedAt: "2026-09-09T11:59:25Z" },
    { symbol: "AAPL", bid: "220", ask: "221", currency: "USD", halted: false, generatedAt: "2026-09-09T11:59:28Z" },
  ] };
  const next: PriceBook = { fetchedAt: "2026-09-09T12:00:00Z", quotes: [
    { symbol: "AAPL", bid: "222", ask: "223", currency: "USD", halted: false, generatedAt: "2026-09-09T11:59:59Z" },
  ], unavailableSymbols: ["NVDA"] };
  const merged = preservePriceObservations(previous, next);
  assert.deepEqual(merged.quotes.find((q) => q.symbol === "NVDA"), previous.quotes[0]);
  assert.deepEqual(merged.quotes.find((q) => q.symbol === "AAPL"), next.quotes[0]);
  assert.deepEqual(merged.cachedSymbols, ["NVDA"]);
  assert.equal(merged.fetchedAt, previous.fetchedAt);
  assert.equal(next.quotes.length, 1, "The received source object remains unchanged");
  assert.equal(preservePriceObservations(previous, { ...next, unavailableSymbols: [] }).quotes.length, 1);
});

test("initial, invalid and future timestamps never look like fresh source data", () => {
  assert.equal(sourceIsCurrent("2026-09-09T12:00:00Z", 0, 90000), false);
  assert.equal(sourceIsCurrent("invalid", now, 90000), false);
  assert.equal(sourceIsCurrent("2026-09-09T12:01:00Z", now, 90000), false);
  assert.equal(sourceIsCurrent("2026-09-09T11:58:00Z", now, 90000), false);
  assert.equal(sourceIsCurrent("2026-09-09T11:59:45Z", now, 90000), true);
  assert.equal(ageLabel("2026-09-09T12:00:00Z", 0), "Awaiting source");
  assert.equal(ageLabel("2026-09-09T12:10:00Z", now), "Awaiting source");
  assert.equal(ageLabel("2026-09-09T11:59:45Z", now), "15s ago");
});

test("returning focus and connectivity refreshes stale active queries but leaves fresh and inactive queries alone", async () => {
  const client = new QueryClient({ defaultOptions: { queries: LIVE_QUERY_DEFAULTS } });
  const calls = { stale: 0, fresh: 0, disabled: 0 };
  const focused = focusManager.isFocused(), online = onlineManager.isOnline();
  focusManager.setFocused(false);
  onlineManager.setOnline(true);
  client.mount();
  const observers = (Object.keys(calls) as (keyof typeof calls)[]).map((kind) => {
    client.setQueryData(["freshness", kind], "previous", { updatedAt: kind === "fresh" ? Date.now() : Date.now() - 120000 });
    const observer = new QueryObserver(client, { queryKey: ["freshness", kind], queryFn: async () => { calls[kind]++; return "updated"; }, staleTime: 60000, enabled: kind !== "disabled", refetchOnMount: false });
    return observer.subscribe(() => {});
  });
  try {
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(calls, { stale: 1, fresh: 0, disabled: 0 });
    client.setQueryData(["freshness", "stale"], "previous", { updatedAt: Date.now() - 120000 });
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(calls, { stale: 2, fresh: 0, disabled: 0 });
  } finally {
    observers.forEach((unsubscribe) => unsubscribe());
    client.unmount();
    client.clear();
    focusManager.setFocused(focused);
    onlineManager.setOnline(online);
  }
});
