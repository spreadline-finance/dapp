import { decodeFunctionResult, encodeFunctionData, erc20Abi, isAddress, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { deskVaultAbi } from "./desk-contract";
import { CHAIN_ID, SWAP_ROUTER, USDG } from "./market-types";
import type { DeskSnapshot } from "./desk-types";
import { walletSubmissions, type WalletProvider } from "./wallet-submission";

export type DeskAction = "deposit" | "withdraw" | "claim";
export type DeskPlan = {
  kind: DeskAction | "approval" | "reset-approval";
  account: Address;
  vault: Address;
  assets: string;
  shares: string | null;
  minimum: string | null;
  expiresAt: number;
  transaction: { from: Address; to: Address; data: Hex; value: "0x0"; gas: Hex; chainId: "0x1237" };
};

export function parseDeskAssets(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(value)) throw new Error("Enter a USDG amount with up to six decimal places.");
  const amount = parseUnits(value, 6);
  if (amount <= BigInt(0)) throw new Error("Enter an amount greater than zero.");
  return amount;
}

export function sharesFromPercent(shares: string, value: string): bigint {
  if (!/^(?:\d{1,3})(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter a percentage from 0.01 to 100.");
  const bps = parseUnits(value, 2);
  if (bps <= BigInt(0) || bps > BigInt(10000)) throw new Error("Enter a percentage from 0.01 to 100.");
  const result = BigInt(shares) * bps / BigInt(10000);
  if (!result) throw new Error("This percentage is too small for your share balance.");
  return result;
}

async function checkWallet(provider: WalletProvider, account: Address) {
  const [chain, accounts] = await Promise.all([
    provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" }),
  ]);
  if (typeof chain !== "string" || !/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(CHAIN_ID) ||
    !Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== account.toLowerCase()) {
    throw new Error("Your wallet account or network changed. Connect the correct wallet and prepare again.");
  }
}

function checkApprovalResult(kind: DeskPlan["kind"], raw: unknown) {
  if (kind !== "approval" && kind !== "reset-approval") return;
  if (raw === "0x") return;
  if (typeof raw !== "string" || !/^0x[\da-f]{64}$/i.test(raw) ||
    decodeFunctionResult({ abi: erc20Abi, functionName: "approve", data: raw as Hex }) !== true)
    throw new Error("USDG refused the approval simulation. No transaction was sent.");
}

function planMatches(plan: DeskPlan, account: Address, vault: Address) {
  try {
    if (!isAddress(vault, { strict: false }) || vault === zeroAddress || plan.vault.toLowerCase() !== vault.toLowerCase() ||
      plan.account.toLowerCase() !== account.toLowerCase() || plan.transaction.from.toLowerCase() !== account.toLowerCase() ||
      plan.transaction.value !== "0x0" || plan.transaction.chainId !== "0x1237" || !/^0x[\da-f]+$/i.test(plan.transaction.gas) ||
      BigInt(plan.transaction.gas) <= BigInt(0) || BigInt(plan.transaction.gas) > BigInt(2400000) || !/^\d{1,78}$/.test(plan.assets)) return false;
    const assets = BigInt(plan.assets);
    if (assets <= BigInt(0)) return false;
    let expected: Hex, to: Address = vault;
    if (plan.kind === "approval" || plan.kind === "reset-approval") {
      to = USDG;
      expected = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, plan.kind === "approval" ? assets : BigInt(0)] });
    } else if (plan.kind === "claim") {
      expected = encodeFunctionData({ abi: deskVaultAbi, functionName: "claim", args: [account] });
    } else if (plan.kind === "deposit" || plan.kind === "withdraw") {
      if (!plan.shares || !/^\d{1,78}$/.test(plan.shares)) return false;
      const shares = BigInt(plan.shares);
      const output = plan.kind === "deposit" ? shares : assets;
      const minimum = output - output / BigInt(1000);
      if (shares <= BigInt(0) || plan.minimum !== String(minimum)) return false;
      expected = plan.kind === "deposit"
        ? encodeFunctionData({ abi: deskVaultAbi, functionName: "deposit", args: [assets, account, minimum] })
        : encodeFunctionData({ abi: deskVaultAbi, functionName: "withdraw", args: [shares, account, minimum] });
    } else return false;
    return plan.transaction.to.toLowerCase() === to.toLowerCase() && plan.transaction.data.toLowerCase() === expected.toLowerCase();
  } catch { return false; }
}

/** Preparing only reads/simulates. A separate explicit send action requests a signature. */
export async function prepareDeskAction(provider: WalletProvider, snapshot: DeskSnapshot, account: Address,
  action: DeskAction, input: string, clock = Date.now): Promise<DeskPlan> {
  const timestamp = Date.parse(snapshot.fetchedAt);
  if (snapshot.status !== "ready" || !snapshot.vault || snapshot.chainId !== CHAIN_ID || snapshot.dataStatus ||
    !Number.isFinite(timestamp) || clock() - timestamp > 30000 || timestamp > clock() + 5000 ||
    snapshot.wallet?.address.toLowerCase() !== account.toLowerCase() ||
    snapshot.vault.settlement.toLowerCase() !== USDG.toLowerCase() || snapshot.vault.router.toLowerCase() !== SWAP_ROUTER.toLowerCase()) {
    throw new Error("A fresh, verified vault snapshot for this wallet is required. Refresh the desk.");
  }
  const vault = snapshot.vault.address;
  await checkWallet(provider, account);
  let kind: DeskPlan["kind"] = action, assets = "0", shares: string | null = null, minimum: string | null = null;
  let to: Address = vault, data: Hex;
  if (action === "deposit") {
    const amount = parseDeskAssets(input);
    if (amount > BigInt(snapshot.wallet.assetBalance)) throw new Error("The deposit exceeds your USDG balance.");
    assets = String(amount);
    const allowance = BigInt(snapshot.wallet.allowance);
    if (allowance < amount) {
      kind = allowance > BigInt(0) ? "reset-approval" : "approval";
      to = USDG;
      data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, kind === "reset-approval" ? BigInt(0) : amount] });
    } else {
      const encoded = encodeFunctionData({ abi: deskVaultAbi, functionName: "previewDeposit", args: [amount] });
      const raw = await provider.request({ method: "eth_call", params: [{ from: account, to: vault, data: encoded }, "latest"] });
      if (typeof raw !== "string" || !/^0x[\da-f]+$/i.test(raw)) throw new Error("The deposit preview was unavailable.");
      const preview = decodeFunctionResult({ abi: deskVaultAbi, functionName: "previewDeposit", data: raw as Hex });
      if (preview <= BigInt(0)) throw new Error("The deposit would mint no shares.");
      shares = String(preview);
      const floor = preview - preview / BigInt(1000);
      minimum = String(floor);
      data = encodeFunctionData({ abi: deskVaultAbi, functionName: "deposit", args: [amount, account, floor] });
    }
  } else if (action === "withdraw") {
    const quantity = sharesFromPercent(snapshot.wallet.shares, input);
    const encoded = encodeFunctionData({ abi: deskVaultAbi, functionName: "previewRedeem", args: [quantity] });
    const raw = await provider.request({ method: "eth_call", params: [{ from: account, to: vault, data: encoded }, "latest"] });
    if (typeof raw !== "string" || !/^0x[\da-f]+$/i.test(raw)) throw new Error("The withdrawal preview was unavailable.");
    const preview = decodeFunctionResult({ abi: deskVaultAbi, functionName: "previewRedeem", data: raw as Hex });
    if (preview <= BigInt(0)) throw new Error("The withdrawal is too small to return USDG.");
    shares = String(quantity); assets = String(preview);
    const floor = preview - preview / BigInt(1000);
    minimum = String(floor);
    data = encodeFunctionData({ abi: deskVaultAbi, functionName: "withdraw", args: [quantity, account, floor] });
  } else {
    assets = snapshot.wallet.claimableAssets;
    if (BigInt(assets) <= BigInt(0)) throw new Error("This wallet has no claimable rewards yet.");
    data = encodeFunctionData({ abi: deskVaultAbi, functionName: "claim", args: [account] });
  }
  const transaction = { from: account, to, data, value: "0x0" as const, chainId: "0x1237" as const };
  checkApprovalResult(kind, await provider.request({ method: "eth_call", params: [transaction, "latest"] }));
  const gas = await provider.request({ method: "eth_estimateGas", params: [transaction] });
  if (typeof gas !== "string" || !/^0x[\da-f]+$/i.test(gas) || BigInt(gas) <= BigInt(0) || BigInt(gas) > BigInt(2000000)) throw new Error("The wallet returned an invalid gas estimate.");
  if (clock() - timestamp > 30000) throw new Error("The vault snapshot expired while preparing. Refresh and try again.");
  await checkWallet(provider, account);
  return { kind, account, vault, assets, shares, minimum, expiresAt: clock() + 30000,
    transaction: { ...transaction, gas: `0x${(BigInt(gas) * BigInt(120) / BigInt(100)).toString(16)}` } };
}

export async function sendDeskPlan(provider: WalletProvider, plan: DeskPlan, account: Address, vault: Address, clock = Date.now): Promise<Hex> {
  if (walletSubmissions.has(provider)) throw new Error("Complete the wallet request already in progress first.");
  walletSubmissions.add(provider);
  try {
    if (!planMatches(plan, account, vault) || plan.expiresAt <= clock()) throw new Error("This preview changed or expired. Prepare again.");
    await checkWallet(provider, account);
    if (plan.expiresAt <= clock()) throw new Error("This preview expired. Prepare again.");
    // Simulate again immediately before opening the wallet; signatures are always explicit.
    checkApprovalResult(plan.kind, await provider.request({ method: "eth_call", params: [plan.transaction, "latest"] }));
    await checkWallet(provider, account);
    if (plan.expiresAt <= clock()) throw new Error("This preview expired. Prepare again.");
    const hash = await provider.request({ method: "eth_sendTransaction", params: [plan.transaction] });
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("No transaction hash was returned. Check your wallet before trying again.");
    return hash as Hex;
  } finally { walletSubmissions.delete(provider); }
}
