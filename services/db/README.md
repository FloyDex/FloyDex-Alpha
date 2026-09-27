# @kryon/db

Prisma schema and generated client for the off-chain stack (matcher, indexer,
keepers, settlement queue, leaderboard/portfolio projections). Ported from
`reference/stellar/offchain/prisma`; see the schema's own header comment and
`docs/prd/04-migration-map.md` §2 for what changed and why.

## Local setup

```bash
docker compose up -d          # postgres:16 on localhost:5433
export DATABASE_URL=postgresql://kryon:kryon@localhost:5433/kryon
export DIRECT_URL=$DATABASE_URL
yarn db:generate
yarn db:migrate:dev           # first run: creates the schema
```

Put those two exports in a gitignored `.env` (`.gitignore` already covers
`.env*`) rather than your shell history if you'll be running this often.

## Scripts

- `yarn db:generate` — regenerate the Prisma client after a schema change
- `yarn db:migrate:dev` — create and apply a new migration locally
- `yarn db:migrate:deploy` — apply pending migrations (CI, production) — the
  only sanctioned way to change a deployed schema; never run ad-hoc SQL
  against a shared database (the Stellar side re-baselined a migration once
  from exactly that)
- `yarn test` — round-trips the schema against `DATABASE_URL` (skips with a
  clear message if unset); CI always sets it via a `postgres:16` service
  container

## Amount scales

All monetary/size fields are `String` (never `Float`), so fixed-point values
round-trip exactly:

- Order/fill size and price: `1e9`, matching the signed order-message wire
  format (`sdk/src/order.ts`).
- Funding indexes and oracle price/confidence: `1e18`, matching
  `protocol_core::PRECISION`.
- Everything settlement-asset (collateral, PnL, fees, deposits/withdrawals,
  portfolio): `1e6`, native USDC decimals.
