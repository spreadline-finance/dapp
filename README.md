# Spreadline

A self-hostable workspace for researching Stock Tokens, comparing position sizes,
trading through Uniswap V3 and exploring Morpho lending on Robinhood Chain.

Spreadline combines live market data with explicit wallet review. The server reads
and simulates; your wallet signs and submits transactions. It never holds a private
key, and it does not run an automated trading bot.

## Features

- **Markets and trading:** issuer reference prices, corporate actions, pool quotes,
  exact-amount approvals and wallet-confirmed USDG / Stock Token swaps.
- **Position and exit planner:** compare 25%, 50% and 100% of a holding or USDG
  budget at one pinned block, including average prices and a price-deterioration
  threshold relative to the 25% quote.
- **Arbitrage research:** compare round-trip routes across supported V3 pools,
  inspect quote coverage and keep a local research journal.
- **Lending:** browse Morpho markets and V2 vaults, inspect variable rates, discover
  positions and prepare deposits or withdrawals for wallet review.
- **Portfolio:** inspect ETH, USDG and tracked Stock Token balances using a
  connected wallet or a public address.
- **Local demo wallets:** three preset portfolios for trying holdings and the
  planner without a browser wallet extension.
- **Installable PWA:** mobile navigation and an offline information screen. Wallet
  requests and market data are never replayed from an offline queue.

## Run locally

Requirements: **Node.js 22.13 or later**, npm, and internet access for live data.
The repository includes an `.nvmrc` for Node.js 22.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open **[localhost:3000/app](http://localhost:3000/app)**.
Next.js serves the frontend on port 3000 and proxies `/api/*` to the local
Cloudflare Worker on port 8787. D1 stores request budgets in `.wrangler/`.
Local development does not require a Cloudflare account or a funded wallet.

The public Robinhood RPC is configured by default. To use a dedicated endpoint:

```sh
cp .dev.vars.example .dev.vars
# Set ROBINHOOD_RPC_URL in .dev.vars.
```

`.dev.vars` and `.env*` are ignored. Keep provider credentials server-side; do not
prefix them with `NEXT_PUBLIC_`.

### Try a demo wallet

1. Run `npm run dev` and open **Connect wallet → Try a demo wallet**.
2. Choose **Diversified**, **Concentrated** or **Fractional**.
3. In Portfolio, select **Compare exit sizes** to load an exact holding into the
   planner. The planner also has **Use demo holding** and **Use demo budget**.

Holdings are fictional; market quotes remain live and need an available API.
Demo mode has no wallet address or signing provider, disables transaction execution,
and resets on reload. It does not simulate fills or lending positions.

Demo availability requires a development build and an exact loopback hostname:
`localhost`, `127.0.0.1` or `[::1]`. Presets are excluded from production bundles,
including production builds served on localhost. Edit quantities in
[`src/lib/demo-wallet-presets.ts`](src/lib/demo-wallet-presets.ts).

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the frontend and local Worker API |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run lint` | Check TypeScript, React and Next.js lint rules |
| `npm run types:worker` | Generate Worker binding and runtime declarations |
| `npm run typecheck:worker` | Regenerate declarations and check Worker types |
| `npm test` | Run the Node.js regression suite |
| `npm run build` | Build the static frontend and bundle the Worker |
| `npm start` | Serve the production build locally on port 3000 |

The build writes `out/`, `dist/client/` and `dist/server/index.js`. Generated output,
Worker declarations, local databases and development notes are excluded from Git.

## Architecture

```text
src/app/          Next.js routes, metadata and global styles
src/components/   Wallet, markets, planner, lending and research interfaces
src/lib/          Domain models, quote assessment and transaction validation
server/           Worker routing, upstream reads and protocol services
db/               Drizzle request-budget schema
drizzle/          Versioned D1 migrations
tests/            Validation, transaction, caching, planner and PWA regressions
scripts/          Local development, test and build runners
public/           Runtime artwork, fonts, asset logos and PWA resources
```

The frontend uses React, TanStack Query, Radix Dialog and viem. The API uses
Cloudflare Workers, D1, Zod and Drizzle. Token identity comes from the official
registry and chain-specific contracts, rather than ticker matches alone.

### API surface

All API routes are reads. The Worker exposes no signing or broadcast endpoint.

| Routes | Purpose |
| --- | --- |
| `/api/health`, `/api/network` | Service and chain status |
| `/api/catalog`, `/api/prices`, `/api/corporate-actions` | Issuer market data |
| `/api/pools`, `/api/quote`, `/api/swap-quote` | Pool discovery and route quotes |
| `/api/portfolio`, `/api/planner-position` | Address-specific balances |
| `/api/position-plan` | Independent quotes at three position sizes |
| `/api/trade-plan` | Balance, allowance and swap preparation |
| `/api/lending/markets`, `/api/lending/vaults`, `/api/lending/history` | Lending research |
| `/api/lending/positions`, `/api/lending/position`, `/api/lending/plan` | Position discovery and transaction preparation |

Inputs are validated before provider calls. Reads are bounded and rate-limited.
Cached public data retains its original timestamps; wallet reads and transaction
plans are excluded from public response caching. Provider failures remain visible.

## Execution and data limits

- The app targets **Robinhood Chain mainnet (4663)**. A connected real wallet can
  submit real transactions. Review the account, network, token and amount.
- Quotes compare USDG pairs across four Uniswap V3 fee tiers. They do not cover
  every venue or split route, and an observed output is not a guaranteed fill.
- The planner compares independent alternative sizes, not sequential trades.
  Quoted output includes pool fees and price impact; network and approval costs
  are separate. Incomplete or expired comparisons do not highlight a size.
- Issuer USD reference prices and pool prices denominated in USDG are different
  observations. Missing data is not replaced with fabricated market values.
- Transactions require explicit wallet confirmation. A receipt, rather than a
  local success message, establishes confirmation. This project has no keeper or
  automated arbitrage executor.
- Lending rates are variable. The interface distinguishes supply APY, liquidity,
  protocol warnings and unavailable observations.

This is an experimental implementation, not an audited trading system. Tests cover
validation, transaction encoding, mocked wallet flows and data handling. Funded
swaps and lending flows have not been verified end to end. Mobile installation and
wallet behavior also need testing on physical devices.

## Hosting

The project builds a static Next.js frontend and an ESM Cloudflare Worker. Local
development and production preview are supported by the included scripts.

For your own deployment, configure a D1 database and its migrations, the `ASSETS`
binding, and a server-side `ROBINHOOD_RPC_URL`. The database ID in `wrangler.jsonc`
is a local placeholder. Configure your own resources before deploying.

Set `NEXT_PUBLIC_SITE_URL` to your trusted public origin at build time for social
metadata; it defaults to localhost. Building or running the test suite does not
deploy the app. Existing private hosting configuration is not part of this repo.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.
Keep changes focused, include relevant validation, and preserve the distinction
between live observations, assumptions and simulated holdings.

## Asset notices

Third-party marks and fonts have separate ownership and licensing from the
application. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the bundled font
license and the logo source manifests. Referenced organizations do not endorse
this project.
