import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Spreadline — Stock arbitrage. Without running your own bot.",
  description:
    "Live Stock Token markets, wallet balances and Uniswap route analysis on Robinhood Chain. Explore the planned Spreadline execution service.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
