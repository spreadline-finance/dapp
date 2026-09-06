import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  ...(process.env.NODE_ENV === "development" ? {} : { output: "export" as const }),
  images: { unoptimized: true },
  turbopack: { root: process.cwd() },
  ...(process.env.NODE_ENV === "development"
    ? {
        async headers() {
          return [{ source: "/sw.js", headers: [
            { key: "Cache-Control", value: "no-store, max-age=0" },
            { key: "Content-Type", value: "application/javascript; charset=utf-8" },
            { key: "Service-Worker-Allowed", value: "/" },
            { key: "X-Content-Type-Options", value: "nosniff" },
          ] }];
        },
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: "http://127.0.0.1:8787/api/:path*",
            },
          ];
        },
      }
    : {}),
};
export default nextConfig;
