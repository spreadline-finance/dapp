"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { STOCK_LOGOS } from "@/lib/stock-logos";
import "./stock-logo.css";

/** Company/fund identity, separate from the issuer's generic token icon. */
export function StockLogo({ symbol, size = 32 }: { symbol: string; size?: number }) {
  const src = symbol === "USDG" ? "/logos/USDG.png" : STOCK_LOGOS[symbol];
  const [failedSource, setFailedSource] = useState<string>();
  return <span className="stock-logo" data-symbol={symbol} style={{ width: size, height: size }} aria-hidden="true">
    {src && failedSource !== src
      ? <img src={src} width={size} height={size} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(src)}/>
      : <span>{symbol.slice(0, 2)}</span>}
  </span>;
}
