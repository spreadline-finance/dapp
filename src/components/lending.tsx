"use client";
import { useId, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDown, ArrowRight, CircleHelp, Landmark, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { ageLabel, DataError, displayNumber as n, getData, pollingInterval, shortAddress } from "@/lib/live-api";
import { USDG, EXPLORER, type StockAsset } from "@/lib/market-types";
import { depositDisabled, lendingLink, lendingProjection, lendingWarningText, type LendingHistory, type LendingMarket, type LendingMarkets, type LendingVault, type LendingVaults, type LendingWarning } from "@/lib/lending";
import { TokenLogo, TokenPairLogo, TokenLogoScope } from "./token-logo";
import { LendingExecution, LendingActivity, useLendingConfirmations, type LendingTarget } from "./lending-execution";
import { LendingPositions } from "./lending-positions";
import type { WalletState } from "./wallet";
import "./lending.css";

const percent = (value: number | null | undefined) => value == null ? "—" : `${n(value * 100, 2)}%`;
const dollars = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sourceOld = (date: string | null, now: number) => !date || now <= 0 || now - Date.parse(date) > 5 * 60000 || Date.parse(date) > now + 60000;

function Warnings({ warnings }: { warnings: LendingWarning[] }) {
  return warnings.length ? <ul className="lending-warnings">{warnings.map((warning, i) => <li key={`${warning.type}-${i}`} data-level={warning.level.toUpperCase()}><CircleHelp size={14}/>{lendingWarningText(warning)}</li>)}</ul> : null;
}
function YieldHistory({ id, now }: { id: string; now: number }) {
  const gradient = useId();
  const reduceMotion = useReducedMotion();
  const history = useQuery({ queryKey: ["lending-history", id], queryFn: ({ signal }) => getData<LendingHistory>(`lending/history?market=${id}`, signal), staleTime: 300000 });
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const points = history.data?.points ?? [];
  const first = points[0], last = points[points.length - 1];
  const inspected = points.find((point) => point.time === selectedTime) ?? last;
  const low = points.length ? Math.min(...points.map((p) => p.apy)) : 0;
  const high = points.length ? Math.max(...points.map((p) => p.apy)) : 1;
  const pad = Math.max((high - low) * .2, .001);
  const bottom = low < 0 ? low - pad : Math.max(0, low - pad), top = high + pad;
  const x = (time: number) => first && last && first.time !== last.time ? 26 + (time - first.time) / (last.time - first.time) * 470 : 261;
  const y = (apy: number) => 140 - (apy - bottom) / (top - bottom) * 116;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(p.apy)}`).join(" ");
  return <section className="lending-history" aria-label="Seven-day base supply APY history">
    <div><span>BASE SUPPLY APY · 7 DAYS</span><strong>{inspected ? percent(inspected.apy) : "—"}</strong><small>{inspected ? new Date(inspected.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Daily observations from Morpho"}</small></div>
    {points.length ? <><svg viewBox="0 0 560 174" role="img" aria-label={`${points.length} actual supply APY observations; latest ${percent(last.apy)}`}>
      <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#759652" stopOpacity=".25"/><stop offset="100%" stopColor="#759652" stopOpacity=".02"/></linearGradient></defs>
      {[0, 1, 2].map((i) => { const value = bottom + (top - bottom) * i / 2; return <g key={i}><line x1="26" x2="496" y1={y(value)} y2={y(value)}/><text x="505" y={y(value) + 4}>{n(value * 100, 1)}%</text></g>; })}
      {points.length > 1 && <><path d={`${path} L${x(last.time)},140 L${x(first.time)},140 Z`} fill={`url(#${gradient})`}/><motion.path d={path} fill="none" stroke="#688b43" strokeWidth="2.5" initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .55, ease: "easeOut" }}/></>}
      {inspected && <circle cx={x(inspected.time)} cy={y(inspected.apy)} r="4" fill="#405c28"/>}
      <text x="26" y="164">{new Date(first.time).toLocaleDateString([], { month: "short", day: "numeric" })}</text><text x="496" y="164" textAnchor="end">{new Date(last.time).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
    </svg>{points.length > 1 && <input type="range" min={0} max={points.length - 1} value={Math.max(0, points.findIndex((p) => p.time === inspected.time))} onChange={(e) => setSelectedTime(points[Number(e.target.value)].time)} aria-label="Inspect daily supply APY" aria-valuetext={`${percent(inspected.apy)} on ${new Date(inspected.time).toLocaleDateString()}`}/>}</> : <p className="lending-empty">{history.isPending ? "Reading yield history…" : history.error ? history.error.message : "No history was returned for this market."}</p>}
    <p>{history.data?.dataStatus ? "Cached history · " : ""}{history.data ? `Fetched ${ageLabel(history.data.fetchedAt, now)}. ` : ""}Past rates do not predict future returns.</p>
  </section>;
}

function MarketDetails({ market, now, cached }: { market: LendingMarket; assets: StockAsset[]; now: number; cached: boolean }) {
  const [amount, setAmount] = useState("1000");
  const [days, setDays] = useState(30);
  const stale = cached || sourceOld(market.updatedAt, now);
  const criticalAlert = market.warnings.some((warning) => warning.level.toUpperCase() === "RED");
  const unsupportedRate = market.supplyApy === null || market.supplyApy < 0 || market.supplyApy > 100;
  const estimate = criticalAlert ? null : lendingProjection(amount, market.supplyApy, days);
  const usage = market.utilization === null ? null : Math.max(0, Math.min(1, market.utilization));
  return <aside className="lending-detail">

    <p className="lending-detail-intro">Lenders supply {market.loan.symbol}. Borrowers post {market.collateral?.symbol ?? "the market’s specified"} collateral and pay variable interest.</p>
    <div className="lending-rate-pair"><div><span>Base supply APY</span><strong>{percent(market.supplyApy)}</strong></div><div><span>Borrow APY</span><strong>{percent(market.borrowApy)}</strong></div></div>
    <p className="lending-small">{stale ? "Last indexed rates · " : "Indexed "}{ageLabel(market.updatedAt ?? undefined, now)} · rewards excluded</p>
    <div className="lending-detail-analysis"><YieldHistory key={market.id} id={market.id} now={now}/>
    <div className="lending-utilization"><div><span>Borrowed share of supplied assets</span><strong>{percent(usage)}</strong></div><div className="lending-utilization-track" role="img" aria-label={`Market utilization ${percent(usage)}`}><i style={{ width: `${(usage ?? 0) * 100}%` }}/></div><p>{dollars(market.liquidityUsd)} indexed liquidity. Withdrawals depend on liquidity at execution.</p></div>
    <details className="lending-calculator-disclosure"><summary>Explore potential interest<ArrowDown size={14}/></summary><div className="lending-calculator"><span className="eyebrow">EXPLORE THE OBSERVED RATE</span><label htmlFor="lending-amount">Illustrative supply <span>{market.loan.symbol}</span></label><input id="lending-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off"/><div className="lending-periods">{[30, 90, 365].map((period) => <button key={period} aria-pressed={days === period} onClick={() => setDays(period)}>{period === 365 ? "1 year" : `${period} days`}</button>)}</div><div className="lending-estimate"><span>Illustrative interest</span><strong>{estimate === null ? "—" : `+${n(estimate, 4)}`}</strong> <small>{market.loan.symbol}</small></div><p>{criticalAlert ? "This market has critical protocol alerts. An interest illustration is unavailable." : unsupportedRate ? "The observed APY is missing or outside this calculator’s supported range." : estimate === null ? "Enter an amount above zero and up to 10 million, with up to six decimals." : `${stale ? "Uses the last indexed rate. " : ""}Assumes this APY stays constant for ${days} days. Excludes network fees and incentives; no return is guaranteed.`}</p></div></details>
    </div>
    <Warnings warnings={market.warnings}/>
    {!market.listed && <p className="lending-caution">This market is unlisted. A matching Stock Token address does not establish the market’s safety or oracle quality.</p>}
    <dl className="lending-facts"><div><dt>Liquidation LTV</dt><dd>{percent(market.lltv)}</dd></div><div><dt>Loan token</dt><dd><a href={`${EXPLORER}/address/${market.loan.address}`} target="_blank" rel="noreferrer">{shortAddress(market.loan.address)}<ArrowUpRight size={12}/></a></dd></div>{market.collateral && <div><dt>Collateral token</dt><dd><a href={`${EXPLORER}/address/${market.collateral.address}`} target="_blank" rel="noreferrer">{shortAddress(market.collateral.address)}<ArrowUpRight size={12}/></a></dd></div>}</dl>
    <p className="lending-small">Liquidation LTV is a borrower liquidation threshold, not a suggested borrowing ratio. Lenders can lose funds through bad debt or contract and oracle failures.</p>
    <a className="button button-primary lending-action" href={lendingLink("market", market.id)!} target="_blank" rel="noreferrer">View market on Morpho<ArrowUpRight size={16}/></a>
    <p className="lending-small">Morpho opens separately for additional market details and borrowing. Direct-market supply rates can differ from vault returns.</p>
  </aside>;
}

function VaultDetails({ vault }: { vault: LendingVault; assets: StockAsset[] }) {
  return <article className="lending-vault">
    <div className="lending-vault-heading"><TokenLogo asset={vault.asset} size={42}/><div><span>MORPHO VAULT V{vault.version}</span><h3>{vault.asset.symbol} lending vault</h3></div><span className={`lending-vault-status ${depositDisabled(vault) ? "restricted" : ""}`}>{depositDisabled(vault) ? "Deposits restricted" : "Listed"}</span></div>
    <p>{vault.curators.length ? `Curated by ${vault.curators.join(", ")}` : "Curator not reported"}</p>
    <div className="lending-vault-apy"><span>Net base APY</span><strong>{percent(vault.netApy)}</strong><small>Variable · after vault fees · rewards excluded</small></div>
    <dl><div><dt>Total supplied</dt><dd>{dollars(vault.suppliedUsd)}</dd></div><div><dt>Indexed liquidity</dt><dd>{dollars(vault.liquidityUsd)}</dd></div><div><dt>Performance fee</dt><dd>{percent(vault.performanceFee)}</dd></div>{vault.version === 2 && <div><dt>Annual management fee</dt><dd>{percent(vault.managementFee)}</dd></div>}</dl>
    <Warnings warnings={vault.warnings}/>
    {vault.gated && <p className="lending-caution">This vault has access gates. New deposits are restricted here; an exact exit simulation checks access for withdrawals.</p>}
    <a className="button button-secondary lending-action" href={lendingLink("vault", vault.address)!} target="_blank" rel="noreferrer">{depositDisabled(vault) ? "Review vault on Morpho" : "View vault on Morpho"}<ArrowUpRight size={16}/></a>
    <p className="lending-small">{depositDisabled(vault) ? "The feed reports restrictions or critical alerts. This link is for review; it does not establish deposit availability." : "Morpho checks current access, balances and deposit availability before you confirm in your wallet."}</p>
    <a className="lending-contract" href={`${EXPLORER}/address/${vault.address}`} target="_blank" rel="noreferrer">{shortAddress(vault.address)}<ArrowUpRight size={13}/></a>
  </article>;
}

export function Lending({ assets, now, wallet }: { assets: StockAsset[]; now: number; wallet: WalletState }) {
  useLendingConfirmations(wallet);
  const [recoveredTarget, setRecoveredTarget] = useState<LendingTarget>();
  const reduceMotion = useReducedMotion();
  const markets = useQuery({ queryKey: ["lending-markets"], queryFn: ({ signal }) => getData<LendingMarkets>("lending/markets", signal), staleTime: 120000, refetchInterval: (q) => pollingInterval(120000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) });
  const vaults = useQuery({ queryKey: ["lending-vaults"], queryFn: ({ signal }) => getData<LendingVaults>("lending/vaults", signal), staleTime: 120000, refetchInterval: (q) => pollingInterval(120000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) });
  const [tab, setTab] = useState<"markets" | "vaults">("markets");
  const [search, setSearch] = useState("");
  const [unlisted, setUnlisted] = useState(false);
  const [stockOnly, setStockOnly] = useState(false);
  const [sort, setSort] = useState("supplied");
  const [selectedId, setSelectedId] = useState("");
  const [selectedVaultAddress, setSelectedVaultAddress] = useState("");
  const lastReviewButton = useRef<HTMLButtonElement | null>(null);
  const [loanAddress, setLoanAddress] = useState<string>(USDG);
  const rows = markets.data?.markets ?? [];
  const registered = new Set(assets.map((stock) => stock.address.toLowerCase()));
  const stockMarket = (market: LendingMarket) => !!market.collateral && registered.has(market.collateral.address.toLowerCase());
  const listedUSDG = rows.filter((market) => market.listed && sameAddress(market.loan.address, USDG));
  const total = (key: "suppliedUsd" | "liquidityUsd") => listedUSDG.length && listedUSDG.every((m) => m[key] !== null) ? listedUSDG.reduce((sum, m) => sum + m[key]!, 0) : null;
  const loans = [...new Map(rows.map((market) => [market.loan.address.toLowerCase(), market.loan])).values()];
  if (!loans.some((asset) => sameAddress(asset.address, USDG))) loans.unshift({ address: USDG, symbol: "USDG", decimals: 6 });
  const visible = rows.filter((market) => (unlisted || market.listed) && (!stockOnly || stockMarket(market)) && (loanAddress === "all" || sameAddress(market.loan.address, loanAddress)) && `${market.loan.symbol} ${market.collateral?.symbol ?? ""} ${market.id} ${market.collateral?.address ?? ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => ((sort === "yield" ? b.supplyApy : sort === "liquidity" ? b.liquidityUsd : b.suppliedUsd) ?? -Infinity) - ((sort === "yield" ? a.supplyApy : sort === "liquidity" ? a.liquidityUsd : a.suppliedUsd) ?? -Infinity));
  const selected = rows.find((market) => market.id === selectedId);
  const selectedVault = vaults.data?.vaults.find((vault) => vault.address === selectedVaultAddress);
  const recoveredMarket = rows.find((m) => m.id.toLowerCase() === recoveredTarget?.id.toLowerCase());
  const recoveredVault = vaults.data?.vaults.find((v) => v.address.toLowerCase() === recoveredTarget?.id.toLowerCase());
  const resolvedRecovered = recoveredTarget ? { ...recoveredTarget, asset: recoveredMarket?.loan ?? recoveredVault?.asset ?? recoveredTarget.asset, collateral: recoveredMarket?.collateral, apy: recoveredMarket?.supplyApy ?? recoveredVault?.netApy, depositRestricted: recoveredMarket ? !recoveredMarket.listed || recoveredMarket.warnings.some((w) => w.level.toUpperCase() === "RED" || w.type === "deposit_disabled") : recoveredVault ? depositDisabled(recoveredVault) : false } : undefined;
  const activeTarget: LendingTarget | undefined = selected ? { kind: "market", id: selected.id, label: `${selected.collateral?.symbol ?? "No collateral"} / ${selected.loan.symbol}`, asset: selected.loan, collateral: selected.collateral, apy: selected.supplyApy, depositRestricted: !selected.listed || selected.warnings.some((w) => w.level.toUpperCase() === "RED" || w.type === "deposit_disabled") } : selectedVault ? { kind: "vault", id: selectedVault.address, label: selectedVault.name, asset: selectedVault.asset, apy: selectedVault.netApy, depositRestricted: depositDisabled(selectedVault) } : resolvedRecovered;
  function openPosition(target: LendingTarget) { setSelectedId(""); setSelectedVaultAddress(""); setRecoveredTarget({ ...target, initialOperation: target.initialOperation ?? "withdraw" }); }
  const active = tab === "markets" ? markets : vaults;
  const retryAt = active.error instanceof DataError ? active.error.retryAt : active.data?.dataStatus ? Date.parse(active.data.dataStatus.retryAt) : 0;
  const refreshAt = Math.max(retryAt, active.data ? Date.parse(active.data.fetchedAt) + 120000 : 0);
  const refreshWait = Math.max(0, Math.ceil((refreshAt - now) / 1000));
  const summaryCached = !!markets.data?.dataStatus || !!markets.error || (!!markets.data && sourceOld(markets.data.fetchedAt, now));
  return <TokenLogoScope stocks={assets}><MotionConfig reducedMotion="user"><div className="lending-workspace lending-refined lending-polished">
    <LendingPositions wallet={wallet} now={now} onOpen={openPosition}/>
    <div className="lending-summary">
      <div><Landmark size={20}/><span>USDG supplied</span><strong>{dollars(total("suppliedUsd"))}</strong><small>{summaryCached ? "Last snapshot · " : ""}loaded, listed markets</small></div>
      <div><ArrowDown size={20}/><span>Available liquidity</span><strong>{dollars(total("liquidityUsd"))}</strong><small>USDG markets · indexed USD value</small></div>
      <div><ShieldCheck size={20}/><span>Curated vaults</span><strong>{vaults.data ? vaults.data.vaults.length : "—"}</strong><small>{vaults.data ? `${vaults.data.vaults.filter(depositDisabled).length} with deposit restrictions / alerts` : "Reading availability"}</small></div>
    </div>
    <div className="lending-toolbar" id="lending-explore"><div className="lending-tabs" aria-label="Lending views">
      {(["markets", "vaults"] as const).map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item === "markets" ? "Lending markets" : "Curated vaults"}{item === "vaults" && vaults.data && <span className="lending-count">{vaults.data.vaults.length}</span>}{tab === item && <motion.span className="lending-tab-line" layoutId={reduceMotion ? undefined : "lending-tab"} transition={{ duration: .22, ease: "easeOut" }}/>}</button>)}
    </div><button className="lending-refresh" disabled={active.isFetching || refreshWait > 0} onClick={() => void active.refetch()}><RefreshCw size={14} className={active.isFetching ? "spin" : ""}/>{active.isFetching ? "Updating" : refreshWait > 0 ? `Refresh in ${refreshWait}s` : "Refresh"}</button></div>
    {(active.error || active.data?.dataStatus) && <p className="lending-caution" role="status"><CircleHelp size={17}/>{active.data ? "Showing the last snapshot. Rates and liquidity may have changed. " : ""}{active.error?.message ?? active.data?.dataStatus?.reason}</p>}
    <motion.div key={tab} initial={reduceMotion ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .2 }}>
    {tab === "markets" ? <>
      <div className="lending-filters"><label>Supply asset<select value={loanAddress} onChange={(e) => setLoanAddress(e.target.value)}><option value="all">All assets</option>{loans.map((asset) => <option key={asset.address} value={asset.address}>{asset.symbol}</option>)}</select></label><label>Sort by<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="supplied">Total supplied</option><option value="liquidity">Available liquidity</option><option value="yield">Supply APY</option></select></label><label className="lending-search"><Search size={16}/><input placeholder="Search collateral or market…" aria-label="Search lending markets" value={search} onChange={(e) => setSearch(e.target.value)}/></label></div>
      <div className="lending-toggles"><label><input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)}/>Stock Token collateral</label><label><input type="checkbox" checked={unlisted} onChange={(e) => setUnlisted(e.target.checked)}/>Include unlisted markets</label><span>{visible.length} markets</span>{(search || stockOnly || unlisted || loanAddress !== USDG) && <button className="lending-reset" onClick={() => { setSearch(""); setStockOnly(false); setUnlisted(false); setLoanAddress(USDG); }}>Clear filters<X size={12}/></button>}</div>
      {unlisted && <p className="lending-caution">Unlisted markets can use unrecognized assets or oracles. Review the source warnings and contracts before taking action.</p>}
      <section className="lending-comparison" aria-label="Morpho lending market comparison">
        <div className="lending-table-scroll" tabIndex={0} role="region" aria-label="Lending market table; scroll horizontally on smaller screens">
        <table className="lending-data-table" role="table"><thead><tr><th scope="col">Supply market</th><th scope="col" className="lending-secondary-column">Total supplied</th><th scope="col">Liquidity</th><th scope="col" className="lending-secondary-column">Utilization</th><th scope="col">Base supply APY</th><th scope="col"><span className="sr-only">Review market</span></th></tr></thead>
        <tbody>{visible.map((market) => <tr key={market.id}>
          <td data-label="Market"><div className="lending-table-asset"><TokenPairLogo supply={market.loan} collateral={market.collateral}/><div><strong>Supply {market.loan.symbol}</strong><small>Collateral: {market.collateral?.symbol ?? "None"}{stockMarket(market) ? " · Stock Token" : ""}</small><span className={`lending-market-status ${!market.listed || market.warnings.length ? "has-alert" : ""}`}>{market.listed ? "Listed market" : "Unlisted market"}{market.warnings.length ? ` · ${market.warnings.length} alert${market.warnings.length === 1 ? "" : "s"}` : ""}</span></div></div></td>
          <td className="lending-secondary-column" data-label="Total supplied"><strong>{dollars(market.suppliedUsd)}</strong><small>{market.loan.symbol} supplied</small></td>
          <td data-label="Liquidity"><strong>{dollars(market.liquidityUsd)}</strong><small>Available at index time</small></td>
          <td className="lending-secondary-column" data-label="Utilization"><strong>{percent(market.utilization)}</strong>{market.utilization !== null && <span className="lending-table-utilization" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(1, market.utilization)) * 100}%` }}/></span>}</td>
          <td data-label="Base supply APY"><strong className="lending-yield">{percent(market.supplyApy)}</strong><small>{sourceOld(market.updatedAt, now) || summaryCached ? "Last indexed rate" : "Variable · rewards excluded"}</small></td>
          <td><button className="lending-review-button" aria-label={`${market.listed && !market.warnings.some((w) => w.level.toUpperCase() === "RED" || w.type === "deposit_disabled") ? "Deposit into" : "Manage"} ${market.loan.symbol} supply market with ${market.collateral?.symbol ?? "no"} collateral ${shortAddress(market.id)}`} onClick={(event) => { lastReviewButton.current = event.currentTarget; setSelectedId(market.id); }}>{market.listed && !market.warnings.some((w) => w.level.toUpperCase() === "RED" || w.type === "deposit_disabled") ? "Deposit" : "Manage"}<ArrowRight size={14}/></button></td>
        </tr>)}</tbody></table></div>
        {!visible.length && <div className="lending-empty"><Landmark size={30}/><h3>{markets.isPending ? "Reading Morpho markets…" : markets.error ? "Market data is unavailable" : "No markets match these filters"}</h3><p>{markets.error?.message ?? (stockOnly && !unlisted ? "This snapshot may only have unlisted Stock Token markets. Include unlisted markets to research them." : "Adjust the asset or search to explore the available markets.")}</p></div>}
        {markets.data && <p className="lending-list-note">{markets.data.markets.length} of {markets.data.total} chain markets loaded, ordered by supply. {markets.data.rejected ? `${markets.data.rejected} invalid records omitted. ` : ""}Vault deposits are not added to these totals.</p>}
      </section>
      <details className="lending-explainer"><summary><CircleHelp size={15}/>Where does the yield come from?</summary><p>Borrowers pay interest to use supplied assets. Supply APY varies with demand. Compare collateral, liquidity and protocol alerts; a listing does not guarantee safety. Open a market to see its rate history, borrowing rate and an illustrative return calculator.</p></details>
    </> : <>
      <p className="lending-vault-intro">Vaults let a curator allocate your supplied assets. Rates below are net of vault fees and exclude rewards.</p>
      <section className="lending-comparison" aria-label="Curated lending vaults"><div className="lending-table-scroll" tabIndex={0} role="region" aria-label="Curated vault table; scroll horizontally on smaller screens"><table className="lending-data-table" role="table"><thead><tr><th scope="col">Lending vault</th><th scope="col" className="lending-secondary-column">Total supplied</th><th scope="col">Liquidity</th><th scope="col">Net base APY</th><th scope="col">Availability</th><th scope="col"><span className="sr-only">Review vault</span></th></tr></thead><tbody>
        {vaults.data?.vaults.map((vault) => <tr key={`${vault.version}-${vault.address}`}><td><div className="lending-table-asset"><TokenLogo asset={vault.asset} size={40}/><div><strong>{vault.name}<span className="lending-version">V{vault.version}</span></strong><small>{vault.curators.join(", ") || "Curator not reported"}</small></div></div></td><td className="lending-secondary-column" data-label="Total supplied"><strong>{dollars(vault.suppliedUsd)}</strong><small>{vault.asset.symbol} supplied</small></td><td data-label="Liquidity"><strong>{dollars(vault.liquidityUsd)}</strong><small>Indexed liquidity</small></td><td data-label="Net base APY"><strong className="lending-yield">{percent(vault.netApy)}</strong><small>Variable · rewards excluded</small></td><td data-label="Availability"><span className={`lending-vault-status ${depositDisabled(vault) ? "restricted" : ""}`}>{depositDisabled(vault) ? "Deposits restricted" : "Listed"}</span><small>{vault.warnings.some((w) => w.type === "deposit_disabled") ? "Deposits disabled in Morpho" : vault.gated ? "Access gates apply" : depositDisabled(vault) ? "Critical protocol alerts" : "Preview deposit here"}</small></td><td><button className="lending-review-button" aria-label={`Manage ${vault.name} vault`} onClick={(event) => { lastReviewButton.current = event.currentTarget; setSelectedVaultAddress(vault.address); }}>Manage<ArrowRight size={14}/></button></td></tr>)}
      </tbody></table></div>
      {!vaults.data?.vaults.length && <div className="lending-empty"><Landmark size={30}/><h3>{vaults.isPending ? "Reading listed vaults…" : "No listed vaults are available in this snapshot"}</h3><p>{vaults.error?.message ?? "Explore individual markets while vault availability is checked."}</p></div>}
      </section><p className="lending-list-note">{vaults.data ? `${vaults.data.vaults.length} of ${vaults.data.total} listed vaults loaded. ${vaults.data.rejected ? `${vaults.data.rejected} invalid records omitted. ` : ""}` : ""}Robinhood Earn promotions have separate eligibility and are excluded. A deposit-disabled warning refers to Morpho’s interface policy, not proof of a paused contract.</p>
    </>}
    </motion.div>
    <div className="lending-source"><span><i/>Morpho · Robinhood Chain</span><span>{active.data ? `Fetched ${ageLabel(active.data.fetchedAt, now)}` : "Connecting to Morpho’s indexer"}</span><a href="https://docs.morpho.org/developers/api/get-started/" target="_blank" rel="noreferrer">Source<ArrowUpRight size={12}/></a></div>
    <LendingActivity wallet={wallet} onOpen={openPosition}/>
    <footer className="lending-footer"><Landmark size={18}/><p>Variable rates. Withdrawals depend on liquidity. Principal is at risk. Deposit and withdraw here with your wallet. Borrowing is available separately in Morpho.</p></footer>
    <Dialog.Root open={!!activeTarget} onOpenChange={(open) => { if (!open) { setSelectedId(""); setSelectedVaultAddress(""); setRecoveredTarget(undefined); } }}>
      <Dialog.Portal><Dialog.Overlay className="lending-dialog-overlay"/><Dialog.Content className={`lending-dialog lending-workspace lending-dialog-polished ${selected || selectedVault ? "has-insights" : ""}`} onCloseAutoFocus={(event) => { event.preventDefault(); if (lastReviewButton.current?.isConnected) lastReviewButton.current.focus(); else document.getElementById("lending-positions-heading")?.focus(); }}>
        <div className="lending-dialog-heading"><div className="lending-dialog-identity"><TokenPairLogo supply={activeTarget?.asset} collateral={activeTarget?.collateral} size={44}/><div><span className="eyebrow">{activeTarget?.kind === "market" ? "MORPHO MARKET" : "MORPHO VAULT"}</span><Dialog.Title>{activeTarget?.kind === "market" && activeTarget.asset ? `${activeTarget.asset.symbol} supply market` : activeTarget?.label}</Dialog.Title><Dialog.Description>{activeTarget?.collateral ? `${activeTarget.collateral.symbol} collateral · Morpho on Robinhood Chain` : "Morpho on Robinhood Chain · Your wallet, your assets"}</Dialog.Description></div></div><Dialog.Close className="lending-dialog-close" aria-label="Close lending review"><X size={20}/></Dialog.Close></div>
        <div className="lending-dialog-body">
        {activeTarget && <LendingExecution key={`${activeTarget.kind}:${activeTarget.id}:${wallet.account}:${wallet.chainId}:${wallet.selected?.info.uuid}:${wallet.demoWallet?.id}:${activeTarget.depositRestricted}`} target={activeTarget} wallet={wallet} now={now}/>}
        {selected && <div className="lending-insights"><MarketDetails key={selected.id} market={selected} assets={assets} now={now} cached={summaryCached}/></div>}
        {selectedVault && <div className="lending-insights"><p className="lending-small">{vaults.error || vaults.data?.dataStatus ? "Cached vault snapshot · " : "Vault data fetched "}{ageLabel(vaults.data?.fetchedAt, now)}. Rates and availability may change.</p><VaultDetails vault={selectedVault} assets={assets}/></div>}
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div></MotionConfig></TokenLogoScope>;
}
