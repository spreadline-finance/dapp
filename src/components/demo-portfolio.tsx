"use client";

import { ArrowUpRight } from "lucide-react";
import { demoBalance, type DemoWallet } from "@/lib/demo-wallet";
import { TRACKED_SYMBOLS } from "@/lib/market-types";
import { StockLogo } from "./stock-logo";

export function DemoPortfolio({ wallet, onPlan }: { wallet: DemoWallet; onPlan: (symbol: string, amount?: string) => void }) {
  return <section className="demo-portfolio" aria-labelledby="demo-portfolio-heading">
    <div className="portfolio-top"><div><span className="eyebrow">SIMULATED HOLDINGS</span><h2 id="demo-portfolio-heading">{wallet.name} wallet</h2><p>{wallet.description} Select a holding to compare live exit quotes.</p></div></div>
    <div className="demo-cash-balances">{["USDG", "ETH"].map((symbol) => <div key={symbol}><span>{symbol === "USDG" ? "Simulated cash balance" : "Simulated gas balance"}</span><strong>{demoBalance(wallet, symbol)} <small>{symbol}</small></strong></div>)}</div>
    <div className="demo-holdings"><table><caption className="sr-only">Preset Stock Token balances for the {wallet.name} demo wallet</caption><thead><tr><th scope="col">Stock Token</th><th scope="col">Simulated quantity</th><th scope="col"><span className="sr-only">Plan an exit</span></th></tr></thead><tbody>{TRACKED_SYMBOLS.map((symbol) => {
      const amount = demoBalance(wallet, symbol);
      return <tr key={symbol}><th scope="row"><span><StockLogo symbol={symbol} size={32}/>{symbol}</span></th><td className="demo-exact-amount">{amount}</td><td><button type="button" disabled={Number(amount) <= 0} aria-label={`Compare exit sizes for ${symbol}`} onClick={() => onPlan(symbol, amount)}>Compare exit sizes <ArrowUpRight size={14}/></button></td></tr>;
    })}</tbody></table></div>
    <p className="demo-portfolio-footnote">Preset quantities only. No onchain balance, portfolio valuation or lending position is implied. Quotes use current market data and do not change these balances.</p>
  </section>;
}
