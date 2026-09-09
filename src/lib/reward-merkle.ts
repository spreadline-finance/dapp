import { concatHex, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { feeDistributionLeaf } from "./fee-distributor-contract";

const uint = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform(value => value as Hex);
const address = z.string().refine(value => isAddress(value, { strict: false })).transform(value => value.toLowerCase() as Address);
export const rewardEntrySchema = z.object({ account: address, weight: uint, proof: z.array(hash).max(32) }).strict();
export const rewardPageSchema = z.object({ entries: z.array(rewardEntrySchema).min(1).max(256) }).strict();
export const rewardManifestSchema = z.object({
  version: z.literal(1), chainId: z.literal(4663), distributor: address, holderToken: address,
  epochId: uint, snapshotBlock: uint, snapshotBlockHash: hash, root: hash,
  totalEligibleWeight: uint, grossIncome: uint, holderBudget: uint, policyVersion: uint,
  exclusions: z.array(z.object({ address, reason: z.string().min(1).max(180) }).strict()).max(200),
  pages: z.array(z.object({ first: address, last: address, hash, count: z.number().int().min(1).max(256) }).strict()).min(1).max(10000),
}).strict();
export type RewardManifest = z.infer<typeof rewardManifestSchema>;
export type RewardPage = z.infer<typeof rewardPageSchema>;

/** The serialized form is shared by the keeper, public API and independent auditors. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const rewardContentHash = (value: unknown) => keccak256(stringToHex(canonicalJSON(value)));
export function merkleParent(a: Hex, b: Hex): Hex { return keccak256(concatHex(a < b ? [a, b] : [b, a])); }
export function verifyRewardProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  return proof.length <= 32 && proof.reduce(merkleParent, leaf) === root;
}

export function buildRewardManifest(
  input: Omit<RewardManifest, "version" | "root" | "totalEligibleWeight" | "pages">,
  balances: ReadonlyMap<string, bigint>,
): { manifest: RewardManifest; manifestHash: Hex; pages: RewardPage[] } {
  const excluded = new Set(input.exclusions.map(item => item.address.toLowerCase()));
  const entries = [...balances].filter(([account, weight]) => weight > BigInt(0) && !excluded.has(account.toLowerCase()))
    .map(([account, weight]) => ({ account: address.parse(account), weight: String(weight) }))
    .sort((a, b) => a.account.localeCompare(b.account));
  if (!entries.length || new Set(entries.map(item => item.account)).size !== entries.length) throw new Error("Empty or duplicate holder snapshot.");
  const total = entries.reduce((sum, item) => sum + BigInt(item.weight), BigInt(0));
  if (total >= BigInt(2) ** BigInt(128) || BigInt(input.holderBudget) <= BigInt(0)) throw new Error("Invalid snapshot budget or holder weight.");
  const levels: Hex[][] = [entries.map(item => feeDistributionLeaf(BigInt(input.chainId), input.distributor, BigInt(input.epochId), item.account, BigInt(item.weight)))];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    const next: Hex[] = [];
    for (let index = 0; index < current.length; index += 2) next.push(index + 1 < current.length ? merkleParent(current[index], current[index + 1]) : current[index]);
    levels.push(next);
  }
  const claims = entries.map((entry, index) => {
    const proof: Hex[] = [];
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const sibling = index ^ 1;
      if (sibling < levels[depth].length) proof.push(levels[depth][sibling]);
      index = Math.floor(index / 2);
    }
    return { ...entry, proof };
  });
  const pages: RewardPage[] = [];
  for (let offset = 0; offset < claims.length; offset += 256) pages.push({ entries: claims.slice(offset, offset + 256) });
  const manifest = rewardManifestSchema.parse({ ...input, version: 1, root: levels.at(-1)![0], totalEligibleWeight: String(total),
    pages: pages.map(page => ({ first: page.entries[0].account, last: page.entries.at(-1)!.account, count: page.entries.length, hash: rewardContentHash(page) })),
  });
  return { manifest, manifestHash: rewardContentHash(manifest), pages };
}

export function validateRewardManifest(value: unknown): RewardManifest {
  const result = rewardManifestSchema.parse(value);
  if (BigInt(result.totalEligibleWeight) === BigInt(0) || BigInt(result.holderBudget) === BigInt(0) || BigInt(result.holderBudget) > BigInt(result.grossIncome)) throw new Error("Invalid reward allocation.");
  result.pages.forEach((page, index) => {
    if (page.first > page.last || index > 0 && result.pages[index - 1].last >= page.first) throw new Error("Overlapping or unordered proof pages.");
  });
  return result;
}

export function validateRewardPage(value: unknown, manifest: RewardManifest, pageHash: Hex): RewardPage {
  const page = rewardPageSchema.parse(value);
  const descriptor = manifest.pages.find(item => item.hash === pageHash);
  if (!descriptor || rewardContentHash(page) !== pageHash || page.entries.length !== descriptor.count || page.entries[0].account !== descriptor.first || page.entries.at(-1)!.account !== descriptor.last) throw new Error("Proof page does not match the committed manifest.");
  page.entries.forEach((entry, index) => {
    if (BigInt(entry.weight) <= BigInt(0) || BigInt(entry.weight) > BigInt(manifest.totalEligibleWeight) || index > 0 && page.entries[index - 1].account >= entry.account || !verifyRewardProof(manifest.root,
      feeDistributionLeaf(BigInt(manifest.chainId), manifest.distributor, BigInt(manifest.epochId), entry.account, BigInt(entry.weight)), entry.proof)) throw new Error("Invalid holder proof.");
  });
  return page;
}
