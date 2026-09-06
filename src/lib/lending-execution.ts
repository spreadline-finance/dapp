import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseUnits, zeroHash, type Address, type Hex } from "viem";
import { CHAIN_ID } from "./market-types";

export const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010" as const;
export const BUNDLER = "0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6" as const;
export const LENDING_ADAPTER = "0xc5E188541D107e8B79e43478bDE365F1406665D6" as const;
export const VAULT_V2_FACTORY = "0x0FBad98595b0186dA120E41f77C102beb49f803c" as const;
export const WAD = BigInt(10) ** BigInt(18), RAY = BigInt(10) ** BigInt(27);
export const LENDING_PREVIEW_MS = 30000;
export const lendingTokenAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function symbol() view returns(string)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
]);
export const vaultAbi = parseAbi([
  "function asset() view returns(address)", "function previewDeposit(uint256) view returns(uint256)",
  "function previewWithdraw(uint256) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function liquidityAdapter() view returns(address)", "function liquidityData() view returns(bytes)",
]);
export const vaultFactoryAbi = parseAbi(["function isVaultV2(address) view returns(bool)"]);
export const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32) view returns(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function feeRecipient() view returns(address)", "function isAuthorized(address,address) view returns(bool)",
  "function setAuthorization(address authorized,bool newIsAuthorized)",
]);
export const irmAbi = parseAbi(["function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns(uint256)"]);
export const bundlerAbi = parseAbi(["function multicall((address to,bytes data,uint256 value,bool skipRevert,bytes32 callbackHash)[] bundle) payable"]);
export const lendingAdapterAbi = parseAbi([
  "function BUNDLER3() view returns(address)", "function MORPHO() view returns(address)",
  "function erc20TransferFrom(address token,address receiver,uint256 amount)",
  "function erc4626Deposit(address vault,uint256 assets,uint256 maxSharePriceE27,address receiver)",
  "function erc4626Withdraw(address vault,uint256 assets,uint256 minSharePriceE27,address receiver,address owner)",
  "function erc4626Redeem(address vault,uint256 shares,uint256 minSharePriceE27,address receiver,address owner)",
  "function morphoSupply((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),uint256 assets,uint256 shares,uint256 maxSharePriceE27,address onBehalf,bytes data)",
  "function morphoWithdraw((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),uint256 assets,uint256 shares,uint256 minSharePriceE27,address receiver)",
]);
export type LendingKind = "market" | "vault";
export type LendingOperation = "deposit" | "withdraw";
export type MarketParams = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: string };
export type BlueState = { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };
export type LendingIntent = { kind: LendingKind; id: string; operation: LendingOperation; amount: string; all: boolean; slippageBps: number };
export type LendingPosition = {
  kind: LendingKind; id: string; account: Address; chainId: typeof CHAIN_ID;
  asset: { address: Address; symbol: string; decimals: number }; shareDecimals: number;
  sharesRaw: string; assetsRaw: string; walletBalanceRaw: string; nativeBalanceRaw: string;
  assetAllowanceRaw: string; shareAllowanceRaw: string; authorized: boolean;
  liquidityRaw: string | null; params?: MarketParams; blockNumber: string; blockTimestamp: string; fetchedAt: string;
};
export type LendingBounds = { assetsRaw: string; sharesRaw: string; priceLimitRaw: string; minimumSharesRaw: string; minimumAssetsRaw: string; maximumSharesRaw: string };
export type LendingPlan = {
  intent: LendingIntent; position: LendingPosition; bounds: LendingBounds;
  status: "ready" | "approval_required" | "authorization_required" | "approval_reset_required" | "blocked";
  reason: string; approvalToken?: Address; approvalAmountRaw?: string;
  transaction?: { from: Address; to: Address; data: Hex; value: "0x0"; gas: Hex };
  gasEstimateETH?: string; expiresAt: string;
};
export class LendingPreparationError extends Error { constructor(message: string) { super(message); this.name = "LendingPreparationError"; } }
export const sameContract = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function validLendingId(kind: LendingKind, id: string) { return (kind === "market" || kind === "vault") && !/^0x0+$/i.test(id) && (kind === "market" ? /^0x[\da-f]{64}$/i : /^0x[\da-f]{40}$/i).test(id); }
export function parseLendingAmount(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^\d{1,8}(\.\d{1,18})?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) throw new LendingPreparationError("Enter a token amount without rounding, using at most 18 supported decimals.");
  const amount = parseUnits(value, decimals);
  if (amount <= BigInt(0) || amount > BigInt(10000000) * BigInt(10) ** BigInt(decimals)) throw new LendingPreparationError("Enter an amount above zero and up to 10 million tokens.");
  return amount;
}
export function ceilDiv(a: bigint, b: bigint) { if (a < BigInt(0) || b <= BigInt(0)) throw new LendingPreparationError("Invalid share conversion."); return (a + b - BigInt(1)) / b; }
export function marketParamsTuple(params: MarketParams) { return { ...params, lltv: BigInt(params.lltv) }; }
export function marketIdentity(params: MarketParams) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [params.loanToken, params.collateralToken, params.oracle, params.irm, BigInt(params.lltv)]));
}
// Exact integer accrual and virtual-share math from MorphoBalancesLib / SharesMathLib.
export function accrueBlue(state: BlueState, rate: bigint, timestamp: bigint) {
  const elapsed = timestamp - state.lastUpdate;
  if (elapsed < BigInt(0) || state.fee > WAD || rate < BigInt(0)) throw new LendingPreparationError("Invalid Morpho market state.");
  const first = rate * elapsed, second = first * first / (BigInt(2) * WAD), third = second * first / (BigInt(3) * WAD);
  const interest = state.totalBorrowAssets * (first + second + third) / WAD;
  const totalSupplyAssets = state.totalSupplyAssets + interest, totalBorrowAssets = state.totalBorrowAssets + interest;
  const feeAssets = interest * state.fee / WAD;
  const feeShares = feeAssets * (state.totalSupplyShares + BigInt(1000000)) / (totalSupplyAssets - feeAssets + BigInt(1));
  const totalSupplyShares = state.totalSupplyShares + feeShares;
  if ([totalSupplyAssets, totalBorrowAssets, totalSupplyShares].some((v) => v < BigInt(0) || v > (BigInt(1) << BigInt(128)) - BigInt(1)) || totalBorrowAssets > totalSupplyAssets) throw new LendingPreparationError("Unsupported Morpho accounting state.");
  return { ...state, totalSupplyAssets, totalBorrowAssets, totalSupplyShares, lastUpdate: timestamp, feeShares };
}
export const blueAssets = (shares: bigint, state: BlueState) => shares * (state.totalSupplyAssets + BigInt(1)) / (state.totalSupplyShares + BigInt(1000000));
export const blueShares = (assets: bigint, state: BlueState, roundUp = false) => roundUp ? ceilDiv(assets * (state.totalSupplyShares + BigInt(1000000)), state.totalSupplyAssets + BigInt(1)) : assets * (state.totalSupplyShares + BigInt(1000000)) / (state.totalSupplyAssets + BigInt(1));
export function lendingBounds(operation: LendingOperation, all: boolean, assets: bigint, shares: bigint, walletShares: bigint, bps: number): LendingBounds {
  if (assets <= BigInt(0) || shares <= BigInt(0) || !Number.isInteger(bps) || bps < 1 || bps > 100 || (operation === "deposit" && all)) throw new LendingPreparationError("This amount cannot produce a protected lending transaction.");
  let price: bigint, minimumShares = BigInt(0), minimumAssets = BigInt(0), maximumShares = BigInt(0);
  if (operation === "deposit") {
    price = ceilDiv(assets * RAY * BigInt(10000 + bps), shares * BigInt(10000));
    minimumShares = ceilDiv(assets * RAY, price);
  } else if (all) {
    if (shares > walletShares) throw new LendingPreparationError("The share balance changed. Refresh your position.");
    price = assets * RAY * BigInt(10000 - bps) / (shares * BigInt(10000));
    minimumAssets = ceilDiv(shares * price, RAY); maximumShares = shares;
  } else {
    const desired = ceilDiv(shares * BigInt(10000 + bps), BigInt(10000));
    const cap = desired < walletShares ? desired : walletShares;
    price = ceilDiv(assets * RAY, cap);
    maximumShares = assets * RAY / price; minimumAssets = assets;
    if (maximumShares < shares) throw new LendingPreparationError("The withdrawal is too small to protect at this precision. Try another amount or withdraw all.");
  }
  if (price <= BigInt(0) || (operation === "deposit" ? minimumShares <= BigInt(0) : minimumAssets <= BigInt(0))) throw new LendingPreparationError("The protected receive amount is too small.");
  return { assetsRaw: String(assets), sharesRaw: String(shares), priceLimitRaw: String(price), minimumSharesRaw: String(minimumShares), minimumAssetsRaw: String(minimumAssets), maximumSharesRaw: String(maximumShares) };
}
export function lendingCall(intent: LendingIntent, position: LendingPosition, bounds: LendingBounds): Hex {
  const assets = BigInt(bounds.assetsRaw), shares = BigInt(bounds.sharesRaw), price = BigInt(bounds.priceLimitRaw), account = position.account;
  const calls: Hex[] = [];
  if (intent.operation === "deposit") calls.push(encodeFunctionData({ abi: lendingAdapterAbi, functionName: "erc20TransferFrom", args: [position.asset.address, LENDING_ADAPTER, assets] }));
  if (intent.kind === "vault") {
    const vault = intent.id as Address;
    calls.push(intent.operation === "deposit" ? encodeFunctionData({ abi: lendingAdapterAbi, functionName: "erc4626Deposit", args: [vault, assets, price, account] }) : intent.all ? encodeFunctionData({ abi: lendingAdapterAbi, functionName: "erc4626Redeem", args: [vault, shares, price, account, account] }) : encodeFunctionData({ abi: lendingAdapterAbi, functionName: "erc4626Withdraw", args: [vault, assets, price, account, account] }));
  } else {
    if (!position.params || !sameContract(marketIdentity(position.params), intent.id)) throw new LendingPreparationError("The market parameters do not match.");
    const params = marketParamsTuple(position.params);
    calls.push(intent.operation === "deposit" ? encodeFunctionData({ abi: lendingAdapterAbi, functionName: "morphoSupply", args: [params, assets, BigInt(0), price, account, "0x"] }) : encodeFunctionData({ abi: lendingAdapterAbi, functionName: "morphoWithdraw", args: [params, intent.all ? BigInt(0) : assets, intent.all ? shares : BigInt(0), price, account] }));
  }
  return encodeFunctionData({ abi: bundlerAbi, functionName: "multicall", args: [calls.map((data) => ({ to: LENDING_ADAPTER, data, value: BigInt(0), skipRevert: false, callbackHash: zeroHash }))] });
}
export function lendingApproval(position: LendingPosition, intent: LendingIntent, bounds: LendingBounds) {
  return intent.operation === "deposit" ? { token: position.asset.address, amount: BigInt(bounds.assetsRaw), allowance: BigInt(position.assetAllowanceRaw) } : { token: intent.id as Address, amount: BigInt(bounds.maximumSharesRaw), allowance: BigInt(position.shareAllowanceRaw) };
}
export type ExpectedLending = LendingIntent & { account: string; asset: string; assetDecimals: number };
export function lendingPlanMatches(plan: LendingPlan, expected: ExpectedLending, now = Date.now()) {
  try {
    const p = plan.position, i = plan.intent, b = plan.bounds, tx = plan.transaction;
    if (!tx || !validLendingId(i.kind, i.id) || i.kind !== expected.kind || !sameContract(i.id, expected.id) || i.operation !== expected.operation || i.all !== expected.all || i.slippageBps !== expected.slippageBps || p.kind !== i.kind || !sameContract(p.id, i.id) || p.chainId !== CHAIN_ID || !sameContract(p.account, expected.account) || !sameContract(p.asset.address, expected.asset) || p.asset.decimals !== expected.assetDecimals) return false;
    const expiry = Date.parse(plan.expiresAt), blockTime = Date.parse(p.blockTimestamp);
    if (!Number.isFinite(expiry) || !Number.isFinite(blockTime) || now >= expiry || blockTime > now + 10000 || now - blockTime > LENDING_PREVIEW_MS || expiry > blockTime + LENDING_PREVIEW_MS) return false;
    if (!i.all && (parseLendingAmount(expected.amount, p.asset.decimals) !== BigInt(b.assetsRaw) || parseLendingAmount(i.amount, p.asset.decimals) !== BigInt(b.assetsRaw))) return false;
    if (i.all && (i.operation !== "withdraw" || BigInt(b.sharesRaw) !== BigInt(p.sharesRaw))) return false;
    if (i.kind === "market" && (!p.params || !sameContract(marketIdentity(p.params), i.id) || !sameContract(p.params.loanToken, p.asset.address))) return false;
    if (i.operation !== "deposit" && i.operation !== "withdraw") return false;
    if (i.operation === "deposit" && BigInt(b.assetsRaw) > BigInt(p.walletBalanceRaw)) return false;
    if (i.operation === "withdraw" && (BigInt(b.assetsRaw) > BigInt(p.assetsRaw) || BigInt(b.sharesRaw) > BigInt(p.sharesRaw) || p.liquidityRaw !== null && BigInt(b.assetsRaw) > BigInt(p.liquidityRaw))) return false;
    if (!plan.gasEstimateETH || parseUnits(plan.gasEstimateETH, 18) <= BigInt(0) || parseUnits(plan.gasEstimateETH, 18) > BigInt(p.nativeBalanceRaw)) return false;
    const bounds = lendingBounds(i.operation, i.all, BigInt(b.assetsRaw), BigInt(b.sharesRaw), BigInt(p.sharesRaw), i.slippageBps);
    if (Object.keys(bounds).some((key) => bounds[key as keyof LendingBounds] !== b[key as keyof LendingBounds])) return false;
    if (!sameContract(tx.from, expected.account) || tx.value !== "0x0" || !/^0x[0-9a-f]+$/i.test(tx.gas) || BigInt(tx.gas) <= BigInt(0) || BigInt(tx.gas) > BigInt(5000000)) return false;
    if (plan.status === "authorization_required") return i.kind === "market" && i.operation === "withdraw" && !p.authorized && sameContract(tx.to, MORPHO) && tx.data === encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [LENDING_ADAPTER, true] });
    if (plan.status === "approval_required" || plan.status === "approval_reset_required") {
      if (i.kind === "market" && i.operation === "withdraw") return false;
      const a = lendingApproval(p, i, b), amount = plan.status === "approval_reset_required" ? BigInt(0) : a.amount;
      return a.allowance < a.amount && (plan.status !== "approval_reset_required" || a.allowance > BigInt(0)) && plan.approvalAmountRaw === String(amount) && !!plan.approvalToken && sameContract(plan.approvalToken, a.token) && sameContract(tx.to, a.token) && tx.data === encodeFunctionData({ abi: lendingTokenAbi, functionName: "approve", args: [LENDING_ADAPTER, amount] });
    }
    if (i.kind === "market" && i.operation === "withdraw") { if (!p.authorized) return false; }
    else { const a = lendingApproval(p, i, b); if (a.allowance < a.amount) return false; }
    return plan.status === "ready" && sameContract(tx.to, BUNDLER) && tx.data === lendingCall(i, p, b);
  } catch { return false; }
}
