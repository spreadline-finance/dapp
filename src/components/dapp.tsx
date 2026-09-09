"use client";
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ConnectionNotice, PwaInstallButton } from "./pwa";
import { useEffect, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Ellipsis,
  Layers3,
  Landmark,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  BookOpen,
  ShieldCheck,
  Wallet,
  Vault,
  X,
} from "lucide-react";
import { useWallet, WalletButton, DemoWalletNotice, type WalletState } from "./wallet";
import { DemoPortfolio } from "./demo-portfolio";
import {
  getData,
  DataError,
  displayNumber as n,
  shortAddress,
  ageLabel,
  pollingInterval,
} from "@/lib/live-api";
import {
  CHAIN_ID,
  EXPLORER,
  USDG,
  V3_FACTORY,
  V3_QUOTER,
  TRACKED_SYMBOLS,
  type Catalog,
  type PriceBook,
  type StockAsset,
  type NetworkState,
  type PoolBook,
  type QuoteBook,
  type Portfolio,
  type CorporateActions,
} from "@/lib/market-types";
import { ReferenceChart, StrategyLab, RouteComparison, ProductGuide } from "./market-charts";
import { recordPrices } from "@/lib/price-observations";
import { OpportunityCheck, QuoteDecision, ResearchJournal } from "./opportunity-check";
import { saveObservation } from "@/lib/research-journal";
import { MarketTerminal } from "./market-terminal";
import { StockLogo } from "./stock-logo";
import { Lending } from "./lending";
import { StrategyDesk } from "./desk";
import { TokenRewards } from "./token-rewards";
import { ResearchHistoryChart } from "./arbitrage-monitor";
import { requestResearchQuote } from "@/lib/research-quote-client";
import { PositionPlanner } from "./position-planner";
import "./dapp.css";
type View = "terminal" | "planner" | "lending" | "desk" | "rewards" | "check" | "markets" | "routes" | "portfolio" | "activity" | "infrastructure" | "learn";
const views = [
  { id: "terminal", label: "Markets & trading", icon: ChartNoAxesCombined },
  { id: "planner", label: "Position & exit planner", icon: Layers3 },
  { id: "lending", label: "Lending", icon: Landmark },
  { id: "desk", label: "Desk & earn", icon: Vault },
  { id: "rewards", label: "Token rewards", icon: Wallet },
  { id: "check", label: "Arbitrage research", icon: Search },
  { id: "markets", label: "Asset directory", icon: ChartNoAxesCombined },
  { id: "routes", label: "Route analysis", icon: Layers3 },
  { id: "portfolio", label: "Portfolio", icon: Wallet },
  { id: "activity", label: "Research log", icon: Activity },
  { id: "learn", label: "How it works", icon: BookOpen },
  { id: "infrastructure", label: "Sources & status", icon: Server },
] as const;
function MobileNavigation({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const [open, setOpen] = useState(false);
  const primary = [{ id: "terminal", label: "Markets", icon: ChartNoAxesCombined }, { id: "lending", label: "Lending", icon: Landmark }, { id: "portfolio", label: "Portfolio", icon: Wallet }] as const;
  const secondary = views.filter((item) => !primary.some((main) => main.id === item.id));
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <nav className="app-bottom-nav" aria-label="Mobile workspace">
      {primary.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)}><item.icon size={21}/><span>{item.label}</span></button>)}
      <Dialog.Trigger aria-current={secondary.some((item) => item.id === view) ? "page" : undefined}><Ellipsis size={22}/><span>More</span></Dialog.Trigger>
    </nav>
    <Dialog.Portal><Dialog.Overlay className="app-menu-overlay"/><Dialog.Content className="app-menu-sheet">
      <div className="app-menu-heading"><Dialog.Title>More from Spreadline</Dialog.Title><Dialog.Close aria-label="Close navigation"><X size={20}/></Dialog.Close></div>
      <Dialog.Description className="sr-only">Research tools, data sources and app installation.</Dialog.Description>
      <nav aria-label="More workspace views">{secondary.map((item) => <button key={item.id} aria-current={view === item.id ? "page" : undefined} onClick={() => { setOpen(false); onNavigate(item.id); }}><item.icon size={20}/><span>{item.label}</span><ChevronRight size={17}/></button>)}</nav>
      <div className="app-menu-install"><PwaInstallButton/></div>
      <Link className="app-menu-about" href="/">About Spreadline<ArrowUpRight size={16}/></Link>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
function useClock() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className="address-copy"
      aria-label={`Copy ${value}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => {});
      }}
    >
      {shortAddress(value)}
      {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
    </button>
  );
}
function ErrorBox({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  const now = useClock();
  const remaining = error instanceof DataError ? Math.max(0, Math.ceil((error.retryAt - now) / 1000)) : 0;
  return error ? (
    <div className="desk-error" role="status">
      <CircleHelp size={17} />
      <p>{error.message}</p>
      {retry && (
        <button onClick={retry} disabled={remaining > 0}>
          {remaining > 0 ? `Retry in ${remaining}s` : "Retry"} <RefreshCw size={13} />
        </button>
      )}
    </div>
  ) : null;
}
function SkeletonRows() {
  return (
    <div className="market-skeleton" aria-label="Loading live markets">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="desk-empty">
      <Layers3 size={28} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function PoolPanel({
  symbol,
  now,
  onAnalyze,
}: {
  symbol: string;
  now: number;
  onAnalyze: () => void;
}) {
  const query = useQuery({
    queryKey: ["pools", symbol],
    queryFn: ({ signal }) =>
      getData<PoolBook>(`pools?symbol=${encodeURIComponent(symbol)}`, signal),
    refetchInterval: (q) => pollingInterval(60000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt),
    staleTime: 60000,
  });
  const data = query.data;
  const stale = !!data && (!!data.dataStatus || now - Date.parse(data.blockTimestamp) > 90000);
  return (
    <div className="desk-panel pool-panel">
      <div className="desk-panel-heading">
        <h2>{symbol} / USDG pools</h2>
        <span className={`data-tag ${query.isError || stale ? "warning" : ""}`}>
          <i />
          {query.isError
            ? "Update failed"
            : stale
              ? "Stale snapshot"
              : data
                ? "Onchain"
                : "Connecting"}
        </span>
      </div>
      <div className="pool-panel-subtitle">
        Discovered through the official Uniswap V3 factory.
      </div>
      <ErrorBox error={query.error} retry={() => void query.refetch()} />
      {data?.dataStatus && <p className="panel-note">Last successful pool snapshot · {ageLabel(data.fetchedAt, now)}. Updates resume automatically.</p>}
      {query.isPending ? (
        <SkeletonRows />
      ) : data?.pools.length ? (
        <div className="actual-pools">
          {data.pools.map((pool) => (
            <div key={pool.address}>
              <div>
                <span className="pool-fee">
                  {n(pool.fee / 10000, pool.fee === 100 ? 2 : 2)}%
                </span>
                <span>
                  <strong>Uniswap V3</strong>
                  <a
                    href={`${EXPLORER}/address/${pool.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(pool.address)} <ArrowUpRight size={11} />
                  </a>
                </span>
              </div>
              <div>
                <strong>
                  {pool.active ? n(pool.priceUSDG, 4) : "Inactive"}
                </strong>
                <span>
                  {pool.active ? "USDG per token" : "No active liquidity"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty title="No V3 pools found.">
            No pools were found in the four supported fee tiers for this token
            and USDG.
          </Empty>
        )
      )}
      {data && (
        <div className="pool-source">
          <a
            href={`${EXPLORER}/block/${data.blockNumber}`}
            target="_blank"
            rel="noreferrer"
          >
            Block {n(data.blockNumber, 0)} <ArrowUpRight size={11} />
          </a>
          <span>{ageLabel(data.blockTimestamp, now)}</span>
        </div>
      )}
      {!!data?.failedReads && (
        <p className="desk-error-inline panel-note">
          {data.failedReads} pool reads failed. This list may be incomplete.
        </p>
      )}
      <button className="pool-action" onClick={onAnalyze}>
        Analyze a round trip <ArrowUpRight size={16} />
      </button>
    </div>
  );
}
function RouteAnalysis({
  assets,
  symbol,
  setSymbol,
  now,
  onQuote,
  onInfrastructure,
  initialQuote,
}: {
  initialQuote?: QuoteBook;
  assets: StockAsset[];
  symbol: string;
  setSymbol: (v: string) => void;
  now: number;
  onQuote: (q: QuoteBook) => void;
  onInfrastructure: () => void;
}) {
  const [amount, setAmount] = useState(initialQuote?.amountIn ?? "1000");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const quote = useMutation({
    mutationFn: async () => {
      controller.current?.abort();
      controller.current = new AbortController();
      return requestResearchQuote(symbol, amount, controller.current.signal);
    },
    onSuccess: onQuote,
  });
  const data = quote.data ?? (initialQuote?.symbol === symbol && Number(initialQuote.amountIn) === Number(amount) ? initialQuote : undefined);
  const quoteCooldown = quote.error instanceof DataError ? Math.max(0, Math.ceil((quote.error.retryAt - now) / 1000)) : 0;
  const expired = !!data && now >= Date.parse(data.expiresAt);
  const selected = assets.find((a) => a.symbol === symbol);
  const amountValid =
    /^\d{1,7}(\.\d{1,6})?$/.test(amount) &&
    Number(amount) >= 1 &&
    Number(amount) <= 100000;
  return (
    <div className="route-layout">
      <div>
        <div className="desk-panel route-builder">
          <div className="desk-panel-heading">
            <h2>Quote the complete trade</h2>
            <span className="data-tag">
              <i />
              Mainnet reads
            </span>
          </div>
          <div className="route-builder-body">
            <label htmlFor="route-asset">Stock Token</label>
            <div className="route-token-input">
              {selected && <StockLogo symbol={selected.symbol} />}
              <select
                id="route-asset"
                value={symbol}
                disabled={quote.isPending || !assets.length}
                onChange={(e) => {
                  quote.reset();
                  setSymbol(e.target.value);
                }}
              >
                {assets
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.address} value={a.symbol}>
                      {a.symbol} — {a.name}
                    </option>
                  ))}
              </select>
            </div>
            <label htmlFor="route-amount">
              Starting amount <span>USDG</span>
            </label>
            <div className="route-amount-input">
              <input
                id="route-amount"
                inputMode="decimal"
                value={amount}
                disabled={quote.isPending}
                onChange={(e) => {
                  setAmount(e.target.value);
                  quote.reset();
                }}
                autoComplete="off"
              />
              <span>USDG</span>
            </div>
            <div className="size-presets">
              {["100", "1000", "5000", "10000"].map((value) => (
                <button
                  key={value}
                  disabled={quote.isPending}
                  aria-pressed={amount === value}
                  onClick={() => {
                    setAmount(value);
                    quote.reset();
                  }}
                >
                  {n(value, 0)}
                </button>
              ))}
            </div>
            {!amountValid && (
              <p className="desk-error-inline">
                Enter 1–100,000 USDG, with up to 6 decimals.
              </p>
            )}
            <div className="real-route-path">
              <span>USDG</span>
              <ArrowRight size={15} />
              <span>{symbol}</span>
              <ArrowRight size={15} />
              <span>USDG</span>
            </div>
            <p>
              Checks both directions across distinct Uniswap V3 pools at the
              same block. Swap fees and price impact are included in each
              returned amount.
            </p>
            <button
              className="button button-primary route-quote-button"
              disabled={quote.isPending || !amountValid || !selected || quoteCooldown > 0}
              onClick={() => quote.mutate()}
            >
              {quote.isPending ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Reading onchain quotes…
                </>
              ) : (
                <>
                  {quoteCooldown > 0 ? `Provider cooldown · ${quoteCooldown}s` : "Get live route quotes"} <ArrowUpRight size={16} />
                </>
              )}
            </button>
            <span className="quote-scope">
              Read-only simulation. No approval or transaction is requested.
            </span>
          </div>
        </div>
        <div className="route-boundary">
          <ShieldCheck size={21} />
          <div>
            <strong>A quote is not an execution.</strong>
            <p>
              Gross surplus excludes Spreadline fees and the full transaction’s
              gas. Quotes can expire or change before a trade is included.
            </p>
          </div>
        </div>
      </div>
      <div className="route-results">
        <ErrorBox error={quote.error} retry={() => quote.mutate()} />
        {quote.isPending ? (
          <div className="desk-panel">
            <div className="quote-loading">
              <LoaderCircle size={27} className="spin" />
              <h3>Comparing actual pool routes.</h3>
              <p>
                Reading reserves and simulating the complete round trip at one
                chain block.
              </p>
              <div>
                <span>Pool discovery</span>
                <span>Route simulation</span>
                <span>Cost disclosure</span>
              </div>
            </div>
          </div>
        ) : data ? (
          <>
            <QuoteDecision key={`${data.symbol}-${data.blockHash}-${data.amountIn}`} quote={data} now={now} />
            {expired && (
              <div className="desk-notice">
                <Clock3 size={17} />
                <span>
                  This quote has expired. Refresh before making a decision.
                </span>
                <button onClick={() => quote.mutate()}>Requote</button>
              </div>
            )}
            <RouteComparison data={data} />
            <div className="desk-panel">
              <div className="desk-panel-heading">
                <h2>Compared routes</h2>
                <span>
                  {data.routes.length} quoted / {data.attempted} attempted
                </span>
              </div>
              {data.routes.length ? (
                <div className="route-table-scroll">
                  <table className="route-table">
                    <thead>
                      <tr>
                        <th>Buy pool → sell pool</th>
                        <th>Returned USDG</th>
                        <th>Gross surplus</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.routes.map((r, i) => (
                        <tr key={`${r.buyFee}-${r.sellFee}`}>
                          <td>
                            <span className="route-rank">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <a
                              title="Buy pool on explorer"
                              href={`${EXPLORER}/address/${r.buyPool}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {n(r.buyFee / 10000, 2)}%
                            </a>
                            <ArrowRight size={11} />
                            <a
                              title="Sell pool on explorer"
                              href={`${EXPLORER}/address/${r.sellPool}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {n(r.sellFee / 10000, 2)}%
                            </a>
                          </td>
                          <td>{n(r.amountOut, 6)}</td>
                          <td
                            className={
                              Number(r.surplus) > 0 ? "positive" : "accent"
                            }
                          >
                            {Number(r.surplus) > 0 ? "+" : ""}
                            {n(r.surplus, 6)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No usable route returned.">
                  Try a smaller size or another Stock Token. Empty results are
                  not replaced with estimates.
                </Empty>
              )}
              {data.failed > 0 && (
                <p className="panel-note">
                  {data.failed} paths failed to quote and are omitted. The
                  comparison may be incomplete.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="desk-panel awaiting-quote">
            <div className="awaiting-icon">
              <Layers3 size={31} />
            </div>
            <span className="eyebrow">THE ROUTE, BEFORE THE TRADE</span>
            <h2 className="display">
              Make the whole
              <br />
              <em>trade add up.</em>
            </h2>
            <p>
              Set a size to compare real USDG round trips across the supported
              V3 fee tiers.
            </p>
            <div className="awaiting-foot">
              <span>01 / Read a single block</span>
              <span>02 / Compare full paths</span>
              <span>03 / Show the outcome</span>
            </div>
          </div>
        )}
        <div className="execution-gate">
          <div>
            <span className="offline-dot" />
            <strong>Automated round trips are not enabled</strong>
          </div>
          <p>
            No Spreadline executor is deployed/configured in this application.
            This round-trip research view does not submit trades.
          </p>
          <button className="text-link" onClick={onInfrastructure}>
            Understand the data sources <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
function PortfolioView({ wallet, onPlan }: { wallet: WalletState; onPlan: (symbol: string, amount?: string) => void }) {
  const [input, setInput] = useState("");
  const [watch, setWatch] = useState("");
  const address = watch || wallet.account;
  const query = useQuery({
    queryKey: ["portfolio", address],
    queryFn: ({ signal }) =>
      getData<Portfolio>(
        `portfolio?address=${encodeURIComponent(address!)}`,
        signal,
      ),
    enabled: !!address && !wallet.demoWallet,
    refetchInterval: (q) => pollingInterval(60000, q.state.error, q.state.fetchFailureCount),
    staleTime: 60000,
  });
  const formValid = /^0x[a-fA-F0-9]{40}$/.test(input);
  if (wallet.demoWallet) return <DemoPortfolio wallet={wallet.demoWallet} onPlan={onPlan}/>;
  return (
    <>
      <div className="portfolio-top">
        <div>
          <h2>Wallet balances</h2>
          <p>Read ETH, USDG and the tracked Stock Tokens on Robinhood Chain.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (formValid) setWatch(input);
          }}
        >
          <label className="sr-only" htmlFor="watch-address">
            Public wallet address
          </label>
          <input
            id="watch-address"
            placeholder="Or enter a public 0x address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
          />
          <button className="button button-primary" disabled={!formValid}>
            View address
          </button>
        </form>
      </div>
      {watch && (
        <div className="desk-notice">
          <Wallet size={16} />
          <span>
            Viewing a public address. This does not connect its wallet.
          </span>
          <button
            onClick={() => {
              setWatch("");
              setInput("");
            }}
          >
            Clear
          </button>
        </div>
      )}
      {wallet.account && wallet.chainId !== CHAIN_ID && !watch && (
        <div className="desk-notice">
          <CircleHelp size={16} />
          <span>
            Your wallet is on another network. The balances below are read from
            Robinhood Chain.
          </span>
          <button
            disabled={wallet.pending}
            onClick={() => void wallet.switchNetwork()}
          >
            Switch network
          </button>
        </div>
      )}
      <ErrorBox error={query.error} retry={() => void query.refetch()} />
      {!address ? (
        <div className="desk-panel">
          <Empty title="Your assets, from the chain.">
            Connect your wallet or enter a public address to view actual
            balances. No simulated portfolio is shown.
          </Empty>
          <div className="center-wallet">
            <WalletButton wallet={wallet} />
          </div>
        </div>
      ) : query.isPending ? (
        <div className="desk-panel">
          <SkeletonRows />
        </div>
      ) : (
        query.data && (
          <div className="desk-panel">
            <div className="desk-panel-heading">
              <div className="portfolio-address">
                <Wallet size={17} />
                <CopyAddress value={query.data.address} />
              </div>
              <a
                href={`${EXPLORER}/address/${query.data.address}`}
                target="_blank"
                rel="noreferrer"
                className="desk-external"
              >
                View full wallet <ArrowUpRight size={13} />
              </a>
            </div>
            <div className="balance-grid">
              <div>
                <span>ETH · GAS BALANCE</span>
                <strong>
                  {n(query.data.nativeBalance, 6)} <small>ETH</small>
                </strong>
              </div>
              <div>
                <span>USDG · SETTLEMENT ASSET</span>
                <strong>
                  {n(
                    query.data.tokens.find((t) => t.symbol === "USDG")?.balance,
                    2,
                  )}{" "}
                  <small>USDG</small>
                </strong>
              </div>
            </div>
            <div className="route-table-scroll">
              <table className="wallet-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Token balance</th>
                    <th>Contract</th>
                    <th>Exit planning</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.tokens.map((t) => (
                    <tr key={t.address}>
                      <td>
                        <strong className="stock-identity"><StockLogo symbol={t.symbol} size={28}/>{t.symbol}</strong>
                        <span>
                          {t.symbol === "USDG"
                            ? "Settlement asset"
                            : "Stock Token"}
                        </span>
                      </td>
                      <td>
                        {t.balance === null ? (
                          <span className="accent">Read failed</span>
                        ) : (
                          n(t.balance, 6)
                        )}
                      </td>
                      <td>
                        <a
                          href={`${EXPLORER}/address/${t.address}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddress(t.address)} <ArrowUpRight size={12} />
                        </a>
                      </td>
                      <td>{t.symbol !== "USDG" && <button className="planner-portfolio-action" disabled={t.balance === null || Number(t.balance) <= 0} onClick={() => onPlan(t.symbol, t.balance ?? undefined)} aria-label={`Plan an exit for your ${t.symbol} balance`}>Compare exit sizes <ArrowUpRight size={13}/></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="panel-note">
              Balances cover USDG and tracked tokens (
              {TRACKED_SYMBOLS.join(", ")}), not every asset in the wallet.
              Quantities are token units, not underlying share equivalents.
            </p>
            <div className="pool-source">
              <span>Block {n(query.data.blockNumber, 0)}</span>
              <button
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
              >
                <RefreshCw
                  size={12}
                  className={query.isFetching ? "spin" : ""}
                />
                Refresh balances
              </button>
            </div>
          </div>
        )
      )}
    </>
  );
}
function ActivityView({ now, onArbitrage }: { now: number; onArbitrage: () => void }) {
  const actions = useQuery({
    queryKey: ["corporate-actions"],
    queryFn: ({ signal }) =>
      getData<CorporateActions>("corporate-actions", signal),
    staleTime: 3600000,
  });
  return (
    <div className="research-activity">
      <ResearchHistoryChart now={now} onOpen={onArbitrage}/>
      <ResearchJournal now={now}/>
      <div className="desk-panel">
        <div className="desk-panel-heading">
          <h2>Stock Token corporate actions</h2>
          <span>Robinhood API</span>
        </div>
        <ErrorBox error={actions.error} retry={() => void actions.refetch()} />
        {actions.data?.dataStatus && <p className="panel-note">Cached corporate actions · fetched {ageLabel(actions.data.fetchedAt, now)}. The source is reconnecting.</p>}
        {actions.isPending ? (
          <SkeletonRows />
        ) : actions.data?.items.length ? (
          <div className="corporate-list">
            {actions.data.items.slice(0, 12).map((a, i) => (
              <div key={`${a.symbol}-${a.date}-${i}`}>
                <span>{a.symbol}</span>
                <div>
                  <strong>{a.type.replaceAll("_", " ").toLowerCase()}</strong>
                  <small>{a.status.replaceAll("_", " ").toLowerCase()}</small>
                </div>
                <time>{a.date ?? "Date pending"}</time>
              </div>
            ))}
          </div>
        ) : (
          !actions.error && (
            <Empty title="No actions returned.">
              The source returned no recent corporate actions on Robinhood
              Chain.
            </Empty>
          )
        )}
      </div>
    </div>
  );
}
function Infrastructure({ network, networkCurrent }: { network: NetworkState | undefined; networkCurrent: boolean }) {
  return (
    <div className="infrastructure-layout">
      <div className="desk-panel">
        <div className="desk-panel-heading">
          <h2>Market data sources</h2>
          <span>Read-only connections</span>
        </div>
        <div className="source-list">
          {[
            {
              name: "Robinhood Chain",
              detail: `Chain ${CHAIN_ID} · ETH gas`,
              status: networkCurrent ? "RPC responding" : network ? "Last chain snapshot" : "RPC reconnecting",
              url: "https://docs.robinhood.com/chain/connecting/",
            },
            {
              name: "Official asset registry",
              detail: "Canonical contracts and corporate-action multipliers",
              status: "Live REST integration",
              url: "https://docs.robinhood.com/chain/stock-token-apis/",
            },
            {
              name: "Uniswap V3",
              detail: "Factory discovery and QuoterV2 simulation",
              status: "4 supported fee tiers",
              url: "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments",
            },
          ].map((source) => (
            <div key={source.name}>
              <span className="source-icon">
                <Server size={18} />
              </span>
              <div>
                <strong>{source.name}</strong>
                <p>{source.detail}</p>
                <span>{source.status}</span>
              </div>
              <a
                aria-label={`Read ${source.name} documentation`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                <ArrowUpRight size={17} />
              </a>
            </div>
          ))}
        </div>
        <div className="contract-list">
          {[
            ["USDG", USDG],
            ["V3 factory", V3_FACTORY],
            ["QuoterV2", V3_QUOTER],
          ].map(([name, address]) => (
            <div key={name}>
              <span>{name}</span>
              <CopyAddress value={address} />
              <a
                href={`${EXPLORER}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`View ${name} contract`}
              >
                <ExternalLink size={13} />
              </a>
            </div>
          ))}
        </div>
      </div>
      <div className="desk-panel production-panel">
        <div className="desk-panel-heading">
          <h2>What the numbers mean</h2>
          <span className="data-tag warning">
            <i />
            Research mode
          </span>
        </div>
        <div className="production-items">
          <div><span>01</span><div><h3>Reference is context</h3><p>Issuer bid and ask are shown in USD, adjusted by the Stock Token’s multiplier. Every observation retains the issuer’s timestamp, including when a cached read is displayed.</p></div></div>
          <div><span>02</span><div><h3>A pool price is a snapshot</h3><p>USDG prices come from Uniswap V3 pool state at one chain block. They describe the pool before your trade. Trade size, swap fees and price impact change what you receive.</p></div></div>
          <div><span>03</span><div><h3>A route quote goes further</h3><p>Both swaps are simulated at the same block through different pools. Gross surplus includes swap fees and price impact, but still excludes executor fees and full transaction gas. Quotes expire after 20 seconds.</p></div></div>
        </div>
        <p className="panel-note">
          Current release: live market reads, wallet balances and V3 route
          quotes. One-way wallet swaps are available in Markets & trading; automated round trips are not enabled.
        </p>
      </div>
    </div>
  );
}
function Workspace() {
  const wallet = useWallet();
  const [view, setView] = useState<View>("terminal");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [symbol, setSymbol] = useState("NVDA");
  const [inspectedQuote, setInspectedQuote] = useState<QuoteBook>();
  const [plannerSeed, setPlannerSeed] = useState<{ id: number; symbol: string; amount?: string; walletContext: string }>();
  const walletContext = wallet.demoWallet ? `demo:${wallet.demoWallet.id}` : wallet.account ?? "guest";
  const now = useClock();
  useEffect(() => {
    const sync = () => {
      const v = new URLSearchParams(window.location.search).get("view");
      if (views.some((item) => item.id === v)) setView(v as View);
      else setView("terminal");
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function navigate(next: View) {
    if (next === view) return;
    setView(next);
    window.history.pushState(
      {},
      "",
      next === "terminal" ? "/app" : `/app?view=${next}`,
    );
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: ({ signal }) => getData<Catalog>("catalog", signal),
    staleTime: 300000,
    refetchInterval: (q) => pollingInterval(300000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt),
  });
  const network = useQuery({
    queryKey: ["network"],
    queryFn: ({ signal }) => getData<NetworkState>("network", signal),
    staleTime: 30000,
    refetchInterval: (q) => pollingInterval(30000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt),
  });
  const assets = catalog.data?.assets ?? [];
  const active = assets.filter((a) => a.active);
  const sorted = [...active].sort((a, b) => {
    const ia = TRACKED_SYMBOLS.indexOf(a.symbol),
      ib = TRACKED_SYMBOLS.indexOf(b.symbol);
    return (
      (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) ||
      a.symbol.localeCompare(b.symbol)
    );
  });
  const filtered = sorted.filter((a) =>
    `${a.symbol} ${a.name} ${a.address}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const visible = filtered.slice(page * 12, page * 12 + 12);
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const priceSymbols = [...new Set([...(view === "terminal" ? TRACKED_SYMBOLS : visible.map((asset) => asset.symbol)), symbol])].sort().join(",");
  const prices = useQuery({
    queryKey: ["prices", priceSymbols],
    queryFn: async ({ signal }) => {
      const book = await getData<PriceBook>(`prices?symbols=${encodeURIComponent(priceSymbols)}`, signal);
      if (!catalog.data?.dataStatus) recordPrices(book, assets);
      return book;
    },
    enabled: assets.length > 0 && (view === "terminal" || view === "markets" || view === "portfolio"),
    staleTime: 60000,
    refetchInterval: (q) => (view === "markets" || view === "terminal") ? pollingInterval(60000, q.state.error, q.state.fetchFailureCount, q.state.data?.dataStatus?.retryAt) : false,
  });
  const reads = [
    { name: "Registry", query: catalog },
    { name: "Reference prices", query: prices },
    { name: "Chain", query: network },
  ];
  const refreshWait = Math.max(0, ...reads.map(({ query }) => {
    const deadline = query.error instanceof DataError ? query.error.retryAt : query.data?.dataStatus ? Date.parse(query.data.dataStatus.retryAt) : 0;
    return Math.ceil((deadline - now) / 1000);
  }));
  const priceMap = new Map(prices.data?.quotes.map((q) => [q.symbol, q]) ?? []);
  const chainStale =
    !network.data ||
    network.isError ||
    !!network.data?.dataStatus ||
    now - Date.parse(network.data.blockTimestamp) > 90000;
  function analyze(next: string, observed?: QuoteBook) {
    setInspectedQuote(observed);
    setSymbol(next);
    navigate("routes");
  }
  function planPosition(next: string, amount?: string) {
    setSymbol(next);
    setPlannerSeed({ id: Date.now(), symbol: next, amount, walletContext });
    navigate("planner");
  }
  const titles: Record<View, { title: string; description: string }> = {
    terminal: { title: "Your market. Your next move.", description: "Robinhood Stock Tokens, issuer insights and wallet trading." },
    planner: { title: "Position & exit planner", description: "See how trade size changes what you could receive." },
    lending: { title: "Put your assets to work.", description: "Explore real rates. Deposit, earn and manage your Morpho positions on Robinhood Chain." },
    desk: { title: "A shared edge.", description: "Follow the markets, see the strategy, and share in realized trading surplus." },
    rewards: { title: "A share in every fee.", description: "75% of collected creator fees, shared with token holders every 15 minutes." },
    check: {
      title: "An eye on every route.",
      description: "Follow live round-trip quotes. Compare pools. Watch the edge change.",
    },
    markets: {
      title: "The market observatory.",
      description:
        "Official Stock Tokens. Real pool liquidity. The information behind a trade.",
    },
    routes: {
      title: "Understand the round trip.",
      description:
        "Compare actual quotes across different pools, at a single Robinhood Chain block.",
    },
    portfolio: {
      title: "Your onchain balance sheet.",
      description: "Read what a wallet holds. No deposits or token approvals.",
    },
    activity: {
      title: "Every read has a reference.",
      description:
        "Your saved quote observations, source failures and issuer corporate actions.",
    },
    infrastructure: {
      title: "Know your sources.",
      description: "The connections, contracts and data behind each observation.",
    },
    learn: {
      title: "The difference is in the return.",
      description: "Explore the idea behind Spreadline, then test the economics yourself.",
    },
  };
  return (
    <div className="desk" data-view={view}>
      <a href="#desk-main" className="skip-link">
        Skip to workspace
      </a>
      <aside className="desk-sidebar">
        <Link className="wordmark" href="/">
          spreadline
        </Link>
        <span className="desk-workspace-label">MARKET WORKSPACE</span>
        <nav aria-label="Workspace">
          {views.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "selected" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="desk-sidebar-art" aria-hidden="true">
          <img src="/artwork/hero-engraving.webp" alt="" />
          <span>FIND THE EDGE.<br />FOLLOW IT THROUGH.</span>
        </div>
        <div className="desk-sidebar-bottom">
          <PwaInstallButton/>
          <ShieldCheck size={19} />
          <p>
            Robinhood Chain
            <br />
            <span>Mainnet · {CHAIN_ID}</span>
          </p>
          <Link href="/">
            About Spreadline <ArrowUpRight size={15} />
          </Link>
        </div>
      </aside>
      <div className="desk-work">
        <header className="desk-header">
          <Link href="/app" className="app-mobile-wordmark" aria-label="Spreadline markets">spreadline</Link>
          <span>
            Workspace <span>/</span>
            {views.find((v) => v.id === view)?.label}
          </span>
          <div className="desk-header-actions">
            <span className={`desk-status ${chainStale ? "unavailable" : ""}`}>
              <i />
              {network.isPending
                ? "Connecting"
                : chainStale
                  ? network.data ? "Last chain snapshot" : "Chain reconnecting"
                  : "Mainnet connected"}
            </span>
            <WalletButton wallet={wallet} />
          </div>
        </header>
        <main className="desk-main" id="desk-main">
          <ConnectionNotice/>
          <DemoWalletNotice wallet={wallet}/>
          <div className="desk-page-heading">
            <div>
              <span className="eyebrow">SPREADLINE / STOCK TOKEN DESK</span>
              <h1 className="display">{titles[view].title}</h1>
              <p>{titles[view].description}</p>
            </div>
            {view === "markets" && <button
              className="refresh-data"
              aria-label="Refresh live data"
              disabled={
                network.isFetching || catalog.isFetching || prices.isFetching || refreshWait > 0
              }
              onClick={() => {
                void network.refetch();
                void catalog.refetch();
                void prices.refetch();
              }}
            >
              <RefreshCw
                size={16}
                className={network.isFetching ? "spin" : ""}
              />
              <span>{refreshWait > 0 ? `Resumes in ${refreshWait}s` : "Refresh"}</span>
            </button>}
          </div>
          {view === "terminal" && <><div className="planner-launch"><p>Planning a position? Compare entry or exit costs at three sizes.</p><button onClick={() => planPosition(symbol)}>Open position planner <ArrowRight size={16}/></button></div><MarketTerminal assets={sorted} book={prices.data} network={network.data} symbol={symbol} onSelect={setSymbol} now={now} wallet={wallet} registryCached={!!catalog.data?.dataStatus} priceError={prices.error?.message ?? null}/></>}
          {view === "planner" && <PositionPlanner key={`${plannerSeed?.id ?? "manual"}:${walletContext}`} assets={sorted} symbol={symbol} onSelect={setSymbol} wallet={wallet} now={now} registryReady={!!catalog.data && !catalog.data.dataStatus} registryError={catalog.error?.message ?? catalog.data?.dataStatus?.reason ?? null} initialAmount={plannerSeed?.symbol === symbol && plannerSeed.walletContext === walletContext ? plannerSeed.amount : undefined}/>}
          {view === "lending" && <Lending assets={assets} now={now} wallet={wallet}/>}
          {view === "desk" && <StrategyDesk assets={sorted} now={now} wallet={wallet} onAnalyze={analyze} registryError={catalog.error?.message ?? catalog.data?.dataStatus?.reason ?? null}/>}
          {view === "rewards" && <TokenRewards wallet={wallet} now={now}/>}
          {view === "check" && <OpportunityCheck assets={assets} registryReady={!!catalog.data && !catalog.data.dataStatus} registryError={catalog.error?.message ?? catalog.data?.dataStatus?.reason ?? null} now={now} onInspect={analyze} onLearn={() => navigate("learn")}/>}
          {view === "markets" && (
            <>
              <div className="observatory-intro">
                <div>
                  <span className="eyebrow">ONE ASSET. DIFFERENT POOLS.</span>
                  <h2 className="display">A price gap is only<br /><em>the beginning.</em></h2>
                  <p>Follow a Stock Token across pools. Compare the complete USDG round trip. See what remains after the costs.</p>
                  <button className="text-link" onClick={() => navigate("routes")}>Explore a route <ArrowUpRight size={15} /></button>
                </div>
                <img src="/artwork/execution.webp" alt="Engraved paths passing through a precision gate, illustrating a complete trading route" />
              </div>
              <div className="desk-metrics">
                <div>
                  <span>ACTIVE STOCK TOKENS</span>
                  <strong>
                    {catalog.data ? n(active.length, 0) : "—"}
                    <small>in the official registry</small>
                  </strong>
                </div>
                <div>
                  <span>LAST OBSERVED BLOCK</span>
                  <strong>
                    {network.data ? n(network.data.blockNumber, 0) : "—"}
                    <small>
                      {network.data
                        ? ageLabel(network.data.blockTimestamp, now)
                        : "Waiting for RPC"}
                    </small>
                  </strong>
                </div>
                <div>
                  <span>OBSERVED GAS PRICE</span>
                  <strong>
                    {network.data
                      ? n(Number(network.data.gasPriceWei) / 1e9, 5)
                      : "—"}
                    <small>gwei · not full transaction cost</small>
                  </strong>
                </div>
                <div>
                  <span>WORKSPACE MODE</span>
                  <strong className="metric-status">
                    Research<small>Live reads · simulated routes</small>
                  </strong>
                </div>
              </div>
              <div className="source-health" role="status">
                <span className="source-health-label">DATA PULSE</span>
                {reads.map(({ name, query }) => <span key={name}><i className={query.isError || query.data?.dataStatus ? "cooling" : query.data ? "ready" : "pending"}/>{name}<small>{query.data?.dataStatus ? "Cached" : query.isError ? "Reconnecting" : query.data ? "Responding" : "Connecting"}</small></span>)}
              </div>
              {reads.some(({ query }) => query.error || query.data?.dataStatus) && <div className="source-recovery"><Clock3 size={16}/><p>{reads.some(({ query }) => query.data) ? "Keeping the last successful observations visible while the provider recovers." : "Connecting to the market sources. The strategy model is ready to explore below."} Updates resume automatically{refreshWait > 0 ? ` in ${refreshWait}s` : ""}.</p></div>}
              {!!prices.data?.unavailableSymbols?.length && <p className="partial-prices">Awaiting issuer quotes for {prices.data.unavailableSymbols.join(", ")}. Available quotes are shown below.</p>}
              {!!prices.data?.cachedSymbols?.length && <p className="partial-prices">Last available observations retained for {prices.data.cachedSymbols.join(", ")}. Original issuer timestamps are shown.</p>}
              <div className="market-visuals">
                <ReferenceChart symbol={symbol} assets={sorted} book={prices.data} now={now} onSelect={setSymbol} registryCached={!!catalog.data?.dataStatus}/>
                <div className="market-reading-card"><span className="eyebrow">READ BETWEEN THE PRICES</span><h2 className="display">One token.<br/><em>More than one price.</em></h2><p>The issuer’s USD reference tells you about the underlying exposure. A pool’s USDG price tells you about its liquidity.</p><img src="/artwork/hero-engraving.webp" alt=""/><button className="text-link" onClick={() => navigate("learn")}>How Spreadline connects them <ArrowUpRight size={14}/></button></div>
              </div>
              <div className="market-workspace">
                <div className="desk-panel markets-panel">
                  <div className="desk-panel-heading">
                    <div>
                      <h2>Stock Token markets</h2>
                      <p>
                        Issuer reference quotes, adjusted by each token’s
                        multiplier.
                      </p>
                    </div>
                    <span className="data-tag">
                      <ShieldCheck size={12} />
                      Canonical assets
                    </span>
                  </div>
                  <div className="market-toolbar">
                    <label className="market-search">
                      <Search size={15} />
                      <input
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(0);
                        }}
                        placeholder="Search symbol, company or contract"
                        aria-label="Search Stock Tokens"
                      />
                      {search && (
                        <button
                          aria-label="Clear search"
                          onClick={() => {
                            setSearch("");
                            setPage(0);
                          }}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </label>
                    <span>
                      {catalog.data
                        ? `${filtered.length} assets`
                        : "Loading registry"}
                    </span>
                  </div>

                  {catalog.isPending ? (
                    <SkeletonRows />
                  ) : visible.length ? (
                    <div className="market-table-scroll">
                      <table className="market-table">
                        <thead>
                          <tr>
                            <th>Stock Token</th>
                            <th>Reference bid / ask</th>
                            <th>Multiplier</th>
                            <th>Quote age</th>
                            <th>
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((asset) => {
                            const q = priceMap.get(asset.symbol);
                            const stale =
                              !!q && (!!catalog.data?.dataStatus || !!prices.data?.dataStatus || !!prices.data?.cachedSymbols?.includes(asset.symbol) || now - Date.parse(q.generatedAt) > 90000);
                            return (
                              <tr
                                key={asset.address}
                                className={
                                  symbol === asset.symbol ? "row-selected" : ""
                                }
                              >
                                <td>
                                  <button
                                    className="stock-name"
                                    onClick={() => setSymbol(asset.symbol)}
                                  >
                                    <StockLogo symbol={asset.symbol} />
                                    <span>
                                      <strong>
                                        {asset.symbol}
                                        <span
                                          className="verified-stock"
                                          title="Official registry"
                                        >
                                          <Check size={9} />
                                        </span>
                                      </strong>
                                      <small>{asset.name}</small>
                                    </span>
                                  </button>
                                </td>
                                <td>
                                  <strong>
                                    {q && !q.halted
                                      ? `$${n(Number(q.bid) * Number(asset.multiplier))}`
                                      : "—"}
                                    <span> / </span>
                                    {q && !q.halted
                                      ? `$${n(Number(q.ask) * Number(asset.multiplier))}`
                                      : ""}
                                  </strong>
                                  <small>
                                    {q?.halted
                                      ? "Underlying trading halted"
                                      : catalog.data?.dataStatus ? "Cached multiplier · reference only" : "USD per token · reference only"}
                                  </small>
                                </td>
                                <td>
                                  <span className="multiplier-value">
                                    {n(asset.multiplier, 6)}
                                    <small>×</small>
                                  </span>
                                </td>
                                <td>
                                  <span
                                    className={`quote-age ${stale || prices.isError ? "stale" : ""}`}
                                  >
                                    {q
                                      ? ageLabel(q.generatedAt, now)
                                      : "Awaiting quote"}
                                  </span>
                                  {stale && <small>Last available quote</small>}
                                </td>
                                <td>
                                  <button
                                    className="analyze-row"
                                    aria-label={`Analyze ${asset.symbol} routes`}
                                    onClick={() => analyze(asset.symbol)}
                                  >
                                    <ArrowUpRight size={16} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty title={catalog.error ? "The registry is reconnecting." : "No matching Stock Tokens."}>
                      {catalog.error ? "Official tokens will return here when the source responds. You can explore the strategy model while you wait." : "Try another symbol, company name or contract address."}
                    </Empty>
                  )}
                  <div className="market-pagination">
                    <span>
                      {filtered.length
                        ? `${page * 12 + 1}–${Math.min((page + 1) * 12, filtered.length)} of ${filtered.length}`
                        : "0 results"}
                    </span>
                    <div>
                      <button
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                        aria-label="Previous assets"
                      >
                        <ChevronLeft size={15} />
                      </button>
                      <span>
                        {page + 1} / {pages}
                      </span>
                      <button
                        disabled={page + 1 >= pages}
                        onClick={() => setPage((p) => p + 1)}
                        aria-label="Next assets"
                      >
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </div>
                  <p className="panel-note">
                    Reference prices are not DEX quotes. They use Robinhood’s
                    underlying bid/ask × currentMultiplier. USD and USDG are
                    shown separately; no peg or executable spread is assumed.
                  </p>
                </div>
                <div className="market-side">
                  <PoolPanel
                    symbol={symbol}
                    now={now}
                    onAnalyze={() => navigate("routes")}
                  />
                  <div className="desk-insight">
                    <span className="eyebrow">
                      A PRICE GAP IS A STARTING POINT
                    </span>
                    <h3 className="display">
                      The return
                      <br />
                      <em>has to survive the route.</em>
                    </h3>
                    <p>
                      Compare complete swaps at your size. Pool fees, price
                      impact and transaction costs decide what remains.
                    </p>
                    <button
                      className="text-link"
                      onClick={() => navigate("routes")}
                    >
                      Open route analysis <ArrowUpRight size={15} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
          {view === "learn" && <><ProductGuide onAnalyze={() => navigate("routes")}/><StrategyLab/></>}
          {view === "routes" && (
            <RouteAnalysis
              key={inspectedQuote ? `${inspectedQuote.symbol}-${inspectedQuote.blockHash}-${inspectedQuote.amountIn}` : "manual"}
              initialQuote={inspectedQuote}
              assets={assets}
              symbol={symbol}
              setSymbol={setSymbol}
              now={now}
              onQuote={(q) => saveObservation({ id: crypto.randomUUID(), symbol: q.symbol, amount: q.amountIn, quote: q, checkedAt: new Date().toISOString(), assumedCost: null })}
              onInfrastructure={() => navigate("infrastructure")}
            />
          )}
          {view === "portfolio" && <PortfolioView key={walletContext} wallet={wallet} onPlan={planPosition} />}
          {view === "activity" && <ActivityView now={now} onArbitrage={() => navigate("check")} />}
          {view === "infrastructure" && (
            <Infrastructure network={network.data} networkCurrent={!chainStale} />
          )}
          <footer className="desk-footer">
            <span>
              <span
                className={`connection-dot ${chainStale ? "offline" : ""}`}
              />
              {chainStale
                ? "Waiting for fresh chain data"
                : `Robinhood Chain · ${n(network.data?.blockNumber, 0)}`}
            </span>
            <div>
              <span>{view === "rewards" ? "Token rewards · automatic wallet payouts" : view === "desk" ? "Vault strategy · USDG settlement" : "Live data · no automated execution"}</span>
              <a
                href="https://docs.robinhood.com/chain/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Network docs <ArrowUpRight size={11} />
              </a>
              <a
                href="https://x.com/spreadonrh"
                target="_blank"
                rel="noopener noreferrer"
              >
                X <ArrowUpRight size={11} />
              </a>
              <a
                href="https://github.com/spreadline-finance/dapp"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub <ArrowUpRight size={11} />
              </a>
            </div>
          </footer>
        </main>
      </div>
      <MobileNavigation view={view} onNavigate={navigate}/>
    </div>
  );
}
export function Dapp() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            gcTime: 30 * 60 * 1000,
            refetchIntervalInBackground: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace />
    </QueryClientProvider>
  );
}
