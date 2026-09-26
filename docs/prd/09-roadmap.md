# 09 — Roadmap

Start: **Mon 2026-09-28**. Assumes 1–2 core developers. Dates are targets;
**phase gates are not optional**. Don't move on with a gate red.

## Phase 0 — Foundation (Week 1: 09-28 → 10-04)
- [x] `git init` Kryon-sol and push (github.com/SamyaDeb/kryon-sol)
- [x] Port `protocol-core` + `risk-engine` off Soroban (done, 25 tests)
- [x] `session.rs` session-aware risk (done)
- [x] Benchmark `mul_div` (I256) compute units in BPF; decide on keeping it or a u128 path (u64-limb path adopted, `05` §6)
- [x] `anchor init` equivalent: `programs/kryon-perps` builds for SBF
- [ ] Choose RPC (Helius/Triton), sign up for Pyth (API key), create a devnet USDC mint we control
- **Gate:** program builds; the crates compile to `sbf`; CU numbers written down

## Phase 1 — Core program (Weeks 2–5: 10-05 → 11-01)
- [x] Accounts: Exchange, Market, Collateral, UserAccount, OrderRecord (`05` §1)
- [x] deposit/withdraw (SPL + Token-2022 via `token_interface`), deposit caps, pause
- [x] set_delegate / revoke; order message encoder (Rust + TS) + **golden test**
- [x] `settle_fills` with Ed25519 introspection + full `validate_fill` table
- [x] position effects (open/increase/reduce/close), fees, OI
- [x] Pyth read → OracleSnapshot → guard; execution-deviation band
- [x] `post_session_calendar` (pulled forward from Phase 2 so markets are not always Closed)
- [x] Tests: each validate_fill rule, each ed25519 tampering case, conservation invariant
- **Gate:** a local-validator end-to-end run: two users, session keys, 1,000 random fills, conservation holds
  - ✅ Passed 2026-09-26 (`scripts/e2e-local.sh`): 1,000 fills in 65 s, median 158k CU (with reduce-only relief),
    solvent at 5 marks every 100 fills, strict equality when flat, USDC conserved to the
    base unit after full withdrawals. Not yet in CI (`11` L1).

## Phase 2 — Risk completeness (Weeks 5–8: 10-26 → 11-22)
- [x] Session calendar + `post_session_calendar`; closed mark EMA; margin ramp (+ `post_mark`, grace, reopen)
- [x] update_funding (premium-based, elapsed cap)
- [x] liquidate (partial, capped reward) → insurance → bad debt → ADL (position transfer; OI capped against the fund)
- [x] Insurance staking (shares, cooldown, retire on wipe)
- [ ] xStocks collateral: haircut, multiplier, extension allow-list
- [ ] Fuzzing (Trident / proptest) for the invariants in `05` §7
- **Gate:** a liquidation actually executes in tests **and** on devnet. On Stellar it never did (see `11`). Weekend replay backtest passes (`07` §7)

## Phase 3 — Off-chain stack (Weeks 6–10, overlapping: 11-02 → 12-06)
- [ ] Port matcher (queue + concurrent submitters, not settle-in-tick), reconciler
- [ ] Pyth pusher (own shard), session-calendar keeper, mark poster
- [ ] Indexer (Helius webhooks or Yellowstone gRPC → Postgres, slot cursor)
- [ ] Keepers: liquidator, funding, refill; monitor → **real webhook** + on-call
- [ ] Prisma schema port; delete the dead `Position` model
- **Gate:** load test ≥ 50 fills/s sustained for 30 min on devnet, from a
  cloud load generator, not a laptop

## Phase 4 — App & SDK (Weeks 8–11: 11-16 → 12-13)
- [ ] Port the trade terminal; wallet adapter + session-key onboarding (one approval, then popup-free)
- [ ] Session badge, band indicator, effective leverage, liquidation price from `risk-engine` WASM
- [ ] Deposit/withdraw with xStocks; portfolio; leaderboard
- [ ] Geofence + ToS + sanctions screening
- [ ] TS SDK + conformance vectors (reuse the KryonSDK structure); MM docs
- **Gate:** a new user goes from connecting a wallet to their first trade in under 60 s with one wallet approval

## Phase 5 — Devnet public beta (Weeks 12–15: 12-14 → 2027-01-10)
- [ ] Open to testers; faucet; mock xStocks
- [ ] Points (testnet season, no value), bug bounty (devnet scope)
- [ ] Parameter tuning from real weekend books
- **Gate:** 4 consecutive weekends with no bad debt and no stuck settlements

## Phase 6 — Audit (Weeks 13–18: 12-21 → 2027-01-31)
- [ ] Two independent audits (one Solana-specialist firm + one contest, e.g. on a competitive audit platform)
- [ ] Fix, re-review, publish the reports
- **Gate:** zero open critical/high findings

## Phase 7 — Mainnet guarded launch (Feb 2027)
- [ ] Squads v4 multisig (≥ 3/5) + 48 h time lock as upgrade authority and admin — **set up before the first deposit** (Stellar mainnet admin was never handed over)
- [ ] Deposit caps (e.g. $250k total for weeks 1–2, $2M for weeks 3–4), 5 markets
- [ ] Market-maker partners live; points Season 1 starts
- [ ] Mainnet bug bounty
- **Gate for lifting caps:** 30 days, no incidents, conservation checks green daily

## Phase 8 — Growth (Mar–Jun 2027)
- [ ] Portfolio margin + Basis Vault (D1)
- [ ] Commodities/FX markets; Pyth Pro extended hours (if the budget allows)
- [ ] Pre-listing markets (D5), first KRY pre-market
- [ ] TGE, once the `08` §A1 gates are met

## Budget sketch (first 6 months, USD, estimates)

| Item | Estimate |
|---|---|
| Audits (2) | 80k–200k |
| Pyth data (Core → Pro later) | 3k–30k |
| RPC (dedicated) | 3k–12k |
| Infra (DB, services, monitoring) | 3k–8k |
| Bug bounty reserve | 50k+ |
| Legal (entity, opinion, ToS, token) | 40k–150k |
| Insurance fund seed | 50k–250k |

Funding options: Solana Foundation / Colosseum hackathon and accelerator
tracks, ecosystem grants, pre-seed. Recheck current programs; the
`colosseum-copilot` skill can research these.
