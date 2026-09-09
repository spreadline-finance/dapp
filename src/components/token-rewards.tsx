"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, CalendarClock, Check, ChevronDown, CircleHelp, Clock3, Coins, FileCheck2, LoaderCircle, RefreshCw, Users, Wallet as WalletIcon } from "lucide-react";
import { formatUnits } from "viem";
import { ageLabel, DataError, getData, pollingInterval, shortAddress } from "@/lib/live-api";
import { sourceIsCurrent } from "@/lib/live-freshness";
import { CHAIN_ID, EXPLORER } from "@/lib/market-types";
import { currentRewardPosition, distributionCountdown, distributionTotals, estimatedAdditionalReward, rewardsServiceMessage } from "@/lib/rewards-preview";
import { rewardPriceIsCurrent, rewardUsdValue, type RewardUsdPrice } from "@/lib/rewards-usd";
import type { RewardsReport, RewardsSnapshot } from "@/lib/rewards-types";
import { WalletButton, type WalletState } from "./wallet";
import { SpreadTokenIcon } from "./spread-token";
import "./token-rewards.css";

function amount(value: string | null | undefined, decimals = 18, places = 9) {
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
  if (seconds < 60) return `${seconds} seconds`;
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
function RewardsIntroduction({ report }: { report?: RewardsReport }) {
  if (report) return <header className="rewards-page-header">
    <div className="rewards-header-copy"><div className="rewards-page-title"><SpreadTokenIcon size={40}/><div><span>HOLDER REWARDS · {report.tokenSymbol}</span><h1>Token rewards</h1></div></div><p>Your share of creator fees, sent directly to your wallet.</p></div>
    <div className="rewards-header-art" aria-hidden="true"><Image src="/artwork/spread-rewards.webp" width={1536} height={1024} alt="" loading="eager" unoptimized/></div>
  </header>;
  return <section className="rewards-brand-hero" aria-labelledby="spread-rewards-title">
    <div className="rewards-brand-copy">
      <div className="rewards-token-identity"><SpreadTokenIcon size={48}/><span><strong>SPREAD</strong><span>Spreadline token rewards</span></span></div>
      <h1 className="display" id="spread-rewards-title">Trading fees,<br/><em>shared.</em></h1>
      <p>Creator-fee rewards for eligible SPREAD holders. Follow your allocations and confirmed payments in one place.</p>
    </div>
    <div className="rewards-brand-art" aria-hidden="true"><Image src="/artwork/spread-rewards.webp" width={1536} height={1024} alt="" loading="eager" unoptimized/></div>
  </section>;
}
function RewardsLaunchGuide() {
  return <section className="rewards-launch-guide" aria-labelledby="rewards-model-heading">
    <div className="rewards-model-flow">
      <span className="rewards-model-eyebrow">The reward model</span>
      <h2 id="rewards-model-heading">From trading activity to holders.</h2>
      <ol className="rewards-visual-steps">
        <li><span className="rewards-step-icon"><Coins size={23}/></span><strong>Creator fees</strong><span>Collected from trading</span></li>
        <li><span className="rewards-step-icon"><Users size={23}/></span><strong>Holder snapshot</strong><span>Sets each eligible share</span></li>
        <li><span className="rewards-step-icon"><WalletIcon size={23}/></span><strong>Wallet payouts</strong><span>Confirmed onchain</span></li>
      </ol>
      <p>Payments begin after setup, when fees are available and a funded payout run is ready.</p>
    </div>
    <div className="rewards-model-split">
      <div className="rewards-share-ring" role="img" aria-label="Creator fee split: 75 percent to eligible holders, 25 percent retained by the fee receiver"><span><strong>75<small>%</small></strong><span>to holders</span></span></div>
      <div className="rewards-share-key"><span><i/>75% eligible holders</span><span><i/>25% fee receiver</span></div>
    </div>
  </section>;
}
const RewardPriceContext = createContext<{ quote: RewardUsdPrice | null; asset: string; decimals: number; now: number } | null>(null);
function UsdEquivalent({ value }: { value: string | null | undefined }) {
  const context = useContext(RewardPriceContext);
  const usd = context ? rewardUsdValue(value, context.decimals, context.quote, context.asset, context.now) : null;
  return usd === null ? null : <span className="rewards-usd" title="Estimated USD value at the current reference price">{usd} USD</span>;
}
function Metric({ label, value, unit, note, rewardRaw }: { label: string; value: string; unit?: string; note?: ReactNode; rewardRaw?: string | null }) {
  return <div className="rewards-metric"><span>{label}</span><strong>{value}{unit && <> <small>{unit}</small></>}</strong><UsdEquivalent value={rewardRaw}/>{note && <p>{note}</p>}</div>;
}
function PersonalRewards({ report, wallet, stale, now, readFailed }: { report: RewardsReport; wallet: WalletState; stale: boolean; now: number; readFailed: boolean }) {
  const personal = report.wallet?.address.toLowerCase() === wallet.account?.toLowerCase() ? report.wallet : null;
  const asset = report.rewardAsset.symbol, decimals = report.rewardAsset.decimals;
  const position = personal && !readFailed ? currentRewardPosition(report, now) : null;
  const estimate = personal ? estimatedAdditionalReward(report, stale, now) : null;
  if (!wallet.account || !personal) return <aside className="rewards-panel rewards-wallet-prompt"><span className="rewards-prompt-icon"><WalletIcon size={25} aria-hidden="true"/></span><div><span className="rewards-eyebrow">YOUR WALLET</span><h2>Your rewards start here</h2><p>{!wallet.account ? "Connect your wallet to see your estimated rewards, pending payments and holdings." : "Your wallet’s balances and allocations are missing from this report. Refresh to check again."}</p><WalletButton wallet={wallet}/><span className="rewards-prompt-footnote">Automatic payments · No claim needed</span></div></aside>;
  return <section className="rewards-panel rewards-participation">
    <span className="rewards-tag"><Users size={12}/>Automatic holder payouts</span>
    <h2>Your rewards</h2>
    <p>Rewards are sent automatically to this wallet when payouts are running and your allocation is ready. No claim transaction needed.</p>
      <WalletButton wallet={wallet}/>
      <span className="rewards-account"><WalletIcon size={12}/>{wallet.chainId === CHAIN_ID ? "Connected on Robinhood Chain" : "Viewing Robinhood Chain rewards · wallet network unchanged"}</span>
      <div className="rewards-personal-summary"><div className="rewards-personal-total"><span>Earned · awaiting payment</span><strong>{amount(personal.pending, decimals)}<small>{asset}</small></strong><UsdEquivalent value={personal.pending}/></div><div className="rewards-received-total"><span>Received so far</span><strong>{amount(personal.paid, decimals)} <small>{asset}</small></strong><UsdEquivalent value={personal.paid}/></div></div>
      <div className="rewards-metrics">
        <Metric label={position ? "Confirmed token balance" : "Last reported token balance"} value={amount(personal.tokenBalance, report.tokenDecimals, 4)} unit={report.tokenSymbol} note={position ? `Block ${position.blockNumber} · checked ${ageLabel(position.observedAt, now)}. Refreshes every 20 seconds.` : `Reported at block ${report.balanceAsOfBlock}. Waiting for a current ownership check.`}/>
        <Metric label="Current eligible share" value={position ? share(position.eligibleWeight, position.totalEligibleWeight) : "—"} note={position ? `${amount(position.eligibleWeight, report.tokenDecimals, 4)} of ${amount(position.totalEligibleWeight, report.tokenDecimals, 4)} eligible tokens. Final share is set at the next snapshot.` : "No current share is available. Earlier snapshot weights are not used as current holdings."}/>
        <Metric label="Earned allocations" value={amount(personal?.earned, decimals)} rewardRaw={personal?.earned} unit={asset} note="Received plus amounts awaiting payment."/>

      </div>
      <div className="rewards-estimate"><Metric label="Estimated share of fees awaiting allocation" value={amount(estimate, decimals)} rewardRaw={estimate} unit={estimate === null ? undefined : asset} note={stale ? "Waiting for fresh accounting before estimating." : estimate === null ? "A fresh ownership check and a nonzero eligible supply are needed to estimate." : "Uses your current eligible share and collected fees not yet allocated. Excludes fees still on Pons. This is provisional and separate from earned pending rewards."}/></div>
      <p className="rewards-wallet-note">{personal.snapshotEpochId ? `Last allocation #${personal.snapshotEpochId} used a ${share(personal.eligibleWeight, personal.totalEligibleWeight)} share. ` : "No allocation snapshot has been recorded yet. "}Buying, selling or transferring changes future snapshot shares. Rewards already earned remain payable to the wallet that earned them.</p>
  </section>;
}

function PaymentHistory({ report, account }: { report: RewardsReport | null; account: string | null }) {
  const personal = report?.wallet?.address.toLowerCase() === account?.toLowerCase() ? report?.wallet : null;
  if (!personal?.receipts.length) return null;
  return <section className="rewards-panel rewards-history"><div className="rewards-heading"><div><h2>Your confirmed payments</h2><p>Recent transfers reported as confirmed, with receipts you can inspect.</p></div><Check size={21}/></div>
    {personal.receipts.map((receipt) => <div className="rewards-receipt" key={`${receipt.transactionHash}:${receipt.epochId}`}><div><strong>{amount(receipt.amount, report?.rewardAsset.decimals)} {report?.rewardAsset.symbol}</strong><UsdEquivalent value={receipt.amount}/><p>Distribution #{receipt.epochId} · Block {receipt.blockNumber}{receipt.confirmedAt ? ` · ${time(receipt.confirmedAt)}` : ""}</p></div><a className="rewards-text-button" href={`${EXPLORER}/tx/${receipt.transactionHash}`} target="_blank" rel="noreferrer">View receipt<ArrowUpRight size={13}/></a></div>)}
  </section>;
}

export function TokenRewards({ wallet, now }: { wallet: WalletState; now: number }) {
  const [pagination, setPagination] = useState<{ account: string | null; cursors: string[] }>({ account: wallet.account, cursors: [] });
  const cursors = pagination.account === wallet.account ? pagination.cursors : [];
  const before = cursors.at(-1);
  const query = new URLSearchParams(); if (wallet.account) query.set("address", wallet.account); if (before) query.set("before", before);
  const snapshot = useQuery({ queryKey: ["token-rewards-wallet-payouts", wallet.account, before], queryFn: ({ signal }) => getData<RewardsSnapshot>(`rewards${query.size ? `?${query}` : ""}`, signal), staleTime: 20000, refetchInterval: (q) => pollingInterval(q.state.data?.status === "unconfigured" ? 60000 : 20000, q.state.error, q.state.fetchFailureCount) });
  const report = snapshot.data?.report ?? null;
  const asset = report?.rewardAsset.symbol ?? "ETH / USDG", decimals = report?.rewardAsset.decimals ?? 18;
  const usdPrice = useQuery({ queryKey: ["reward-usd-price"], queryFn: ({ signal }) => getData<RewardUsdPrice>("reward-price", signal), enabled: report?.rewardAsset.symbol === "ETH", staleTime: 60000, refetchInterval: q => pollingInterval(60000, q.state.error, q.state.fetchFailureCount) });
  const currentPrice = rewardPriceIsCurrent(usdPrice.data, asset, now) ? usdPrice.data : null;
  const stale = !!snapshot.error || snapshot.data?.status === "stale" || !sourceIsCurrent(report?.updatedAt, now, 20 * 60000);
  const serviceCurrent = snapshot.data?.status === "reported" && !stale;
  const pool = report ? distributionTotals(report) : null;
  const nextRun = report ? distributionCountdown(report, now, stale) : "After service setup";
  const scheduleLabel = report?.executionMode === "manual" ? "Operator-triggered" : report?.executionMode === "report-only" ? "Reporting only" : `Every ${interval(report?.intervalSeconds ?? 900)}`;
  const statusLabel = snapshot.isPending ? "Reading payout service" : snapshot.data?.status === "unconfigured" ? "Payout setup pending" : !report ? "Payout data unavailable" : stale ? "Last available service report" : report.statusReason === "payment-pending" ? "Transaction awaiting confirmation" : report.status === "attention" ? "Payout service needs attention" : report.executionMode === "report-only" ? "Reporting connected · payouts not running" : report.executionMode === "manual" ? "Operator-triggered distributions" : report.status === "ready" ? "Payout service reporting" : "Payouts paused";
  const refreshWait = snapshot.error instanceof DataError ? Math.max(0, Math.ceil((snapshot.error.retryAt - now) / 1000)) : 0;
  const refreshButton = <button className="rewards-button" disabled={snapshot.isFetching || refreshWait > 0} onClick={() => void snapshot.refetch()}><RefreshCw size={14} className={snapshot.isFetching ? "spin" : ""}/>{snapshot.isFetching ? "Updating…" : refreshWait ? `Retry in ${refreshWait}s` : "Refresh"}</button>;
  if (!report) {
    const pending = snapshot.isPending;
    const unconfigured = snapshot.data?.status === "unconfigured" && !snapshot.error;
    return <div className="rewards-workspace">
      <RewardsIntroduction/>
      <section className="rewards-panel rewards-unavailable" aria-busy={pending} aria-labelledby="rewards-availability-heading">
        <div className="rewards-unavailable-icon" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={26}/> : unconfigured ? <Clock3 size={26}/> : <CircleHelp size={26}/>}</div>
        <div role="status"><h2 id="rewards-availability-heading">{pending ? "Loading rewards…" : unconfigured ? "Rewards are being set up" : "Rewards data is unavailable"}</h2><p>{pending ? "Fetching the latest payout service report." : unconfigured ? "Token and payout service configuration is pending. Fees, allocations and payment history will appear once reporting begins." : "We couldn’t load the payout report. Rewards balances and payment history cannot be confirmed right now."}</p></div>
        {!pending && refreshButton}
      </section>
      {!pending && <p className="rewards-unavailable-note">{unconfigured ? "You can continue exploring markets while rewards are prepared." : "Refresh to try again. A missing report does not indicate a zero balance or a completed payment."}</p>}
      {unconfigured && <RewardsLaunchGuide/>}
    </div>;
  }
  return <RewardPriceContext.Provider value={{ quote: currentPrice, asset, decimals, now }}><div className="rewards-workspace">
    <RewardsIntroduction report={report}/>
    {report.intervalSeconds === 30 && report.executionMode !== "manual" && report.executionMode !== "report-only" && <Notice>Test schedule: checks every 30 seconds. Payments still require collected fees, confirmations and the minimum payout.</Notice>}
    <div className={`rewards-status ${serviceCurrent && report.status === "ready" && report.executionMode !== "report-only" ? "is-current" : "is-warning"}`}><div><i/><strong>{statusLabel}</strong><span className="rewards-status-time">Accounting updated {ageLabel(report.updatedAt, now)}</span></div>{refreshButton}</div>
    {(snapshot.error || snapshot.data?.status === "unconfigured" || snapshot.data?.status === "unavailable" || snapshot.data?.status === "stale") && <Notice warning={!!snapshot.error || snapshot.data?.status !== "unconfigured"}>{snapshot.error?.message ?? snapshot.data?.message}</Notice>}
    <section className="rewards-distribution-summary" aria-labelledby="distribution-totals-title">
      <div className="rewards-summary-heading"><h2 id="distribution-totals-title">Across all holders</h2><span>{stale ? "Last reported totals · update delayed" : "Lifetime totals · payout service report"}</span></div>
      <div className="rewards-summary-grid">
        <Metric label="Distributed so far" value={amount(pool?.paid, decimals)} rewardRaw={pool?.paid} unit={asset} note="Confirmed holder payments recorded by the keeper."/>
        <Metric label={stale ? "Last reported pending" : "Pending distribution"} value={amount(pool?.pending, decimals)} rewardRaw={pool?.pending} unit={asset} note={<>{amount(pool?.allocatedPending, decimals)} {asset} allocated and unpaid · {amount(pool?.awaitingAllocation, decimals)} {asset} holder share awaiting allocation.</>}/>
        <Metric label="Creator fees collected" value={amount(report.totals.collected, decimals)} rewardRaw={report.totals.collected} unit={asset} note="75% goes to holders. Fees not yet collected from Pons are excluded."/>
      </div>
      <p className="rewards-summary-note">{stale ? `Last keeper update: ${time(report.updatedAt)}. These amounts may have changed; a fresh report is needed to confirm current totals.` : "Pending amounts are not guaranteed to arrive in the next run. Allocation, minimum payouts and network confirmations still apply."}</p>
    </section>
    <p className="rewards-price-reference">{currentPrice ? <>USD estimates use the current {asset} price, including past payments. <a href="https://www.coinbase.com/converter/eth/usd" target="_blank" rel="noreferrer">Coinbase</a> · checked {ageLabel(currentPrice.fetchedAt, now)}. Payments remain in {asset}.</> : usdPrice.isFetching && asset === "ETH" ? "Loading USD reference price…" : `USD estimates unavailable. Reward amounts remain shown in ${asset}.`}</p>
    <section className="rewards-panel rewards-distribution-bar" aria-label="Distribution status and minimum payout">
      <div><span className="rewards-eyebrow">Distribution</span><strong className="rewards-distribution-value" role="timer" aria-live="off">{nextRun}</strong></div>
      <Metric rewardRaw={report.minimumPayout} label="Minimum payout · per wallet" value={report.minimumPayout === undefined ? "Not reported" : amount(report.minimumPayout, decimals, decimals)} unit={report.minimumPayout === undefined ? undefined : asset}/>
      <div className="rewards-delivery"><strong><WalletIcon size={15}/>Direct to your wallet · no claim</strong><p>Paid in {asset}. Smaller rewards carry forward.</p><details><summary>Timing &amp; conditions</summary><p>{rewardsServiceMessage(report, stale)} Payments require available funds, the minimum payout and network confirmations.</p></details></div>
    </section>
    <div className="rewards-holder-focus"><PersonalRewards report={report} wallet={wallet} stale={stale} now={now} readFailed={!!snapshot.error}/></div>
    <PaymentHistory report={report} account={wallet.account}/>
    <details className="rewards-panel rewards-policy rewards-pool-breakdown"><summary><span>Pool breakdown</span><span>Allocations &amp; developer share</span><ChevronDown size={16}/></summary><div className="rewards-overview"><section className="rewards-panel"><div className="rewards-heading"><div><h2>Pool overview</h2><p>75% of received creator fees goes to eligible holders.</p></div><Coins size={22}/></div>
      <div className="rewards-total"><span>Confirmed paid to holders</span><strong>{amount(report?.totals.paidToHolders, decimals)}<small>{asset}</small></strong><UsdEquivalent value={report.totals.paidToHolders}/><p>Completed payments reported by the payout service. Pending allocations are shown separately.</p></div>
      <div className="rewards-metrics">
        <Metric label="Creator fees received" value={amount(report?.totals.collected, decimals)} rewardRaw={report?.totals.collected} unit={asset} note="Pons income recorded for the fee-receiving wallet."/>
        <Metric label="Allocated to holders" value={amount(report?.totals.allocatedToHolders, decimals)} rewardRaw={report?.totals.allocatedToHolders} unit={asset} note="Includes completed and pending holder payments."/>
        <Metric label="Awaiting holder payments" value={amount(report?.totals.reservedForHolders, decimals)} rewardRaw={report?.totals.reservedForHolders} unit={asset} note="Unpaid allocations recorded by the service."/>
        <Metric label="Developer share" value={amount(report?.totals.retainedByDeveloper, decimals)} rewardRaw={report?.totals.retainedByDeveloper} unit={asset} note="The remaining 25% stays with the fee receiver."/>
      </div>
      <div className="rewards-panel-footer"><span>Fee receiver · {report ? <AddressLink address={report.feeWallet}/> : "Not configured"}</span><span>{report ? <AddressLink address={report.token} label={report.tokenSymbol}/> : "Token launch pending"}</span></div>
    </section></div></details>
    <section className="rewards-panel rewards-history"><div className="rewards-heading"><div><h2>Distribution history</h2></div><span className="rewards-tag">{report?.epochs.length ?? 0} loaded</span></div>
      {report?.epochs.length ? report.epochs.map((epoch) => <details className="rewards-epoch rewards-epoch-compact" key={epoch.id}><summary><span className="rewards-run-id">#{epoch.id}</span><time dateTime={epoch.createdAt}>{time(epoch.createdAt)}</time><span className={`rewards-tag ${epoch.status === "attention" ? "is-warning" : ""}`}>{epoch.status === "completed" ? <Check size={11}/> : <Clock3 size={11}/>}{{ scheduled: "Awaiting payment", paying: "Sending payments", completed: "Paid", attention: "Payout delayed" }[epoch.status]}</span><span className="rewards-run-paid"><span>Paid</span><strong>{amount(epoch.paid, decimals)} {asset}</strong><UsdEquivalent value={epoch.paid}/></span><ChevronDown size={15}/></summary>
        <div className="rewards-epoch-metrics"><Metric label="Creator fees received" value={amount(epoch.collected, decimals)} rewardRaw={epoch.collected} unit={asset}/><Metric label="Holder allocation" value={amount(epoch.holderBudget, decimals)} rewardRaw={epoch.holderBudget} unit={asset}/><Metric label="Confirmed paid" value={amount(epoch.paid, decimals)} rewardRaw={epoch.paid} unit={asset}/><Metric label="Awaiting payment" value={amount(epoch.remaining, decimals)} rewardRaw={epoch.remaining} unit={asset}/></div>
        <div className="rewards-epoch-footnote"><a className="rewards-text-button" href={`${EXPLORER}/block/${epoch.snapshotBlock}`} target="_blank" rel="noreferrer">Snapshot block {epoch.snapshotBlock}<ArrowUpRight size={11}/></a><span>{amount(epoch.eligibleSupply, report.tokenDecimals, 4)} eligible {report.tokenSymbol}</span></div>
      </details>) : <div className="rewards-empty"><FileCheck2 size={28}/><h3>The first payout starts the record.</h3><p>{report ? "No distributions have been reported yet. Payments start when creator fees are collected and a funded holder snapshot is prepared." : "Rewards are not live yet. Real income, holder allocations and completed payments will appear here once available."}</p></div>}
      {(cursors.length > 0 || report?.nextCursor) && <div className="rewards-panel-footer"><button className="rewards-text-button" disabled={!cursors.length || snapshot.isFetching} onClick={() => setPagination({ account: wallet.account, cursors: cursors.slice(0, -1) })}>Newer distributions</button><span>Showing the loaded distribution page.</span><button className="rewards-text-button" disabled={!report?.nextCursor || snapshot.isFetching} onClick={() => { if (report?.nextCursor) setPagination({ account: wallet.account, cursors: [...cursors, report.nextCursor] }); }}>Older distributions<ArrowRight size={12}/></button></div>}
    </section>
    <details className="rewards-panel rewards-policy"><summary><span>How rewards work</span><span>75% holders · 25% developer</span><ChevronDown size={16}/></summary><div className="rewards-heading"><div><h2>One fee pool. Two shares.</h2><p>The split applies to creator fees received, before allocating each holder’s proportional share. The fee receiver’s token holdings also participate in the 75% holder pool, in addition to its 25% developer share.</p></div><span className="rewards-tag">Fixed 75 / 25</span></div>
      <div className="rewards-split"><div className="rewards-split-track" role="img" aria-label="75 percent to eligible token holders and 25 percent retained by the fee receiver"><span/><span/></div><div className="rewards-split-labels"><div><strong>75%</strong><span>Token holders</span><p>Paid in proportion to eligible snapshot holdings.</p></div><div><strong>25%</strong><span>Fee receiver / developer</span><p>Retained in the fee-receiving wallet.</p></div></div></div>
      <div className="rewards-schedule"><div><span><CalendarClock size={14}/>Distribution mode</span><strong>{scheduleLabel}</strong><p>Each check requires an operating payout service. Available fees, funding and minimum amounts determine whether it sends a payment.</p></div><div><span><Clock3 size={14}/>Next distribution check</span><strong>{nextRun}</strong><p>{rewardsServiceMessage(report, stale)}</p></div><div><span><Coins size={14}/>Payout asset</span><strong>{report ? report.rewardAsset.symbol : "Set at token launch"}</strong><p>Rewards are paid in the fee asset: ETH or USDG.</p></div></div>
      {report && <details className="rewards-eligibility"><summary>Which holdings are eligible?</summary><p>Each allocation uses confirmed token balances at one snapshot block. Tokens received from another wallet count; buying on Pons is not required. Selling or transferring all tokens before a future snapshot gives that wallet no share of that allocation. Previously earned rewards remain payable to the original wallet and do not transfer with the tokens.</p><p>The following addresses are excluded from new holder allocations.</p>{report.exclusions.length ? <ul>{report.exclusions.map((entry) => <li key={entry.address}><AddressLink address={entry.address}/><span>{entry.reason}</span></li>)}</ul> : <p>No excluded addresses are listed in the current service report.</p>}</details>}
        <section className="rewards-flow" aria-label="How automatic rewards work"><div><Coins size={25}/><h3>1. Trading generates creator fees</h3><p>Pons sends the creator’s share to the configured fee-receiving wallet.</p></div><div><Users size={25}/><h3>2. Holdings determine each allocation</h3><p>The payout service records eligible holdings. Your share is your snapshot balance divided by the total eligible balance.</p></div><div><WalletIcon size={25}/><h3>3. Payments reach your wallet</h3><p>The service sends holder allocations automatically. Completed transfers appear in your payment history.</p></div></section>
    </details>
    <div className="rewards-workspace-footer"><span>Balances and allocations are reported by the payout service. Confirmed payment receipts can be inspected onchain.</span>{report ? <AddressLink address={report.feeWallet} label="View fee receiver"/> : <a className="rewards-text-button" href={EXPLORER} target="_blank" rel="noreferrer">Robinhood Chain explorer<ArrowUpRight size={12}/></a>}</div>
  </div></RewardPriceContext.Provider>;
}
