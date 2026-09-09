import { readFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData,
  getAddress, getContractAddress, http, keccak256, parseEther, zeroAddress,
  parseTransaction, recoverTransactionAddress, TransactionNotFoundError,
  type Address, type Hex, type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPonsLaunchState } from "../server/pons-service";
import { CHAIN_ID, PUBLIC_RPC } from "../src/lib/market-types";
import { feeDistributorAbi } from "../src/lib/fee-distributor-contract";
import { PONS, createPonsLaunchSalt, discoverPonsLaunchInfrastructure, ponsAddress, ponsFactoryAbi, preparePonsLaunchCall, samePonsAddress, verifyPonsRuntime } from "../src/lib/pons";
import type { LaunchDraft, PonsLaunchState } from "../src/lib/rewards-types";
import { distributorDeployData, distributorRuntime, launchPolicy, parseDistributorArtifact, parseLaunchDraft } from "./rewards-launch-lib";
import { atomicJSON } from "./rewards-indexer";

type Stage = "deploy" | "launch" | "bind" | "guardian" | "activate";
type Step = { stage: Stage; title: string; nonce: number; from: Address; to: Address | null; data: Hex; valueWei: string };
type RecordedReceipt = { stage: Stage; transactionHash: Hex; blockNumber: string; blockHash: Hex; status: "success" | "reverted" };
type LaunchPlan = {
  schema: "spreadline-pons-launch-v1"; createdAt: string; draft: LaunchDraft; salt: Hex;
  owner: Address; distributor: Address; token: Address; curve: Address; initialNonce: number;
  runtimeCodeHash: Hex; creationCodeHash: Hex; ponsState: PonsLaunchState;
  steps: Step[]; receipts: RecordedReceipt[];
  intent?: { stage: Stage; nonce: number; startedAt: string; hash: Hex; serialized: TransactionSerialized };
  configuration: Record<string, string>;
  notes: string[];
};
const { values } = parseArgs({ options: {
  help: { type: "boolean" }, draft: { type: "string" }, out: { type: "string" }, plan: { type: "string" },
  distributor: { type: "string" }, salt: { type: "string" }, execute: { type: "boolean" },
  stage: { type: "string" }, "max-launch-fee": { type: "string" }, "max-gas-fee": { type: "string" },
  "recover-tx": { type: "string" },
  "refresh-plan": { type: "boolean" },
} });
if (values.help) {
  console.log(`Spreadline Pons launch workflow (read-only unless --execute)

Prepare: node scripts/rewards-launch.mjs --draft launch-draft.json --out output/launch-plan.json
Resume preparation with a verified deployed recipient: add --distributor 0x...
Sign one reviewed stage: node scripts/rewards-launch.mjs --plan output/launch-plan.json --execute --stage deploy --max-launch-fee 0.0005 --max-gas-fee 0.01
Stages, in order: deploy, launch, bind, guardian (if configured), activate.
Recover a submitted stage after an interrupted wait: add --recover-tx 0x... --stage <stage> without --execute.
Refresh remaining unsigned stages after nonce or economics changes: --plan <file> --refresh-plan

Execution alone reads REWARDS_OWNER_KEY. ROBINHOOD_RPC_URL is optional.
Budgets are ETH: max-launch-fee caps Pons' charge; max-gas-fee caps this stage's gas.
Compile first: forge build --root contracts --ast --force
No opening purchase is implied: developerBuy must be "0" in this workflow.
`);
  process.exit(0);
}
const rpcUrl = process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC;
const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 18000, retryCount: 0, maxResponseBodySize: 2000000, batch: { batchSize: 40, wait: 10 } }) });
const artifactPath = "contracts/out/SpreadlineFeeDistributor.sol/SpreadlineFeeDistributor.json";
async function boundedJSON(path: string): Promise<unknown> {
  if ((await stat(path)).size > 4000000) throw new Error("The launch file exceeds the 4 MB limit.");
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await atomicJSON(path, value);
}
async function artifact() {
  return parseDistributorArtifact(await boundedJSON(artifactPath), await readFile("contracts/src/SpreadlineFeeDistributor.sol", "utf8"));
}
async function freshBlock() {
  const block = await client.getBlock();
  const age = Date.now() - Number(block.timestamp) * 1000;
  if (age > 120000 || age < -10000) throw new Error("The RPC returned a stale chain block.");
  await verifyPonsRuntime(client, block.number);
  return block;
}
async function nextNonce(owner: Address) {
  const [latest, pending] = await Promise.all([client.getTransactionCount({ address: owner, blockTag: "latest" }), client.getTransactionCount({ address: owner, blockTag: "pending" })]);
  if (latest !== pending) throw new Error("The owner has pending transactions. Wait for them before preparing or signing the next launch stage.");
  return pending;
}
async function checkDistributor(plan: Pick<LaunchPlan, "draft" | "distributor" | "runtimeCodeHash">, requireToken?: Address) {
  const compiled = await artifact();
  const expectedCode = distributorRuntime(compiled, getAddress(plan.draft.rewardAsset));
  if (keccak256(expectedCode) !== plan.runtimeCodeHash) throw new Error("The local build no longer matches the reviewed launch plan.");
  const block = await freshBlock();
  const code = await client.getCode({ address: plan.distributor, blockNumber: block.number });
  if (!code || code !== expectedCode) throw new Error("Distributor runtime does not exactly match the compiled source and constructor immutables.");
  const read = { address: plan.distributor, abi: feeDistributorAbi, blockNumber: block.number } as const;
  const [owner, operator, holderToken, rewardAsset, escrow, factory, hook, policy] = await Promise.all([
    client.readContract({ ...read, functionName: "owner" }), client.readContract({ ...read, functionName: "operator" }),
    client.readContract({ ...read, functionName: "holderToken" }), client.readContract({ ...read, functionName: "rewardAsset" }),
    client.readContract({ ...read, functionName: "ponsEscrow" }), client.readContract({ ...read, functionName: "ponsFactory" }),
    client.readContract({ ...read, functionName: "ponsHook" }), client.readContract({ ...read, functionName: "policy" }),
  ]);
  if (!samePonsAddress(owner, plan.draft.owner) || !samePonsAddress(operator, plan.draft.operator) || !samePonsAddress(rewardAsset, plan.draft.rewardAsset) || !samePonsAddress(escrow, PONS.escrow) || !samePonsAddress(factory, PONS.factory) || !samePonsAddress(hook, PONS.hook)) throw new Error("Distributor addresses differ from the launch draft.");
  if (requireToken && !samePonsAddress(holderToken, requireToken)) throw new Error("The distributor is not bound to the planned holder token.");
  const expected = launchPolicy(plan.draft);
  const policyValues = [expected.holderBps, expected.devBps, expected.treasuryBps, expected.intervalSeconds, expected.rootDelaySeconds, expected.minimumIncome, expected.devWallet, expected.treasuryWallet];
  if (policy.some((value, index) => String(value).toLowerCase() !== String(policyValues[index]).toLowerCase())) throw new Error("Distributor policy differs from the reviewed launch draft.");
  return { block, holderToken };
}
async function prepare() {
  if (!values.draft || values.plan || values.stage || values["recover-tx"]) throw new Error("Prepare with --draft <file> and --out <plan>; use --plan only to execute or recover a stage.");
  const draft = parseLaunchDraft(await boundedJSON(resolve(values.draft)));
  const owner = getAddress(draft.owner), guardian = getAddress(draft.guardian || owner);
  const compiled = await artifact();
  const creationData = distributorDeployData(compiled, draft);
  const runtimeCodeHash = keccak256(distributorRuntime(compiled, getAddress(draft.rewardAsset)));
  const initialNonce = await nextNonce(owner);
  const distributor = values.distributor ? ponsAddress(values.distributor, "Distributor") : getContractAddress({ from: owner, nonce: BigInt(initialNonce) });
  if ([draft.developerWallet, draft.treasuryWallet, draft.operator, owner, guardian].some((address) => samePonsAddress(address, distributor))) throw new Error("The distributor cannot be its own owner, operator, guardian or cash recipient.");
  if (values.distributor) await checkDistributor({ draft, distributor, runtimeCodeHash }, zeroAddress);
  else if (await client.getCode({ address: distributor })) throw new Error("The predicted deployment address already has code. Recheck the owner nonce.");
  const state = await getPonsLaunchState(rpcUrl, owner);
  const salt = (values.salt || createPonsLaunchSalt()) as Hex;
  const launch = preparePonsLaunchCall({ draft, state, launcher: owner, distributor, salt });
  // Read-only CREATE2 prediction through the actual factory. The balance override
  // simulates funding only; it does not modify the launcher gate or contract code.
  const simulated = await client.simulateContract({
    address: PONS.factory, abi: ponsFactoryAbi, functionName: "launchToken",
    args: [launch.params, BigInt(launch.configId), launch.pairToken], account: owner,
    value: BigInt(launch.valueWei), blockNumber: BigInt(state.blockNumber!),
    stateOverride: [{ address: owner, balance: parseEther("1") + BigInt(launch.valueWei) }],
  });
  const [token, curve] = simulated.result;
  ponsAddress(token, "Predicted token"); ponsAddress(curve, "Predicted curve");
  const steps: Step[] = [];
  const add = (stage: Stage, title: string, to: Address | null, data: Hex, valueWei = "0") => steps.push({ stage, title, nonce: initialNonce + steps.length, from: owner, to, data, valueWei });
  if (!values.distributor) add("deploy", "Deploy the fee distributor in its paused state", null, creationData);
  add("launch", "Launch the Pons token with creator fees routed to the distributor", PONS.factory, launch.data, launch.valueWei);
  add("bind", "Bind the Pons token to the distributor exactly once", distributor, encodeFunctionData({ abi: feeDistributorAbi, functionName: "bindHolderToken", args: [token] }));
  if (!samePonsAddress(guardian, owner)) add("guardian", "Set the configured pause guardian", distributor, encodeFunctionData({ abi: feeDistributorAbi, functionName: "setGuardian", args: [guardian] }));
  add("activate", "Allow fee distribution under the reviewed policy", distributor, encodeFunctionData({ abi: feeDistributorAbi, functionName: "setPaused", args: [false] }));
  const plan: LaunchPlan = {
    schema: "spreadline-pons-launch-v1", createdAt: new Date().toISOString(), draft, salt,
    owner, distributor, token, curve, initialNonce, runtimeCodeHash, creationCodeHash: keccak256(creationData),
    ponsState: state, steps, receipts: [], configuration: {},
    notes: ["Unsigned plan; no transaction has been sent.", "Execute one stage at a time. Every stage revalidates addresses, calldata and the current chain.", "Pons creator tax and pairing asset are immutable after launch. Distributor splits and schedule are owner-controlled.", "Token and curve are predicted by a read-only Pons launch simulation. Actual launch receipt must match.", "Pons internal fee conversion and buyback sweeps require its upstream operator.", "Gas and the Pons launch fee must be funded separately. This plan does not buy tokens or deposit reward capital."],
  };
  const path = resolve(values.out || ".wrangler/rewards/launch-plan.json");
  await save(path, plan);
  console.log(JSON.stringify({ plan: path, distributor, token, curve, runtimeCodeHash, launchFeeWei: launch.valueWei, stages: steps.map(({ stage }) => stage), sent: false }, null, 2));
}
async function readPlan(): Promise<{ path: string; plan: LaunchPlan }> {
  if (!values.plan || values.draft || values.distributor || values.salt) throw new Error("Execute or recover using only --plan <reviewed file> and stage options.");
  const path = resolve(values.plan);
  const value = await boundedJSON(path);
  if (!value || typeof value !== "object" || (value as { schema?: string }).schema !== "spreadline-pons-launch-v1") throw new Error("Not a Spreadline Pons launch plan.");
  const plan = value as LaunchPlan;
  plan.draft = parseLaunchDraft(plan.draft);
  if (!samePonsAddress(plan.owner, plan.draft.owner) || !Number.isSafeInteger(plan.initialNonce) || plan.initialNonce < 0 || !Array.isArray(plan.steps) || !Array.isArray(plan.receipts)) throw new Error("Invalid launch plan structure.");
  for (const [label, address] of [["Owner", plan.owner], ["Distributor", plan.distributor], ["Token", plan.token], ["Curve", plan.curve]] as const) ponsAddress(address, label);
  return { path, plan };
}
async function validatedStep(plan: LaunchPlan, stage: Stage): Promise<Step> {
  const step = plan.steps.find((item) => item.stage === stage);
  if (!step || !samePonsAddress(step.from, plan.owner)) throw new Error("The selected stage is not in this reviewed plan.");
  const compiled = await artifact();
  const creationData = distributorDeployData(compiled, plan.draft);
  if (keccak256(creationData) !== plan.creationCodeHash || keccak256(distributorRuntime(compiled, getAddress(plan.draft.rewardAsset))) !== plan.runtimeCodeHash) throw new Error("The compiled source or constructor terms changed after plan preparation.");
  let expected: { to: Address | null; data: Hex; valueWei: string };
  if (stage === "deploy") {
    if (getContractAddress({ from: plan.owner, nonce: BigInt(step.nonce) }) !== plan.distributor || step.nonce !== plan.initialNonce) throw new Error("Deployment nonce no longer predicts the reviewed distributor address.");
    if (await client.getCode({ address: plan.distributor })) throw new Error("The distributor is already deployed; recover its receipt instead of redeploying.");
    expected = { to: null, data: creationData, valueWei: "0" };
  } else {
    await checkDistributor(plan, stage === "launch" ? zeroAddress : stage === "bind" ? undefined : plan.token);
    if (stage === "launch") {
      const state = await getPonsLaunchState(rpcUrl, plan.owner);
      const launch = preparePonsLaunchCall({ draft: plan.draft, state, launcher: plan.owner, distributor: plan.distributor, salt: plan.salt });
      expected = { to: PONS.factory, data: launch.data, valueWei: launch.valueWei };
    } else if (stage === "bind") {
      const block = await freshBlock();
      const { launch } = await discoverPonsLaunchInfrastructure(client, plan.token, block.number);
      if (!samePonsAddress(launch.curve, plan.curve) || !samePonsAddress(launch.creatorFeeRecipient, plan.distributor) || !samePonsAddress(launch.pairToken, plan.draft.rewardAsset) || !samePonsAddress(launch.deployer, plan.owner)) throw new Error("The actual Pons launch does not match this plan.");
      expected = { to: plan.distributor, data: encodeFunctionData({ abi: feeDistributorAbi, functionName: "bindHolderToken", args: [plan.token] }), valueWei: "0" };
    } else if (stage === "guardian") expected = { to: plan.distributor, data: encodeFunctionData({ abi: feeDistributorAbi, functionName: "setGuardian", args: [getAddress(plan.draft.guardian || plan.owner)] }), valueWei: "0" };
    else {
      const guardian = await client.readContract({ address: plan.distributor, abi: feeDistributorAbi, functionName: "guardian" });
      if (!samePonsAddress(guardian, plan.draft.guardian || plan.owner)) throw new Error("Set the reviewed guardian before activation.");
      expected = { to: plan.distributor, data: encodeFunctionData({ abi: feeDistributorAbi, functionName: "setPaused", args: [false] }), valueWei: "0" };
    }
  }
  if (expected.to?.toLowerCase() !== step.to?.toLowerCase() || expected.data !== step.data || expected.valueWei !== step.valueWei) throw new Error("Calldata or Pons economics changed. Prepare a new reviewed plan before signing.");
  return step;
}
async function recordReceipt(path: string, plan: LaunchPlan, step: Step, hash: Hex) {
  const transaction = await client.getTransaction({ hash });
  if (!samePonsAddress(transaction.from, plan.owner) || transaction.nonce !== step.nonce || transaction.to?.toLowerCase() !== step.to?.toLowerCase() || transaction.input !== step.data || transaction.value !== BigInt(step.valueWei)) throw new Error("Transaction does not match the reviewed stage.");
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 12, timeout: 60000 });
  const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonicalBlock.hash !== receipt.blockHash) throw new Error("The receipt block was reorganized. Reconcile the recorded submission before continuing.");
  if (receipt.status === "success" && step.stage === "deploy") {
    if (!receipt.contractAddress || !samePonsAddress(receipt.contractAddress, plan.distributor)) throw new Error("Deployment address differs from the plan.");
    const verified = await checkDistributor(plan);
    if (!samePonsAddress(verified.holderToken, zeroAddress) && !samePonsAddress(verified.holderToken, plan.token)) throw new Error("The deployed distributor is bound to a different token.");
    plan.configuration.REWARDS_DISTRIBUTOR_ADDRESS = plan.distributor;
    plan.configuration.REWARDS_DISTRIBUTOR_CODE_HASH = plan.runtimeCodeHash;
    plan.configuration.REWARDS_DEPLOY_BLOCK = String(receipt.blockNumber);
  }
  if (receipt.status === "success" && step.stage === "launch") {
    let matched = false;
    for (const log of receipt.logs.filter((item) => samePonsAddress(item.address, PONS.factory))) {
      try {
        const decoded = decodeEventLog({ abi: ponsFactoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
        if (samePonsAddress(decoded.args.token, plan.token) && samePonsAddress(decoded.args.curve, plan.curve) && samePonsAddress(decoded.args.deployer, plan.owner)) matched = true;
      } catch { /* Other factory events are irrelevant. */ }
    }
    if (!matched) throw new Error("The launch receipt does not contain the predicted token and curve.");
    plan.configuration.REWARDS_TOKEN_DEPLOY_BLOCK = String(receipt.blockNumber);
  }
  plan.receipts = [...plan.receipts.filter((item) => item.transactionHash !== hash), { stage: step.stage, transactionHash: hash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, status: receipt.status }];
  delete plan.intent;
  await save(path, plan);
  await save(`${path}.configuration.json`, plan.configuration);
  if (receipt.status !== "success") throw new Error("The stage reverted. Its receipt was recorded; prepare a fresh plan for the remaining stages.");
  console.log(JSON.stringify({ stage: step.stage, transactionHash: hash, blockNumber: String(receipt.blockNumber), configuration: plan.configuration }, null, 2));
}
async function refreshPlan() {
  if (values.execute || values.stage || values["recover-tx"]) throw new Error("--refresh-plan refreshes unsigned remaining stages and cannot sign or recover a transaction.");
  const { path, plan } = await readPlan();
  if (plan.intent) throw new Error("Recover or rebroadcast the unresolved signed transaction before refreshing the plan.");
  const compiled = await artifact();
  const creationData = distributorDeployData(compiled, plan.draft);
  if (keccak256(creationData) !== plan.creationCodeHash || keccak256(distributorRuntime(compiled, getAddress(plan.draft.rewardAsset))) !== plan.runtimeCodeHash) throw new Error("The local source changed. Preserve the original deployment build before resuming this plan.");
  await freshBlock();
  for (const recorded of plan.receipts) {
    const [receipt, block] = await Promise.all([client.getTransactionReceipt({ hash: recorded.transactionHash }), client.getBlock({ blockNumber: BigInt(recorded.blockNumber) })]);
    if (receipt.blockHash !== recorded.blockHash || block.hash !== recorded.blockHash || receipt.status !== recorded.status) throw new Error("A recorded launch receipt no longer matches the canonical chain.");
  }
  const completed = new Set(plan.receipts.filter((receipt) => receipt.status === "success").map((receipt) => receipt.stage));
  const pending = plan.steps.filter((step) => !completed.has(step.stage));
  if (!pending.length) { console.log("All launch stages already have successful receipts."); return; }
  const nonce = await nextNonce(plan.owner);
  if (pending.some((step) => step.stage === "deploy")) {
    plan.initialNonce = nonce;
    plan.distributor = getContractAddress({ from: plan.owner, nonce: BigInt(nonce) });
    if (await client.getCode({ address: plan.distributor })) throw new Error("The refreshed deployment address already has code.");
  } else await checkDistributor(plan);
  if (pending.some((step) => step.stage === "launch")) {
    const state = await getPonsLaunchState(rpcUrl, plan.owner);
    const launch = preparePonsLaunchCall({ draft: plan.draft, state, launcher: plan.owner, distributor: plan.distributor, salt: plan.salt });
    const simulated = await client.simulateContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "launchToken", args: [launch.params, BigInt(launch.configId), launch.pairToken], account: plan.owner, value: BigInt(launch.valueWei), blockNumber: BigInt(state.blockNumber!), stateOverride: [{ address: plan.owner, balance: parseEther("1") + BigInt(launch.valueWei) }] });
    [plan.token, plan.curve] = simulated.result;
    plan.ponsState = state;
    const launchStep = pending.find((step) => step.stage === "launch")!;
    launchStep.to = PONS.factory; launchStep.data = launch.data; launchStep.valueWei = launch.valueWei;
  }
  for (const [index, step] of pending.entries()) {
    step.nonce = nonce + index;
    if (step.stage === "deploy") { step.to = null; step.data = creationData; }
    if (step.stage === "bind") { step.to = plan.distributor; step.data = encodeFunctionData({ abi: feeDistributorAbi, functionName: "bindHolderToken", args: [plan.token] }); }
    if (step.stage === "guardian") { step.to = plan.distributor; step.data = encodeFunctionData({ abi: feeDistributorAbi, functionName: "setGuardian", args: [getAddress(plan.draft.guardian || plan.owner)] }); }
    if (step.stage === "activate") { step.to = plan.distributor; step.data = encodeFunctionData({ abi: feeDistributorAbi, functionName: "setPaused", args: [false] }); }
  }
  plan.createdAt = new Date().toISOString();
  await save(path, plan);
  console.log(JSON.stringify({ refreshed: path, remainingStages: pending.map((step) => step.stage), preservedReceipts: plan.receipts.length, configuration: plan.configuration, sent: false }, null, 2));
}
async function executeOrRecover() {
  const { path, plan } = await readPlan();
  const stage = values.stage as Stage;
  if (!["deploy", "launch", "bind", "guardian", "activate"].includes(stage)) throw new Error("Select --stage deploy|launch|bind|guardian|activate.");
  const step = plan.steps.find((item) => item.stage === stage);
  if (!step) throw new Error("This stage is not required by the plan.");
  if (values["recover-tx"]) {
    if (values.execute || !/^0x[\da-f]{64}$/i.test(values["recover-tx"])) throw new Error("Recovery is a read-only operation and requires a transaction hash.");
    await freshBlock();
    await recordReceipt(path, plan, step, values["recover-tx"] as Hex);
    return;
  }
  if (!values.execute) throw new Error("Use --execute to sign one stage, or --recover-tx to record an existing transaction.");
  if (plan.intent && plan.intent.stage !== stage) throw new Error("A different stage has an unresolved submission. Recover it first.");
  if (plan.receipts.some((receipt) => receipt.stage === stage && receipt.status === "success")) throw new Error("This stage already has a successful receipt. Do not submit it twice.");
  const position = plan.steps.findIndex((item) => item.stage === stage);
  if (plan.steps.slice(0, position).some((prior) => !plan.receipts.some((receipt) => receipt.stage === prior.stage && receipt.status === "success"))) throw new Error("Complete or recover the preceding stages first.");
  if (!values["max-launch-fee"] || !values["max-gas-fee"] || !/^\d+(?:\.\d{1,18})?$/.test(values["max-launch-fee"]) || !/^\d+(?:\.\d{1,18})?$/.test(values["max-gas-fee"])) throw new Error("Explicit positive ETH budgets --max-launch-fee and --max-gas-fee are required for execution.");
  const launchBudget = parseEther(values["max-launch-fee"]), gasBudget = parseEther(values["max-gas-fee"]);
  if (launchBudget <= 0n || gasBudget <= 0n) throw new Error("Execution budgets must be positive.");
  // Keys are touched only after explicit execution, validated budgets and a chosen stage.
  const key = process.env.REWARDS_OWNER_KEY;
  if (!key || !/^0x[\da-f]{64}$/i.test(key)) throw new Error("Set REWARDS_OWNER_KEY in the environment for explicit stage execution.");
  const account = privateKeyToAccount(key as Hex);
  if (!samePonsAddress(account.address, plan.owner)) throw new Error("The execution key does not belong to the owner in the reviewed plan.");
  if (plan.intent) {
    const { hash, serialized } = plan.intent;
    if (!serialized || keccak256(serialized) !== hash || !samePonsAddress(await recoverTransactionAddress({ serializedTransaction: serialized }), plan.owner)) throw new Error("The unresolved signed transaction cannot be verified. Do not create a replacement automatically.");
    const signed = parseTransaction(serialized);
    if (signed.chainId !== CHAIN_ID || signed.nonce !== step.nonce || signed.to?.toLowerCase() !== step.to?.toLowerCase() || signed.data !== step.data || (signed.value ?? 0n) !== BigInt(step.valueWei) || !signed.gas || signed.gasPrice === undefined || signed.gas * signed.gasPrice > gasBudget || (signed.value ?? 0n) > launchBudget) throw new Error("The saved signed transaction differs from the stage or exceeds the execution budgets.");
    try { await client.getTransaction({ hash }); await recordReceipt(path, plan, step, hash); return; }
    catch (error) { if (!(error instanceof TransactionNotFoundError)) throw error; }
    await validatedStep(plan, stage);
    if (await nextNonce(plan.owner) !== step.nonce) throw new Error("The saved nonce is already in use. Reconcile the original transaction instead of replacing it.");
    const submittedHash = await client.sendRawTransaction({ serializedTransaction: serialized });
    if (submittedHash !== hash) throw new Error("The rebroadcast hash differs from the saved signed transaction.");
    await recordReceipt(path, plan, step, hash);
    return;
  }
  await validatedStep(plan, stage);
  if (await nextNonce(plan.owner) !== step.nonce) throw new Error("The owner's nonce changed. Prepare a new plan for the remaining stages before signing.");
  if (BigInt(step.valueWei) > launchBudget) throw new Error("The Pons fee exceeds the explicit launch-fee budget.");
  const request = { account: plan.owner, to: step.to ?? undefined, data: step.data, value: BigInt(step.valueWei) };
  const [estimatedGas, gasPrice, balance] = await Promise.all([client.estimateGas(request), client.getGasPrice(), client.getBalance({ address: plan.owner })]);
  const gas = (estimatedGas * 120n + 99n) / 100n;
  if (gas * gasPrice > gasBudget) throw new Error("Estimated gas exceeds the per-stage ETH gas budget.");
  if (balance < gas * gasPrice + BigInt(step.valueWei)) throw new Error("The owner wallet cannot fund this stage's fee and gas allowance.");
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 18000, retryCount: 0 }) });
  const serialized = await wallet.signTransaction({ to: step.to ?? undefined, data: step.data, value: BigInt(step.valueWei), nonce: step.nonce, gas, gasPrice, chainId: CHAIN_ID });
  const hash = keccak256(serialized);
  plan.intent = { stage, nonce: step.nonce, startedAt: new Date().toISOString(), hash, serialized };
  await save(path, plan);
  const submittedHash = await client.sendRawTransaction({ serializedTransaction: serialized });
  if (submittedHash !== hash) throw new Error("The RPC submission hash differs from the locally signed transaction. Reconcile the recorded intent before continuing.");
  console.log(JSON.stringify({ stage, submitted: hash, awaitingConfirmations: 12 }));
  await recordReceipt(path, plan, step, hash);
}
try {
  if (values["refresh-plan"]) await refreshPlan();
  else if (values.execute || values.plan || values["recover-tx"]) await executeOrRecover();
  else await prepare();
} catch (error) {
  const message = error && typeof error === "object" && "shortMessage" in error ? String(error.shortMessage) : error instanceof Error ? error.message : "Launch workflow failed.";
  console.error(message);
  process.exitCode = 1;
}
