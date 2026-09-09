import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { createRewardsService, verifiedRewards, type RewardsConfig } from "../server/rewards-service";
import { feeDistributorAbi } from "../src/lib/fee-distributor-contract";
import { buildRewardManifest, canonicalJSON, rewardContentHash } from "../src/lib/reward-merkle";
import { USDG } from "../src/lib/market-types";

const holder = "0x1111111111111111111111111111111111111111" as Address;
const distributor = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x3333333333333333333333333333333333333333" as Address;
const other = "0x4444444444444444444444444444444444444444" as Address;
const escrow = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address;
const code = "0x60006000" as Hex;
const blockHash = `0x${"a".repeat(64)}` as Hex;
const config: RewardsConfig = { REWARDS_DISTRIBUTOR_ADDRESS: distributor, REWARDS_DISTRIBUTOR_CODE_HASH: keccak256(code), REWARDS_DEPLOY_BLOCK: "1" };
const rpcUrl = "https://rpc.rewards.test";
const rpcAbi: Abi = [...feeDistributorAbi, ...erc20Abi, ...parseAbi(["function balanceOfToken(address,address) view returns(uint256)"])];
type RPC = { id: number; method: string; params: unknown[] };
type Bundle = ReturnType<typeof buildRewardManifest>;
type ChainEpoch = {
  root: Hex; manifestHash: Hex; snapshotBlockHash: Hex; snapshotBlock: bigint; totalEligibleWeight: bigint;
  grossIncome: bigint; holderBudget: bigint; holderPaid: bigint; devBudget: bigint; treasuryBudget: bigint;
  devWallet: Address; treasuryWallet: Address; policyVersion: bigint; proposedAt: bigint; readyAt: bigint; activatedAt: bigint; state: number;
};
function bundle(id = "1", balances = new Map<string, bigint>([[holder, 3n], [other, 1n]])): Bundle {
  return buildRewardManifest({ chainId: 4663, distributor, holderToken: token, epochId: id, snapshotBlock: "9000", snapshotBlockHash: blockHash, grossIncome: "1000000000000000000", holderBudget: "750000000000000000", policyVersion: "1", exclusions: [] }, balances);
}
function epoch(document: Bundle, options: Partial<ChainEpoch> = {}): ChainEpoch {
  const time = BigInt(Math.floor(Date.now() / 1000));
  return { root: document.manifest.root, manifestHash: document.manifestHash, snapshotBlockHash: document.manifest.snapshotBlockHash, snapshotBlock: BigInt(document.manifest.snapshotBlock), totalEligibleWeight: BigInt(document.manifest.totalEligibleWeight), grossIncome: BigInt(document.manifest.grossIncome), holderBudget: BigInt(document.manifest.holderBudget), holderPaid: 0n, devBudget: 50000000000000000n, treasuryBudget: 200000000000000000n, devWallet: holder, treasuryWallet: other, policyVersion: 1n, proposedAt: time - 1800n, readyAt: time - 900n, activatedAt: time - 800n, state: 2, ...options };
}
function memoryBucket() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const bucket = {
    async get(key: string) { const value = values.get(key); return value === undefined ? null : { key, json: async () => JSON.parse(value), text: async () => value }; },
    async put(key: string, value: string) { values.set(key, value); writes.push(key); return { key }; },
  } as unknown as R2Bucket;
  const key = (epochId: string, pageHash?: Hex) => `rewards/4663/${distributor}/${epochId}/${pageHash ?? "manifest"}.json`;
  function seed(document: Bundle) { values.set(key(document.manifest.epochId), canonicalJSON(document.manifest)); document.pages.forEach((page, index) => values.set(key(document.manifest.epochId, document.manifest.pages[index].hash), canonicalJSON(page))); }
  return { bucket, values, writes, key, seed };
}
function mockRewardsRPC(t: TestContext, options: { chain?: string; stale?: boolean; future?: boolean; code?: Hex; escrow?: Address; eventsFail?: boolean; epochs?: Map<bigint, ChainEpoch>; nextEpochId?: bigint; claimed?: boolean; rewardAsset?: Address; holderToken?: Address } = {}) {
  const calls: RPC[] = [];
  const epochMap = options.epochs ?? new Map([[1n, epoch(bundle())]]);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); const requests: RPC[] = Array.isArray(body) ? body : [body];
    const responses = requests.map((request) => {
      calls.push(request); let result: unknown;
      if (request.method === "eth_chainId") result = options.chain ?? "0x1237";
      else if (request.method === "eth_getBlockByNumber") result = { number: "0x2710", timestamp: `0x${(Math.floor(Date.now() / 1000) - (options.stale ? 180 : options.future ? -30 : 0)).toString(16)}`, hash: blockHash, transactions: [], gasLimit: "0x1000000", gasUsed: "0x0" };
      else if (request.method === "eth_getCode") result = options.code ?? code;
      else if (request.method === "eth_getLogs") {
        if (options.eventsFail) return { id: request.id, jsonrpc: "2.0", error: { code: -32005, message: "Recent logs unavailable" } };
        result = [];
      } else if (request.method === "eth_call") {
        const transaction = request.params[0] as { data: Hex; to: Address };
        const decoded = decodeFunctionData({ abi: rpcAbi, data: transaction.data });
        const fn = decoded.functionName;
        const values: Record<string, unknown> = {
          ponsEscrow: options.escrow ?? escrow, owner: holder, pendingOwner: zeroAddress, operator: other, guardian: holder, paused: true,
          holderToken: options.holderToken ?? token, rewardAsset: options.rewardAsset ?? zeroAddress,
          policy: [7500, 500, 2000, 900n, 900n, 1000000000000000n, holder, other], policyVersion: 1n,
          totalPonsCollected: 1000000000000000000n, availableIncome: 250000000000000000n, totalReserved: 750000000000000000n,
          totalHolderAllocated: 750000000000000000n, totalHolderPaid: 125000000000000000n,
          totalDevAllocated: 50000000000000000n, totalDevPaid: 25000000000000000n,
          totalTreasuryAllocated: 200000000000000000n, totalTreasuryPaid: 100000000000000000n,
          nextEpochId: options.nextEpochId ?? 2n, lastProposedAt: 0n,
          symbol: transaction.to.toLowerCase() === token ? "SPREAD" : "USDG", decimals: transaction.to.toLowerCase() === token ? 18 : 6,
          balanceOf: transaction.to.toLowerCase() === escrow.toLowerCase() ? 50000000000000000n : 30n,
          balanceOfToken: 5000000n, pendingDev: 25000000000000000n, pendingTreasury: 0n, hasClaimed: options.claimed ?? false,
        };
        if (fn === "epochs") { const id = (decoded.args as readonly bigint[])[0]; const found = epochMap.get(id); if (!found) throw new Error(`Unexpected epoch ${id}`); result = encodeFunctionResult({ abi: feeDistributorAbi, functionName: "epochs", result: found }); }
        else { if (!(fn in values)) throw new Error(`Unexpected contract read ${fn}`); result = encodeFunctionResult({ abi: rpcAbi, functionName: fn, result: values[fn] as never }); }
      } else throw new Error(`Unexpected RPC ${request.method}`);
      return { id: request.id, jsonrpc: "2.0", result };
    });
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  });
  return calls;
}

test("unconfigured rewards report no balances or RPC activity", async (t) => {
  let requests = 0; t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Unexpected network call"); });
  const result = await createRewardsService(rpcUrl, { ...config, REWARDS_DISTRIBUTOR_ADDRESS: "" }).snapshot(holder);
  assert.equal(result.status, "unconfigured"); assert.equal(result.distributor, null); assert.equal(result.wallet, null); assert.equal(result.blockNumber, null); assert.equal(requests, 0);
  await assert.rejects(verifiedRewards(rpcUrl, { ...config, REWARDS_DISTRIBUTOR_CODE_HASH: "" }), /not configured and verified/);
  assert.equal(requests, 0);
});
test("rewards verify deployment identity and pin every financial read to a single block", async (t) => {
  const calls = mockRewardsRPC(t); const storage = memoryBucket(); storage.seed(bundle());
  const result = await createRewardsService(rpcUrl, config, storage.bucket).snapshot(holder);
  assert.equal(result.status, "ready"); assert.equal(result.blockNumber, "10000");
  assert.equal(result.distributor?.totalPonsCollected, "1000000000000000000");
  assert.equal(result.distributor?.totalHolderPaid, "125000000000000000");
  assert.equal(result.distributor?.totalDevAllocated, "50000000000000000");
  assert.equal(result.distributor?.totalDevPaid, "25000000000000000");
  assert.equal(result.wallet?.holderBalance, "30");
  assert.equal(result.wallet?.claims[0]?.amount, "562500000000000000", "uses snapshot weight 3/4, not the current balance 30");
  assert.equal(result.wallet?.proofsStatus, "ready");
  assert.ok(calls.filter((call) => call.method === "eth_call" || call.method === "eth_getCode").every((call) => call.params[1] === "0x2710"));
  const ranges = calls.filter((call) => call.method === "eth_getLogs").map((call) => call.params[0] as { fromBlock: Hex; toBlock: Hex });
  assert.equal(ranges.length, 5); assert.equal(ranges[0].fromBlock, "0x1389");
  assert.ok(ranges.every((range) => BigInt(range.toBlock) - BigInt(range.fromBlock) <= 999n));
});
test("USDG reward metadata and Pons token escrow credit are read at the pinned block", async (t) => {
  const calls = mockRewardsRPC(t, { rewardAsset: USDG });
  const result = await createRewardsService(rpcUrl, config).snapshot();
  assert.equal(result.status, "ready"); assert.equal(result.distributor?.rewardAsset.toLowerCase(), USDG.toLowerCase());
  assert.equal(result.distributor?.rewardSymbol, "USDG"); assert.equal(result.distributor?.rewardDecimals, 6); assert.equal(result.distributor?.escrowCredit, "5000000");
  const credit = calls.filter((call) => call.method === "eth_call").map((call) => ({ call, decoded: decodeFunctionData({ abi: rpcAbi, data: (call.params[0] as { data: Hex }).data }) })).find((entry) => entry.decoded.functionName === "balanceOfToken");
  assert.ok(credit); assert.deepEqual(credit.decoded.args?.map((value) => String(value).toLowerCase()), [distributor, USDG.toLowerCase()]); assert.equal(credit.call.params[1], "0x2710");
});
test("rewards reject wrong chain, stale or future blocks, mismatched code and incorrect escrow", async (t) => {
  for (const options of [{ chain: "0x1" }, { stale: true }, { future: true }, { code: "0x6001" as Hex }, { escrow: other }]) {
    mockRewardsRPC(t, options);
    const result = await createRewardsService(rpcUrl, config).snapshot(holder);
    assert.equal(result.status, "unavailable"); assert.equal(result.distributor, null); assert.equal(result.wallet, null);
    t.mock.restoreAll();
  }
  mockRewardsRPC(t);
  await assert.rejects(verifiedRewards(rpcUrl, { ...config, REWARDS_DEPLOY_BLOCK: "10001" }), /current Robinhood Chain block/);
});
test("validated manifest and proof uploads are retrievable as a wallet claim", async (t) => {
  const document = bundle(); mockRewardsRPC(t, { epochs: new Map([[1n, epoch(document)]]) });
  const storage = memoryBucket(); const service = createRewardsService(rpcUrl, config, storage.bucket);
  assert.deepEqual(await service.manifest(1n, undefined, document.manifest), { stored: true, hash: document.manifestHash });
  assert.deepEqual(await service.manifest(1n, document.manifest.pages[0].hash, document.pages[0]), { stored: true, hash: document.manifest.pages[0].hash });
  assert.equal(storage.writes.length, 2);
  assert.deepEqual(await service.manifest(1n), document.manifest);
  assert.deepEqual(await service.manifest(1n, document.manifest.pages[0].hash), document.pages[0]);
  const result = await service.snapshot(holder);
  assert.equal(result.wallet?.proofsStatus, "ready"); assert.equal(result.wallet?.claims.length, 1);
  assert.deepEqual(result.wallet?.claims[0], { epochId: "1", ...document.pages[0].entries[0], amount: "562500000000000000", claimed: false });
});
test("manifest uploads reject tampered roots, identities, amounts and snapshot commitments without storage writes", async (t) => {
  const document = bundle(); mockRewardsRPC(t, { epochs: new Map([[1n, epoch(document)]]) });
  const storage = memoryBucket(); const service = createRewardsService(rpcUrl, config, storage.bucket);
  for (const change of [{ root: blockHash }, { distributor: other }, { holderToken: other }, { grossIncome: "1000000000000000001" }, { snapshotBlock: "8999" }, { snapshotBlockHash: `0x${"b".repeat(64)}` }, { epochId: "2" }, { policyVersion: "2" }]) await assert.rejects(service.manifest(1n, undefined, { ...document.manifest, ...change }), /differs from the onchain distribution/);
  assert.equal(storage.writes.length, 0);
});
test("proof upload rejects changed weights, changed hashes and invalid Merkle membership", async (t) => {
  const document = bundle(); const chainEpochs = new Map([[1n, epoch(document)]]); mockRewardsRPC(t, { epochs: chainEpochs });
  const storage = memoryBucket(); const service = createRewardsService(rpcUrl, config, storage.bucket);
  await service.manifest(1n, undefined, document.manifest);
  const changed = structuredClone(document.pages[0]); changed.entries[0].weight = "4";
  await assert.rejects(service.manifest(1n, document.manifest.pages[0].hash, changed), /does not match the committed manifest/);
  await assert.rejects(service.manifest(1n, blockHash, document.pages[0]), /not part of the committed manifest/);
  const invalidPage = structuredClone(document.pages[0]); invalidPage.entries[0].proof = [blockHash];
  const invalidHash = rewardContentHash(invalidPage);
  const malicious = { ...document.manifest, pages: [{ ...document.manifest.pages[0], hash: invalidHash }] };
  chainEpochs.set(1n, { ...epoch(document), manifestHash: rewardContentHash(malicious) });
  await service.manifest(1n, undefined, malicious);
  await assert.rejects(service.manifest(1n, invalidHash, invalidPage), /Invalid holder proof/);
  assert.equal(storage.writes.length, 2, "only the two manifest versions were stored; neither invalid proof page was stored");
});
test("missing or corrupt proof data is unavailable rather than zero entitlement", async (t) => {
  const document = bundle(); mockRewardsRPC(t, { epochs: new Map([[1n, epoch(document)]]) });
  const storage = memoryBucket(); const service = createRewardsService(rpcUrl, config, storage.bucket);
  let result = await service.snapshot(holder);
  assert.equal(result.status, "ready"); assert.equal(result.wallet?.proofsStatus, "unavailable"); assert.match(result.wallet!.proofsMessage, /do not mean zero entitlement/);
  storage.values.set(storage.key("1"), canonicalJSON(document.manifest));
  result = await service.snapshot(holder); assert.equal(result.wallet?.proofsStatus, "unavailable", "manifest alone does not imply a usable claim");
  storage.seed(document);
  const corrupted = structuredClone(document.pages[0]); corrupted.entries[0].weight = "900";
  storage.values.set(storage.key("1", document.manifest.pages[0].hash), canonicalJSON(corrupted));
  result = await service.snapshot(holder); assert.equal(result.wallet?.proofsStatus, "unavailable"); assert.deepEqual(result.wallet?.claims, []);
  storage.seed(document);
  result = await service.snapshot(holder); assert.equal(result.wallet?.proofsStatus, "ready"); assert.equal(result.wallet?.claims.length, 1);
  const absent = await service.snapshot("0x5555555555555555555555555555555555555555");
  assert.equal(absent.wallet?.proofsStatus, "ready"); assert.deepEqual(absent.wallet?.claims, [], "a verified absent holder is distinct from unavailable proofs");
});
test("valid claims remain usable when another distribution manifest is unavailable", async (t) => {
  const first = bundle("1"), second = bundle("2");
  mockRewardsRPC(t, { epochs: new Map([[1n, epoch(first)], [2n, epoch(second)]]), nextEpochId: 3n });
  const storage = memoryBucket(); storage.seed(first);
  const result = await createRewardsService(rpcUrl, config, storage.bucket).snapshot(holder);
  assert.equal(result.wallet?.proofsStatus, "unavailable"); assert.equal(result.wallet?.claims.length, 1); assert.equal(result.wallet?.claims[0].epochId, "1");
  assert.match(result.wallet!.proofsMessage, /Any valid proofs below remain usable/);
});
test("wallet lookup selects the correct content-addressed proof page across page boundaries", async (t) => {
  const balances = new Map(Array.from({ length: 257 }, (_, index) => [`0x${(index + 1).toString(16).padStart(40, "0")}`, 1n]));
  const document = bundle("1", balances); const lastHolder = document.pages[1].entries[0].account;
  assert.equal(document.pages.length, 2); assert.equal(document.pages[0].entries.length, 256);
  mockRewardsRPC(t, { epochs: new Map([[1n, epoch(document)]]) });
  const storage = memoryBucket(); storage.seed(document);
  const service = createRewardsService(rpcUrl, config, storage.bucket);
  const complete = await service.snapshot(lastHolder);
  assert.equal(complete.wallet?.proofsStatus, "ready"); assert.equal(complete.wallet?.claims[0].account, lastHolder);
  assert.equal(complete.wallet?.claims[0].amount, (750000000000000000n / 257n).toString());
  storage.values.delete(storage.key("1", document.manifest.pages[1].hash));
  const missing = await service.snapshot(lastHolder);
  assert.equal(missing.wallet?.proofsStatus, "unavailable"); assert.deepEqual(missing.wallet?.claims, []);
  const firstHolder = document.pages[0].entries[0].account;
  const unaffected = await service.snapshot(firstHolder);
  assert.equal(unaffected.wallet?.proofsStatus, "ready"); assert.equal(unaffected.wallet?.claims[0].account, firstHolder);
});
test("older unpaid distributions remain reachable through exclusive epoch pagination", async (t) => {
  const documents = Array.from({ length: 25 }, (_, index) => bundle(String(index + 1)));
  const chainEpochs = new Map(documents.map((document) => [BigInt(document.manifest.epochId), epoch(document)]));
  const calls = mockRewardsRPC(t, { epochs: chainEpochs, nextEpochId: 26n });
  const storage = memoryBucket(); documents.forEach(storage.seed);
  const service = createRewardsService(rpcUrl, config, storage.bucket);
  const latest = await service.snapshot(holder);
  assert.equal(latest.epochs.length, 20); assert.equal(latest.epochs[0].id, "25"); assert.equal(latest.epochs.at(-1)?.id, "6"); assert.equal(latest.nextEpochCursor, "6");
  const older = await service.snapshot(holder, BigInt(latest.nextEpochCursor!));
  assert.deepEqual(older.epochs.map((item) => item.id), ["5", "4", "3", "2", "1"]); assert.equal(older.nextEpochCursor, null);
  assert.equal(older.wallet?.proofsStatus, "ready"); assert.equal(older.wallet?.claims.length, 5); assert.equal(older.wallet?.claims.at(-1)?.epochId, "1");
  assert.equal(older.distributor?.totalHolderPaid, latest.distributor?.totalHolderPaid, "lifetime totals do not shrink on older pages");
  assert.ok(calls.filter((call) => call.method === "eth_call").every((call) => call.params[1] === "0x2710"));
});
test("cancelled distributions reject proof publication and already-paid claims remain explicit", async (t) => {
  const document = bundle(); const chainEpochs = new Map([[1n, epoch(document)]]); mockRewardsRPC(t, { epochs: chainEpochs, claimed: true });
  const storage = memoryBucket(); storage.seed(document); const service = createRewardsService(rpcUrl, config, storage.bucket);
  const paid = await service.snapshot(holder); assert.equal(paid.wallet?.claims[0].claimed, true);
  chainEpochs.set(1n, epoch(document, { state: 3, activatedAt: 0n }));
  await assert.rejects(service.manifest(1n, undefined, document.manifest), /differs from the onchain distribution/);
  const cancelled = await service.snapshot(holder); assert.equal(cancelled.wallet?.proofsStatus, "empty"); assert.deepEqual(cancelled.wallet?.claims, []);
});
test("recent reward log failures preserve verified lifetime balances and indicate missing receipt history", async (t) => {
  mockRewardsRPC(t, { eventsFail: true });
  const result = await createRewardsService(rpcUrl, config).snapshot();
  assert.equal(result.status, "ready"); assert.equal(result.distributor?.totalHolderPaid, "125000000000000000"); assert.equal(result.distributor?.totalPonsCollected, "1000000000000000000");
  assert.deepEqual(result.events, []); assert.match(result.eventsError!, /Lifetime paid totals still come from the contract/);
});
