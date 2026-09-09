"use client";
/* eslint-disable @next/next/no-img-element */
import { useState, useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowUpRight,
  CircleHelp,
  Menu,
  Pause,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import { getData, displayNumber } from "@/lib/live-api";
import type { Catalog, PriceBook } from "@/lib/market-types";
const ExecutionAnimation = dynamic(() => import("./execution-animation"), {
  ssr: false,
  loading: () => <div className="animation-loading" />,
});
export function Brand() {
  return (
    <a href="#" className="wordmark" aria-label="Spreadline home">
      spreadline
      <svg
        className="brand-symbol"
        viewBox="0 0 36 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M1 9h18L35 4M1 15h18l16 5"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    </a>
  );
}
function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{
        duration: reduced ? 0 : 0.7,
        delay,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}
function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow section-eyebrow">{children}</span>;
}
function Opportunity({ onDemo }: { onDemo: () => void }) {
  const [data, setData] = useState<{
    catalog: Catalog;
    prices: PriceBook;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      Promise.all([
        getData<Catalog>("catalog", controller.signal),
        getData<PriceBook>("prices?symbols=AAPL,NVDA,TSLA", controller.signal),
      ])
        .then(([catalog, prices]) => {
          setData({ catalog, prices });
          setError(!!catalog.dataStatus || !!prices.dataStatus || !!prices.cachedSymbols?.length || !!prices.unavailableSymbols?.length);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <section id="opportunity" className="section opportunity">
      <Reveal className="section-heading">
        <div>
          <Eyebrow>01 / LIVE MARKET ACCESS</Eyebrow>
          <h2 className="display">
            Start with the market.
            <br />
            <em>Understand the whole trade.</em>
          </h2>
        </div>
        <p>
          Explore official Stock Tokens, inspect real Uniswap pools and quote
          complete round trips against Robinhood Chain.
        </p>
      </Reveal>
      <Reveal className="landing-live-grid">
        <div>
          <span className="large-index">01—</span>
          <h3 className="display">
            Real assets.
            <br />
            Traceable data.
          </h3>
          <p>
            A symbol is not an identity. Spreadline matches tokens to
            Robinhood’s official contract registry and reads supported pools
            from the Uniswap factory.
          </p>
          <button className="text-link" onClick={onDemo}>
            Open the execution desk <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="landing-live-card">
          <div>
            <span className="eyebrow">OFFICIAL STOCK TOKENS</span>
            <span>REFERENCE BID / ASK</span>
          </div>
          {["NVDA", "AAPL", "TSLA"].map((symbol) => {
            const asset = data?.catalog.assets.find((a) => a.symbol === symbol);
            const q = data?.prices.quotes.find((p) => p.symbol === symbol);
            return (
              <div className="landing-live-row" key={symbol}>
                <div>
                  <strong>{symbol}</strong>
                  <span>{asset?.name ?? "Robinhood Stock Token"}</span>
                </div>
                <div>
                  <strong>
                    {q && asset && !q.halted
                      ? `$${displayNumber(Number(q.bid) * Number(asset.multiplier))} / $${displayNumber(Number(q.ask) * Number(asset.multiplier))}`
                      : "—"}
                  </strong>
                  <span>
                    {q
                      ? `${data?.catalog.dataStatus || data?.prices.dataStatus || data?.prices.cachedSymbols?.includes(symbol) ? "Cached · " : ""}${new Date(q.generatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                      : error
                        ? "Source unavailable"
                        : "Connecting to source"}
                  </span>
                </div>
              </div>
            );
          })}
          <p>
            {error
              ? "The source could not refresh. Any displayed values are the last received quotes. "
              : ""}
            USD reference quotes, adjusted for each token’s multiplier. These
            are not executable DEX prices.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
const steps = [
  {
    title: "Find the difference.",
    label: "01 / OBSERVE",
    text: "The service would read supported pools, track the same token across venues and identify candidate round trips.",
    detail: "Watch pools → compare reserves → identify a route",
    icon: CircleHelp,
  },
  {
    title: "Check the full trade.",
    label: "02 / SIMULATE",
    text: "Quote both swaps at the proposed size. Account for pool fees, service fees, gas estimates and the conditions you set.",
    detail: "Quote swaps → calculate costs → check your limits",
    icon: SlidersHorizontal,
  },
  {
    title: "Settle in one transaction.",
    label: "03 / EXECUTE",
    text: "The proposed contract would run both swaps and require your minimum surplus. If the condition fails, it reverts. A submitted attempt can still cost gas.",
    detail: "USDG → same Stock Token → USDG",
    icon: Zap,
  },
];
function Mechanism() {
  const [step, setStep] = useState(0);
  const active = steps[step];
  return (
    <section id="how-it-works" className="mechanism">
      <div className="shell">
        <Reveal className="mechanism-heading">
          <div>
            <Eyebrow>02 / UNDER THE SURFACE</Eyebrow>
            <h2 className="display">
              You set the conditions.
              <br />
              <em>We build the execution.</em>
            </h2>
          </div>
          <p>
            No server to maintain. No script to babysit.
            <br />
            The proposed service runs the automation;
            <br />
            you decide what it is allowed to do.
          </p>
        </Reveal>
        <div className="mechanism-grid">
          <Reveal className="mechanism-steps">
            <div
              className="step-buttons"
              role="group"
              aria-label="Explore execution stages"
            >
              {steps.map((s, i) => (
                <button
                  key={s.label}
                  aria-pressed={step === i}
                  onClick={() => setStep(i)}
                  className={step === i ? "active" : ""}
                >
                  <span className="step-index">0{i + 1}</span>
                  <div>
                    <h3>{s.title}</h3>
                    <div className="step-detail">
                      <p>{s.text}</p>
                    </div>
                  </div>
                  <ArrowUpRight size={18} />
                </button>
              ))}
            </div>
          </Reveal>
          <Reveal className="execution-panel" delay={0.1}>
            <div className="execution-panel-top">
              <span className="eyebrow">PROPOSED EXECUTION FLOW</span>
              <span className="sequence-indicator">0{step + 1} / 03</span>
            </div>
            <div className="execution-art">
              <img
                src="/artwork/execution.webp"
                alt="Engraved circular pathway connecting both sides of an execution route"
                loading="lazy"
              />
            </div>
            <div className="execution-diagram">
              <ExecutionAnimation />
              <div className="diagram-labels">
                <span>YOUR USDG</span>
                <span>STOCK TOKEN</span>
                <span>USDG RETURNED</span>
              </div>
            </div>
            <div className="execution-caption" aria-live="polite">
              <span className="accent">{active.label}</span>
              <p>{active.detail}</p>
            </div>
          </Reveal>
        </div>
        <div className="mechanism-bottom">
          <ShieldCheck size={18} />
          <p>
            Atomic settlement enforces the transaction’s condition. It does not
            eliminate contract risk, competition or gas costs.
          </p>
          <span>DESIGNED TO BE VERIFIABLE</span>
        </div>
      </div>
    </section>
  );
}
const faqs = [
  [
    "Do I need to run a trading bot?",
    "No. The proposed Spreadline service would monitor supported pools and submit trades. You would set spending limits and execution conditions. Connecting a wallet alone would not authorize trading.",
  ],
  [
    "Where would the opportunity come from?",
    "Separate pools can quote different prices for the same Stock Token. A round trip can capture a difference only if it survives price impact, fees and execution costs. Available liquidity and competing traders limit how much a route can handle.",
  ],
  [
    "What happens if a trade no longer meets my limits?",
    "The proposed contract would require a minimum surplus in USDG after the service fee, before gas. If the condition is not met, the swaps revert together. A submitted transaction can still consume gas even when it reverts.",
  ],
  [
    "Does a Stock Token mean I own company shares?",
    "Stock Tokens provide exposure under their issuer’s terms; they are not direct ownership of the underlying shares. Rights, restrictions and availability depend on the specific token.",
  ],
  [
    "Can I use Spreadline today?",
    "The dApp shows Robinhood market data and offers one-way USDG / Stock Token trading through Uniswap V3. Wallet trades require balance checks, exact-amount approval where needed, simulation and your confirmation. Automated round-trip execution remains a separate, unimplemented product.",
  ],
  [
    "Where does the Spreadline token fit?",
    "The proposed role is access to fee discounts as the product develops. Token design, availability and launch terms are not finalized. Holding a token would not create a right to trading profits or guarantee returns.",
  ],
];
export function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [artPaused, setArtPaused] = useState(false);
  const router = useRouter();
  const openApp = () => router.push("/app");
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="shell">
        <header className="site-nav">
          <Brand />
          <nav className="nav-links" aria-label="Main navigation">
            <a href="#opportunity">The opportunity</a>
            <a href="#how-it-works">How it works</a>
            <a href="#questions">Questions</a>
          </nav>
          <div className="nav-end">
            <span className="status">
              <i />
              In development
            </span>
            <button
              className="button button-primary button-small nav-demo"
              onClick={openApp}
            >
              Launch app <ArrowUpRight size={15} />
            </button>
            <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Dialog.Trigger
                className="mobile-toggle"
                aria-label="Open navigation"
              >
                <Menu size={19} />
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content
                  className="mobile-menu"
                  aria-describedby={undefined}
                >
                  <div className="flex items-center justify-between">
                    <Dialog.Title className="wordmark">spreadline</Dialog.Title>
                    <Dialog.Close
                      className="icon-button"
                      aria-label="Close navigation"
                    >
                      <X size={21} />
                    </Dialog.Close>
                  </div>
                  <nav aria-label="Mobile navigation">
                    {[
                      ["#opportunity", "The opportunity"],
                      ["#how-it-works", "How it works"],
                      ["#controls", "Your controls"],
                      ["#questions", "Questions"],
                    ].map(([href, text]) => (
                      <a
                        key={href}
                        href={href}
                        onClick={() => setMenuOpen(false)}
                      >
                        {text}
                        <ArrowUpRight size={19} />
                      </a>
                    ))}
                  </nav>
                  <button
                    className="button button-primary"
                    onClick={() => {
                      setMenuOpen(false);
                      openApp();
                    }}
                  >
                    Launch app <ArrowUpRight size={17} />
                  </button>
                  <span className="status">
                    <i />
                    In development
                  </span>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
        </header>
        <main id="main">
          <section className="hero">
            <Reveal className="hero-copy">
              <div className="eyebrow hero-kicker">
                Execution infrastructure · Robinhood Chain
              </div>
              <h1 className="display">
                Stock arbitrage.
                <br />
                Without running
                <br />
                <em>your own bot.</em>
              </h1>
              <p className="hero-lede">
                The same Stock Token. Different pool prices.
                <br />
                You set the limits. Spreadline is designed to find, check and
                execute the trade.
              </p>
              <div className="hero-actions">
                <button onClick={openApp} className="button button-primary">
                  Launch app <ArrowUpRight size={17} />
                </button>
                <a
                  href="/app?view=planner"
                  className="button button-secondary"
                >
                  Plan a position <ArrowUpRight size={17} />
                </a>
              </div>
              <p className="hero-note">
                Live market data and route quotes. Automated execution is not
                enabled.
              </p>
              <div className="hero-meta">
                <div className="asset-stack">
                  <span>
                    <img src="/logos/NVIDIA.svg" alt="NVIDIA" />
                  </span>
                  <span>
                    <img src="/logos/Apple.svg" alt="Apple" />
                  </span>
                  <span>
                    <img src="/logos/USDG.png" alt="USDG" />
                  </span>
                </div>
                <span>Built around Stock Tokens. Settled in USDG.</span>
              </div>
            </Reveal>
            <div className={`hero-art ${artPaused ? "art-paused" : ""}`}>
              <img
                src="/artwork/hero-engraving.webp"
                alt="Engraved architectural ribbons following a single vermilion execution path"
                fetchPriority="high"
                width="1122"
                height="1402"
              />
              <span className="art-label">FIG. 01 — THE EXECUTION LOOP</span>
              <button
                className="hero-motion-control"
                onClick={() => setArtPaused(!artPaused)}
                aria-label={
                  artPaused ? "Play artwork motion" : "Pause artwork motion"
                }
              >
                {artPaused ? <Play size={12} /> : <Pause size={12} />}
              </button>
            </div>
            <a href="#opportunity" className="scroll-cue">
              <ArrowDown size={13} /> DISCOVER THE MECHANISM
            </a>
          </section>
          <div className="market-strip">
            <div className="network-reference">
              <p>PROPOSED NETWORK</p>
              <img
                className="network-logo"
                src="/logos/Robinhood-Chain.png"
                alt="Robinhood Chain"
              />
            </div>
            <div className="strip-item">
              <span>01</span>User-defined limits
            </div>
            <div className="strip-item">
              <span>02</span>Atomic settlement
            </div>
            <div className="strip-item">
              <span>03</span>Transparent results
            </div>
          </div>
          <Opportunity onDemo={openApp} />
        </main>
      </div>
      <Mechanism />
      <div className="shell">
        <section id="controls" className="section controls">
          <Reveal className="section-heading">
            <div>
              <Eyebrow>03 / THE CONTROLS</Eyebrow>
              <h2 className="display">
                Your capital.
                <br />
                <em>Your conditions.</em>
              </h2>
            </div>
            <p>
              Automation needs boundaries. The proposed interface makes those
              boundaries explicit before a transaction is ever submitted.
            </p>
          </Reveal>
          <div className="control-grid">
            {[
              {
                num: "01",
                icon: SlidersHorizontal,
                title: "Decide the size.",
                text: "Set a maximum allocation for the strategy. Each candidate trade is sized against the liquidity available in its route.",
                meta: "ALLOCATION LIMIT",
              },
              {
                num: "02",
                icon: ShieldCheck,
                title: "Define the minimum.",
                text: "Require a minimum USDG surplus after the service fee, before gas. The contract would reject a settlement below that condition.",
                meta: "MINIMUM SURPLUS",
              },
              {
                num: "03",
                icon: Zap,
                title: "Account for the cost.",
                text: "Limit the gas estimate the service can accept. Gas is paid separately in ETH and a reverted transaction can still incur a cost.",
                meta: "GAS BUDGET",
              },
            ].map((card, i) => (
              <Reveal key={card.num} delay={i * 0.07} className="control-card">
                <div className="control-card-top">
                  <card.icon size={21} strokeWidth={1.25} />
                  <span>{card.num}</span>
                </div>
                <h3 className="display">{card.title}</h3>
                <p>{card.text}</p>
                <span className="eyebrow">{card.meta}</span>
              </Reveal>
            ))}
          </div>
          <Reveal className="permission-note">
            <span className="permission-mark">
              <ShieldCheck size={19} />
            </span>
            <p>
              <strong>Permission is part of the product.</strong> A wallet
              connection is not trading authorization. A live implementation
              would need explicit, limited permissions, expiry and a way to
              revoke access.
            </p>
            <button className="text-link" onClick={openApp}>
              Open the execution desk <ArrowUpRight size={16} />
            </button>
          </Reveal>
        </section>
        <section className="build-section">
          <Reveal className="build-art">
            <img
              src="/artwork/validation.webp"
              alt="Three engraved architectural arches representing staged product validation"
              loading="lazy"
            />
            <span className="art-caption">
              FIG. 02 / FROM CONCEPT TO EXECUTION
            </span>
          </Reveal>
          <Reveal className="build-copy">
            <Eyebrow>04 / THE PATH TO LAUNCH</Eyebrow>
            <h2 className="display">
              Conviction needs
              <br />
              <em>more than a concept.</em>
            </h2>
            <p>
              The next step is to establish whether repeatable opportunities
              survive real execution costs. The product should earn its case
              with measured results.
            </p>
            <ol className="roadmap">
              {[
                [
                  "Validate the market",
                  "Measure supported pools, route capacity and actual costs.",
                ],
                [
                  "Prove the execution",
                  "Build adapters and contract checks. Test failure cases and security.",
                ],
                [
                  "Open a controlled pilot",
                  "Use capped allocations and publish clear execution records.",
                ],
              ].map(([title, text], i) => (
                <li key={title}>
                  <span>0{i + 1}</span>
                  <div>
                    <strong>{title}</strong>
                    <p>{text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <span className="planned-label">
              PLANNED MILESTONES · NOT COMPLETED RELEASES
            </span>
          </Reveal>
        </section>
        <section id="questions" className="section questions">
          <Reveal className="questions-heading">
            <Eyebrow>05 / A FEW THINGS WORTH ASKING</Eyebrow>
            <h2 className="display">
              Clarity,
              <br />
              <em>before capital.</em>
            </h2>
            <a
              className="text-link"
              href="/app?view=learn"
            >
              How it works <ArrowUpRight size={16} />
            </a>
          </Reveal>
          <div className="faq-list">
            {faqs.map(([question, answer], i) => (
              <Reveal key={question} delay={i * 0.035}>
                <details className="faq">
                  <summary>
                    <span>{question}</span>
                    <span className="faq-toggle" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <p>{answer}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </section>
        <Reveal className="closing">
          <span className="eyebrow">
            THE NEXT STEP IS UNDERSTANDING THE TRADE.
          </span>
          <h2 className="display">
            Follow the gap.
            <br />
            <em>Understand the execution.</em>
          </h2>
          <button className="button button-primary" onClick={openApp}>
            Open Spreadline <ArrowUpRight size={17} />
          </button>
          <span className="closing-note">
            Explore live markets. No wallet required.
          </span>
        </Reveal>
        <footer className="footer">
          <div className="footer-top">
            <Brand />
            <span>Stock Token execution, thoughtfully designed.</span>
            <a href="#main" className="text-link">
              Back to top <ArrowUpRight size={15} />
            </a>
          </div>
          <div className="footer-bottom">
            <span>© 2026 Spreadline</span>
            <p>
              Live market data. Wallet-confirmed swaps. Third-party names and logos
              identify referenced assets and infrastructure; they do not
              indicate endorsement.
            </p>
            <nav className="footer-links" aria-label="Footer links">
              <a href="/app?view=learn">How it works ↗</a>
              <a
                href="https://x.com/spreadonrh"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Spreadline on X (opens in a new tab)"
              >
                X <ArrowUpRight size={11} aria-hidden="true" />
              </a>
              <a
                href="https://github.com/spreadline-finance/dapp"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Spreadline on GitHub (opens in a new tab)"
              >
                GitHub <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            </nav>
          </div>
        </footer>
      </div>
    </>
  );
}
