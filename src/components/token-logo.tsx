"use client";
/* eslint-disable @next/next/no-img-element */
import { createContext, useContext, useState, type ReactNode } from "react";
import { Coins } from "lucide-react";
import { tokenLogo } from "@/lib/token-logos";
import type { StockAsset } from "@/lib/market-types";
import type { LendingAsset } from "@/lib/lending";
import "./token-logo.css";
const RegisteredStocks = createContext<StockAsset[]>([]);
export function TokenLogoScope({ stocks, children }: { stocks: StockAsset[]; children: ReactNode }) { return <RegisteredStocks.Provider value={stocks}>{children}</RegisteredStocks.Provider>; }
export function TokenLogo({ asset, size = 32 }: { asset?: Pick<LendingAsset, "address" | "symbol">; size?: number }) {
  const stocks = useContext(RegisteredStocks), logo = asset ? tokenLogo(asset.address, stocks) : undefined;
  const [failed, setFailed] = useState<string>();
  return <span className="token-logo" data-kind={logo?.kind ?? "unknown"} data-symbol={asset?.symbol} style={{ width: size, height: size }} aria-hidden="true">{logo && failed !== logo.src ? <img src={logo.src} alt="" width={size} height={size} decoding="async" onError={() => setFailed(logo.src)}/> : <Coins size={Math.round(size * .48)}/>}</span>;
}
export function TokenPairLogo({ supply, collateral, size = 40 }: { supply?: Pick<LendingAsset, "address" | "symbol">; collateral?: Pick<LendingAsset, "address" | "symbol"> | null; size?: number }) {
  return <span className="token-pair-logo" style={{ width: collateral ? size + 13 : size, height: collateral ? size + 4 : size }}><TokenLogo asset={supply} size={size}/>{collateral && <span className="token-pair-collateral"><TokenLogo asset={collateral} size={Math.round(size * .58)}/></span>}</span>;
}
