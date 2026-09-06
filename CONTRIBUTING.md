# Contributing to Spreadline

Start with the local setup in [README.md](README.md). Use the checked-in lockfile
with `npm ci`, and keep credentials in ignored local environment files.

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
