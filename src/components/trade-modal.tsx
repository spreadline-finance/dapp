"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, ArrowLeft, ArrowUpRight, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { DataError, displayNumber as n, getData, shortAddress } from "@/lib/live-api";
import { CHAIN_ID, EXPLORER, SWAP_ROUTER, USDG, type StockAsset } from "@/lib/market-types";
import { parseSwapAmount, planMatches, type SwapQuote, type TradePlan, type TradeSide } from "@/lib/trading";
import { readReceipt, recordTransaction, sendPreparedTrade, useTransactionLog, type TransactionRecord } from "@/lib/transactions";
import { StockLogo } from "./stock-logo";
import { TokenLogo } from "./token-logo";
import { ProtocolLogo } from "./protocol-logo";
import { WalletButton, type WalletState } from "./wallet";
import "./trade-modal.css";

type Draft = { side: TradeSide; amount: string; slippage: number };
type TradeModalProps = Draft & {
  asset: StockAsset;
  now: number;
  wallet: WalletState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: Draft) => void;
  initialQuote?: SwapQuote;
};
type Step = "amount" | "review" | "confirm";
const steps: Step[] = ["amount", "review", "confirm"];
const tokenNumber = (value: string) => Number(value) > 0 && Number(value) < .000001 ? value : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(Number(value));

function quoteMatches(quote: SwapQuote | undefined, asset: StockAsset, draft: Draft) {
  if (!quote) return false;
  try {
    const input = draft.side === "buy" ? USDG : asset.address;
    const output = draft.side === "buy" ? asset.address : USDG;
    const decimals = draft.side === "buy" ? 6 : asset.decimals;
    return quote.symbol === asset.symbol && quote.side === draft.side && quote.slippageBps === draft.slippage
      && quote.tokenIn.toLowerCase() === input.toLowerCase() && quote.tokenOut.toLowerCase() === output.toLowerCase()
      && quote.inputDecimals === decimals && quote.outputDecimals === (draft.side === "buy" ? asset.decimals : 6)
      && BigInt(quote.amountInRaw) === parseSwapAmount(draft.amount, decimals);
  } catch { return false; }
}

export function TradeModal(props: TradeModalProps) {
  // The dialog and draft survive wallet connection. Only wallet-bound previews reset.
  const [walletRequestPending, setWalletRequestPending] = useState(false);
  const [publicMemory, setPublicMemory] = useState<{ quote?: SwapQuote; review: boolean }>({ review: false });
  const retainedQuote = publicMemory.quote ?? props.initialQuote;
  const startsAtReview = quoteMatches(retainedQuote, props.asset, props) && (publicMemory.review || props.now < Date.parse(retainedQuote!.expiresAt));
  const walletKey = `${props.wallet.demoWallet?.id ?? props.wallet.account ?? "guest"}:${props.wallet.chainId ?? "none"}:${props.wallet.selected?.info.uuid ?? "none"}`;
  return <Dialog.Root open={props.open} onOpenChange={(open) => {
    if (!open && walletRequestPending) return;
    if (!open) setPublicMemory({ review: false });
    props.onOpenChange(open);
  }}>
    <Dialog.Portal>
      <Dialog.Overlay className="trade-modal-overlay"/>
      <Dialog.Content className="trade-modal" onOpenAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLElement>("[data-trade-modal-heading]")?.focus({ preventScroll: true }); }} onCloseAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById("open-trade-modal")?.focus();
      }} onEscapeKeyDown={(event) => { if (walletRequestPending) event.preventDefault(); }} onInteractOutside={(event) => { if (walletRequestPending) event.preventDefault(); }}>
        <TradeFlow key={walletKey} {...props} initialQuote={retainedQuote} initialStep={startsAtReview ? "review" : "amount"} onPublicReview={(quote) => { setPublicMemory({ quote, review: true }); }} onEdit={() => { setPublicMemory({ review: false }); }} walletRequestPending={walletRequestPending} onWalletRequestPending={setWalletRequestPending}/>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function TradeFlow({ asset, now, wallet, side, amount, slippage, onDraftChange, initialQuote, initialStep, onPublicReview, onEdit, walletRequestPending, onWalletRequestPending }: TradeModalProps & {
  initialStep: "amount" | "review";
  onPublicReview: (quote: SwapQuote) => void;
  onEdit: () => void;
  walletRequestPending: boolean;
  onWalletRequestPending: (pending: boolean) => void;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [quote, setQuote] = useState<SwapQuote | undefined>(initialQuote);
  const [plan, setPlan] = useState<TradePlan>();
  const [busy, setBusy] = useState<"quote" | "prepare" | "receipt" | null>(null);
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [latest, setLatest] = useState<TransactionRecord>();
  const [message, setMessage] = useState("");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [recoveryReviewed, setRecoveryReviewed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const log = useTransactionLog();
  const records = log.records.filter((record) => record.account.toLowerCase() === wallet.account?.toLowerCase() && record.symbol === asset.symbol);
  const pending = records.find((record) => record.status === "submitted");
  const transaction = pending ?? (latest ? records.find((record) => record.hash === latest.hash) ?? latest : undefined);
  const recent = [...records.filter((record) => record.status === "submitted" || record.status === "unresolved"), ...records.filter((record) => record.status !== "submitted" && record.status !== "unresolved")].slice(0, 5);
  const activeStep = pending && !plan ? "confirm" : step;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [activeStep]);
  const inputSymbol = side === "buy" ? "USDG" : asset.symbol;
  const outputSymbol = side === "buy" ? asset.symbol : "USDG";
  const valid = (() => { try { parseSwapAmount(amount, side === "buy" ? 6 : asset.decimals); return true; } catch { return false; } })();
  const currentQuote = quoteMatches(quote, asset, { side, amount, slippage }) ? quote : undefined;
  const best = currentQuote?.routes[0];
  const quoteRemaining = currentQuote ? Math.max(0, Math.ceil((Date.parse(currentQuote.expiresAt) - now) / 1000)) : 0;
  const planFresh = !!plan && quoteMatches(plan.quote, asset, { side, amount, slippage }) && plan.account.toLowerCase() === wallet.account?.toLowerCase()
    && now < Date.parse(plan.expiresAt) && now < Date.parse(plan.quote.expiresAt);
  const planExecutable = !!plan && planFresh && asset.active && !plan.quote.failed && plan.quote.routes.length > 0
    && planMatches(plan, { account: wallet.account ?? "", stock: asset.address, stockDecimals: asset.decimals, side, amount, slippageBps: slippage }, now);
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const locked = !!busy || walletRequestPending;

  function edit(next?: Draft) {
    if (walletRequestPending) return;
    generation.current++; controller.current?.abort(); controller.current = null;
    setBusy(null); setPlan(undefined); setReviewed(false); setQuote(undefined); setError(""); setMessage("");
    setLatest(undefined); setStep("amount");
    onEdit();
    if (next) onDraftChange(next);
  }
  async function request(withWallet: boolean) {
    if (!valid || locked || cooldown || !asset.active || (withWallet && (wallet.demoWallet || pending))) return;
    if (withWallet && (!wallet.account || wallet.chainId !== CHAIN_ID)) return;
    const run = ++generation.current;
    controller.current?.abort(); controller.current = new AbortController();
    setBusy(withWallet ? "prepare" : "quote"); setError(""); setPlan(undefined); setReviewed(false); setMessage("");
    try {
      const params = new URLSearchParams({ symbol: asset.symbol, side, amount, slippageBps: String(slippage) });
      if (withWallet) params.set("address", wallet.account!);
      const result = await getData<SwapQuote | TradePlan>(`${withWallet ? "trade-plan" : "swap-quote"}?${params}`, controller.current.signal);
      if (run !== generation.current) return;
      const nextQuote = "quote" in result ? result.quote : result;
      if (!quoteMatches(nextQuote, asset, { side, amount, slippage })) throw new Error("The quote did not match your trade. Please try again.");
      setQuote(nextQuote); onPublicReview(nextQuote); setLatest(undefined);
      if ("quote" in result) { setPlan(result); setStep("confirm"); }
      else setStep("review");
    } catch (failure) {
      if (run !== generation.current) return;
      setQuote(undefined);
      setError(failure instanceof Error ? failure.message : "The trade could not be prepared.");
      if (failure instanceof DataError) setRetryAt(failure.retryAt);
    } finally { if (run === generation.current) { controller.current = null; setBusy(null); } }
  }
  async function submit() {
    if (wallet.demoWallet || !plan || !planExecutable || !reviewed || locked || pending || !wallet.account || !wallet.selected || wallet.chainId !== CHAIN_ID) return;
    const submittedPlan = plan, account = wallet.account, provider = wallet.selected.provider;
    const run = generation.current;
    onWalletRequestPending(true); setError(""); setMessage("");
    try {
      const hash = await sendPreparedTrade(provider, submittedPlan, { account, stock: asset.address, stockDecimals: asset.decimals, side, amount, slippageBps: slippage });
      const record: TransactionRecord = { hash, account, symbol: asset.symbol, side, amount: submittedPlan.quote.amountIn, kind: submittedPlan.status === "approval_required" ? "approval" : "swap", status: "submitted", submittedAt: new Date().toISOString() };
      // Wallet prompts cannot be aborted. Persist the captured hash after close or account change.
      recordTransaction(record);
      if (run === generation.current) { setLatest(record); setStep("confirm"); setMessage("Submitted to Robinhood Chain. Check confirmation to continue."); }
    } catch (failure) {
      if (run === generation.current) setError(failure && typeof failure === "object" && "code" in failure && failure.code === 4001
        ? "You declined the wallet request. Nothing was submitted by this request."
        : failure instanceof Error ? failure.message : "The wallet request did not complete. Check your wallet before retrying.");
    } finally {
      onWalletRequestPending(false);
      if (run === generation.current) { setPlan(undefined); setReviewed(false); }
    }
  }
  async function checkReceipt(record: TransactionRecord) {
    if (wallet.demoWallet || !wallet.selected || locked) return;
    const run = generation.current, provider = wallet.selected.provider;
    setBusy("receipt"); setError("");
    try {
      const result = await readReceipt(provider, record);
      if (result) recordTransaction(result);
      if (run !== generation.current) return;
      if (result) {
        setLatest(result); setPlan(undefined); setReviewed(false); setStep("confirm");
        setMessage(result.status === "reverted" ? "The transaction reverted. Review the explorer before trying again."
          : result.kind === "approval" ? "Approval confirmed. Prepare a fresh swap quote and review it before signing."
          : "Swap confirmed. The explorer shows the final token amounts and fees.");
      } else setMessage("This transaction is still pending. Check again shortly.");
    } catch (failure) { if (run === generation.current) setError(failure instanceof Error ? failure.message : "Confirmation could not be checked."); }
    finally { if (run === generation.current) setBusy(null); }
  }

  const quoteButton = <button className="button button-primary" disabled={locked || !valid || !asset.active || cooldown > 0} onClick={() => void request(false)}>
    {busy === "quote" ? <><LoaderCircle size={16} className="spin"/>Getting quote…</> : cooldown ? `Retry in ${cooldown}s` : step === "amount" ? "Get quote" : "Refresh quote"}
  </button>;
  const prepareButton = <button className="button button-primary" disabled={locked || !valid || !asset.active || cooldown > 0 || !!pending} onClick={() => void request(true)}>
    {busy === "prepare" ? <><LoaderCircle size={16} className="spin"/>Checking wallet…</> : cooldown ? `Retry in ${cooldown}s` : transaction?.kind === "approval" && transaction.status === "confirmed" ? "Prepare swap" : "Prepare trade"}
  </button>;
  return <>
    <header className="trade-modal-header"><div><Dialog.Title ref={heading} tabIndex={-1} data-trade-modal-heading>{activeStep === "amount" ? `Trade ${asset.symbol}` : activeStep === "review" ? "Review your quote" : transaction?.kind === "swap" && transaction.status === "confirmed" ? "Swap confirmed" : "Confirm your trade"}</Dialog.Title><Dialog.Description>Stock Token swap · Robinhood Chain</Dialog.Description></div><Dialog.Close className="trade-modal-close" aria-label="Close trade" disabled={walletRequestPending}><X size={20}/></Dialog.Close></header>
    <ol className="trade-modal-progress" aria-label="Trade progress">{steps.map((item, index) => <li key={item} data-state={item === activeStep ? "active" : index < steps.indexOf(activeStep) ? "complete" : "upcoming"} aria-current={item === activeStep ? "step" : undefined}><span>{index < steps.indexOf(activeStep) ? <Check size={13}/> : index + 1}</span>{item === "amount" ? "Amount" : item === "review" ? "Review" : "Confirm"}</li>)}</ol>
    <div className="trade-modal-body">
      {activeStep === "amount" ? <>
        <div className="trade-side">{(["buy", "sell"] as const).map((value) => <button key={value} aria-pressed={side === value} disabled={locked} onClick={() => edit({ side: value, amount: value === "buy" ? "100" : "1", slippage })}>{value === "buy" ? "Buy" : "Sell"} {asset.symbol}</button>)}</div>
        <div className="trade-amount-card trade-pay"><label htmlFor="modal-trade-amount">You pay</label><div className="trade-amount-row"><input id="modal-trade-amount" value={amount} disabled={locked} inputMode="decimal" autoComplete="off" aria-invalid={!valid} aria-describedby={!valid ? "modal-trade-amount-error" : undefined} onChange={(event) => edit({ side, amount: event.target.value, slippage })}/><span className="ticket-token">{side === "buy" ? <TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={26}/> : <StockLogo symbol={asset.symbol} size={26}/>}<b>{inputSymbol}</b></span></div><div className="ticket-presets">{(side === "buy" ? ["100", "500", "1000"] : ["0.1", "1", "5"]).map((value) => <button key={value} aria-pressed={amount === value} disabled={locked} onClick={() => edit({ side, amount: value, slippage })}>{n(value, side === "buy" ? 0 : 1)}</button>)}</div></div>
        <label className="ticket-slippage">Slippage tolerance<select disabled={locked} value={slippage} onChange={(event) => edit({ side, amount, slippage: Number(event.target.value) })}>{[10, 50, 100].map((bps) => <option value={bps} key={bps}>{bps / 100}%</option>)}</select></label>
        {!valid && <p className="trade-modal-notice" data-tone="error" id="modal-trade-amount-error">Enter an amount above zero and at most 100,000 {inputSymbol}, using up to {Math.min(6, side === "buy" ? 6 : asset.decimals)} decimals.</p>}
        <p className="trade-modal-notice" data-tone="neutral">Get an estimate first. You review every approval and swap before confirming in your wallet.</p>
      </> : <>
        {currentQuote && best && !transaction && <><div className="trade-modal-summary"><div className="trade-modal-token-row">{side === "buy" ? <TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={32}/> : <StockLogo symbol={asset.symbol} size={32}/>}<div><small>You pay</small><strong>{tokenNumber(currentQuote.amountIn)} {inputSymbol}</strong></div></div><div className="trade-modal-arrow"><ArrowDown size={17}/></div><div className="trade-modal-token-row">{side === "buy" ? <StockLogo symbol={asset.symbol} size={32}/> : <TokenLogo asset={{ address: USDG, symbol: "USDG" }} size={32}/>}<div><small>Estimated receive{!quoteRemaining ? " · expired" : ""}</small><strong>{tokenNumber(best.amountOut)} {outputSymbol}</strong></div></div></div>
          <dl className="trade-modal-details"><div className="trade-modal-minimum"><dt>Minimum received</dt><dd>{best.minimumOut} {outputSymbol}</dd></div><div><dt>Slippage</dt><dd>{slippage / 100}%</dd></div><div><dt>Route</dt><dd><ProtocolLogo protocol="uniswap" size={18}/> Uniswap V3 · {best.fee / 10000}% fee</dd></div><div><dt>Quote validity</dt><dd>{quoteRemaining ? `${quoteRemaining}s remaining` : "Expired · refresh required"}</dd></div></dl>
        </>}
        {!best && !transaction && <p className="trade-modal-notice" data-tone="error">No supported pool returned a quote for this amount. Edit the amount or retry.</p>}
        {!!currentQuote?.failed && <p className="trade-modal-notice" data-tone="error">Some pool quotes failed. A complete fresh comparison is required before trading.</p>}
        {activeStep === "review" && <>
          <p className="trade-modal-notice" data-tone="neutral">Pool fees and price impact are included. Network fees are separate. Preparing a trade checks your balance and allowance and simulates the next transaction.</p>
          {wallet.demoWallet ? <p className="trade-modal-notice" data-tone="neutral">Demo mode supports quotes only. Simulated holdings cannot be approved or traded.</p> : !wallet.account ? <p className="trade-modal-notice" data-tone="neutral">Connect your wallet to prepare this trade. Connecting does not approve spending or submit a swap.</p> : wallet.chainId !== CHAIN_ID ? <p className="trade-modal-notice" data-tone="neutral">Switch your wallet to Robinhood Chain to prepare this trade.</p> : <p className="trade-modal-status">Wallet {shortAddress(wallet.account)}</p>}

        </>}
        {activeStep === "confirm" && plan && <>
          <dl className="trade-modal-details"><div><dt>Account</dt><dd>{shortAddress(plan.account)}</dd></div><div><dt>Available balance</dt><dd>{n(plan.inputBalance, 6)} {inputSymbol}</dd></div><div><dt>Network fee estimate</dt><dd>{plan.gasEstimateETH ? `${n(plan.gasEstimateETH, 8)} ETH` : "Unavailable"}</dd></div></dl>
          {plan.status === "insufficient_balance" || plan.status === "insufficient_gas" ? <p className="trade-modal-notice" data-tone="error">{plan.status === "insufficient_balance" ? `Your wallet does not have enough ${inputSymbol}. Edit the amount or add funds, then prepare again.` : "Your wallet needs more ETH for network fees. Add ETH on Robinhood Chain, then prepare again."}</p> : plan.transaction && <>
            <p className="trade-modal-notice" data-tone="neutral">{plan.status === "approval_required" ? `Approve exactly ${plan.quote.amountIn} ${inputSymbol} for the Uniswap SwapRouter02 contract. Approval gives spending permission; the swap follows as a separate transaction.` : "The swap simulation passed. Your wallet provides the final network fee. A reverted transaction may still consume gas."}</p>
            <dl className="trade-modal-details"><div><dt>{plan.status === "approval_required" ? "Spender" : "Recipient"}</dt><dd><a href={`${EXPLORER}/address/${plan.status === "approval_required" ? SWAP_ROUTER : plan.account}`} target="_blank" rel="noreferrer">{shortAddress(plan.status === "approval_required" ? SWAP_ROUTER : plan.account)}<ArrowUpRight size={12}/></a></dd></div></dl>
            <label className="trade-modal-consent"><input type="checkbox" checked={reviewed} disabled={locked || !planExecutable} onChange={(event) => setReviewed(event.target.checked)}/>{plan.status === "approval_required" ? "I reviewed the token, exact amount and spender." : "I reviewed the amount, minimum received and recipient."}</label>
          </>}
        </>}
      </>}
      {step === "confirm" && plan?.transaction && !planExecutable && !transaction && <p className="trade-modal-notice" data-tone="neutral">This preview needs a fresh quote and wallet check before signing.</p>}
      {!asset.active && <p className="trade-modal-notice" data-tone="error">This token is inactive in the official registry. Trading is unavailable.</p>}
      {walletRequestPending && <p className="trade-modal-notice" data-tone="neutral" role="status">Confirm or decline the request in your wallet. Waiting for the wallet response…</p>}
      {error && <p className="trade-modal-notice" data-tone="error" role="alert">{error}</p>}
      {wallet.error && wallet.error !== error && <p className="trade-modal-notice" data-tone="error" role="alert">{wallet.error}</p>}
      {message && <p className="trade-modal-notice" data-tone={transaction?.status === "confirmed" ? "success" : transaction?.status === "reverted" ? "error" : "neutral"} role="status">{message}</p>}
      {transaction && <div className="trade-modal-status" data-state={transaction.status}>{transaction.status === "confirmed" ? <Check aria-hidden="true"/> : transaction.status === "submitted" ? <LoaderCircle className="spin" aria-hidden="true"/> : <X aria-hidden="true"/>}<h3>{transaction.kind === "approval" ? "Approval" : "Swap"} {transaction.status}</h3><p>{transaction.amount} {transaction.side === "buy" ? "USDG" : transaction.symbol}{transaction.kind === "swap" ? ` · ${transaction.side === "buy" ? "Buy" : "Sell"} ${transaction.symbol}` : " approval amount"}</p><a href={`${EXPLORER}/tx/${transaction.hash}`} target="_blank" rel="noreferrer">View transaction<ArrowUpRight size={13}/></a>{activeStep !== "confirm" && (transaction.status === "submitted" || transaction.status === "unresolved") && <button className="button button-secondary" disabled={locked} onClick={() => void checkReceipt(transaction)}>{busy === "receipt" ? "Checking…" : "Check confirmation"}</button>}</div>}
      {!!pending && !transaction && <p className="trade-modal-notice" data-tone="neutral">Check the pending {asset.symbol} transaction before preparing another trade.</p>}
      {records.length > 0 && <details className="trade-modal-history ticket-transactions"><summary>Recent {asset.symbol} transactions</summary>{recent.map((record) => <div key={record.hash}><a href={`${EXPLORER}/tx/${record.hash}`} target="_blank" rel="noreferrer">{record.kind === "approval" ? "Approval" : "Swap"} · {record.status}<ArrowUpRight size={12}/></a>{(record.status === "submitted" || record.status === "unresolved") && <button disabled={locked} onClick={() => void checkReceipt(record)}>Check confirmation</button>}{record.status === "submitted" && <button disabled={locked} onClick={() => { setRecoveryHash(recoveryHash === record.hash ? "" : record.hash); setRecoveryReviewed(false); }}>Replaced or dropped?</button>}{record.status === "submitted" && recoveryHash === record.hash && <div className="trade-review transaction-recovery"><p className="trade-modal-notice" data-tone="neutral">Check this hash and any replacement in your wallet or explorer. Clearing the local hold does not cancel the transaction. It may still execute, and another trade could spend funds again.</p><label className="trade-modal-consent"><input type="checkbox" checked={recoveryReviewed} disabled={locked} onChange={(event) => setRecoveryReviewed(event.target.checked)}/>I checked my wallet and understand the original transaction may still execute.</label><button disabled={locked || !recoveryReviewed} onClick={() => { recordTransaction({ ...record, status: "unresolved" }); setRecoveryHash(""); setRecoveryReviewed(false); setPlan(undefined); setReviewed(false); setLatest({ ...record, status: "unresolved" }); setMessage("Local hold cleared. The unresolved transaction remains in your history; its onchain status has not changed."); }}>Keep record & clear local hold</button></div>}</div>)}</details>}
      {log.storageError && <p className="trade-modal-notice" data-tone="neutral">Browser storage is unavailable. Save the transaction link to keep your record.</p>}
    </div>
    <footer className="trade-modal-footer">
      {activeStep !== "amount" && !pending && !(transaction?.kind === "swap" && transaction.status === "confirmed") && <div className="trade-modal-footer-tools"><button className="trade-modal-back" disabled={locked} onClick={() => edit()}><ArrowLeft size={15}/>Edit amount</button>{activeStep === "review" && !wallet.demoWallet && (!wallet.account || wallet.chainId !== CHAIN_ID) && <button className="trade-modal-back" disabled={locked || cooldown > 0 || !valid || !asset.active} onClick={() => void request(false)}>{busy === "quote" ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {cooldown ? `Retry in ${cooldown}s` : "Refresh quote"}</button>}</div>}
      {walletRequestPending ? <button className="button button-primary" disabled><LoaderCircle size={16} className="spin"/>Confirm in your wallet…</button> : activeStep === "amount" ? quoteButton : activeStep === "review" ? wallet.demoWallet ? quoteButton
        : !wallet.account ? <WalletButton wallet={wallet}/>
        : wallet.chainId !== CHAIN_ID ? <button className="button button-primary" disabled={wallet.pending || locked} onClick={() => void wallet.switchNetwork()}>Switch to Robinhood Chain</button>
        : !best || !quoteRemaining || !!currentQuote?.failed ? quoteButton : prepareButton
        : transaction?.kind === "swap" && transaction.status === "confirmed" ? <Dialog.Close className="button button-primary">Done</Dialog.Close>
        : pending ? <button className="button button-primary" disabled={locked} onClick={() => void checkReceipt(pending)}>{busy === "receipt" ? "Checking…" : "Check confirmation"}</button>
        : plan?.transaction && planExecutable ? <button className="button button-primary" disabled={locked || !reviewed || !!wallet.demoWallet} onClick={() => void submit()}>{walletRequestPending ? <><LoaderCircle className="spin" size={16}/>Confirm in wallet…</> : plan.status === "approval_required" ? `Approve ${inputSymbol} in wallet` : "Confirm swap in wallet"}</button>
        : !wallet.demoWallet && wallet.account && wallet.chainId === CHAIN_ID ? prepareButton : quoteButton}

    </footer>
  </>;
}
