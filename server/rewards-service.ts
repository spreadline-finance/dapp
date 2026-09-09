import { createPublicClient, erc20Abi, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { CHAIN_ID } from "../src/lib/market-types";
import { feeDistributorAbi } from "../src/lib/fee-distributor-contract";
import type { RewardEpoch, RewardReceipt, RewardsSnapshot } from "../src/lib/rewards-types";
import { canonicalJSON, rewardContentHash, validateRewardManifest, validateRewardPage, type RewardManifest } from "../src/lib/reward-merkle";
import { requestTransport } from "./rpc";

export type RewardsConfig = { REWARDS_DISTRIBUTOR_ADDRESS: string; REWARDS_DISTRIBUTOR_CODE_HASH: string; REWARDS_DEPLOY_BLOCK: string };
const PONS_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as Address;
const escrowAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function balanceOfToken(address,address) view returns (uint256)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const key = (address: Address, epoch: string, hash?: Hex) => `rewards/${CHAIN_ID}/${address.toLowerCase()}/${epoch}/${hash || "manifest"}.json`;

export async function verifiedRewards(rpcUrl: string, config: RewardsConfig) {
  if (!isAddress(config.REWARDS_DISTRIBUTOR_ADDRESS, { strict: false }) || same(config.REWARDS_DISTRIBUTOR_ADDRESS, zeroAddress) || !/^0x[\da-f]{64}$/i.test(config.REWARDS_DISTRIBUTOR_CODE_HASH) || !/^\d{1,16}$/.test(config.REWARDS_DEPLOY_BLOCK)) throw new Error("The reward distributor deployment is not configured and verified.");
  const address = getAddress(config.REWARDS_DISTRIBUTOR_ADDRESS);
  const client = createPublicClient({ transport: requestTransport(rpcUrl) });
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  const age = Date.now() - Number(block.timestamp) * 1000;
  if (chainId !== CHAIN_ID || age > 120000 || age < -10000 || BigInt(config.REWARDS_DEPLOY_BLOCK) > block.number) throw new Error("A current Robinhood Chain block is required.");
  const code = await client.getCode({ address, blockNumber: block.number });
  if (!code || code === "0x" || !same(keccak256(code), config.REWARDS_DISTRIBUTOR_CODE_HASH)) throw new Error("Reward distributor code does not match the verified deployment.");
  const escrow = await client.readContract({ address, abi: feeDistributorAbi, functionName: "ponsEscrow", blockNumber: block.number });
  if (!same(escrow, PONS_ESCROW)) throw new Error("The distributor does not use the verified Pons fee escrow.");
  return { client, address, block };
}

type VerifiedRewards = Awaited<ReturnType<typeof verifiedRewards>>;
export function serializeRewardEpoch(id: bigint, epoch: Awaited<ReturnType<typeof readEpoch>>): RewardEpoch {
  if (epoch.state < 1 || epoch.state > 3) throw new Error("Distribution does not exist.");
  return { id: String(id), root: epoch.root, manifestHash: epoch.manifestHash, snapshotBlockHash: epoch.snapshotBlockHash,
    snapshotBlock: String(epoch.snapshotBlock), totalEligibleWeight: String(epoch.totalEligibleWeight), grossIncome: String(epoch.grossIncome),
    holderBudget: String(epoch.holderBudget), holderPaid: String(epoch.holderPaid), devBudget: String(epoch.devBudget), treasuryBudget: String(epoch.treasuryBudget),
    devWallet: epoch.devWallet, treasuryWallet: epoch.treasuryWallet, policyVersion: String(epoch.policyVersion), proposedAt: Number(epoch.proposedAt), readyAt: Number(epoch.readyAt), activatedAt: Number(epoch.activatedAt), state: (["proposed", "active", "cancelled"] as const)[epoch.state - 1] };
}
function readEpoch(context: VerifiedRewards, id: bigint) { return context.client.readContract({ address: context.address, abi: feeDistributorAbi, functionName: "epochs", args: [id], blockNumber: context.block.number }); }

export function assertManifestMatchesEpoch(manifest: RewardManifest, epoch: RewardEpoch, distributor: Address, holderToken: Address) {
  if (!same(manifest.distributor, distributor) || !same(manifest.holderToken, holderToken) || manifest.epochId !== epoch.id || rewardContentHash(manifest) !== epoch.manifestHash || manifest.root !== epoch.root || manifest.snapshotBlock !== epoch.snapshotBlock || manifest.snapshotBlockHash !== epoch.snapshotBlockHash || manifest.totalEligibleWeight !== epoch.totalEligibleWeight || manifest.grossIncome !== epoch.grossIncome || manifest.holderBudget !== epoch.holderBudget || manifest.policyVersion !== epoch.policyVersion || epoch.state === "cancelled") throw new Error("Manifest differs from the onchain distribution.");
}

async function storedManifest(bucket: R2Bucket, distributor: Address, epoch: RewardEpoch, token: Address) {
  const object = await bucket.get(key(distributor, epoch.id));
  if (!object) throw new Error("The operator has not published this distribution's proof manifest yet.");
  const manifest = validateRewardManifest(await object.json());
  assertManifestMatchesEpoch(manifest, epoch, distributor, token);
  return manifest;
}

export function createRewardsService(rpcUrl: string, config: RewardsConfig, bucket?: R2Bucket) {
  async function snapshot(account?: Address, before?: bigint): Promise<RewardsSnapshot> {
    const base: RewardsSnapshot = { status: "unconfigured", message: "The token fee distributor has not been deployed and connected. No holder income is recorded yet.", chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), blockNumber: null, blockTimestamp: null, distributor: null, wallet: null, epochs: [], events: [], eventsError: null, manifestsAvailable: Boolean(bucket), nextEpochCursor: null };
    if (!config.REWARDS_DISTRIBUTOR_ADDRESS) return base;
    try {
      const context = await verifiedRewards(rpcUrl, config);
      const { client, address, block } = context;
      const common = { address, abi: feeDistributorAbi, blockNumber: block.number } as const;
      const [owner, pendingOwner, operator, guardian, paused, holderToken, rewardAsset, policy, policyVersion, totalPonsCollected, availableIncome, totalReserved, totalHolderAllocated, totalHolderPaid, totalDevAllocated, totalDevPaid, totalTreasuryAllocated, totalTreasuryPaid, nextEpochId, lastProposedAt] = await Promise.all([
        client.readContract({ ...common, functionName: "owner" }), client.readContract({ ...common, functionName: "pendingOwner" }),
        client.readContract({ ...common, functionName: "operator" }), client.readContract({ ...common, functionName: "guardian" }),
        client.readContract({ ...common, functionName: "paused" }), client.readContract({ ...common, functionName: "holderToken" }),
        client.readContract({ ...common, functionName: "rewardAsset" }), client.readContract({ ...common, functionName: "policy" }),
        client.readContract({ ...common, functionName: "policyVersion" }), client.readContract({ ...common, functionName: "totalPonsCollected" }),
        client.readContract({ ...common, functionName: "availableIncome" }), client.readContract({ ...common, functionName: "totalReserved" }),
        client.readContract({ ...common, functionName: "totalHolderAllocated" }), client.readContract({ ...common, functionName: "totalHolderPaid" }),
        client.readContract({ ...common, functionName: "totalDevAllocated" }), client.readContract({ ...common, functionName: "totalDevPaid" }),
        client.readContract({ ...common, functionName: "totalTreasuryAllocated" }), client.readContract({ ...common, functionName: "totalTreasuryPaid" }),
        client.readContract({ ...common, functionName: "nextEpochId" }), client.readContract({ ...common, functionName: "lastProposedAt" }),
      ]);
      async function metadata(token: Address, native: boolean) {
        if (same(token, zeroAddress)) return { symbol: native ? "ETH" : "Unbound token", decimals: 18 };
        const [symbol, decimals] = await Promise.all([client.readContract({ address: token, abi: erc20Abi, functionName: "symbol", blockNumber: block.number }), client.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block.number })]);
        if (decimals > 18 || symbol.length > 40) throw new Error("Unsupported reward or holder token metadata.");
        return { symbol, decimals };
      }
      const [holder, reward, credit] = await Promise.all([metadata(holderToken, false), metadata(rewardAsset, true), same(rewardAsset, zeroAddress)
        ? client.readContract({ address: PONS_ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [address], blockNumber: block.number })
        : client.readContract({ address: PONS_ESCROW, abi: escrowAbi, functionName: "balanceOfToken", args: [address, rewardAsset], blockNumber: block.number })]);
      const result: RewardsSnapshot = { ...base, status: "ready", message: paused ? "New distributions are paused. Previously activated rewards remain payable." : "Collected fees, allocations and completed payments are read from the verified distributor.", blockNumber: String(block.number), blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
        distributor: { address, owner, pendingOwner, operator, guardian, paused, holderToken, holderTokenSymbol: holder.symbol, holderTokenDecimals: holder.decimals, rewardAsset, rewardSymbol: reward.symbol, rewardDecimals: reward.decimals, ponsEscrow: PONS_ESCROW,
          totalPonsCollected: String(totalPonsCollected), availableIncome: String(availableIncome), totalReserved: String(totalReserved), totalHolderAllocated: String(totalHolderAllocated), totalHolderPaid: String(totalHolderPaid), totalDevAllocated: String(totalDevAllocated), totalDevPaid: String(totalDevPaid), totalTreasuryAllocated: String(totalTreasuryAllocated), totalTreasuryPaid: String(totalTreasuryPaid), nextEpochId: String(nextEpochId), lastProposedAt: Number(lastProposedAt), policyVersion: String(policyVersion), escrowCredit: String(credit),
          policy: { holderBps: policy[0], devBps: policy[1], treasuryBps: policy[2], intervalSeconds: Number(policy[3]), rootDelaySeconds: Number(policy[4]), minimumIncome: String(policy[5]), devWallet: policy[6], treasuryWallet: policy[7] } },
      };
      const end = before && before < nextEpochId ? before : nextEpochId;
      const start = end > 20n ? end - 20n : 1n;
      const ids: bigint[] = [];
      for (let id = end - 1n; id >= start; id--) ids.push(id);
      result.epochs = await Promise.all(ids.map(async id => serializeRewardEpoch(id, await readEpoch(context, id))));
      result.nextEpochCursor = start > 1n ? String(start) : null;
      if (account) {
        const [holderBalance, pendingDev, pendingTreasury] = await Promise.all([
          same(holderToken, zeroAddress) ? Promise.resolve(0n) : client.readContract({ address: holderToken, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: block.number }),
          client.readContract({ ...common, functionName: "pendingDev", args: [account] }), client.readContract({ ...common, functionName: "pendingTreasury", args: [account] }),
        ]);
        result.wallet = { address: account, holderBalance: String(holderBalance), pendingDev: String(pendingDev), pendingTreasury: String(pendingTreasury), claims: [], proofsStatus: "empty", proofsMessage: "No activated distributions on this page." };
        const active = result.epochs.filter(epoch => epoch.state === "active");
        const wallet = result.wallet;
        if (active.length) {
          const proofs = await Promise.allSettled(active.map(async epoch => {
            if (!bucket) throw new Error("Public proof storage is not configured.");
            const manifest = await storedManifest(bucket, address, epoch, holderToken);
            const lower = account.toLowerCase();
            const page = manifest.pages.find(item => lower >= item.first && lower <= item.last);
            if (!page) return null;
            const object = await bucket.get(key(address, epoch.id, page.hash));
            if (!object) throw new Error("Proof page is awaiting publication.");
            const entry = validateRewardPage(await object.json(), manifest, page.hash).entries.find(item => same(item.account, account));
            if (!entry) return null;
            const claimed = await client.readContract({ ...common, functionName: "hasClaimed", args: [BigInt(epoch.id), account] });
            return { epochId: epoch.id, ...entry, amount: String(BigInt(epoch.holderBudget) * BigInt(entry.weight) / BigInt(epoch.totalEligibleWeight)), claimed };
          }));
          wallet.claims = proofs.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
          const failed = proofs.filter(result => result.status === "rejected").length;
          wallet.proofsStatus = failed ? "unavailable" : "ready";
          wallet.proofsMessage = failed ? `${failed} distribution proof manifest(s) are unavailable. Any valid proofs below remain usable; unavailable proofs do not mean zero entitlement.` : "Proofs verified against each distribution's onchain root. Older distributions are available on previous pages.";
        }
      }
      try {
        const from = block.number > 4999n ? block.number - 4999n : 0n;
        const floor = BigInt(config.REWARDS_DEPLOY_BLOCK) > from ? BigInt(config.REWARDS_DEPLOY_BLOCK) : from;
        const ranges = [];
        for (let start = floor; start <= block.number; start += 1000n) ranges.push({ fromBlock: start, toBlock: start + 999n < block.number ? start + 999n : block.number });
        const batches = await Promise.all(ranges.map(range => client.getContractEvents({ address, abi: feeDistributorAbi, ...range, strict: true })));
        result.events = batches.flat().filter(log => !log.removed).sort((a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1).flatMap((log): RewardReceipt[] => {
          const base = { id: `${log.transactionHash}:${log.logIndex}`, transactionHash: log.transactionHash, blockNumber: String(log.blockNumber), account: null, amount: null, epochId: null };
          if (log.eventName === "PonsFeesCollected") return [{ ...base, kind: "collected", amount: String(log.args.amount) }];
          if (log.eventName === "EpochProposed" || log.eventName === "EpochActivated" || log.eventName === "EpochCancelled") return [{ ...base, kind: log.eventName === "EpochProposed" ? "proposed" : log.eventName === "EpochActivated" ? "activated" : "cancelled", epochId: String(log.args.epochId) }];
          if (log.eventName === "HolderPaid") return [{ ...base, kind: "holder-paid", account: log.args.account, amount: String(log.args.amount), epochId: String(log.args.epochId) }];
          if (log.eventName === "CashPaid") return [ { ...base, id: base.id + ":dev", kind: "dev-paid", account: log.args.account, amount: String(log.args.devAmount) }, { ...base, id: base.id + ":treasury", kind: "treasury-paid", account: log.args.account, amount: String(log.args.treasuryAmount) } ].filter(event => event.amount !== "0") as RewardReceipt[];
          if (log.eventName === "PolicyUpdated") return [{ ...base, kind: "policy" }];
          return [];
        }).slice(0, 80);
      } catch { result.eventsError = "Recent receipt history is unavailable. Lifetime paid totals still come from the contract."; }
      return result;
    } catch (error) {
      console.error(JSON.stringify({ event: "rewards_snapshot_failed", reason: error instanceof Error ? error.name : "unknown" }));
      return { ...base, status: "unavailable", message: "The distributor could not be verified against a current chain block. Refresh before preparing a transaction." };
    }
  }

  async function manifest(epochId: bigint, pageHash?: Hex, value?: unknown) {
    if (!bucket) throw new Error("Public proof storage is not configured.");
    const context = await verifiedRewards(rpcUrl, config);
    const epoch = serializeRewardEpoch(epochId, await readEpoch(context, epochId));
    const token = await context.client.readContract({ address: context.address, abi: feeDistributorAbi, functionName: "holderToken", blockNumber: context.block.number });
    if (value !== undefined && !pageHash) {
      const document = validateRewardManifest(value);
      assertManifestMatchesEpoch(document, epoch, context.address, token);
      await bucket.put(key(context.address, String(epochId)), canonicalJSON(document), { httpMetadata: { contentType: "application/json" } });
      return { stored: true, hash: rewardContentHash(document) };
    }
    const document = await storedManifest(bucket, context.address, epoch, token);
    if (!pageHash) return document;
    if (!document.pages.some(page => page.hash === pageHash)) throw new Error("Page is not part of the committed manifest.");
    if (value !== undefined) {
      const page = validateRewardPage(value, document, pageHash);
      await bucket.put(key(context.address, String(epochId), pageHash), canonicalJSON(page), { httpMetadata: { contentType: "application/json" } });
      return { stored: true, hash: pageHash };
    }
    const object = await bucket.get(key(context.address, String(epochId), pageHash));
    if (!object) throw new Error("Proof page is awaiting publication.");
    return validateRewardPage(await object.json(), document, pageHash);
  }
  return { snapshot, manifest };
}
