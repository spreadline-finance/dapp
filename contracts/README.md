# Spreadline earnings vault

This is an implemented, locally tested contract mechanism, **not a deployed or audited investment product**. No user deposits, live trades or payouts have been made by this implementation. The app must have an explicitly configured, verified deployment before it can offer transactions.

Users deposit USDG and receive nontransferable accounting shares. An operator can use available vault capital for one narrowly defined action: buy an allowlisted stock token in one Uniswap V3 fee tier, then sell the exact newly acquired token amount in another tier in the same transaction. The final USDG balance must exceed the starting balance by the operator-specified minimum, which itself cannot be below the owner's configured floor. If either leg fails or the final balance is insufficient, the whole transaction reverts.

An accepted trade allocates 75% of its realized USDG trading surplus to a cash-backed reward reserve. The other 25% increases capital backing shares. Holders claim their accrued USDG rewards directly. A claim is counted as paid only when its transaction succeeds. There is no guaranteed yield, token emission, treasury subsidy masquerading as income, or forecast that quotes will be executable.

Gas is paid by the operator outside the vault and is not deducted from `totalRealizedProfit`. That getter measures settlement trading surplus after swaps, before the operator's network costs. An operator must compare the surplus with its gas cost and margin before submission. A reverting transaction may still cost the operator gas.

## Accounting and access

- `managedAssets()` equals actual USDG balance minus all allocated, unclaimed reward liabilities. New deposits buy shares only in that managed capital; they do not inherit previous rewards.
- Rewards use a cumulative index with per-account fractional accrual. Deposits and withdrawals settle that account's existing accrual first. A user can withdraw all shares and subsequently claim their old earnings.
- The complete 75% reward budget is reserved even when integer rounding makes a small fraction unclaimable. This conservative dust is never recycled into apparent profit or withdrawn by administrators.
- Share conversions use one virtual asset and 1,000,000 virtual shares, plus mandatory caller minimums for deposit shares and withdrawal assets. These constrain donation-based inflation and front-running. Use `previewDeposit` and `previewRedeem` for wallet planning and set positive minimums; do not value shares by a naïve ratio. Virtual conversion may leave residual capital dust when the last holder withdraws, especially after unsolicited donations. There is no final-holder sweep that bypasses the defense.
- The owner controls the operator, stock allowlist, maximum trade size, minimum surplus, and a maximum deadline of at most 300 seconds. Ownership transfer takes two steps. Execution starts paused. The pause does not stop deposits, withdrawals, or reward claims.
- The owner and operator have no principal withdrawal, arbitrary-call, token-sweep, share-transfer, reward-reset, or contract-upgrade function. The settlement and router addresses are immutable. Only a holder can redeem their own shares or claim their own rewards, to a receiver they select.
- Router allowances are limited to each leg's actual amount and reset to zero after use. Final earnings use token balance changes, not the router's reported return value. Previously donated stock tokens are not traded.

This is an atomic trading strategy, not Arbitrage Ape's longer-lived LP inventory strategy. The latter would need a separate inventory manager, mark-to-market and realized loss accounting, and a strategy that can lose capital while inventory is held. This vault does not hold strategic overnight stock exposure or provide concentrated liquidity. It adapts the verifiable trading-surplus-to-holder-payment mechanism to Spreadline's existing V3 routes and USDG settlement.

## Build and verification

Install [Foundry](https://getfoundry.sh/introduction/installation/), then run from the repository root:

```sh
forge test --root contracts -vv
node scripts/desk-contract-build.mjs
```

The tests execute Solidity bytecode against mock tokens and a router. They cover actual deposits and withdrawals, post-withdrawal claims, late-depositor reward isolation, loss rollback, swap return-value manipulation, approvals, policy and access restrictions, share inflation, fee tokens, callback reentrancy, and 512 randomized sequences that reconcile deposits plus realized surplus against withdrawals, claims, and remaining cash. These are local EVM tests; they do not prove execution against funded mainnet pools.

The build writes ignored compiler artifacts and a manifest under `contracts/out`. Its runtime template hash is **not** a deployable app identity because Solidity patches immutable settlement/router references at deployment. Before enabling a deployment, compare its bytecode with the compiler artifact patched using the exact approved constructor values, verify those immutable values on chain, and then configure its actual runtime code hash in the backend. A matching hash must not be inferred merely because getter responses look plausible.

The client ABI in `src/lib/desk-contract.ts` is checked against compiled function and event selectors by `tests/desk-contract.test.ts` when Foundry is installed. That test uses the local compiler cache. The first `forge test` may download Solidity 0.8.26.

## Deployment prerequisites

Use the intended network's verified USDG and SwapRouter02 addresses. The router tuple matches [Uniswap's `IV3SwapRouter` interface](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol). The constructor is:

```text
SpreadlineVault(settlement, router, owner, operator, maxTradeAssets)
```

No deployment script automatically broadcasts. For a launch, obtain an independent contract review, validate a fork against the precise target contracts, choose custody and operator controls, set conservative trade limits, verify a deliberately small funded end-to-end cycle, and resolve the product's legal and operating requirements. Store an operator key in a dedicated signing environment, not the frontend, Worker configuration, source tree, or shell arguments.

Deployment does not create trading opportunities. The operator may correctly find no profitable routes for extended periods. Depositor eligibility is based on shares held when a successful trade executes; there is no holding-period or anti-MEV deposit lock. Just-in-time deposits can dilute an individual holder's proportion of a trade's rewards. Settlement issuer freezes, rebases, unusual transfer behavior, compromised token/router contracts, RPC errors, contract bugs, and governance mistakes remain risks. The supported token assumption is plain, non-rebasing ERC20 behavior; exact transfer checks reject detected fee-on-transfer behavior but cannot eliminate issuer or contract risk.
