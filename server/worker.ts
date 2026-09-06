import { consumeBudget } from "./rate-limit";
import { createMarketService } from "./market-service";
import { parseSymbol, validWallet, parseTradeSize } from "./validation";
import { PUBLIC_RPC } from "../src/lib/market-types";
const MAX_BYTES = 2_000_000;
class UpstreamError extends Error {
  constructor(readonly status: number) {
    super("upstream_unavailable");
    this.name = "UpstreamError";
  }
}
export async function readBoundedJSON(response: Response): Promise<unknown> {
  if (!response.ok) throw new UpstreamError(response.status);
  if (Number(response.headers.get("content-length") || 0) > MAX_BYTES)
    throw new Error("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function json(value: unknown, status = 200, ttl = 0) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ttl ? `public, max-age=${ttl}` : "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
function errorCauses(error: unknown) {
  const causes: {
    name: string;
    code?: number;
    status?: number;
    summary?: string;
  }[] = [];
  let current = error;
  for (
    let depth = 0;
    depth < 6 && current && typeof current === "object";
    depth++
  ) {
    const item = current as Record<string, unknown>;
    causes.push({
      name: typeof item.name === "string" ? item.name.slice(0, 60) : "Unknown",
      code: typeof item.code === "number" ? item.code : undefined,
      status: typeof item.status === "number" ? item.status : undefined,
      summary:
        typeof item.shortMessage === "string"
          ? item.shortMessage
              .replace(/https?:\/\/[^\s]+/g, "[endpoint]")
              .slice(0, 160)
          : undefined,
    });
    current = item.cause;
  }
  return causes;
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET")
      return json({ error: "Only read-only GET requests are supported." }, 405);
    if (url.search.length > 350)
      return json({ error: "Invalid request." }, 400);
    const allowed = new Set([
      "/api/catalog",
      "/api/prices",
      "/api/network",
      "/api/pools",
      "/api/quote",
      "/api/portfolio",
      "/api/corporate-actions",
      "/api/health",
    ]);
    if (!allowed.has(url.pathname))
      return json({ error: "Endpoint not found." }, 404);
    const permitted: Record<string, string[]> = {
      "/api/pools": ["symbol"],
      "/api/quote": ["symbol", "amount"],
      "/api/portfolio": ["address"],
    };
    if (
      [...url.searchParams.keys()].some(
        (k) => !(permitted[url.pathname] || []).includes(k),
      )
    )
      return json({ error: "Unsupported query parameter." }, 400);
    let symbol = "",
      amount = "",
      address: ReturnType<typeof validWallet> | undefined;
    try {
      if (url.pathname === "/api/pools" || url.pathname === "/api/quote")
        symbol = parseSymbol(url.searchParams.get("symbol"));
      if (url.pathname === "/api/quote") {
        amount = url.searchParams.get("amount") || "";
        parseTradeSize(amount, 6);
      }
      if (url.pathname === "/api/portfolio")
        address = validWallet(url.searchParams.get("address"));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid request." },
        400,
      );
    }
    if (url.pathname === "/api/health")
      return json({
        status: "ok",
        mode: "live-read-only",
        chainId: 4663,
        executionEnabled: false,
        rpcTier:
          (env.ROBINHOOD_RPC_URL || PUBLIC_RPC) === PUBLIC_RPC
            ? "public"
            : "dedicated",
      });
    try {
      // Namespaced Workers cannot access the shared default cache.
      const cache = await caches.open("spreadline-live-v1");
      const cacheKey = new Request(url.toString());
      const privateRead = url.pathname === "/api/portfolio";
      if (!privateRead) {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
      }
      async function fetchJSON(upstream: string, ttl: number) {
        const key = new Request(
          new URL(
            "/__source-cache/" + encodeURIComponent(upstream),
            url.origin,
          ),
        );
        const hit = await cache.match(key);
        if (hit)
          return hit.json() as Promise<{ value: unknown; fetchedAt: string }>;
        const response = await fetch(upstream, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        });
        const data = await readBoundedJSON(response);
        const payload = { value: data, fetchedAt: new Date().toISOString() };
        const cached = json(payload, 200, ttl);
        ctx.waitUntil(cache.put(key, cached));
        return payload;
      }
      const service = createMarketService(
        env.ROBINHOOD_RPC_URL || PUBLIC_RPC,
        fetchJSON,
      );
      if (
        ["/api/quote", "/api/pools", "/api/portfolio"].includes(url.pathname)
      ) {
        const budget = await consumeBudget(
          env.SPREADLINE_DB,
          request.headers.get("cf-connecting-ip") || "local",
          url.pathname,
          url.pathname === "/api/quote"
            ? 10
            : url.pathname === "/api/pools"
              ? 40
              : 10,
        );
        if (!budget.allowed) {
          const denied = json(
            {
              error:
                "Request limit reached. Please wait before refreshing this data.",
            },
            429,
          );
          denied.headers.set("retry-after", String(budget.retryAfter));
          return denied;
        }
        ctx.waitUntil(
          env.SPREADLINE_DB.prepare(
            "DELETE FROM request_budgets WHERE key IN (SELECT key FROM request_budgets WHERE window_start < ? LIMIT 100)",
          )
            .bind(Math.floor(Date.now() / 1000) - 86400)
            .run(),
        );
      }
      let data: unknown;
      let ttl = 0;
      switch (url.pathname) {
        case "/api/catalog":
          data = await service.catalog();
          break;
        case "/api/prices":
          data = await service.prices();
          break;
        case "/api/network":
          data = await service.network();
          ttl = 3;
          break;
        case "/api/pools":
          data = await service.pools(symbol);
          ttl = 10;
          break;
        case "/api/quote":
          data = await service.quote(symbol, amount);
          ttl = 3;
          break;
        case "/api/portfolio":
          data = await service.portfolio(address!);
          break;
        case "/api/corporate-actions":
          data = await service.corporateActions();
          break;
        default:
          return json({ error: "Endpoint not found." }, 404);
      }
      const response = json(data, 200, ttl);
      if (ttl) ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      const causes = errorCauses(error);
      console.error(
        JSON.stringify({
          event: "data_request_failed",
          path: url.pathname,
          errorType: error instanceof Error ? error.name : "Unknown",
          upstreamStatus:
            error instanceof UpstreamError ? error.status : undefined,
          causes,
          requestId: crypto.randomUUID(),
        }),
      );
      if (causes.some((cause) => cause.status === 429 || cause.code === 429)) {
        const limited = json(
          {
            error:
              "The market data provider is rate-limiting requests. Please wait before trying again.",
          },
          429,
        );
        limited.headers.set("retry-after", "30");
        return limited;
      }
      return json(
        {
          error:
            "The live data source is temporarily unavailable. Please retry. No simulated values have been substituted.",
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
