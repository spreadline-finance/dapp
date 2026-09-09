import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaProvider } from "@/components/pwa";
import { siteOrigin, title, description, openGraph } from "@/lib/site-metadata";
const indexable = process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview";
export const metadata: Metadata = {
  metadataBase: siteOrigin,
  title, description, applicationName: "Spreadline",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Spreadline" },
  alternates: { canonical: "/" },
  icons: { icon: [
    { url: "/icon.svg", type: "image/svg+xml" },
    { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
  ], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
  openGraph: { ...openGraph, url: "/" },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
  robots: { index: indexable, follow: indexable },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  themeColor: "#f3f5ed", colorScheme: "light", interactiveWidget: "resizes-content",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body><PwaProvider>{children}</PwaProvider></body>
    </html>
  );
}
