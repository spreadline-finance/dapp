import { z } from "zod";
import { encodeDeployData, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { feeDistributorAbi, type FeeDistributorPolicy } from "../src/lib/fee-distributor-contract";
import { PONS, PONS_QUOTE_ASSETS, ponsAddress, samePonsAddress } from "../src/lib/pons";
import type { LaunchDraft } from "../src/lib/rewards-types";

const draftSchema = z.object({
  name: z.string().min(1).max(64), symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
  description: z.string().max(2000), imageURI: z.string().min(1).max(2048),
  website: z.string().max(2048), twitter: z.string().max(2048), telegram: z.string().max(2048),
  owner: z.string(), operator: z.string(), guardian: z.string().optional(), developerWallet: z.string(), treasuryWallet: z.string(),
  creatorTaxBps: z.number().int().min(0).max(10000), rewardAsset: z.string(), developerBuy: z.string(),
  buybackEnabled: z.boolean(), launchConfigId: z.string().regex(/^\d{1,4}$/),
  holderBps: z.number().int().min(1).max(10000), devBps: z.number().int().min(0).max(10000), treasuryBps: z.number().int().min(0).max(10000),
  intervalSeconds: z.number().int().min(60).max(2592000), rootDelaySeconds: z.number().int().min(900).max(604800),
  minimumIncome: z.string().regex(/^\d{1,39}$/),
});
export function parseLaunchDraft(value: unknown): LaunchDraft {
  const draft = draftSchema.parse(value);
  for (const [label, address] of [["Owner", draft.owner], ["Operator", draft.operator], ["Developer wallet", draft.developerWallet], ["Treasury wallet", draft.treasuryWallet]] as const) ponsAddress(address, label);
  if (draft.guardian) ponsAddress(draft.guardian, "Guardian");
  if (draft.holderBps + draft.devBps + draft.treasuryBps !== 10000) throw new Error("Holder, developer and treasury shares must total 100%.");
  if (!/^0+(?:\.0+)?$/.test(draft.developerBuy)) throw new Error("This launch workflow does not include an opening purchase. Set developerBuy to 0; an opening buy needs its own quote and minimum-output approval.");
  const asset = PONS_QUOTE_ASSETS.find((item) => samePonsAddress(item.address, draft.rewardAsset));
  if (!asset) throw new Error("Choose USDG or native ETH for both Pons pairing and holder rewards.");
  const minimum = BigInt(draft.minimumIncome);
  if (minimum <= 0n || minimum > (1n << 128n) - 1n) throw new Error("Minimum income is outside the distributor accounting limits.");
  return draft;
}
export function launchPolicy(draft: LaunchDraft): FeeDistributorPolicy {
  const asset = PONS_QUOTE_ASSETS.find((item) => samePonsAddress(item.address, draft.rewardAsset));
  if (!asset) throw new Error("Unsupported reward asset.");
  return {
    holderBps: draft.holderBps, devBps: draft.devBps, treasuryBps: draft.treasuryBps,
    intervalSeconds: BigInt(draft.intervalSeconds), rootDelaySeconds: BigInt(draft.rootDelaySeconds),
    minimumIncome: BigInt(draft.minimumIncome),
    devWallet: getAddress(draft.developerWallet), treasuryWallet: getAddress(draft.treasuryWallet),
  };
}
const artifactSchema = z.object({
  bytecode: z.object({ object: z.string().regex(/^0x[\da-f]+$/i) }),
  deployedBytecode: z.object({ object: z.string().regex(/^0x[\da-f]+$/i), immutableReferences: z.record(z.string(), z.array(z.object({ start: z.number().int().nonnegative(), length: z.number().int().positive() }))) }),
  ast: z.unknown(),
  metadata: z.object({ compiler: z.object({ version: z.string() }), sources: z.record(z.string(), z.object({ keccak256: z.string() })) }),
});
export type DistributorArtifact = z.infer<typeof artifactSchema>;
export function parseDistributorArtifact(value: unknown, source: string): DistributorArtifact {
  const artifact = artifactSchema.parse(value);
  if (!artifact.metadata.compiler.version.startsWith("0.8.26+")) throw new Error("Build the distributor with the configured Solidity 0.8.26 compiler.");
  const compiledSource = Object.entries(artifact.metadata.sources).find(([path]) => path.endsWith("/SpreadlineFeeDistributor.sol"))?.[1];
  if (!compiledSource || compiledSource.keccak256 !== keccak256(toHex(source))) throw new Error("The compiled distributor artifact is stale. Run forge build --root contracts --ast --force.");
  if (!artifact.ast) throw new Error("Compiler AST is required for exact immutable verification. Run forge build --root contracts --ast --force.");
  return artifact;
}
function immutableNames(ast: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (item.nodeType === "VariableDeclaration" && item.mutability === "immutable" && typeof item.id === "number" && typeof item.name === "string") names.set(String(item.id), item.name);
    Object.values(item).forEach(visit);
  };
  visit(ast); return names;
}
/** Every compiler-declared immutable occurrence is patched, then the complete runtime is compared. */
export function distributorRuntime(artifact: DistributorArtifact, rewardAsset: Address): Hex {
  const names = immutableNames(artifact.ast);
  const values: Record<string, Address> = { rewardAsset, ponsEscrow: PONS.escrow, ponsFactory: PONS.factory, ponsHook: PONS.hook };
  let code = artifact.deployedBytecode.object.slice(2);
  const intervals: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const [id, references] of Object.entries(artifact.deployedBytecode.immutableReferences)) {
    const name = names.get(id);
    if (!name || !values[name] || !references.length) throw new Error("An unknown immutable prevents exact runtime verification.");
    seen.add(name);
    for (const reference of references) {
      const start = reference.start * 2, end = start + reference.length * 2;
      if (reference.length !== 32 || end > code.length || intervals.some((other) => start < other.end && end > other.start)) throw new Error("Invalid or overlapping immutable reference.");
      intervals.push({ start, end });
      code = code.slice(0, start) + values[name].slice(2).toLowerCase().padStart(64, "0") + code.slice(end);
    }
  }
  if (Object.keys(values).some((name) => !seen.has(name))) throw new Error("The artifact does not contain every expected Pons immutable.");
  return `0x${code}`;
}
export function distributorDeployData(artifact: DistributorArtifact, draft: LaunchDraft): Hex {
  return encodeDeployData({ abi: feeDistributorAbi, bytecode: artifact.bytecode.object as Hex, args: [zeroAddress, getAddress(draft.rewardAsset), PONS.escrow, PONS.factory, PONS.hook, getAddress(draft.owner), getAddress(draft.operator), launchPolicy(draft)] });
}
