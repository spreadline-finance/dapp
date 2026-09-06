"use client";
import { useRef, useState, useEffect } from "react";
import { ArrowDown, ArrowUpRight, Check, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { DataError, displayNumber as n, getData, shortAddress } from "@/lib/live-api";
import { CHAIN_ID, EXPLORER, SWAP_ROUTER, type StockAsset } from "@/lib/market-types";
import { parseSwapAmount, uniswapLink, type SwapQuote, type TradePlan, type TradeSide } from "@/lib/trading";
import { readReceipt, recordTransaction, sendPreparedTrade, useTransactionLog, type TransactionRecord } from "@/lib/transactions";
import { WalletButton, type WalletState } from "./wallet";
import { StockLogo } from "./stock-logo";
const tokenNumber = (value: string) => Number(value) > 0 && Number(value) < .000001 ? value : n(value, 6);

export function TradeTicket({ asset, now, wallet }: { asset: StockAsset; now: number; wallet: WalletState }) {
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("100");
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<SwapQuote>();
  const [plan, setPlan] = useState<TradePlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [review, setReview] = useState(false);
  const [transactionMessage, setTransactionMessage] = useState("");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [recoveryReviewed, setRecoveryReviewed] = useState(false);
  const transactionLog = useTransactionLog();
  const assetTransactions = transactionLog.records.filter((t) => t.account.toLowerCase() === wallet.account?.toLowerCase() && t.symbol === asset.symbol);
  const pendingTransaction = assetTransactions.some((t) => t.status === "submitted");
  const recent = [...assetTransactions.filter((t) => t.status === "submitted"), ...assetTransactions.filter((t) => t.status !== "submitted")].slice(0, 3);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const inputSymbol = side === "buy" ? "USDG" : asset.symbol;
  const outputSymbol = side === "buy" ? asset.symbol : "USDG";
  const valid = (() => { try { parseSwapAmount(amount, side === "buy" ? 6 : asset.decimals); return true; } catch { return false; } })();
  const remaining = quote ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000)) : 0;
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const best = quote?.routes[0];
  function invalidate() { generation.current++; controller.current?.abort(); setQuote(undefined); setPlan(undefined); setReview(false); setError(""); setBusy(""); }
  async function compare(withWallet = false) {
    if (withWallet && wallet.demoWallet) return;
    if (!valid || busy || cooldown || !asset.active) return;
    const run = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy(withWallet ? "Checking balance & simulating…" : "Comparing pools…"); setError(""); setPlan(undefined); setReview(false);
    try {
      const params = new URLSearchParams({ symbol: asset.symbol, side, amount, slippageBps: String(slippage) });
      if (withWallet) {
        if (!wallet.account || wallet.chainId !== CHAIN_ID) throw new Error("Connect an account on Robinhood Chain first.");
        params.set("address", wallet.account);
        const result = await getData<TradePlan>(`trade-plan?${params}`, controller.current.signal);
        if (run !== generation.current) return;
        setPlan(result); setQuote(result.quote);
      } else {
        const result = await getData<SwapQuote>(`swap-quote?${params}`, controller.current.signal);
        if (run !== generation.current) return;
        setQuote(result);
      }
    } catch (failure) {
      if (run !== generation.current) return;
      setQuote(undefined);
      setError(failure instanceof Error ? failure.message : "The comparison could not be completed.");
      if (failure instanceof DataError) setRetryAt(failure.retryAt);
    } finally { if (run === generation.current) setBusy(""); }
  }
  async function submit() {
    if (wallet.demoWallet || !plan || !wallet.account || !wallet.selected || busy || pendingTransaction || !review) return;
    const submittedPlan = plan, account = wallet.account, provider = wallet.selected.provider;
    const run = generation.current;
    setBusy("Confirm in your wallet…"); setError(""); setTransactionMessage("");
    try {
      const hash = await sendPreparedTrade(provider, submittedPlan, { account, stock: asset.address, stockDecimals: asset.decimals, side, amount, slippageBps: slippage });
      // Preserve the hash even if navigation or an account change unmounts this ticket.
      recordTransaction({ hash, account, symbol: asset.symbol, side, amount: submittedPlan.quote.amountIn, kind: submittedPlan.status === "approval_required" ? "approval" : "swap", status: "submitted", submittedAt: new Date().toISOString() });
      if (run === generation.current) setTransactionMessage("Transaction submitted. Check confirmation below before the next step.");
    } catch (failure) {
      if (run === generation.current) setError(failure && typeof failure === "object" && "code" in failure && failure.code === 4001 ? "You declined the wallet request. Nothing was submitted by this request." : failure instanceof Error ? failure.message : "The wallet request did not complete. Check your wallet before retrying.");
    } finally { if (run === generation.current) { setBusy(""); setPlan(undefined); setReview(false); } }
  }
  async function checkReceipt(record: TransactionRecord) {
    if (wallet.demoWallet || !wallet.selected || busy) return;
    setBusy("Checking confirmation…"); setError("");
    try {
      const result = await readReceipt(wallet.selected.provider, record);
      if (result) {
        recordTransaction(result);
        setPlan(undefined); setReview(false);
        setTransactionMessage(result.status === "reverted" ? "The transaction reverted. Review it on the explorer before retrying." : record.kind === "approval" ? "Approval confirmed. Prepare a fresh trade to simulate the swap." : "Swap confirmed onchain. See the transaction for the final token amounts and fees.");
      } else setTransactionMessage("The transaction is still awaiting a receipt. You can check again shortly.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Confirmation could not be checked."); }
    finally { setBusy(""); }
  }
  return <section className="trade-ticket" aria-label="Buy and sell Stock Tokens">
    <div className="ticket-heading"><span className="stock-identity"><StockLogo symbol={asset.symbol} size={28}/>TRADE {asset.symbol}</span><span className="ticket-network"><i/>Robinhood Chain</span></div>
    <div className="trade-side">{(["buy", "sell"] as const).map((value) => <button key={value} aria-pressed={side === value} disabled={!!busy} onClick={() => { invalidate(); setSide(value); setAmount(value === "buy" ? "100" : "1"); }}>{value === "buy" ? "Buy" : "Sell"} {asset.symbol}</button>)}</div>
    <label className="trade-pay">You pay <span>{inputSymbol}</span><input aria-label={`Amount of ${inputSymbol} to ${side === "buy" ? "spend" : "sell"}`} value={amount} disabled={!!busy} onChange={(e) => { invalidate(); setAmount(e.target.value); }} inputMode="decimal" autoComplete="off"/></label>
    <div className="ticket-presets">{(side === "buy" ? ["100", "500", "1000"] : ["0.1", "1", "5"]).map((value) => <button key={value} disabled={!!busy} aria-pressed={amount === value} onClick={() => { invalidate(); setAmount(value); }}>{n(value, side === "buy" ? 0 : 1)}</button>)}</div>
    <div className="trade-direction"><ArrowDown size={17}/></div>
    <div className="trade-receive"><span>Estimated receive <b>{outputSymbol}</b></span><strong>{best ? tokenNumber(best.amountOut) : "—"}</strong><small>{best ? `Minimum ${best.minimumOut} ${outputSymbol}` : "Compare live routes to get an estimate"}</small></div>
    <label className="ticket-slippage">Slippage tolerance<select aria-label="Slippage tolerance" disabled={!!busy} value={slippage} onChange={(e) => { invalidate(); setSlippage(Number(e.target.value)); }}>{[10, 50, 100].map((bps) => <option value={bps} key={bps}>{bps / 100}%</option>)}</select></label>
    {!valid && <p className="ticket-message">Enter a positive amount up to 100,000, with up to six decimals.</p>}
    <button className="button button-primary ticket-primary" disabled={!!busy || !valid || !asset.active || cooldown > 0} onClick={() => void compare()}>{busy ? <><LoaderCircle className="spin" size={16}/>{busy}</> : cooldown ? `Source resumes in ${cooldown}s` : <><RefreshCw size={15}/>{quote ? "Refresh comparison" : "Compare live routes"}</>}</button>
    {error && <p className="ticket-message" role="alert">{error}</p>}
    {quote && <div className="ticket-quote-meta"><span>{quote.routes.length}/{quote.attempted} V3 pools quoted{quote.failed ? ` · ${quote.failed} failed` : ""}</span><span>{remaining ? `Quote expires in ${remaining}s` : "Quote expired"}</span></div>}
    {quote && !best && <p className="ticket-message">No active supported pool returned this trade. You can check broader routing on Uniswap.</p>}
    {best && <div className="ticket-route"><span>Best quoted route</span><strong>Uniswap V3 · {best.fee / 10000}% fee</strong><span>Effective price</span><strong>{n(best.priceUSDG, 4)} USDG / token</strong></div>}
    {best && quote && <details className="ticket-pool-comparison"><summary>Compare {quote.routes.length} pool quotes</summary><p>Estimated {outputSymbol} received, at the same input and block.</p>{quote.routes.map((route, i) => <div key={route.fee}><span>{route.fee / 10000}% fee {i === 0 && <b>Best quote</b>}</span><div><i style={{ width: `${Number(route.amountOut) / Number(best.amountOut) * 100}%` }}/></div><strong>{tokenNumber(route.amountOut)}</strong></div>)}<small>Bars start at zero. Pool fees and price impact are included; network fees are separate.</small></details>}
    {!wallet.demoWallet && <><a className="ticket-external" href={uniswapLink(asset.address, side, amount)} target="_blank" rel="noreferrer">Review swap on Uniswap<ArrowUpRight size={15}/></a>
    <p className="ticket-note">Uniswap requests its own quote and may use a different route. Robinhood’s USD reference is separate from these USDG pool quotes.</p></>}
    <div className="ticket-execution"><h3><ShieldCheck size={16}/> {wallet.demoWallet ? "Demo mode · quotes only" : "Execute with your wallet"}</h3>
      {wallet.demoWallet ? <p>Live quotes are available. Simulated holdings cannot be approved or traded, and no wallet request will be sent.</p> : !wallet.account ? <><p>Connect to check your balance, approve an exact amount and review a simulated swap.</p><WalletButton wallet={wallet}/></> : wallet.chainId !== CHAIN_ID ? <button className="button button-secondary" onClick={() => void wallet.switchNetwork()} disabled={wallet.pending}>Switch to Robinhood Chain</button> : <>
        <button className="button button-secondary" disabled={!!busy || !valid || cooldown > 0 || pendingTransaction} onClick={() => void compare(true)}>Check wallet & prepare trade</button>
        {plan && <div className="wallet-preflight"><div><Check size={13}/> Account {shortAddress(plan.account)}</div><div>Available: {n(plan.inputBalance, 6)} {inputSymbol}</div><div>Gas balance: {n(plan.nativeBalance, 8)} ETH</div><p>{plan.status === "insufficient_balance" ? `Not enough ${inputSymbol} for this amount.` : plan.status === "insufficient_gas" ? "More ETH is needed for transaction gas." : plan.status === "approval_required" ? "An exact-amount approval is needed before the swap can be simulated." : "The full swap simulation passed."}</p></div>}
        {plan?.transaction && <div className="trade-review"><p><strong>{plan.status === "approval_required" ? `Approve exactly ${n(plan.quote.amountIn, 6)} ${inputSymbol}` : `${side === "buy" ? "Buy" : "Sell"} ${asset.symbol}`}</strong></p><dl><div><dt>{plan.status === "approval_required" ? "Spender" : "Recipient"}</dt><dd>{shortAddress(plan.status === "approval_required" ? SWAP_ROUTER : plan.account)}</dd></div><div><dt>Gas estimate</dt><dd>{n(plan.gasEstimateETH, 8)} ETH</dd></div>{plan.status === "ready" && <div><dt>Minimum received</dt><dd>{plan.quote.routes[0].minimumOut} {outputSymbol}</dd></div>}</dl><p className="ticket-note">The wallet provides the final network fee. {plan.status === "approval_required" ? "Approval permits this router to spend the specified amount. It does not perform the swap." : "The transaction has an onchain deadline and a minimum-output limit. It can still revert and consume gas."}</p><label><input type="checkbox" checked={review} disabled={!!busy} onChange={(e) => setReview(e.target.checked)}/>{plan.status === "approval_required" ? "I reviewed the token, amount and spender." : "I reviewed the amount, minimum received and recipient."}</label><button className="button button-primary" disabled={!!busy || pendingTransaction || !review || !remaining || now >= Date.parse(plan.expiresAt)} onClick={() => void submit()}>{remaining ? plan.status === "approval_required" ? "Approve exact amount in wallet" : "Confirm swap in wallet" : "Preview expired · prepare again"}</button></div>}
      </>}
      {pendingTransaction && <p className="ticket-note">Check the pending transaction’s confirmation before preparing another {asset.symbol} trade.</p>}
      {transactionMessage && <p className="ticket-message" role="status">{transactionMessage}</p>}
      {recent.length > 0 && <div className="ticket-transactions"><h4>Recent {asset.symbol} transactions</h4>{recent.map((t) => <div key={t.hash}><a href={`${EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer">{t.kind === "approval" ? "Approval" : "Swap"} · {t.status}<ArrowUpRight size={12}/></a>{(t.status === "submitted" || t.status === "unresolved") && <button disabled={!!busy} onClick={() => void checkReceipt(t)}>Check confirmation</button>}{t.status === "submitted" && <button disabled={!!busy} onClick={() => { setRecoveryHash(recoveryHash === t.hash ? "" : t.hash); setRecoveryReviewed(false); }}>Replaced or dropped?</button>}{t.status === "submitted" && recoveryHash === t.hash && <div className="trade-review transaction-recovery"><p>Check this hash and any replacement in your wallet or the explorer. Clearing this local hold does not cancel the transaction; it could still execute and a new trade could spend funds again.</p><label><input type="checkbox" checked={recoveryReviewed} disabled={!!busy} onChange={(e) => setRecoveryReviewed(e.target.checked)}/>I checked my wallet and understand the original transaction may still execute.</label><button disabled={!!busy || !recoveryReviewed} onClick={() => { recordTransaction({ ...t, status: "unresolved" }); setRecoveryHash(""); setRecoveryReviewed(false); setPlan(undefined); setReview(false); setTransactionMessage("Local hold cleared. The unresolved transaction stays in your history; its onchain status has not changed."); }}>Keep unresolved record & clear local hold</button></div>}</div>)}</div>}
      {transactionLog.storageError && <p className="ticket-note">Browser storage is unavailable. Save the transaction link to keep this record.</p>}
      {!wallet.demoWallet && <p className="ticket-note">Spender: <a href={`${EXPLORER}/address/${SWAP_ROUTER}`} target="_blank" rel="noreferrer">Uniswap SwapRouter02<ArrowUpRight size={11}/></a>. You confirm every transaction in your wallet.</p>}
    </div>
  </section>;
}
