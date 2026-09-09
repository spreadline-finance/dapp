import type { Metadata } from "next";

export const siteOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://spredline.vercel.app");
if (!["http:", "https:"].includes(siteOrigin.protocol) || siteOrigin.username || siteOrigin.password) {
  throw new Error("NEXT_PUBLIC_SITE_URL must be an HTTP(S) site origin without credentials.");
}
if (process.env.NODE_ENV === "production" && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(siteOrigin.hostname)) {
  throw new Error("NEXT_PUBLIC_SITE_URL must be a public origin for production builds, such as https://spredline.vercel.app.");
}
export const title = "Spreadline — Markets, trading & lending";
export const description = "Explore Stock Token markets, trade through Uniswap, manage Morpho lending and discover SPREAD token rewards on Robinhood Chain.";
export const openGraph = {
  type: "website", locale: "en_US", siteName: "Spreadline", title, description,
  images: [{ url: "/og.png", width: 1200, height: 630, alt: "Spreadline — Markets. Lending. In your hands. Robinhood Chain." }],
} satisfies Metadata["openGraph"];
