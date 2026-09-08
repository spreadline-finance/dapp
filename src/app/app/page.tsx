import type { Metadata } from "next";
import { Dapp } from "@/components/dapp";
import { openGraph } from "@/lib/site-metadata";
const title = "Spreadline — Markets & trading";
const description = "Robinhood Stock Token market data, corporate actions, live buy and sell comparisons, and wallet-confirmed Uniswap trading.";
export const metadata: Metadata = {
  title, description,
  alternates: { canonical: "/app" },
  openGraph: { ...openGraph, title, description, url: "/app" },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};
export default function AppPage() {
  return <Dapp />;
}
