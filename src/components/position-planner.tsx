"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check, CircleHelp, Clock3, Layers3, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { EXPLORER, type StockAsset } from "@/lib/market-types";
import { DataError, ageLabel, displayNumber, getData, shortAddress } from "@/lib/live-api";
import { assessPositionPlan, averagePlannerPrice, parsePlannerAmount, type PlannerPosition, type PlannerRow, type PositionPlan } from "@/lib/position-planner";
import type { TradeSide } from "@/lib/trading";
import type { WalletState } from "./wallet";
import { demoBalance } from "@/lib/demo-wallet";
import { StockLogo } from "./stock-logo";
import "./position-planner.css";

function quantity(value: string | number | null) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (numeric > 0 && numeric < 0.000001) return numeric.toExponential(3);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(numeric);
}
function unavailable(row: PlannerRow) {
  switch (row.status) {
    case "too_small": return "Below token precision";
    case "no_pools": return "No supported pools found";
    case "no_active_pools": return "No active supported pools";
    case "full_size_unavailable": return "No verified full-size quote";
    default: return "Quotes unavailable";
  }
}

export function PositionPlanner({ assets, symbol, onSelect, wallet, now, registryReady, registryError, initialAmount }: {
  assets: StockAsset[]; symbol: string; onSelect: (symbol: string) => void; wallet: WalletState; now: number;
  registryReady: boolean; registryError: string | null; initialAmount?: string;
}) {
  const [side, setSide] = useState<TradeSide>("sell");
  const [amount, setAmount] = useState(initialAmount ?? "10");
  const [limit, setLimit] = useState("0.50");
  const [address, setAddress] = useState("");
  const [holding, setHolding] = useState<PlannerPosition>();
  const [plan, setPlan] = useState<PositionPlan>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState<"quotes" | "balance" | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  const asset = assets.find((item) => item.symbol === symbol);
  const inputSymbol = side === "buy" ? "USDG" : symbol;
  const demoAmount = wallet.demoWallet ? demoBalance(wallet.demoWallet, inputSymbol) : undefined;
  const outputSymbol = side === "buy" ? symbol : "USDG";
  const inputDecimals = side === "buy" ? 6 : asset?.decimals ?? 18;
  let validation = "";
  try { parsePlannerAmount(amount, inputDecimals); } catch (e) { validation = (e as Error).message; }
  const thresholdBps = /^\d(\.\d{1,2})?$/.test(limit) && Number(limit) <= 5 ? Math.round(Number(limit) * 100) : -1;
  const current = plan?.symbol === symbol && plan.stock.toLowerCase() === asset?.address.toLowerCase() ? plan : undefined;
  const assessment = current ? assessPositionPlan(current, thresholdBps, now) : undefined;
  const waiting = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const inspectedAddress = address.trim() || wallet.account || "";
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(inspectedAddress);
  const largest = assessment?.largest;
  const full = current?.rows.find((row) => row.percentage === 100);
  const expiry = current ? Math.max(0, Math.ceil((Date.parse(current.expiresAt) - now) / 1000)) : 0;

  function clearComparison() {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setBusy(null); setPlan(undefined); setError(undefined); setHolding(undefined);
  }
  function changeSide(next: TradeSide) {
    if (next === side) return;
    clearComparison(); setSide(next); setAmount(next === "buy" ? "1000" : "10");
  }
  async function request(kind: "quotes" | "balance") {
    if (kind === "balance" && wallet.demoWallet) return;
    if (controller.current || !asset || !registryReady || waiting > 0) return;
    const thisRun = ++generation.current;
    const abort = new AbortController();
    controller.current = abort; setBusy(kind); setError(undefined);
    if (kind === "quotes") { setPlan(undefined); setRetryAt(Date.now() + 15000); }
    const params = new URLSearchParams({ symbol });
    if (kind === "balance") params.set("address", inspectedAddress);
    else { params.set("side", side); params.set("amount", amount); }
    try {
      if (kind === "balance") {
        const result = await getData<PlannerPosition>(`planner-position?${params}`, abort.signal);
        if (thisRun !== generation.current) return;
        setHolding(result); setAmount(result.balance); setPlan(undefined);
      } else {
        const result = await getData<PositionPlan>(`position-plan?${params}`, abort.signal);
        if (thisRun !== generation.current) return;
        setPlan(result);
        requestAnimationFrame(() => resultsHeading.current?.focus({ preventScroll: true }));
      }
    } catch (e) {
      if (abort.signal.aborted || thisRun !== generation.current) return;
      const failure = e instanceof Error ? e : new Error("The comparison could not be completed.");
      setError(failure);
      if (failure instanceof DataError && failure.retryAt) setRetryAt((value) => Math.max(value, failure.retryAt));
    } finally {
      if (thisRun === generation.current) { setBusy(null); controller.current = null; }
    }
  }

  return <div className="position-planner">
    <div className="planner-layout">
      <form className="planner-builder" onSubmit={(event) => { event.preventDefault(); if (!validation) void request("quotes"); }}>
        <div className="planner-modes" aria-label="Choose trade direction">{(["sell", "buy"] as const).map((value) => <button key={value} type="button" aria-pressed={side === value} onClick={() => changeSide(value)}>{value === "sell" ? <ArrowUpRight size={17}/> : <ArrowDownRight size={17}/>} {value === "sell" ? "Plan an exit" : "Plan an entry"}</button>)}</div>
        <label htmlFor="planner-asset">Stock Token</label>
        <div className="planner-asset"><StockLogo symbol={symbol} size={30}/><select id="planner-asset" value={symbol} onChange={(event) => { clearComparison(); onSelect(event.target.value); }}>{assets.length ? assets.map((item) => <option key={item.address} value={item.symbol}>{item.symbol} — {item.name}</option>) : <option value={symbol}>{symbol}</option>}</select></div>
        <label htmlFor="planner-amount">{side === "buy" ? "Total budget to compare" : "Total tokens to compare"}</label>
        <div className="planner-amount"><input id="planner-amount" value={amount} inputMode="decimal" autoComplete="off" aria-invalid={!!validation} aria-describedby="planner-amount-help" onChange={(event) => { clearComparison(); setAmount(event.target.value); }}/><span>{inputSymbol}</span></div>
        <p id="planner-amount-help" className={validation ? "planner-invalid" : "planner-help"}>{validation || `We’ll quote 25%, 50% and 100% of this ${side === "buy" ? "budget" : "amount"}.`}</p>
        {demoAmount !== undefined ? <div className="planner-demo-balance"><span>Simulated balance: <strong>{demoAmount} {inputSymbol}</strong></span><button type="button" className="planner-secondary" disabled={Number(demoAmount) <= 0} onClick={() => { clearComparison(); setAmount(demoAmount); }}><Wallet size={16}/>Use demo {side === "buy" ? "budget" : "holding"}</button><span>Loads locally. The size comparison uses live pool quotes.</span></div> : side === "sell" && <details className="planner-wallet"><summary><Wallet size={16}/> Load a wallet holding</summary><label htmlFor="planner-address">Public wallet address</label><input id="planner-address" value={address} placeholder={wallet.account ? shortAddress(wallet.account) : "0x…"} autoComplete="off" spellCheck={false} onChange={(event) => { clearComparison(); setAddress(event.target.value); }}/><p className="planner-help">{wallet.account && !address ? `Using connected address ${shortAddress(wallet.account)}.` : "Read a balance without connecting or signing."}</p><button type="button" className="planner-secondary" disabled={!validAddress || !!busy || !registryReady || waiting > 0} onClick={() => void request("balance")}>{busy === "balance" ? <LoaderCircle className="spin" size={16}/> : <Wallet size={16}/>} Load {symbol} balance</button></details>}
        {holding && <p className="planner-holding"><Check size={16}/><span>Loaded {quantity(holding.balance)} {holding.symbol} from <a href={`${EXPLORER}/address/${holding.address}`} target="_blank" rel="noreferrer">{shortAddress(holding.address)}</a> · balance observed {ageLabel(holding.blockTimestamp, now)}. Quotes do not reserve this balance.</span></p>}
        {!registryReady && <p className="planner-invalid" role="status">{registryError || "Waiting for the current Stock Token registry."}</p>}
        <button className="button button-primary planner-submit" disabled={!!validation || !asset || !registryReady || !!busy || waiting > 0} type="submit">{busy === "quotes" ? <><LoaderCircle className="spin" size={17}/> Comparing three sizes…</> : waiting > 0 ? <><Clock3 size={17}/> Refresh available in {waiting}s</> : <><RefreshCw size={17}/>{current ? "Refresh size comparison" : "Compare three sizes"}</>}</button>
        {busy && <button type="button" className="planner-cancel" onClick={clearComparison}>Cancel request</button>}
        <p className="planner-help planner-readonly">Read-only quotes. No approval or transaction.</p>
        {error && <div className="planner-error" role="alert"><CircleHelp size={17}/><span>{error.message}</span></div>}
      </form>

      <section className="planner-results" aria-busy={busy === "quotes"} aria-labelledby="planner-results-title">
        <div className="planner-results-heading"><div><span className="planner-kicker">{side === "sell" ? "YOUR EXIT, AT THREE SIZES" : "YOUR BUDGET, AT THREE SIZES"}</span><h2 id="planner-results-title" ref={resultsHeading} tabIndex={-1}>{side === "sell" ? "What could you receive?" : "How far does your budget go?"}</h2></div>{current && <span className={`planner-freshness ${!assessment?.fresh ? "expired" : ""}`}><Clock3 size={14}/>{expiry ? `Expires in ${expiry}s` : "Quote expired"}</span>}</div>
        <div className="planner-limit"><label htmlFor="planner-limit">{side === "sell" ? "Maximum drop in average sell price" : "Maximum rise in average buy price"} <span>vs the 25% quote</span></label><div><input id="planner-limit" value={limit} inputMode="decimal" aria-invalid={thresholdBps < 0} aria-describedby="planner-limit-help" onChange={(event) => setLimit(event.target.value)}/><span>%</span></div></div>
        <p className="planner-help" id="planner-limit-help">{thresholdBps < 0 ? "Choose 0–5%, with up to two decimal places. " : ""}This compares size and route selection. It is not slippage protection or total execution cost; the 25% quote already includes trading costs.</p>

        {current && assessment ? <>
          <div className={`planner-verdict ${!assessment.fresh || !assessment.complete ? "caution" : ""}`} role="status">
            {!assessment.fresh ? <><Clock3 size={19}/><div><strong>Refresh before using this comparison</strong><p>The original quote has expired. The observations below remain for reference.</p></div></> : !assessment.complete ? <><CircleHelp size={19}/><div><strong>The size comparison is incomplete</strong><p>A size or pool could not be quoted. No largest size is highlighted while coverage is incomplete.</p></div></> : thresholdBps < 0 ? <><CircleHelp size={19}/><div><strong>Enter a valid comparison limit</strong><p>The quotes remain available below.</p></div></> : largest ? <><Check size={19}/><div><strong>{largest.percentage}% is the largest tested size within your limit</strong><p>{side === "sell" ? "Sell" : "Spend"} {quantity(largest.amountIn)} {inputSymbol} · estimated {quantity(largest.routes[0].amountOut)} {outputSymbol} received.</p></div></> : null}
          </div>
          <div className="planner-sizes">{assessment.rows.map(({ row, differenceBps, withinLimit }) => <article key={row.percentage} className={`planner-size ${largest?.percentage === row.percentage ? "highlighted" : ""}`}>
            <div className="planner-size-title"><strong>{row.percentage}<span>%</span></strong><span>{row.percentage === 25 ? "Comparison baseline" : row.percentage === 100 ? "Full entered amount" : "Half entered amount"}</span>{largest?.percentage === row.percentage && <span className="planner-size-tag"><Check size={13}/> Within limit</span>}</div>
            <div className="planner-size-numbers"><div><span>{side === "sell" ? "Tokens sold" : "USDG spent"}</span><strong title={row.amountIn}>{quantity(row.amountIn)} <small>{inputSymbol}</small></strong></div><div><span>Estimated received</span><strong title={row.routes[0]?.amountOut}>{row.routes.length ? quantity(row.routes[0].amountOut) : "—"} <small>{outputSymbol}</small></strong></div><div><span>Average {side} price</span><strong>{quantity(averagePlannerPrice(current, row))} <small>USDG / token</small></strong></div></div>
            <div className="planner-size-bottom"><span className={assessment.fresh && withinLimit === false ? "over-limit" : ""}>{differenceBps === null ? "Price comparison unavailable" : row.percentage === 25 ? "Baseline · not zero trading cost" : `${Math.abs(differenceBps) > 0 && Math.abs(differenceBps) < 0.01 ? "<0.0001" : displayNumber(Math.abs(differenceBps) / 100, 4)}% ${differenceBps < 0 ? "better" : "worse"} vs 25%`}{assessment.fresh && withinLimit === false ? " · over limit" : ""}</span><span>{row.status !== "quoted" ? unavailable(row) : `${row.routes.length}/${row.attempted} pools fully quoted${row.excludedRoutes.length ? ` · ${row.excludedRoutes.length} price-limit exclusion` : ""}${row.failed ? " · partial coverage" : ""}`}</span></div>
            {(row.routes.length > 0 || row.excludedRoutes.length > 0) && <details className="planner-route-details"><summary>Pool quotes & exact amounts</summary><p>Exact input: {row.amountIn} {inputSymbol}. Highest quoted output appears first.</p>{row.routes.map((route) => <div key={route.pool}><a href={`${EXPLORER}/address/${route.pool}`} target="_blank" rel="noreferrer">V3 · {route.fee / 10000}% fee <ArrowUpRight size={12}/></a><span>{route.amountOut} {outputSymbol}</span></div>)}{row.excludedRoutes.map((route) => <div key={route.pool}><span>V3 · {route.fee / 10000}% fee</span><span>Price limit reached; full input not verified. Excluded.</span></div>)}</details>}
          </article>)}</div>
          <div className="planner-evidence"><a href={`${EXPLORER}/block/${current.blockNumber}`} target="_blank" rel="noreferrer">Block {current.blockNumber} <ArrowUpRight size={13}/></a><span>{new Date(current.blockTimestamp).toLocaleString()}</span><span>{current.activePools} active / {current.discoveredPools} discovered pools</span></div>
        </> : <div className="planner-empty" role="status"><Layers3 size={26}/><h3>{busy === "quotes" ? "Reading all sizes at one block" : "Start with the amount you’re considering"}</h3><p>{busy === "quotes" ? "Checking supported pools and simulating independent quotes. This can take a few seconds." : "Your comparison will show estimated proceeds and how the average price changes with size."}</p><div>{[25, 50, 100].map((percent) => <span key={percent}><strong>{percent}%</strong><small>{busy === "quotes" ? "Comparing…" : "Awaiting quote"}</small></span>)}</div></div>}
        <div className="planner-costs"><div><Check size={16}/><span>Pool fees and simulated price impact are included in quoted output.</span></div><div><CircleHelp size={16}/><span>Network and approval fees are not estimated here. Proceeds are before those costs.</span></div><div><Layers3 size={16}/><span>Coverage: USDG pairs across four Uniswap V3 fee tiers. Each size is an alternative, not a sequence of trades. Other venues and split routes are not compared.</span></div></div>
        {full?.routes.length ? <p className="planner-final-note">A quoted output is an observation, not a guaranteed fill. Wallet balance, allowance and complete transaction simulation are checked separately when preparing an actual trade.</p> : null}
      </section>
    </div>
  </div>;
}
