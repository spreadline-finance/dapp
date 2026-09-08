export function deploymentConfig(env: Record<string, string | undefined>) {
  const development = env.NODE_ENV === "development";
  const vercel = env.VERCEL === "1";
  if (development) return { staticExport: false, apiOrigin: "http://127.0.0.1:8787" };
  if (!vercel) return { staticExport: true, apiOrigin: undefined };
  if (!env.SPREADLINE_API_ORIGIN) {
    throw new Error("Set SPREADLINE_API_ORIGIN to your deployed Cloudflare Worker origin in Vercel. The frontend requires a running API.");
  }
  const origin = new URL(env.SPREADLINE_API_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(origin.hostname)) {
    throw new Error("SPREADLINE_API_ORIGIN must be a public HTTPS origin without credentials, paths or query parameters.");
  }
  const site = new URL(env.NEXT_PUBLIC_SITE_URL || "https://spredline.vercel.app");
  if (origin.origin === site.origin || origin.hostname === env.VERCEL_URL || origin.hostname === env.VERCEL_PROJECT_PRODUCTION_URL) {
    throw new Error("SPREADLINE_API_ORIGIN must point to the Worker, not this frontend.");
  }
  return { staticExport: false, apiOrigin: origin.origin };
}
