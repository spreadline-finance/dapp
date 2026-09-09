# Token rewards dashboard

The Pons-launched coin sends creator fees to a dedicated fee-receiving wallet. A separately hosted private keeper tracks eligible token holdings and schedules proportional payouts every **15 minutes**. **75% of collected creator fees goes to holders; 25% remains with the fee receiver.** Gas and pending holder allocations must remain funded before payment execution.

The fee receiver's token holdings participate in the 75% holder pool, in addition to its separate 25% developer share. Holdings are measured at confirmed snapshots; small payments accumulate until the private service's minimum payout is reached.

This repository contains only the public dashboard and its read-only report adapter. It contains no coin reward-distributor contract, reward signing key, payout runner, token-launch transaction flow, or claim endpoint. The separate Desk vault remains its own product and is not used for coin-holder fee payouts.

## What holders see

- The coin and fee wallet, with explorer links.
- The fixed 75% holder / 25% fee-receiver split and 15-minute schedule.
- Fees collected, holder allocations, completed payouts and allocations awaiting payment.
- Their current token balance, eligible share at the reported snapshot, received rewards and pending payouts.
- Distribution history, payment receipts and the report's update time.

Payouts are automatic wallet transfers. Connecting a wallet identifies the holder for reporting; it does not grant approvals, move tokens, or request a reward claim transaction. Pending allocations are the keeper's accounting records, not enforceable onchain claims. Funds remain controlled by the fee wallet. A scheduled run still requires collected fees, a working keeper/RPC and sufficient gas.

## Launch routing

On the [official Pons launch page](https://www.ponsfamily.com/launchpad/create), set **Creator wallet** to the dedicated fee-receiving wallet. Leave Pons **Holder fee sharing** off: that option installs Pons' own distributor and would change the intended fee route. Choose the creator tax and pairing asset on Pons. The holder split applies to creator fees actually collected, after Pons' platform rules, not to all trade volume.

The public dapp does not configure, launch or operate this wallet. The private keeper must check the launched token's recorded creator fee recipient and asset before collecting or paying anything.

## Connect the report service

Set the server-side `REWARDS_REPORT_URL` to the private keeper's **public read-only report endpoint**, such as `https://rewards.example.com/v1/rewards`. For local development, `http://127.0.0.1:8791/v1/rewards` is permitted. Leave it empty until the service and token are configured; the dashboard then displays an honest setup-pending state with no invented earnings.

The dapp serves `GET /api/rewards`, optionally with `address=0x…` and a `before` distribution cursor. The adapter forwards only the validated holder address and cursor, validates report version/network, the 75/25 policy and accounting, limits response size/time and returns a sanitized response. Wallet-specific responses are not shared through a public cache. The response is labeled as a service report; it is not described as independently verified onchain state.

No payment key, seed phrase, operator environment file, signing journal or keeper source belongs in this repository or its frontend build. The dapp has no write API for payouts. The separately managed keeper has no GitHub remote and must not be copied into this public repository.

## Verification

Run `npm test`, `npm run lint`, `npm run typecheck:worker`, `npx tsc --noEmit` and `npm run build` for the dashboard and report adapter. `npm run test:contracts` covers the separate Desk vault only. Keeper accounting, restart recovery and local transaction tests are maintained in the private service, not this dapp's CI.

Passing tests does not guarantee loss-free operation. The wallet custodian can spend its funds, and a signing-key compromise, lost accounting state or unavailable provider can interrupt or misdirect payouts. Keep the wallet dedicated, its secret off public source control, and its durable state backed up. No token address, live private key or production report endpoint is assumed by this repository.
