import { createPublicClient, createWalletClient, defineChain, encodePacked, formatUnits, http, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMarketService } from "../server/market-service";
import { createDeskService } from "../server/desk-service";
import { deskVaultAbi } from "../src/lib/desk-contract";
import { deskPriceIsFresh, deskProfitFloor } from "../src/lib/desk-economics";
import { CHAIN_ID, PUBLIC_RPC, USDG, V3_QUOTER } from "../src/lib/market-types";

const flags: string[] = process.argv.slice(2);
if (flags.includes("--help")) {
  console.log("Spreadline desk operator\n\nDefault: read-only scan and contract simulation. --execute signs ONE qualified trade.\n--watch repeats read-only scans every 30 seconds; cannot combine with --execute.\n\nRequired for contract simulation: DESK_VAULT_ADDRESS, DESK_VAULT_CODE_HASH, DESK_VAULT_DEPLOY_BLOCK.\nRequired for cost checks: DESK_ETH_PRICE_USDG (USDG per ETH), DESK_PRICE_TIMESTAMP (ISO time, max 5 minutes old).\nOptional: DESK_SYMBOL (NVDA), DESK_SIZE_USDG (100), DESK_MIN_NET_USDG (1), ROBINHOOD_RPC_URL.\nFor --execute only: DESK_OPERATOR_KEY. Keep keys in an operator secret manager, never frontend or Worker vars.\nOperator pays gas externally. The 75/25 split is trading surplus before that external cost. No LP inventory or overnight stock exposure is taken.");
  process.exit(0);
}
if (flags.some((flag) => !["--execute", "--watch"].includes(flag))) throw new Error("Unknown option. Use --help.");
const execute = flags.includes("--execute"), watch = flags.includes("--watch");
if (execute && watch) throw new Error("Execution is one trade per invocation. Continuous mode is read-only.");
const rpc = process.env.ROBINHOOD_RPC_URL || PUBLIC_RPC;
const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 12000, retryCount: 0, maxResponseBodySize: 2_000_000 }) });
function marketService() { return createMarketService(rpc, async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Public market source unavailable (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty market response.");
  const decoder = new TextDecoder(); let size = 0, value = "";
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new Error("Market response exceeded limit."); } value += decoder.decode(next.value, { stream: true }); }
  value += decoder.decode();
  return { value: JSON.parse(value), fetchedAt: new Date().toISOString() };
}); }
const deskConfig = {
  DESK_VAULT_ADDRESS: process.env.DESK_VAULT_ADDRESS || "",
  DESK_VAULT_CODE_HASH: process.env.DESK_VAULT_CODE_HASH || "",
  DESK_VAULT_DEPLOY_BLOCK: process.env.DESK_VAULT_DEPLOY_BLOCK || "0",
};
const symbol = process.env.DESK_SYMBOL || "NVDA";
const size = process.env.DESK_SIZE_USDG || "100";
const minNet = parseUnits(process.env.DESK_MIN_NET_USDG || "1", 6);
const quoterAbi = parseAbi(["function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)"]);
const log = (status: string, details: object = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), mode: execute ? "single-execution" : "read-only", status, symbol, ...details }));

async function scan() {
  // Worker transports deliberately have a per-request lifetime. Each scan gets
  // fresh services so a long-running read-only monitor never reuses an expired signal.
  const market = marketService();
  const desk = createDeskService(rpc, deskConfig, market);
  const [catalog, quote] = await Promise.all([market.catalog(), market.quote(symbol, size)]);
  const asset = catalog.assets.find((entry) => entry.symbol === symbol && entry.active);
  if (!asset || catalog.dataStatus || Date.parse(quote.expiresAt) <= Date.now() || quote.settlementDecimals !== 6) throw new Error("A current registered asset and complete quote are required.");
  const best = quote.routes.filter((route) => route.buyPool.toLowerCase() !== route.sellPool.toLowerCase() && route.buyFee !== route.sellFee)
    .sort((a, b) => { const left = parseUnits(a.surplus, 6), right = parseUnits(b.surplus, 6); return left > right ? -1 : left < right ? 1 : 0; })[0];
  if (!best || parseUnits(best.surplus, 6) <= 0n) { log("no-profitable-route", { block: quote.blockNumber, routes: quote.routes.length, bestTradingSurplusUSDG: best?.surplus ?? null }); return; }
  const vaultState = await desk.snapshot();
  if (vaultState.status !== "ready" || !vaultState.vault) { log("vault-unavailable", { detail: vaultState.message, indicativeTradingSurplusUSDG: best.surplus }); return; }
  const vault = vaultState.vault;
  if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("Quote expired while reading vault state. Scan again.");
  if (vault.paused) { log("execution-paused"); return; }
  const assetsIn = parseUnits(size, 6);
  if (assetsIn > BigInt(vault.maxTradeAssets) || assetsIn > BigInt(vault.managedAssets) || BigInt(vault.totalShares) === 0n) { log("capital-or-limit-insufficient"); return; }
  const priceTime = Date.parse(process.env.DESK_PRICE_TIMESTAMP || "");
  if (!deskPriceIsFresh(priceTime)) throw new Error("A fresh ETH/USDG price is required to evaluate operator costs (max five minutes old).");
  const ethPrice = parseUnits(process.env.DESK_ETH_PRICE_USDG || "0", 6);
  const [allowed, mandatoryProfit, maxDeadline, fees, firstLeg] = await Promise.all([
    client.readContract({ address: vault.address, abi: deskVaultAbi, functionName: "allowedTokens", args: [asset.address] }),
    client.readContract({ address: vault.address, abi: deskVaultAbi, functionName: "minimumProfitAssets" }),
    client.readContract({ address: vault.address, abi: deskVaultAbi, functionName: "maxDeadlineSeconds" }),
    client.estimateFeesPerGas(),
    client.simulateContract({ address: V3_QUOTER, abi: quoterAbi, functionName: "quoteExactInput", args: [encodePacked(["address", "uint24", "address"], [USDG, best.buyFee, asset.address]), assetsIn], blockNumber: BigInt(quote.blockNumber) }),
  ]);
  if (!allowed) { log("token-not-allowed"); return; }
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + (maxDeadline < 60n ? maxDeadline : 60n);
  const minStock = firstLeg.result[0] * 9950n / 10000n;
  const baseArgs = [asset.address, best.buyFee, best.sellFee, assetsIn, minStock, mandatoryProfit, deadline] as const;
  const estimate = await client.estimateContractGas({ account: vault.operator, address: vault.address, abi: deskVaultAbi, functionName: "executeArbitrage", args: baseArgs });
  const gas = (estimate * 120n + 99n) / 100n;
  const economicFloor = deskProfitFloor(gas, fees.maxFeePerGas, ethPrice, minNet);
  const floor = economicFloor > mandatoryProfit ? economicFloor : mandatoryProfit;
  if (parseUnits(best.surplus, 6) < floor) { log("below-cost-floor", { tradingSurplusUSDG: best.surplus, minimumTradingSurplusUSDG: formatUnits(floor, 6) }); return; }
  const args = [asset.address, best.buyFee, best.sellFee, assetsIn, minStock, floor, deadline] as const;
  const simulated = await client.simulateContract({ account: vault.operator, address: vault.address, abi: deskVaultAbi, functionName: "executeArbitrage", args });
  if (Date.parse(quote.expiresAt) <= Date.now() || !deskPriceIsFresh(priceTime)) throw new Error("Quote or operator cost inputs expired during simulation. Scan again.");
  log("qualified-simulation", { vault: vault.address, inputUSDG: size, simulatedTradingSurplusUSDG: formatUnits(simulated.result, 6), requiredSurplusUSDG: formatUnits(floor, 6), buyFee: best.buyFee, sellFee: best.sellFee, gasLimit: String(gas), deadline: String(deadline) });
  if (!execute) return;
  const key = process.env.DESK_OPERATOR_KEY;
  if (!key || !/^0x[\da-f]{64}$/i.test(key)) throw new Error("--execute requires a valid operator key from the operator secret environment.");
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== vault.operator.toLowerCase()) throw new Error("The signing account is not the configured vault operator.");
  if (await client.getChainId() !== CHAIN_ID) throw new Error("Wrong execution chain.");
  if (Date.parse(quote.expiresAt) <= Date.now() || !deskPriceIsFresh(priceTime) || deadline <= BigInt(Math.floor(Date.now() / 1000)))
    throw new Error("Execution inputs expired during the final network check. Scan again.");
  // Only this explicit CLI flag enters the signer path; the Worker never holds a key.
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 0, timeout: 12000 }) });
  const hash = await wallet.writeContract({ address: vault.address, abi: deskVaultAbi, functionName: "executeArbitrage", args, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  log("submitted", { hash });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120000 });
  log(receipt.status === "success" ? "confirmed" : "reverted", { hash, block: String(receipt.blockNumber) });
}

do {
  try { await scan(); } catch (error) { log("stopped", { reason: error instanceof Error ? error.message.split("\n")[0] : "Unknown failure" }); if (!watch) process.exitCode = 1; }
  if (watch) await new Promise((resolve) => setTimeout(resolve, 30000));
} while (watch);
