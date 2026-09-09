"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, CalendarClock, Check, CircleHelp, Clock3, Coins, FileCheck2, RefreshCw, Users, Wallet as WalletIcon } from "lucide-react";
import { formatUnits } from "viem";
import { ageLabel, getData, pollingInterval, shortAddress } from "@/lib/live-api";
import { CHAIN_ID, EXPLORER } from "@/lib/market-types";
import type { RewardsReport, RewardsSnapshot } from "@/lib/rewards-types";
import { WalletButton, type WalletState } from "./wallet";
import "./token-rewards.css";

function amount(value: string | null | undefined, decimals = 18, places = 6) {
  if (value == null || !/^\d+$/.test(value)) return "—";
  const [whole, fraction = ""] = formatUnits(BigInt(value), decimals).split(".");
  const trimmed = fraction.slice(0, places).replace(/0+$/, "");
  if (whole === "0" && !trimmed && BigInt(value) > BigInt(0)) return `<0.${"0".repeat(places - 1)}1`;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${trimmed ? `.${trimmed}` : ""}`;
}
function share(weight: string, total: string) {
  if (!/^\d+$/.test(weight) || !/^\d+$/.test(total) || BigInt(total) === BigInt(0) || BigInt(weight) > BigInt(total)) return "—";
  const scaled = BigInt(weight) * BigInt(100000000) / BigInt(total);
  return scaled === BigInt(0) && BigInt(weight) > BigInt(0) ? "<0.000001%" : `${formatUnits(scaled, 6)}%`;
}
function time(value: string | null | undefined) {
  if (!value) return "Awaiting schedule";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Awaiting schedule";
}
function interval(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${seconds / 60} minutes`;
}
function Notice({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <div className={`rewards-notice ${warning ? "is-warning" : ""}`} role="status"><CircleHelp size={17}/><p>{children}</p></div>;
}
function AddressLink({ address, label }: { address: string; label?: string }) {
  return <a className="rewards-address" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" title={address}>{label ?? shortAddress(address)}<ArrowUpRight size={12}/></a>;
}
function Metric({ label, value, unit, note }: { label: string; value: string; unit?: string; note?: ReactNode }) {
  return <div className="rewards-metric"><span>{label}</span><strong>{value}{unit && <> <small>{unit}</small></>}</strong>{note && <p>{note}</p>}</div>;
}
function serviceMessage(report: RewardsReport | null, stale: boolean) {
  if (!report) return "Token and payout service configuration is pending.";
  if (stale) return "The payout service has not provided a recent update. The schedule and amounts below may be out of date.";
  const reasons: Record<RewardsReport["statusReason"], string> = {
    none: "", paused: "Automatic payouts are paused.", "insufficient-funds": "The payout wallet needs funds before payments can continue.",
    "gas-unavailable": "The payout wallet needs ETH for transaction fees.", "rpc-unavailable": "The payout service cannot read the network right now.",
    "payment-pending": "Waiting for a submitted payment to confirm.", "operator-attention": "The payout service needs attention before it can continue.",
  };
  if (reasons[report.statusReason]) return reasons[report.statusReason];
  if (report.status === "paused") return "Automatic payouts are paused.";
  if (report.status === "attention") return "The payout service needs attention before it can continue.";
  if (BigInt(report.totals.collected) === BigInt(0)) return "Waiting for creator fees. Automatic payouts begin when income is available.";
  if (BigInt(report.totals.unallocated) === BigInt(0) && BigInt(report.totals.reservedForHolders) === BigInt(0)) return "Waiting for new creator fees. Previous holder allocations have been paid.";
  return "The service checks available fees and sends funded holder allocations automatically.";
}

function PersonalRewards({ report, wallet }: { report: RewardsReport | null; wallet: WalletState }) {
  const personal = report?.wallet?.address.toLowerCase() === wallet.account?.toLowerCase() ? report?.wallet : null;
  const asset = report?.rewardAsset.symbol ?? "ETH / USDG", decimals = report?.rewardAsset.decimals ?? 18;
  return <section className="rewards-panel rewards-participation">
    <span className="rewards-tag"><Users size={12}/>Automatic holder payouts</span>
    <h2>Your share, sent to you.</h2>
    <p>Your allocation follows your eligible token holdings at each payout snapshot. Payments arrive in your wallet automatically.</p>
    {!wallet.account ? <><WalletButton wallet={wallet}/><p className="rewards-wallet-note">Connect to view your holdings and payment history. Viewing rewards does not request a payment signature.</p></> : <>
      <WalletButton wallet={wallet}/>
      <span className="rewards-account"><WalletIcon size={12}/>{wallet.chainId === CHAIN_ID ? "Connected on Robinhood Chain" : "Viewing Robinhood Chain rewards · wallet network unchanged"}</span>
      <div className="rewards-personal-total"><span>Confirmed received</span><strong>{amount(personal?.paid, decimals)}<small>{asset}</small></strong></div>
      <div className="rewards-metrics">
        <Metric label="Reported token balance" value={amount(personal?.tokenBalance, report?.tokenDecimals ?? 18, 4)} unit={report?.tokenSymbol} note={personal && report ? `Read at block ${report.balanceAsOfBlock}.` : "Available after the payout service is configured."}/>
        <Metric label="Your eligible snapshot share" value={personal?.snapshotEpochId ? share(personal.eligibleWeight, personal.totalEligibleWeight) : "—"} note={personal?.snapshotEpochId ? `Snapshot #${personal.snapshotEpochId} · ${amount(personal.eligibleWeight, report?.tokenDecimals ?? 18, 4)} eligible tokens.` : "Appears after your first reported snapshot."}/>
        <Metric label="Earned allocations" value={amount(personal?.earned, decimals)} unit={asset} note="Received plus amounts awaiting payment."/>
        <Metric label="Awaiting automatic payment" value={amount(personal?.pending, decimals)} unit={asset} note="Allocated by the payout service; not yet received."/>
      </div>
      <p className="rewards-wallet-note">Amounts come from the payout service’s ledger. Only confirmed transfers count as received. A later token purchase does not change an earlier snapshot.</p>
    </>}
  </section>;
}

function PaymentHistory({ report, account }: { report: RewardsReport | null; account: string | null }) {
  const personal = report?.wallet?.address.toLowerCase() === account?.toLowerCase() ? report?.wallet : null;
  if (!personal?.receipts.length) return null;
  return <section className="rewards-panel rewards-history"><div className="rewards-heading"><div><h2>Your confirmed payments</h2><p>Recent transfers reported as confirmed, with receipts you can inspect.</p></div><Check size={21}/></div>
    {personal.receipts.map((receipt) => <div className="rewards-receipt" key={`${receipt.transactionHash}:${receipt.epochId}`}><div><strong>{amount(receipt.amount, report?.rewardAsset.decimals)} {report?.rewardAsset.symbol}</strong><p>Distribution #{receipt.epochId} · Block {receipt.blockNumber}{receipt.confirmedAt ? ` · ${time(receipt.confirmedAt)}` : ""}</p></div><a className="rewards-text-button" href={`${EXPLORER}/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">View receipt<ArrowUpRight size={13}/></a></div>)}
  </section>;
}

export function TokenRewards({ wallet, now }: { wallet: WalletState; now: number }) {
  const [pagination, setPagination] = useState<{ account: string | null; cursors: string[] }>({ account: wallet.account, cursors: [] });
  const cursors = pagination.account === wallet.account ? pagination.cursors : [];
  const before = cursors.at(-1);
  const query = new URLSearchParams(); if (wallet.account) query.set("address", wallet.account); if (before) query.set("before", before);
  const snapshot = useQuery({ queryKey: ["token-rewards-wallet-payouts", wallet.account, before], queryFn: ({ signal }) => getData<RewardsSnapshot>(`rewards${query.size ? `?${query}` : ""}`, signal), staleTime: 20000, refetchInterval: (q) => pollingInterval(20000, q.state.error, q.state.fetchFailureCount) });
  const report = snapshot.data?.report ?? null;
  const asset = report?.rewardAsset.symbol ?? "ETH / USDG", decimals = report?.rewardAsset.decimals ?? 18;
  const reportAge = report ? now - Date.parse(report.updatedAt) : Infinity;
  const stale = !!snapshot.error || snapshot.data?.status === "stale" || reportAge > 20 * 60000 || !Number.isFinite(reportAge);
  const serviceCurrent = snapshot.data?.status === "reported" && !stale;
  const nextRun = !report ? "After service setup" : stale ? "Awaiting service update" : report.status === "paused" ? "Paused" : report.nextRunAt && Date.parse(report.nextRunAt) <= now ? "Scheduled run due" : time(report.nextRunAt);
  const statusLabel = snapshot.isPending ? "Reading payout service" : snapshot.data?.status === "unconfigured" ? "Payout setup pending" : !report ? "Payout data unavailable" : stale ? "Last available service report" : report.status === "ready" ? "Payout service reporting" : report.status === "paused" ? "Payouts paused" : "Payout service needs attention";
  return <div className="rewards-workspace">
    <div className={`rewards-status ${serviceCurrent ? "is-current" : ""}`}><div><i/><strong>{statusLabel}</strong><span className="rewards-status-time">{report ? `Updated ${ageLabel(report.updatedAt, now)}` : "Robinhood Chain"}</span></div><button className="rewards-button" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}><RefreshCw size={13}/>{snapshot.isFetching ? "Updating" : "Refresh"}</button></div>
    {(snapshot.error || snapshot.data?.status === "unconfigured" || snapshot.data?.status === "unavailable" || snapshot.data?.status === "stale") && <Notice warning={!!snapshot.error || snapshot.data?.status !== "unconfigured"}>{snapshot.error?.message ?? snapshot.data?.message}</Notice>}
    <div className="rewards-overview"><section className="rewards-panel"><div className="rewards-heading"><div><h2>Trading fees, shared.</h2><p>75% of received creator fees goes to eligible holders.</p></div><Coins size={22}/></div>
      <div className="rewards-total"><span>Confirmed paid to holders</span><strong>{amount(report?.totals.paidToHolders, decimals)}<small>{asset}</small></strong><p>Completed payments reported by the payout service. Pending allocations are shown separately.</p></div>
      <div className="rewards-metrics">
        <Metric label="Creator fees received" value={amount(report?.totals.collected, decimals)} unit={asset} note="Pons income recorded for the fee-receiving wallet."/>
        <Metric label="Allocated to holders" value={amount(report?.totals.allocatedToHolders, decimals)} unit={asset} note="Includes completed and pending holder payments."/>
        <Metric label="Awaiting holder payments" value={amount(report?.totals.reservedForHolders, decimals)} unit={asset} note="Unpaid allocations recorded by the service."/>
        <Metric label="Developer share" value={amount(report?.totals.retainedByDeveloper, decimals)} unit={asset} note="The remaining 25% stays with the fee receiver."/>
      </div>
      <div className="rewards-panel-footer"><span>Fee receiver · {report ? <AddressLink address={report.feeWallet}/> : "Not configured"}</span><span>{report ? <AddressLink address={report.token} label={report.tokenSymbol}/> : "Token launch pending"}</span></div>
    </section><PersonalRewards report={report} wallet={wallet}/></div>
    <section className="rewards-panel rewards-policy"><div className="rewards-heading"><div><h2>One fee pool. Two shares.</h2><p>The split applies to creator fees received, before allocating each holder’s proportional share. The fee receiver’s token holdings also participate in the 75% holder pool, in addition to its 25% developer share.</p></div><span className="rewards-tag">Fixed 75 / 25</span></div>
      <div className="rewards-split"><div className="rewards-split-track" role="img" aria-label="75 percent to eligible token holders and 25 percent retained by the fee receiver"><span/><span/></div><div className="rewards-split-labels"><div><strong>75%</strong><span>Token holders</span><p>Paid in proportion to eligible snapshot holdings.</p></div><div><strong>25%</strong><span>Fee receiver / developer</span><p>Retained in the fee-receiving wallet.</p></div></div></div>
      <div className="rewards-schedule"><div><span><CalendarClock size={14}/>Payout interval</span><strong>Every {interval(report?.intervalSeconds ?? 900)}</strong><p>Scheduled checks require collected fees and an operating payout service.</p></div><div><span><Clock3 size={14}/>Next scheduled run</span><strong>{nextRun}</strong><p>{serviceMessage(report, stale)}</p></div><div><span><Coins size={14}/>Payout asset</span><strong>{report ? report.rewardAsset.symbol : "Set at token launch"}</strong><p>Rewards are paid in the fee asset: ETH or USDG.</p></div></div>
      {report && <details className="rewards-eligibility"><summary>Which holdings are eligible?</summary><p>The service calculates each share from the snapshot’s eligible token balance. The following addresses are excluded from holder allocations.</p>{report.exclusions.length ? <ul>{report.exclusions.map((entry) => <li key={entry.address}><AddressLink address={entry.address}/><span>{entry.reason}</span></li>)}</ul> : <p>No excluded addresses are listed in the current service report.</p>}</details>}
    </section>
    <section className="rewards-panel rewards-history"><div className="rewards-heading"><div><h2>Distribution history</h2><p>Collected income, snapshot allocations and automatic payment progress.</p></div><span className="rewards-tag">{report?.epochs.length ?? 0} loaded</span></div>
      {report?.epochs.length ? report.epochs.map((epoch) => <article className="rewards-epoch" key={epoch.id}><div className="rewards-epoch-heading"><div><h3>Distribution #{epoch.id}</h3><span className={`rewards-tag ${epoch.status === "attention" ? "is-warning" : ""}`}>{epoch.status === "completed" ? <Check size={11}/> : <Clock3 size={11}/>}{{ scheduled: "Awaiting payment", paying: "Sending payments", completed: "Paid", attention: "Payout delayed" }[epoch.status]}</span></div><time dateTime={epoch.createdAt}>{time(epoch.createdAt)}</time></div>
        <div className="rewards-epoch-metrics"><Metric label="Creator fees received" value={amount(epoch.collected, decimals)} unit={asset}/><Metric label="Holder allocation" value={amount(epoch.holderBudget, decimals)} unit={asset}/><Metric label="Confirmed paid" value={amount(epoch.paid, decimals)} unit={asset}/><Metric label="Awaiting payment" value={amount(epoch.remaining, decimals)} unit={asset}/></div>
        <div className="rewards-epoch-footnote"><a className="rewards-text-button" href={`${EXPLORER}/block/${epoch.snapshotBlock}`} target="_blank" rel="noreferrer">Snapshot block {epoch.snapshotBlock}<ArrowUpRight size={11}/></a><span>{amount(epoch.eligibleSupply, report.tokenDecimals, 4)} eligible {report.tokenSymbol}</span></div>
      </article>) : <div className="rewards-empty"><FileCheck2 size={28}/><h3>The first payout starts the record.</h3><p>{report ? "No distributions have been reported yet. Payments start when creator fees are collected and a funded holder snapshot is prepared." : "Rewards are not live yet. Real income, holder allocations and completed payments will appear here once available."}</p></div>}
      {(cursors.length > 0 || report?.nextCursor) && <div className="rewards-panel-footer"><button className="rewards-text-button" disabled={!cursors.length || snapshot.isFetching} onClick={() => setPagination({ account: wallet.account, cursors: cursors.slice(0, -1) })}>Newer distributions</button><span>Showing the loaded distribution page.</span><button className="rewards-text-button" disabled={!report?.nextCursor || snapshot.isFetching} onClick={() => { if (report?.nextCursor) setPagination({ account: wallet.account, cursors: [...cursors, report.nextCursor] }); }}>Older distributions<ArrowRight size={12}/></button></div>}
    </section>
    <PaymentHistory report={report} account={wallet.account}/>
    <section className="rewards-panel rewards-flow" aria-label="How automatic rewards work"><div><Coins size={25}/><h3>1. Trading generates creator fees</h3><p>Pons sends the creator’s share to the configured fee-receiving wallet.</p></div><div><Users size={25}/><h3>2. Holdings determine each allocation</h3><p>The payout service records eligible holdings. Your share is your snapshot balance divided by the total eligible balance.</p></div><div><WalletIcon size={25}/><h3>3. Payments reach your wallet</h3><p>The service sends holder allocations automatically. Completed transfers appear in your payment history.</p></div></section>
    <div className="rewards-workspace-footer"><span>Balances and allocations are reported by the payout service. Confirmed payment receipts can be inspected onchain.</span>{report ? <AddressLink address={report.feeWallet} label="View fee receiver"/> : <a className="rewards-text-button" href={EXPLORER} target="_blank" rel="noreferrer">Robinhood Chain explorer<ArrowUpRight size={12}/></a>}</div>
  </div>;
}
