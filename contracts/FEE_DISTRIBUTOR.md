# Spreadline token-holder fee distributor

`SpreadlineFeeDistributor.sol` is a separate cash-funded fee-sharing contract for a Pons-launched token. It does not change `SpreadlineVault`, accept investor deposits, mint a reward token, or promise yield. Tests provide engineering evidence; this contract is **unaudited** and needs independent review before holding live funds.

## Funding and deployment

The deployment fixes the reward asset, Pons factory, hook and escrow. `address(0)` means native ETH; an ERC20 deployment supports a plain, non-rebasing token with exact transfer amounts. Reward assets cannot be changed in place. Use the same asset as the Pons launch's pairing asset.

Constructor arguments, in order:

1. `holderToken_`: normally zero before the launch.
2. `rewardAsset_`: zero for ETH or the verified pairing ERC20 address.
3. `ponsEscrow_`.
4. `ponsFactory_`.
5. `ponsHook_`.
6. `owner_`: the account controlling distribution policy, preferably a reviewed multisig.
7. `operator_`: the account sponsoring fee collection, root publication and push distributions.
8. `Policy(holderBps, devBps, treasuryBps, intervalSeconds, rootDelaySeconds, minimumIncome, devWallet, treasuryWallet)`.

The constructor checks the factory's escrow/hook and the hook's factory/pool-manager linkage. Deployment tooling must additionally verify the official contracts' addresses and exact runtime bytecode. Getter consistency alone does not establish authenticity.

Deploy the distributor first with `holderToken_ = 0`. Launch the token with **this distributor as `creatorFeeRecipient`**, then call `bindHolderToken(token)` once from the owner. Binding checks that the factory recognizes the token, its pairing asset matches, and its creator-fee recipient is this distributor. It starts paused; review the resulting token, immutable addresses and policy before `setPaused(false)`.

The contract cannot collect escrow credits owed to another wallet. If the launch initially used a developer wallet, changing Pons's recipient only redirects future credits; already credited money stays with the earlier recipient until that recipient claims and intentionally funds the distributor. The staged launch path avoids that split.

Fee collection has two separate steps:

1. `sweepCurveFees()` in Pons phase 0 or `sweepPoolFees()` in phase 2 requests the launch's upstream fees. The owner/operator calls the distributor, which is the authorized Pons fee recipient. The wrappers only use the verified launch's curve or derived pool ID. They accept no arbitrary target, swap route or calldata.
2. Anyone can call `collectPonsFees()`. It calls only the immutable escrow's `claim()` or `claimToken(rewardAsset)` for **this contract's own credit**, and records the actual increase in its reward balance.

These wrappers request quote-only sweeps with zero conversion/buyback minima. Pons itself requires its upstream fee-sweep operator for internal token conversions or buybacks. A restricted Pons sweep reverts; the distributor does not bypass that restriction or silently count uncollected income. Existing escrow credits can still be collected. Sweeping and collection remain available while distribution proposals are paused.

Direct native transfers and exact ERC20 `fund(amount)` calls can also fund distributions. They are available cash, but are not included in `totalPonsCollected`. Gas is paid separately by transaction senders. Transferring an unrelated token does not create reward income, and there is no recovery function for unsupported tokens.

## Manual policy and timing

Percentages use basis points, with `10_000 = 100%`. The three percentages must sum to 10,000; the holder percentage must be positive. A 75% holder / 10% developer / 15% treasury policy is represented by `(7500, 1000, 1500)`. No financial percentage is hardcoded as a mandatory default.

The owner changes the complete policy through `setPolicy`. The interval is between 60 seconds and 30 days. The root review delay is between 15 minutes and 7 days. The minimum gross distribution amount is positive and expressed in the reward asset's smallest units. Developer and treasury recipients must be valid, nonzero addresses, and can be the same wallet.

Each proposal copies its wallets, budgets, policy version and activation time. Changing policy cannot redirect or recalculate an existing pending or active epoch. A new policy's interval controls when the next proposal may be published. An interval creates eligibility for a transaction; it does not execute a transaction automatically. The keeper must remain online, funded for gas and able to read the chain.

`setOperator` changes the publishing/push account. `setGuardian` appoints an account that can pause new proposals/activations and cancel pending epochs. Only the owner can unpause. Owner transfer requires `transferOwnership(nextOwner)` followed by `acceptOwnership()` from the nominated address. Guardian and operator roles do not automatically move with ownership; rotate them explicitly if needed.

## Funded epoch lifecycle

`proposeEpoch(root, snapshotBlock, snapshotBlockHash, manifestHash, totalEligibleWeight, grossIncome)` is restricted to the owner/operator. It requires an unpaused, bound deployment, a past nonzero snapshot block and hash, a nonzero public manifest digest, a nonzero root, enough unallocated cash, and the configured minimum/interval.

The EVM checks the supplied block hash when the snapshot is within the last 256 blocks. Older hashes cannot be checked by EVM `blockhash`; archival RPC verification and the manifest are necessary. Historical holder balances and exclusions always need offchain verification, regardless of snapshot age.

The proposal reserves the **entire gross income** immediately. Holder and developer budgets are floored by their configured percentages. The remainder, including split rounding, belongs to the declared treasury. Gross income and total eligible weight are bounded to `uint128`, making every reward multiplication safe within `uint256`.

After `readyAt`, anyone may call `activateEpoch(id)`. Activation is blocked while paused. It makes holder proofs usable and accrues the copied developer/treasury budgets to their original wallets. The owner/guardian can cancel only a proposed epoch, releasing its reserved cash. An active epoch cannot be cancelled, edited, swept, or expired by an administrator.

States in the ABI are `0 = missing`, `1 = proposed`, `2 = active`, `3 = cancelled`.

## Proof format and delivery

One leaf represents one eligible holder address with a positive historical token balance. The manifest builder must consolidate duplicate addresses, exclude the advertised infrastructure/blocked addresses, and recompute the total eligible weight from the actual included balances. No new minimum-holding rule may be silently substituted during publication.

The exact leaf is:

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
    chainId, distributorAddress, epochId, account, weight
))))
```

The TypeScript equivalent is `feeDistributionLeaf` in `src/lib/fee-distributor-contract.ts`. Each Merkle pair is sorted by its `bytes32` value before hashing. Weight uses raw token units, not a floating-point display balance. The manifest must preserve all information needed to reproduce the root and serve each holder's proof.

An entitlement equals `floor(holderBudget * weight / totalEligibleWeight)`. `claim(id, account, weight, proof)` is permissionless but always pays the proven account. `claimTo(id, weight, proof, receiver)` lets only that proven account redirect its own claim. Token transfers after the snapshot do not change that epoch's entitlement. A newly acquired token balance cannot claim an earlier owner's reward.

`distributeClaims(Claim[])` is an owner/operator push batch, bounded to 64 entries and 64 proof siblings per entry. Each claim runs in an isolated, gas-bounded self-call. A failing recipient, invalid proof or duplicate does not erase earlier successful claims or prevent later entries. A transaction with insufficient gas to attempt its complete batch reverts, so gas estimation cannot select a successful no-op or partial attempt. The keeper must use receipts and `hasClaimed`, not a submitted transaction or attempted batch size, to count payments.

Native delivery is capped at 100,000 gas. A recipient requiring more gas can use its own `claimTo` to receive at another compatible address. ERC20 delivery checks the exact reduction/increase in sender/recipient balances and rejects transfer-tax or false-return behavior. Failed transfers roll back before any paid total or claimed flag is recorded. Reentrancy is blocked, including token callbacks and native recipient callbacks.

Developer/treasury delivery uses `withdrawCashFor(account)`, which anyone may sponsor but which always pays that account. `withdrawCash(receiver)` can redirect only the caller's own pending amounts. Failed cash delivery leaves the full liability available for retry. Developer and treasury paid totals remain separate even if their wallets are the same.

## Accounting and trust limits

At every completed operation:

```text
reward balance = available income + total reserved
cash received  = reward balance + holder paid + developer paid + treasury paid
holder paid <= activated holder allocation
```

Pending epochs, unclaimed holder budgets, per-holder rounding dust and unpaid developer/treasury amounts stay reserved. Holder rounding dust is not recycled into later distributions. `totalPonsCollected` records only measured escrow collections; `totalHolderPaid` records only completed recipient transfers. Neither an advertised APR, trading volume, submitted transaction nor an unpaid allocation is a user payment.

**The root publisher is trusted.** A Merkle proof proves membership in its published tree; it does not prove that the tree contains every legitimate holder or that those balances match token storage. A dishonest owner/operator can publish a dishonest future allocation. The public manifest, independent recomputation, minimum delay and guardian cancellation provide detection/intervention mechanisms, not a cryptographic proof of historical balances. A dishonest root is still capped to its own reserved holder budget and cannot spend another epoch's funds.

The owner also controls future distribution splits and timing. There is no owner balance sweep or arbitrary-call escape hatch, but changing future policy is economically powerful and must remain visible. Previously allocated claims are preserved. Independent contract review, transparent manifests and a reliable keeper are required operational work before launch.

## Verification

Run `forge test --root contracts -v`. The fee suite covers both reward modes, the complete sweep/escrow/collection path, phase/recipient/asset checks, upstream conversion restrictions, policy changes, ownership, pause behavior, proof domains, duplicates, failed recipients, reentrancy, epoch budget isolation and 512 randomized split/weight cash reconciliations. The existing stock-vault tests run alongside it unchanged.

Run `node scripts/rewards-integration-test.mjs` for the complete local integration. It builds the contracts, starts its own localhost Anvil instance, sweeps mock Pons fees into escrow, collects actual test ETH, indexes real test-token events and historical balances, builds TypeScript Merkle proofs, activates a funded Solidity epoch, estimates gas and delivers a mixed-success holder batch, redirects the failed holder's own claim, and reconciles developer/treasury payments and rounding dust. It uses only local Anvil accounts and closes its test node afterward. `REWARDS_TEST_PORT` can override the dedicated default port 18547.

Run `forge build --root contracts --ast --force` to generate the artifact and AST used by deployment tooling; `--force` ensures a prior build without AST output is not reused. Review the artifact's immutable references when comparing deployed runtime bytecode. No test result means that a production deployment has been audited or that users have already received income.
