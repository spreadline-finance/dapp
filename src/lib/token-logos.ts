import { CHAIN_ID, type StockAsset } from "./market-types";
import { STOCK_LOGOS } from "./stock-logos";
// Identity and original artwork verified against Morpho's chain-scoped asset API.
// Provenance: public/logos/tokens/sources.json. Symbols never select a crypto logo.
export const TOKEN_LOGOS: Readonly<Record<string, string>> = {
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "/logos/tokens/usdg.svg",
  "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": "/logos/tokens/usde.svg",
  "0x40858070814a57fdf33a613ae84fe0a8b4a874f7": "/logos/tokens/syrupusdg.svg",
  "0xfed493f38c1aacb4ea4e6a11f8b9287849ee0096": "/logos/tokens/mglo.svg",
  "0xde770c84fe66e063336b31737cfe9790f18c4087": "/logos/tokens/spusdg.svg",
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "/logos/tokens/weth.svg",
};
export function tokenLogo(address: string, stocks: Pick<StockAsset, "address" | "symbol">[] = [], chainId = CHAIN_ID) {
  if (chainId !== CHAIN_ID || !/^0x[\da-f]{40}$/i.test(address)) return undefined;
  const key = address.toLowerCase();
  if (TOKEN_LOGOS[key]) return { src: TOKEN_LOGOS[key], kind: "token" as const };
  const stock = stocks.find((s) => s.address.toLowerCase() === key);
  return stock && STOCK_LOGOS[stock.symbol] ? { src: STOCK_LOGOS[stock.symbol], kind: "stock" as const } : undefined;
}
