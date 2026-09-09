import type { NextConfig } from "next";
import { deploymentConfig } from "./config/deployment";
const deployment = deploymentConfig(process.env);
const nextConfig: NextConfig = {
  ...(deployment.staticExport ? { output: "export" as const } : {}),
  ...(deployment.apiOrigin ? {
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${deployment.apiOrigin}/api/:path*` }];
    },
  } : {}),
  images: { unoptimized: true },
  turbopack: { root: process.cwd() },
  allowedDevOrigins: ["127.0.0.1"],
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
      }
    : {}),
};
export default nextConfig;
