"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, CircleHelp, RefreshCw } from "lucide-react";
import { DataError, ageLabel, displayNumber as n, getData, pollingInterval, shortAddress } from "@/lib/live-api";
import { sourceIsCurrent } from "@/lib/live-freshness";
import { EXPLORER, type CorporateActions, type NetworkState, type PoolBook, type PriceBook, type StockAsset } from "@/lib/market-types";
import { ReferenceChart } from "./market-charts";
import { AppSelect } from "./app-select";
import { StockLogo } from "./stock-logo";
import { ProtocolLogo } from "./protocol-logo";
import { TradeTicket } from "./trade-ticket";
import type { WalletState } from "./wallet";
import "./market-terminal.css";

const compact = (value: string | number | null | undefined) => value != null && Number(value) > 0 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(value)) : "—";
const pretty = (value?: string | null) => value ? value.replaceAll("_", " ") : "Not reported";

export function MarketTerminal({ assets, book, network, symbol, onSelect, now, wallet, registryCached, priceError }: {
  assets: StockAsset[]; book?: PriceBook; network?: NetworkState; symbol: string; onSelect: (s: string) => void; now: number; wallet: WalletState; registryCached: boolean; priceError: string | null;
}) {
  const [allEvents, setAllEvents] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const asset = assets.find((a) => a.symbol === symbol);
  const quote = book?.quotes.find((q) => q.symbol === symbol);
  const multiplier = asset ? Number(asset.multiplier) : null;
  const bid = quote && multiplier !== null ? Number(quote.bid) * multiplier : null, ask = quote && multiplier !== null ? Number(quote.ask) * multiplier : null;
  const spread = bid && ask ? (ask - bid) / ((ask + bid) / 2) * 10000 : null;
  const referenceOld = registryCached || !!priceError || !!book?.dataStatus || !!book?.cachedSymbols?.includes(symbol) || (!!quote && !sourceIsCurrent(quote.generatedAt, now, 90000));
  const pools = useQuery({ queryKey: ["pools", symbol], queryFn: ({ signal }) => getData<PoolBook>(`pools?symbol=${encodeURIComponent(symbol)}`, signal), enabled: !!asset, staleTime: 30000, refetchInterval: (q) => pollingInterval(30000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) });
  const events = useQuery({ queryKey: ["corporate-actions"], queryFn: ({ signal }) => getData<CorporateActions>("corporate-actions", signal), staleTime: 3600000, enabled: eventsOpen });
  const displayedEvents = (events.data?.items ?? []).filter((e) => allEvents || e.symbol === symbol).slice(0, 6);
  const poolRows = [...(pools.data?.pools ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.fee - b.fee);
  const activePools = poolRows.filter((pool) => pool.active).length;
  const poolRetryAt = Math.max(pools.error instanceof DataError ? pools.error.retryAt : 0, pools.data?.dataStatus?.retryAt ? Date.parse(pools.data.dataStatus.retryAt) : 0);
  const poolCooldown = Math.max(0, Math.ceil((poolRetryAt - now) / 1000));
  const poolsCached = !!pools.data && (!!pools.error || !!pools.data.dataStatus || !sourceIsCurrent(pools.data.blockTimestamp, now, 90000));
  const poolStatus = pools.data ? poolsCached ? "Last snapshot" : pools.data.failedReads ? "Partial data" : "Live snapshot" : !asset ? "Token data required" : pools.error ? "Unavailable" : "Loading";
  const assetOptions = assets.length ? assets.map((a) => ({ value: a.symbol, label: a.symbol, detail: a.name })) : [{ value: symbol, label: symbol }];
  return <div className="market-terminal">
    <div className="terminal-toolbar"><div className="terminal-token-select"><StockLogo symbol={symbol} size={30}/><AppSelect ariaLabel="Choose a Stock Token" value={symbol} options={assetOptions} onChange={onSelect}/></div><span>Stock Token / USDG <b>·</b> Uniswap V3 pools</span></div>
    <div className="terminal-columns"><div className="terminal-analysis">
      <section className="asset-pulse"><div className="asset-pulse-heading"><div><span className="eyebrow stock-identity"><StockLogo symbol={symbol} size={38}/>{asset?.name ?? symbol} / STOCK TOKEN</span><h2>{bid !== null && ask !== null ? `$${n((bid + ask) / 2, 4)}` : priceError ? "Reference unavailable" : "Awaiting reference"}</h2><p>USD reference per token <span className={referenceOld || quote?.halted ? "reference-aged" : ""}>{quote?.halted ? "Underlying halted" : referenceOld ? "Last source observation" : quote ? "Issuer quote" : "Awaiting issuer"}</span></p></div></div>
        <div className="pulse-metrics"><div><span>Reference bid</span><strong>{bid === null ? "—" : `$${n(bid, 4)}`}</strong></div><div><span>Reference ask</span><strong>{ask === null ? "—" : `$${n(ask, 4)}`}</strong></div><div><span>Bid / ask spread</span><strong>{spread === null ? "—" : n(spread, 2)}<small> bps</small></strong></div><div><span>Underlying volume</span><strong>{compact(quote?.dailyTradingVolume)}</strong></div></div>
        <div className="pulse-source"><span title={quote ? new Date(quote.generatedAt).toLocaleString() : undefined}>Robinhood · {quote ? `Observed ${ageLabel(quote.generatedAt, now)}` : priceError ? "Reference unavailable" : "Source pending"} · {priceError || book?.dataStatus ? "Updates delayed" : "checks every 15s"}</span><span>Volume is the issuer’s daily underlying figure, not onchain volume.</span></div>
      </section>
      {(priceError || book?.unavailableSymbols?.length || registryCached) && <p className="terminal-alert" role="status"><CircleHelp size={16}/>{registryCached ? "Showing cached registry information. A fresh registry is required for trade preparation." : priceError ?? `Reference updates are pending for ${book?.unavailableSymbols?.join(", ")}. Other markets remain available.`}</p>}
      <ReferenceChart key={symbol} symbol={symbol} assets={assets} book={book} now={now} onSelect={onSelect} registryCached={registryCached} sourceUnavailable={!!priceError} initialMode="session" selectable={false}/>
      <section className="terminal-panel liquidity-board" aria-label={`${symbol} liquidity pools`}>
        <div className="terminal-section-heading"><div><span className="eyebrow">ONCHAIN LIQUIDITY</span><h3><ProtocolLogo protocol="uniswap" size={25}/>Uniswap V3 pools</h3></div><span className={`pool-status ${poolsCached || pools.error || pools.data?.failedReads ? "is-delayed" : ""}`}>{poolStatus}</span></div>
        {poolRows.length > 0 ? <div className="liquidity-list">{poolRows.map((pool) => <a key={pool.address} className="liquidity-row" href={`${EXPLORER}/address/${pool.address}`} target="_blank" rel="noreferrer">
          <div className="liquidity-pair"><StockLogo symbol={symbol} size={32}/><div><strong>{symbol} / USDG</strong><span>{pool.fee / 10000}% fee · {pool.active ? "Active liquidity" : "Inactive pool"}</span></div></div>
          <div className="liquidity-price"><strong>{pool.active ? n(pool.priceUSDG, 4) : "—"}</strong><span>{pool.active ? "USDG / token" : "No active liquidity"}</span></div><ArrowUpRight size={15}/>
        </a>)}</div> : <div className="liquidity-empty" role="status"><ProtocolLogo protocol="uniswap" size={38}/><div><strong>{!asset ? "Waiting for the token registry" : pools.error ? "Pool data is temporarily unavailable" : pools.isPending ? "Checking pool liquidity…" : pools.data?.failedReads ? "Pool discovery is incomplete" : `No ${symbol} / USDG pools found`}</strong><p>{!asset ? "Pool reads begin once this token’s registry details are available." : pools.error ? "Retry when the source is ready. A live quote is required before any trade." : pools.isPending ? "Reading the supported fee tiers on Robinhood Chain." : pools.data?.failedReads ? "Some source reads failed. Retry to verify the available pools." : "No pool was returned at the supported fee tiers."}</p></div></div>}
        <div className="liquidity-refresh"><span>{pools.data ? `${activePools} active ${activePools === 1 ? "pool" : "pools"} · ${ageLabel(pools.data.blockTimestamp, now)}${pools.data.failedReads ? ` · ${pools.data.failedReads} failed reads` : ""}` : "Robinhood Chain"}</span><button disabled={!asset || pools.isFetching || poolCooldown > 0} onClick={() => void pools.refetch()}><RefreshCw size={13} className={pools.isFetching ? "spin" : ""}/>{pools.isFetching ? "Refreshing…" : poolCooldown ? `Retry in ${poolCooldown}s` : "Refresh pools"}</button></div>
        <p className="terminal-panel-note">{poolsCached ? "Showing the last available snapshot. " : ""}Pool spot prices are indicative. Get a live quote in the trade card for your amount.</p>
      </section>
    </div><aside className="terminal-trading">{asset ? <TradeTicket key={asset.address} asset={asset} now={now} wallet={wallet}/> : <div className="trade-ticket"><h3>Token data required</h3><p>The trade card opens when the official token registry is available.</p></div>}</aside></div>
    <div className="terminal-bottom">
      <details className="terminal-panel corporate-board" onToggle={(event) => setEventsOpen(event.currentTarget.open)}><summary className="terminal-section-heading"><span><CalendarDays size={17}/> Corporate actions</span><span>Issuer calendar</span></summary><div className="event-filter"><button aria-pressed={allEvents} onClick={() => setAllEvents(!allEvents)}>{allEvents ? `Show ${symbol}` : "Show all assets"}</button></div><div className="event-timeline">{displayedEvents.length ? displayedEvents.map((event, i) => <div key={event.id ?? `${event.symbol}-${event.type}-${i}`}><span className="event-date" title={event.date ?? "Date not scheduled"}>{event.date ? <><b>{event.date.slice(8)}</b>{new Date(`${event.date}T12:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" })}<small>{event.date.slice(0,4)}</small></> : "TBD"}</span><div><span>{event.symbol} <small>{pretty(event.status)}</small></span><strong>{pretty(event.type)}</strong><p>{event.detail ?? "Details are unavailable in this view."}</p></div></div>) : <p className="terminal-empty">{events.isPending ? "Loading issuer events…" : events.error ? events.error.message : `No ${symbol} events were returned. View all assets to explore the issuer calendar.`}</p>}</div><p className="terminal-panel-note">Issuer processing dates, not dividend payment dates. {events.data?.dataStatus ? "Cached data · " : ""}{events.data ? `Fetched ${ageLabel(events.data.fetchedAt, now)}.` : ""}</p></details>
    </div>
    {asset && <section className="terminal-facts"><div><span>Token contract</span><a href={`${EXPLORER}/address/${asset.address}`} target="_blank" rel="noreferrer">{shortAddress(asset.address)}<ArrowUpRight size={12}/></a></div><div><span>Share-equivalent multiplier</span><strong>{n(asset.multiplier, 6)} / token</strong></div><div><span>Underlying overnight trading</span><strong>{pretty(asset.tradingCapabilities?.allDayTradability)}</strong></div><div><span>Network gas price · {network ? `${network.dataStatus || !sourceIsCurrent(network.blockTimestamp, now, 90000) ? "last · " : ""}${ageLabel(network.blockTimestamp, now)}` : "pending"}</span><strong>{network ? n(Number(network.gasPriceWei) / 1e9, 5) : "—"} gwei</strong></div>{asset.pendingMultiplier && <p>Scheduled token adjustment: {n(asset.pendingMultiplier, 6)} shares per token{asset.pendingMultiplierEffectiveTime ? ` · ${new Date(asset.pendingMultiplierEffectiveTime).toLocaleString()}` : ""}.</p>}<p>Stock Tokens provide issuer-defined financial exposure. Underlying trading capabilities do not determine whether an onchain swap can execute.</p></section>}
  </div>;
}
