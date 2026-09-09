"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowDown, ArrowRight, ArrowUpRight, Check, CircleHelp, Clock3, ExternalLink, Landmark, Layers3, RefreshCw, ShieldCheck, Vault } from "lucide-react";
import type { DeskEvent, DeskHistory, DeskPoolBoard, DeskSnapshot } from "@/lib/desk-types";
import { ageLabel, DataError, displayNumber as n, getData, pollingInterval, shortAddress } from "@/lib/live-api";
import { sourceIsCurrent } from "@/lib/live-freshness";
import { EXPLORER, USDG, type StockAsset } from "@/lib/market-types";
import { DeskWallet } from "./desk-wallet";
import { ProtocolLogo } from "./protocol-logo";
import { TokenLogoScope, TokenPairLogo } from "./token-logo";
import type { WalletState } from "./wallet";
import "./desk.css";

type DeskTab = "pools" | "ledger" | "method";
const tabNames: Record<DeskTab, string> = { pools: "Market watch", ledger: "Treasury activity", method: "How you earn" };
const eventNames: Record<DeskEvent["kind"], string> = { deposit: "Capital deposited", withdrawal: "Capital withdrawn", profit: "Trading surplus realized", claim: "Rewards claimed" };
const poolColors = ["#476b32", "#9a734b", "#6b7fa2", "#8c6e92"];

/** Keep financial amounts exact until display; values from the vault are USDG base units. */
function units(value: string | null | undefined, places = 2) {
  if (value == null || !/^\d+$/.test(value)) return "—";
  const padded = value.padStart(7, "0"), whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  if (places === 2 && whole === "0" && padded.slice(-6, -4) === "00" && /[1-9]/.test(padded.slice(-6))) return "<0.01";
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${places ? `.${padded.slice(-6).slice(0, places).padEnd(places, "0")}` : ""}`;
}
function bps(value: number | null | undefined) { return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${n(value, 1)} bps`; }
function fee(value: number) { return `${n(value / 10000, value < 1000 ? 2 : 1)}%`; }
function current(time: string | undefined | null, now: number) { return sourceIsCurrent(time, now, 90000); }
function retryTime(error: Error | null, retryAt?: string) { return error instanceof DataError ? error.retryAt : retryAt ? Date.parse(retryAt) : 0; }

function Notice({ children }: { children: React.ReactNode }) { return <div className="earn-notice" role="status"><CircleHelp size={17}/><p>{children}</p></div>; }
function EmptyState({ title, children, icon: Icon = Activity }: { title: string; children: React.ReactNode; icon?: typeof Activity }) { return <div className="earn-empty"><Icon size={25}/><h3>{title}</h3><p>{children}</p></div>; }

function PoolHistory({ symbol, now, pools }: { symbol: string; now: number; pools: DeskPoolBoard | undefined }) {
  const gradientId = useId();
  const history = useQuery({ queryKey: ["desk-history", symbol], queryFn: ({ signal }) => getData<DeskHistory>(`desk/history?symbol=${encodeURIComponent(symbol)}`, signal), staleTime: 300000, refetchInterval: (q) => pollingInterval(300000, q.state.error, q.state.fetchFailureCount) });
  const available = history.data?.points.filter((point) => point.spreadBps != null && Number.isFinite(point.spreadBps)) ?? [];
  const poolAddresses = [...new Set(available.map((point) => point.poolAddress))];
  const times = available.map((point) => Date.parse(point.observedAt));
  const start = times.length ? Math.min(...times) : 0, end = times.length ? Math.max(...times) : 0;
  const max = Math.max(5, ...available.map((point) => Math.abs(point.spreadBps!))) * 1.15;
  const x = (time: string) => start === end ? 328 : 52 + (Date.parse(time) - start) / (end - start) * 550;
  const y = (value: number) => 88 - value / max * 58;
  return <section className="earn-history" aria-label={`${symbol} observed pool spreads`}>
    <div className="earn-section-heading"><div><h3>Watch the spread change</h3><p>Recorded spot spreads to the USD reference, assuming 1 USDG = 1 USD.</p></div><span className="earn-source-label">{history.data?.status === "ready" ? `${available.length} observations` : "Recorded observations"}</span></div>
    {available.length > 1 && start !== end ? <>
      <svg viewBox="0 0 660 176" role="img" aria-label={`Observed spread in basis points for ${poolAddresses.length} ${symbol} pools. A spot spread is not an executable return.`}>
        <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#edf1e6"/><stop offset="100%" stopColor="#fffffb"/></linearGradient></defs>
        <rect x="52" y="25" width="550" height="126" fill={`url(#${gradientId})`}/>
        {[-1, 0, 1].map((tick) => <g key={tick}><line x1="52" x2="602" y1={y(tick * max / 1.15)} y2={y(tick * max / 1.15)} className={tick === 0 ? "earn-chart-zero" : "earn-chart-line"}/><text x="43" y={y(tick * max / 1.15) + 3} textAnchor="end">{n(tick * max / 1.15, 0)}</text></g>)}
        {poolAddresses.map((address, index) => { const points = available.filter((point) => point.poolAddress === address).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)); return <g key={address}><path d={points.map((point, i) => `${i ? "L" : "M"}${x(point.observedAt)},${y(point.spreadBps!)}`).join(" ")} fill="none" stroke={poolColors[index % poolColors.length]} strokeWidth="2"/>{points.map((point) => <circle key={`${point.blockNumber}-${point.observedAt}`} cx={x(point.observedAt)} cy={y(point.spreadBps!)} r="2.5" fill={poolColors[index % poolColors.length]}><title>{bps(point.spreadBps)} · block {point.blockNumber}</title></circle>)}</g>; })}
        <text x="52" y="170">{new Date(start).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</text><text x="602" y="170" textAnchor="end">{new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>
      </svg>
      <div className="earn-chart-legend">{poolAddresses.map((address, index) => <span key={address}><i style={{ background: poolColors[index % poolColors.length] }}/>{pools?.pools.find((pool) => pool.address.toLowerCase() === address.toLowerCase()) ? fee(pools.pools.find((pool) => pool.address.toLowerCase() === address.toLowerCase())!.fee) : shortAddress(address)} pool</span>)}</div>
    </> : <div className="earn-history-empty"><Clock3 size={22}/><div><strong>{history.isPending ? "Reading recorded market observations…" : history.error ? "Market history is unavailable" : "A history built from real observations"}</strong><p>{history.error?.message ?? history.data?.message ?? "Market observations will appear as the recorder collects them."}</p></div></div>}
    {available.length > 0 && <p className="earn-footnote">Last history read {ageLabel(history.data?.fetchedAt, now)}. This is an observed spread history, not strategy performance.</p>}
  </section>;
}

function MarketWatch({ assets, now, onAnalyze, registryError }: { assets: StockAsset[]; now: number; onAnalyze: (symbol: string) => void; registryError?: string | null }) {
  const [selection, setSelection] = useState("NVDA");
  const symbol = assets.some((asset) => asset.symbol === selection) ? selection : assets[0]?.symbol ?? selection;
  const asset = assets.find((item) => item.symbol === symbol);
  const [activeOnly, setActiveOnly] = useState(false);
  const pools = useQuery({ queryKey: ["desk-pools", symbol], queryFn: ({ signal }) => getData<DeskPoolBoard>(`desk/pools?symbol=${encodeURIComponent(symbol)}`, signal), enabled: !!asset, staleTime: 30000, refetchInterval: (q) => pollingInterval(30000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) });
  const wait = Math.max(0, Math.ceil((retryTime(pools.error, pools.data?.dataStatus?.retryAt) - now) / 1000));
  const live = !!pools.data && !pools.error && !pools.data.dataStatus && current(pools.data.blockTimestamp, now);
  const rows = pools.data?.pools.filter((pool) => !activeOnly || pool.active) ?? [];
  const ref = pools.data?.reference;
  const referenceFresh = ref && !pools.error && !pools.data?.dataStatus && !registryError && current(ref.generatedAt, now) && !ref.halted && !ref.cached;
  return <>
    <section className="earn-market-board">
      <div className="earn-section-heading"><div><h2>Pool market watch</h2><p>The same stock token can trade at different prices across pools.</p></div><button className="earn-button earn-button-quiet" disabled={pools.isFetching || wait > 0 || !asset} onClick={() => void pools.refetch()}><RefreshCw size={14} className={pools.isFetching ? "spin" : ""}/>{wait > 0 ? `Retry in ${wait}s` : pools.isFetching ? "Updating" : "Refresh"}</button></div>
      <div className="earn-market-toolbar"><label className="earn-asset-select"><span>Stock token</span><select value={symbol} onChange={(event) => setSelection(event.target.value)} disabled={!assets.length}>{!assets.length && <option value={selection}>{registryError ? "Assets unavailable" : "Loading assets…"}</option>}{assets.map((item) => <option key={item.address} value={item.symbol}>{item.symbol} · {item.name}</option>)}</select></label></div>
      {registryError && <Notice>{assets.length ? "The asset registry is using its last snapshot. " : ""}{registryError}</Notice>}
      {(pools.error || pools.data?.dataStatus) && <Notice>{pools.data ? "Showing the last pool snapshot. " : ""}{pools.error?.message ?? pools.data?.dataStatus?.reason}</Notice>}
      <div className="earn-pair-summary"><div className="earn-pair-title"><TokenPairLogo supply={asset} collateral={{ address: USDG, symbol: "USDG" }} size={38}/><div><h3>{symbol} <span>/ USDG</span></h3><p className="earn-protocol-name"><ProtocolLogo protocol="uniswap" size={17}/>Uniswap V3 · {pools.data ? `${pools.data.pools.length} discovered pools` : pools.error ? "Source unavailable" : !asset ? "Token data required" : "Discovering pools"}</p></div></div><div className="earn-reference"><span>Issuer bid / ask</span><strong>{ref ? `${n(ref.bid)} / ${n(ref.ask)}` : "—"} <small>USD</small></strong><span>{ref?.halted ? "Issuer trading halted" : ref ? `${referenceFresh ? "Updated" : "Last reference"} ${ageLabel(ref.generatedAt, now)}` : "Reference unavailable"}</span></div><button className="earn-button" onClick={() => onAnalyze(symbol)} disabled={!asset}>Check executable routes <ArrowUpRight size={15}/></button></div>
      {pools.data && <div className="earn-table-meta"><span className={`earn-live ${live ? "is-live" : ""}`}><i/>{pools.isPending ? "Reading chain" : live ? "Live chain snapshot" : "Last chain snapshot"}{pools.data && <> · block {n(pools.data.blockNumber, 0)}</>}</span><label><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)}/>Active liquidity only</label></div>}
      {rows.length > 0 && <div className="earn-pool-table-wrap"><table className="earn-pool-table"><thead><tr><th scope="col">Pool / trading fee</th><th scope="col">Spot price <span>USDG</span></th><th scope="col">Vs. issuer midpoint</th><th scope="col">Liquidity at current price</th><th scope="col"><span className="sr-only">Source</span></th></tr></thead><tbody>{rows.map((pool) => <tr key={pool.address}><td><div className="earn-pool-identity"><ProtocolLogo protocol="uniswap" size={31}/><div><strong>{symbol} / USDG</strong><span>Uniswap V3 · {fee(pool.fee)} fee</span><span>{shortAddress(pool.address)}</span></div></div></td><td className="earn-numeric" data-label="Spot price · USDG">{n(pool.priceUSDG, 4)}</td><td className="earn-numeric" data-label="Vs. issuer midpoint"><span className={pool.spreadBps != null && pool.spreadBps > 0 ? "earn-positive" : ""}>{bps(pool.spreadBps)}</span></td><td data-label="Liquidity at current price"><span className={`earn-pool-state ${pool.active ? "is-active" : ""}`}><i/>{pool.active ? "In range" : "No active liquidity"}</span><details className="earn-liquidity-detail"><summary>Liquidity units</summary><span>{pool.liquidity}</span><small>Raw Uniswap liquidity units, not a USDG balance or trade size.</small></details></td><td><a className="earn-explorer-link" href={`${EXPLORER}/address/${pool.address}`} target="_blank" rel="noreferrer" aria-label={`View ${symbol} ${fee(pool.fee)} pool on explorer`}><ExternalLink size={15}/></a></td></tr>)}</tbody></table></div>}
      {!rows.length && <EmptyState title={!asset && registryError ? "Asset registry is unavailable" : pools.isPending ? "Reading pool prices…" : pools.error ? "Pool data is unavailable" : activeOnly ? "No pools with active liquidity" : "No pools discovered"} icon={Layers3}>{!asset && registryError ? "Pool discovery resumes after the asset registry reconnects." : pools.isPending ? "Reading the factory and pool state at a single chain block." : pools.error ? "The desk will retry after the source cooldown." : "No pools matched this view. Try another stock token or clear the active-liquidity filter."}</EmptyState>}
      <div className="earn-pool-footer"><p>Comparisons assume 1 USDG = 1 USD. Trading fees, price impact and gas are excluded from these spot spreads. <strong>100 bps = 1%.</strong></p><span>{pools.data ? `Read ${ageLabel(pools.data.fetchedAt, now)}` : "Awaiting source"}{pools.data?.failedReads ? ` · ${pools.data.failedReads} reads unavailable` : ""}</span></div>
    </section>
    {!!asset && !!pools.data && <PoolHistory symbol={symbol} now={now} pools={pools.data}/>}
  </>;
}

function TreasuryLedger({ snapshot }: { snapshot: DeskSnapshot | undefined }) {
  const [filter, setFilter] = useState<"all" | "profit" | "claim">("all");
  const events = snapshot?.events.filter((event) => filter === "all" || event.kind === filter) ?? [];
  return <section className="earn-ledger"><div className="earn-section-heading"><div><h2>Every movement, onchain</h2><p>Confirmed vault events with transaction evidence.</p></div><div className="earn-segmented" aria-label="Treasury activity filter">{(["all", "profit", "claim"] as const).map((item) => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === "all" ? "All activity" : item === "profit" ? "Trading surplus" : "Payouts"}</button>)}</div></div>
    {snapshot?.eventsError && <Notice>{snapshot.eventsError}</Notice>}
    {events.length ? <div className="earn-event-list">{events.map((event) => <div className="earn-event" key={event.id}><span className={`earn-event-icon earn-event-${event.kind}`}>{event.kind === "claim" ? <Check size={17}/> : event.kind === "profit" ? <Activity size={17}/> : event.kind === "deposit" ? <ArrowDown size={17}/> : <ArrowUpRight size={17}/>}</span><div><h3>{eventNames[event.kind]}</h3><p>Block {n(event.blockNumber, 0)}{event.account && <> · <a href={`${EXPLORER}/address/${event.account}`} target="_blank" rel="noreferrer">{shortAddress(event.account)}</a></>}</p>{event.kind === "profit" && <p>{units(event.rewards, 6)} USDG allocated to rewards · {units(event.retained, 6)} USDG retained</p>}</div><div className="earn-event-amount"><strong>{units(event.assets, 6)} <small>USDG</small></strong><a href={`${EXPLORER}/tx/${event.transactionHash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={13}/></a></div></div>)}</div> : <EmptyState title={snapshot?.status === "unconfigured" ? "The ledger starts with the first real transaction" : filter === "claim" ? "No confirmed reward claims in this window" : filter === "profit" ? "No confirmed trading surplus in this window" : "No confirmed activity in this window"}>{snapshot?.status === "unconfigured" ? "Deposits, trading surplus, withdrawals and reward claims will appear here after the vault is launched." : "Only confirmed contract events appear here. A quote, wallet approval or submitted transaction is not a payment."}</EmptyState>}
    {snapshot?.eventsFromBlock && <p className="earn-footnote">Recent event window from block {n(snapshot.eventsFromBlock, 0)}. Totals above come from vault accounting, not this limited activity window.</p>}
  </section>;
}

function EarningMethod() {
  return <section className="earn-method"><div className="earn-section-heading"><div><h2>Where the money comes from</h2><p>A trading strategy with a visible path from capital to rewards.</p></div><span className="earn-method-label"><ShieldCheck size={15}/>No platform token required</span></div>
    <div className="earn-flow"><div><span className="earn-step-number">01</span><Landmark size={23}/><h3>Pool USDG capital</h3><p>Depositors receive vault shares. Those shares track their stake in managed assets and newly allocated rewards.</p></div><ArrowRight className="earn-flow-arrow" size={20}/><div><span className="earn-step-number">02</span><Layers3 size={23}/><h3>Trade a price difference</h3><p>The strategy buys a stock token in one V3 pool and sells it in another, in the same transaction.</p></div><ArrowRight className="earn-flow-arrow" size={20}/><div><span className="earn-step-number">03</span><Vault size={23}/><h3>Account for the surplus</h3><p>The vault requires more USDG to come back than went out. If its profit requirement fails, the entire trade reverts.</p></div></div>
    <div className="earn-distribution"><div><h3>Realized surplus is shared</h3><p>After a successful trade, the contract allocates the added USDG between rewards and managed capital.</p></div><div className="earn-split"><div className="earn-split-labels"><span><strong>75%</strong> Depositor rewards</span><span><strong>25%</strong> Retained in vault</span></div><div className="earn-split-bar" aria-label="75 percent to depositor rewards, 25 percent retained in the vault"><span/><span/></div><p>Rewards accrue to shares held when profit is realized. Claim in USDG from your wallet.</p></div></div>
    <div className="earn-method-notes"><div><h3>Surplus is not a promised yield</h3><p>Profitable routes may be rare or disappear before execution. There is no fixed APY, daily payout or guaranteed return. Operator gas is paid outside the vault and is not deducted from the displayed trading surplus.</p></div><div><h3>Capital and rewards stay distinct</h3><p>A new deposit increases capital, not earnings. Reserved rewards are excluded from assets backing shares. The retained portion stays in the vault and benefits share value.</p></div><div><h3>One strategy, a narrow scope</h3><p>This desk uses atomic V3 arbitrage. It does not currently provide liquidity, farm token incentives or hold an overnight stock inventory.</p></div><div><h3>Know what you depend on</h3><p>Smart contract faults, settlement-token risk, permissions and chain availability can affect funds. The strategy requires an operator and active pools; activity pauses when those conditions are missing.</p></div></div>
  </section>;
}

export function StrategyDesk({ assets, now, wallet, onAnalyze, registryError }: { assets: StockAsset[]; now: number; wallet: WalletState; onAnalyze: (symbol: string) => void; registryError?: string | null }) {
  const [tab, setTab] = useState<DeskTab>("pools");
  const snapshot = useQuery({ queryKey: ["desk", wallet.account ?? "public"], queryFn: ({ signal }) => getData<DeskSnapshot>(`desk${wallet.account ? `?address=${encodeURIComponent(wallet.account)}` : ""}`, signal), staleTime: 15000, refetchInterval: (q) => pollingInterval(q.state.data?.status === "unconfigured" ? 60000 : wallet.account ? 15000 : 30000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) });
  const data = snapshot.data, vault = data?.vault;
  const fresh = data?.status === "ready" && !snapshot.error && !data.dataStatus && current(data.blockTimestamp, now);
  const wait = Math.max(0, Math.ceil((retryTime(snapshot.error, data?.dataStatus?.retryAt) - now) / 1000));
  const status = snapshot.isPending ? "Reading vault status" : snapshot.error && !data ? "Vault status unavailable" : data?.status === "unconfigured" ? "Vault not launched" : data?.status === "unavailable" ? "Vault unavailable" : vault?.paused ? "Trading paused" : fresh ? "Vault connected" : "Last vault snapshot";
  return <TokenLogoScope stocks={assets}><div className="earn-workspace">
    <div className="earn-status-bar"><div className={`earn-live ${fresh && !vault?.paused ? "is-live" : ""}`}><i/><strong>{status}</strong><span>{data?.blockNumber ? `Block ${n(data.blockNumber, 0)} · ${ageLabel(data.fetchedAt, now)}` : "USDG vault · Robinhood Chain"}</span></div><button className="earn-button earn-button-quiet" disabled={snapshot.isFetching || wait > 0} onClick={() => void snapshot.refetch()}><RefreshCw size={14} className={snapshot.isFetching ? "spin" : ""}/>{wait > 0 ? `Retry in ${wait}s` : "Refresh vault"}</button></div>
    {(snapshot.error || data?.dataStatus || data?.status === "unavailable") && <Notice>{data?.vault ? "Figures are from the last available snapshot. " : ""}{snapshot.error?.message ?? data?.dataStatus?.reason ?? data?.message}</Notice>}
    {vault ? <div className="earn-overview"><section className="earn-treasury"><div className="earn-section-heading"><div><h2>USDG strategy vault</h2><p>Deposit USDG to back atomic stock-token arbitrage. Rewards appear only after profitable trades finish onchain.</p></div><Vault size={23}/></div><div className="earn-capital"><span>Managed capital</span><strong>{units(vault?.managedAssets)} <small>USDG</small></strong><p>{vault ? "Assets backing depositor shares · excludes reserved rewards" : data?.status === "unconfigured" ? "Capital figures appear when a funded vault is connected." : "Awaiting verified vault accounting."}</p></div><div className="earn-metrics"><div><span>Trading surplus</span><strong>{units(vault?.totalRealizedProfit)}</strong><small>USDG · before operator gas</small></div><div><span>Rewards reserved</span><strong>{units(vault?.totalRewardsReserved)}</strong><small>USDG · allocated, unclaimed</small></div><div><span>Rewards paid</span><strong>{units(vault?.totalClaimed)}</strong><small>USDG · confirmed claims</small></div></div><div className="earn-treasury-bottom"><span><span className="earn-mini-dot"/>75% to rewards / 25% retained</span>{vault ? <a href={`${EXPLORER}/address/${vault.address}`} target="_blank" rel="noreferrer">Vault contract <ExternalLink size={13}/></a> : <button onClick={() => setTab("method")}>See how it works <ArrowRight size={13}/></button>}</div></section>
      <section className="earn-participation" aria-label="Your vault position"><DeskWallet snapshot={data} wallet={wallet} onRefresh={() => void snapshot.refetch()}/></section>
    </div> : <section className="earn-vault-unavailable"><Vault size={24}/><div><h2>{snapshot.isPending ? "Checking vault availability…" : data?.status === "unconfigured" ? "The USDG strategy vault has not launched" : "Vault accounting is unavailable"}</h2><p>{data?.status === "unconfigured" ? "When connected, users can deposit USDG into a strategy that shares realized arbitrage surplus. You can still explore pool prices below." : "Vault balances and wallet actions appear when verified accounting is available. Pool market watch is available below."}</p></div><button className="earn-button earn-button-quiet" onClick={() => setTab("method")}>How it works<ArrowRight size={14}/></button></section>}
    <div className="earn-tabs" aria-label="Desk sections">{(Object.keys(tabNames) as DeskTab[]).map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{tabNames[item]}{item === "pools" && <span className="earn-tab-dot"/>}{item === "ledger" && !!data?.events.length && <span className="earn-count">{data.events.length}</span>}</button>)}</div>
    {tab === "pools" && <MarketWatch assets={assets} now={now} onAnalyze={onAnalyze} registryError={registryError}/>}
    {tab === "ledger" && <TreasuryLedger snapshot={data}/>}
    {tab === "method" && <EarningMethod/>}
    <footer className="earn-workspace-footer"><span>Source-backed figures. Wallet-confirmed actions.</span><button onClick={() => setTab("method")}>Understand the strategy <ArrowUpRight size={13}/></button></footer>
  </div></TokenLogoScope>;
}
