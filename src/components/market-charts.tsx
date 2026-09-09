"use client";
/* eslint-disable @next/next/no-img-element */
import { useId, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChartNoAxesCombined, SlidersHorizontal } from "lucide-react";
import { displayNumber as n, ageLabel } from "@/lib/live-api";
import { sourceIsCurrent } from "@/lib/live-freshness";
import { usePriceObservations } from "@/lib/price-observations";
import { modelRoundTrip } from "@/lib/chart-data";
import type { PriceBook, QuoteBook, StockAsset } from "@/lib/market-types";

import { StockLogo } from "./stock-logo";

const W = 760, H = 225, L = 22, R = 684, T = 20, B = 178;
const timeLabel = (time: number) => new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

export function ReferenceChart({ symbol, assets, book, now, onSelect, registryCached = false, sourceUnavailable = false, initialMode = "session", selectable = true }: {
  symbol: string; assets: StockAsset[]; book?: PriceBook; now: number; onSelect: (symbol: string) => void; registryCached?: boolean; sourceUnavailable?: boolean; initialMode?: "session" | "spread"; selectable?: boolean;
}) {
  const points = usePriceObservations(symbol);
  const [hovered, setHovered] = useState<number | null>(null);
  const [mode, setMode] = useState<"session" | "spread">(initialMode);
  const id = useId();
  const current = points.length ? points[mode === "spread" ? points.length - 1 : Math.min(hovered ?? points.length - 1, points.length - 1)] : undefined;
  const first = points[0];
  const last = points[points.length - 1];
  const quote = book?.quotes.find((q) => q.symbol === symbol);
  const delta = current && first ? (current.midpoint / first.midpoint - 1) * 100 : 0;
  const stale = registryCached || sourceUnavailable || !!book?.cachedSymbols?.includes(symbol) || !!book?.dataStatus || (!!last && !sourceIsCurrent(new Date(last.time).toISOString(), now, 90000));
  const values = points.flatMap((p) => [p.bid, p.ask]);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const pad = Math.max((max - min) * .25, max * .0001, .001);
  const low = min - pad, high = max + pad;
  const y = (value: number) => B - (value - low) / (high - low) * (B - T);
  const x = (time: number) => first && last && first.time !== last.time ? L + (time - first.time) / (last.time - first.time) * (R - L) : (L + R) / 2;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(p.midpoint)}`).join(" ");
  const selectedIndex = Math.min(hovered ?? Math.max(0, points.length - 1), Math.max(0, points.length - 1));
  return <section className="desk-panel reference-chart" aria-label={`${symbol} reference chart`}>
    <div className="desk-panel-heading">
      <div className="chart-asset-title">
        <StockLogo symbol={symbol} size={36}/>
        <div>{selectable ? <select aria-label="Chart Stock Token" value={symbol} onChange={(e) => { setHovered(null); onSelect(e.target.value); }}>
          {assets.length ? assets.map((a) => <option key={a.address} value={a.symbol}>{a.symbol}</option>) : <option>{symbol}</option>}
        </select> : <strong>{symbol} reference history</strong>}<span>USD reference · per token</span></div>
      </div>
      <div className="chart-tabs" aria-label="Chart display">
        <button aria-pressed={mode === "session"} onClick={() => { setHovered(null); setMode("session"); }}>Session</button>
        <button aria-pressed={mode === "spread"} onClick={() => { setHovered(null); setMode("spread"); }}>Bid / ask</button>
      </div>
    </div>
    <div className="reference-summary">
      <div><strong>{current ? `$${n(current.midpoint, 4)}` : "Awaiting first quote"}</strong>
        <span className={delta < 0 ? "chart-negative" : "chart-positive"}>{points.length > 1 ? <>{delta < 0 ? <ArrowDownRight size={14}/> : <ArrowUpRight size={14}/>} {n(delta, 3)}% since first observation</> : "Reference midpoint"}</span></div>
      <span className={`data-tag ${stale || quote?.halted ? "warning" : ""}`}><i/>{quote?.halted ? "Trading halted" : stale ? "Last observation" : current ? "Issuer reference" : "Connecting"}</span>
    </div>
    {!points.length ? <div className="chart-waiting"><ChartNoAxesCombined size={32}/><h3>{sourceUnavailable ? "Issuer quotes are unavailable" : "Waiting for an issuer quote"}</h3><p>{sourceUnavailable ? "Observations resume when the price source responds." : "New observations appear here while this tab is open."}</p><span>Historical prices are not available from this source.</span></div> : mode === "spread" ? <div className="bid-ask-view">
      <div><span>REFERENCE BID</span><strong>${n(last.bid, 4)}</strong></div>
      <div className="spread-bridge"><i/><span>{n((last.ask / last.bid - 1) * 10000, 2)} bps</span><i/></div>
      <div><span>REFERENCE ASK</span><strong>${n(last.ask, 4)}</strong></div>
      <p>Issuer bid and ask × the token multiplier. This reference range is separate from the USDG prices in liquidity pools.</p>
    </div> : <div className="price-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${symbol} reference midpoint, ${points.length} observed quotes. Latest ${n(last.midpoint, 4)} USD.`}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ad4e36" stopOpacity=".16"/><stop offset="100%" stopColor="#ad4e36" stopOpacity="0"/></linearGradient></defs>
        {[0, 1, 2, 3].map((i) => { const value = low + (high - low) * i / 3; return <g key={i}><line x1={L} x2={R} y1={y(value)} y2={y(value)} className="chart-grid"/><text x={R + 10} y={y(value) + 4}>{n(value, 3)}</text></g>; })}
        {points.length > 1 && <><path d={`${path} L${x(last.time)},${B} L${x(first.time)},${B} Z`} fill={`url(#${id})`}/><path d={path} className="chart-line"/></>}
        {current && <><line x1={x(current.time)} x2={x(current.time)} y1={T} y2={B} className="chart-crosshair"/><line x1={x(current.time)} x2={x(current.time)} y1={y(current.bid)} y2={y(current.ask)} className="chart-range"/><circle cx={x(current.time)} cy={y(current.midpoint)} r="5" fill="#a84a33" stroke="#fffefa" strokeWidth="3"/></>}
        <text x={L} y={208}>{timeLabel(first.time)}</text><text x={R} y={208} textAnchor="end">{timeLabel(last.time)} UTC</text>
        {points.length === 1 && <text x={(L + R) / 2} y={38} textAnchor="middle">First observation · waiting for the next source update</text>}
        <rect x={L} y={T} width={R - L} height={B - T} fill="transparent" onPointerMove={(e) => {
          const bounds = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
          const at = (e.clientX - bounds.left) / bounds.width * W;
          let closest = 0;
          points.forEach((p, i) => { if (Math.abs(x(p.time) - at) < Math.abs(x(points[closest].time) - at)) closest = i; });
          setHovered(closest);
        }} onPointerLeave={() => setHovered(null)}/>
      </svg>
      {points.length > 1 && <input className="chart-scrubber" aria-label="Inspect observation" type="range" min={0} max={points.length - 1} value={selectedIndex} onChange={(e) => setHovered(Number(e.target.value))} aria-valuetext={current ? `${timeLabel(current.time)} UTC, ${n(current.midpoint, 4)} USD` : undefined}/>}
    </div>}
    <div className="chart-footnote"><span><i className="legend-dot"/> {points.length} source observations · this tab</span><span>{current ? `${timeLabel(current.time)} UTC · ${ageLabel(new Date(current.time).toISOString(), now)}` : registryCached ? "Waiting for a fresh token multiplier" : "No historical prices inferred"}</span></div>
  </section>;
}

export function StrategyLab({ compact = false }: { compact?: boolean }) {
  const [size, setSize] = useState(1000);
  const [gap, setGap] = useState(80);
  const [fee, setFee] = useState(5);
  const [depth, setDepth] = useState(1000000);
  const [gas, setGas] = useState(1);
  const assumptions = { gapBps: gap, feeBps: fee, depth, gas };
  const result = modelRoundTrip(size, assumptions);
  const series = Array.from({ length: 61 }, (_, i) => modelRoundTrip(i * 10000 / 60, assumptions));
  const lower = Math.min(0, ...series.map((p) => p.net));
  const upper = Math.max(1, ...series.map((p) => p.net));
  const padding = (upper - lower) * .14;
  const modelY = (v: number) => B - (v - lower + padding) / (upper - lower + padding * 2) * (B - T);
  const modelX = (amount: number) => L + amount / 10000 * (R - L);
  const curve = series.map((p, i) => `${i ? "L" : "M"}${modelX(p.amount)},${modelY(p.net)}`).join(" ");
  return <section className={`desk-panel strategy-lab ${compact ? "compact" : ""}`}>
    <div className="desk-panel-heading"><div><span className="eyebrow">THE STRATEGY LAB</span><h2>How much of the gap survives?</h2></div><span className="model-label"><SlidersHorizontal size={13}/> Illustrative model</span></div>
    <div className="lab-layout"><div className="lab-chart">
      <div className="model-result"><div><span>Modeled net result</span><strong className={result.net >= 0 ? "chart-positive" : "chart-negative"}>{result.net > 0 ? "+" : ""}{n(result.net)} <small>USDG</small></strong></div><p>A bigger trade captures more of the gap, but also moves the pool prices.</p></div>
      <div className="model-plot"><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Illustrative net return by trade size. At ${size} USDG, modeled result is ${n(result.net)} USDG.`}>
        {[0, 1, 2, 3].map((i) => { const v = lower + (upper - lower) * i / 3; return <g key={i}><line x1={L} x2={R} y1={modelY(v)} y2={modelY(v)} className="chart-grid"/><text x={R + 10} y={modelY(v) + 4}>{n(v, 1)}</text></g>; })}
        <line x1={L} x2={R} y1={modelY(0)} y2={modelY(0)} className="chart-zero"/>
        <path d={curve} className="chart-line"/>
        <line x1={modelX(size)} x2={modelX(size)} y1={T} y2={B} className="chart-crosshair"/>
        <circle cx={modelX(size)} cy={modelY(result.net)} r="5" fill="#a84a33" stroke="#fffefa" strokeWidth="2"/>
        {[0, 2500, 5000, 7500, 10000].map((amount) => <text key={amount} x={modelX(amount)} y={207} textAnchor={amount === 0 ? "start" : amount === 10000 ? "end" : "middle"}>{n(amount, 0)}</text>)}
      </svg></div>
      <div className="chart-footnote"><span><i className="legend-dot"/> Modeled net result, USDG</span><span>Trade size, USDG →</span></div>
      <div className="cost-breakdown">{[["Price gap", result.gross], ["Swap fees", -result.fees], ["Price impact", -result.impact], ["Assumed gas", -result.gas]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{Number(value) > 0 ? "+" : ""}{n(value)}</strong></div>)}</div>
    </div><div className="lab-controls">
      <label htmlFor="model-size">Trade size <output>{n(size, 0)} USDG</output></label><input id="model-size" type="range" min="100" max="10000" step="100" value={size} onChange={(e) => setSize(Number(e.target.value))}/>
      <label htmlFor="model-gap">Initial price gap <output>{n(gap / 100)}%</output></label><input id="model-gap" type="range" min="0" max="200" step="5" value={gap} onChange={(e) => setGap(Number(e.target.value))}/>
      <label htmlFor="model-fee">Fee per swap</label><select id="model-fee" value={fee} onChange={(e) => setFee(Number(e.target.value))}>{[1, 5, 30, 100].map((v) => <option key={v} value={v}>{n(v / 100)}%</option>)}</select>
      <label htmlFor="model-depth">USDG reserve per pool</label><select id="model-depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{[250000, 1000000, 5000000].map((v) => <option key={v} value={v}>{n(v, 0)} USDG</option>)}</select>
      <label htmlFor="model-gas">Assumed gas <output>{n(gas)} USDG</output></label><input id="model-gas" type="range" min="0" max="10" step=".25" value={gas} onChange={(e) => setGas(Number(e.target.value))}/>
    </div></div>
    <p className="panel-note">Educational constant-product approximation with two equal-depth pools. All inputs are assumptions. This is not a Uniswap V3 quote, forecast, or executable return; it excludes Spreadline fees.</p>
  </section>;
}

export function RouteComparison({ data }: { data: QuoteBook }) {
  if (!data.routes.length) return null;
  const extent = Math.max(...data.routes.map((route) => Math.abs(Number(route.surplus))), .001);
  return <section className="desk-panel route-comparison"><div className="desk-panel-heading"><h2>The route makes the difference.</h2><span>Gross surplus · USDG</span></div><div className="route-bars">
    {data.routes.map((route, i) => <div className="route-bar-row" key={`${route.buyFee}-${route.sellFee}`}><span>{n(route.buyFee / 10000)}% <ArrowRight size={12}/> {n(route.sellFee / 10000)}% {i === 0 && <small>BEST QUOTED</small>}</span><div className="route-bar-track"><i/><b className={Number(route.surplus) >= 0 ? "gain" : "loss"} style={{ width: `${Math.abs(Number(route.surplus)) / extent * 48}%`, left: Number(route.surplus) >= 0 ? "50%" : `${50 - Math.abs(Number(route.surplus)) / extent * 48}%` }}/></div><strong>{Number(route.surplus) > 0 ? "+" : ""}{n(route.surplus, 4)}</strong></div>)}
    <div className="route-bar-axis"><span>Loss</span><span>0</span><span>Surplus</span></div>
  </div><p className="panel-note">Same input, same block, different pools. Includes swap fees and price impact; excludes executor fees and full transaction gas.</p></section>;
}

export function ProductGuide({ onAnalyze }: { onAnalyze: () => void }) {
  return <section className="product-guide">
    <div className="guide-art"><img src="/artwork/validation.webp" alt="Engraved balance mechanism illustrating the validation of a trading route"/><span className="eyebrow">THE SPREADLINE METHOD</span></div>
    <div className="guide-copy"><h2 className="display">Follow the money.<br/><em>All the way back.</em></h2><p>Spreadline explores price differences for the same Stock Token across liquidity pools on Robinhood Chain.</p>
      <div className="guide-route"><span>USDG</span><ArrowRight size={16}/><span>Stock Token</span><ArrowRight size={16}/><span>USDG</span></div>
      <ol><li><strong>Read the market.</strong><span>Identify official tokens and compare real USDG pool prices.</span></li><li><strong>Quote both swaps.</strong><span>Buy through one pool and sell through another at the same chain block.</span></li><li><strong>Measure what returns.</strong><span>Compare the returned USDG with your starting amount, then account for the remaining costs.</span></li></ol>
      <button className="text-link" onClick={onAnalyze}>Try a live route analysis <ArrowUpRight size={15}/></button><p className="guide-footnote">Available today: market reads, route quotes and wallet balances. Automated execution is planned.</p>
    </div>
  </section>;
}
