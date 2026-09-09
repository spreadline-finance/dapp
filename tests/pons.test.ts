import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { PONS, ponsFactoryAbi, ponsLaunchAndBuyAbi, ponsPoolId, preparePonsLaunchAndBuyCall, preparePonsLaunchCall } from "../src/lib/pons";
import { USDG } from "../src/lib/market-types";
import type { LaunchDraft, PonsLaunchState } from "../src/lib/rewards-types";
import { distributorDeployData, distributorRuntime, launchPolicy, parseDistributorArtifact, parseLaunchDraft, type DistributorArtifact } from "../scripts/rewards-launch-lib";

const owner: Address = "0x1111111111111111111111111111111111111111";
const distributor: Address = "0x5555555555555555555555555555555555555555";
const salt = `0x${"ab".repeat(32)}` as Hex;
const economics = `0x${"cd".repeat(32)}` as Hex;
const now = 1700000000000;
const draft: LaunchDraft = {
  name: "Spreadline test", symbol: "TEST", description: "Test metadata", imageURI: "ipfs://example", website: "https://example.com", twitter: "https://x.com/spreadonrh", telegram: "",
  owner, operator: "0x2222222222222222222222222222222222222222", developerWallet: "0x3333333333333333333333333333333333333333", treasuryWallet: "0x4444444444444444444444444444444444444444",
  creatorTaxBps: 100, rewardAsset: USDG, developerBuy: "0", buybackEnabled: false, launchConfigId: "0",
  holderBps: 7500, devBps: 500, treasuryBps: 2000, intervalSeconds: 900, rootDelaySeconds: 900, minimumIncome: "300000000",
};
function state(): PonsLaunchState {
  return {
    status: "ready", message: "Test", fetchedAt: new Date(now).toISOString(), blockNumber: "58536959", blockTimestamp: new Date(now).toISOString(), blockHash: economics,
    chainId: 4663, factory: PONS.factory, escrow: PONS.escrow, hook: PONS.hook, launcher: owner,
    launchEnabled: true, canLaunch: true, maxCreatorTaxBps: 1000, launchFeeWei: "500000000000000", runtimeVerified: true,
    officialLaunchUrl: "https://www.ponsfamily.com/launchpad/create", docsUrl: "https://docs.ponsfamily.com/v2",
    quoteAssets: [{ address: USDG, symbol: "USDG", decimals: 6, approved: true, phantomQuoteRaw: "3236000000", graduationThresholdRaw: "8090000000" }, { address: zeroAddress, symbol: "ETH", decimals: 18, approved: true, phantomQuoteRaw: null, graduationThresholdRaw: null }],
    configs: [{ id: "0", supplyRaw: "1000000000000000000000000000", curveFeeBps: 100, phantomQuoteRaw: "1680000000000000000", graduationThresholdRaw: "4200000000000000000", poolFee: 0, tickSpacing: 200, enabled: true }],
    feePolicy: { protocolFeeRecipient: owner, protocolFeeShareBps: 3000, buybackBurnBps: 5000, hookFeeBps: 100, maxInternalPriceImpactBps: 300 },
    launchQuotes: [{ configId: "0", pairToken: USDG, expectedEconomics: economics }, { configId: "0", pairToken: zeroAddress, expectedEconomics: economics }],
  };
}
const input = () => ({ draft, state: state(), launcher: owner, distributor, salt, now });

test("Pons launch calldata pins the fee recipient, immutable tax, pairing and economics", () => {
  const prepared = preparePonsLaunchCall(input());
  const decoded = decodeFunctionData({ abi: ponsFactoryAbi, data: prepared.data });
  assert.equal(decoded.functionName, "launchToken");
  if (decoded.functionName !== "launchToken") throw new Error("Wrong function");
  assert.equal(decoded.args[0].creatorFeeRecipient, distributor);
  assert.equal(decoded.args[0].creatorTaxBps, 100);
  assert.equal(decoded.args[0].buybackEnabled, false);
  assert.equal(decoded.args[0].expectedEconomics, economics);
  assert.equal(decoded.args[0].salt, salt);
  assert.equal(decoded.args[1], 0n);
  assert.equal(decoded.args[2], getAddress(USDG));
  assert.equal(prepared.valueWei, "500000000000000");
  assert.equal(prepared.totalTradeFeeBps, 200);
});

test("Pons launch preparation refuses stale, mismatched or unapproved launch terms", () => {
  for (const invalid of [
    { ...state(), fetchedAt: new Date(now - 60001).toISOString() }, { ...state(), chainId: 1 },
    { ...state(), canLaunch: false }, { ...state(), launcher: distributor }, { ...state(), runtimeVerified: false },
    { ...state(), quoteAssets: state().quoteAssets.map((asset) => ({ ...asset, approved: false })) },
    { ...state(), launchQuotes: [] },
  ]) assert.throws(() => preparePonsLaunchCall({ ...input(), state: invalid }));
  assert.throws(() => preparePonsLaunchCall({ ...input(), draft: { ...draft, creatorTaxBps: 1001 } }), /tax/);
  assert.throws(() => preparePonsLaunchCall({ ...input(), draft: { ...draft, imageURI: "javascript:alert(1)" } }), /HTTPS or IPFS/);
  assert.throws(() => preparePonsLaunchCall({ ...input(), salt: "0x1234" }), /32-byte/);
});

test("Pons authoritative canLaunch permits a whitelisted wallet when public launches are closed", () => {
  assert.doesNotThrow(() => preparePonsLaunchCall({ ...input(), state: { ...state(), launchEnabled: false, canLaunch: true } }));
});

test("optional opening buy uses the pairing asset and requires an explicit minimum output", () => {
  const prepared = preparePonsLaunchAndBuyCall({ ...input(), draft: { ...draft, developerBuy: "3.5" }, minTokensOut: 100n, recipient: owner });
  assert.equal(prepared.valueWei, "500000000000000");
  assert.equal(prepared.approval?.amount, "3500000");
  const decoded = decodeFunctionData({ abi: ponsLaunchAndBuyAbi, data: prepared.data });
  assert.equal(decoded.args[3], 3500000n);
  assert.equal(decoded.args[4], 100n);
  const native = preparePonsLaunchAndBuyCall({ ...input(), draft: { ...draft, rewardAsset: zeroAddress, developerBuy: "0.01" }, minTokensOut: 100n, recipient: owner });
  assert.equal(native.valueWei, "10500000000000000");
  assert.equal(native.approval, null);
  assert.throws(() => preparePonsLaunchAndBuyCall({ ...input(), draft: { ...draft, developerBuy: "1" }, minTokensOut: 0n, recipient: owner }));
});

test("launch CLI preserves exact raw units exported by the UI for USDG and ETH", () => {
  const usdg = parseLaunchDraft({ ...draft, rewardAsset: USDG, minimumIncome: "300000000" });
  const eth = parseLaunchDraft({ ...draft, rewardAsset: zeroAddress, minimumIncome: "1000000000000000" });
  assert.equal(launchPolicy(usdg).minimumIncome, 300000000n);
  assert.equal(launchPolicy(eth).minimumIncome, 1000000000000000n);
  assert.throws(() => parseLaunchDraft({ ...draft, minimumIncome: "0.001" }));
  assert.throws(() => parseLaunchDraft({ ...draft, holderBps: 7600 }));
  assert.throws(() => parseLaunchDraft({ ...draft, rootDelaySeconds: 899 }));
  assert.throws(() => parseLaunchDraft({ ...draft, developerBuy: "1" }), /opening purchase/);
});

function syntheticArtifact(): DistributorArtifact {
  return {
    bytecode: { object: "0x6000" },
    deployedBytecode: { object: `0x${"00".repeat(128)}`, immutableReferences: Object.fromEntries(["rewardAsset", "ponsEscrow", "ponsFactory", "ponsHook"].map((_, index) => [String(index), [{ start: index * 32, length: 32 }]])) },
    ast: { nodes: ["rewardAsset", "ponsEscrow", "ponsFactory", "ponsHook"].map((name, id) => ({ id, name, nodeType: "VariableDeclaration", mutability: "immutable" })) },
    metadata: { compiler: { version: "0.8.26+commit.8a97fa7a" }, sources: { "src/SpreadlineFeeDistributor.sol": { keccak256: keccak256(toHex("test source")) } } },
  };
}
test("runtime verification patches every named immutable and rejects unknown or overlapping slots", () => {
  const compiled = syntheticArtifact();
  const patched = distributorRuntime(compiled, USDG);
  const expected = [USDG, PONS.escrow, PONS.factory, PONS.hook].map((address) => address.slice(2).toLowerCase().padStart(64, "0")).join("");
  assert.equal(patched, `0x${expected}`);
  const overlapping = syntheticArtifact(); overlapping.deployedBytecode.immutableReferences["1"][0].start = 0;
  assert.throws(() => distributorRuntime(overlapping, USDG), /overlapping/);
  const unknown = syntheticArtifact(); unknown.deployedBytecode.immutableReferences["99"] = [{ start: 0, length: 32 }];
  assert.throws(() => distributorRuntime(unknown, USDG), /unknown/);
  assert.throws(() => parseDistributorArtifact(compiled, "changed source"), /stale/);
});

test("compiled distributor AST and creation code match the launch constructor", { skip: !existsSync("contracts/out/SpreadlineFeeDistributor.sol/SpreadlineFeeDistributor.json") }, () => {
  const compiled = parseDistributorArtifact(JSON.parse(readFileSync("contracts/out/SpreadlineFeeDistributor.sol/SpreadlineFeeDistributor.json", "utf8")), readFileSync("contracts/src/SpreadlineFeeDistributor.sol", "utf8"));
  const runtime = distributorRuntime(compiled, USDG);
  assert.equal(runtime.length, compiled.deployedBytecode.object.length);
  assert.notEqual(keccak256(runtime), keccak256(compiled.deployedBytecode.object as Hex));
  assert.ok(distributorDeployData(compiled, draft).startsWith(compiled.bytecode.object));
  assert.notEqual(distributorRuntime(compiled, zeroAddress), runtime);
});

test("Pons V4 pool identity sorts currencies and includes hook, fee and tick spacing", () => {
  assert.equal(ponsPoolId(owner, USDG, 0, 200), ponsPoolId(USDG, owner, 0, 200));
  assert.notEqual(ponsPoolId(owner, USDG, 0, 200), ponsPoolId(owner, USDG, 0, 60));
  assert.notEqual(ponsPoolId(owner, USDG, 0, 200), ponsPoolId(owner, USDG, 100, 200));
});
