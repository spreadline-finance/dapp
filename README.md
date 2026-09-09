# Spreadline

### Plan the position. Understand the exit.

![Spreadline — markets, trading and lending](public/og.png)

**A trading workspace for tokenized equities, built around the decisions that matter.**

Spreadline brings market research, position planning, wallet trading and lending
into one interface on Robinhood Chain. Its focus is practical: help traders
understand what a position could cost to enter, what it could return on exit, and
how those estimates change with size.

[Explore the code](src/) · [Try it locally](CONTRIBUTING.md#run-locally) · [Contribute](CONTRIBUTING.md)

## A price is only the beginning

Before acting on a position, a trader needs more than a displayed price:

- How much could I receive if I sell part of my holding?
- How does the average execution price change if I sell the full amount?
- Which supported pool offers the strongest quote for this size?
- How recent is the data, and what costs are still outside the estimate?

**Spreadline makes these questions the starting point of the product.**

## From a holding to a decision

The position and exit planner is the clearest expression of that idea.

Start with a Stock Token holding or a USDG budget. Compare **25%, 50% and 100%**
of that amount against supported pools at the same blockchain snapshot. Inspect
estimated proceeds, average prices and the largest tested size within your chosen
price-deterioration threshold relative to the 25% quote.

For example, a trader holding NVDA can compare a partial exit with a full exit
before choosing an amount. The comparison exposes the effect of size, along with
missing quotes and expiry. It does not place an order or guarantee a fill.

That workflow connects the rest of the workspace:

| Workspace | What it helps you do |
| --- | --- |
| **Markets** | Research issuer reference prices, corporate actions and pool liquidity. |
| **Position planner** | Compare entry budgets or exit sizes before committing capital. |
| **Trading** | Review live pool quotes and prepare a swap for confirmation in your wallet. |
| **Portfolio** | Inspect balances and bring an exact holding into the planner. |
| **Lending** | Explore Morpho markets and V2 vaults, inspect rates and manage positions. |
| **Arbitrage research** | Compare supported round-trip routes and record observations. |
| **Desk & earn** | Inspect live pools, follow a verified USDG strategy vault, and manage capital and reward claims once launched. |
| **Token rewards** | Track holdings, the 75% holder fee allocation and automatic wallet payouts scheduled every 15 minutes. |

The new [Desk & earn module](DESK.md) includes a locally tested atomic trading vault,
75/25 reward accounting, wallet actions and an operator runner. The default vault
is unlaunched: live research works, while deposits and earnings require a reviewed,
verified, funded deployment. No return is guaranteed.

The [Token rewards dashboard](REWARDS.md) reads public reports from a separately
hosted private keeper. The coin launches on Pons with a fee-receiving wallet;
75% of fees actually collected is allocated proportionally to eligible holders,
and 25% stays with the receiver. Payout runs are scheduled every 15 minutes and
require collected fees and sufficient gas. This dapp has no reward signing key,
keeper runtime, custom fee distributor, or holder-claim transactions. It shows
reported allocations separately from confirmed transfers. The fee wallet and
keeper control payment execution; this is not a contract-enforced claim system.

## Transparent by design

A useful trading tool should make its assumptions visible.

- **Your trading wallet stays in control.** This dapp backend holds no private keys. Your wallet
  signs and submits each approval or transaction.
- **Quotes carry context.** Source timestamps, expiry, coverage and unavailable
  data remain visible. Missing market data is never filled with invented prices.
- **Costs are explicit.** Pool quotes include pool fees and price impact. Network
  and approval costs are separate; a positive quoted surplus is not realized profit.
- **The implementation is inspectable.** Amount handling, route assessment and
  transaction checks live alongside the interface in this repository.

Local demo portfolios let contributors explore the product without connecting a
wallet. Their holdings are fictional, their market quotes are live, and transaction
execution is disabled. An installable web app brings the workspace to mobile.

## Where we want to take it

Our thesis is that the lasting value of a tokenized-equity interface lies in helping
people make and revisit position decisions. We want Spreadline to become a workspace
traders return to before entering, adjusting or exiting a position.

The next priority is **validating the planner with traders**: whether it answers a
real sizing question, fits their workflow and earns repeated use.

From that foundation, directions to explore include:

- **Position monitoring:** revisit a saved plan as liquidity and quotes change.
- **Execution analysis:** compare planned outcomes with confirmed transactions.
- **Broader coverage:** evaluate additional routes and venues with explicit coverage.
- **Professional workflows:** investigate portfolio tools and data integrations
  that active traders would value enough to pay for.

These are product directions to validate, not shipped features or established
revenue streams. The current implementation provides a working foundation for that
learning. Commercial demand and product-market fit remain to be established.

## Build with us

Spreadline is being developed in the open. We welcome traders who can challenge the
workflow, developers who care about financial software, and collaborators interested
in the tools around tokenized equities.

Try a demo portfolio, inspect the planner, or contribute a focused improvement.
Product feedback is especially useful when it describes a real decision and what
information was missing.

**[Get started and contribute →](CONTRIBUTING.md)**

Built with **Next.js, React, viem and Cloudflare Workers**, with integrations for
**Robinhood Chain, Uniswap V3 and Morpho**. These integrations do not imply partnership
or endorsement.

---

**Project stage:** experimental. Real-wallet paths target mainnet, but funded swap
and lending flows have not been verified end to end, and the system has not been
audited. Automated arbitrage execution is not implemented. See the
[execution limits](CONTRIBUTING.md#execution-and-data-limits) before using a real wallet.

**Licensing:** a project license has not yet been selected. Third-party fonts and
marks retain their own rights; see [asset notices](THIRD_PARTY_NOTICES.md).
