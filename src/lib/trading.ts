import { encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { CHAIN_ID, SWAP_ROUTER, USDG, FEE_TIERS } from "./market-types";

export type TradeSide = "buy" | "sell";
export class TradePreparationError extends Error {
  constructor(message: string) { super(message); this.name = "TradePreparationError"; }
}
export type SwapQuote = {
  symbol: string; side: TradeSide; amountIn: string; amountInRaw: string;
  tokenIn: Address; tokenOut: Address; inputDecimals: number; outputDecimals: number;
  blockNumber: string; blockTimestamp: string; expiresAt: string; fetchedAt: string;
  slippageBps: number; attempted: number; failed: number;
  routes: { fee: number; pool: Address; amountOut: string; amountOutRaw: string; minimumOut: string; minimumOutRaw: string; priceUSDG: number }[];
};
export type TradePlan = {
  quote: SwapQuote; account: Address; chainId: typeof CHAIN_ID;
  inputBalance: string; nativeBalance: string; allowance: string;
  status: "insufficient_balance" | "insufficient_gas" | "approval_required" | "ready";
  transaction?: { from: Address; to: Address; data: Hex; value: "0x0"; gas: Hex };
  gasEstimateETH?: string; deadline?: number; expiresAt: string;
};
export const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
  "function factory() view returns (address)",
]);
export const approvalAbi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);
export function parseSwapAmount(value: string, decimals: number) {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals)
    throw new TradePreparationError("Enter a positive amount with up to six decimals supported by the token.");
  const amount = parseUnits(value, decimals);
  if (amount <= BigInt(0) || amount > BigInt(100000) * BigInt(10) ** BigInt(decimals)) throw new TradePreparationError("Amount must be above zero and at most 100,000 input tokens.");
  return amount;
}
export function minimumOutput(value: bigint, slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100) throw new Error("Choose slippage between 0.01% and 1%.");
  const minimum = value * BigInt(10000 - slippageBps) / BigInt(10000);
  if (minimum <= BigInt(0)) throw new Error("The minimum received is too small.");
  return minimum;
}
export function swapCall(quote: SwapQuote, recipient: Address, deadline: number) {
  const route = quote.routes[0];
  if (!route || !FEE_TIERS.some((fee) => fee === route.fee) || quote.tokenIn.toLowerCase() === quote.tokenOut.toLowerCase()) throw new Error("Invalid swap route.");
  const settlement = quote.side === "buy" ? quote.tokenIn : quote.tokenOut;
  if (settlement.toLowerCase() !== USDG.toLowerCase() || BigInt(quote.amountInRaw) <= BigInt(0) || BigInt(route.minimumOutRaw) !== minimumOutput(BigInt(route.amountOutRaw), quote.slippageBps)) throw new Error("Invalid swap amounts.");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid swap deadline.");
  const inner = encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, fee: route.fee, recipient, amountIn: BigInt(quote.amountInRaw), amountOutMinimum: BigInt(route.minimumOutRaw), sqrtPriceLimitX96: BigInt(0) }] });
  return encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [BigInt(deadline), [inner]] });
}
export function approvalCall(quote: SwapQuote) {
  return encodeFunctionData({ abi: approvalAbi, functionName: "approve", args: [SWAP_ROUTER, BigInt(quote.amountInRaw)] });
}
export function uniswapLink(stock: Address, side: TradeSide, amount: string) {
  const params = new URLSearchParams({ chain: "robinhood", inputCurrency: side === "buy" ? USDG : stock, outputCurrency: side === "buy" ? stock : USDG, field: "input", value: amount });
  return `https://app.uniswap.org/#/swap?${params}`;
}
export function planMatches(plan: TradePlan, expected: { account: string; stock: string; stockDecimals: number; side: TradeSide; amount: string; slippageBps: number }, now = Date.now()) {
  try {
    const q = plan.quote, tx = plan.transaction;
    const input = expected.side === "buy" ? USDG : expected.stock;
    const output = expected.side === "buy" ? expected.stock : USDG;
    const inputDecimals = expected.side === "buy" ? 6 : expected.stockDecimals;
    const outputDecimals = expected.side === "buy" ? expected.stockDecimals : 6;
    if (plan.chainId !== CHAIN_ID || plan.account.toLowerCase() !== expected.account.toLowerCase() || q.tokenIn.toLowerCase() !== input.toLowerCase() || q.tokenOut.toLowerCase() !== output.toLowerCase() || q.side !== expected.side || q.inputDecimals !== inputDecimals || q.outputDecimals !== outputDecimals || q.slippageBps !== expected.slippageBps || q.failed || !q.routes.length) return false;
    if (parseSwapAmount(q.amountIn, inputDecimals) !== BigInt(q.amountInRaw) || parseSwapAmount(expected.amount, inputDecimals) !== BigInt(q.amountInRaw)) return false;
    if (![plan.expiresAt, q.expiresAt].every((time) => Number.isFinite(Date.parse(time)) && now < Date.parse(time))) return false;
    const route = q.routes[0];
    if (parseUnits(route.amountOut, outputDecimals) !== BigInt(route.amountOutRaw) || parseUnits(route.minimumOut, outputDecimals) !== minimumOutput(BigInt(route.amountOutRaw), expected.slippageBps) || BigInt(route.minimumOutRaw) !== minimumOutput(BigInt(route.amountOutRaw), expected.slippageBps)) return false;
    if (!tx || tx.from.toLowerCase() !== expected.account.toLowerCase() || tx.value !== "0x0" || !/^0x[0-9a-f]+$/i.test(tx.gas) || BigInt(tx.gas) <= BigInt(0) || BigInt(tx.gas) > BigInt(5000000)) return false;
    if (plan.status === "approval_required") return tx.to.toLowerCase() === input.toLowerCase() && tx.data === approvalCall(q);
    return plan.status === "ready" && !!plan.deadline && plan.deadline > now / 1000 && plan.deadline <= now / 1000 + 180 && tx.to.toLowerCase() === SWAP_ROUTER.toLowerCase() && tx.data === swapCall(q, plan.account, plan.deadline);
  } catch { return false; }
}
export function gasETH(gas: bigint, gasPrice: bigint) { return formatUnits(gas * gasPrice, 18); }
