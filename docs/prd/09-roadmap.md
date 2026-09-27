# 09 — Roadmap

Start: **Mon 2026-09-28**. Assumes 1–2 core developers. Dates are targets;
**phase gates are not optional**. Don't move on with a gate red.

## Phase 0 — Foundation (Week 1: 09-28 → 10-04)
- [x] `git init` Kryon-sol and push (github.com/SamyaDeb/kryon-sol)
- [x] Port `protocol-core` + `risk-engine` off Soroban (done, 25 tests)
- [x] `session.rs` session-aware risk (done)
- [x] Benchmark `mul_div` (I256) compute units in BPF; decide on keeping it or a u128 path (u64-limb path adopted, `05` §6)
- [x] `anchor init` equivalent: `programs/kryon-perps` builds for SBF
- [x] RPC: public devnet endpoint for now (dedicated Helius/Triton before Phase 3 load test); Pyth API key not needed (free sponsored shard-0 feeds, `06` §8); devnet USDC mint `BL4DqDDg5uerF11E4PafA43Vj7MVfy25xy9wwyXeMCqd` (6 decimals, authority = deployer), 2026-09-27
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
    base unit after full withdrawals. In CI on every push since 2026-09-26 (`yarn e2e 200`,
    `.github/workflows/ci.yml`, `11` L1).

## Phase 2 — Risk completeness (Weeks 5–8: 10-26 → 11-22)
- [x] Session calendar + `post_session_calendar`; closed mark EMA; margin ramp (+ `post_mark`, grace, reopen)
- [x] update_funding (premium-based, elapsed cap)
- [x] liquidate (partial, capped reward) → insurance → bad debt → ADL (position transfer; OI capped against the fund)
- [x] Insurance staking (shares, cooldown, retire on wipe)
- [x] xStocks collateral: haircut, multiplier, extension allow-list (+ closed-market haircut)
- [x] Fuzzing (Trident / proptest) for the invariants in `05` §7 (proptest on the crates + a randomized LiteSVM harness in CI)
- [x] Weekend replay backtest (`yarn backtest`, `07` §7): all 10 tickers pass after mega-cap MM 6% → 7%
- **Gate:** a liquidation actually executes in tests **and** on devnet. On Stellar it never did (see `11`). Weekend replay backtest passes (`07` §7)
  - ✅ Part 1, local validator (2026-09-26, `yarn e2e`, in CI on every push): after the Phase 1 fills,
    the insurance fund is staked, a permissionless `update_funding` moves the indexes, and when a
    second market's 25 s session closes the Closed ×2 maintenance makes two leveraged accounts
    liquidatable: a keeper liquidates both by position transfer (~167k CU each). OI stays two-sided;
    conservation holds strictly once flat (vault + bad debt == balances + fees + fund, 2,223 wei of dust).
  - ✅ Part 2, devnet with Pyth's sponsored shard-0 feeds (2026-09-27, Helius RPC,
    `scripts/devnet-gate.sh` → `deployments/devnet.json`): program deployed at
    `2vgBHV763RtsBZGNpnuvbkGDKJdtt1DxP9tUDo4NZxUB`
    ([deploy](https://explorer.solana.com/tx/Sqvw5qJQjzKStmyRLurRNDYMuBCBmcFcWRKcWnLZQubmrRaNgMvd4qhkqg1EAATtgKYqd52yVFWTLCZgbicS21r?cluster=devnet)),
    a fill settled against the sponsored SOL/USD feed
    ([settle_fills](https://explorer.solana.com/tx/3Kh3NyCyWg9ePYHjhynDFT1KRbeitNpjWLuQU6Jt7DHjWRoEKTUgsCDpNS31VSfmpBGYgbFvv2Ab8JoE1uwcxY1g?cluster=devnet)),
    `update_funding` moved the index
    ([tx](https://explorer.solana.com/tx/4ooSrjMrrK1TWKss9N8CrrpJ7gCizPJFEevaq7Mmh9EWKz3PXtj3BcM3HRDAj7bmw8pJUHCsdv7vu3kHkfWxakFM?cluster=devnet)),
    and once the session closed a keeper liquidated both leveraged accounts
    ([1](https://explorer.solana.com/tx/3jmkMVr5EKuRBUvK2AkuMNSGnzjZyGTbZVF74boNUJug3XJKU4U2JsquFtQsAmM6eYiKhKVUPiw4vgWQvutEFNWT?cluster=devnet),
    [2](https://explorer.solana.com/tx/2CUgVhV5e6jw124KLzgCSi87ruZgcyB5aex48avqvr4V6MidzrHUcPHvDNDP1bzbQNF6DKYb1Ln22eGqC9ptTay?cluster=devnet)).
    The public devnet RPC timed out three times on the deploy step; a Helius
    URL (kept only in the gitignored `.env`) got through on the first try.
    `services/kit`'s L3 drift check (`assertDeploymentMatchesChain`) confirms
    the on-chain Exchange matches this file.
  - ✅ Backtest: all 10 tickers at 0‰ after mega-cap MM 6% → 7% (2026-09-26, `07` §7).

## Phase 3 — Off-chain stack (Weeks 6–10, overlapping: 11-02 → 12-06)
- [x] Shared service kit (`services/kit`, 2026-09-27): env validation at boot (L16), the deployments.json loader with the on-chain drift check (L3), Postgres client + retry, structured JSON logs, webhook alerter (L6)
- [x] Prisma schema port (`services/db`, 2026-09-27); delete the dead `Position` model (L13); local Postgres via docker compose; round-trips against a real Postgres in CI
- [x] Order intake API (`services/order-intake`, 2026-09-27): verifies the session-key Ed25519 signature over the 108-byte order message (`sdk`'s new `verifyEd25519`), checks the delegate is active on-chain for `(owner, sub_id)`, confirms the market is known and active, and stores the order
- [~] Port matcher (queue + concurrent submitters, not settle-in-tick), reconciler
  - [x] Matching engine + queueing (`services/matcher`, 2026-09-27): price-time
    priority ported from `reference/stellar/offchain/scripts/matcher-service.ts`
    (`lib/market/matcher.ts` in that tree turned out to be client-side order
    submission, not the matcher — noted here since the task description named
    the wrong file). One writer per market via a transaction-scoped Postgres
    advisory lock (`pg_try_advisory_xact_lock`, same connection as the reads/
    writes it guards — a plain `$queryRaw` lock + separate `$transaction`
    write would silently provide no exclusion under Prisma's connection
    pool). Self-trade prevention compares `(owner, subId)`, matching the
    on-chain `UserAccount` identity, not `owner` alone. Each match becomes one
    `TxJob` row (`kind: "settle_fill"`, structured `payload`, not settled
    in-tick — L4); `Order.queuedSize` reserves that fill's size so it can't be
    matched twice before settlement confirms. Found and fixed a real gap:
    order-intake validated `signerPubkey` but never persisted it, which would
    have silently blocked every order from ever settling (nothing could build
    its Ed25519 introspection instruction without it).
  - [ ] Settlement submitter: concurrent workers claiming `QUEUED` TxJobs
    (`SELECT ... FOR UPDATE SKIP LOCKED`), building `settle_fills` transactions
    (Ed25519 instructions + the program instruction, an address lookup table,
    dynamic priority fee capped by env). Not started yet — this is the rest of
    item d.
  - [ ] Reconciler (item e): confirm by signature/slot, retry or roll back
    idempotently — also the piece that decrements `queuedSize` on a failed/
    rolled-back job. Until it exists, a job that fails leaves `queuedSize`
    stuck reserved on its two orders (flagging this now rather than after
    the fact: worth building the reconciler next, before load-testing).
- [ ] Pyth pusher (own shard), session-calendar keeper, mark poster
- [ ] Indexer (Helius webhooks or Yellowstone gRPC → Postgres, slot cursor)
- [ ] Keepers: liquidator, funding, refill; monitor → **real webhook** + on-call
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
