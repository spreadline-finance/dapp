"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { Activity, ArrowRight, ArrowUpRight, Check, ChevronRight, Clock3, Layers3, Pause, Play, Radio, RefreshCw, ScanLine } from "lucide-react";
import { ARBITRAGE_INTERVAL, monitorRetryDelay, quoteLife, quoteSamples, rankedRoutes, routeKey, ROUTE_FEES, sampleSegments, type QuoteSample } from "@/lib/arbitrage-monitor";
import { requestResearchQuote, researchQuoteStatus } from "@/lib/research-quote-client";
import { ageLabel, displayNumber as n } from "@/lib/live-api";
import { saveObservation, useResearchJournal } from "@/lib/research-journal";
import { TRACKED_SYMBOLS, USDG, type QuoteBook, type RouteQuote, type StockAsset } from "@/lib/market-types";
import { StockLogo } from "./stock-logo";
import { TokenLogo } from "./token-logo";
import "./arbitrage-monitor.css";

const signed = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${n(value, value !== 0 && Math.abs(value) < .01 ? 6 : digits)}`;
const amountLabel = (value: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(Number(value));
const fee = (value: number) => `${value / 10000}%`;
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function QuoteHistory({ quotes, symbol, amount, compact = false }: { quotes: QuoteBook[]; symbol: string; amount: string; compact?: boolean }) {
  const samples = quoteSamples(quotes, symbol, amount);
  const [inspected, setInspected] = useState("");
  const selected = samples.find((p) => p.id === inspected) ?? samples.at(-1);
  const values = samples.flatMap((p) => p.value === null ? [] : [p.value]);
  const firstTime = samples[0]?.time ?? 0, lastTime = samples.at(-1)?.time ?? firstTime;
  const extent = Math.max(.01, ...values.map(Math.abs));
  const low = Math.min(0, ...values) - extent * .12, high = Math.max(0, ...values) + extent * .12;
  const x = (p: QuoteSample) => samples.length === 1 ? 355 : 12 + ((p.time - firstTime) / Math.max(1, lastTime - firstTime)) * 696;
  const y = (value: number) => 26 + ((high - value) / (high - low)) * 155;
  return <section className={`arb-history ${compact ? "is-compact" : ""}`} aria-label={`${symbol} quoted surplus history`}>
    <div className="arb-section-title"><div><h3>Watch the edge change</h3><p>Best quoted surplus · {amountLabel(amount)} USDG input · before extra costs</p></div><span>{samples.length} observations</span></div>
    {samples.length ? <>
      <div className="arb-history-readout"><strong>{selected?.value === null || selected?.value === undefined ? selected?.partial ? "Partial comparison" : "No route quote" : `${signed(selected.value, 4)} USDG`}</strong><span>{selected ? `${time(selected.time)} · block ${selected.block}` : ""}</span></div>
      <div className="arb-plot"><div className="arb-chart-axis" aria-hidden="true">{[high, 0, low].map((value, i) => <span key={i} style={{ top: `${y(value) / 200 * 100}%` }}>{new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: Math.abs(value) < .1 ? 3 : 2 }).format(value)}</span>)}</div><svg viewBox="0 0 720 200" role="img" aria-label={`Actual saved quote observations for ${symbol}; gaps mark partial quotes or long pauses. Latest ${samples.at(-1)?.value ?? "unavailable"} USDG.`} onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect(), px = ((event.clientX - bounds.left) / bounds.width) * 720;
        const nearest = samples.reduce((a, b) => Math.abs(x(a) - px) <= Math.abs(x(b) - px) ? a : b);
        setInspected(nearest.id);
      }} onPointerLeave={() => setInspected("")}>
        {[high, 0, low].map((v, i) => <g key={i}><line x1="12" x2="708" y1={y(v)} y2={y(v)} className={v === 0 ? "arb-zero" : "arb-grid"}/></g>)}
        {sampleSegments(samples).map((segment, i) => <path key={i} d={segment.map((p, j) => `${j ? "L" : "M"}${x(p)},${y(p.value!)}`).join(" ")} className="arb-series"/>)}
        {samples.map((p) => p.value !== null && <circle key={p.id} cx={x(p)} cy={y(p.value)} r={p.id === selected?.id ? 5 : 2.5} className="arb-point"/>)}
        {selected && <line x1={x(selected)} x2={x(selected)} y1="18" y2="187" className="arb-crosshair"/>}
      </svg></div><div className="arb-chart-times"><span>{time(firstTime)}</span><span>{samples.length > 1 ? time(lastTime) : "First observation"}</span></div>
      <input type="range" min="0" max={Math.max(0, samples.length - 1)} value={Math.max(0, samples.findIndex((p) => p.id === selected?.id))} onChange={(event) => setInspected(samples[Number(event.target.value)].id)} aria-label="Inspect quote history" aria-valuetext={selected ? `${time(selected.time)}, ${selected.value === null ? "No complete quote" : `${signed(selected.value, 4)} USDG before costs`}` : "No observations"}/>
      <p className="arb-chart-note">{samples.length === 1 ? "One real observation so far. A line appears as new blocks are sampled." : "Saved in this browser. Samples are not earnings; partial quotes and long pauses break the line."}</p>
    </> : <div className="arb-chart-empty"><Activity size={25}/><p>Your quote history starts with the first returned block.</p><span>Actual observations only · no sample prices</span></div>}
  </section>;
}

function RouteFlow({ quote, route, fresh, symbol, amount }: { quote?: QuoteBook; route?: RouteQuote; fresh: boolean; symbol: string; amount: string }) {
  const reduced = useReducedMotion();
  return <div className="arb-flow" aria-label="Quoted USDG to Stock Token to USDG route">
    <svg viewBox="0 0 720 170" preserveAspectRatio="none" aria-hidden="true"><path className="arb-flow-track" d="M95 102 C180 10 260 10 355 102 S540 192 625 102"/>{route && <motion.path key={`${quote?.blockHash}:${routeKey(route)}`} d="M95 102 C180 10 260 10 355 102 S540 192 625 102" className="arb-flow-line" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduced || !fresh ? 0 : .8, ease: "easeOut" }}/>}</svg>
    <div className="arb-flow-fees"><span>{route ? `Buy · ${fee(route.buyFee)} pool` : "Buy pool"}</span><span>{route ? `Sell · ${fee(route.sellFee)} pool` : "Sell pool"}</span></div>
    <div className="arb-flow-nodes"><div><TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={42}/><span>Starting amount</span><strong>{amountLabel(amount)}<small>USDG</small></strong></div><div><StockLogo symbol={symbol} size={48}/><span>Stock Token</span><strong>{symbol}</strong></div><div><TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={42}/><span>Quoted return</span><strong>{route ? n(route.amountOut, 4) : "—"}<small>USDG</small></strong></div></div>
  </div>;
}

export function ArbitrageMonitor({ assets, registryReady, now, batchRunning, onInspect }: { assets: StockAsset[]; registryReady: boolean; now: number; batchRunning: boolean; onInspect: (symbol: string, quote?: QuoteBook) => void }) {
  const [symbol, setSymbol] = useState("NVDA"), [amount, setAmount] = useState("1000"), [draft, setDraft] = useState("1000");
  const [enabled, setEnabled] = useState(true), [visible, setVisible] = useState(true), [online, setOnline] = useState(true);
  const [selection, setSelection] = useState(""), [unit, setUnit] = useState<"USDG" | "bps">("USDG");
  const [details, setDetails] = useState(false);
  const queryClient = useQueryClient();
  const journal = useResearchJournal();
  const lastSaved = useRef("");
  const inputId = useId();
  const symbols = TRACKED_SYMBOLS.filter((s) => assets.some((a) => a.active && a.symbol === s));
  const valid = /^\d{1,7}(\.\d{1,6})?$/.test(draft) && Number(draft) >= 1 && Number(draft) <= 100000;
  const key = ["arbitrage-live", symbol, amount];
  const active = enabled && visible && online && registryReady && symbols.includes(symbol) && !batchRunning;
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => requestResearchQuote(symbol, amount, signal), enabled: active,
    refetchInterval: (q) => q.state.error ? monitorRetryDelay(q.state.fetchFailureCount) : ARBITRAGE_INTERVAL,
    refetchIntervalInBackground: false, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 10000,
  });
  useEffect(() => {
    const sync = () => {
      const available = document.visibilityState === "visible" && navigator.onLine;
      setVisible(document.visibilityState === "visible"); setOnline(navigator.onLine);
      if (!available) void queryClient.cancelQueries({ queryKey: ["arbitrage-live"] });
    };
    sync(); window.addEventListener("online", sync); window.addEventListener("offline", sync); document.addEventListener("visibilitychange", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); document.removeEventListener("visibilitychange", sync); };
  }, [queryClient]);
  useEffect(() => { if (!active) void queryClient.cancelQueries({ queryKey: ["arbitrage-live", symbol, amount] }); }, [active, symbol, amount, queryClient]);
  const quote = query.data;
  useEffect(() => {
    if (!quote || lastSaved.current === `${quote.symbol}:${quote.amountIn}:${quote.blockHash}`) return;
    lastSaved.current = `${quote.symbol}:${quote.amountIn}:${quote.blockHash}`;
    saveObservation({ id: crypto.randomUUID(), symbol: quote.symbol, amount: quote.amountIn, checkedAt: quote.fetchedAt, quote, assumedCost: null });
  }, [quote]);
  const routes = rankedRoutes(quote), best = routes[0], route = routes.find((item) => routeKey(item) === selection) ?? best;
  const life = quoteLife(quote, now);
  const gate = researchQuoteStatus();
  const due = Math.max(gate.nextAt, query.error ? query.errorUpdatedAt + monitorRetryDelay(query.failureCount) : query.dataUpdatedAt + ARBITRAGE_INTERVAL);
  const remaining = Math.max(0, Math.ceil((due - now) / 1000));
  const samples = journal.records.flatMap((record) => record.quote ? [record.quote] : []);
  const history = quote ? [quote, ...samples] : samples;
  const recent = quoteSamples(history, symbol, amount).slice(-4).reverse();
  const surplus = route ? Number(route.surplus) : null;
  const noQuote = quote?.availability === "one_active_pool" ? "A second active pool is needed." : quote?.availability === "no_pools" ? "No supported pools found." : quote?.availability === "no_active_pools" ? "No active liquidity in the supported pools." : "No round-trip quote returned.";
  const state = !registryReady ? "Verifying token registry" : batchRunning ? "Paused for batch check" : !online ? "Offline · paused" : !visible ? "Hidden tab · paused" : !enabled ? "Monitoring paused" : query.isFetching ? gate.inFlight ? "Reading the next block" : "Waiting for quote slot" : query.error ? "Provider recovery" : "Monitoring every 15s";
  function pause() { setEnabled(!enabled); if (enabled) void queryClient.cancelQueries({ queryKey: ["arbitrage-live"] }); }
  function selectMarket(next: string) { setSelection(""); setSymbol(next); }
  return <MotionConfig reducedMotion="user"><section className="arb-monitor" aria-label="Live arbitrage monitor">
    <div className="arb-topline"><div className="arb-monitor-title"><Radio size={20}/><h2>Live arbitrage</h2><span>Robinhood Chain</span></div><button className="arb-pause" aria-pressed={enabled} onClick={pause}>{enabled ? <Pause size={15}/> : <Play size={15}/>} {enabled ? "Pause" : "Resume"}</button></div>
    <div className="arb-controls"><div className="arb-market-picker" aria-label="Monitored Stock Token">{(symbols.length ? symbols : TRACKED_SYMBOLS).map((s) => <button key={s} disabled={!symbols.includes(s)} aria-pressed={s === symbol} onClick={() => selectMarket(s)}><StockLogo symbol={s} size={24}/>{s}</button>)}</div><form className="arb-size" onSubmit={(event) => { event.preventDefault(); if (valid) { setAmount(String(Number(draft))); setSelection(""); } }}><label htmlFor={inputId}>Round-trip size</label><div><input id={inputId} value={draft} inputMode="decimal" autoComplete="off" onChange={(event) => setDraft(event.target.value)} aria-invalid={!valid}/><span>USDG</span><button disabled={!valid || Number(draft) === Number(amount)} aria-label="Apply quote amount"><Check size={18}/></button></div>{!valid && <p role="status">Use 1–100,000 USDG, up to 6 decimals.</p>}</form></div>
    <div className="arb-live-status"><span><i data-active={active && !query.error}/>{state}</span><span>{quote ? `Block ${quote.blockNumber} · ${ageLabel(quote.blockTimestamp, now)}` : "Awaiting the first observation"}</span><button disabled={query.isFetching || !registryReady || !symbols.includes(symbol) || !visible || !online || batchRunning || remaining > 0} onClick={() => void query.refetch()}><RefreshCw size={13} className={query.isFetching ? "spin" : ""}/>{active && !query.isFetching ? `Next check ${remaining}s` : "Refresh"}</button></div>
    {query.error && <p className="arb-source-message" role="status">{query.error.message} {remaining ? `Retry available in ${remaining}s.` : ""} {quote ? "The previous observation stays visible with its original timestamp." : "No result is substituted."}</p>}
    <div className="arb-observation">
      <div className="arb-edge"><div><span>{route && best && routeKey(route) !== routeKey(best) ? "Selected route" : quote?.failed ? "Best returned route · partial" : "Best quoted round trip"}</span><span className={`arb-freshness ${life.fresh ? "is-fresh" : ""}`}><Clock3 size={12}/>{quote ? life.fresh ? `Fresh for ${life.remaining}s` : "Expired observation" : "Waiting for data"}</span></div><motion.strong key={`${quote?.blockHash}:${selection}`} initial={{ opacity: .5 }} animate={{ opacity: 1 }} transition={{ duration: .3 }} className={surplus !== null && surplus > 0 ? "is-positive" : "is-negative"}>{surplus === null ? "—" : signed(surplus, 4)}<small>USDG</small></motion.strong><p>{route ? `${signed(Number(route.surplus) / Number(amount) * 10000)} bps · after pool fees and price impact` : quote ? noQuote : `Checking ${symbol} across four pool fee tiers.`}</p><div className="arb-lifetime" aria-hidden="true"><i style={{ transform: `scaleX(${life.fraction})` }}/></div><p className="arb-cost-note">{surplus !== null && surplus > 0 ? "Positive before unknown execution costs. This is a research candidate." : surplus === 0 ? "This quote returns the input before additional execution costs." : surplus !== null ? "This quote returns less than the input before additional execution costs." : "Both swap legs are simulated at one chain block."}</p></div>
      <RouteFlow quote={quote} route={route} fresh={life.fresh && active} symbol={symbol} amount={amount}/>
    </div>
    <div className="arb-analysis-grid"><section className="arb-matrix-section" aria-label="Pool route comparison"><div className="arb-section-title"><div><h3>Find the better route</h3><p>Buy fee ↓ · sell fee →</p></div><div className="arb-unit-switch">{(["USDG", "bps"] as const).map((value) => <button key={value} aria-pressed={unit === value} onClick={() => setUnit(value)}>{value}</button>)}</div></div><div className="arb-matrix" role="group" aria-label={`Quoted surplus by pool fee in ${unit}`}><span aria-hidden="true"/>{ROUTE_FEES.map((value) => <span className="arb-matrix-axis" key={value}>{fee(value)}</span>)}{ROUTE_FEES.map((buy) => <div className="arb-matrix-row" key={buy}><span className="arb-matrix-axis">{fee(buy)}</span>{ROUTE_FEES.map((sell) => {
      const cell = routes.find((item) => item.buyFee === buy && item.sellFee === sell);
      const value = cell ? Number(cell.surplus) * (unit === "bps" ? 10000 / Number(amount) : 1) : null;
      const strength = cell ? 8 + Math.min(1, Math.abs(Number(cell.surplus)) / Number(amount)) * 26 : 0;
      return <button key={sell} style={cell ? { backgroundColor: `color-mix(in srgb, ${Number(cell.surplus) > 0 ? "#78965d" : "#c58355"} ${strength}%, #fffffb)` } : undefined} disabled={!cell} data-sign={value === null ? "none" : value > 0 ? "positive" : "negative"} aria-pressed={!!cell && !!route && routeKey(cell) === routeKey(route)} aria-label={`${fee(buy)} buy, ${fee(sell)} sell: ${value === null ? buy === sell ? "same pool excluded" : "no returned quote" : `${signed(value, 4)} ${unit} before additional costs`}`} onClick={() => { if (cell) setSelection(routeKey(cell)); }}>{value === null ? buy === sell ? "×" : "—" : signed(value, Math.abs(value) >= 100 ? 0 : 2)}{cell && best && routeKey(cell) === routeKey(best) && <i aria-label="Best returned quote"/>}</button>;
    })}</div>)}</div><div className="arb-matrix-note"><span><i/>Best returned quote</span><span>{quote ? `${routes.length}/${quote.attempted} routes · ${quote.failed} failed` : "Awaiting routes"}</span></div><p className="arb-chart-note">Choose a cell to trace that route. A dash means no quote was returned. Prices may change before execution.</p></section>
      <QuoteHistory quotes={history} symbol={symbol} amount={amount}/>
    </div>
    <div className="arb-bottom"><div className="arb-observation-tape"><Activity size={16}/><span>Recent blocks</span>{recent.map((sample) => <span key={sample.id}>{time(sample.time)}<strong>{sample.value === null ? "Incomplete" : signed(sample.value)}</strong></span>)}</div><button disabled={!quote} onClick={() => setDetails(!details)} aria-expanded={details}>{details ? "Hide" : "Show"} route details<ChevronRight size={15}/></button></div>
    {details && quote && <div className="arb-route-list">{routes.length ? routes.map((item, index) => <button key={routeKey(item)} aria-pressed={!!route && routeKey(item) === routeKey(route)} onClick={() => setSelection(routeKey(item))}><span>{index + 1}</span><span>{fee(item.buyFee)} <ArrowRight size={12}/> {fee(item.sellFee)}</span><span>{n(item.amountOut, 6)} USDG returned</span><strong>{signed(Number(item.surplus), 4)} USDG</strong></button>) : <p>{noQuote}</p>}</div>}
    <div className="arb-boundary"><span><ScanLine size={17}/>Read-only polling · full gas and executor costs are not measured.</span><button disabled={!quote} onClick={() => onInspect(symbol, quote)}>Inspect route evidence<ArrowUpRight size={15}/></button></div>
  </section></MotionConfig>;
}

export function ResearchHistoryChart({ now, onOpen }: { now: number; onOpen: () => void }) {
  const journal = useResearchJournal();
  const [chosen, setChosen] = useState("");
  const quotes = journal.records.flatMap((record) => record.quote ? [record.quote] : []);
  const combinations = [...new Map(quotes.map((quote) => [`${quote.symbol}:${Number(quote.amountIn)}`, { symbol: quote.symbol, amount: quote.amountIn }])).entries()];
  const selection = combinations.find(([key]) => key === chosen) ?? combinations[0];
  if (!selection) return <section className="arb-journal-chart"><div className="arb-journal-heading"><span><Activity size={18}/>Arbitrage, block by block</span><button onClick={onOpen}>Open live monitor<ArrowUpRight size={15}/></button></div><p className="arb-chart-note arb-journal-intro">Follow real round-trip quotes and build a history of how they change. Your first observation starts the chart.</p></section>;
  const latest = quoteSamples(quotes, selection[1].symbol, selection[1].amount).at(-1);
  return <section className="arb-journal-chart"><div className="arb-journal-heading"><span><Layers3 size={18}/>Recorded arbitrage signals</span><select aria-label="Saved market and quote size" value={selection[0]} onChange={(event) => setChosen(event.target.value)}>{combinations.map(([key, value]) => <option key={key} value={key}>{value.symbol} · {amountLabel(value.amount)} USDG</option>)}</select><button onClick={onOpen}>Open live monitor<ArrowUpRight size={15}/></button></div><QuoteHistory quotes={quotes} symbol={selection[1].symbol} amount={selection[1].amount} compact/><p className="arb-chart-note">Saved observations only. Latest observed block for this selection {ageLabel(latest ? new Date(latest.time).toISOString() : undefined, now)}.</p></section>;
}
