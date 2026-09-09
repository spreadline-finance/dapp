import {
  encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256,
  parseAbi, parseUnits, toHex, zeroAddress, type Address, type Hex, type PublicClient,
} from "viem";
import { CHAIN_ID, USDG } from "./market-types";
import type { LaunchDraft, PonsLaunchState } from "./rewards-types";

/** Current Pons V2 stack: official docs, cross-checked at Robinhood block 58536959. */
export const PONS = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  launchDeployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  graduationExecutor: "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046",
  graduationGuard: "0xf5695117b99B6f6401e67d4195BD653628176C6C",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
} as const satisfies Record<string, Address>;
export const PONS_RUNTIME_HASHES = {
  factory: "0x89a27da6f703e0a7cdd4f233e7cb57604ff75b164530962d3ff7cf8483a67d84",
  escrow: "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1",
  hook: "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db",
} as const;
export const PONS_DOCS_URL = "https://docs.ponsfamily.com/v2";
export const PONS_LAUNCH_URL = "https://www.ponsfamily.com/launchpad/create";
export const PONS_QUOTE_ASSETS = [
  { address: USDG, symbol: "USDG", decimals: 6 },
  { address: zeroAddress, symbol: "ETH", decimals: 18 },
] as const;

export const ponsFactoryAbi = parseAbi([
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address launcher) view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote,uint256 graduationThreshold,uint8 decimals)",
  "function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))",
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function getLaunchFeePolicy(address token) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))",
  "function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)",
  "function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)",
  "function transferCreatorFeeRecipient(address token,address newRecipient)",
  "function setBuybackEnabled(address token,bool enabled)",
  "function memeHook() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function locker() view returns (address)",
  "function buybackVault() view returns (address)",
  "function poolManager() view returns (address)",
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
]);
export const ponsEscrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient,address token) view returns (uint256)",
  "function claim()", "function claimToken(address token)",
]);
export const ponsHookAbi = parseAbi([
  "function currentFeePolicy() view returns (address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps)",
  "function factory() view returns (address)",
  "function poolManager() view returns (address)",
  "function feeSweepOperator() view returns (address)",
  "function pendingFees(bytes32 poolId,address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId,address currency) view returns (uint256)",
  "function sweepPoolFees(bytes32 poolId,uint256 minConversionQuoteOut,uint256 minBuybackTokensOut)",
]);
export const ponsCurveAbi = parseAbi([
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function sweepFees(uint256 minBuybackTokensOut)",
]);
export const ponsLaunchAndBuyAbi = parseAbi([
  "function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)",
]);
export const ponsHolderTokenAbi = parseAbi([
  "function balanceOf(address holder) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export function samePonsAddress(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
export function ponsAddress(value: string, label: string, allowZero = false): Address {
  if (!isAddress(value, { strict: false }) || (!allowZero && samePonsAddress(value, zeroAddress))) throw new Error(`${label} must be a valid nonzero address.`);
  return getAddress(value);
}
export function createPonsLaunchSalt(): Hex { return toHex(crypto.getRandomValues(new Uint8Array(32))); }

function metadataURL(value: string, label: string, required = false): string {
  const trimmed = value.trim();
  if (!trimmed && !required) return "";
  if (trimmed.length > 2048) throw new Error(`${label} is too long.`);
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error(`${label} must be an HTTPS or IPFS URL.`); }
  if (!["https:", "ipfs:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be an HTTPS or IPFS URL.`);
  return trimmed;
}

export type PonsLaunchInput = {
  draft: LaunchDraft; state: PonsLaunchState; launcher: Address; distributor: Address;
  salt: Hex; configId?: string; buybackEnabled?: boolean; now?: number;
};

/** Builds unsigned calldata only. Deploy and verify the recipient before signing this transaction. */
export function preparePonsLaunchCall(input: PonsLaunchInput) {
  const { draft, state } = input;
  const age = (input.now ?? Date.now()) - Date.parse(state.fetchedAt);
  if (state.status !== "ready" || !state.runtimeVerified || state.chainId !== CHAIN_ID || age < -10000 || age > 60000 || !Number.isFinite(age)) throw new Error("Refresh the verified Pons launch state before preparing a launch.");
  if (!samePonsAddress(state.factory, PONS.factory) || !samePonsAddress(state.escrow, PONS.escrow) || !samePonsAddress(state.hook, PONS.hook)) throw new Error("The Pons deployment does not match the verified stack.");
  const launcher = ponsAddress(input.launcher, "Launcher");
  const distributor = ponsAddress(input.distributor, "Fee recipient");
  if (!state.launcher || !samePonsAddress(state.launcher, launcher) || state.canLaunch !== true) throw new Error("Pons must confirm that the launching wallet is allowed to launch.");
  if (!/^0x[\da-f]{64}$/i.test(input.salt)) throw new Error("A persisted 32-byte launch salt is required.");
  const configId = input.configId ?? draft.launchConfigId;
  const config = state.configs.find((item) => item.id === configId && item.enabled);
  if (!config) throw new Error("Select an enabled Pons launch configuration.");
  const pairToken = ponsAddress(draft.rewardAsset, "Pairing asset", true);
  const quoteAsset = state.quoteAssets.find((asset) => samePonsAddress(asset.address, pairToken) && asset.approved === true);
  if (!quoteAsset) throw new Error("The selected reward asset is not an approved Pons pairing asset.");
  const quote = state.launchQuotes.find((item) => item.configId === configId && samePonsAddress(item.pairToken, pairToken));
  if (!quote || !/^0x[\da-f]{64}$/i.test(quote.expectedEconomics)) throw new Error("The selected launch needs a fresh pinned economics quote.");
  if (!Number.isInteger(draft.creatorTaxBps) || draft.creatorTaxBps < 0 || state.maxCreatorTaxBps === null || draft.creatorTaxBps > state.maxCreatorTaxBps) throw new Error("The creator tax exceeds the current Pons limit.");
  if (!state.launchFeeWei || !/^\d+$/.test(state.launchFeeWei)) throw new Error("The current Pons launch fee is unavailable.");
  const name = draft.name.trim(), symbol = draft.symbol.trim();
  if (!name || new TextEncoder().encode(name).length > 64 || !/^[A-Za-z0-9]{1,12}$/.test(symbol)) throw new Error("Provide a token name up to 64 bytes and an alphanumeric symbol up to 12 characters.");
  if (draft.description.length > 2000) throw new Error("The token description must be at most 2,000 characters.");
  const buybackEnabled = input.buybackEnabled ?? draft.buybackEnabled;
  if (typeof buybackEnabled !== "boolean") throw new Error("Choose whether Pons buybacks are enabled.");
  const params = {
    name, symbol, logo: metadataURL(draft.imageURI, "Token image", true), description: draft.description.trim(),
    socials: { twitter: metadataURL(draft.twitter, "X link"), telegram: metadataURL(draft.telegram, "Telegram link"), discord: "", website: metadataURL(draft.website, "Website"), farcaster: "" },
    creatorFeeRecipient: distributor, creatorTaxBps: draft.creatorTaxBps, buybackEnabled,
    expectedEconomics: quote.expectedEconomics, salt: input.salt,
  };
  return {
    chainId: CHAIN_ID, from: launcher, to: PONS.factory, valueWei: state.launchFeeWei,
    data: encodeFunctionData({ abi: ponsFactoryAbi, functionName: "launchToken", args: [params, BigInt(configId), pairToken] }),
    params, configId, pairToken, quotedAtBlock: state.blockNumber,
    totalTradeFeeBps: config.curveFeeBps + draft.creatorTaxBps,
  };
}

/** An opening purchase needs a separately reviewed minimum output; it is never implied by launch. */
export function preparePonsLaunchAndBuyCall(input: PonsLaunchInput & { minTokensOut: bigint; recipient: Address }) {
  const launch = preparePonsLaunchCall(input);
  const asset = PONS_QUOTE_ASSETS.find((item) => samePonsAddress(item.address, launch.pairToken));
  if (!asset || !/^\d+(?:\.\d+)?$/.test(input.draft.developerBuy) || (input.draft.developerBuy.split(".")[1]?.length ?? 0) > asset.decimals) throw new Error("Provide a valid opening-buy amount in the pairing asset.");
  const quoteIn = parseUnits(input.draft.developerBuy, asset.decimals);
  if (quoteIn <= BigInt(0) || input.minTokensOut <= BigInt(0)) throw new Error("An opening purchase requires a positive spend and minimum token output.");
  const recipient = ponsAddress(input.recipient, "Opening-buy recipient");
  return {
    ...launch, to: PONS.launchAndBuy,
    valueWei: (BigInt(launch.valueWei) + (samePonsAddress(launch.pairToken, zeroAddress) ? quoteIn : BigInt(0))).toString(),
    data: encodeFunctionData({ abi: ponsLaunchAndBuyAbi, functionName: "launchAndBuy", args: [launch.params, BigInt(launch.configId), launch.pairToken, quoteIn, input.minTokensOut, recipient, []] }),
    approval: samePonsAddress(launch.pairToken, zeroAddress) ? null : { token: launch.pairToken, spender: PONS.launchAndBuy, amount: quoteIn.toString() },
  };
}

export function ponsPoolId(token: Address, pairToken: Address, poolFee: number, tickSpacing: number): Hex {
  const [currency0, currency1] = BigInt(token) < BigInt(pairToken) ? [token, pairToken] : [pairToken, token];
  return keccak256(encodeAbiParameters([{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }], [{ currency0, currency1, fee: poolFee, tickSpacing, hooks: PONS.hook }]));
}

export type PonsReader = Pick<PublicClient, "readContract" | "getCode" | "getChainId">;
export async function verifyPonsRuntime(client: PonsReader, blockNumber: bigint): Promise<void> {
  if (await client.getChainId() !== CHAIN_ID) throw new Error("Pons requires Robinhood Chain 4663.");
  const entries = ["factory", "escrow", "hook"] as const;
  const codes = await Promise.all(entries.map((name) => client.getCode({ address: PONS[name], blockNumber })));
  for (const [index, name] of entries.entries()) if (!codes[index] || codes[index] === "0x" || keccak256(codes[index]) !== PONS_RUNTIME_HASHES[name]) throw new Error(`The ${name} runtime differs from the verified Pons deployment.`);
}

/** Resolve launch inventory before constructing a holder snapshot; never distribute to locked liquidity. */
export async function discoverPonsLaunchInfrastructure(client: PonsReader, token: Address, blockNumber: bigint) {
  await verifyPonsRuntime(client, blockNumber);
  const [launch, locker, buybackVault, poolManager, escrow, hook] = await Promise.all([
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token], blockNumber }),
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "locker", blockNumber }),
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "buybackVault", blockNumber }),
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "poolManager", blockNumber }),
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "feeEscrow", blockNumber }),
    client.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "memeHook", blockNumber }),
  ]);
  if (!launch.exists || !samePonsAddress(launch.token, token) || samePonsAddress(launch.curve, zeroAddress)) throw new Error("The holder token is not a launch in the verified Pons factory.");
  if (![samePonsAddress(locker, PONS.locker), samePonsAddress(buybackVault, PONS.buybackVault), samePonsAddress(poolManager, PONS.poolManager), samePonsAddress(escrow, PONS.escrow), samePonsAddress(hook, PONS.hook)].every(Boolean)) throw new Error("Pons infrastructure has changed; review the holder exclusion list.");
  const addresses = [zeroAddress, "0x000000000000000000000000000000000000dEaD" as Address, token, launch.curve, ...Object.values(PONS)];
  const mandatoryExclusions = [...new Map(addresses.map((address) => [address.toLowerCase(), getAddress(address)])).values()];
  return { launch, mandatoryExclusions, poolId: ponsPoolId(token, launch.pairToken, launch.poolFee, launch.tickSpacing) };
}
