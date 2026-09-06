"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, Check, LoaderCircle, RefreshCw, ShieldCheck, CheckCircle2, Clock3, ChevronRight } from "lucide-react";
import { CHAIN_ID, EXPLORER } from "@/lib/market-types";
import { ageLabel, DataError, getData, shortAddress } from "@/lib/live-api";
import { LENDING_ADAPTER, lendingPlanMatches, parseLendingAmount, sameContract, type LendingKind, type LendingPlan, type LendingPosition } from "@/lib/lending-execution";
import { lendingPending, recordLendingTransaction, sendPreparedLending, useLendingTransactions, type LendingTransaction } from "@/lib/lending-transactions";
import { readReceipt } from "@/lib/transactions";
import { WalletButton, type WalletState } from "./wallet";
import { TokenLogo } from "./token-logo";
import type { LendingAsset } from "@/lib/lending";

export type LendingTarget = { kind: LendingKind; id: string; label: string; asset?: { address: string; symbol: string; decimals: number }; collateral?: LendingAsset | null; depositRestricted?: boolean; initialOperation?: "deposit" | "withdraw"; apy?: number | null };
const token = (raw: string | undefined, decimals: number) => raw === undefined ? "—" : formatUnits(BigInt(raw), decimals);
const compactToken = (raw: string | undefined, decimals: number) => {
  if (raw === undefined) return "—";
  const exact = token(raw, decimals), value = Number(exact);
  return value > 0 && value < .000001 ? exact : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
};
export function useLendingConfirmations(wallet: WalletState) {
  const { records } = useLendingTransactions();
  useEffect(() => {
    if (!wallet.selected || wallet.chainId !== CHAIN_ID || !wallet.account) return;
    const provider = wallet.selected.provider;
    const pending = records.filter((r) => r.hash && r.status === "submitted" && sameContract(r.account, wallet.account!) && Date.now() - Date.parse(r.submittedAt) < 10 * 60000).slice(0, 3);
    if (!pending.length) return;
    let stopped = false;
    const check = async () => {
      for (const r of pending) {
        if (stopped) return;
        try { const receipt = await readReceipt(provider, { ...r, hash: r.hash! }); if (receipt) recordLendingTransaction(receipt); } catch { /* Keep the pending record; manual retry is available. */ }
      }
    };
    const timer = window.setInterval(() => void check(), 6000);
    void check();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [records, wallet.account, wallet.chainId, wallet.selected]);
}

export function LendingActivity({ wallet, onOpen }: { wallet: WalletState; onOpen: (target: LendingTarget) => void }) {
  const log = useLendingTransactions();
  const records = log.records.filter((r) => wallet.account && sameContract(r.account, wallet.account));
  const [busy, setBusy] = useState(""), [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState(""), [reviewed, setReviewed] = useState(false);
  const recent = [...records.filter(lendingPending), ...records.filter((r) => !lendingPending(r))].slice(0, 8);
  async function check(record: LendingTransaction) {
    if (!wallet.selected || !record.hash) return;
    setBusy(record.id); setMessage("");
    try {
      const receipt = await readReceipt(wallet.selected.provider, { ...record, hash: record.hash });
      if (receipt) { recordLendingTransaction(receipt); setMessage(receipt.status === "confirmed" ? "Confirmed onchain. Open the position for refreshed balances and the next step." : "The transaction reverted. No lending action completed; network gas may have been charged."); }
      else setMessage("No receipt yet. Check your wallet for pending or replacement transactions.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Receipt unavailable."); }
    finally { setBusy(""); }
  }
  if (!records.length) return null;
  return <section className="lend-activity" aria-label="Your lending activity"><div className="lend-section-heading"><div><h3>Your lending activity</h3></div><span>Saved in this browser</span></div>
    {recent.map((r) => <div className="lend-activity-row" key={r.id}><div><strong>{r.kind === "authorization" ? "Adapter authorization" : r.kind[0].toUpperCase() + r.kind.slice(1)} <span>· {r.status.replaceAll("_", " ")}</span></strong><small>{r.label} · {r.kind === "authorization" ? "All Morpho positions" : `${r.amount} ${r.symbol}`}</small></div><div className="lend-row-actions"><button onClick={() => onOpen({ kind: r.targetKind, id: r.target, label: r.label })}>Manage</button>{r.hash && <a href={`${EXPLORER}/tx/${r.hash}`} target="_blank" rel="noreferrer" aria-label={`View ${r.kind} transaction`}>Explorer<ArrowUpRight size={12}/></a>}{r.hash && (lendingPending(r) || r.status === "unresolved") && <button disabled={!!busy || !wallet.selected || wallet.chainId !== CHAIN_ID} onClick={() => void check(r)}>Check status</button>}{lendingPending(r) && <button disabled={!!busy} onClick={() => { setRecovery(recovery === r.id ? "" : r.id); setReviewed(false); }}>Resolve hold</button>}</div>{recovery === r.id && <div className="lend-recovery"><p>Check your wallet and any replacement transaction first. Clearing this local hold does not cancel a transaction; the original could still execute and another action could spend again.</p><label><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)}/>I checked my wallet and understand that risk.</label><button disabled={!reviewed} onClick={() => { recordLendingTransaction({ ...r, status: "unresolved" }); setRecovery(""); setReviewed(false); }}>Keep unresolved record & clear hold</button></div>}</div>)}
    {message && <p className="lend-message" role="status">{message}</p>}{log.storageError && <p className="lend-message">Browser storage is unavailable. Save your transaction links.</p>}
  </section>;
}

export function LendingExecution({ target, wallet, now }: { target: LendingTarget; wallet: WalletState; now: number }) {
  const fieldId = useId();
  const [operation, setOperation] = useState<"deposit" | "withdraw">(target.initialOperation ?? (target.depositRestricted ? "withdraw" : "deposit"));
  const [amount, setAmount] = useState(""); const [all, setAll] = useState(false); const [slippageBps, setSlippage] = useState(50);
  const [lastSubmittedId, setLastSubmittedId] = useState("");
  const [plan, setPlan] = useState<LendingPlan>(); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [review, setReview] = useState(false); const [retryAt, setRetryAt] = useState(0);
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => { const counter = generation; return () => { counter.current++; controller.current?.abort(); }; }, []);
  const log = useLendingTransactions();
  const own = log.records.filter((r) => wallet.account && sameContract(r.account, wallet.account));
  const pending = own.some(lendingPending);
  const recent = own.filter((r) => sameContract(r.target, target.id)).slice(0, 3);
  const minimumBlock = own.filter((r) => r.blockNumber && (r.status === "confirmed" || r.status === "reverted")).reduce((v, r) => BigInt(r.blockNumber!) > v ? BigInt(r.blockNumber!) : v, BigInt(0)).toString();
  const connected = !wallet.demoWallet && !!wallet.account && !!wallet.selected && wallet.chainId === CHAIN_ID;
  const position = useQuery({ queryKey: ["lending-position", wallet.account, target.kind, target.id, minimumBlock], queryFn: ({ signal }) => getData<LendingPosition>(`lending/position?${new URLSearchParams({ kind: target.kind, id: target.id, address: wallet.account!, minBlock: minimumBlock })}`, signal), enabled: connected, staleTime: 20000, retry: false, refetchOnWindowFocus: false });
  const p = plan?.position ?? position.data;
  const asset = target.asset ?? p?.asset;
  const symbol = asset?.symbol ?? "tokens", decimals = asset?.decimals ?? 6;
  const intent = { kind: target.kind, id: target.id, operation, amount: all ? "0" : amount, all, slippageBps };
  const expected = { ...intent, account: wallet.account ?? "", asset: asset?.address ?? "", assetDecimals: decimals };
  const valid = all ? operation === "withdraw" && !!p && BigInt(p.sharesRaw) > BigInt(0) : (() => { try { parseLendingAmount(amount, decimals); return true; } catch { return false; } })();
  const remaining = plan ? Math.max(0, Math.ceil((Date.parse(plan.expiresAt) - now) / 1000)) : 0;
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const ready = plan && lendingPlanMatches(plan, expected, now);
  const depositBlocked = operation === "deposit" && target.depositRestricted;
  const activePending = own.find((r) => sameContract(r.target, target.id) && lendingPending(r));
  const autoChecking = connected && activePending?.status === "submitted" && !!activePending.hash && now - Date.parse(activePending.submittedAt) < 10 * 60000;
  const permissionStep = plan?.status === "approval_required" || plan?.status === "approval_reset_required" || plan?.status === "authorization_required";
  const completed = recent.some((r) => r.id === lastSubmittedId && r.status === "confirmed" && r.kind === operation);
  const step = completed ? 3 : activePending ? activePending.kind === "deposit" || activePending.kind === "withdraw" ? 3 : 1 : plan?.status === "ready" ? 2 : permissionStep ? 1 : 0;
  const amountIssue = (() => {
    if (!amount || all) return "";
    try {
      const value = parseLendingAmount(amount, decimals);
      if (connected && p && operation === "deposit" && value > BigInt(p.walletBalanceRaw)) return `Above your last checked ${symbol} balance. Refresh your balance or lower the amount.`;
      if (connected && p && operation === "withdraw" && value > BigInt(p.assetsRaw)) return "Above your last checked supplied balance. Refresh or lower the amount.";
    } catch { return `Enter a positive amount with up to ${Math.min(decimals, 18)} decimal places.`; }
    return "";
  })();
  async function checkTransaction(record: LendingTransaction) {
    if (!wallet.selected || !record.hash || busy) return;
    const run = generation.current;
    setBusy("Checking confirmation…"); setError("");
    try { const receipt = await readReceipt(wallet.selected.provider, { ...record, hash: record.hash }); if (receipt) recordLendingTransaction(receipt); }
    catch (e) { if (run === generation.current) setError(e instanceof Error ? e.message : "Could not check confirmation."); }
    finally { if (run === generation.current) setBusy(""); }
  }
  function invalidate() { setLastSubmittedId(""); generation.current++; controller.current?.abort(); setPlan(undefined); setReview(false); setError(""); }
  async function prepare() {
    if (!connected || !valid || busy || pending || cooldown || depositBlocked) return;
    const run = ++generation.current; controller.current?.abort(); controller.current = new AbortController();
    setBusy("Checking your balance & simulating…"); setError(""); setPlan(undefined); setReview(false);
    try {
      const params = new URLSearchParams({ ...intent, all: String(all), slippageBps: String(slippageBps), address: wallet.account!, minBlock: minimumBlock });
      const result = await getData<LendingPlan>(`lending/plan?${params}`, controller.current.signal);
      if (run !== generation.current) return;
      const checkedAsset = asset ?? result.position.asset;
      if (!lendingPlanMatches(result, { ...expected, asset: checkedAsset.address, assetDecimals: checkedAsset.decimals })) throw new Error("The prepared transaction did not match your request. Refresh your position and try again.");
      setPlan(result);
    } catch (e) { if (run === generation.current) { setError(e instanceof Error ? e.message : "Unable to prepare lending."); if (e instanceof DataError) setRetryAt(e.retryAt); } }
    finally { if (run === generation.current) setBusy(""); }
  }
  async function submit() {
    if (!plan || !wallet.account || !wallet.selected || !review || !ready || busy || pending || depositBlocked) return;
    const submitted = plan, provider = wallet.selected.provider, run = generation.current;
    const isApproval = submitted.status === "approval_required" || submitted.status === "approval_reset_required";
    const record: LendingTransaction = { id: crypto.randomUUID(), account: wallet.account, to: submitted.transaction!.to, target: target.id, targetKind: target.kind, label: target.label, symbol: isApproval && operation === "withdraw" ? "vault shares" : symbol, amount: isApproval ? token(submitted.approvalAmountRaw, operation === "withdraw" ? submitted.position.shareDecimals : decimals) : token(submitted.bounds.assetsRaw, decimals), kind: submitted.status === "authorization_required" ? "authorization" : isApproval ? "approval" : operation, status: "awaiting_wallet", submittedAt: new Date().toISOString() };
    let requested = false;
    setBusy("Confirm in your wallet…"); setError("");
    try {
      const hash = await sendPreparedLending(provider, submitted, expected, () => { requested = true; recordLendingTransaction(record); if (run === generation.current) setLastSubmittedId(record.id); });
      recordLendingTransaction({ ...record, hash, status: "submitted" }); // Persist even after the dialog unmounts.
    } catch (e) {
      const rejected = !!e && typeof e === "object" && "code" in e && e.code === 4001;
      if (requested && rejected) recordLendingTransaction({ ...record, status: "cancelled" });
      if (run === generation.current) setError(rejected ? "Wallet request declined. Nothing was submitted by this request." : e instanceof Error ? e.message : "Check your wallet before retrying this request.");
    } finally { if (run === generation.current) { setBusy(""); setPlan(undefined); setReview(false); } }
  }
  if (wallet.demoWallet) return <section className="demo-execution-notice" aria-label="Demo lending unavailable"><strong>Demo mode · market research only</strong><p>You can explore live lending rates. Preset Stock Token holdings do not include lending positions, and deposits, withdrawals and approvals are disabled.</p></section>;
  return <section className="lend-execution" aria-label={`Manage ${target.label}`}>
    <div className="lend-section-heading"><div className="lend-ticket-identity"><TokenLogo asset={asset} size={36}/><div><h3>Manage {symbol}</h3></div></div><span className="lend-network"><i/>Robinhood Chain</span></div>
    {target.apy !== undefined && <div className="lend-rate-banner"><span>{target.kind === "vault" ? "Net base APY" : "Base supply APY"}</span><strong>{target.apy === null ? "—" : `${(target.apy * 100).toFixed(2)}%`}</strong><small>Variable · indexed rate · rewards excluded</small></div>}
    <div className="lend-balances"><div><span>In your wallet</span><strong title={token(p?.walletBalanceRaw, decimals)}>{compactToken(p?.walletBalanceRaw, decimals)} <small>{symbol}</small></strong></div><div><span>You supplied</span><strong title={token(p?.assetsRaw, decimals)}>{compactToken(p?.assetsRaw, decimals)} <small>{symbol}</small></strong></div><div><span>Available to withdraw</span><strong>{p ? p.liquidityRaw === null ? "Check amount" : compactToken(String(BigInt(p.assetsRaw) < BigInt(p.liquidityRaw) ? BigInt(p.assetsRaw) : BigInt(p.liquidityRaw)), decimals) : "—"}<small>{p?.liquidityRaw === null ? "Preview to check liquidity" : symbol}</small></strong></div></div>
    {connected && <div className="lend-balance-meta"><span>{p ? `Onchain ${ageLabel(p.fetchedAt, now)} · ${compactToken(p.nativeBalanceRaw, 18)} ETH for gas` : "Reading your actual wallet position…"}</span><button disabled={position.isFetching || !!busy} onClick={() => { invalidate(); void position.refetch(); }}><RefreshCw size={12}/>Refresh</button></div>}
    {position.error && <p className="lend-message" role="status">{position.error.message}{position.data ? " Displayed balances are the previous read." : ""}</p>}
    <ol className="lend-steps" aria-label="Transaction progress">{[{ label: "Amount", done: step > 0 }, { label: "Permission", done: step > 1 }, { label: operation === "deposit" ? "Deposit" : "Withdraw", done: completed }].map((item, index) => <li key={item.label} data-state={item.done ? "done" : Math.min(step, 2) === index ? "current" : "upcoming"} aria-current={!completed && Math.min(step, 2) === index ? "step" : undefined}><span>{item.done ? <Check size={12}/> : index + 1}</span>{item.label}{index < 2 && <ChevronRight size={12}/>}</li>)}</ol>
    <div className="lend-action-tabs">{(["deposit", "withdraw"] as const).map((op) => <button key={op} aria-pressed={operation === op} disabled={!!busy || pending} onClick={() => { invalidate(); setOperation(op); setAll(false); setAmount(""); }}>{op === "deposit" ? <ArrowDownToLine size={16}/> : <ArrowUpFromLine size={16}/>} {op === "deposit" ? "Deposit" : "Withdraw"}</button>)}</div>
    <div className="lend-amount"><label htmlFor={fieldId}>{operation === "deposit" ? "You deposit" : all ? "Withdraw current shares" : "You receive"}<span className="lend-token-chip"><TokenLogo asset={asset} size={24}/>{symbol}</span></label><div><input id={fieldId} disabled={!!busy || all || pending} placeholder="0.00" value={all ? token(p?.assetsRaw, decimals) : amount} inputMode="decimal" autoComplete="off" aria-invalid={!!amountIssue} aria-describedby={amountIssue ? `${fieldId}-error` : undefined} onChange={(e) => { invalidate(); setAmount(e.target.value); }}/><button disabled={!!busy || pending || !p || (operation === "deposit" ? BigInt(p.walletBalanceRaw) === BigInt(0) : BigInt(p.sharesRaw) === BigInt(0))} aria-pressed={all} onClick={() => { invalidate(); if (operation === "withdraw") { setAll(!all); setAmount(""); } else { setAmount(token(p?.walletBalanceRaw, decimals)); } }}>{operation === "deposit" ? "Max" : all ? "Edit" : "All"}</button></div></div>
    {amountIssue && <p className="lend-input-hint" id={`${fieldId}-error`} role="status">{amountIssue}</p>}
    <label className="lend-slippage">Share-price tolerance<select disabled={!!busy || pending} value={slippageBps} onChange={(e) => { invalidate(); setSlippage(Number(e.target.value)); }}>{[10, 50, 100].map((v) => <option key={v} value={v}>{v / 100}%</option>)}</select></label>
    {depositBlocked && <p className="lend-message">New deposits are restricted for this listing. An existing position can still be withdrawn after its exit simulation passes.</p>}
    <div className="lend-prepare-action">{!wallet.account ? <div className="lend-connect"><p>Connect to read your balance and deposit or withdraw here.</p><WalletButton wallet={wallet}/></div> : wallet.chainId !== CHAIN_ID ? <button className="lend-primary" disabled={wallet.pending} onClick={() => void wallet.switchNetwork()}>Switch to Robinhood Chain</button> : <button className={plan ? "lend-refresh-preview" : "lend-primary"} disabled={!!busy || !valid || !asset || pending || cooldown > 0 || depositBlocked} onClick={() => void prepare()}>{busy ? <><LoaderCircle className="spin" size={16}/>{busy}</> : cooldown ? `Retry in ${cooldown}s` : <><ShieldCheck size={16}/>{plan ? "Refresh preview" : `Preview ${operation}`}</>}</button>}</div>
    {error && <p className="lend-message" role="alert">{error}</p>}
    {plan && <div className="lend-review" data-step={plan.status}><div className="lend-review-title"><Check size={16}/><strong>{plan.status === "ready" ? `${operation === "deposit" ? "Deposit" : "Withdraw"} preview` : plan.status === "authorization_required" ? "Step 1 · Authorize adapter" : plan.status === "approval_reset_required" ? "Step 1 · Reset allowance" : "Step 1 · Approve amount"}</strong><span>{remaining ? `${remaining}s` : "Expired"}</span></div><dl><div><dt>Account / recipient</dt><dd>{shortAddress(plan.position.account)}</dd></div><div><dt>{operation === "deposit" ? "Deposit amount" : "Expected withdrawal"}</dt><dd>{token(plan.bounds.assetsRaw, decimals)} {symbol}</dd></div>{operation === "deposit" ? <div><dt>Minimum shares received</dt><dd>{target.kind === "market" ? `${plan.bounds.minimumSharesRaw} accounting units` : token(plan.bounds.minimumSharesRaw, plan.position.shareDecimals)}</dd></div> : all ? <div><dt>Minimum received</dt><dd>{token(plan.bounds.minimumAssetsRaw, decimals)} {symbol}</dd></div> : <div><dt>Maximum shares spent</dt><dd>{target.kind === "market" ? `${plan.bounds.maximumSharesRaw} accounting units` : token(plan.bounds.maximumSharesRaw, plan.position.shareDecimals)}</dd></div>}{plan.approvalAmountRaw !== undefined && <div><dt>Exact approval</dt><dd>{token(plan.approvalAmountRaw, operation === "withdraw" ? plan.position.shareDecimals : decimals)} {operation === "withdraw" ? "vault shares" : symbol}</dd></div>}<div><dt>Network fee estimate, buffered</dt><dd>{plan.gasEstimateETH} ETH</dd></div></dl>
      <p>{plan.status === "authorization_required" ? "This gives the Morpho adapter persistent management permission across all your Morpho positions, including withdrawals and borrowing. It is broader than a token allowance and does not withdraw funds now. This permission remains until you revoke it onchain." : plan.status === "approval_reset_required" ? "This token requires its existing allowance to be reset to zero first. This transaction removes that allowance. After it confirms, prepare again for a new exact-amount approval, then the lending action." : plan.status === "approval_required" ? "This approval lets the verified adapter spend only the amount shown. It does not deposit or withdraw. After confirmation, prepare again to simulate the lending action." : "The full lending action passed simulation. The onchain share-price limit protects the amount you receive or shares spent. Simulation does not guarantee execution."}</p>
      <p className="lend-review-timing">The preview expires before opening your wallet. The contract has no time deadline: a delayed confirmation can still execute. Your wallet sets the final network fee.</p>
      <a href={`${EXPLORER}/address/${LENDING_ADAPTER}`} target="_blank" rel="noreferrer">Verified Morpho adapter · {shortAddress(LENDING_ADAPTER)}<ArrowUpRight size={12}/></a>
      <label className="lend-consent"><input type="checkbox" checked={review} disabled={!!busy} onChange={(e) => setReview(e.target.checked)}/>{plan.status === "authorization_required" ? "I reviewed the scope of this persistent authorization." : "I reviewed the asset, amount, recipient and limits."}</label><button className="lend-primary" disabled={!review || !ready || !!busy || pending || depositBlocked} onClick={() => void submit()}>{!remaining ? "Preview expired · refresh above" : plan.status === "ready" ? `Confirm ${operation} in wallet` : plan.status === "authorization_required" ? "Authorize adapter in wallet" : plan.status === "approval_reset_required" ? "Reset allowance in wallet" : "Approve exact amount in wallet"}</button>
    </div>}
    {pending && <div className="lend-pending-panel" role="status"><Clock3 size={18}/><div><strong>{!activePending ? "Another lending request needs attention" : activePending.status === "awaiting_wallet" ? "Check your wallet" : "Waiting for onchain confirmation"}</strong><p>{!activePending ? "Close this panel and review Your lending activity before starting another transaction." : activePending.status === "awaiting_wallet" ? "A wallet request is open or its result is unknown. Check your wallet before retrying; no transaction hash has been received." : autoChecking ? "Checking for a receipt automatically. Your balance updates after confirmation." : "Use Check status below or in Your lending activity to look for a receipt."}</p>{activePending?.status === "submitted" && (activePending.kind === "approval" || activePending.kind === "authorization") && <p>After permission confirms, preview again to prepare the lending transaction.</p>}</div></div>}
    {recent.length > 0 && <div className="lend-recent">{recent.map((r) => <div className="lend-receipt-row" data-status={r.status} key={r.id}><div>{r.status === "confirmed" ? <CheckCircle2 size={16}/> : <Clock3 size={16}/>}<strong>{r.kind[0].toUpperCase() + r.kind.slice(1)}<small>{r.status.replaceAll("_", " ")}</small></strong></div><span>{r.hash && <a href={`${EXPLORER}/tx/${r.hash}`} target="_blank" rel="noreferrer" aria-label={`View ${r.kind} transaction`}>Explorer<ArrowUpRight size={12}/></a>}{r.hash && (lendingPending(r) || r.status === "unresolved") && <button disabled={!!busy} onClick={() => void checkTransaction(r)}>Check status</button>}</span>{r.status === "confirmed" && (r.kind === "approval" || r.kind === "authorization") && <p>Permission confirmed. Preview again to prepare the {operation}.</p>}</div>)}</div>}
    <p className="lend-footnote">Funds go directly between your wallet and Morpho. Rates vary and principal is at risk. Each transaction requires your wallet confirmation.</p>
  </section>;
}
