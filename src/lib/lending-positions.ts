import type { LendingKind } from "./lending-execution";
export type DiscoveredPosition = { kind: LendingKind; id: string; label: string; asset?: { address: string; symbol: string; decimals: number }; indexedAssetsRaw?: string };
export type LendingPositionsResponse = { account: string; chainId: 4663; positions: DiscoveredPosition[]; fetchedAt: string; warnings: string[]; truncated: boolean };
