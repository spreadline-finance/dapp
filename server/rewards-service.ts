import { getAddress, isAddress, type Address } from "viem";
import { sameRewardsReportIdentity, validateRewardsReport } from "../src/lib/rewards-report";
import type { RewardsReport, RewardsSnapshot } from "../src/lib/rewards-types";

export type RewardsConfig = { REWARDS_REPORT_URL?: string };
const MAX_REPORT_BYTES = 512_000;
const REQUEST_TIMEOUT_MS = 8_000;
const STALE_AFTER_MS = 20 * 60_000;

function reportEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("Invalid report endpoint configuration.");
  return url;
}

async function boundedJSON(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REPORT_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Report exceeds the response limit.");
  }
  if (!response.body) throw new Error("Report response is empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0, text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_REPORT_BYTES) throw new Error("Report exceeds the response limit.");
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Read-only adapter. No signing keys, user-selected targets, shared wallet cache or onchain claims. */
export function createRewardsService(config: RewardsConfig, fetcher: typeof fetch = fetch) {
  async function snapshot(account?: Address, before?: bigint | string): Promise<RewardsSnapshot> {
    const base: RewardsSnapshot = { status: "unconfigured", message: "The automatic reward service is not connected. No earnings or payment totals are available.", chainId: 4663, fetchedAt: new Date().toISOString(), report: null };
    if (!config.REWARDS_REPORT_URL?.trim()) return base;
    try {
      if (account && !isAddress(account, { strict: false })) throw new Error("Invalid wallet address.");
      const wallet = account ? getAddress(account) : undefined;
      const cursor = before === undefined ? undefined : String(before);
      if (cursor !== undefined && !/^[1-9]\d{0,15}$/.test(cursor)) throw new Error("Invalid pagination cursor.");
      const endpoint = reportEndpoint(config.REWARDS_REPORT_URL.trim());
      const headers: Record<string, string> = { accept: "application/json", "cache-control": "no-store" };
      if (/(?:^|\.)ngrok-free\.(?:dev|app)$|(?:^|\.)ngrok\.(?:app|io)$/.test(endpoint.hostname)) {
        headers["ngrok-skip-browser-warning"] = "1";
      }
      async function read(walletAddress?: Address, page?: string): Promise<RewardsReport> {
        const url = new URL(endpoint);
        if (walletAddress) url.searchParams.set("wallet", walletAddress);
        if (page) url.searchParams.set("before", page);
        // Workers supports manual redirects; non-2xx responses below are rejected.
        const response = await fetcher(url.toString(), { method: "GET", redirect: "manual", cache: "no-store", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok || response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Reward service unavailable.");
        }
        const report = validateRewardsReport(await boundedJSON(response));
        if (Date.parse(report.updatedAt) > Date.now() + 60_000) throw new Error("Report is dated in the future.");
        if (report.wallet?.currentPosition && Date.parse(report.wallet.currentPosition.observedAt) > Date.now() + 60_000) throw new Error("Current position is dated in the future.");
        if (page && report.epochs.some(epoch => BigInt(epoch.id) >= BigInt(page))) throw new Error("Report pagination differs from request.");
        if (walletAddress ? !report.wallet || report.wallet.address.toLowerCase() !== walletAddress.toLowerCase() : report.wallet !== null) throw new Error("Report wallet differs from request.");
        return report;
      }
      // Only this request holds the baseline identity. Wallet responses are never
      // placed in the application's shared market-data cache or reused by account.
      const report = wallet ? await (async () => {
        const [identity, personal] = await Promise.all([read(), read(wallet, cursor)]);
        if (!sameRewardsReportIdentity(identity, personal)) throw new Error("Reward service identity changed during wallet lookup.");
        return personal;
      })() : await read(undefined, cursor);
      const stale = Date.now() - Date.parse(report.updatedAt) > STALE_AFTER_MS;
      return { ...base, status: stale ? "stale" : "reported", report,
        message: stale ? "This reward-service report is out of date. Displayed payments and allocations may have changed."
          : "Reported by the automatic payout service. Amounts and transaction references have not been independently verified by this dashboard." };
    } catch {
      // Upstream failures may contain private endpoints, credentials or journal
      // fragments. Return a fixed public message and no invented balances.
      return { ...base, status: "unavailable", message: "The reward service is unavailable or returned an inconsistent report. Current earnings and payment totals cannot be confirmed." };
    }
  }
  return { snapshot };
}
