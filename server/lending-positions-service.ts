import { z } from "zod";
import { sameContract } from "../src/lib/lending-execution";
import type { DiscoveredPosition, LendingPositionsResponse } from "../src/lib/lending-positions";
const address = z.string().regex(/^0x[\da-f]{40}$/i), raw = z.string().regex(/^\d{1,78}$/);
const asset = z.object({ address, symbol: z.string().min(1).max(40), decimals: z.number().int().min(0).max(36) });
const chain = z.object({ id: z.literal(4663) });
const blueItem = z.object({ user: z.object({ address, chain }), market: z.object({ marketId: z.string().regex(/^0x[\da-f]{64}$/i), morphoBlue: z.object({ chain }), loanAsset: asset, collateralAsset: asset.nullable() }), state: z.object({ supplyShares: raw, supplyAssets: raw }).nullable() });
const vaultItem = z.object({ chain_id: z.literal(4663), vault_address: address, shares: raw, assets: raw });
const BLUE = `query WalletBlueSupplies($address:String!){marketPositions(first:50,skip:0,orderBy:SupplyShares,orderDirection:Desc,where:{chainId_in:[4663],userAddress_in:[$address],supplyShares_gte:"1"}){pageInfo{countTotal} items{user{address chain{id}} market{marketId morphoBlue{chain{id}} loanAsset{address symbol decimals} collateralAsset{address symbol decimals}} state{supplyShares supplyAssets}}}}`;
const VAULTS = `query DiscoveredVaultMetadata($addresses:[String!]!){vaultV2s(first:50,where:{chainId_in:[4663],address_in:$addresses}){items{address name chain{id} asset{address symbol decimals}}}}`;
export async function discoverLendingPositions(account: string, readJSON: (response: Response) => Promise<unknown>): Promise<LendingPositionsResponse> {
  async function query(query: string, variables: object) {
    const body = z.object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() }).parse(await readJSON(await fetch("https://api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) })));
    if (!body.data || body.errors?.length) throw new Error("Incomplete indexer response."); return body.data;
  }
  const result: LendingPositionsResponse = { account, chainId: 4663, positions: [], fetchedAt: new Date().toISOString(), warnings: [], truncated: false };
  const [blue, vaults] = await Promise.allSettled([
    (async () => {
      const body = z.object({ items: z.array(blueItem).max(50), pageInfo: z.object({ countTotal: z.number().int().nonnegative() }) }).parse((await query(BLUE, { address: account })).marketPositions);
      if (body.items.some((r) => !sameContract(r.user.address, account))) throw new Error("Position account mismatch.");
      return { positions: body.items.filter((r) => r.state && BigInt(r.state.supplyShares) > 0n).map((r): DiscoveredPosition => ({ kind: "market", id: r.market.marketId, label: `${r.market.collateralAsset?.symbol ?? "No collateral"} / ${r.market.loanAsset.symbol}`, asset: r.market.loanAsset, indexedAssetsRaw: r.state!.supplyAssets })), truncated: body.pageInfo.countTotal > body.items.length };
    })(),
    (async () => {
      const body = z.object({ params: z.object({ user_address: address }), data: z.array(vaultItem).max(50), cursor: z.string().nullable() }).parse(await readJSON(await fetch(`https://api.morpho.org/v1/vaults-v2/users/${account}/positions?chain_ids=4663&active_only=true&limit=50`, { signal: AbortSignal.timeout(10000) })));
      if (!sameContract(body.params.user_address, account)) throw new Error("Position account mismatch.");
      const active = body.data.filter((r) => BigInt(r.shares) > 0n);
      // Discovery survives missing metadata: the onchain view can still open a known vault.
      let names: { address: string; name: string; asset: z.infer<typeof asset> }[] = [];
      if (active.length) { try { names = z.object({ items: z.array(z.object({ address, name: z.string().max(160), chain, asset })).max(50) }).parse((await query(VAULTS, { addresses: active.map((r) => r.vault_address) })).vaultV2s).items; } catch { /* Onchain metadata is available in the position dialog. */ } }
      return { positions: active.map((r): DiscoveredPosition => { const metadata = names.find((v) => sameContract(v.address, r.vault_address)); return { kind: "vault", id: r.vault_address, label: metadata?.name ?? `Vault ${r.vault_address.slice(0, 6)}…${r.vault_address.slice(-4)}`, asset: metadata?.asset, indexedAssetsRaw: metadata ? r.assets : undefined }; }), truncated: body.cursor !== null };
    })(),
  ]);
  for (const [name, item] of [["Market", blue], ["Vault", vaults]] as const) {
    if (item.status === "fulfilled") { result.positions.push(...item.value.positions); result.truncated ||= item.value.truncated; }
    else result.warnings.push(`${name} position discovery is unavailable. Open a saved position or enter its contract to check it directly.`);
  }
  result.fetchedAt = new Date().toISOString(); return result;
}
