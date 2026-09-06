import { z } from "zod";
import { CHAIN_ID } from "../src/lib/market-types";
import type { LendingMarket, LendingMarkets, LendingVault, LendingVaults, LendingHistory } from "../src/lib/lending";

const address = z.string().regex(/^0x[\da-f]{40}$/i);
const marketId = z.string().regex(/^0x[\da-f]{64}$/i);
const asset = z.object({ address, symbol: z.string().min(1).max(40), decimals: z.number().int().min(0).max(36) });
const metric = z.number().finite().nonnegative().nullable();
const apy = z.number().finite().min(-1).max(1000).nullable();
const warnings = z.array(z.object({ type: z.string().max(100), level: z.string().max(30) })).max(50);
const chain = z.object({ id: z.literal(CHAIN_ID) });
const page = z.object({ items: z.array(z.unknown()).max(200), pageInfo: z.object({ countTotal: z.number().int().nonnegative() }) });
const market = z.object({
  marketId, listed: z.boolean(), morphoBlue: z.object({ chain }),
  lltv: z.string().regex(/^\d+$/).refine((value) => BigInt(value) <= 10n ** 18n),
  loanAsset: asset, collateralAsset: asset.nullable(), warnings,
  state: z.object({ timestamp: z.number().int().positive(), supplyApy: apy, borrowApy: apy,
    supplyAssetsUsd: metric, borrowAssetsUsd: metric, liquidityAssetsUsd: metric,
    utilization: z.number().finite().min(0).max(1).nullable(),
  }).nullable(),
});
const vaultBase = { address, name: z.string().min(1).max(160), listed: z.literal(true), asset, chain, warnings };
const gate = z.object({ address: address.nullable() });
const vaultV2 = z.object({ ...vaultBase,
  netApyExcludingRewards: apy, totalAssetsUsd: metric, liquidityUsd: metric,
  performanceFee: metric, managementFee: metric,
  curators: z.object({ items: z.array(z.object({ name: z.string().max(120) })).max(30) }),
  gatesConfig: z.object({ receiveSharesGate: gate, receiveAssetsGate: gate, sendSharesGate: gate, sendAssetsGate: gate }),
});
const vaultV1 = z.object({ ...vaultBase,
  state: z.object({ netApyExcludingRewards: apy, totalAssetsUsd: metric, fee: metric,
    curators: z.array(z.object({ name: z.string().max(120) })).max(30),
  }).nullable(), liquidity: z.object({ usd: metric }).nullable(),
});

export function parseLendingMarkets(value: unknown, fetchedAt = new Date().toISOString()): LendingMarkets {
  const raw = page.parse(value);
  let rejected = 0;
  const seen = new Set<string>();
  const markets: LendingMarket[] = [];
  for (const item of raw.items) {
    const parsed = market.safeParse(item);
    if (!parsed.success) { rejected++; continue; }
    const m = parsed.data;
    if (seen.has(m.marketId.toLowerCase())) continue;
    seen.add(m.marketId.toLowerCase());
    markets.push({ id: m.marketId, listed: m.listed, loan: m.loanAsset, collateral: m.collateralAsset,
      lltv: Number(m.lltv) / 1e18, warnings: m.warnings,
      supplyApy: m.state?.supplyApy ?? null, borrowApy: m.state?.borrowApy ?? null,
      suppliedUsd: m.state?.supplyAssetsUsd ?? null, borrowedUsd: m.state?.borrowAssetsUsd ?? null,
      liquidityUsd: m.state?.liquidityAssetsUsd ?? null, utilization: m.state?.utilization ?? null,
      updatedAt: m.state ? new Date(m.state.timestamp * 1000).toISOString() : null,
    });
  }
  if (raw.items.length && !markets.length) throw new Error("Morpho returned no valid Robinhood Chain markets.");
  return { markets, total: raw.pageInfo.countTotal, rejected, fetchedAt };
}
export function parseLendingVaults(value: unknown, fetchedAt = new Date().toISOString()): LendingVaults {
  const raw = z.object({ vaultV2s: page, vaults: page }).parse(value);
  const vaults: LendingVault[] = [];
  let rejected = 0;
  for (const item of raw.vaultV2s.items) {
    const parsed = vaultV2.safeParse(item);
    if (!parsed.success) { rejected++; continue; }
    const v = parsed.data;
    vaults.push({ address: v.address, name: v.name, version: 2, asset: v.asset,
      netApy: v.netApyExcludingRewards, suppliedUsd: v.totalAssetsUsd, liquidityUsd: v.liquidityUsd,
      performanceFee: v.performanceFee, managementFee: v.managementFee,
      curators: v.curators.items.map((curator) => curator.name), warnings: v.warnings,
      gated: Object.values(v.gatesConfig).some((g) => !!g.address && !/^0x0{40}$/i.test(g.address)),
    });
  }
  for (const item of raw.vaults.items) {
    const parsed = vaultV1.safeParse(item);
    if (!parsed.success) { rejected++; continue; }
    const v = parsed.data;
    vaults.push({ address: v.address, name: v.name, version: 1, asset: v.asset,
      netApy: v.state?.netApyExcludingRewards ?? null, suppliedUsd: v.state?.totalAssetsUsd ?? null,
      liquidityUsd: v.liquidity?.usd ?? null, performanceFee: v.state?.fee ?? null, managementFee: null,
      curators: v.state?.curators.map((curator) => curator.name) ?? [], warnings: v.warnings, gated: false,
    });
  }
  if (rejected && !vaults.length) throw new Error("Morpho returned no valid listed Robinhood Chain vaults.");
  return { vaults, total: raw.vaultV2s.pageInfo.countTotal + raw.vaults.pageInfo.countTotal, rejected, fetchedAt };
}
export function parseLendingHistory(value: unknown, expectedId: string, fetchedAt = new Date().toISOString()): LendingHistory {
  const raw = z.object({ marketId, historicalState: z.object({ supplyApy: z.array(z.object({ x: z.number().int().positive(), y: apy })).max(100) }) }).parse(value);
  if (raw.marketId.toLowerCase() !== expectedId.toLowerCase()) throw new Error("Mismatched lending history.");
  const cutoff = Date.parse(fetchedAt) - 8 * 86400000;
  const points = [...new Map(raw.historicalState.supplyApy.filter((p) => p.y !== null && p.x * 1000 >= cutoff && p.x * 1000 <= Date.parse(fetchedAt)).map((p) => [p.x, { time: p.x * 1000, apy: p.y! }])).values()].sort((a, b) => a.time - b.time);
  return { marketId: raw.marketId, points, fetchedAt };
}

const MARKETS_QUERY = `query SpreadlineLendingMarkets {
  markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc, where:{chainId_in:[4663]}) {
    pageInfo { countTotal } items { marketId listed morphoBlue { chain { id } } lltv
      loanAsset { address symbol decimals } collateralAsset { address symbol decimals }
      state { timestamp supplyApy borrowApy supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      warnings { type level }
    }
  }
}`;
const VAULTS_QUERY = `query SpreadlineLendingVaults {
  vaultV2s(first:50,where:{chainId_in:[4663],listed:true}) {
    pageInfo{countTotal} items { address name listed asset{address symbol decimals} chain{id}
      netApyExcludingRewards totalAssetsUsd liquidityUsd performanceFee managementFee
      curators{items{name}} warnings{type level}
      gatesConfig{receiveSharesGate{address} receiveAssetsGate{address} sendSharesGate{address} sendAssetsGate{address}}
    }
  }
  vaults(first:50,where:{chainId_in:[4663],listed:true}) {
    pageInfo{countTotal} items { address name listed asset{address symbol decimals} chain{id}
      state{netApyExcludingRewards totalAssetsUsd fee curators{name}} liquidity{usd} warnings{type level}
    }
  }
}`;
const HISTORY_QUERY = `query SpreadlineLendingHistory($marketId:String!, $options:TimeseriesOptions) {
  marketById(marketId:$marketId,chainId:4663) { marketId historicalState{supplyApy(options:$options){x y}} }
}`;

export function createLendingService(readJSON: (response: Response) => Promise<unknown>) {
  async function query(query: string, variables?: Record<string, unknown>) {
    const response = await fetch("https://api.morpho.org/graphql", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
    });
    const result = z.object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() }).parse(await readJSON(response));
    if (!result.data || result.errors?.length) throw new Error("Morpho did not return a complete lending response.");
    return result.data;
  }
  return {
    async markets() { const data = await query(MARKETS_QUERY); return parseLendingMarkets(data.markets); },
    async vaults() { return parseLendingVaults(await query(VAULTS_QUERY)); },
    async history(id: string) {
      const endTimestamp = Math.floor(Date.now() / 1000);
      const data = await query(HISTORY_QUERY, { marketId: id, options: { startTimestamp: endTimestamp - 7 * 86400, endTimestamp, interval: "DAY" } });
      return parseLendingHistory(data.marketById, id);
    },
  };
}
