# Desk & earn

Open `/app?view=desk` to use the desk. It combines live Uniswap V3 pool observations, recorded market history, a USDG vault, wallet deposits and withdrawals, accrued reward claims, and confirmed contract activity. It uses Spreadline's existing Robinhood Chain assets and routes.

The vault is **implemented and locally tested, but unlaunched and unaudited**. The default configuration deliberately has no vault address. Live pool observations work immediately; money figures remain unavailable until a specific deployed contract passes verification. No deposits, operator trades, or payouts were made while implementing this feature.

## How users earn

1. A user deposits USDG through their own wallet and receives nontransferable vault shares.
2. The operator buys an allowlisted stock in one V3 fee tier and sells it in another in a single transaction. The contract requires the final USDG balance to exceed the starting balance by a minimum surplus. Both legs revert together if this condition fails.
3. Of the completed trade's USDG surplus, 75% accrues as claimable rewards to current shareholders and 25% stays in capital backing their shares.
4. Each user can claim earned USDG or redeem their shares. Withdrawing capital preserves already earned rewards. New deposits do not receive past rewards.

Deposits are capital, not revenue. Allocated rewards are liabilities, not available trading capital. Claims are counted as paid only after a successful onchain transaction. Pool spot spreads are observations, not executable returns. Operator gas is paid externally and is not subtracted from the vault's reported trading surplus. The operator runner requires an estimated cost floor before it will submit a trade, but the operator still needs its own ETH operating budget; there is no gas reimbursement from the vault.

The strategy adapts the trading-surplus-to-holder mechanism to Spreadline. It does not implement Arbitrage Ape's token launch, creator-fee income, or long-lived concentrated LP inventory. It has no fixed APY. Profitable routes may be scarce or absent. See [contract accounting and limitations](contracts/README.md).

## Run and verify locally

```sh
npm install
npm run db:migrate:local
npm run dev
```

Then open `http://localhost:3000/app?view=desk`. A wallet connection is optional for market research. Demo wallets cannot submit vault transactions.

```sh
npm test
npm run test:contracts
npm run lint
npm run typecheck:worker
npm run typecheck:desk
npm run build
npm run desk:contracts
```

Foundry is required for the contract suite. The first run downloads Solidity 0.8.26. Tests use mock tokens and a router on a local EVM; funded mainnet execution has not been verified.

## Data and recorder

| Endpoint | Data |
| --- | --- |
| `GET /api/desk` | Verified vault totals and bounded recent contract events |
| `GET /api/desk?address=0x…` | Same snapshot plus that wallet's shares, redeemable assets, claims, balance and allowance; never publicly cached |
| `GET /api/desk/pools?symbol=NVDA` | Actual pool prices, fee tiers, active liquidity and comparison with a fresh issuer reference |
| `GET /api/desk/history?symbol=NVDA` | Persisted observations, with original source times and blocks |

A five-minute Cloudflare scheduled trigger samples one tracked asset and the configured vault. Eight assets rotate in forty minutes; this history is not a tick-level market feed. The open pool board separately refreshes every fifteen seconds, subject to upstream limits. D1 keeps thirty days, with bounded cleanup. No cron handler signs trades or holds an operator key.

Apply `drizzle/0002_desk_observations.sql` through the existing D1 migration workflow before deploying the Worker. For local recorder testing, start Wrangler with `--test-scheduled` and request `/cdn-cgi/local/scheduled?format=json` on its local port, following the [Cloudflare scheduled-trigger test workflow](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally). Without samples, history shows an honest empty state.

## Connect a deployment

The contract constructor and verification requirements are in [contracts/README.md](contracts/README.md). Execution starts paused. The admin has no principal withdrawal or arbitrary-call function, but controls the operator, allowed stocks and trade limits.

After contract review and a deliberately small funded validation cycle on the intended network, configure these Worker variables using the exact approved deployment:

| Variable | Value |
| --- | --- |
| `DESK_VAULT_ADDRESS` | Deployed SpreadlineVault address |
| `DESK_VAULT_CODE_HASH` | Keccak hash of the actual deployed runtime, after comparing it to the compiled artifact with its exact immutable values |
| `DESK_VAULT_DEPLOY_BLOCK` | Actual deployment block number |
| `ROBINHOOD_RPC_URL` | Robinhood Chain RPC, preferably a dedicated provider |

An address or plausible getter values alone are insufficient. The backend checks chain 4663, recent block time, runtime hash, settlement, router, USDG decimals and reward allocation before enabling wallet preparation. The hash must come from a deployment whose artifact has been checked; copying an arbitrary contract's hash would defeat that control. Owner and operator access should use deliberately chosen signing arrangements. Frontend or Worker deployment does not deploy the contract or create profitable opportunities.

## Operator runner

```sh
npm run desk:operator -- --help
npm run desk:operator
npm run desk:operator -- --watch
```

The default invocation only reads and simulates. `--watch` repeats read-only scans every thirty seconds with a fresh RPC client. It reports unavailable routes and negative surpluses without creating earnings entries. Contract simulation uses the same deployment identity configuration as the Worker.

For cost checks, provide a current conservative `DESK_ETH_PRICE_USDG` and ISO `DESK_PRICE_TIMESTAMP` in the operator environment. Prices expire after five minutes. `DESK_SIZE_USDG` defaults to 100, `DESK_SYMBOL` to NVDA, and `DESK_MIN_NET_USDG` to 1. This supplied ETH/USDG estimate is not an oracle; a poor estimate can misprice gas. Gas estimates include a 20% gas-limit buffer and the current fee cap. The contract minimum surplus is the greater of its policy floor and that buffered estimated cost plus the requested minimum.

An explicitly invoked `--execute` signs **one** qualified trade using `DESK_OPERATOR_KEY` from the operator secret environment. It validates the signing account against the contract operator, simulates the final call, rejects expired inputs, and waits for a receipt. Execution and `--watch` cannot be combined. Never place that key in source, frontend variables, Worker variables, or shell arguments. A successful simulation is not a guarantee of inclusion or profit; failed submitted transactions can still cost gas.

## Wallet lifecycle

Every action gets a fresh wallet-specific snapshot, verifies account/network, simulates and estimates gas, and presents a thirty-second preview. Approval/reset and deposit are separate actions. Deposits and withdrawals enforce a minimum output within 0.1% of the preview. The send path revalidates calldata, destination, account, chain and simulation. Submitted transactions remain pending until a matching receipt arrives; recent receipts survive reloads in browser storage. Claims are user initiated, so allocated rewards and actual payouts remain visibly separate.
