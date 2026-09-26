# 11 — Lessons from Kryon on Stellar (don't repeat these)

Each item cost real time or money on Stellar. Each has a test or gate in the
Solana plan. Details are in `reference/stellar/audits/` and
`reference/stellar/docs/`.

| # | What happened on Stellar | Rule for Kryon-sol |
|---|---|---|
| L1 | The matcher called `settle_fill_signed`, **a function that didn't exist** on-chain. Every fill rolled back and positions never updated | An end-to-end test on a local validator runs in CI for every PR: sign → match → settle → position visible |
| L2 | Settlement failed deep in the engine with `StaleOracle` because the **USDC collateral feed was missing**. Zero trades settled on testnet for weeks | Every collateral and market feed is in a health check; the deploy script refuses to finish if any feed is stale |
| L3 | **Two contract sets live at once** (v2/v3 split-brain); deposits landed in a vault the matcher didn't settle against | A single `deployment.json` is the source of truth; services refuse to start if on-chain `Exchange` doesn't match it |
| L4 | Settlement happened **inside the 1 s matcher tick**, so the ceiling was ~12–13 fills/min | Matching and submission are separate: a queue plus concurrent submitters |
| L5 | **Liquidation and funding never executed** on testnet (0 KeeperAction, 0 FundingUpdate rows) | Phase 2 gate: a liquidation and a funding update happen on devnet before the audit |
| L6 | Mainnet was **silent for weeks** (Neon 402 quota); the monitor had no webhook | Alerts must reach a phone; an external heartbeat; DB quota alarms |
| L7 | **Admin never handed to governance** on mainnet; the deployer keypair still controls it | Squads multisig + time lock before the first deposit (roadmap gate) |
| L8 | The OI-imbalance funding formula was **structurally always zero** | Premium-based funding (already ported) + a test that funding is non-zero for a rich perp |
| L9 | Partial liquidation **over-liquidated** (used max instead of min) | Ported, with its test (`partial_liquidation_does_not_over_liquidate`). The step size itself under-shot by ~10x (it closed notional equal to the shortfall), fixed 2026-09-26 (`05` §2) |
| L10 | Isolated margin **promised containment the ledger didn't provide** (KRY-Q5) | Isolated mode is off until a real per-position margin ledger exists |
| L11 | The insurance cap was checked per market against one shared fund (Q11) | Keep `max_total_oi_policy_bps` aggregate check |
| L12 | ADL could run with no bad debt (Q4) | ADL requires `bad_debt > 0` and a profitable target |
| L13 | The `Position` DB table was **dead code** that people kept trying to "fix" | Delete it in the port; positions come from chain or indexer events only |
| L14 | The load-test keystore was treated as writable and truncated funded wallets; minted keys weren't persisted | Test keys are persisted before any chain call; keystores are read-only; key files never go in git |
| L15 | A laptop load generator saturated before the venue did | Load tests run from a cloud box |
| L16 | `rateLimit()` failed closed in production without Upstash, rejecting every order | Every env var is checked at boot with a clear error (reuse `secrets-check.ts`) |
| L17 | A hand-rolled price keeper (3-CEX median) was the oracle | Pyth is the oracle; the CEX median is only an alarm |
| L18 | The canonical message had to byte-match between TS and Rust; the golden test caught drift | Keep golden vectors (`05` §4) in both languages |
