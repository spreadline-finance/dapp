"use client";
import { useRef, useState, useEffect } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import { DataError, displayNumber as n, getData } from "@/lib/live-api";
import { USDG, type StockAsset } from "@/lib/market-types";
import { parseSwapAmount, uniswapLink, type SwapQuote, type TradeSide } from "@/lib/trading";
import { useTransactionLog } from "@/lib/transactions";
import type { WalletState } from "./wallet";
import { TradeModal } from "./trade-modal";
import { StockLogo } from "./stock-logo";
import { TokenLogo } from "./token-logo";
import { ProtocolLogo } from "./protocol-logo";
const tokenNumber = (value: string) => Number(value) > 0 && Number(value) < .000001 ? value : n(value, 6);

export function TradeTicket({ asset, now, wallet }: { asset: StockAsset; now: number; wallet: WalletState }) {
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("100");
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<SwapQuote>();
  const [tradeOpen, setTradeOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const transactionLog = useTransactionLog();
  const pendingTransaction = transactionLog.records.some((t) => t.account.toLowerCase() === wallet.account?.toLowerCase() && t.symbol === asset.symbol && t.status === "submitted");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const inputSymbol = side === "buy" ? "USDG" : asset.symbol;
  const outputSymbol = side === "buy" ? asset.symbol : "USDG";
  const inputDecimals = Math.min(6, side === "buy" ? 6 : asset.decimals);
  const valid = (() => { try { parseSwapAmount(amount, side === "buy" ? 6 : asset.decimals); return true; } catch { return false; } })();
  const remaining = quote ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000)) : 0;
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const best = quote?.routes[0];
  function invalidate() { generation.current++; controller.current?.abort(); setQuote(undefined); setError(""); setBusy(""); }
  async function compare() {
    if (!valid || busy || cooldown || !asset.active) return;
    const run = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy("Comparing pools…"); setError("");
    try {
      const params = new URLSearchParams({ symbol: asset.symbol, side, amount, slippageBps: String(slippage) });
      const result = await getData<SwapQuote>(`swap-quote?${params}`, controller.current.signal);
      if (run === generation.current) setQuote(result);
    } catch (failure) {
      if (run !== generation.current) return;
      setQuote(undefined);
      setError(failure instanceof Error ? failure.message : "The comparison could not be completed.");
      if (failure instanceof DataError) setRetryAt(failure.retryAt);
    } finally { if (run === generation.current) setBusy(""); }
  }
  return <section className="trade-ticket" aria-label="Buy and sell Stock Tokens">
    <div className="ticket-heading"><div><span className="eyebrow">STOCK TOKEN SWAP</span><h2>Trade {asset.symbol}</h2></div><span className="ticket-network"><i/>Robinhood Chain</span></div>
    <div className="trade-side">{(["buy", "sell"] as const).map((value) => <button key={value} aria-pressed={side === value} disabled={!!busy} onClick={() => { invalidate(); setSide(value); setAmount(value === "buy" ? "100" : "1"); }}>{value === "buy" ? "Buy" : "Sell"} {asset.symbol}</button>)}</div>
    <div className="trade-amount-card trade-pay">
      <label htmlFor="trade-input-amount">You pay</label>
      <div className="trade-amount-row"><input id="trade-input-amount" aria-label={`Amount of ${inputSymbol} to ${side === "buy" ? "spend" : "sell"}`} aria-invalid={!valid} aria-describedby={!valid ? "trade-amount-error" : undefined} value={amount} disabled={!!busy} onChange={(e) => { invalidate(); setAmount(e.target.value); }} inputMode="decimal" autoComplete="off" spellCheck={false}/><span className="ticket-token">{side === "buy" ? <TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={26}/> : <StockLogo symbol={asset.symbol} size={26}/>}<b>{inputSymbol}</b></span></div>
      <div className="ticket-presets">{(side === "buy" ? ["100", "500", "1000"] : ["0.1", "1", "5"]).map((value) => <button key={value} disabled={!!busy} aria-pressed={amount === value} onClick={() => { invalidate(); setAmount(value); }}>{n(value, side === "buy" ? 0 : 1)}</button>)}</div>
    </div>
    <div className="trade-direction" aria-hidden="true"><ArrowDown size={17}/></div>
    <div className={`trade-amount-card trade-receive ${best && !remaining ? "quote-expired" : ""}`}>
      <span>{best && !remaining ? "Last quote · expired" : "You receive"}</span>
      <div className="trade-amount-row"><strong>{best ? tokenNumber(best.amountOut) : "—"}</strong><span className="ticket-token">{side === "buy" ? <StockLogo symbol={asset.symbol} size={26}/> : <TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={26}/>}<b>{outputSymbol}</b></span></div>
      <small>{best ? remaining ? `Minimum ${best.minimumOut} ${outputSymbol}` : "Refresh your quote before preparing a trade." : "Get a quote to see the estimated amount."}</small>
    </div>
    <label className="ticket-slippage">Slippage tolerance<select aria-label="Slippage tolerance" disabled={!!busy} value={slippage} onChange={(e) => { invalidate(); setSlippage(Number(e.target.value)); }}>{[10, 50, 100].map((bps) => <option value={bps} key={bps}>{bps / 100}%</option>)}</select></label>
    {!valid && <p className="ticket-message" id="trade-amount-error">Enter an amount above zero and at most 100,000 {inputSymbol}, with up to {inputDecimals} decimals.</p>}
    <button className="button button-secondary ticket-primary" disabled={!!busy || !valid || !asset.active || cooldown > 0} onClick={() => void compare()}>{busy ? <><LoaderCircle className="spin" size={16}/>{busy}</> : cooldown ? `Retry in ${cooldown}s` : <><RefreshCw size={15}/>{quote ? "Refresh quote" : "Get quote"}</>}</button>
    {!asset.active && <p className="ticket-message">This token is inactive in the official registry. Trading is unavailable.</p>}
    {error && <p className="ticket-message" role="alert">{error}</p>}
    {quote && <div className="ticket-quote-meta"><span>{quote.routes.length}/{quote.attempted} pools quoted{quote.failed ? ` · ${quote.failed} failed` : ""}</span><span>{remaining ? `Quote expires in ${remaining}s` : "Quote expired"}</span></div>}
    {quote && !best && <p className="ticket-message">No active supported pool returned this trade. You can check broader routing on Uniswap.</p>}
    {best && <div className="ticket-route"><span>Best quoted route</span><strong className="ticket-route-identity"><ProtocolLogo protocol="uniswap" size={19}/>Uniswap V3 · {best.fee / 10000}%</strong><span>Effective price</span><strong>{n(best.priceUSDG, 4)} USDG / token</strong></div>}
    {best && quote && quote.routes.length > 1 && <details className="ticket-pool-comparison"><summary>Compare {quote.routes.length} pool quotes</summary><p>Estimated {outputSymbol} received, at the same input and block.</p>{quote.routes.map((route, i) => <div key={route.fee}><span>{route.fee / 10000}% fee {i === 0 && <b>Best quote</b>}</span><div><i style={{ width: `${Number(route.amountOut) / Number(best.amountOut) * 100}%` }}/></div><strong>{tokenNumber(route.amountOut)}</strong></div>)}<small>Bars start at zero. Pool fees and price impact are included; network fees are separate.</small></details>}
    <button id="open-trade-modal" className="button button-primary ticket-primary ticket-open-trade" aria-haspopup="dialog" aria-expanded={tradeOpen} disabled={!asset.active && !pendingTransaction} onClick={() => { generation.current++; controller.current?.abort(); setBusy(""); setTradeOpen(true); }}>{pendingTransaction ? "View pending trade" : wallet.demoWallet ? "Preview trade" : "Trade in Spreadline"}<ArrowRight size={16}/></button>
    {!wallet.demoWallet && <><a className="ticket-external" href={uniswapLink(asset.address, side, amount)} target="_blank" rel="noreferrer"><ProtocolLogo protocol="uniswap" size={19}/>Open in Uniswap<ArrowUpRight size={15}/></a>
    <p className="ticket-note">Trade here with your wallet, or open Uniswap for its own quote and routing.</p></>}
    {wallet.demoWallet && <p className="ticket-note">Demo mode supports live quotes. Simulated holdings cannot be traded.</p>}
    <TradeModal asset={asset} now={now} wallet={wallet} open={tradeOpen} onOpenChange={setTradeOpen} side={side} amount={amount} slippage={slippage} initialQuote={quote} onDraftChange={(draft) => { invalidate(); setSide(draft.side); setAmount(draft.amount); setSlippage(draft.slippage); }}/>
  </section>;
}
