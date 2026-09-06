import {
  createPublicClient,
  parseAbi,
  encodePacked,
  formatUnits,
  zeroAddress,
  type Address,
} from "viem";
import {
  CHAIN_ID,
  PUBLIC_RPC,
  USDG,
  V3_FACTORY,
  V3_QUOTER,
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
import { parseCatalog, parsePrices, parseTradeSize } from "./validation";
import { requestTransport } from "./rpc";
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
) => Promise<{ value: unknown; fetchedAt: string }>;
const now = () => new Date().toISOString();
export function createMarketService(rpcUrl: string, fetchJSON: JSONFetcher) {
  const client = createPublicClient({
    transport: requestTransport(rpcUrl),
  });
  async function catalog(): Promise<Catalog> {
    const source = await fetchJSON("https://api.robinhood.com/rhj/assets", 300);
    return { ...parseCatalog(source.value), fetchedAt: source.fetchedAt };
  }
  async function prices(): Promise<PriceBook> {
    const source = await fetchJSON("https://api.robinhood.com/rhj/prices", 15);
    return { quotes: parsePrices(source.value), fetchedAt: source.fetchedAt };
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
  async function corporateActions(): Promise<CorporateActions> {
    const source = await fetchJSON(
      "https://api.robinhood.com/rhj/corporate-actions",
      3600,
    );
    const raw = source.value;
    if (
      !raw ||
      typeof raw !== "object" ||
      !("corpActions" in raw) ||
      !Array.isArray(raw.corpActions)
    )
      throw new Error("Corporate-action data is unavailable.");
    const items = raw.corpActions
      .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
      .filter(
        (v) =>
          Array.isArray(v.deployments) &&
          v.deployments.some(
            (d) => d && typeof d === "object" && d.chainId === CHAIN_ID,
          ),
      )
      .slice(0, 30)
      .map((v) => {
        const d = v.processDate;
        const date =
          d &&
          typeof d === "object" &&
          "year" in d &&
          "month" in d &&
          "day" in d
            ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
            : null;
        return {
          symbol: String(v.tokenSymbol),
          type: String(v.type).replace("CORPORATE_ACTION_TYPE_", ""),
          status: String(v.status).replace("CORPORATE_ACTION_STATUS_", ""),
          date,
        };
      });
    return { items, fetchedAt: source.fetchedAt };
  }
  return {
    catalog,
    prices,
    network,
    pools,
    quote,
    portfolio,
    corporateActions,
  };
}
