import type { Metadata } from "next";
import { Dapp } from "@/components/dapp";
export const metadata: Metadata = {
  title: "Spreadline — Execution desk",
  description:
    "Robinhood Chain market monitoring, wallet balances and route analysis.",
};
export default function AppPage() {
  return <Dapp />;
}
