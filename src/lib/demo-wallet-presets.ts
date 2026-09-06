import type { DemoWallet } from "./demo-wallet";

// Loaded only in development on a loopback host. Quantities are fictional;
// token contracts and prices always come from the existing live data sources.
export const DEMO_WALLETS: readonly DemoWallet[] = Object.freeze([
  {
    id: "diversified",
    name: "Diversified",
    description: "A mix of Stock Tokens and USDG to explore everyday position sizes.",
    balances: { ETH: "0.15", USDG: "5000", NVDA: "25", AAPL: "40", TSLA: "5", MSFT: "12", AMZN: "20", GOOGL: "15", META: "6", SPY: "8" },
  },
  {
    id: "concentrated",
    name: "Concentrated",
    description: "A large NVDA holding to compare the effect of exit size on quotes.",
    balances: { ETH: "1.5", USDG: "25000", NVDA: "5000", AAPL: "0", TSLA: "250", MSFT: "0", AMZN: "0", GOOGL: "0", META: "0", SPY: "0" },
  },
  {
    id: "fractional",
    name: "Fractional",
    description: "Small holdings and an exact 18-decimal amount for precision checks.",
    balances: { ETH: "0.003", USDG: "125.50", NVDA: "0.123456789012345678", AAPL: "0.25", TSLA: "0.05", MSFT: "0.01", AMZN: "0.5", GOOGL: "0", META: "0", SPY: "0.1" },
  },
].map((wallet) => Object.freeze({ ...wallet, balances: Object.freeze(wallet.balances) })));
