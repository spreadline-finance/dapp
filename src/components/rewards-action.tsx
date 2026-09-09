"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { formatUnits, type Hex } from "viem";
import { CHAIN_ID, EXPLORER } from "@/lib/market-types";
import { getData, shortAddress } from "@/lib/live-api";
import { readReceipt } from "@/lib/transactions";
import { prepareRewardAction, sendRewardPlan, type RewardsPlan } from "@/lib/rewards-transactions";
import type { RewardsRequest, RewardsSnapshot } from "@/lib/rewards-types";
import type { WalletState } from "./wallet";

type RewardRecord = { hash: Hex; account: string; to: string; kind: RewardsRequest["kind"]; label: string; status: "submitted" | "confirmed" | "reverted"; submittedAt: string };
const storageKey = "spreadline.token-rewards.transactions.v1";
const emptyRecords: RewardRecord[] = [];
let records = emptyRecords, hydrated = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish() { listeners.forEach((listener) => listener()); }
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try { const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]"); if (Array.isArray(raw)) records = raw.slice(0, 40).filter((record): record is RewardRecord => record && /^0x[\da-f]{64}$/i.test(record.hash) && /^0x[\da-f]{40}$/i.test(record.account) && /^0x[\da-f]{40}$/i.test(record.to) && typeof record.label === "string" && record.label.length < 100 && ["submitted", "confirmed", "reverted"].includes(record.status) && ["collect", "sweep-curve", "sweep-pool", "claim", "claim-to", "withdraw-cash", "policy", "operator", "guardian", "pause", "cancel", "activate", "bind-token", "propose-owner", "accept-owner"].includes(record.kind) && typeof record.submittedAt === "string"); } catch { /* The explorer remains the durable receipt source. */ }
  publish();
}
function save(record: RewardRecord) {
  hydrate(); records = [record, ...records.filter((item) => item.hash !== record.hash)].slice(0, 40);
  try { localStorage.setItem(storageKey, JSON.stringify(records)); } catch { /* Keep the receipt in memory if storage is full. */ }
  publish();
}
function summary(request: RewardsRequest) {
  switch (request.kind) {
    case "policy": return `Future distributions: ${request.policy.holderBps / 100}% holders, ${request.policy.devBps / 100}% developer and ${request.policy.treasuryBps / 100}% treasury. Already proposed and activated distributions keep their recorded policy.`;
    case "claim": return `Claim distribution #${request.claim.epochId} to ${shortAddress(request.claim.account)}. This transaction cannot change its recipient.`;
    case "claim-to": return `Claim your own distribution #${request.claim.epochId} to the receiving wallet below. Only the proven holder can redirect their own allocation.`;
    case "collect": return "Collect this distributor's accrued Pons fees into its reward balance. Collection does not activate a payout.";
    case "sweep-curve": return "Move accrued bonding-curve trading fees to the Pons escrow. The contract checks the token's launch phase and the distributor's fee-routing policy. Collect escrow credit separately after confirmation.";
    case "sweep-pool": return "Move accrued pool trading fees to the Pons escrow. The contract checks the token's graduation phase and enforces its configured conversion bounds. Collect escrow credit separately after confirmation.";
    case "withdraw-cash": return request.receiver ? "Withdraw only this wallet's activated developer and treasury allocations to the receiving wallet shown below." : "Withdraw this wallet's activated developer and treasury allocations to the connected wallet.";
    case "pause": return request.paused ? "Pause new proposals and activations. Existing holder claims and developer or treasury withdrawals remain available." : "Resume new proposals and activations. Distributions still require sufficient collected fees, an operator and the review delay.";
    case "bind-token": return `Bind ${shortAddress(request.address)} as the holder token. This token address can be set only once.`;
    case "propose-owner": return `Propose ${shortAddress(request.address)} as owner. That wallet must accept ownership in a separate transaction.`;
    case "accept-owner": return "Accept the pending ownership transfer. This wallet will control future policies and administrative roles.";
    case "operator": return `Set the distribution operator to ${shortAddress(request.address)}.`;
    case "guardian": return `Set the guardian to ${shortAddress(request.address)}. The guardian may pause or cancel pending distributions.`;
    case "cancel": return `Cancel proposed distribution #${request.epochId} and release its reserved budget. Activated distributions cannot be cancelled.`;
    case "activate": return `Activate distribution #${request.epochId} after its public review delay. Its recorded allocations become claimable.`;
  }
}
export function RewardsAction({ wallet, snapshot, request, onConfirmed, label, disabled = false }: { wallet: WalletState; snapshot: RewardsSnapshot | undefined; request: RewardsRequest; onConfirmed: () => void; label: string; disabled?: boolean }) {
  const [plan, setPlan] = useState<RewardsPlan | null>(null);
  const [lastHash, setLastHash] = useState<Hex | null>(null);
  const [now, setNow] = useState(0);
  const log = useSyncExternalStore(subscribe, () => records, () => emptyRecords);
  useEffect(hydrate, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const account = wallet.account, provider = wallet.selected?.provider;
  const personal = log.filter((record) => record.account.toLowerCase() === account?.toLowerCase());
  const pending = personal.find((record) => record.status === "submitted");
  const latest = lastHash ? personal.find((record) => record.hash === lastHash) : undefined;
  const receipt = useQuery({ queryKey: ["token-rewards-receipt", pending?.hash, account, wallet.chainId], queryFn: () => readReceipt(provider!, pending!), enabled: !!pending && !!provider && wallet.chainId === CHAIN_ID, refetchInterval: 5000, retry: false });
  useEffect(() => { if (receipt.data && receipt.data.hash === pending?.hash) { save(receipt.data); onConfirmed(); } }, [receipt.data, pending?.hash, onConfirmed]);
  const prepare = useMutation({ mutationFn: async () => {
    setPlan(null);
    if (!provider || !account || wallet.demoWallet) throw new Error("Connect a wallet to preview this transaction.");
    const epochId = request.kind === "claim" || request.kind === "claim-to" ? request.claim.epochId : request.kind === "activate" || request.kind === "cancel" ? request.epochId : null;
    const fresh = await getData<RewardsSnapshot>(`rewards?address=${account}${epochId ? `&before=${BigInt(epochId) + BigInt(1)}` : ""}`);
    if (!fresh.distributor || fresh.distributor.address.toLowerCase() !== snapshot?.distributor?.address.toLowerCase()) throw new Error("The configured distributor changed. Refresh before proceeding.");
    return prepareRewardAction(provider, fresh, account, request);
  }, onSuccess: setPlan });
  const send = useMutation({ mutationFn: async () => {
    if (!provider || !account || !plan || !snapshot?.distributor) throw new Error("Prepare this transaction first.");
    if (JSON.stringify(plan.request) !== JSON.stringify(request)) throw new Error("The requested action changed. Prepare it again.");
    const hash = await sendRewardPlan(provider, plan, account, snapshot.distributor.address);
    save({ hash, account, to: plan.transaction.to, kind: request.kind, label, status: "submitted", submittedAt: new Date().toISOString() });
    setLastHash(hash); setPlan(null);
  } });
  const currentPlan = plan && plan.account.toLowerCase() === account?.toLowerCase() && plan.distributor.toLowerCase() === snapshot?.distributor?.address.toLowerCase() && plan.expiresAt > now && JSON.stringify(plan.request) === JSON.stringify(request) ? plan : null;
  const busy = prepare.isPending || send.isPending;
  return <div className="rw-transaction">
    {currentPlan ? <div className="rw-preview" aria-live="polite"><strong style={{ fontSize: 12, fontWeight: 500 }}>Transaction preview · {label}</strong><p style={{ marginTop: 8 }}>{summary(currentPlan.request)}</p>{currentPlan.request.kind === "claim-to" && <dl className="rewards-audit"><dt>Proven holder</dt><dd>{currentPlan.request.claim.account}</dd><dt>Receiving wallet</dt><dd>{currentPlan.request.receiver}</dd><dt>Allocation</dt><dd>{formatUnits(BigInt(currentPlan.request.claim.amount), snapshot?.distributor?.rewardDecimals ?? 18)} {snapshot?.distributor?.rewardSymbol}</dd></dl>}{currentPlan.request.kind === "withdraw-cash" && currentPlan.request.receiver && <dl className="rewards-audit"><dt>Allocation owner</dt><dd>{currentPlan.account}</dd><dt>Receiving wallet</dt><dd>{currentPlan.request.receiver}</dd></dl>}{currentPlan.request.kind === "policy" && <dl className="rewards-audit"><dt>Interval</dt><dd>{currentPlan.request.policy.intervalSeconds / 60} minutes</dd><dt>Review delay</dt><dd>{currentPlan.request.policy.rootDelaySeconds / 60} minutes</dd><dt>Minimum income</dt><dd>{formatUnits(BigInt(currentPlan.request.policy.minimumIncome), snapshot?.distributor?.rewardDecimals ?? 18)} {snapshot?.distributor?.rewardSymbol}</dd><dt>Developer wallet</dt><dd>{currentPlan.request.policy.devWallet}</dd><dt>Treasury wallet</dt><dd>{currentPlan.request.policy.treasuryWallet}</dd></dl>}<p style={{ marginTop: 8 }}>Contract: {shortAddress(currentPlan.distributor)}. Network gas is paid in ETH. This simulation expires after 30 seconds.</p><button className="rewards-button" disabled={busy || !!pending || disabled || wallet.chainId !== CHAIN_ID} onClick={() => send.mutate()}>{send.isPending && <LoaderCircle size={14} className="spin"/>}Confirm in wallet</button><button className="rewards-text-button" style={{ marginLeft: 12 }} disabled={busy} onClick={() => setPlan(null)}>Discard preview</button></div> : <button className="rewards-button" disabled={disabled || busy || !!pending || !account || !provider || wallet.chainId !== CHAIN_ID || snapshot?.status !== "ready" || !!snapshot.dataStatus} onClick={() => { send.reset(); prepare.mutate(); }}>{prepare.isPending && <LoaderCircle size={14} className="spin"/>}Preview {label.toLowerCase()}</button>}
    {(prepare.error || send.error) && <p className="rw-error" role="alert">{(prepare.error || send.error)?.message}</p>}
    {latest && <a className="rw-receipt" href={`${EXPLORER}/tx/${latest.hash}`} target="_blank" rel="noreferrer">{latest.status === "submitted" ? "Submitted · awaiting receipt" : latest.status === "confirmed" ? "Confirmed onchain" : "Reverted · no action completed"}<ArrowUpRight size={12}/></a>}
    {pending && pending.hash !== lastHash && <a className="rw-receipt" href={`${EXPLORER}/tx/${pending.hash}`} target="_blank" rel="noreferrer">{pending.label} pending · view transaction<ArrowUpRight size={12}/></a>}
    {receipt.error && pending && <p className="rw-error">{receipt.error.message} Check the explorer before submitting another transaction.</p>}
  </div>;
}
