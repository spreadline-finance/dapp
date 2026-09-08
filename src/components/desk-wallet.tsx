"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import { WalletButton, type WalletState } from "./wallet";
import type { DeskSnapshot } from "@/lib/desk-types";
import { CHAIN_ID, EXPLORER } from "@/lib/market-types";
import { getData, shortAddress } from "@/lib/live-api";
import { prepareDeskAction, sendDeskPlan, type DeskAction, type DeskPlan } from "@/lib/desk-transactions";
import { readReceipt } from "@/lib/transactions";
import "./desk-wallet.css";

type Record = { hash: Hex; account: string; to: string; kind: DeskPlan["kind"]; status: "submitted" | "confirmed" | "reverted"; submittedAt: string };
const KEY = "spreadline.desk.transactions.v1";
const empty: Record[] = [];
let records = empty, hydrated = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish() { listeners.forEach((listener) => listener()); }
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(raw)) records = raw.slice(0, 20).filter((r): r is Record =>
      r && /^0x[\da-f]{64}$/i.test(r.hash) && /^0x[\da-f]{40}$/i.test(r.account) && /^0x[\da-f]{40}$/i.test(r.to) &&
      ["deposit", "withdraw", "claim", "approval", "reset-approval"].includes(r.kind) && ["submitted", "confirmed", "reverted"].includes(r.status) && typeof r.submittedAt === "string");
  } catch { /* Wallet receipts remain available in the chain explorer. */ }
  publish();
}
function save(record: Record) {
  hydrate();
  records = [record, ...records.filter((r) => r.hash !== record.hash)].slice(0, 20);
  try { localStorage.setItem(KEY, JSON.stringify(records)); } catch { /* Keep receipts in memory. */ }
  publish();
}
const amount = (value: string) => Number(formatUnits(BigInt(value), 6)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const labels = { deposit: "Deposit", withdraw: "Withdraw", claim: "Claim rewards", approval: "Approve USDG", "reset-approval": "Reset USDG approval" };

export function DeskWallet({ snapshot, wallet, onRefresh }: { snapshot: DeskSnapshot | undefined; wallet: WalletState; onRefresh: () => void }) {
  const [action, setAction] = useState<DeskAction>("deposit");
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<DeskPlan | null>(null);
  const log = useSyncExternalStore(subscribe, () => records, () => empty);
  useEffect(hydrate, []);
  const account = wallet.account;
  const provider = wallet.selected?.provider;
  const position = account && snapshot?.wallet?.address.toLowerCase() === account.toLowerCase() ? snapshot.wallet : null;
  const personal = log.filter((r) => r.account.toLowerCase() === account?.toLowerCase());
  const pending = personal.find((r) => r.status === "submitted");
  const receipt = useQuery({
    queryKey: ["desk-receipt", pending?.hash, account, wallet.chainId],
    queryFn: () => readReceipt(provider!, pending!),
    enabled: !!pending && !!provider && wallet.chainId === CHAIN_ID,
    refetchInterval: 5000, retry: false,
  });
  useEffect(() => {
    if (receipt.data && receipt.data.hash === pending?.hash) { save(receipt.data); onRefresh(); }
  }, [receipt.data, pending?.hash, onRefresh]);
  const prepare = useMutation({
    mutationFn: async () => {
      if (!provider || !account) throw new Error("Connect your wallet first.");
      setPlan(null);
      const fresh = await getData<DeskSnapshot>(`/api/desk?address=${account}`);
      return prepareDeskAction(provider, fresh, account, action, input);
    },
    onSuccess: setPlan,
  });
  const send = useMutation({
    mutationFn: async () => {
      if (!provider || !account || !plan || !snapshot?.vault) throw new Error("Prepare this action first.");
      const hash = await sendDeskPlan(provider, plan, account, snapshot.vault.address);
      save({ hash, account, to: plan.transaction.to, kind: plan.kind, status: "submitted", submittedAt: new Date().toISOString() });
    },
    onSuccess: () => { setPlan(null); onRefresh(); },
  });
  const busy = prepare.isPending || send.isPending;
  function change(next: DeskAction) {
    setAction(next); setInput(next === "withdraw" ? "100" : ""); setPlan(null); prepare.reset(); send.reset();
  }
  const currentPlan = plan && plan.account.toLowerCase() === account?.toLowerCase() && plan.vault.toLowerCase() === snapshot?.vault?.address.toLowerCase() && wallet.chainId === CHAIN_ID ? plan : null;
  const unavailable = snapshot?.status !== "ready" || !snapshot.vault;
  return <div className="desk-wallet">
    <div className="dw-heading"><div><span className="eyebrow">YOUR PARTICIPATION</span><h3>Capital in. Rewards out.</h3></div><span className="dw-asset">USDG</span></div>
    {unavailable ? <div className="dw-empty"><p>{!snapshot ? "Checking vault availability…" : snapshot.status === "unconfigured" ? "The vault has not opened for deposits." : "Vault actions are temporarily unavailable."}</p><span>{snapshot?.status === "unavailable" ? "A current contract snapshot could not be verified. Refresh the desk before preparing an action." : "Live markets are available in the desk. Deposits and claims become available after a verified vault is connected."}</span></div>
      : wallet.demoWallet ? <div className="dw-empty"><p>Demo wallets cannot join the vault.</p><span>Switch to a real wallet to view an onchain position.</span><WalletButton wallet={wallet}/></div>
      : !account ? <div className="dw-empty"><p>Connect to view your capital and rewards.</p><span>Rewards accrue only after profitable trades. There is no fixed rate or guaranteed payout.</span><WalletButton wallet={wallet}/></div>
      : wallet.chainId !== CHAIN_ID ? <div className="dw-empty"><p>Switch to Robinhood Chain.</p><button className="button button-primary" onClick={() => void wallet.switchNetwork()} disabled={wallet.pending}>Switch network</button></div>
      : <>
        <div className="dw-balances"><div><span>Redeemable capital</span><strong>{position ? amount(position.redeemableAssets) : "—"}<small> USDG</small></strong></div><div><span>Claimable rewards</span><strong>{position ? amount(position.claimableAssets) : "—"}<small> USDG</small></strong></div></div>
        <div className="dw-actions" role="group" aria-label="Vault action">{(["deposit", "withdraw", "claim"] as const).map((kind) => <button key={kind} aria-pressed={action === kind} disabled={busy} onClick={() => change(kind)}>{kind === "claim" ? "Claim" : labels[kind]}</button>)}</div>
        {action !== "claim" && <label className="dw-input"><span>{action === "deposit" ? "Deposit amount · USDG" : "Share of your position · %"}</span><div><input aria-label={action === "deposit" ? "Deposit amount in USDG" : "Percentage to withdraw"} inputMode="decimal" placeholder={action === "deposit" ? "0.00" : "100"} value={input} disabled={busy} onChange={(e) => { setInput(e.target.value); setPlan(null); prepare.reset(); send.reset(); }}/>{action === "withdraw" && <button onClick={() => { setInput("100"); setPlan(null); }} disabled={busy}>All</button>}</div></label>}
        <p className="dw-note">{action === "deposit" ? `Wallet balance: ${position ? amount(position.assetBalance) : "—"} USDG. Deposits buy vault shares; returns depend on completed profitable trades.` : action === "withdraw" ? "Redeem your shares for USDG. Accrued rewards remain claimable after withdrawal." : "Claim accrued USDG to your connected wallet. Claimed rewards are separate from your redeemable capital."}</p>
        {currentPlan ? <div className="dw-preview" aria-live="polite"><span>SIMULATED PREVIEW</span><strong>{labels[currentPlan.kind]}{currentPlan.kind !== "reset-approval" ? ` · ${amount(currentPlan.assets)} USDG` : ""}</strong>
          <p>{currentPlan.kind === "approval" || currentPlan.kind === "reset-approval" ? "This is a token permission only. After confirmation, prepare your deposit separately." : `Receiver: ${shortAddress(currentPlan.account)}. ${currentPlan.kind === "deposit" || currentPlan.kind === "withdraw" ? "The contract enforces a minimum output within 0.1% of this preview." : "The amount is checked again before signing."}`}</p>
          <span>Network gas is paid separately in ETH. Preview expires after 30 seconds.</span>
          <button className="button button-primary" onClick={() => send.mutate()} disabled={busy || !!pending}>{send.isPending ? <LoaderCircle className="dw-spin" size={16}/> : null} Confirm {labels[currentPlan.kind].toLowerCase()} in wallet</button>
          <button className="dw-text-button" onClick={() => setPlan(null)} disabled={busy}>Discard preview</button>
        </div> : <button className="button button-primary dw-prepare" onClick={() => prepare.mutate()} disabled={busy || !position || !!pending || action === "claim" && BigInt(position.claimableAssets) === BigInt(0)}>{prepare.isPending ? <LoaderCircle className="dw-spin" size={16}/> : null} Preview {labels[action].toLowerCase()}</button>}
        {(prepare.error || send.error) && <p className="dw-error" role="alert">{(prepare.error || send.error)?.message}</p>}
      </>}
    {!!personal.length && <div className="dw-receipts"><span className="eyebrow">YOUR RECENT TRANSACTIONS</span>{personal.slice(0, 3).map((record) => <a key={record.hash} href={`${EXPLORER}/tx/${record.hash}`} target="_blank" rel="noreferrer"><span>{labels[record.kind]}<small>{record.status === "submitted" ? "Submitted · awaiting receipt" : record.status === "confirmed" ? "Confirmed onchain" : "Reverted · no action completed"}</small></span><ArrowUpRight size={16}/></a>)}{pending && <button className="dw-text-button" onClick={() => void receipt.refetch()} disabled={receipt.isFetching || wallet.chainId !== CHAIN_ID}>Check pending receipt</button>}{receipt.error && <p className="dw-note">{receipt.error.message} Check the explorer before submitting another transaction.</p>}</div>}
  </div>;
}
