import { walletSubmissions } from "./wallet-submission";

/** No account, chain or provider: a demo wallet is only a set of quantities. */
export type DemoWallet = Readonly<{
  id: string;
  name: string;
  description: string;
  balances: Readonly<Record<string, string>>;
}>;

export function isLocalDemoHost(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

export function canActivateDemo(environment: string | undefined, hostname: string, pending: boolean) {
  return environment === "development" && isLocalDemoHost(hostname) && !pending && walletSubmissions.size === 0;
}

export function demoBalance(wallet: DemoWallet, symbol: string): string {
  return Object.hasOwn(wallet.balances, symbol) ? wallet.balances[symbol] : "0";
}
