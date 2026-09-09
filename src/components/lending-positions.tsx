"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, RefreshCw, Wallet } from "lucide-react";
import { ageLabel, getData } from "@/lib/live-api";
import { validLendingId, type LendingKind } from "@/lib/lending-execution";
import type { DiscoveredPosition, LendingPositionsResponse } from "@/lib/lending-positions";
import { useLendingTransactions } from "@/lib/lending-transactions";
import type { WalletState } from "./wallet";
import { TokenLogo } from "./token-logo";
import type { LendingTarget } from "./lending-execution";
export function LendingPositions({ wallet, now, onOpen }: { wallet: WalletState; now: number; onOpen: (target: LendingTarget) => void }) {
  const [kind, setKind] = useState<LendingKind>("market"), [id, setId] = useState("");
  const log = useLendingTransactions();
  const own = log.records.filter((r) => r.account.toLowerCase() === wallet.account?.toLowerCase());
  const confirmed = own.find((r) => r.status === "confirmed" && (r.kind === "deposit" || r.kind === "withdraw"));
  const positions = useQuery({ queryKey: ["lending-positions", wallet.account, confirmed?.hash], queryFn: ({ signal }) => getData<LendingPositionsResponse>(`lending/positions?address=${wallet.account}`, signal), enabled: !!wallet.account, staleTime: 60000, retry: false, refetchOnWindowFocus: false });
  const saved = [...new Map(own.filter((r) => r.kind === "deposit" || r.kind === "withdraw").map((r) => [r.target, { kind: r.targetKind, id: r.target, label: r.label }])).values()];
  const discovered = positions.data?.positions ?? [];
  const targets: DiscoveredPosition[] = [...discovered, ...saved.filter((s) => !discovered.some((d) => d.id.toLowerCase() === s.id.toLowerCase()))];
  if (wallet.demoWallet) return <section className="lend-positions"><div className="demo-execution-notice"><strong>{wallet.demoWallet.name} · simulated wallet</strong><p>View your preset Stock Token holdings in Portfolio. This demo has no lending positions; you can still explore the live markets below.</p><a href="#lending-explore">Explore lending markets</a></div></section>;
  if (!wallet.account) return <aside className="lend-wallet-prompt" aria-label="Your lending positions"><Wallet size={18} aria-hidden="true"/><p id="lending-positions-heading" tabIndex={-1}>Connect your wallet to view and manage positions. Explore markets below.</p></aside>;
  return <section className="lend-positions" aria-labelledby="lending-positions-heading">
    <div className="lend-section-heading"><div><span className="eyebrow"><Wallet size={12}/>YOUR WALLET</span><h3 id="lending-positions-heading" tabIndex={-1}>Your positions<span className="lend-position-count">{positions.isPending && !targets.length ? "—" : targets.length}</span></h3></div><button disabled={positions.isFetching || !!positions.data && now - Date.parse(positions.data.fetchedAt) < 30000} onClick={() => void positions.refetch()}><RefreshCw size={13} className={positions.isFetching ? "spin" : ""}/>{positions.isFetching ? "Updating…" : "Refresh positions"}</button></div>
      {targets.map((t) => <div className="lend-position-card" key={`${t.kind}-${t.id}`}><button className="lend-position-identity" onClick={() => onOpen(t)}><TokenLogo asset={t.asset} size={40}/><span><strong>{t.asset?.symbol ?? t.label}<span>{t.kind === "vault" ? "Vault" : "Market"}</span></strong><small>{t.asset ? t.label : "Saved position"}</small></span><ChevronRight size={14}/></button><div className="lend-position-amount"><strong title={t.indexedAssetsRaw && t.asset ? formatUnits(BigInt(t.indexedAssetsRaw), t.asset.decimals) : undefined}>{t.indexedAssetsRaw && t.asset ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(Number(formatUnits(BigInt(t.indexedAssetsRaw), t.asset.decimals))) : "Check balance"}<small>{t.asset?.symbol}</small></strong><span>{t.indexedAssetsRaw ? "Indexed supplied balance" : "Read onchain to update"}</span></div><div className="lend-position-actions"><button aria-label={`Deposit ${t.asset?.symbol ?? "assets"} into ${t.label}`} onClick={() => onOpen({ ...t, initialOperation: "deposit" })}><ArrowDownLeft size={14}/>Deposit</button><button aria-label={`Withdraw from ${t.label}`} onClick={() => onOpen({ ...t, initialOperation: "withdraw" })}><ArrowUpRight size={14}/>Withdraw</button></div></div>)}
      {!targets.length && (positions.isPending ? <div className="lend-positions-loading" role="status"><span>Finding your Morpho positions…</span><div aria-hidden="true" className="lend-position-skeleton"/><div aria-hidden="true" className="lend-position-skeleton"/></div> : <p className="lend-positions-empty">{positions.error || positions.data?.warnings.length ? "We couldn’t confirm your positions. Open a market or use its contract below to check your balance directly." : "No lending positions found. Choose a market below to preview your first deposit."}</p>)}
      {positions.error && <p className="lend-footnote">{positions.error.message}</p>}{positions.data?.warnings.map((w) => <p className="lend-footnote" key={w}>{w}</p>)}
      {positions.data && <p className="lend-footnote">Updated {ageLabel(positions.data.fetchedAt, now)}. Opening a position checks its balance onchain. {positions.data.truncated ? "Showing the first 50 positions of each type; open additional positions by contract." : "V1 vaults and fee wrappers are excluded."}</p>}
      <details className="lend-manual"><summary>Find a position by contract<ChevronDown size={13}/></summary><p>Use a Morpho market ID or a V2 vault address on Robinhood Chain. This works when position discovery is unavailable.</p><div><select aria-label="Position type" value={kind} onChange={(e) => setKind(e.target.value as LendingKind)}><option value="market">Market ID</option><option value="vault">V2 vault address</option></select><input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="0x…" aria-label="Lending contract or market ID"/><button disabled={!validLendingId(kind, id)} onClick={() => onOpen({ kind, id, label: `${kind === "market" ? "Market" : "Vault"} ${id.slice(0, 6)}…${id.slice(-4)}` })}>Open<ChevronRight size={13}/></button></div></details>
  </section>;
}
