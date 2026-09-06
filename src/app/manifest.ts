import type { MetadataRoute } from "next";
export const dynamic = "force-static";
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app", name: "Spreadline", short_name: "Spreadline",
    description: "Stock Token markets, trading and Morpho lending on Robinhood Chain.",
    start_url: "/app", scope: "/", display: "standalone",
    background_color: "#f3f5ed", theme_color: "#f3f5ed", lang: "en",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Markets & trading", short_name: "Markets", url: "/app", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Lending", url: "/app?view=lending", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Portfolio", url: "/app?view=portfolio", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
