import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, parseEther, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CHAIN_ID, PUBLIC_RPC } from "../src/lib/market-types";
import { feeDistributorAbi } from "../src/lib/fee-distributor-contract";
import { buildRewardManifest, canonicalJSON, rewardContentHash, validateRewardManifest, validateRewardPage, type RewardManifest, type RewardPage } from "../src/lib/reward-merkle";
import { discoverPonsLaunchInfrastructure, PONS, ponsCurveAbi, ponsEscrowAbi, ponsHookAbi, samePonsAddress } from "../src/lib/pons";
import { assertManifestMatchesEpoch, serializeRewardEpoch } from "../server/rewards-service";
import { atomicJSON, indexHolders } from "./rewards-indexer";

const flags = process.argv.slice(2);
if (flags.includes("--help")) {
  console.log(`Spreadline token reward keeper
Default: read-only readiness report. --execute performs one bounded cycle. --execute --watch runs continuously.
Required: REWARDS_DISTRIBUTOR_ADDRESS, REWARDS_DISTRIBUTOR_CODE_HASH, REWARDS_DEPLOY_BLOCK,
REWARDS_TOKEN_DEPLOY_BLOCK, REWARDS_API_URL (your HTTPS dapp origin).
Execution additionally requires REWARDS_OPERATOR_KEY and REWARDS_DAILY_GAS_BUDGET_ETH.
Optional: ROBINHOOD_RPC_URL, REWARDS_STATE_DIR, REWARDS_CONFIRMATIONS (>=12; default24),
REWARDS_MAX_GAS_PER_TX (default3000000), REWARDS_MAX_BATCHES (default4),
REWARDS_MIN_AUTO_PAYOUT_RAW (default1), REWARDS_EXTRA_EXCLUSIONS (JSON array of {address,reason}).
The operator key belongs in a server secret manager. It only needs distributor operator authority and ETH for gas.
Start one instance per state directory. State, transaction journal, proofs and gas budget survive restarts.`);
  process.exit(0);
}
if (flags.some(flag => !["--execute", "--watch"].includes(flag))) throw new Error("Unknown option; use --help.");
const execute = flags.includes("--execute"), watch = flags.includes("--watch");
const env = process.env;
const rpc = env.ROBINHOOD_RPC_URL || PUBLIC_RPC;
const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc, { timeout: 18000, retryCount: 1, maxResponseBodySize: 2_000_000 });
const client = createPublicClient({ chain, transport });
const distributor = getAddress(env.REWARDS_DISTRIBUTOR_ADDRESS || "");
const expectedCodeHash = env.REWARDS_DISTRIBUTOR_CODE_HASH || "";
if (!/^0x[\da-f]{64}$/i.test(expectedCodeHash)) throw new Error("Configure the reviewed distributor runtime hash.");
const tokenDeployment = BigInt(env.REWARDS_TOKEN_DEPLOY_BLOCK || "0");
const distributorDeployment = BigInt(env.REWARDS_DEPLOY_BLOCK || "0");
if (tokenDeployment <= 0n || distributorDeployment <= 0n) throw new Error("Configure both exact deployment blocks from the launch receipts.");
const api = new URL(env.REWARDS_API_URL || "https://unconfigured.invalid");
if (api.hostname === "unconfigured.invalid" || api.username || api.password || api.pathname !== "/" || (api.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(api.hostname))) throw new Error("REWARDS_API_URL must be your HTTPS dapp origin (or localhost for local tests).");
const account = execute ? privateKeyToAccount((env.REWARDS_OPERATOR_KEY || "") as Hex) : undefined;
const wallet = account ? createWalletClient({ account, chain, transport }) : undefined;
const dailyBudget = parseEther(env.REWARDS_DAILY_GAS_BUDGET_ETH || "0");
if (execute && dailyBudget <= 0n) throw new Error("Set an explicit positive daily gas budget before enabling execution.");
const confirmations = BigInt(env.REWARDS_CONFIRMATIONS || "24");
if (confirmations < 12n || confirmations > 10000n) throw new Error("Confirmations must be between 12 and 10000.");
const maxGas = BigInt(env.REWARDS_MAX_GAS_PER_TX || "3000000");
const maxBatches = Number(env.REWARDS_MAX_BATCHES || "4");
if (maxGas < 100000n || maxGas > 10000000n || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) throw new Error("Invalid gas or batch bound.");
const minimumPayout = BigInt(env.REWARDS_MIN_AUTO_PAYOUT_RAW || "1");
if (minimumPayout < 1n) throw new Error("Minimum automatic payout must be at least one raw unit.");
const extras = JSON.parse(env.REWARDS_EXTRA_EXCLUSIONS || "[]") as { address: string; reason: string }[];
if (!Array.isArray(extras) || extras.length > 100 || extras.some(item => typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 180)) throw new Error("Each optional holder exclusion needs a public reason.");
const extraExclusions = extras.map(item => ({ address: getAddress(item.address), reason: item.reason.trim() }));
const stateDir = resolve(env.REWARDS_STATE_DIR || `.wrangler/rewards/state-${distributor.toLowerCase()}`);
await mkdir(stateDir, { recursive: true });
const statePath = resolve(stateDir, "keeper.json");
type Pending = { hash: Hex; raw: Hex; reservedWei: string; day: string; label: string };
type State = { distributor: Address; codeHash: string; operator: Address | null; gasByDay: Record<string, string>; pending?: Pending; lastDiscovered: string; failures: Record<string, number>; completed: string[]; cursor: number };
let state: State;
const lockPath = resolve(stateDir, "keeper.lock");
try {
  const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); await lock.close();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  const pid = Number(await readFile(lockPath, "utf8"));
  let running = true;
  try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") running = false; else throw probe; }
  if (running) throw new Error("Another keeper is using this state directory.");
  await unlink(lockPath); const lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); await lock.close();
}
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { distributor, codeHash: expectedCodeHash, operator: account?.address || null, gasByDay: {}, lastDiscovered: "0", failures: {}, completed: [], cursor: 0 }; }
if (!samePonsAddress(state.distributor, distributor) || state.codeHash !== expectedCodeHash || account && state.operator && !samePonsAddress(state.operator, account.address)) throw new Error("Keeper state belongs to a different deployment or signer.");
if (account) state.operator = account.address;
let stopping = false;
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
const log = (status: string, details: object = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), mode: execute ? "execute" : "read-only", status, ...details }));
const save = () => atomicJSON(statePath, state);

async function resumePending() {
  if (!state.pending) return;
  const pending = state.pending;
  let receipt = await client.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
  if (!receipt) {
    // Rebroadcast the exact signed bytes. Its nonce and hash cannot create a second payout.
    await client.sendRawTransaction({ serializedTransaction: pending.raw }).catch(() => undefined);
  }
  receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations: Number(confirmations), timeout: 180000 });
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error("Transaction receipt was reorganized; its journal is retained until canonical confirmation.");
  const cost = receipt.gasUsed * receipt.effectiveGasPrice;
  const reserved = BigInt(pending.reservedWei);
  state.gasByDay[pending.day] = String(BigInt(state.gasByDay[pending.day] || "0") - reserved + cost);
  delete state.pending;
  await save();
  log(receipt.status === "success" ? "transaction-confirmed" : "transaction-reverted", { operation: pending.label, hash: receipt.transactionHash, gasCostWei: String(cost) });
  if (receipt.status !== "success") throw new Error("A keeper transaction reverted; state was preserved for retry and review.");
  return receipt;
}

async function send(data: Hex, label: string) {
  if (!account || !wallet) throw new Error("Execution is disabled.");
  if (state.pending) await resumePending();
  const [chainId, block, nonce, pendingNonce] = await Promise.all([client.getChainId(), client.getBlock(), client.getTransactionCount({ address: account.address }), client.getTransactionCount({ address: account.address, blockTag: "pending" })]);
  if (chainId !== CHAIN_ID || Date.now() - Number(block.timestamp) * 1000 > 120000 || nonce !== pendingNonce) throw new Error("Chain state is stale or the operator has an untracked pending transaction.");
  const code = await client.getCode({ address: distributor });
  if (!code || keccak256(code).toLowerCase() !== expectedCodeHash.toLowerCase()) throw new Error("Distributor runtime changed.");
  await client.call({ account, to: distributor, data, value: 0n });
  const [estimate, fees, balance] = await Promise.all([client.estimateGas({ account, to: distributor, data, value: 0n }), client.estimateFeesPerGas(), client.getBalance({ address: account.address })]);
  const gas = estimate * 120n / 100n;
  if (gas > maxGas) throw new Error("Transaction exceeds the configured gas limit. Reduce batch size or review the limit.");
  const reserved = gas * fees.maxFeePerGas;
  const day = new Date().toISOString().slice(0, 10);
  if (BigInt(state.gasByDay[day] || "0") + reserved > dailyBudget || balance < reserved) throw new Error("The daily gas budget or operator ETH balance is insufficient.");
  const raw = await wallet.signTransaction({ account, chain, to: distributor, data, value: 0n, nonce, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  state.gasByDay[day] = String(BigInt(state.gasByDay[day] || "0") + reserved);
  state.pending = { hash: keccak256(raw), raw, reservedWei: String(reserved), day, label };
  await save();
  return resumePending();
}

async function apiJSON(epoch: string, hash?: Hex, body?: unknown) {
  const url = new URL("/api/rewards/manifest", api);
  url.searchParams.set("epoch", epoch); if (hash) url.searchParams.set("page", hash);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : canonicalJSON(body), signal: AbortSignal.timeout(25000) });
    if (response.ok) return response.json();
    if (attempt === 3 || response.status === 400 || response.status === 404) throw new Error(`Proof publication/read failed (${response.status}); activation will wait until all pages are public.`);
    await delay(Math.min(60000, Number(response.headers.get("retry-after") || 5) * 1000));
  }
  throw new Error("Proof API unavailable.");
}
type EpochBundle = { manifest: RewardManifest; manifestHash: Hex; pages: RewardPage[] };
async function loadBundle(id: bigint): Promise<EpochBundle> {
  let bundle: EpochBundle;
  const path = resolve(stateDir, `epoch-${id}.json`);
  try { bundle = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const manifest = validateRewardManifest(await apiJSON(String(id)));
    const pages: RewardPage[] = [];
    for (const page of manifest.pages) pages.push(validateRewardPage(await apiJSON(String(id), page.hash), manifest, page.hash));
    bundle = { manifest, manifestHash: rewardContentHash(manifest), pages };
    await atomicJSON(path, bundle);
  }
  bundle.manifest = validateRewardManifest(bundle.manifest);
  if (rewardContentHash(bundle.manifest) !== bundle.manifestHash || bundle.pages.length !== bundle.manifest.pages.length) throw new Error("Corrupt local distribution manifest.");
  bundle.pages.forEach((page, index) => validateRewardPage(page, bundle.manifest, bundle.manifest.pages[index].hash));
  const { version: _format, root: _root, totalEligibleWeight: _total, pages: _pages, ...input } = bundle.manifest;
  void _format; void _root; void _total; void _pages;
  const rebuilt = buildRewardManifest(input, new Map(bundle.pages.flatMap(page => page.entries.map(entry => [entry.account, BigInt(entry.weight)] as const))));
  if (rebuilt.manifestHash !== bundle.manifestHash) throw new Error("The complete holder list does not reproduce the committed root, eligible weight and deterministic manifest.");
  return bundle;
}
async function publish(bundle: EpochBundle) {
  await apiJSON(bundle.manifest.epochId, undefined, bundle.manifest);
  for (let index = 0; index < bundle.pages.length; index++) await apiJSON(bundle.manifest.epochId, bundle.manifest.pages[index].hash, bundle.pages[index]);
  log("proofs-published", { epoch: bundle.manifest.epochId, holders: bundle.pages.reduce((sum, page) => sum + page.entries.length, 0) });
}

async function cycle() {
  if (execute && state.pending) await resumePending();
  const block = await client.getBlock();
  if (await client.getChainId() !== CHAIN_ID || block.number < distributorDeployment || Date.now() - Number(block.timestamp) * 1000 > 120000) throw new Error("A current Robinhood Chain block is required.");
  const code = await client.getCode({ address: distributor, blockNumber: block.number });
  if (!code || keccak256(code).toLowerCase() !== expectedCodeHash.toLowerCase()) throw new Error("Distributor code does not match the reviewed deployment.");
  const at = { address: distributor, abi: feeDistributorAbi, blockNumber: block.number } as const;
  const [token, asset, escrow, operator, owner, paused, policy, version, lastProposedAt, nextEpoch, available] = await Promise.all([
    client.readContract({ ...at, functionName: "holderToken" }), client.readContract({ ...at, functionName: "rewardAsset" }), client.readContract({ ...at, functionName: "ponsEscrow" }), client.readContract({ ...at, functionName: "operator" }), client.readContract({ ...at, functionName: "owner" }), client.readContract({ ...at, functionName: "paused" }), client.readContract({ ...at, functionName: "policy" }), client.readContract({ ...at, functionName: "policyVersion" }), client.readContract({ ...at, functionName: "lastProposedAt" }), client.readContract({ ...at, functionName: "nextEpochId" }), client.readContract({ ...at, functionName: "availableIncome" }),
  ]);
  if (samePonsAddress(token, zeroAddress) || !samePonsAddress(escrow, PONS.escrow)) throw new Error("Bind the Pons token and verify its fee escrow first.");
  if (account && ![owner, operator].some(address => samePonsAddress(address, account.address))) throw new Error("The signing account is not the distributor owner/operator.");
  const infrastructure = await discoverPonsLaunchInfrastructure(client, token, block.number);
  if (!samePonsAddress(infrastructure.launch.creatorFeeRecipient, distributor) || !samePonsAddress(infrastructure.launch.pairToken, asset)) throw new Error("Pons fees are not routed to this distributor in its immutable reward currency.");
  const credit = samePonsAddress(asset, zeroAddress)
    ? await client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOf", args: [distributor] })
    : await client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOfToken", args: [distributor, asset] });
  log("ready", { block: String(block.number), paused, creatorFeesInEscrow: String(credit), unallocated: String(available), nextEpoch: String(nextEpoch), nextProposalAt: String(lastProposedAt + policy[3]) });
  if (!execute) return;
  // Sweeps are separate bounded calls. Token-side conversions/buybacks that require
  // Pons' trusted sweeper remain pending there; they are never booked as receipts.
  if (!paused) {
    try {
    if (infrastructure.launch.phase === 0) {
      const [curveFees, creatorTax] = await Promise.all([client.readContract({ address: infrastructure.launch.curve, abi: ponsCurveAbi, functionName: "quoteFeeBalance" }), client.readContract({ address: infrastructure.launch.curve, abi: ponsCurveAbi, functionName: "creatorTaxBalance" })]);
      if (curveFees + creatorTax > 0n) await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "sweepCurveFees" }), "sweep-curve-fees");
    }
    if (infrastructure.launch.phase === 2) {
      const [poolFees, poolTax] = await Promise.all([client.readContract({ address: PONS.hook, abi: ponsHookAbi, functionName: "pendingFees", args: [infrastructure.poolId, asset] }), client.readContract({ address: PONS.hook, abi: ponsHookAbi, functionName: "pendingCreatorTax", args: [infrastructure.poolId, asset] })]);
      if (poolFees + poolTax > 0n) await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "sweepPoolFees" }), "sweep-pool-fees");
    }
    } catch (error) { log("pons-sweep-pending", { reason: error instanceof Error ? error.message.slice(0, 180) : "unknown", detail: "Existing holder claims continue; conversion/buyback legs may require Pons' fee sweep operator." }); }
  }
  const freshCredit = samePonsAddress(asset, zeroAddress) ? await client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOf", args: [distributor] }) : await client.readContract({ address: escrow, abi: ponsEscrowAbi, functionName: "balanceOfToken", args: [distributor, asset] });
  if (freshCredit > 0n) {
    try { await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "collectPonsFees" }), "collect-creator-fees"); }
    catch (error) { log("fee-collection-pending", { reason: error instanceof Error ? error.message.slice(0, 180) : "unknown", detail: "Existing collected income and activated claims remain available." }); }
  }
  // Discover every epoch since the last checkpoint, including another publisher's.
  const freshNext = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "nextEpochId" });
  let discovered = BigInt(state.lastDiscovered);
  for (let id = discovered + 1n; id < freshNext && id <= discovered + 20n; id++) {
    const epoch = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "epochs", args: [id] });
    if (epoch.state !== 3) {
      try { await loadBundle(id); } catch { log("distribution-proof-missing", { epoch: String(id), detail: "Previously published rewards will still be processed." }); break; }
    }
    else state.completed.push(String(id));
    state.lastDiscovered = String(id); await save();
  }
  discovered = BigInt(state.lastDiscovered);
  const localIds = (await readdir(stateDir)).flatMap(name => /^epoch-([1-9]\d*)\.json$/.exec(name)?.[1] || []).filter(id => BigInt(id) <= discovered && !state.completed.includes(id)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  let batches = 0;
  for (let offset = 0; offset < Math.min(localIds.length, 20) && batches < maxBatches; offset++) {
    const id = BigInt(localIds[(state.cursor + offset) % localIds.length]);
    let epoch = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "epochs", args: [id] });
    if (epoch.state === 3) { state.completed.push(String(id)); continue; }
    const bundle = await loadBundle(id);
    assertManifestMatchesEpoch(bundle.manifest, serializeRewardEpoch(id, epoch), distributor, token);
    if (epoch.state === 1) {
      try {
        if ((await client.getBlock({ blockNumber: epoch.snapshotBlock })).hash !== epoch.snapshotBlockHash) throw new Error("The distribution snapshot was reorganized. Owner or guardian review is required.");
        await publish(bundle);
      } catch (error) { log("pending-distribution-needs-attention", { epoch: String(id), reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }); continue; }
      const now = await client.getBlock();
      if (!paused && now.timestamp >= epoch.readyAt) {
        if ((await client.getBlock({ blockNumber: epoch.snapshotBlock })).hash !== epoch.snapshotBlockHash) { log("snapshot-reorganized", { epoch: String(id), detail: "Activation stopped; previously activated claims remain payable." }); continue; }
        await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "activateEpoch", args: [id] }), "activate-distribution");
        epoch = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "epochs", args: [id] });
      } else continue;
    }
    let cashPending = false;
    for (const cashWallet of new Set([epoch.devWallet, epoch.treasuryWallet])) {
      const [dev, treasury] = await Promise.all([client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "pendingDev", args: [cashWallet] }), client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "pendingTreasury", args: [cashWallet] })]);
      if (dev + treasury > 0n) {
        try { await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "withdrawCashFor", args: [cashWallet] }), "pay-dev-treasury"); }
        catch (error) { cashPending = true; log("cash-payment-needs-attention", { wallet: cashWallet, reason: error instanceof Error ? error.message.slice(0, 180) : "unknown" }); }
      }
    }
    let unpaid = false;
    for (const page of bundle.pages) {
      const results: { entry: RewardPage["entries"][number]; claimed: boolean }[] = [];
      for (let start = 0; start < page.entries.length; start += 16) results.push(...await Promise.all(page.entries.slice(start, start + 16).map(async entry => ({ entry, claimed: await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "hasClaimed", args: [id, entry.account] }) }))));
      const due = results.filter(({ entry, claimed }) => !claimed && epoch.holderBudget * BigInt(entry.weight) / epoch.totalEligibleWeight > 0n);
      if (due.length) unpaid = true;
      const eligible = due.filter(({ entry }) => epoch.holderBudget * BigInt(entry.weight) / epoch.totalEligibleWeight >= minimumPayout && (state.failures[`${id}:${entry.account}`] || 0) < 3);
      for (let start = 0; start < eligible.length && batches < maxBatches; start += 16) {
        const claims = eligible.slice(start, start + 16).map(({ entry }) => ({ epochId: id, account: entry.account, weight: BigInt(entry.weight), proof: entry.proof }));
        const receipt = await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "distributeClaims", args: [claims] }), "pay-holder-batch");
        if (receipt) for (const event of parseEventLogs({ abi: feeDistributorAbi, eventName: "ClaimSkipped", logs: receipt.logs })) state.failures[`${event.args.epochId}:${event.args.account.toLowerCase()}`] = (state.failures[`${event.args.epochId}:${event.args.account.toLowerCase()}`] || 0) + 1;
        batches++; await save();
      }
      if (batches >= maxBatches) break;
    }
    if (!unpaid && !cashPending) state.completed.push(String(id));
  }
  state.cursor = localIds.length ? (state.cursor + 1) % localIds.length : 0;
  await save();
  if (paused || discovered < freshNext - 1n) return;
  const currentBlock = await client.getBlock();
  const income = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "availableIncome" });
  if (income < policy[5] || currentBlock.timestamp < lastProposedAt + policy[3]) return;
  const id = await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "nextEpochId" });
  const snapshotBlock = currentBlock.number - confirmations;
  const snapshot = await indexHolders(client, { chainId: CHAIN_ID, token, deploymentBlock: tokenDeployment, snapshotBlock, checkpointPath: resolve(stateDir, "holders.json"), onProgress: block => log("holders-indexed", { block: String(block) }) });
  const exclusions = [...infrastructure.mandatoryExclusions.map(address => ({ address, reason: "Pons infrastructure, pool inventory, token contract or burn address" })), { address: distributor, reason: "Reward distributor inventory" }, ...extraExclusions];
  const bundle = buildRewardManifest({ chainId: CHAIN_ID, distributor, holderToken: token, epochId: String(id), snapshotBlock: String(snapshot.block.number), snapshotBlockHash: snapshot.block.hash,
    grossIncome: String(income), holderBudget: String(income * BigInt(policy[0]) / 10000n), policyVersion: String(version), exclusions }, snapshot.balances);
  // Check settings again after indexing. Do not publish under a policy changed mid-snapshot.
  if (await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "policyVersion" }) !== version || await client.readContract({ address: distributor, abi: feeDistributorAbi, functionName: "nextEpochId" }) !== id || (await client.getBlock({ blockNumber: snapshotBlock })).hash !== snapshot.block.hash) throw new Error("Policy, epoch or snapshot changed during preparation. Retry with fresh state.");
  await atomicJSON(resolve(stateDir, `epoch-${id}.json`), bundle);
  await send(encodeFunctionData({ abi: feeDistributorAbi, functionName: "proposeEpoch", args: [bundle.manifest.root, snapshotBlock, snapshot.block.hash, bundle.manifestHash, BigInt(bundle.manifest.totalEligibleWeight), income] }), "propose-distribution");
  await publish(bundle);
  log("distribution-proposed", { epoch: String(id), grossIncome: String(income), holderBudget: bundle.manifest.holderBudget, manifestHash: bundle.manifestHash, reviewDelaySeconds: String(policy[4]) });
}

try {
  do {
    try { await cycle(); } catch (error) { log("cycle-needs-attention", { reason: error instanceof Error ? error.message.slice(0, 250) : "unknown" }); if (!watch) process.exitCode = 1; }
    if (!watch || stopping) break;
    await delay(30000);
  } while (!stopping);
} finally { await unlink(lockPath).catch(() => undefined); }
