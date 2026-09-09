import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { feeDistributionLeaf } from "../src/lib/fee-distributor-contract";
import { buildRewardManifest, canonicalJSON, rewardContentHash, validateRewardManifest, validateRewardPage, verifyRewardProof } from "../src/lib/reward-merkle";
import { applyHolderTransfers, indexHolders } from "../scripts/rewards-indexer";
import { assertManifestMatchesEpoch, createRewardsService } from "../server/rewards-service";
import type { RewardEpoch } from "../src/lib/rewards-types";

const account = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const input = { chainId: 4663 as const, distributor: account(90000), holderToken: account(90001), epochId: "1", snapshotBlock: "100", snapshotBlockHash: hash(100), grossIncome: "10000003", holderBudget: "7500002", policyVersion: "1", exclusions: [{ address: zeroAddress, reason: "Burn address" }] };
test("reward trees cover odd and even holder sets, with exact rounding and bounded proof pages", () => {
  for (const count of [1, 2, 3, 17, 256, 513]) {
    const balances = new Map(Array.from({ length: count }, (_, index) => [account(index + 1), BigInt(index + 1)]));
    const bundle = buildRewardManifest(input, balances);
    assert.equal(bundle.manifestHash, rewardContentHash(bundle.manifest));
    let paid = 0n;
    for (const [index, page] of bundle.pages.entries()) {
      assert.deepEqual(validateRewardPage(page, bundle.manifest, bundle.manifest.pages[index].hash), page);
      for (const entry of page.entries) {
        assert.ok(verifyRewardProof(bundle.manifest.root, feeDistributionLeaf(4663n, input.distributor, 1n, entry.account, BigInt(entry.weight)), entry.proof));
        paid += BigInt(bundle.manifest.holderBudget) * BigInt(entry.weight) / BigInt(bundle.manifest.totalEligibleWeight);
      }
    }
    assert.ok(paid <= BigInt(input.holderBudget));
    assert.ok(BigInt(input.holderBudget) - paid < BigInt(count));
  }
});
test("holder proofs cannot be reused on a different chain, distributor, epoch, account or weight", () => {
  const bundle = buildRewardManifest(input, new Map([[account(1), 10n], [account(2), 20n]]));
  const entry = bundle.pages[0].entries[0];
  for (const leaf of [feeDistributionLeaf(1n, input.distributor, 1n, entry.account, 10n), feeDistributionLeaf(4663n, account(3), 1n, entry.account, 10n), feeDistributionLeaf(4663n, input.distributor, 2n, entry.account, 10n), feeDistributionLeaf(4663n, input.distributor, 1n, account(3), 10n), feeDistributionLeaf(4663n, input.distributor, 1n, entry.account, 11n)]) assert.equal(verifyRewardProof(bundle.manifest.root, leaf, entry.proof), false);
});
test("holder exclusions affect eligible weight and zero balances never receive a leaf", () => {
  const bundle = buildRewardManifest({ ...input, exclusions: [...input.exclusions, { address: account(1), reason: "Pons locked inventory" }] }, new Map([[account(1), 999n], [account(2), 2n], [account(3), 0n]]));
  assert.equal(bundle.manifest.totalEligibleWeight, "2");
  assert.deepEqual(bundle.pages[0].entries.map(entry => entry.account), [account(2)]);
  assert.throws(() => buildRewardManifest(input, new Map()));
});
test("content addressed proof publication rejects tampering, overlap and unrelated manifests", () => {
  const bundle = buildRewardManifest(input, new Map([[account(1), 10n], [account(2), 20n]]));
  const changed = structuredClone(bundle.pages[0]); changed.entries[0].weight = "11";
  assert.throws(() => validateRewardPage(changed, bundle.manifest, bundle.manifest.pages[0].hash));
  assert.throws(() => validateRewardPage(bundle.pages[0], bundle.manifest, hash(999)));
  assert.throws(() => validateRewardManifest({ ...bundle.manifest, pages: [...bundle.manifest.pages, ...bundle.manifest.pages] }));
  const epoch: RewardEpoch = { id: "1", ...input, root: bundle.manifest.root, manifestHash: bundle.manifestHash, totalEligibleWeight: "30", holderPaid: "0", devBudget: "500000", treasuryBudget: "2000001", devWallet: account(4), treasuryWallet: account(5), proposedAt: 1, readyAt: 901, activatedAt: 0, state: "proposed" };
  assert.doesNotThrow(() => assertManifestMatchesEpoch(bundle.manifest, epoch, input.distributor, input.holderToken));
  assert.throws(() => assertManifestMatchesEpoch({ ...bundle.manifest, grossIncome: "20000000" }, epoch, input.distributor, input.holderToken));
  assert.throws(() => assertManifestMatchesEpoch(bundle.manifest, { ...epoch, state: "cancelled" }, input.distributor, input.holderToken));
  assert.equal(canonicalJSON({ b: [2, { z: 1, a: 2 }], a: 1 }), canonicalJSON({ a: 1, b: [2, { a: 2, z: 1 }] }));
});
test("holder index handles mint, burn, self transfer and detects incomplete histories", () => {
  const balances = new Map<string, bigint>();
  applyHolderTransfers(balances, [{ from: zeroAddress, to: account(1), value: 100n }, { from: account(1), to: account(1), value: 100n }, { from: account(1), to: account(2), value: 40n }, { from: account(2), to: zeroAddress, value: 5n }]);
  assert.deepEqual([...balances], [[account(1), 60n], [account(2), 35n]]);
  assert.throws(() => applyHolderTransfers(balances, [{ from: account(3), to: account(1), value: 1n }]), /Incomplete/);
});
test("holder checkpoints resume without double-counting and stop on a reorganization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-index-"));
  try {
    let queries = 0, reorganized = false;
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: reorganized ? hash(999) : hash(Number(blockNumber)) }),
      readContract: async () => 100n,
      getContractEvents: async () => { queries++; return [{ removed: false, blockNumber: 1n, blockHash: hash(1), logIndex: 0, args: { from: zeroAddress, to: account(1), value: 100n } }]; },
    } as unknown as PublicClient;
    const options = { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 100n, checkpointPath: join(directory, "holders.json") };
    const first = await indexHolders(client, options);
    const resumed = await indexHolders(client, options);
    assert.deepEqual(first.balances, resumed.balances); assert.equal(queries, 1);
    assert.equal(JSON.parse(await readFile(options.checkpointPath, "utf8")).block, "100");
    reorganized = true;
    await assert.rejects(indexHolders(client, options), /reorganized/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("holder index rejects snapshots that do not reproduce totalSupply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-index-"));
  try {
    const client = { getBlock: async () => ({ number: 1n, hash: hash(1) }), readContract: async () => 100n, getContractEvents: async () => [] } as unknown as PublicClient;
    await assert.rejects(indexHolders(client, { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 1n, checkpointPath: join(directory, "holders.json") }), /totalSupply/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("unconfigured rewards expose no invented holdings, fees or payouts", async () => {
  const snapshot = await createRewardsService("http://never-called.invalid", { REWARDS_DISTRIBUTOR_ADDRESS: "", REWARDS_DISTRIBUTOR_CODE_HASH: "", REWARDS_DEPLOY_BLOCK: "0" }).snapshot(account(1));
  assert.equal(snapshot.status, "unconfigured"); assert.equal(snapshot.distributor, null); assert.equal(snapshot.wallet, null); assert.deepEqual(snapshot.events, []);
});

test("holder index rejects a missing ordinary transfer even when totalSupply reconciles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-missing-transfer-"));
  try {
    const checkpointPath = join(directory, "holders.json");
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }),
      readContract: async ({ functionName }: { functionName: string }) => functionName === "totalSupply" ? 100n : 60n,
      // The RPC omits a later transfer of 40 tokens from holder 1 to an unseen holder 2.
      getContractEvents: async () => [{ removed: false, blockNumber: 1n, blockHash: hash(1), logIndex: 0, args: { from: zeroAddress, to: account(1), value: 100n } }],
    } as unknown as PublicClient;
    await assert.rejects(indexHolders(client, { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 100n, checkpointPath }), /historical token storage/);
    await assert.rejects(readFile(checkpointPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("holder index rejects duplicate and out-of-range logs before committing a checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-invalid-logs-"));
  try {
    const transfer = { removed: false, blockNumber: 1n, blockHash: hash(1), logIndex: 0, args: { from: zeroAddress, to: account(1), value: 100n } };
    let logs = [transfer, transfer];
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }),
      readContract: async () => 100n,
      getContractEvents: async () => logs,
    } as unknown as PublicClient;
    const options = { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 100n, checkpointPath: join(directory, "holders.json") };
    await assert.rejects(indexHolders(client, options), /Duplicate transfer/);
    logs = [{ ...transfer, blockNumber: 101n, blockHash: hash(101) }];
    await assert.rejects(indexHolders(client, options), /outside the requested/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("holder storage verification is bounded and rejects a snapshot reorganization before commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-holder-verification-"));
  try {
    let active = 0, maximum = 0, checked = 0, reorganized = false;
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: reorganized ? hash(999) : hash(Number(blockNumber)) }),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "totalSupply") return 25n;
        active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 0));
        active--; checked++;
        if (checked === 25) reorganized = true;
        return 1n;
      },
      getContractEvents: async () => Array.from({ length: 25 }, (_, index) => ({ removed: false, blockNumber: 1n, blockHash: hash(1), logIndex: index, args: { from: zeroAddress, to: account(index + 1), value: 1n } })),
    } as unknown as PublicClient;
    const checkpointPath = join(directory, "holders.json");
    await assert.rejects(indexHolders(client, { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 100n, checkpointPath }), /reorganized during holder verification/);
    assert.equal(checked, 25);
    assert.ok(maximum <= 8 && maximum > 1);
    await assert.rejects(readFile(checkpointPath), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed incremental verification preserves the previous verified holder checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewards-checkpoint-preservation-"));
  try {
    let firstRun = true;
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }),
      readContract: async ({ functionName }: { functionName: string }) => functionName === "totalSupply" || firstRun ? 100n : 60n,
      getContractEvents: async () => firstRun ? [{ removed: false, blockNumber: 1n, blockHash: hash(1), logIndex: 0, args: { from: zeroAddress, to: account(1), value: 100n } }] : [],
    } as unknown as PublicClient;
    const options = { chainId: 4663, token: input.holderToken, deploymentBlock: 1n, snapshotBlock: 100n, checkpointPath: join(directory, "holders.json") };
    await indexHolders(client, options);
    const before = await readFile(options.checkpointPath, "utf8");
    firstRun = false;
    await assert.rejects(indexHolders(client, { ...options, snapshotBlock: 101n }), /historical token storage/);
    assert.equal(await readFile(options.checkpointPath, "utf8"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
