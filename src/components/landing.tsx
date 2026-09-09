"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Menu, Wallet, X } from "lucide-react";
import { ProtocolLogo } from "./protocol-logo";
import { SpreadTokenIcon } from "./spread-token";
import "./landing.css";

export function Brand() {
  return <Link href="/" className="wordmark" aria-label="Spreadline home">spreadline<svg className="brand-symbol" viewBox="0 0 36 24" fill="none" aria-hidden="true"><path d="M1 9h18L35 4M1 15h18l16 5" stroke="currentColor" strokeWidth="1.4"/></svg></Link>;
}
const links = [{ href: "#products", label: "Explore" }, { href: "#trading", label: "Trading" }, { href: "#spread", label: "SPREAD", earn: true }, { href: "#questions", label: "Questions" }];
const steps = [
  { title: "Choose your trade", text: "Pick a Stock Token, choose buy or sell, and enter your amount. Get a quote before connecting your wallet.", label: "Amount", detail: "Start with the amount you want to trade.", facts: ["Buy or sell", "Choose your amount", "Request a live quote"] },
  { title: "Review the details", text: "Check the quoted output, minimum received and price impact. See what the trade means before you commit.", label: "Review", detail: "A clear quote, with the details that matter.", facts: ["Quoted output", "Minimum received", "Price impact and slippage"] },
  { title: "Confirm in your wallet", text: "Approve the required token amount if needed, then review the refreshed quote and confirm your swap in your wallet.", label: "Confirm", detail: "You review and authorize the transaction.", facts: ["Token approval, if required", "Refreshed quote", "Wallet confirmation"] },
];
const questions = [
  { q: "What can I do with Spreadline?", a: "Explore Stock Token markets on Robinhood Chain, inspect Uniswap pools, buy or sell through a guided trade flow, manage supported Morpho lending positions, and track your portfolio. Position planning and arbitrage research tools help you evaluate a trade before taking action." },
  { q: "Do I need a wallet to explore?", a: "No. You can browse markets, inspect pools and request trade quotes without a wallet. Connect a compatible wallet when you want to transact or view your own holdings." },
  { q: "Can I still open a trade in Uniswap?", a: "Yes. Open in Uniswap remains available alongside trading directly in Spreadline. In-app trading guides you through the amount, quote review and wallet confirmation." },
  { q: "How do SPREAD rewards work?", a: "The reward model allocates 75% of collected creator fees to eligible token holders and 25% to the fee receiver. The Token rewards page shows service availability, eligible snapshot holdings, allocations and confirmed payments when configured. Rewards depend on collected fees and eligibility; the split is not an APY or a guaranteed return." },
  { q: "Is the USDG strategy vault the same as token rewards?", a: "No. The USDG strategy vault is a separate vault experience: depositors can share realized trading surplus when the vault completes profitable routes. SPREAD rewards concern eligible token holdings and creator-fee distributions. Check each page for its current status before participating." },
  { q: "What should I know about Stock Tokens and lending?", a: "Stock Tokens are tokenized instruments, not direct ownership of company shares. Review the issuer’s terms and eligibility requirements. DEX prices can differ from issuer references. Lending rates vary, and lending and trading involve market, liquidity and smart-contract risk." },
];
function Launch({ children = "Launch app" }: { children?: string }) {
  return <a className="lp-button" href="/app">{children}<ArrowUpRight size={17} aria-hidden="true"/></a>;
}
export function Landing() {
  const [menu, setMenu] = useState(false);
  const [step, setStep] = useState(0);
  return <div className="landing-page">
    <a className="lp-skip" href="#main">Skip to content</a>
    <header className="lp-header lp-wrap">
      <Brand/>
      <nav className="lp-desktop-nav" aria-label="Main navigation">{links.map(link => <a key={link.href} href={link.href} className={link.earn ? "lp-nav-earn" : undefined}>{link.earn && <SpreadTokenIcon size={22}/>} {link.label}</a>)}</nav>
      <div className="lp-header-actions"><Launch/>
        <Dialog.Root open={menu} onOpenChange={setMenu}>
          <Dialog.Trigger className="lp-menu-trigger" aria-label="Open navigation"><Menu size={23}/></Dialog.Trigger>
          <Dialog.Portal><Dialog.Overlay className="lp-menu-overlay"/><Dialog.Content className="lp-menu-panel">
            <div className="lp-menu-heading"><Dialog.Title>Explore Spreadline</Dialog.Title><Dialog.Close aria-label="Close navigation"><X size={24}/></Dialog.Close></div>
            <Dialog.Description className="sr-only">Markets, trading and token rewards on Robinhood Chain.</Dialog.Description>
            <nav aria-label="Mobile navigation">{links.map(link => <a key={link.href} href={link.href} onClick={() => setMenu(false)} className={link.earn ? "lp-nav-earn" : undefined}>{link.earn && <SpreadTokenIcon size={26}/>} {link.label}<ArrowUpRight size={18}/></a>)}</nav>
            <Launch/>
          </Dialog.Content></Dialog.Portal>
        </Dialog.Root>
      </div>
    </header>
    <main id="main">
      <section className="lp-hero lp-wrap" aria-labelledby="hero-title">
        <div className="lp-hero-copy"><span className="lp-kicker">Stock Tokens. Robinhood Chain.</span>
          <h1 id="hero-title">Trade. Lend.<br/><em>Stay in control.</em></h1>
          <p>Research Stock Token markets, trade through Uniswap and manage Morpho lending. One workspace, connected to your wallet.</p>
          <div className="lp-actions"><Launch/><a className="lp-text-link" href="#spread"><SpreadTokenIcon size={25}/>Explore SPREAD<ArrowRight size={17}/></a></div>
          <span className="lp-hero-note">Explore markets without connecting a wallet.</span>
        </div>
        <div className="lp-hero-art"><img src="/artwork/hero-transparent.webp" alt="" width="900" height="1125" fetchPriority="high"/><span className="lp-art-caption">Different possibilities.<br/>One continuous line.</span></div>
      </section>
      <div className="lp-protocols lp-wrap" aria-label="Supported ecosystem">
        <span className="lp-kicker">Your onchain workspace</span>
        <div><ProtocolLogo protocol="uniswap"/><span>Uniswap<small>Markets & swaps</small></span></div>
        <div><ProtocolLogo protocol="morpho"/><span>Morpho<small>Lending markets</small></span></div>
        <div className="lp-chain"><img src="/logos/Robinhood-Chain.png" alt="Robinhood Chain" width="142" height="32"/><small>The network underneath</small></div>
      </div>
      <section id="products" className="lp-section lp-wrap" aria-labelledby="products-title">
        <div className="lp-section-heading"><div><span className="lp-kicker">01 / The workspace</span><h2 id="products-title">From the first look<br/><em>to your next move.</em></h2></div><p>Follow a market, put a trade together and keep track of what you hold. The context stays with you.</p></div>
        <div className="lp-product-grid">
          <a className="lp-product" href="/app"><div className="lp-product-art lp-token-stack"><img src="/logos/stocks/NVDA.png" alt="" width="58" height="58"/><img src="/logos/stocks/AAPL.png" alt="" width="58" height="58"/><img src="/logos/stocks/TSLA.png" alt="" width="58" height="58"/></div><span className="lp-kicker">Explore & trade</span><h3>Markets, with context.</h3><p>Compare issuer references with DEX prices, inspect liquidity and buy or sell in a guided trade flow.</p><span className="lp-product-link">Explore markets<ArrowUpRight size={18}/></span></a>
          <a className="lp-product" href="/app?view=lending"><div className="lp-product-art"><ProtocolLogo protocol="morpho" size={58}/><span className="lp-visual-label">Morpho<br/><small>Supply · Withdraw · Manage</small></span></div><span className="lp-kicker">Put assets to work</span><h3>Lending, in view.</h3><p>Explore Morpho markets, review rates and collateral, and manage supported lending positions from your wallet.</p><span className="lp-product-link">Explore lending<ArrowUpRight size={18}/></span></a>
          <a className="lp-product" href="/app?view=portfolio"><div className="lp-product-art"><Wallet size={48} strokeWidth={1}/><span className="lp-visual-label">Your wallet<br/><small>Assets · Positions · Perspective</small></span></div><span className="lp-kicker">Keep the bigger picture</span><h3>Your portfolio, together.</h3><p>See your wallet holdings and positions. Use the position planner to evaluate size and costs for your next trade.</p><span className="lp-product-link">View portfolio<ArrowUpRight size={18}/></span></a>
        </div>
        <a className="lp-secondary-link" href="/app?view=planner">Already have a trade in mind? Open the position planner<ArrowRight size={16}/></a>
      </section>
      <section id="trading" className="lp-trading" aria-labelledby="trading-title"><div className="lp-wrap">
        <div className="lp-trade-grid"><div><span className="lp-kicker">02 / In-app trading</span><h2 id="trading-title">See the trade.<br/><em>Then sign.</em></h2><p className="lp-trade-intro">A dedicated trading card. Three clear steps. Your wallet has the final say.</p>
          <div className="lp-steps" aria-label="Preview the trading steps">{steps.map((item, i) => <button key={item.label} type="button" aria-pressed={step === i} aria-controls="trade-preview" onClick={() => setStep(i)}><span className="lp-step-number">0{i + 1}</span><span><strong>{item.title}</strong>{step === i && <span className="lp-step-description">{item.text}</span>}</span><ArrowUpRight size={18}/></button>)}</div>
        </div><div className="lp-trade-visual">
          <img className="lp-gate-art" src="/artwork/execution-transparent.webp" alt="" width="1600" height="533" loading="lazy"/>
          <div id="trade-preview" className="lp-trade-card" aria-live="polite"><div className="lp-preview-heading"><span><ProtocolLogo protocol="uniswap" size={24}/>Uniswap</span><small>Flow preview</small></div>
            <div className="lp-progress">{steps.map((item, i) => <span key={item.label} data-active={step === i}>{i + 1}. {item.label}</span>)}</div>
            <div className="lp-preview-pair"><img src="/logos/tokens/usdg.svg" alt="USDG" width="45" height="45"/><ArrowRight size={22}/><img src="/logos/stocks/NVDA.png" alt="NVDA Stock Token" width="45" height="45"/></div>
            <h3>{steps[step].title}</h3><p>{steps[step].detail}</p><ul>{steps[step].facts.map(fact => <li key={fact}><Check size={16}/>{fact}</li>)}</ul><a href="/app" className="lp-button">Start a trade<ArrowUpRight size={17}/></a>
          </div>
        </div></div>
        <p className="lp-uniswap-note"><ProtocolLogo protocol="uniswap" size={22}/>Prefer Uniswap? <span>Open in Uniswap is still available inside the app.</span></p>
      </div></section>
      <section id="spread" className="lp-rewards lp-section lp-wrap" aria-labelledby="spread-title">
        <div className="lp-rewards-art"><img src="/artwork/spread-rewards.webp" alt="An engraved sculpture with spreading paths and the SPREAD coin" width="1024" height="683" loading="lazy"/></div>
        <div><span className="lp-token-label"><SpreadTokenIcon size={34}/>SPREAD / Token rewards</span><h2 id="spread-title">A share in<br/><em>what flows.</em></h2><p>The SPREAD reward model shares collected creator fees with eligible holders. Follow allocations and confirmed payments in one dedicated view.</p>
          <div className="lp-fee-split" aria-label="Reward model: 75 percent to eligible holders, 25 percent to the fee receiver"><div><strong>75<span>%</span></strong><span>Eligible holders</span></div><div><strong>25<span>%</span></strong><span>Fee receiver</span></div></div>
          <p className="lp-rewards-note">Fee allocation, not an APY. Availability, eligibility and payout status are shown in the app.</p>
          <a href="/app?view=rewards" className="lp-button"><SpreadTokenIcon size={23}/>Explore token rewards<ArrowUpRight size={17}/></a>
          <a href="/app?view=desk" className="lp-secondary-link">Looking for strategy deposits? Explore the USDG vault<ArrowRight size={16}/></a>
        </div>
      </section>
      <section className="lp-principles lp-wrap" aria-label="Designed for informed decisions"><div><span className="lp-kicker">Know the source</span><h3>Prices with perspective.</h3><p>Issuer references and DEX quotes have different roles. See where each figure comes from.</p></div><div><span className="lp-kicker">Know the status</span><h3>Freshness made visible.</h3><p>Check update times and source availability before relying on a quote or a balance.</p></div><div><span className="lp-kicker">Know what you sign</span><h3>Wallet-led decisions.</h3><p>Review the amount and transaction details before authorizing an onchain action.</p></div></section>
      <section id="questions" className="lp-faq lp-section lp-wrap" aria-labelledby="questions-title"><div><span className="lp-kicker">03 / A little clarity</span><h2 id="questions-title">Good questions.<br/><em>Clear answers.</em></h2><a className="lp-text-link" href="/app?view=learn">Read the product guide<ArrowUpRight size={17}/></a></div><div>{questions.map(item => <details key={item.q}><summary>{item.q}<ChevronDown size={19}/></summary><p>{item.a}</p></details>)}</div></section>
      <section className="lp-closing lp-wrap"><span className="lp-kicker">Make your next move</span><h2>Your next move.<br/><em>A clearer view.</em></h2><Launch>Explore Spreadline</Launch></section>
    </main>
    <footer className="lp-footer lp-wrap"><div><Brand/><p>Markets, trading and lending on Robinhood Chain.</p></div><nav aria-label="Footer"><a href="/app?view=infrastructure">Sources & status<ArrowUpRight size={14}/></a><a href="/app?view=learn">Product guide<ArrowUpRight size={14}/></a><a href="/app?view=rewards">SPREAD rewards<ArrowUpRight size={14}/></a><a href="https://x.com/spreadonrh" target="_blank" rel="noreferrer">X<ArrowUpRight size={14}/></a><a href="https://github.com/spreadline-finance/dapp" target="_blank" rel="noreferrer">GitHub<ArrowUpRight size={14}/></a></nav><small>Spreadline is an independent interface. Third-party names and marks identify assets and protocols; they do not imply endorsement. Trading and lending involve risk.</small></footer>
  </div>;
}
