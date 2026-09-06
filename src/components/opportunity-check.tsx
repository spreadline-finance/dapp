"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, CircleHelp, ChevronRight, Clock3, Download, FlaskConical, LoaderCircle, Search, ShieldCheck } from "lucide-react";
import { ageLabel, DataError, displayNumber as n } from "@/lib/live-api";
import { assessQuote, parseAssumedCost } from "@/lib/opportunity-assessment";
import { exportJournal, saveObservation, useResearchJournal, type ResearchObservation } from "@/lib/research-journal";
import { EXPLORER, TRACKED_SYMBOLS, type QuoteBook, type StockAsset } from "@/lib/market-types";
import { StockLogo } from "./stock-logo";
import { ArbitrageMonitor } from "./arbitrage-monitor";
import { requestResearchQuote } from "@/lib/research-quote-client";
import "./opportunity-check.css";

function signed(value: number, digits = 2) { return `${value > 0 ? "+" : ""}${n(value, value !== 0 && Math.abs(value) < 0.01 ? 6 : digits)}`; }

export function QuoteDecision({ quote, now, initialCost = "" }: { quote: QuoteBook; now: number; initialCost?: string }) {
  const [cost, setCost] = useState(initialCost);
  const assumed = parseAssumedCost(cost);
  const verdict = assessQuote(quote, assumed, now);
  return <section className={`decision-card ${verdict.kind}`}>
    <div className="decision-topline"><span><FlaskConical size={15}/> THE RESULT EXPLAINED</span><span className="observation-badge">{verdict.expired ? "Recorded quote · expired" : "Read-only quote"}</span></div>
    <h2>{verdict.headline}</h2>
    {verdict.best ? <>
      <p className="decision-explanation">For a {n(quote.amountIn)} USDG round trip through {quote.symbol}, the best returned quote {verdict.difference! < 0 ? "gave back less than you started with" : verdict.difference === 0 ? "returned your starting amount" : "gave back more than you started with"}. {verdict.incomplete ? "Some routes failed, so the comparison is incomplete." : "Both swap fees and price impact are already included."}</p>
      <div className="money-path"><div><span>You start with</span><strong>{n(quote.amountIn)}<small> USDG</small></strong></div><ArrowRight size={20}/><div><span>The quote returns</span><strong>{n(verdict.best.amountOut, 6)}<small> USDG</small></strong></div></div>
      <dl className="decision-breakdown"><div><dt>Difference before remaining costs</dt><dd className={verdict.difference! <= 0 ? "money-negative" : "money-candidate"}>{signed(verdict.difference!)} USDG</dd></div><div><dt>Full transaction gas + executor fees</dt><dd>Not measured</dd></div></dl>
      {verdict.difference! > 0 && <p className="cost-ceiling">The quoted difference can absorb at most <strong>{n(verdict.extraCostBudget, 6)} USDG</strong> of additional costs before reaching zero. Execution, latency and final fees still need to be tested.</p>}
      <details className="cost-scenario"><summary>What if I include additional costs?</summary><p>Enter an assumed total for full gas, executor fees and a safety allowance. Pool fees and price impact are already in the quote.</p><label htmlFor={`cost-${quote.blockNumber}-${quote.symbol}`}>Assumed extra cost <span>USDG</span></label><input id={`cost-${quote.blockNumber}-${quote.symbol}`} value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="Unknown until measured"/>{cost && assumed === null && <p role="alert">Enter a cost from 0 to 100,000 USDG, with up to six decimals.</p>}<div><span>Result under your assumption</span><strong>{verdict.scenario === null ? "Enter an assumption" : `${signed(verdict.scenario)} USDG`}</strong></div><small>This temporary assumption is not saved in the research log. It is not measured profit or a guarantee of execution.</small></details>
    </> : <p className="decision-explanation">This strategy needs two different active pools for the same token and USDG. A missing quote says nothing about prices or trading on other venues.</p>}
    <div className="decision-evidence"><span>{quote.routes.length}/{quote.attempted} routes returned{quote.failed ? ` · ${quote.failed} failed` : ""}</span><span>{quote.coverage ? `${quote.coverage.activePools} active pools · ` : ""}Uniswap V3 only</span><a href={`${EXPLORER}/block/${quote.blockNumber}`} target="_blank" rel="noreferrer">Block {quote.blockNumber}<ArrowUpRight size={12}/></a><span>{ageLabel(quote.blockTimestamp, now)}</span></div>
    <p className="decision-next"><ShieldCheck size={16}/>{["negative", "break_even"].includes(verdict.kind) ? "This observation does not support entering the round trip. Keep the record; there is no need to force a trade." : verdict.kind === "candidate" ? "Treat this as a research candidate. Recheck it, measure full costs and test execution before calling it an opportunity." : "Resolve the missing coverage or failed reads before drawing a conclusion."}</p>
  </section>;
}

export function OpportunityCheck({ assets, registryReady, registryError, now, onInspect, onLearn }: {
  assets: StockAsset[]; registryReady: boolean; registryError: string | null; now: number; onInspect: (symbol: string, quote?: QuoteBook) => void; onLearn: () => void;
}) {
  const [amount, setAmount] = useState("1000");
  const [selected, setSelected] = useState(["NVDA", "AAPL", "TSLA"]);
  const [results, setResults] = useState<ResearchObservation[]>([]);
  const [running, setRunning] = useState("");
  const [nextCheckAt, setNextCheckAt] = useState(0);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const journal = useResearchJournal();
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const validAmount = /^\d{1,7}(\.\d{1,6})?$/.test(amount) && Number(amount) >= 1 && Number(amount) <= 100000;
  const activeSymbols = assets.filter((asset) => asset.active).map((asset) => asset.symbol);
  const universe = TRACKED_SYMBOLS.filter((symbol) => activeSymbols.includes(symbol));
  const choices = selected.filter((symbol) => activeSymbols.includes(symbol));
  const cooldown = Math.max(0, Math.ceil((nextCheckAt - now) / 1000));
  const checked = results.filter((result) => result.quote);
  const negative = checked.filter((result) => assessQuote(result.quote!, null, now).kind === "negative");
  const flat = checked.filter((result) => assessQuote(result.quote!, null, now).kind === "break_even");
  const candidates = checked.filter((result) => assessQuote(result.quote!, null, now).kind === "candidate");
  const incomplete = results.filter((result) => !result.quote || ["missing", "incomplete"].includes(assessQuote(result.quote, null, now).kind));
  async function runCheck() {
    if (!validAmount || running || !registryReady || !choices.length || cooldown) return;
    const run = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setResults([]); setNotice(""); setExpanded(null); setNextCheckAt(Date.now() + 60000);
    try {
      for (const symbol of choices) {
        if (abort.signal.aborted) break;
        setRunning(symbol);
        const checkedAt = new Date().toISOString();
        try {
          const quote = await requestResearchQuote(symbol, amount, abort.signal);
          if (abort.signal.aborted || run !== generation.current) break;
          const record = { id: crypto.randomUUID(), symbol, amount: quote.amountIn, checkedAt, quote, assumedCost: null };
          saveObservation(record); setResults((current) => [...current, record]);
        } catch (error) {
          if (abort.signal.aborted || run !== generation.current) break;
          const record = { id: crypto.randomUUID(), symbol, amount, checkedAt, error: error instanceof Error ? error.message : "The quote source did not respond.", assumedCost: null };
          saveObservation(record); setResults((current) => [...current, record]);
          if (error instanceof DataError && (error.status === 429 || error.status >= 500)) {
            setNextCheckAt(Math.max(Date.now() + 60000, error.retryAt));
            setNotice("The provider needs a pause. The remaining markets were not checked; completed observations are saved.");
            break;
          }
        }
      }
    } finally { if (run === generation.current) setRunning(""); }
  }
  function cancelCheck() { generation.current++; controller.current?.abort(); setRunning(""); setNotice("Check stopped. Completed observations remain saved; unchecked markets have no result."); }
  return <div className="opportunity-workspace">
    <ArbitrageMonitor assets={assets} registryReady={registryReady} now={now} batchRunning={!!running} onInspect={onInspect}/>
    <details className="arb-batch"><summary>Compare a batch of markets<span>Up to 3 tokens · saved research</span><ChevronRight size={18}/></summary>
    <div className="start-context"><span><FlaskConical size={15}/> RESEARCH TOOL · NO TRADES</span><p>Spreadline tests one idea: buy a Stock Token through one pool, sell it through another, and compare the USDG returned with the amount you started with.</p></div>
    <div className="opportunity-layout"><section className="desk-panel check-builder"><div className="check-step"><span>01</span><div><h2>Test a round trip</h2><p>No wallet or deposit needed.</p></div></div>
      <label htmlFor="check-amount">Amount to test <span>USDG</span></label><div className="check-amount"><input id="check-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={!!running}/><span>USDG</span></div>
      <div className="check-presets">{["100", "1000", "5000"].map((size) => <button key={size} disabled={!!running} aria-pressed={amount === size} onClick={() => setAmount(size)}>{n(size, 0)}</button>)}</div>
      {!validAmount && <p className="check-validation" role="alert">Enter 1–100,000 USDG, with up to six decimals.</p>}
      <fieldset className="market-choices"><legend>Markets to check <span>Choose up to 3</span></legend>{(universe.length ? universe : TRACKED_SYMBOLS).map((symbol) => <button key={symbol} type="button" aria-pressed={selected.includes(symbol)} disabled={!!running || !universe.includes(symbol) || (!selected.includes(symbol) && choices.length >= 3)} onClick={() => setSelected((current) => current.includes(symbol) ? current.filter((s) => s !== symbol) : [...current.filter((s) => activeSymbols.includes(s)), symbol])}><StockLogo symbol={symbol} size={22}/>{selected.includes(symbol) && <Check size={12}/>} {symbol}</button>)}</fieldset>
      <button className="button button-primary run-check" disabled={!!running || !validAmount || !choices.length || !registryReady || cooldown > 0} onClick={() => void runCheck()}>{running ? <><LoaderCircle size={17} className="spin"/> Checking {running}…</> : cooldown > 0 ? <><Clock3 size={17}/> Ready again in {cooldown}s</> : <><Search size={17}/> Check {choices.length || selected.length} {choices.length === 1 ? "market" : "markets"}<ArrowRight size={17}/></>}</button>
      {running && <button className="stop-check" onClick={cancelCheck}>Stop after completed observations</button>}
      <p className="check-scope">Each token is checked in sequence against four Uniswap V3 fee tiers. This is not a scan of every venue or a continuous trading bot.</p>
      {!registryReady && <p className="check-validation" role="status">{registryError ? "Waiting for the official token registry to recover. Checks resume when token identities are verified." : "Loading official token identities…"}</p>}
    </section>
    <section className="check-results" aria-live="polite" aria-busy={!!running}>
      {!results.length && !running ? <div className="check-introduction"><span className="eyebrow">02 / UNDERSTAND THE ANSWER</span><h2>More than a price gap.<br/><em>A result you can read.</em></h2><div className="outcome-examples"><div><i className="negative-dot"/><p><strong>Loses before costs</strong><span>The quoted return is already below your input.</span></p></div><div><i className="candidate-dot"/><p><strong>Positive before unknown costs</strong><span>A candidate to investigate, with no profit established.</span></p></div><div><i className="unknown-dot"/><p><strong>Not enough evidence</strong><span>A source failed or the strategy lacks usable pools.</span></p></div></div><img src="/artwork/execution.webp" alt=""/></div> : <>
        <div className="check-summary"><span className="eyebrow">02 / {running ? "CHECK IN PROGRESS" : "WHAT THIS CHECK FOUND"}</span><h2>{running ? `Reading ${running}…` : candidates.length ? `${candidates.length} positive ${candidates.length === 1 ? "quote" : "quotes"}. Costs still need testing.` : (negative.length || flat.length) && !incomplete.length ? "The returned quotes do not cover execution costs." : "There is not enough evidence for a positive result."}</h2><p>{results.length} checked · {negative.length} negative · {flat.length} break even · {candidates.length} positive before costs · {incomplete.length} incomplete</p></div>
        {results.map((record) => { const result = record.quote ? assessQuote(record.quote, null, now) : null; return <article key={record.id} className={`scan-result ${result?.kind ?? "missing"}`}><div className="scan-result-title"><span className="scan-symbol stock-identity"><StockLogo symbol={record.symbol} size={26}/>{record.symbol}</span><span className="observation-badge">{!record.quote ? "Source failed" : result?.expired ? "Recorded · expired" : "Observed quote"}</span></div><h3>{result?.kind === "negative" ? `${n(Math.abs(result.difference!), Math.abs(result.difference!) < 0.01 ? 6 : 2)} USDG lost before costs` : result?.kind === "candidate" ? `${signed(result.difference!)} USDG before unknown costs` : result?.headline ?? "Could not complete this check."}</h3><p>{result?.best ? `${n(record.amount)} USDG → ${n(result.best.amountOut, 6)} USDG` : record.error ?? "Other venues were not checked."}</p><div className="scan-result-actions">{record.quote && <button onClick={() => setExpanded(expanded === record.id ? null : record.id)} aria-expanded={expanded === record.id}>{expanded === record.id ? "Hide explanation" : "Explain this result"}<CircleHelp size={14}/></button>}<button onClick={() => onInspect(record.symbol, record.quote)}>Inspect {record.symbol}<ArrowUpRight size={14}/></button></div>{expanded === record.id && record.quote && <QuoteDecision quote={record.quote} now={now}/>}</article>; })}
      </>}
      {notice && <p className="check-validation" role="status">{notice}</p>}
    </section></div>
    </details>
    <div className="evidence-strip"><ShieldCheck size={19}/><div><strong>Quotes are evidence. Earnings require actual execution.</strong><p>This research view does not place trades. A positive quote still needs full-cost estimates and successful execution; several observations cannot be added together as income.</p></div><button onClick={onLearn}>How this works<ArrowUpRight size={15}/></button></div>
    <ResearchJournal now={now} compact journal={journal}/>
  </div>;
}

export function ResearchJournal({ now, compact = false, journal: supplied }: { now: number; compact?: boolean; journal?: ReturnType<typeof useResearchJournal> }) {
  const local = useResearchJournal(); const journal = supplied ?? local;
  const [filter, setFilter] = useState("ALL");
  const [amountFilter, setAmountFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRecord = journal.records.find((record) => record.id === selectedId);
  const explanation = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selectedId) explanation.current?.scrollIntoView({ block: "start", behavior: "instant" }); }, [selectedId]);
  const symbols = [...new Set(journal.records.map((record) => record.symbol))];
  const amounts = [...new Set(journal.records.map((record) => record.amount))].sort((a, b) => Number(a) - Number(b));
  const filtered = journal.records.filter((record) => (filter === "ALL" || record.symbol === filter) && (amountFilter === "ALL" || record.amount === amountFilter));
  const display = compact ? filtered.slice(0, 5) : filtered;
  const positive = filtered.filter((record) => record.quote && assessQuote(record.quote, null, now).kind === "candidate").length;
  return <section className="desk-panel research-journal"><div className="desk-panel-heading"><div><span className="eyebrow">03 / KEEP THE EVIDENCE</span><h2>Research log</h2><p>Saved on this browser. Quote observations, never trading P&amp;L.</p></div><button className="journal-export" disabled={!filtered.length} onClick={() => exportJournal(filtered)}><Download size={15}/> Export JSON</button></div>
    {!compact && <div className="journal-filters"><label>Market<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ALL">All markets</option>{symbols.map((s) => <option key={s}>{s}</option>)}</select></label><label>Test amount<select value={amountFilter} onChange={(e) => setAmountFilter(e.target.value)}><option value="ALL">All amounts</option>{amounts.map((a) => <option key={a} value={a}>{n(a)} USDG</option>)}</select></label><span>{positive}/{filtered.length} observations positive before costs<br/>This is not a win rate or a count of unique opportunities.</span></div>}
    {journal.storageMessage && <p className="check-validation">{journal.storageMessage}</p>}
    {selectedRecord?.quote && <div className="saved-explanation" ref={explanation}><div><span>Saved observation · {new Date(selectedRecord.checkedAt).toLocaleString()}</span><button onClick={() => setSelectedId(null)}>Close explanation</button></div><QuoteDecision key={selectedRecord.id} quote={selectedRecord.quote} now={now}/></div>}
    {display.length ? <div className="journal-table-wrap"><table><thead><tr><th>Observation</th><th>Input</th><th>Quoted difference</th><th>Evidence</th></tr></thead><tbody>{display.map((record) => { const v = record.quote ? assessQuote(record.quote, null, now) : null; return <tr key={record.id}><td>{record.quote ? <button className="journal-open" aria-label={`Explain saved ${record.symbol} observation from ${new Date(record.checkedAt).toLocaleString()}`} onClick={() => setSelectedId(record.id)}>{record.symbol}<CircleHelp size={13}/></button> : <strong>{record.symbol}</strong>}<small>{new Date(record.checkedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></td><td>{n(record.amount)}<small>USDG</small></td><td className={v?.difference !== null && v?.difference !== undefined && v.difference <= 0 ? "money-negative" : ""}>{v?.difference !== null && v?.difference !== undefined ? `${signed(v.difference, 4)} USDG` : "No comparable quote"}<small>{record.error ? "Source failed" : v?.incomplete ? "Incomplete comparison" : "Before remaining costs"}</small></td><td>{record.quote ? <a href={`${EXPLORER}/block/${record.quote.blockNumber}`} target="_blank" rel="noreferrer">Block {record.quote.blockNumber}<ArrowUpRight size={12}/></a> : <span>{record.error}</span>}<small>{v?.expired ? "Quote expired" : record.quote ? "Read-only observation" : "No conclusion"}</small></td></tr>; })}</tbody></table></div> : <div className="journal-empty"><FlaskConical size={24}/><h3>No observations yet.</h3><p>Run a check to start a record of what worked, what lost and what could not be measured.</p></div>}
    <p className="panel-note">Up to 100 observations stay in this browser. Repeated quotes can describe the same market event. No cumulative profit, APY or realized returns are inferred.</p>
  </section>;
}
