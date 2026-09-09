"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import "./protocol-logo.css";

/** Original protocol marks. Always pair with a visible protocol name. */
export function ProtocolLogo({ protocol, size = 32 }: { protocol: "uniswap" | "morpho"; size?: number }) {
  const [failed, setFailed] = useState<string>();
  const src = `/logos/protocols/${protocol}.svg`;
  return <span className="protocol-logo" data-protocol={protocol} style={{ width: size, height: size }} aria-hidden="true">
    {failed !== src ? <img src={src} alt="" width={size} height={size} decoding="async" onError={() => setFailed(src)}/> : <span>{protocol === "uniswap" ? "U" : "M"}</span>}
  </span>;
}
