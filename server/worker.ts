import { consumeBudget } from "./rate-limit";
import { createMarketService } from "./market-service";
import { createDeskService, deskScheduledSymbol, readDeskHistory, recordDeskObservation } from "./desk-service";
import { createLendingService } from "./lending-service";
import { createLendingExecutionService } from "./lending-execution-service";
import { discoverLendingPositions } from "./lending-positions-service";
import { LendingPreparationError, validLendingId, type LendingKind, type LendingIntent } from "../src/lib/lending-execution";
import { parseSymbol, validWallet, parseTradeSize, parsePrices, quoteIsFresh } from "./validation";
import { PUBLIC_RPC, TRACKED_SYMBOLS } from "../src/lib/market-types";
import { parseSwapAmount, TradePreparationError, type TradeSide } from "../src/lib/trading";
import { parsePlannerAmount } from "../src/lib/position-planner";
const MAX_BYTES = 2_000_000;
class UpstreamError extends Error {
  constructor(readonly status: number, readonly retryAfter = 60) {
    super("upstream_unavailable");
    this.name = "UpstreamError";
  }
}
export async function readBoundedJSON(response: Response): Promise<unknown> {
  if (!response.ok) throw new UpstreamError(response.status, Math.max(30, Math.min(300, Number(response.headers.get("retry-after")) || 60)));
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
    retryAfter?: number;
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
      retryAfter: item.headers instanceof Headers && item.headers.has("retry-after")
        ? Math.min(300, Math.max(1, Number(item.headers.get("retry-after")) || 60)) : undefined,
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
      "/api/swap-quote",
      "/api/trade-plan",
      "/api/position-plan",
      "/api/planner-position",
      "/api/lending/markets",
      "/api/lending/vaults",
      "/api/lending/history",
      "/api/lending/position",
      "/api/lending/positions",
      "/api/lending/plan",
      "/api/desk",
      "/api/desk/pools",
      "/api/desk/history",
    ]);
    if (!allowed.has(url.pathname))
      return json({ error: "Endpoint not found." }, 404);
    const permitted: Record<string, string[]> = {
      "/api/prices": ["symbols"],
      "/api/pools": ["symbol"],
      "/api/quote": ["symbol", "amount"],
      "/api/swap-quote": ["symbol", "side", "amount", "slippageBps"],
      "/api/trade-plan": ["symbol", "side", "amount", "slippageBps", "address"],
      "/api/position-plan": ["symbol", "side", "amount"],
      "/api/planner-position": ["symbol", "address"],
      "/api/portfolio": ["address"],
      "/api/lending/history": ["market"],
      "/api/lending/positions": ["address"],
      "/api/lending/position": ["kind", "id", "address", "minBlock"],
      "/api/lending/plan": ["kind", "id", "address", "operation", "amount", "all", "slippageBps", "minBlock"],
      "/api/desk": ["address"],
      "/api/desk/pools": ["symbol"],
      "/api/desk/history": ["symbol"],
    };
    if (
      [...url.searchParams.keys()].some(
        (k) => !(permitted[url.pathname] || []).includes(k),
      )
    )
      return json({ error: "Unsupported query parameter." }, 400);
    if (["/api/position-plan", "/api/planner-position", "/api/desk", "/api/desk/pools", "/api/desk/history"].includes(url.pathname) &&
        [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1))
      return json({ error: "Duplicate query parameters are not supported." }, 400);
    const isSwap = ["/api/swap-quote", "/api/trade-plan"].includes(url.pathname);
    const isPlanner = url.pathname === "/api/position-plan";
    const isLendingPrivate = ["/api/lending/position", "/api/lending/plan", "/api/lending/positions"].includes(url.pathname);
    const isDeskPrivate = url.pathname === "/api/desk" && url.searchParams.has("address");
    const needsAddress = ["/api/portfolio", "/api/trade-plan", "/api/planner-position"].includes(url.pathname) || isLendingPrivate || isDeskPrivate;
    const privateRead = needsAddress || isPlanner;
    let lendingKind: LendingKind = "market", lendingId = "", minBlock = 0n;
    let lendingIntent: LendingIntent | undefined;
    let side: TradeSide = "buy", slippageBps = 50;
    let lendingMarket = "";
    let symbols = TRACKED_SYMBOLS;
    let symbol = "",
      amount = "",
      address: ReturnType<typeof validWallet> | undefined;
    try {
      if (isLendingPrivate && url.pathname !== "/api/lending/positions") {
        const kind = url.searchParams.get("kind");
        if (kind !== "market" && kind !== "vault") throw new Error("Choose a market or vault.");
        lendingKind = kind; lendingId = url.searchParams.get("id") ?? "";
        if (!validLendingId(kind, lendingId)) throw new Error("Choose a valid lending contract.");
        const rawBlock = url.searchParams.get("minBlock") ?? "0";
        if (!/^\d{1,16}$/.test(rawBlock)) throw new Error("Invalid block.");
        minBlock = BigInt(rawBlock);
        if (url.pathname === "/api/lending/plan") {
          const operation = url.searchParams.get("operation"), value = url.searchParams.get("amount") ?? "", all = url.searchParams.get("all") ?? "false", slip = url.searchParams.get("slippageBps") ?? "50";
          if (operation !== "deposit" && operation !== "withdraw") throw new Error("Choose deposit or withdraw.");
          if (all !== "true" && all !== "false" || all === "true" && operation !== "withdraw") throw new Error("Invalid withdraw-all option.");
          if (!/^\d{1,8}(\.\d{1,18})?$/.test(value)) throw new Error("Enter a valid token amount.");
          if (!/^\d{1,3}$/.test(slip) || Number(slip) < 1 || Number(slip) > 100) throw new Error("Choose slippage between 0.01% and 1%.");
          lendingIntent = { kind, id: lendingId, operation, amount: value, all: all === "true", slippageBps: Number(slip) };
        }
      }
      if (url.pathname === "/api/lending/history") {
        lendingMarket = url.searchParams.get("market") ?? "";
        if (!/^0x[\da-f]{64}$/i.test(lendingMarket)) throw new Error("Choose a valid Morpho market.");
        lendingMarket = lendingMarket.toLowerCase();
        url.searchParams.set("market", lendingMarket);
      }
      if (url.pathname === "/api/prices") {
        const raw = url.searchParams.get("symbols");
        if (raw !== null) {
          symbols = [...new Set(raw.split(",").map((value) => parseSymbol(value)))].sort();
          if (!symbols.length || symbols.length > 16) throw new Error("Request between 1 and 16 symbols.");
          url.searchParams.set("symbols", symbols.join(","));
        }
      }
      if (url.pathname === "/api/pools" || url.pathname === "/api/quote" || isSwap || isPlanner || url.pathname === "/api/planner-position" || url.pathname === "/api/desk/pools" || url.pathname === "/api/desk/history")
        symbol = parseSymbol(url.searchParams.get("symbol"));
      if (isPlanner) {
        const rawSide = url.searchParams.get("side");
        if (rawSide !== "buy" && rawSide !== "sell") throw new Error("Choose buy or sell.");
        side = rawSide;
        amount = url.searchParams.get("amount") ?? "";
        parsePlannerAmount(amount, side === "buy" ? 6 : 18);
      }
      if (url.pathname === "/api/quote") {
        amount = url.searchParams.get("amount") || "";
        parseTradeSize(amount, 6);
      }
      if (isSwap) {
        const rawSide = url.searchParams.get("side");
        if (rawSide !== "buy" && rawSide !== "sell") throw new Error("Choose buy or sell.");
        side = rawSide;
        amount = url.searchParams.get("amount") || "";
        parseSwapAmount(amount, 6);
        const rawSlippage = url.searchParams.get("slippageBps") ?? "50";
        if (!/^\d{1,3}$/.test(rawSlippage)) throw new Error("Invalid slippage.");
        slippageBps = Number(rawSlippage);
        if (slippageBps < 1 || slippageBps > 100) throw new Error("Slippage must be between 0.01% and 1%.");
      }
      if (needsAddress)
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
        mode: "market-data-and-wallet-trading",
        walletTradingEnabled: true,
        walletLendingEnabled: true,
        deskVaultConfigured: Boolean(env.DESK_VAULT_ADDRESS && env.DESK_VAULT_CODE_HASH),
        chainId: 4663,
        executionEnabled: false,
        rpcTier:
          (env.ROBINHOOD_RPC_URL || PUBLIC_RPC) === PUBLIC_RPC
            ? "public"
            : "dedicated",
      });
    let cache: Cache | undefined;
    const cacheKey = new Request(new URL("/__response-v2/" + encodeURIComponent(url.pathname + url.search), url.origin));
    const snapshotKey = new Request(new URL("/__last-good/" + encodeURIComponent(url.pathname + url.search), url.origin));
    const failureKey = new Request(new URL("/__cooldown/" + encodeURIComponent(url.pathname + url.search), url.origin));
    const retention: Record<string, number> = {
      "/api/catalog": 86400, "/api/prices": 21600, "/api/network": 300,
      "/api/pools": 300, "/api/corporate-actions": 86400,
      "/api/lending/markets": 900, "/api/lending/vaults": 900, "/api/lending/history": 1800,
      "/api/desk/pools": 300,
    };
    async function unavailable(status: number, retryAfter: number, message: string) {
      const retryAt = new Date(Date.now() + retryAfter * 1000).toISOString();
      if (cache && retention[url.pathname]) {
        const snapshot = await cache.match(snapshotKey);
        if (snapshot) {
          const data = await snapshot.json<Record<string, unknown>>();
          return json({ ...data, dataStatus: { state: "cached", reason: message, retryAt } });
        }
      }
      const response = json({ error: message }, status);
      response.headers.set("retry-after", String(retryAfter));
      return response;
    }
    try {
      // Namespaced Workers cannot access the shared default cache.
      cache = await caches.open("spreadline-live-v1");
      const activeCache = cache;
      if (!privateRead) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          if (url.pathname !== "/api/quote" && url.pathname !== "/api/swap-quote") return hit;
          const quoted = await hit.clone().json<{ expiresAt: string }>();
          if (quoteIsFresh(quoted.expiresAt)) return hit;
        }
      }
      const cooldown = isLendingPrivate || isPlanner || url.pathname === "/api/planner-position" ? undefined : await cache.match(failureKey);
      if (cooldown) {
        const saved = await cooldown.json<{ status: number; retryAt: number; message: string }>();
        if (saved.retryAt > Date.now()) return unavailable(saved.status, Math.ceil((saved.retryAt - Date.now()) / 1000), saved.message);
      }
      async function fetchJSON(upstream: string, ttl: number) {
        const key = new Request(
          new URL(
            "/__source-cache/" + encodeURIComponent(upstream),
            url.origin,
          ),
        );
        const hit = await activeCache.match(key);
        if (hit)
          return hit.json() as Promise<{ value: unknown; fetchedAt: string }>;
        const sourceFailureKey = new Request(new URL("/__source-cooldown/" + encodeURIComponent(upstream), url.origin));
        const sourceSnapshotKey = new Request(new URL("/__source-last-good/" + encodeURIComponent(upstream), url.origin));
        // Price observations may be retained with their original source time.
        // Registry metadata used for live quotes must still be fresh.
        const canRetain = upstream.startsWith("https://api.robinhood.com/rhj/prices/");
        async function lastPrice() {
          const previous = canRetain ? await activeCache.match(sourceSnapshotKey) : undefined;
          if (!previous) return;
          const saved = await previous.json<{ value: unknown; fetchedAt: string }>();
          return { ...saved, cached: true };
        }
        const cooling = await activeCache.match(sourceFailureKey);
        if (cooling) {
          const saved = await cooling.json<{ status: number; retryAt: number }>();
          if (saved.retryAt > Date.now()) {
            const previous = await lastPrice();
            if (previous) return previous;
            throw new UpstreamError(saved.status, Math.ceil((saved.retryAt - Date.now()) / 1000));
          }
        }
        try {
          const response = await fetch(upstream, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          const data = await readBoundedJSON(response);
          if (canRetain && !parsePrices(data).some((quote) => quote.symbol === decodeURIComponent(new URL(upstream).pathname.split("/").pop()!))) {
            throw new UpstreamError(503);
          }
          const payload = { value: data, fetchedAt: new Date().toISOString() };
          await activeCache.put(key, json(payload, 200, ttl));
          if (canRetain) await activeCache.put(sourceSnapshotKey, json(payload, 200, 21600));
          return payload;
        } catch (error) {
          const status = error instanceof UpstreamError ? error.status : 503;
          const seconds = error instanceof UpstreamError ? error.retryAfter : 60;
          await activeCache.put(sourceFailureKey, json({ status, retryAt: Date.now() + seconds * 1000 }, 200, seconds));
          const previous = await lastPrice();
          if (previous) return previous;
          throw error;
        }
      }
      const service = createMarketService(
        env.ROBINHOOD_RPC_URL || PUBLIC_RPC,
        fetchJSON,
      );
      const lending = createLendingService(readBoundedJSON);
      if (
        ["/api/quote", "/api/pools", "/api/portfolio", "/api/lending/history", "/api/planner-position", "/api/desk", "/api/desk/pools", "/api/desk/history"].includes(url.pathname) || isSwap || isLendingPrivate || isPlanner
      ) {
        const budget = await consumeBudget(
          env.SPREADLINE_DB,
          request.headers.get("cf-connecting-ip") || "local",
          isSwap ? "/api/swap-quote" : url.pathname,
          isPlanner ? 4 : url.pathname === "/api/quote" || isSwap
            ? 10
            : url.pathname === "/api/pools"
              ? 40
              : url.pathname === "/api/lending/history" ? 20 : 10,
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
        case "/api/desk":
          data = await createDeskService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, env, service).snapshot(address);
          ttl = isDeskPrivate ? 0 : 15;
          break;
        case "/api/desk/pools":
          data = await createDeskService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, env, service).pools(symbol);
          ttl = 30;
          break;
        case "/api/desk/history":
          data = await readDeskHistory(env.SPREADLINE_DB, symbol);
          ttl = 60;
          break;
        case "/api/position-plan":
          data = await service.positionPlan(symbol, side, amount);
          break;
        case "/api/planner-position":
          data = await service.plannerPosition(symbol, address!);
          break;
        case "/api/lending/positions":
          data = await discoverLendingPositions(address!, readBoundedJSON);
          break;
        case "/api/lending/position":
          data = await createLendingExecutionService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, lending).position(lendingKind, lendingId, address!, minBlock);
          break;
        case "/api/lending/plan":
          data = await createLendingExecutionService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, lending).plan(lendingIntent!, address!, minBlock);
          break;
        case "/api/lending/markets":
          data = await lending.markets();
          ttl = 120;
          break;
        case "/api/lending/vaults":
          data = await lending.vaults();
          ttl = 120;
          break;
        case "/api/lending/history":
          data = await lending.history(lendingMarket);
          ttl = 300;
          break;
        case "/api/catalog":
          data = await service.catalog();
          ttl = 300;
          break;
        case "/api/prices":
          data = await service.prices(symbols);
          ttl = 45;
          break;
        case "/api/network":
          data = await service.network();
          ttl = 15;
          break;
        case "/api/pools":
          data = await service.pools(symbol);
          ttl = 30;
          break;
        case "/api/quote":
          data = await service.quote(symbol, amount);
          ttl = 3;
          break;
        case "/api/swap-quote":
          data = await service.swapQuote(symbol, side, amount, slippageBps);
          ttl = 3;
          break;
        case "/api/trade-plan":
          data = await service.tradePlan(symbol, side, amount, slippageBps, address!);
          break;
        case "/api/portfolio":
          data = await service.portfolio(address!);
          break;
        case "/api/corporate-actions":
          data = await service.corporateActions();
          ttl = 3600;
          break;
        default:
          return json({ error: "Endpoint not found." }, 404);
      }
      const response = json(data, 200, ttl);
      if (ttl) await cache.put(cacheKey, response.clone());
      if (retention[url.pathname]) ctx.waitUntil(cache.put(snapshotKey, json(data, 200, retention[url.pathname])));
      return response;
    } catch (error) {
      const causes = errorCauses(error);
      if (error instanceof TradePreparationError || error instanceof LendingPreparationError) return json({ error: error.message }, 422);
      if ((url.pathname === "/api/trade-plan" || url.pathname === "/api/lending/plan") && causes.some((cause) => cause.name === "ContractFunctionRevertedError" || cause.name === "ExecutionRevertedError")) {
        return json({ error: "The transaction simulation reverted. Check the amount, allowance, liquidity and access restrictions before preparing again. Nothing was submitted." }, 422);
      }
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
      const status = causes.some((cause) => cause.status === 429 || cause.code === 429 || cause.code === -32005) ? 429 : 503;
      const seconds = error instanceof UpstreamError ? error.retryAfter : Math.max(60, ...causes.map((cause) => cause.retryAfter ?? 0));
      const message = isPlanner ? status === 429
        ? "The quote provider is cooling down. Please wait before comparing again."
        : "The quote provider did not respond. Please wait, then refresh the comparison."
        : status === 429
        ? "The provider is cooling down. Automatic updates will resume shortly."
        : "The provider did not respond. Automatic updates will resume shortly.";
      if (cache && !privateRead) {
        await cache.put(failureKey, json({ status, retryAt: Date.now() + seconds * 1000, message }, 200, seconds));
      }
      return unavailable(status, seconds, message);
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const sources = new Map<string, Promise<{ value: unknown; fetchedAt: string }>>();
    const service = createMarketService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, async (upstream) => {
      const previous = sources.get(upstream);
      if (previous) return previous;
      const read = (async () => {
        const response = await fetch(upstream, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        return { value: await readBoundedJSON(response), fetchedAt: new Date().toISOString() };
      })();
      sources.set(upstream, read);
      return read;
    });
    const desk = createDeskService(env.ROBINHOOD_RPC_URL || PUBLIC_RPC, env, service);
    const symbol = deskScheduledSymbol(controller.scheduledTime);
    const [pools, snapshot] = await Promise.allSettled([desk.pools(symbol), desk.snapshot()]);
    if (pools.status === "rejected" || snapshot.status === "rejected")
      console.error(JSON.stringify({ event: "desk_recording_partial", symbol, poolsRead: pools.status, vaultRead: snapshot.status }));
    await recordDeskObservation(env.SPREADLINE_DB, pools.status === "fulfilled" ? pools.value : null, snapshot.status === "fulfilled" ? snapshot.value : null);
    console.info(JSON.stringify({ event: "desk_recorded", symbol, pools: pools.status === "fulfilled" ? pools.value.pools.length : 0,
      failedPoolReads: pools.status === "fulfilled" ? pools.value.failedReads : null,
      vaultStatus: snapshot.status === "fulfilled" ? snapshot.value.status : "unavailable" }));
  },
} satisfies ExportedHandler<Env>;
