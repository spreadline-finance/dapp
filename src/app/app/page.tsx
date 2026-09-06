import type { Metadata } from "next";
import { Dapp } from "@/components/dapp";
export const metadata: Metadata = {
  title: "Spreadline — Markets & trading",
  description:
    "Robinhood Stock Token market data, corporate actions, live buy and sell comparisons, and wallet-confirmed Uniswap trading.",
};
export default function AppPage() {
  return <Dapp />;
}
