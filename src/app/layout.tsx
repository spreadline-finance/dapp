import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaProvider } from "@/components/pwa";
const siteOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://127.0.0.1:3000");
if (!["http:", "https:"].includes(siteOrigin.protocol) || siteOrigin.username || siteOrigin.password) throw new Error("NEXT_PUBLIC_SITE_URL must be an HTTP(S) site origin without credentials.");
const title = "Spreadline — Markets, trading & lending";
const description = "Research Stock Token markets, trade with your wallet, and manage Morpho lending on Robinhood Chain.";
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin.origin),
  title, description, applicationName: "Spreadline",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Spreadline" },
  icons: { apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
  openGraph: { type: "website", locale: "en_US", siteName: "Spreadline", title, description, images: [{ url: "/og.png", width: 1200, height: 630, alt: "Spreadline — Markets. Lending. In your hands. Robinhood Chain." }] },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: "#f3f5ed", colorScheme: "light", interactiveWidget: "resizes-content",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><PwaProvider>{children}</PwaProvider></body>
    </html>
  );
}
