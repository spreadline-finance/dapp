import { createPublicClient, encodeFunctionData, formatEther, toHex, zeroAddress, type Address, type Hex } from "viem";
import { CHAIN_ID } from "../src/lib/market-types";
import { depositDisabled } from "../src/lib/lending";
import { createLendingService } from "./lending-service";
import { requestTransport } from "./rpc";
import {
  MORPHO, BUNDLER, LENDING_ADAPTER, VAULT_V2_FACTORY, LENDING_PREVIEW_MS,
  lendingTokenAbi, vaultAbi, vaultFactoryAbi, morphoAbi, irmAbi, lendingAdapterAbi,
  accrueBlue, blueAssets, blueShares, marketIdentity, marketParamsTuple, sameContract,
  lendingBounds, lendingCall, lendingApproval, parseLendingAmount, LendingPreparationError,
  type LendingKind, type LendingIntent, type LendingPosition, type LendingPlan, type BlueState,
} from "../src/lib/lending-execution";

// A new client and transport belong to this request. Private balances and plans are never cached.
export function createLendingExecutionService(rpc: string, metadata: ReturnType<typeof createLendingService>) {
  let currentClient: ReturnType<typeof createPublicClient> | undefined;
  const getClient = () => currentClient ??= createPublicClient({ transport: requestTransport(rpc) });
  async function snapshot(kind: LendingKind, id: string, account: Address, minBlock = 0n) {
    const client = getClient();
    const [chain, block, adapterBundler, adapterMorpho] = await Promise.all([
      client.getChainId(), client.getBlock(),
      client.readContract({ address: LENDING_ADAPTER, abi: lendingAdapterAbi, functionName: "BUNDLER3" }),
      client.readContract({ address: LENDING_ADAPTER, abi: lendingAdapterAbi, functionName: "MORPHO" }),
    ]);
    if (chain !== CHAIN_ID || !sameContract(adapterBundler, BUNDLER) || !sameContract(adapterMorpho, MORPHO)) throw new LendingPreparationError("The RPC network or lending deployment did not match Robinhood Chain.");
    const blockTime = Number(block.timestamp) * 1000;
    if (Date.now() - blockTime > 15000 || blockTime > Date.now() + 10000 || block.number < minBlock) throw new LendingPreparationError("The RPC has not reached a fresh enough block. Refresh in a few seconds.");
    const at = { blockNumber: block.number };
    let asset: Address, shareDecimals: number, shares: bigint, assets: bigint, liquidity: bigint | null = null;
    let params: LendingPosition["params"], accrued: BlueState | undefined;
    if (kind === "market") {
      const [rawParams, rawState, rawPosition, recipient] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id as Hex], ...at }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id as Hex], ...at }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [id as Hex, account], ...at }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "feeRecipient", ...at }),
      ]);
      params = { loanToken: rawParams[0], collateralToken: rawParams[1], oracle: rawParams[2], irm: rawParams[3], lltv: String(rawParams[4]) };
      if (!sameContract(marketIdentity(params), id) || rawState[4] === 0n || sameContract(params.loanToken, zeroAddress)) throw new LendingPreparationError("This is not an existing Morpho market on Robinhood Chain.");
      const state: BlueState = { totalSupplyAssets: rawState[0], totalSupplyShares: rawState[1], totalBorrowAssets: rawState[2], totalBorrowShares: rawState[3], lastUpdate: rawState[4], fee: rawState[5] };
      const rate = state.totalBorrowAssets && block.timestamp > state.lastUpdate && !sameContract(params.irm, zeroAddress) ? await client.readContract({ address: params.irm, abi: irmAbi, functionName: "borrowRateView", args: [marketParamsTuple(params), state], ...at }) : 0n;
      const updated = accrueBlue(state, rate, block.timestamp);
      accrued = updated; shares = rawPosition[0] + (sameContract(account, recipient) ? updated.feeShares : 0n);
      assets = blueAssets(shares, updated); liquidity = updated.totalSupplyAssets - updated.totalBorrowAssets;
      asset = params.loanToken; shareDecimals = 0; // Blue shares are accounting units, not an ERC-20 token.
    } else {
      const registered = await client.readContract({ address: VAULT_V2_FACTORY, abi: vaultFactoryAbi, functionName: "isVaultV2", args: [id as Address], ...at });
      if (!registered) throw new LendingPreparationError("Native execution currently supports factory-verified Morpho V2 vaults. This vault is not supported.");
      [asset, shareDecimals, shares] = await Promise.all([
        client.readContract({ address: id as Address, abi: vaultAbi, functionName: "asset", ...at }),
        client.readContract({ address: id as Address, abi: lendingTokenAbi, functionName: "decimals", ...at }),
        client.readContract({ address: id as Address, abi: lendingTokenAbi, functionName: "balanceOf", args: [account], ...at }),
      ]);
      assets = await client.readContract({ address: id as Address, abi: vaultAbi, functionName: "previewRedeem", args: [shares], ...at });
      // V2 maxWithdraw/maxRedeem always return zero. The exact routed exit must be simulated.
    }
    const [decimals, symbol, walletBalance, nativeBalance, allowance, shareAllowance, authorized] = await Promise.all([
      client.readContract({ address: asset, abi: lendingTokenAbi, functionName: "decimals", ...at }),
      client.readContract({ address: asset, abi: lendingTokenAbi, functionName: "symbol", ...at }),
      client.readContract({ address: asset, abi: lendingTokenAbi, functionName: "balanceOf", args: [account], ...at }),
      client.getBalance({ address: account, ...at }),
      client.readContract({ address: asset, abi: lendingTokenAbi, functionName: "allowance", args: [account, LENDING_ADAPTER], ...at }),
      kind === "vault" ? client.readContract({ address: id as Address, abi: lendingTokenAbi, functionName: "allowance", args: [account, LENDING_ADAPTER], ...at }) : 0n,
      kind === "market" ? client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [account, LENDING_ADAPTER], ...at }) : false,
    ]);
    if (decimals > 36 || shareDecimals > 36 || symbol.length > 40) throw new LendingPreparationError("Unsupported token metadata.");
    const position: LendingPosition = { kind, id, account, chainId: CHAIN_ID, asset: { address: asset, symbol, decimals }, shareDecimals, sharesRaw: String(shares), assetsRaw: String(assets), walletBalanceRaw: String(walletBalance), nativeBalanceRaw: String(nativeBalance), assetAllowanceRaw: String(allowance), shareAllowanceRaw: String(shareAllowance), authorized, liquidityRaw: liquidity === null ? null : String(liquidity), params, blockNumber: String(block.number), blockTimestamp: new Date(blockTime).toISOString(), fetchedAt: new Date().toISOString() };
    return { position, accrued, block };
  }
  return {
    async position(kind: LendingKind, id: string, account: Address, minBlock?: bigint) { return (await snapshot(kind, id, account, minBlock)).position; },
    async plan(intent: LendingIntent, account: Address, minBlock?: bigint): Promise<LendingPlan> {
      // The indexer can block new risk, but an indexer failure must not prevent existing exits.
      if (intent.operation === "deposit") {
        if (intent.kind === "market") {
          const market = (await metadata.markets()).markets.find((m) => sameContract(m.id, intent.id));
          if (!market?.listed || market.warnings.some((w) => w.level.toUpperCase() === "RED" || w.type === "deposit_disabled")) throw new LendingPreparationError("New deposits require a listed market without critical Morpho alerts. Existing positions can still be withdrawn.");
        } else {
          const vault = (await metadata.vaults()).vaults.find((v) => sameContract(v.address, intent.id));
          if (!vault || depositDisabled(vault)) throw new LendingPreparationError("New deposits are restricted for this vault in Morpho. You can still prepare a withdrawal of an existing position.");
        }
      }
      const { position: p, accrued, block } = await snapshot(intent.kind, intent.id, account, minBlock);
      const client = getClient();
      const assets = intent.all ? BigInt(p.assetsRaw) : parseLendingAmount(intent.amount, p.asset.decimals);
      if (intent.operation === "deposit" && assets > BigInt(p.walletBalanceRaw)) throw new LendingPreparationError(`Your wallet does not have enough ${p.asset.symbol} for this deposit.`);
      if (intent.operation === "withdraw" && (assets > BigInt(p.assetsRaw) || BigInt(p.sharesRaw) === 0n)) throw new LendingPreparationError("This withdrawal exceeds your supplied position.");
      if (intent.operation === "withdraw" && p.liquidityRaw !== null && assets > BigInt(p.liquidityRaw)) throw new LendingPreparationError("This market does not have enough available liquidity for that withdrawal. Try a smaller amount.");
      const shares = intent.all ? BigInt(p.sharesRaw) : intent.kind === "market" ? blueShares(assets, accrued!, intent.operation === "withdraw") : await client.readContract({ address: intent.id as Address, abi: vaultAbi, functionName: intent.operation === "deposit" ? "previewDeposit" : "previewWithdraw", args: [assets], blockNumber: block.number });
      const bounds = lendingBounds(intent.operation, intent.all, assets, shares, BigInt(p.sharesRaw), intent.slippageBps);
      let status: LendingPlan["status"] = "ready", to: Address = BUNDLER, data = lendingCall(intent, p, bounds);
      let approvalToken: Address | undefined, approvalAmountRaw: string | undefined, currentAllowance = 0n;
      if (intent.kind === "market" && intent.operation === "withdraw") {
        if (!p.authorized) { status = "authorization_required"; to = MORPHO; data = encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [LENDING_ADAPTER, true] }); }
      } else {
        const a = lendingApproval(p, intent, bounds); currentAllowance = a.allowance;
        if (a.allowance < a.amount) { status = "approval_required"; approvalToken = a.token; approvalAmountRaw = String(a.amount); to = a.token; data = encodeFunctionData({ abi: lendingTokenAbi, functionName: "approve", args: [LENDING_ADAPTER, a.amount] }); }
      }
      const simulate = async () => {
        const result = await client.call({ account, to, data, value: 0n, blockNumber: block.number });
        if ((status === "approval_required" || status === "approval_reset_required") && result.data && result.data !== "0x" && BigInt(result.data) !== 1n) throw new LendingPreparationError("The token rejected this approval.");
      };
      try { await simulate(); }
      catch (error) {
        let cause = error; let reverted = error instanceof LendingPreparationError;
        for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
          if ("name" in cause && ["ContractFunctionRevertedError", "ExecutionRevertedError"].includes(String(cause.name))) reverted = true;
          cause = "cause" in cause ? cause.cause : undefined;
        }
        if (status !== "approval_required" || currentAllowance === 0n || !reverted) throw error;
        status = "approval_reset_required"; approvalAmountRaw = "0";
        data = encodeFunctionData({ abi: lendingTokenAbi, functionName: "approve", args: [LENDING_ADAPTER, 0n] });
        await simulate();
      }
      const estimate = await client.estimateGas({ account, to, data, value: 0n });
      const gas = (estimate * 125n + 99n) / 100n;
      if (gas > 5000000n) throw new LendingPreparationError("This transaction requires an unusually high gas limit.");
      const price = await client.getGasPrice();
      const gasCost = gas * price * 2n;
      if (BigInt(p.nativeBalanceRaw) < gasCost) throw new LendingPreparationError("You need more ETH on Robinhood Chain to cover the estimated network fee.");
      const expiresAt = new Date(Number(block.timestamp) * 1000 + LENDING_PREVIEW_MS).toISOString();
      if (Date.now() >= Date.parse(expiresAt) - 3000) throw new LendingPreparationError("This preview took too long to prepare. Refresh for a current block.");
      return { intent, position: p, bounds, status, reason: status === "authorization_required" ? "Authorize the Morpho adapter, then prepare a fresh withdrawal." : status === "approval_reset_required" ? "Reset the existing allowance to zero, then prepare a fresh approval." : status === "approval_required" ? "Approve this amount, then prepare a fresh lending transaction." : "Your exact lending transaction passed simulation. Review it in your wallet.", approvalToken, approvalAmountRaw, transaction: { from: account, to, data, value: "0x0", gas: toHex(gas) }, gasEstimateETH: formatEther(gasCost), expiresAt };
    },
  };
}
