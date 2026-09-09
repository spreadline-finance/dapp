import {
  createPublicClient,
  parseAbi,
  encodePacked,
  formatUnits,
  toHex,
  zeroAddress,
  BaseError,
  HttpRequestError,
  type Address,
} from "viem";
import {
  CHAIN_ID,
  PUBLIC_RPC,
  USDG,
  V3_FACTORY,
  V3_QUOTER,
  SWAP_ROUTER,
  FEE_TIERS,
  TRACKED_SYMBOLS,
  QUOTE_TTL_MS,
  type Catalog,
  type PriceBook,
  type StockAsset,
  type NetworkState,
  type PoolBook,
  type Pool,
  type QuoteBook,
  type RouteQuote,
  type Portfolio,
  type CorporateActions,
} from "../src/lib/market-types";
import { parseCatalog, parsePrices, parseTradeSize, parseCorporateActions } from "./validation";
import { requestTransport } from "./rpc";
import { approvalAbi, approvalCall, gasETH, minimumOutput, parseSwapAmount, routerAbi, swapCall, TradePreparationError, type SwapQuote, type TradePlan, type TradeSide } from "../src/lib/trading";
import { fullPlannerInputVerified, parsePlannerAmount, plannerSizes, type PositionPlan, type PlannerPosition, type PlannerRoute } from "../src/lib/position-planner";
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
]);
const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns(address)",
]);
const poolAbi = parseAbi([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function liquidity() view returns(uint128)",
  "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
export type JSONFetcher = (
  url: string,
  ttl: number,
) => Promise<{ value: unknown; fetchedAt: string; cached?: boolean }>;
const now = () => new Date().toISOString();
export function createMarketService(rpcUrl: string, fetchJSON: JSONFetcher) {
  const client = createPublicClient({
    transport: requestTransport(rpcUrl),
  });
  async function catalog(): Promise<Catalog> {
    const source = await fetchJSON("https://api.robinhood.com/rhj/assets", 300);
    return { ...parseCatalog(source.value), fetchedAt: source.fetchedAt };
  }
  async function prices(symbols = TRACKED_SYMBOLS): Promise<PriceBook> {
    const quotes: PriceBook["quotes"] = [];
    const unavailableSymbols: string[] = [];
    const cachedSymbols: string[] = [];
    const timestamps: string[] = [];
    let lastError: unknown;
    // The bulk feed has a separate, restrictive quota. Request only the assets
    // on screen, in small batches, and reuse each symbol's source cache.
    for (let offset = 0; offset < symbols.length; offset += 3) {
      const batch = symbols.slice(offset, offset + 3);
      const results = await Promise.allSettled(batch.map(async (symbol) => {
        const source = await fetchJSON(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`, 15);
        const parsed = parsePrices(source.value);
        const quote = parsed.find((q) => q.symbol === symbol);
        if (!quote) throw new Error("No valid quote returned for this symbol.");
        return { quote, fetchedAt: source.fetchedAt, cached: source.cached };
      }));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          quotes.push(result.value.quote);
          timestamps.push(result.value.fetchedAt);
          if (result.value.cached) cachedSymbols.push(batch[index]);
        } else {
          unavailableSymbols.push(batch[index]);
          lastError = result.reason;
        }
      });
    }
    if (!quotes.length) throw lastError ?? new Error("No reference quotes returned.");
    return { quotes, fetchedAt: timestamps.sort()[0], unavailableSymbols, cachedSymbols };
  }
  async function checkedBlock() {
    const [chainId, block] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockTag: "latest" }),
    ]);
    if (chainId !== CHAIN_ID)
      throw new Error("The RPC is connected to the wrong chain.");
    const blockAge = Date.now() - Number(block.timestamp) * 1000;
    if (blockAge > 120000 || blockAge < -10000)
      throw new Error("The latest chain block is stale.");
    return block;
  }
  async function assetFor(symbol: string) {
    const c = await catalog();
    const asset = c.assets.find((a) => a.symbol === symbol && a.active);
    if (!asset)
      throw new Error(
        "This token is not active in the official Robinhood Chain registry.",
      );
    return asset;
  }
  async function network(): Promise<NetworkState> {
    const [block, gas] = await Promise.all([
      checkedBlock(),
      client.getGasPrice(),
    ]);
    return {
      chainId: CHAIN_ID,
      blockNumber: String(block.number),
      blockHash: block.hash,
      blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      gasPriceWei: String(gas),
      fetchedAt: now(),
      provider: rpcUrl === PUBLIC_RPC ? "public" : "dedicated",
      executionEnabled: false,
    };
  }
  async function discover(
    asset: StockAsset,
    blockNumber: bigint,
    decimals: number,
  ) {
    const results = await Promise.allSettled(
      FEE_TIERS.map(async (fee) => {
        const address = await client.readContract({
          address: V3_FACTORY,
          abi: factoryAbi,
          functionName: "getPool",
          args: [asset.address, USDG, fee],
          blockNumber,
        });
        if (address === zeroAddress) return null;
        const [liquidity, slot, token0, token1] = await Promise.all([
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "liquidity",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "slot0",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "token0",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "token1",
            blockNumber,
          }),
        ]);
        const expected = [
          asset.address.toLowerCase(),
          USDG.toLowerCase(),
        ].sort();
        if (
          [token0.toLowerCase(), token1.toLowerCase()].sort().join() !==
          expected.join()
        )
          throw new Error("Pool token mismatch.");
        const stockIs0 = token0.toLowerCase() === asset.address.toLowerCase();
        const ratio = Number(slot[0]) ** 2 / 2 ** 192;
        const price = stockIs0
          ? ratio * 10 ** (asset.decimals - decimals)
          : (1 / ratio) * 10 ** (asset.decimals - decimals);
        return {
          address,
          fee,
          liquidity: String(liquidity),
          priceUSDG: Number.isFinite(price) && price > 0 ? price : null,
          active: liquidity > 0n && slot[0] > 0n && slot[6],
        } satisfies Pool;
      }),
    );
    // A provider outage is not an empty market. Preserve the upstream status so
    // the Worker can apply its cooldown and retain the last verified pool book.
    if (results.every((result) => result.status === "rejected")) {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    return {
      pools: results.flatMap((r) =>
        r.status === "fulfilled" && r.value ? [r.value] : [],
      ),
      failedReads: results.filter((r) => r.status === "rejected").length,
    };
  }
  async function pools(symbol: string): Promise<PoolBook> {
    const [asset, block] = await Promise.all([
      assetFor(symbol),
      checkedBlock(),
    ]);
    const decimals = await client.readContract({
      address: USDG,
      abi: erc20Abi,
      functionName: "decimals",
      blockNumber: block.number,
    });
    return {
      ...(await discover(asset, block.number, decimals)),
      symbol,
      blockNumber: String(block.number),
      blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      fetchedAt: now(),
    };
  }
  async function quote(symbol: string, input: string): Promise<QuoteBook> {
    const [asset, block] = await Promise.all([
      assetFor(symbol),
      checkedBlock(),
    ]);
    const [decimals, code] = await Promise.all([
      client.readContract({
        address: USDG,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: block.number,
      }),
      client.getCode({ address: V3_QUOTER, blockNumber: block.number }),
    ]);
    if (!code || code === "0x")
      throw new Error("The verified Uniswap quoter is unavailable.");
    const amount = parseTradeSize(input, decimals);
    const { pools, failedReads } = await discover(
      asset,
      block.number,
      decimals,
    );
    if (failedReads)
      throw new Error(
        "One or more pool reads failed. Refresh before requesting a quote.",
      );
    const active = pools.filter((p) => p.active);
    const pairs = active.flatMap((buy) =>
      active
        .filter((sell) => sell.address !== buy.address)
        .map((sell) => ({ buy, sell })),
    );
    const results = await Promise.allSettled(
      pairs.map(async ({ buy, sell }) => {
        const path = encodePacked(
          ["address", "uint24", "address", "uint24", "address"],
          [USDG, buy.fee, asset.address, sell.fee, USDG],
        );
        const { result } = await client.simulateContract({
          address: V3_QUOTER,
          abi: quoterAbi,
          functionName: "quoteExactInput",
          args: [path, amount],
          blockNumber: block.number,
        });
        return {
          buyFee: buy.fee,
          sellFee: sell.fee,
          buyPool: buy.address,
          sellPool: sell.address,
          amountOut: formatUnits(result[0], decimals),
          surplus: formatUnits(result[0] - amount, decimals),
          gasUnits: String(result[3]),
          crossedTicks: [...result[2]],
        } satisfies RouteQuote;
      }),
    );
    const routes = results
      .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
      .sort((a, b) => Number(b.surplus) - Number(a.surplus));
    if (Date.now() >= Number(block.timestamp) * 1000 + QUOTE_TTL_MS)
      throw new Error("Quote expired during simulation.");
    const timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
    return {
      symbol,
      amountIn: formatUnits(amount, decimals),
      settlementDecimals: decimals,
      blockNumber: String(block.number),
      blockHash: block.hash,
      blockTimestamp: timestamp,
      fetchedAt: now(),
      expiresAt: new Date(
        Number(block.timestamp) * 1000 + QUOTE_TTL_MS,
      ).toISOString(),
      routes,
      attempted: pairs.length,
      failed: results.filter((r) => r.status === "rejected").length,
      coverage: {
        venue: "Uniswap V3",
        feeTiers: [...FEE_TIERS],
        discoveredPools: pools.length,
        activePools: active.length,
      },
      availability: routes.length ? "quoted" : !pools.length ? "no_pools" : !active.length ? "no_active_pools" : active.length === 1 ? "one_active_pool" : "simulations_failed",
      executionEnabled: false,
    };
  }
  async function portfolio(address: Address): Promise<Portfolio> {
    const [c, block] = await Promise.all([catalog(), checkedBlock()]);
    const tracked = c.assets.filter((a) => TRACKED_SYMBOLS.includes(a.symbol));
    const tokens = [{ symbol: "USDG", address: USDG, decimals: 6 }, ...tracked];
    const [native, balances] = await Promise.all([
      client.getBalance({ address, blockNumber: block.number }),
      Promise.allSettled(
        tokens.map((t) =>
          client.readContract({
            address: t.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
            blockNumber: block.number,
          }),
        ),
      ),
    ]);
    return {
      address,
      blockNumber: String(block.number),
      fetchedAt: now(),
      nativeBalance: formatUnits(native, 18),
      tokens: tokens.map((t, i) => ({
        ...t,
        balance:
          balances[i].status === "fulfilled"
            ? formatUnits(balances[i].value, t.decimals)
            : null,
      })),
    };
  }
  async function swapQuote(symbol: string, side: TradeSide, input: string, slippageBps: number): Promise<SwapQuote> {
    const [asset, block] = await Promise.all([assetFor(symbol), checkedBlock()]);
    const [decimals, stockDecimals, code] = await Promise.all([
      client.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
      client.readContract({ address: asset.address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
      client.getCode({ address: V3_QUOTER, blockNumber: block.number }),
    ]);
    if (decimals !== 6 || stockDecimals !== asset.decimals || !code || code === "0x") throw new Error("Token or quoter verification failed.");
    const tokenIn = side === "buy" ? USDG : asset.address;
    const tokenOut = side === "buy" ? asset.address : USDG;
    const inputDecimals = side === "buy" ? decimals : asset.decimals;
    const outputDecimals = side === "buy" ? asset.decimals : decimals;
    const amount = parseSwapAmount(input, inputDecimals);
    const discovered = await discover(asset, block.number, decimals);
    if (discovered.failedReads) throw new Error("Pool discovery is incomplete.");
    const active = discovered.pools.filter((pool) => pool.active);
    const outcomes = await Promise.allSettled(active.map(async (pool) => {
      const { result } = await client.simulateContract({ address: V3_QUOTER, abi: quoterAbi, functionName: "quoteExactInput", args: [encodePacked(["address", "uint24", "address"], [tokenIn, pool.fee, tokenOut]), amount], blockNumber: block.number });
      const minimum = minimumOutput(result[0], slippageBps);
      const output = formatUnits(result[0], outputDecimals);
      return { fee: pool.fee, pool: pool.address as Address, amountOut: output, amountOutRaw: String(result[0]), minimumOut: formatUnits(minimum, outputDecimals), minimumOutRaw: String(minimum), priceUSDG: side === "buy" ? Number(input) / Number(output) : Number(output) / Number(input) };
    }));
    const routes = outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : []).sort((a, b) => BigInt(a.amountOutRaw) > BigInt(b.amountOutRaw) ? -1 : BigInt(a.amountOutRaw) < BigInt(b.amountOutRaw) ? 1 : 0);
    const expiresAt = new Date(Number(block.timestamp) * 1000 + QUOTE_TTL_MS).toISOString();
    if (Date.now() >= Date.parse(expiresAt)) throw new Error("The quote expired during comparison.");
    return { symbol, side, tokenIn, tokenOut, inputDecimals, outputDecimals, amountIn: formatUnits(amount, inputDecimals), amountInRaw: String(amount), routes, attempted: active.length, failed: outcomes.filter((r) => r.status === "rejected").length, slippageBps, blockNumber: String(block.number), blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), fetchedAt: now(), expiresAt };
  }
  async function positionPlan(symbol: string, side: TradeSide, input: string): Promise<PositionPlan> {
    const [asset, block] = await Promise.all([assetFor(symbol), checkedBlock()]);
    const expiresAt = new Date(Number(block.timestamp) * 1000 + QUOTE_TTL_MS).toISOString();
    const ensureFresh = () => { if (Date.now() >= Date.parse(expiresAt)) throw new TradePreparationError("The size comparison expired. Request fresh quotes."); };
    ensureFresh();
    const [decimals, stockDecimals, code] = await Promise.all([
      client.readContract({ address: USDG, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
      client.readContract({ address: asset.address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
      client.getCode({ address: V3_QUOTER, blockNumber: block.number }),
    ]);
    if (decimals !== 6 || stockDecimals !== asset.decimals || !code || code === "0x") throw new Error("Token or quoter verification failed.");
    const inputDecimals = side === "buy" ? decimals : stockDecimals;
    const outputDecimals = side === "buy" ? stockDecimals : decimals;
    let total: bigint;
    try { total = parsePlannerAmount(input, inputDecimals); }
    catch (error) { throw new TradePreparationError(error instanceof Error ? error.message : "Invalid token amount."); }
    const sizes = plannerSizes(input, inputDecimals);
    const discovered = await discover(asset, block.number, decimals);
    if (discovered.failedReads) throw new Error("Pool discovery is incomplete.");
    const active = discovered.pools.filter((pool) => pool.active);
    const tokenIn = side === "buy" ? USDG : asset.address;
    const tokenOut = side === "buy" ? asset.address : USDG;
    ensureFresh();
    // Each size is an independent alternative against the same original state.
    // No slippage minimum or transaction is constructed for a research quote.
    const rowOutcomes = await Promise.allSettled(sizes.map(async (size): Promise<PositionPlan["rows"][number]> => {
      if (size.amountInRaw === "0") return { ...size, status: "too_small", attempted: 0, failed: 0, routes: [], excludedRoutes: [] };
      const outcomes = await Promise.allSettled(active.map(async (pool): Promise<PlannerRoute | { pool: Address; fee: number; reason: "price_limit" }> => {
        const { result } = await client.simulateContract({
          address: V3_QUOTER, abi: quoterAbi, functionName: "quoteExactInput",
          args: [encodePacked(["address", "uint24", "address"], [tokenIn, pool.fee, tokenOut]), BigInt(size.amountInRaw)],
          blockNumber: block.number,
        });
        if (!fullPlannerInputVerified(tokenIn, tokenOut, result[1])) return { fee: pool.fee, pool: pool.address as Address, reason: "price_limit" };
        if (result[0] <= 0n) throw new Error("No positive output was quoted.");
        return { fee: pool.fee, pool: pool.address as Address, amountOut: formatUnits(result[0], outputDecimals), amountOutRaw: String(result[0]) };
      }));
      // A provider outage is not evidence that a pool lacks a route.
      for (const outcome of outcomes) {
        if (outcome.status !== "rejected" || !(outcome.reason instanceof BaseError)) continue;
        const infrastructure = outcome.reason.walk((cause) => cause instanceof HttpRequestError ||
          (cause !== null && typeof cause === "object" && (("name" in cause && cause.name === "TimeoutError") ||
          ("code" in cause && (cause.code === -32005 || cause.code === 429)))));
        if (infrastructure) throw outcome.reason;
      }
      const routes = outcomes.flatMap((result) => result.status === "fulfilled" && !("reason" in result.value) ? [result.value] : [])
        .sort((a, b) => BigInt(a.amountOutRaw) > BigInt(b.amountOutRaw) ? -1 : BigInt(a.amountOutRaw) < BigInt(b.amountOutRaw) ? 1 : 0);
      const excludedRoutes = outcomes.flatMap((result) => result.status === "fulfilled" && "reason" in result.value ? [result.value] : []);
      const failed = outcomes.filter((result) => result.status === "rejected").length;
      return { ...size, routes, excludedRoutes, attempted: active.length, failed,
        status: routes.length ? "quoted" : !discovered.pools.length ? "no_pools" : !active.length ? "no_active_pools" : failed ? "quotes_unavailable" : "full_size_unavailable" };
    }));
    const failedRow = rowOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedRow?.status === "rejected") throw failedRow.reason;
    const rows = rowOutcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    // A reorg must not leave a comparison labelled as one consistent block.
    const confirmedBlock = await client.getBlock({ blockNumber: block.number });
    if (confirmedBlock.hash !== block.hash) throw new TradePreparationError("The quoted block changed. Request a fresh comparison.");
    ensureFresh();
    return { symbol, stock: asset.address, side, inputDecimals, outputDecimals, amount: formatUnits(total, inputDecimals), amountRaw: String(total),
      rows, blockNumber: String(block.number), blockHash: block.hash, blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), expiresAt, fetchedAt: now(),
      discoveredPools: discovered.pools.length, activePools: active.length, feeTiers: [...FEE_TIERS] };
  }
  async function plannerPosition(symbol: string, address: Address): Promise<PlannerPosition> {
    const [asset, block] = await Promise.all([assetFor(symbol), checkedBlock()]);
    const [decimals, balance] = await Promise.all([
      client.readContract({ address: asset.address, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
      client.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: block.number }),
    ]);
    if (decimals !== asset.decimals) throw new Error("Token decimals could not be verified.");
    return { address, symbol, stock: asset.address, decimals, balance: formatUnits(balance, decimals), blockNumber: String(block.number), blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), fetchedAt: now() };
  }
  async function tradePlan(symbol: string, side: TradeSide, input: string, slippageBps: number, account: Address): Promise<TradePlan> {
    const quote = await swapQuote(symbol, side, input, slippageBps);
    if (!quote.routes.length || quote.failed) throw new TradePreparationError("A complete route comparison is required before preparing a trade. Try another amount or check broader routing on Uniswap.");
    const [routerCode, factory, balance, native, allowance, gasPrice] = await Promise.all([
      client.getCode({ address: SWAP_ROUTER }),
      client.readContract({ address: SWAP_ROUTER, abi: routerAbi, functionName: "factory" }),
      client.readContract({ address: quote.tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.getBalance({ address: account }),
      client.readContract({ address: quote.tokenIn, abi: approvalAbi, functionName: "allowance", args: [account, SWAP_ROUTER] }),
      client.getGasPrice(),
    ]);
    if (!routerCode || routerCode === "0x" || factory.toLowerCase() !== V3_FACTORY.toLowerCase()) throw new TradePreparationError("The swap router could not be verified. Wallet submission is disabled.");
    if (Date.now() >= Date.parse(quote.expiresAt)) throw new TradePreparationError("The trade preview expired during checks. Prepare a fresh trade.");
    const base: Omit<TradePlan, "status"> = { quote, account, chainId: CHAIN_ID, inputBalance: formatUnits(balance, quote.inputDecimals), nativeBalance: formatUnits(native, 18), allowance: formatUnits(allowance, quote.inputDecimals), expiresAt: quote.expiresAt };
    if (balance < BigInt(quote.amountInRaw)) return { ...base, status: "insufficient_balance" };
    if (native === 0n) return { ...base, status: "insufficient_gas" };
    const needsApproval = allowance < BigInt(quote.amountInRaw);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const to = needsApproval ? quote.tokenIn : SWAP_ROUTER;
    const data = needsApproval ? approvalCall(quote) : swapCall(quote, account, deadline);
    const request = { account, to, data, value: 0n };
    // Simulate the real sender and calldata; no synthetic balance/allowance overrides.
    if (needsApproval) {
      const simulation = await client.simulateContract({ account, address: to, abi: approvalAbi, functionName: "approve", args: [SWAP_ROUTER, BigInt(quote.amountInRaw)] });
      if (!simulation.result) throw new TradePreparationError("The token rejected the approval simulation. No approval was submitted.");
    } else await client.call(request);
    const gas = (await client.estimateGas(request)) * 120n / 100n;
    if (Date.now() >= Date.parse(quote.expiresAt)) throw new TradePreparationError("The trade preview expired during checks. Prepare a fresh trade.");
    if (native < gas * gasPrice) return { ...base, status: "insufficient_gas", gasEstimateETH: gasETH(gas, gasPrice) };
    return { ...base, status: needsApproval ? "approval_required" : "ready", gasEstimateETH: gasETH(gas, gasPrice), deadline: needsApproval ? undefined : deadline, transaction: { from: account, to, data, value: "0x0", gas: toHex(gas) } };
  }
  async function corporateActions(): Promise<CorporateActions> {
    const source = await fetchJSON(
      "https://api.robinhood.com/rhj/corporate-actions",
      3600,
    );
    return { items: parseCorporateActions(source.value), fetchedAt: source.fetchedAt };
  }

  return {
    catalog,
    prices,
    network,
    pools,
    quote,
    portfolio,
    corporateActions,
    swapQuote,
    positionPlan,
    plannerPosition,
    tradePlan,
  };
}
