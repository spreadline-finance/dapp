# Pons creator fees → Spreadline coin holders

Spreadline combines a tokenized-equity trading workspace with a coin-holder reward system funded by the coin's collected Pons creator fees.

The holder reward system is separate from the USDG atomic-arbitrage depositor vault in [DESK.md](DESK.md). Owning the launched coin makes a wallet eligible for its future snapshots; depositing in the Desk vault is not required for coin-holder rewards. Distributions depend on actual collected fees, eligible balances, configured policy and an operating keeper. There is no guaranteed payout or APR.

## What is implemented

- A Solidity distributor that receives its own Pons escrow credits in ETH or USDG, reserves each funded distribution, and protects outstanding liabilities.
- Narrow Pons curve/pool sweep calls, restricted to the launched token and verified infrastructure; no arbitrary calls or owner balance sweep.
- Owner-controlled holder/developer/treasury basis points, minimum income, payment interval, review delay and payout wallets. Two-step ownership, operator rotation and an emergency guardian are included.
- An incremental holder index that checks historical transfers, supply, individual balances and block hashes. Burned tokens, locked liquidity and protocol inventory are excluded. Optional additional exclusions are public in the manifest.
- Deterministic Merkle roots, downloadable manifests and paginated proofs committed by hash onchain. Existing claims never expire; holders can claim without waiting for operator-sponsored delivery.
- A persistent keeper that collects fees, proposes distributions, publishes proofs, waits for activation and sponsors bounded holder batches and dev/treasury payments. Its transaction journal and daily gas budget survive restarts.
- The **Token rewards** view at `/app?view=rewards`, with live balances, distribution history, claim controls, launch configuration and owner administration.

## Pons economics verified on 9 September 2026

Sources: [official Pons V2 documentation](https://docs.ponsfamily.com/v2), the [official launch application](https://www.ponsfamily.com/launchpad/create), and onchain reads at Robinhood Chain block **58,536,959**. `src/lib/pons.ts` records the verified contract addresses and runtime hashes. Launch preparation re-reads the current terms instead of freezing these observations.

| Setting | Observed value | Who controls it |
| --- | --- | --- |
| Chain | Robinhood Chain, 4663 | Pons deployment |
| Launch fee | 0.0005 ETH, plus transaction gas | Pons; re-read before launch |
| Creator tax cap | 10% | Pons factory; re-read before launch |
| Creator tax | Chosen at launch, then immutable | Coin creator at launch |
| Base curve/hook fee | 1% in the active configuration | Pons configuration |
| Pons protocol share | 30% of the base fee | Snapshotted launch fee policy |
| Buybacks disabled | Creator receives 70% of base fee, plus creator tax | Buyback choice at launch |
| Buybacks enabled | Half of the remaining base fee goes to buybacks | Pons buyback policy |
| Pairing/reward asset | Native ETH or approved USDG | Chosen at launch, fixed for this distributor |
| Holder/dev/treasury split | Configurable; must total 100% | Distributor owner |

For illustration only: with a 1% creator tax and the observed 1% base fee, the total trading fee is 2%. With buybacks disabled, creator proceeds are approximately 1.7% of taxable quote volume before timing, execution and other Pons conditions; a 75% holder split allocates 75% of the proceeds actually collected. This is not 75% of trade volume or guaranteed investment profit. Gas is paid externally by transaction senders.

USDG pairing produces USDG creator fees directly; it does not require an ETH-to-USDG conversion in Spreadline. Pons token-side fee conversions and buyback legs can require Pons's own trusted sweep operator. Spreadline requests only permitted quote-side sweeps and reports blocked upstream fees as pending; it never treats unswept fees as user payments.

## Settings and accounting

The launch form provides editable draft values. Nothing becomes active just by saving/exporting a draft. `10,000` basis points means 100%; `7,500 / 500 / 2,000` means 75% holders, 5% developer, 20% treasury.

The distribution interval is between 60 seconds and 30 days. The independent review delay is between 15 minutes and 7 days. An eligible interval still requires sufficient collected income and a keeper transaction. Developer and treasury budgets are copied into each epoch at proposal; changing a wallet later cannot redirect existing allocations.

For a holder with snapshot balance `b` and total eligible balance `B`:

```text
holder budget = floor(collected distribution income × holder basis points / 10,000)
holder entitlement = floor(holder budget × b / B)
cash in distributor = unallocated income + reserved liabilities
```

Integer rounding dust remains reserved. Paid totals advance only after successful transfers. Donations can fund distributions, but are not included in the Pons creator-fee collection counter. Failed recipients do not block other recipients; failed claims remain payable. Wallets unable to receive ETH can redirect only their own entitlement with `claimTo`. The owner cannot cancel active claims.

The publisher remains trusted to propose correct historical balances and exclusions. The keeper verifies its snapshot and reconstructs the complete manifest, but the contract itself cannot prove historical ERC20 balances from a Merkle root. Public proofs, the review delay and guardian cancellation make that trust inspectable; they do not remove it. See [the contract specification](contracts/FEE_DISTRIBUTOR.md) for the full role and accounting model.

## Launch sequence

1. Open **Token rewards → Launch setup**. Enter the final token name/ticker, public image URL, description, links, pairing currency, creator tax, owner/operator/dev/treasury wallets, and distribution settings. Export the draft JSON. An optional guardian can pause/cancel proposals. The draft contains no private key.
2. Run `npm run test:contracts`, `npm test`, `npm run typecheck:rewards`, and `npm run rewards:launch -- --help`. Build the reviewed contract with `forge build --root contracts --ast --force`; the AST is required to patch and verify every immutable occurrence in the deployed runtime.
3. Use the launch runner to prepare a plan from the exported draft. It verifies live Pons terms, predicts the distributor deployment, patches compiled immutable references for runtime verification and prepares staged transactions. Review the final metadata, immutable creator tax, currency, wallets and spending caps before enabling any execution.
4. Deploy the distributor with an unbound holder token. Launch on Pons with **the distributor itself as creatorFeeRecipient**. Bind the resulting token once. Configure the guardian if desired. The final activation stage unpauses distributions after checking deployment settings. Each stage is separately simulated and confirmed; resume against the actual deployed address after an interruption.
5. Copy the verified distributor address, runtime hash, distributor deployment block and token creation block from the launch artifacts into the Worker and keeper configuration. The same coin pairing asset must match the distributor's immutable reward asset.
6. Publish the API/proof storage and start the funded keeper. Verify the first real receipt from fee collection through an activated distribution and completed holder/dev/treasury transfers.

Never send a seed phrase to a launch site or put a signing key into browser configuration. The public frontend uses the connected wallet for claims and administration. The optional launch/operator CLI keys belong in a local/server secret manager and are used only with explicit execution flags.

### Launch commands and recovery

The exported draft uses **raw token units** for `minimumIncome`: `300000000` represents 300 USDG; `1000000000000000` represents 0.001 ETH. Basis points and seconds are integers. This workflow requires `developerBuy: "0"`; it does not silently spend an opening allocation.

```sh
# Prepare all unsigned stages using current Pons terms and a read-only CREATE2 simulation.
npm run rewards:launch -- --draft /secure/path/launch-draft.json \
  --out .wrangler/rewards/launch-plan.json

# After reviewing the plan, load REWARDS_OWNER_KEY through your secret manager.
# Set both caps to the ETH amounts you authorize; no cap is assumed for execution.
npm run rewards:launch -- --plan .wrangler/rewards/launch-plan.json \
  --execute --stage deploy \
  --max-launch-fee "$PONS_LAUNCH_FEE_CAP_ETH" --max-gas-fee "$LAUNCH_STAGE_GAS_CAP_ETH"
```

Run the same execution command with `--stage launch`, then `bind`, optional `guardian`, and finally `activate`. The plan lists the required stages. Each invocation sends at most one new transaction and waits for 12 confirmations and a matching canonical block hash. It verifies exact compiled runtime, constructor settings, owner, policy, nonce and stage calldata before signing. The fee cap applies to Pons' native ETH launch charge; the gas cap is a separate maximum for that invocation. No key is read by plan preparation, refresh or receipt recovery.

The runner saves the exact signed transaction and hash durably before broadcast. If submission or waiting is interrupted, rerun the same explicit execution command: a known hash is confirmed, and an unknown hash can only rebroadcast the identical signed bytes under the supplied budgets. It never silently creates a replacement nonce. Keep the plan on persistent private storage until launch completes.

```sh
# Record a transaction already sent, without signing or broadcasting.
npm run rewards:launch -- --plan .wrangler/rewards/launch-plan.json \
  --stage launch --recover-tx 0xYOUR_CONFIRMED_TRANSACTION_HASH

# Refresh unsigned remaining stages after an unrelated owner transaction or changed Pons terms.
# Completed receipts, token identity after launch, and deployment configuration are preserved.
npm run rewards:launch -- --plan .wrangler/rewards/launch-plan.json --refresh-plan
```

Resolve any saved pending transaction before refreshing. A changed local contract build or a reorganized receipt stops the workflow for review. The adjacent `launch-plan.json.configuration.json` supplies `REWARDS_DISTRIBUTOR_ADDRESS`, `REWARDS_DISTRIBUTOR_CODE_HASH`, `REWARDS_DEPLOY_BLOCK` and `REWARDS_TOKEN_DEPLOY_BLOCK` as their receipts become available. `--distributor 0x…` can prepare a new launch with an existing verified, still-unbound distributor; use `--refresh-plan` for normal continuation so its prior deployment record is retained.

## API and proof storage

The Worker uses `REWARDS_PROOFS`, an R2 bucket, alongside the existing D1 request-budget database. Create the bucket once in the intended Cloudflare account:

```sh
npx wrangler r2 bucket create spreadline-reward-proofs
```

Keep the R2 binding and the three `REWARDS_*` Worker variables from `wrangler.jsonc` in the production configuration. Keep `ROBINHOOD_RPC_URL` in the host's configuration, preferably using a provider capable of historical block reads. Apply the existing D1 migrations before serving API requests. No new D1 reward ledger is needed; financial truth comes from the contract.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/rewards?address=…&before=…` | Verified current totals and a page of 20 distributions/holder claims. `before` is an optional exclusive epoch cursor. |
| `GET /api/rewards/launch?address=…` | Current verified Pons launch terms and wallet launch eligibility. |
| `GET /api/rewards/manifest?epoch=…` | Onchain-committed manifest and ordered proof-page hashes. |
| `GET /api/rewards/manifest?epoch=…&page=0x…` | A committed page of up to 256 holder proofs. |
| `POST` to the manifest/page endpoint | Publish the exact matching JSON document. |

Proof publication is permissionless and content-addressed. An upload must match the deployed epoch's exact manifest hash, chain/distributor/token identity, snapshot, budget and root. Each proof page must match its committed hash, address range and every Merkle proof. Arbitrary data, modified claims and cancelled epochs are rejected. A replay stores identical data, so the uploader needs no backend signing secret. Bodies are bounded to 2 MB and requests are rate-limited. Missing proof pages are shown as unavailable, never as zero earned income.

## Keeper operation

Copy [the environment example](.env.rewards.example) into a secret environment file. Fill in the launch output, HTTPS API origin, dedicated operator key and **your chosen positive daily ETH gas budget**. Keep the state directory on persistent storage. The operator must match the owner or operator onchain and needs ETH for gas; it cannot spend someone else's wallet funds.

```sh
# Read-only readiness check; does not sign or publish.
npm run rewards:operator

# One bounded execution cycle.
npm run rewards:operator -- --execute

# Continuous fee collection and distributions, waking every 30 seconds.
npm run rewards:operator -- --execute --watch
```

The default snapshot/receipt confirmation depth is 24 blocks; the minimum is 12. This is a configurable confirmation policy, not a claim of L1 economic finality. A reorganization or inconsistent indexed balance stops new proposals for review. The keeper checks every positive holder balance against historical token storage before committing its checkpoint.

Each signed transaction is journaled to disk before broadcast. After a restart it rebroadcasts the same bytes/hash and waits for canonical confirmations, rather than issuing a replacement payout. The worst-case gas cost is reserved in a persistent daily budget and reconciled with the confirmed receipt. Use one keeper and a dedicated signing account; an untracked pending nonce stops new submissions.

Holder transfers are batched in groups of 16, with up to four batches per cycle by default. After three onchain skipped transfers for an entitlement, automated retries stop and the holder can claim directly or redirect their own claim. Minimum automatic-payout thresholds never remove a user's contract entitlement. Dev/treasury failures retain their credits and are retried. Keep the operator online and replenish its external ETH gas balance as needed.

For a Linux service, compile the operator once through `npm run rewards:operator -- --help`, install [the service template](deploy/spreadline-rewards.service), and provide `/etc/spreadline/rewards.env` with mode `0600` readable by the service account. Set the correct repository and Node paths before enabling it. The template uses `/var/lib/spreadline-rewards` for durable state. Logs are available through `journalctl -u spreadline-rewards`.

A [Dockerfile](deploy/rewards-operator.Dockerfile) is also provided:

```sh
docker build -f deploy/rewards-operator.Dockerfile -t spreadline-rewards .
docker run --name spreadline-rewards --restart unless-stopped \
  --env-file /secure/path/rewards.env \
  -v spreadline-rewards-state:/var/lib/spreadline-rewards spreadline-rewards
```

Do not run the systemd service and container for the same signer simultaneously. Back up the persistent state and public manifest artifacts. Monitor `cycle-needs-attention`, `pons-sweep-pending`, missing proofs and failed transfer logs; an unavailable upstream sweeper or exhausted gas budget requires operational attention.

## Verification and activation status

Run the repository tests, `npm run test:contracts`, `npm run test:rewards:integration`, `npm run lint`, both Worker/operator typechecks and `npm run build`. The tests exercise funded native/ERC20 distributions, partial batch failures, proof tampering/replay, historical indexing, owner changes and reserved-budget accounting. The integration command starts its own local Anvil node and verifies the TypeScript index/Merkle output against real Solidity calls, productive gas estimation, a failed recipient's redirected claim and exact cash reconciliation. It uses local test ETH only. CI installs the tested Foundry version and runs these checks.

The default repository configuration is deliberately **unlaunched**: it has no selected token, owner/dev/treasury wallet or funded production distributor. Software tests do not establish that a production contract is audited, that Pons has generated fees for this coin, or that users have already been paid. The launch requires real metadata, public wallet choices, a reviewed deployment, a funded signer and an operating keeper.
