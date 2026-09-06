# Spreadline

A Stock Token market research workspace for Robinhood Chain, built with Next.js
and a Cloudflare Worker API. The application reads the official registry, issuer
prices, wallet balances and Uniswap V3 route quotes.

## Local development

Use Node.js 22.13 or later and npm.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open http://localhost:3000/app. Next.js runs on port 3000 and proxies the local
Worker API on port 8787. The default public RPC needs no credentials; a dedicated
endpoint can be configured in an ignored `.dev.vars` file using `.dev.vars.example`.

## Validation

```sh
npm run lint
npm run typecheck:worker
npm test
npm run build
```

Worker declarations are generated from the checked-in configuration. Build output,
local state, development notes and marketing exports are excluded from Git.

## Assets

Bundled fonts retain their own license in `public/fonts/font-license.txt`.
Third-party names and marks identify referenced assets and do not imply endorsement.
