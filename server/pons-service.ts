import { createPublicClient, type Address } from "viem";
import { CHAIN_ID, USDG } from "../src/lib/market-types";
import type { PonsLaunchState } from "../src/lib/rewards-types";
import { PONS, PONS_DOCS_URL, PONS_LAUNCH_URL, PONS_QUOTE_ASSETS, ponsFactoryAbi, ponsHookAbi, samePonsAddress, verifyPonsRuntime } from "../src/lib/pons";
import { requestTransport } from "./rpc";

/** Bounded reads pinned to one recent chain block. No user-specific launch gate is inferred. */
export async function getPonsLaunchState(rpcUrl: string, launcher?: Address): Promise<PonsLaunchState> {
  const base: PonsLaunchState = {
    status: "unavailable", message: "Current Pons launch terms could not be verified. Refresh before preparing a launch.",
    fetchedAt: new Date().toISOString(), blockNumber: null, blockTimestamp: null, blockHash: null,
    chainId: CHAIN_ID, factory: PONS.factory, escrow: PONS.escrow, hook: PONS.hook,
    launchEnabled: null, canLaunch: null, maxCreatorTaxBps: null, launchFeeWei: null,
    officialLaunchUrl: PONS_LAUNCH_URL, docsUrl: PONS_DOCS_URL, launcher: launcher ?? null,
    runtimeVerified: false, configs: [], feePolicy: null, launchQuotes: [],
    quoteAssets: PONS_QUOTE_ASSETS.map((asset) => ({ ...asset, approved: null, phantomQuoteRaw: null, graduationThresholdRaw: null })),
  };
  const client = createPublicClient({ transport: requestTransport(rpcUrl) });
  try {
    const block = await client.getBlock({ blockTag: "latest" });
    const age = Date.now() - Number(block.timestamp) * 1000;
    if (age > 120000 || age < -10000) throw new Error("stale_block");
    await verifyPonsRuntime(client, block.number);
    const at = { blockNumber: block.number };
    const [launchEnabled, canLaunch, launchFee, maxTax, count, usdgApproved, usdgEconomics, currentPolicy, escrow, hook] = await Promise.all([
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "launchEnabled", ...at }),
      launcher ? client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "canLaunch", args: [launcher], ...at }) : Promise.resolve(null),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "launchFee", ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "maxCreatorTaxBps", ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "launchConfigCount", ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "approvedPairTokens", args: [USDG], ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "pairTokenEconomics", args: [USDG], ...at }),
      client.readContract({ address: PONS.hook, abi: ponsHookAbi, functionName: "currentFeePolicy", ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "feeEscrow", ...at }),
      client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "memeHook", ...at }),
    ]);
    if (count > 32n || maxTax > 10000n || !samePonsAddress(escrow, PONS.escrow) || !samePonsAddress(hook, PONS.hook)) throw new Error("unsupported_launch_configuration");
    if (usdgApproved && usdgEconomics[2] !== 6) throw new Error("usdg_decimals_mismatch");
    if ([currentPolicy[1], currentPolicy[2], currentPolicy[3], currentPolicy[4]].some((bps) => bps > 10000)) throw new Error("invalid_fee_policy");
    const configs = await Promise.all(Array.from({ length: Number(count) }, async (_, id) => {
      const config = await client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchConfig", args: [BigInt(id)], ...at });
      if (config.curveFeeBps > 10000n) throw new Error("invalid_curve_fee");
      return { id: String(id), supplyRaw: String(config.supply), curveFeeBps: Number(config.curveFeeBps), phantomQuoteRaw: String(config.phantomQuote), graduationThresholdRaw: String(config.graduationThreshold), poolFee: config.poolFee, tickSpacing: config.tickSpacing, enabled: config.enabled };
    }));
    const quoteAssets = PONS_QUOTE_ASSETS.map((asset) => ({
      ...asset, approved: asset.symbol === "ETH" || usdgApproved,
      phantomQuoteRaw: asset.symbol === "USDG" && usdgApproved ? String(usdgEconomics[0]) : null,
      graduationThresholdRaw: asset.symbol === "USDG" && usdgApproved ? String(usdgEconomics[1]) : null,
    }));
    const launchQuotes = await Promise.all(configs.filter((config) => config.enabled).flatMap((config) => quoteAssets.filter((asset) => asset.approved).map(async (asset) => ({
      configId: config.id, pairToken: asset.address,
      expectedEconomics: await client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "previewLaunchEconomics", args: [BigInt(config.id), asset.address], ...at }),
    }))));
    return {
      ...base, status: "ready", message: "Pons launch terms were read from the verified contracts. Creator tax and pairing asset become fixed when the token is launched.",
      fetchedAt: new Date().toISOString(), blockNumber: String(block.number), blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), blockHash: block.hash,
      launchEnabled, canLaunch, launchFeeWei: String(launchFee), maxCreatorTaxBps: Number(maxTax), runtimeVerified: true,
      configs, quoteAssets, launchQuotes,
      feePolicy: { protocolFeeRecipient: currentPolicy[0], protocolFeeShareBps: currentPolicy[1], buybackBurnBps: currentPolicy[2], hookFeeBps: currentPolicy[3], maxInternalPriceImpactBps: currentPolicy[4] },
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "pons_launch_state_unavailable", errorType: error instanceof Error ? error.name : "Unknown" }));
    return base;
  }
}
