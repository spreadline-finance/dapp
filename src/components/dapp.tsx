"use client";
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
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
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useWallet, WalletButton, type WalletState } from "./wallet";
import {
  getData,
  DataError,
  displayNumber as n,
  shortAddress,
  ageLabel,
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
import "./dapp.css";
type View = "markets" | "routes" | "portfolio" | "activity" | "infrastructure";
const views = [
  { id: "markets", label: "Markets", icon: ChartNoAxesCombined },
  { id: "routes", label: "Route analysis", icon: Layers3 },
  { id: "portfolio", label: "Portfolio", icon: Wallet },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "infrastructure", label: "Infrastructure", icon: Server },
] as const;
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
  return error ? (
    <div className="desk-error" role="alert">
      <CircleHelp size={17} />
      <p>{error.message}</p>
      {retry && (
        <button onClick={retry}>
          Retry <RefreshCw size={13} />
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
function AssetIcon({ asset }: { asset: StockAsset }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="stock-icon">
      {asset.logo && !failed ? (
        <img
          src={asset.logo}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        asset.symbol.slice(0, 1)
      )}
    </span>
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
    refetchInterval: 20000,
    staleTime: 10000,
  });
  const data = query.data;
  const stale = !!data && now - Date.parse(data.blockTimestamp) > 30000;
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
}: {
  assets: StockAsset[];
  symbol: string;
  setSymbol: (v: string) => void;
  now: number;
  onQuote: (q: QuoteBook) => void;
  onInfrastructure: () => void;
}) {
  const [amount, setAmount] = useState("1000");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const quote = useMutation({
    mutationFn: async () => {
      controller.current?.abort();
      controller.current = new AbortController();
      return getData<QuoteBook>(
        `quote?symbol=${encodeURIComponent(symbol)}&amount=${encodeURIComponent(amount)}`,
        controller.current.signal,
      );
    },
    onSuccess: onQuote,
  });
  const data = quote.data;
  const expired = !!data && now >= Date.parse(data.expiresAt);
  const selected = assets.find((a) => a.symbol === symbol);
  const best = data?.routes[0];
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
              {selected && <AssetIcon asset={selected} />}
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
              disabled={quote.isPending || !amountValid || !selected}
              onClick={() => quote.mutate()}
            >
              {quote.isPending ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  Reading onchain quotes…
                </>
              ) : (
                <>
                  Get live route quotes <ArrowUpRight size={16} />
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
            <div className={`quote-result-card ${expired ? "expired" : ""}`}>
              <div>
                <span className="eyebrow">
                  {best ? "BEST QUOTED GROSS SURPLUS" : "ROUTE AVAILABILITY"}
                </span>
                <span className={`data-tag ${expired ? "warning" : ""}`}>
                  <i />
                  {expired
                    ? "Quote expired"
                    : `Expires in ${Math.max(0, Math.ceil((Date.parse(data.expiresAt) - now) / 1000))}s`}
                </span>
              </div>
              <strong
                className={
                  best && Number(best.surplus) > 0
                    ? "quote-positive"
                    : "quote-negative"
                }
              >
                {best
                  ? `${Number(best.surplus) > 0 ? "+" : ""}${n(best.surplus, 6)}`
                  : "No quote available"}
                {best && <small> USDG</small>}
              </strong>
              <p>
                {best
                  ? Number(best.surplus) > 0
                    ? "Positive before executor fees and transaction gas. This does not establish a profitable executable trade."
                    : "The best quoted route returns less than the starting amount, even before executor fees and transaction gas."
                  : "Fewer than two active pools or all attempted paths failed to quote. No opportunity has been inferred."}
              </p>
              <div className="quote-result-stats">
                <div>
                  <span>Starting amount</span>
                  <strong>{n(data.amountIn, 2)} USDG</strong>
                </div>
                <div>
                  <span>Best quoted return</span>
                  <strong>{best ? `${n(best.amountOut, 6)} USDG` : "—"}</strong>
                </div>
                <div>
                  <span>Executor fees + full gas</span>
                  <strong>Not available</strong>
                </div>
              </div>
              <div className="result-source">
                <a
                  href={`${EXPLORER}/block/${data.blockNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Block {n(data.blockNumber, 0)} <ArrowUpRight size={12} />
                </a>
                <span>{ageLabel(data.blockTimestamp, now)}</span>
              </div>
            </div>
            {expired && (
              <div className="desk-notice">
                <Clock3 size={17} />
                <span>
                  This quote has expired. Refresh before making a decision.
                </span>
                <button onClick={() => quote.mutate()}>Requote</button>
              </div>
            )}
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
            <strong>Live execution is not enabled</strong>
          </div>
          <p>
            No Spreadline executor is deployed/configured in this application.
            No funds can be deposited or traded through it.
          </p>
          <button className="text-link" onClick={onInfrastructure}>
            View the execution dependencies <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
function PortfolioView({ wallet }: { wallet: WalletState }) {
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
    enabled: !!address,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const formValid = /^0x[a-fA-F0-9]{40}$/.test(input);
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
                  </tr>
                </thead>
                <tbody>
                  {query.data.tokens.map((t) => (
                    <tr key={t.address}>
                      <td>
                        <strong>{t.symbol}</strong>
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
function ActivityView({ history, now }: { history: QuoteBook[]; now: number }) {
  const actions = useQuery({
    queryKey: ["corporate-actions"],
    queryFn: ({ signal }) =>
      getData<CorporateActions>("corporate-actions", signal),
    staleTime: 3600000,
  });
  return (
    <div className="activity-layout">
      <div className="desk-panel">
        <div className="desk-panel-heading">
          <h2>This session’s quotes</h2>
          <span>Read-only requests</span>
        </div>
        {history.length ? (
          <div className="quote-history">
            {history.map((q, i) => (
              <div key={`${q.blockNumber}-${i}`}>
                <span className="history-icon">
                  <Layers3 size={18} />
                </span>
                <div>
                  <strong>
                    {q.symbol} · {n(q.amountIn, 0)} USDG
                  </strong>
                  <span>
                    {q.routes.length} routes quoted ·{" "}
                    {ageLabel(q.fetchedAt, now)}
                  </span>
                </div>
                <a
                  href={`${EXPLORER}/block/${q.blockNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Block {n(q.blockNumber, 0)} <ArrowUpRight size={12} />
                </a>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No quote requests yet.">
            Run a route analysis to see its real block reference here. This
            session log is not a trading history.
          </Empty>
        )}
        <div className="panel-note">
          Transaction history is unavailable until a Spreadline executor is
          deployed. No trades have been submitted by this interface.
        </div>
      </div>
      <div className="desk-panel">
        <div className="desk-panel-heading">
          <h2>Stock Token corporate actions</h2>
          <span>Robinhood API</span>
        </div>
        <ErrorBox error={actions.error} retry={() => void actions.refetch()} />
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
function Infrastructure({ network }: { network: NetworkState | undefined }) {
  return (
    <div className="infrastructure-layout">
      <div className="desk-panel">
        <div className="desk-panel-heading">
          <h2>Connected infrastructure</h2>
          <span>Verified sources</span>
        </div>
        <div className="source-list">
          {[
            {
              name: "Robinhood Chain",
              detail: `Chain ${CHAIN_ID} · ETH gas`,
              status: network ? "RPC responding" : "RPC unavailable",
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
          <h2>Before live execution</h2>
          <span className="data-tag warning">
            <i />
            Not enabled
          </span>
        </div>
        <div className="production-items">
          <div>
            <span>01</span>
            <div>
              <h3>Deploy and verify the executor</h3>
              <p>
                The application has no execution contract, token allowances or
                spending permissions. Contract deployment, testing and
                independent security review are still required.
              </p>
            </div>
          </div>
          <div>
            <span>02</span>
            <div>
              <h3>Configure production RPC capacity</h3>
              <p>
                {network?.provider === "dedicated"
                  ? "A dedicated RPC endpoint is configured. Its capacity and operational monitoring still need to match launch traffic."
                  : "This deployment uses the public RPC. Robinhood explicitly recommends dedicated infrastructure for production traffic."}
              </p>
            </div>
          </div>
          <div>
            <span>03</span>
            <div>
              <h3>Operate the execution service</h3>
              <p>
                Continuous route monitoring, inclusion handling, transaction
                simulation, gas accounting and execution records need an
                operating service. A page showing quotes does not perform that
                work.
              </p>
            </div>
          </div>
        </div>
        <p className="panel-note">
          Current release: live market reads, wallet balances and V3 route
          quotes. No deposits, approvals, token launch or automated trading.
        </p>
      </div>
    </div>
  );
}
function Workspace() {
  const wallet = useWallet();
  const [view, setView] = useState<View>("markets");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [symbol, setSymbol] = useState("NVDA");
  const [history, setHistory] = useState<QuoteBook[]>([]);
  const now = useClock();
  useEffect(() => {
    const sync = () => {
      const v = new URLSearchParams(window.location.search).get("view");
      if (views.some((item) => item.id === v)) setView(v as View);
      else setView("markets");
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function navigate(next: View) {
    setView(next);
    window.history.pushState(
      {},
      "",
      next === "markets" ? "/app" : `/app?view=${next}`,
    );
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: ({ signal }) => getData<Catalog>("catalog", signal),
    staleTime: 300000,
    refetchInterval: 300000,
  });
  const prices = useQuery({
    queryKey: ["prices"],
    queryFn: ({ signal }) => getData<PriceBook>("prices", signal),
    staleTime: 15000,
    refetchInterval: view === "markets" ? 30000 : false,
  });
  const network = useQuery({
    queryKey: ["network"],
    queryFn: ({ signal }) => getData<NetworkState>("network", signal),
    staleTime: 5000,
    refetchInterval: 10000,
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
  const priceMap = new Map(prices.data?.quotes.map((q) => [q.symbol, q]) ?? []);
  const chainStale =
    !network.data ||
    network.isError ||
    now - Date.parse(network.data.blockTimestamp) > 30000;
  function analyze(next: string) {
    setSymbol(next);
    navigate("routes");
  }
  const titles: Record<View, { title: string; description: string }> = {
    markets: {
      title: "The execution desk.",
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
        "Session quote records and corporate actions from the issuer.",
    },
    infrastructure: {
      title: "Know what is connected.",
      description:
        "Live integrations, canonical contracts and the remaining execution dependencies.",
    },
  };
  return (
    <div className="desk">
      <a href="#desk-main" className="skip-link">
        Skip to workspace
      </a>
      <aside className="desk-sidebar">
        <Link className="wordmark" href="/">
          spreadline
        </Link>
        <span className="desk-workspace-label">EXECUTION WORKSPACE</span>
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
        <div className="desk-sidebar-bottom">
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
                  ? "Chain data unavailable"
                  : "Mainnet connected"}
            </span>
            <WalletButton wallet={wallet} />
          </div>
        </header>
        <main className="desk-main" id="desk-main">
          <div className="desk-page-heading">
            <div>
              <span className="eyebrow">ROBINHOOD CHAIN / LIVE DATA</span>
              <h1 className="display">{titles[view].title}</h1>
              <p>{titles[view].description}</p>
            </div>
            <button
              className="refresh-data"
              aria-label="Refresh live data"
              disabled={
                network.isFetching || catalog.isFetching || prices.isFetching
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
              <span>Refresh</span>
            </button>
          </div>
          {view === "markets" && (
            <>
              <div className="desk-metrics">
                <div>
                  <span>ACTIVE STOCK TOKENS</span>
                  <strong>
                    {catalog.data ? n(active.length, 0) : "—"}
                    <small>in the official registry</small>
                  </strong>
                </div>
                <div>
                  <span>LATEST CHAIN BLOCK</span>
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
                  <span>CURRENT GAS PRICE</span>
                  <strong>
                    {network.data
                      ? n(Number(network.data.gasPriceWei) / 1e9, 5)
                      : "—"}
                    <small>gwei · not full transaction cost</small>
                  </strong>
                </div>
                <div>
                  <span>SPREADLINE EXECUTION</span>
                  <strong className="metric-status">
                    Not enabled<small>No executor configured</small>
                  </strong>
                </div>
              </div>
              <ErrorBox
                error={network.error}
                retry={() => void network.refetch()}
              />
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
                  <ErrorBox
                    error={catalog.error}
                    retry={() => void catalog.refetch()}
                  />
                  <ErrorBox
                    error={prices.error}
                    retry={() => void prices.refetch()}
                  />
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
                              !!q && now - Date.parse(q.generatedAt) > 90000;
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
                                    <AssetIcon asset={asset} />
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
                                      : "USD per token · reference only"}
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
                                      : "Unavailable"}
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
                    !catalog.error && (
                      <Empty title="No matching Stock Tokens.">
                        Try another symbol, company name or contract address.
                      </Empty>
                    )
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
          {view === "routes" && (
            <RouteAnalysis
              assets={assets}
              symbol={symbol}
              setSymbol={setSymbol}
              now={now}
              onQuote={(q) =>
                setHistory((current) => [q, ...current].slice(0, 20))
              }
              onInfrastructure={() => navigate("infrastructure")}
            />
          )}
          {view === "portfolio" && <PortfolioView wallet={wallet} />}
          {view === "activity" && <ActivityView history={history} now={now} />}
          {view === "infrastructure" && (
            <Infrastructure network={network.data} />
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
              <span>Live data · no automated execution</span>
              <a
                href="https://docs.robinhood.com/chain/"
                target="_blank"
                rel="noreferrer"
              >
                Network docs <ArrowUpRight size={11} />
              </a>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
export function Dapp() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (failureCount, error) =>
              !(error instanceof DataError && error.status === 429) &&
              failureCount < 1,
            retryDelay: 2000,
            refetchOnWindowFocus: true,
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
