import type { SnapshotStatus } from "./market-types";

export type LendingAsset = { address: string; symbol: string; decimals: number };
export type LendingWarning = { type: string; level: string };
export type LendingMarket = {
  id: string; listed: boolean; loan: LendingAsset; collateral: LendingAsset | null;
  supplyApy: number | null; borrowApy: number | null; suppliedUsd: number | null;
  borrowedUsd: number | null; liquidityUsd: number | null; utilization: number | null;
  lltv: number; updatedAt: string | null; warnings: LendingWarning[];
};
export type LendingVault = {
  address: string; name: string; version: 1 | 2; asset: LendingAsset;
  netApy: number | null; suppliedUsd: number | null; liquidityUsd: number | null;
  performanceFee: number | null; managementFee: number | null;
  curators: string[]; warnings: LendingWarning[]; gated: boolean;
};
export type LendingMarkets = SnapshotStatus & { markets: LendingMarket[]; fetchedAt: string; total: number; rejected: number };
export type LendingVaults = SnapshotStatus & { vaults: LendingVault[]; fetchedAt: string; total: number; rejected: number };
export type LendingHistory = SnapshotStatus & { marketId: string; points: { time: number; apy: number }[]; fetchedAt: string };

export function lendingLink(kind: "market" | "vault", id: string) {
  if (!(kind === "market" ? /^0x[\da-f]{64}$/i : /^0x[\da-f]{40}$/i).test(id)) return null;
  return `https://app.morpho.org/robinhood-chain/${kind}/${id}`;
}
export function lendingProjection(amount: string, apy: number | null, days: number) {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 10000000 || apy === null || !Number.isFinite(apy) || apy < 0 || apy > 100 || !Number.isFinite(days) || days < 0 || days > 365) return null;
  const interest = Number(amount) * (Math.pow(1 + apy, days / 365) - 1);
  return Number.isFinite(interest) ? interest : null;
}
export function depositDisabled(vault: LendingVault) {
  return vault.gated || vault.warnings.some((warning) => warning.type === "deposit_disabled" || warning.level.toUpperCase() === "RED");
}
export function lendingWarningText(warning: LendingWarning) {
  const messages: Record<string, string> = {
    deposit_disabled: "Deposits disabled in Morpho’s interface",
    not_whitelisted: "Not listed by Morpho",
    unrecognized_collateral_asset: "Collateral asset is not recognized by Morpho",
    unrecognized_loan_asset: "Loan asset is not recognized by Morpho",
    bad_debt: "Bad debt reported",
    unrecognized_oracle: "Oracle is not recognized by Morpho",
  };
  return messages[warning.type] ?? warning.type.replaceAll("_", " ");
}
