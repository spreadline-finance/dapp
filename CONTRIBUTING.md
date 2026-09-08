# Contributing to Spreadline

Help build a clearer trading experience for tokenized equities. Contributions to
position planning, market data, wallet safety and product usability are welcome.

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
metadata; it defaults to `https://spredline.vercel.app`. Production builds reject
localhost origins. Production pages allow indexing; development and Vercel preview
builds retain `noindex, nofollow`. Building or running the test suite does not
deploy the app. Existing private hosting configuration is not part of this repo.


## Changes and pull requests

- Keep each change focused on a concrete problem. For larger work, explain the
  proposed behavior in an issue before implementing it.
- Describe what changes for a user and how you verified it. Include screenshots
  for visible interface changes when useful.
- Add regression tests for changes to monetary amounts, transaction validation,
  caching, wallet transitions or protocol assumptions.
- Keep exact token quantities as decimal strings or integer base units. Do not
  use floating-point arithmetic for transaction amounts.
- Preserve account, chain, allowance, expiry, simulation and receipt checks.
  Demo holdings must never become a signing identity or executable transaction.
- Show missing or stale data explicitly. Do not add fabricated market fallbacks.
- Keep source and required assets in Git. Research exports, marketing documents,
  local agent configuration, generated files and credentials belong outside it.
- Preserve asset license notices and document the source of new third-party assets.

Before submitting a pull request, run:

```sh
npm run lint
npm run typecheck:worker
npm test
npm run build
```

Use short, descriptive commit messages, for example
`fix(planner): reject expired size comparisons`. Group related code and tests;
separate unrelated changes so reviewers can follow them.

The automated suite uses mock providers and does not require signing or spending
funds. A passing suite is not evidence of a successful funded transaction. Describe
manual protocol or device testing separately, including anything still unverified.

Never attach private keys, seed phrases, provider credentials or private wallet
logs to issues or pull requests.
