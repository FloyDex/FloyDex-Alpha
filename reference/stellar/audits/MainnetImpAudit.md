# Kryon — Mainnet Implementation Audit & Roadmap

> **Purpose:** the definitive checklist of what must be built/changed before Kryon
> (a Soroban perpetual-futures DEX) can safely hold real funds on Stellar mainnet.
> Hand this file to Claude and implement items **in priority order (P0 → P3)**.
> Each item lists: **What · Why · Where · Acceptance criteria · Est.**

**Status as of 2026-06-06 (testnet):** Fully wired and working end-to-end.
Auto-settlement (`settle_fill_signed`) verified with a live cross-wallet fill.
All ~104 contract tests pass; frontend/backend/DB/contracts are consistent.
**This is a solid testnet MVP. It is NOT mainnet-ready.** The gaps below are
security, decentralization, infrastructure, and economic-validation — not code wiring.

Current testnet deployment (for reference):
- vault `CAULDUKSV4TRBCCFARMCS2D6SY2MJ4GDYUD4YNWTBKRY6WJGWA3HLAJ4`
- engine `CDGU5MYLXY6N3ABCOTFLL665B7UNIHSBYDDAL22A2KREGLDOHODCJEG5`
- order-gateway `CD77MHYJVQOSD467OSMSBJQSVOYPGONPOQBCJEW7R32UDMF23MBFNM6H`
- oracle-adapter `CARSV4BT3II5QONUAOP4D363OUNTTSSZCXSKNNXKZCBJM7Z6UXSNZ3LP`
- governance `CCRI6YJYXHFTGALTDPYRNFSDFWMZRVSJ6WNC3NV5ECE3E7DG4SZ3TBQ5` (deployed, **NOT** admin)
- **admin of all contracts = a single EOA `GA3SSO6D...` which is also the oracle key and the dev wallet** ← the core problem to fix

---

## P0 — Hard blockers (do not launch without these)

### P0.1 — Independent third-party security audit
- **What:** Engage a Soroban-specialist audit firm (OtterSec, Certora, Veridise, Runtime Verification) for a full review of all contracts in `kryon-protocol/contracts/*` and `kryon-protocol/crates/*`. Include an economic/mechanism audit of funding, liquidation, and insurance math (`crates/risk-engine`).
- **Why:** Leveraged derivatives holding user funds. Internal review (this repo's `AUDIT_REPORT.md` / `FINAL_AUDIT_REPORT.md`) is not a substitute. This is non-negotiable.
- **Where:** whole `kryon-protocol/`. Prepare an audit package (`kryon-protocol/infra/audit/build-audit-package.sh` already exists — verify it's current).
- **Acceptance:** Audit report received; all Critical/High findings remediated and re-reviewed; report published.
- **Est.:** 4–8 weeks external + remediation time.

### P0.2 — Decentralize admin: wire governance + timelock as the contract admin
- **What:** Make `perp-governance` (with its 48h timelock, already built — `MIN_SAFE_DELAY_SECS`) the `admin`/owner of vault, engine, order-gateway, oracle-adapter, liquidation, insurance. Move admin off the single EOA. Admin should be a multisig that proposes through governance.
- **Why:** Today one hot key controls every contract (upgrade, set_market, set_operator, set_domain, pause, set_collateral). One leak = total drain. **Biggest single risk.**
- **Where:**
  - Each contract has `nominate_admin`/`accept_admin` (two-step) — e.g. `perp-order-gateway/src/lib.rs:101-119`. Use them to transfer admin to the governance contract address.
  - `kryon-protocol/infra/deploy/role-transfer.sh` exists — make it transfer all roles to governance, not an EOA.
  - Governance must be able to call the admin-gated setters (it executes proposals as the admin caller).
- **Acceptance:** `admin()` on every core contract returns the governance contract; a privileged change (e.g. `set_market`) is only possible via a governance proposal that respects the 48h timelock; the deployer EOA has zero privileged power. Add an integration test proving an EOA-direct admin call now fails.
- **Est.:** 2–3 days + careful mainnet ceremony.

### P0.3 — Key separation & secrets management
- **What:** Split the currently-shared keys into distinct, isolated keys with least privilege:
  - **admin/upgrade** → cold multisig (via governance, see P0.2)
  - **oracle publisher** → its own key (today it's `ORACLE_PUBLISHER_SECRET`, *same key as admin & dev wallet* — `client/scripts/oracle-keeper.ts`)
  - **matcher operator** → its own key (`MATCHER_OPERATOR_SECRET`, already separate — keep it that way; it's the gateway operator that submits `settle_fill_signed`)
  - **liquidator** → its own key
  Move all secrets out of `client/.env.local` into a managed secret store (Doppler / AWS Secrets Manager / GCP Secret Manager / Railway/Render secrets). `client/lib/secrets-check.ts` already asserts presence — extend it.
- **Why:** `GA3SSO6D` is currently admin + oracle + dev wallet simultaneously. Any one role's compromise compromises all. Secrets sit in a laptop `.env.local`.
- **Where:** `client/scripts/oracle-keeper.ts`, `client/scripts/matcher-service.ts`, `client/app/api/settlements/[id]/sign/route.ts`, `client/lib/secrets-check.ts`.
- **Acceptance:** No key serves two roles; no secret in any committed/laptop file; rotation runbook documented.
- **Est.:** 2 days.

### P0.4 — Decentralized / hardened oracle
- **What:** Replace the single-keeper-single-source oracle with a quorum. The contract already supports it: `perp-oracle-adapter` has `OracleSource`, quorum config, and the H7 source-enforcement check. Operationally wire ≥2–3 independent publishers/sources and require quorum in production; add staleness + deviation circuit breakers that pause markets (engine `max_oracle_age_secs`, `max_oracle_confidence_bps`, `max_execution_deviation_bps` already exist — tune + monitor them). Add a USDC depeg guard (today the keeper hardcodes USDC=$1 in `oracle-keeper.ts` — for mainnet, source it and halt on depeg).
- **Why:** A liquidation engine driven by one key + one Binance fetch is manipulable and a SPOF. We literally hit `StaleOracle` halting settlement during testing.
- **Where:** `kryon-protocol/contracts/perp-oracle-adapter/src/lib.rs`, `client/scripts/oracle-keeper.ts`.
- **Acceptance:** Price requires N-of-M sources; single publisher outage does not halt the protocol; depeg/stale/deviation auto-pauses affected markets; alerting on all of the above.
- **Est.:** 1–2 weeks.

### P0.5 — Production infrastructure (the backend cannot live on a laptop)
- **What:** Deploy the off-chain services to real cloud infra with HA: `oracle-keeper`, `matcher-service`, `state-indexer`, `ws-server`, `settlement-reconciler`. Currently all run via PM2 on the dev's Mac (`client/ecosystem.config.cjs`). `client/render.yaml` and `client/docker-compose.yml` exist — finish and deploy one. Add: health checks, auto-restart, log aggregation, metrics dashboards, alerting (PagerDuty/Opsgenie), and **make sure `settlement-reconciler` runs 24/7** (it's the safety net for stuck fills).
- **Why:** Single laptop = guaranteed downtime, no HA, secrets on disk, no monitoring. The reconciler must always run or stuck settlements strand orders/funds.
- **Where:** `client/render.yaml`, `client/docker-compose.yml`, `client/Dockerfile.services`, `client/ecosystem.config.cjs`.
- **Acceptance:** All services in cloud with HA; dashboards for fill latency, settlement success rate, oracle freshness, reconciler backlog, DB health; alerts fire on degradation; documented failover.
- **Est.:** 1–2 weeks.

### P0.6 — Neon/Postgres production hardening
- **What:** Production DB tier with automated backups + PITR; connection pooling sized for load; migrations gated (`client/scripts/migrate-*.ts`) and run via CI not manually; least-privilege DB credentials.
- **Why:** The DB holds the orderbook + settlement-job state of record. Loss/corruption = stuck/lost user orders.
- **Where:** Neon project config; `client/prisma/`; migration scripts.
- **Acceptance:** Backups verified by a restore drill; migrations reproducible from CI; no ad-hoc prod SQL.
- **Est.:** 2–3 days.

---

## P1 — Required before launch (state, limits, economics)

### P1.1 — I1: Bound nonce storage (filled/cancelled never pruned)
- **What:** `DataKey::Filled(owner, nonce)` and `DataKey::Cancelled(owner, nonce)` in `perp-order-gateway/src/lib.rs` grow without bound (one persistent entry per order forever). Add TTL/archival or an expiry-based reclamation tied to `expiry_ts` so entries for long-expired orders can be cleared, and ensure Soroban state-TTL bumping is handled.
- **Why:** Unbounded persistent state → rising rent/cost and eventual scaling problems. Flagged "mainnet blocker" in `FINAL_AUDIT_REPORT.md` (I1).
- **Where:** `kryon-protocol/contracts/perp-order-gateway/src/lib.rs` (`add_filled`, `filled`, `is_cancelled`, `cancel_order`).
- **Acceptance:** Storage for an order can be reclaimed after expiry without enabling replay; test proves a settled/expired nonce's entry is bounded; replay still rejected.
- **Est.:** 1 day.

### P1.2 — I2: Enforce a per-user position cap
- **What:** `account_health` in `crates/risk-engine` uses a fixed `[0i128; 64]` buffer and returns `Err(InvalidConfig)` above 64 positions. Enforce a per-user open-position limit in the engine/gateway *before* that buffer is hit (and well below 64).
- **Why:** Without a cap, a user can reach the buffer limit and brick their own `account_health` (which gates liquidation/settlement) — a griefing/DoS and liquidation-evasion vector. Flagged I2.
- **Where:** `kryon-protocol/crates/risk-engine/src/margin.rs` (the 64 buffer), `perp-engine/src/lib.rs` (`open_position`).
- **Acceptance:** Opening beyond the cap is rejected cleanly with a typed error; `account_health` can never be DoS'd by position count; test added.
- **Est.:** Half day.

### P1.3 — Economic stress testing & parameter validation
- **What:** Simulate adversarial conditions: oracle gaps, liquidation cascades, funding-rate extremes, insurance-fund drawdown, and **200× max leverage** behavior (`MARKETS` in `client/config/index.ts` sets `maxLeverageBps: 2000000`). Validate insurance fund sizing and bad-debt absorption (C1 fix) under load. Decide whether 200× is launch-appropriate.
- **Why:** Unit tests prove correctness of paths, not solvency under stress. This is how perp DEXs blow up.
- **Where:** `crates/risk-engine/*`, market config in `client/config/index.ts`, existing `client/scripts/*soak*/*load*` harnesses (extend them).
- **Acceptance:** Documented simulation report; parameters (leverage caps, margin bps, liquidation fees, insurance seed) set from results; protocol stays solvent in modeled tail scenarios.
- **Est.:** 1–2 weeks.

### P1.4 — Liquidation engine operationalization
- **What:** Ensure a liquidation keeper runs in production (who calls `perp-liquidation`?), is incentivized, and is monitored. Verify the H5 single-liquidation cap and C1 insurance bad-debt path behave under the P1.3 stress tests.
- **Why:** Unliquidated underwater positions = protocol insolvency. There's no point-of-truth that a liquidator is reliably running on mainnet.
- **Where:** `kryon-protocol/contracts/perp-liquidation/src/lib.rs`; add a `liquidation-keeper` service alongside the others.
- **Acceptance:** Liquidations fire within target latency in a load test; keeper HA + alerting; reward economics documented.
- **Est.:** 3–4 days.

### P1.5 — Mainnet config & fail-fast verification
- **What:** Populate every `NEXT_PUBLIC_*` mainnet contract/asset address and flip `NEXT_PUBLIC_STELLAR_NETWORK=mainnet`. `client/config/index.ts` already throws if any mainnet var is missing (`envOrDefault`) — good. Verify the real mainnet USDC SAC + issuer, RPC, and Horizon URLs. Re-point Vercel + backend env.
- **Why:** Prevent accidentally running mainnet against testnet addresses.
- **Where:** `client/config/index.ts`, Vercel env, backend secrets.
- **Acceptance:** App refuses to boot in mainnet mode with any missing address; a dry-run on mainnet RPC reads each contract successfully.
- **Est.:** 1 day (after contracts are deployed to mainnet).

---

## P2 — Hardening & correctness cleanup

### P2.1 — L1: Remove dead oracle-confidence check
- **What:** Remove the dead `checked_sub` sub-expression in the oracle confidence guard (no security impact, but cleanup). See `FINAL_AUDIT_REPORT.md` L1.
- **Where:** `kryon-protocol/contracts/perp-oracle-adapter/src/lib.rs`.
- **Acceptance:** Dead code gone; tests still pass.
- **Est.:** 5 min.

### P2.2 — Decide & document the `settle_fill_signed` master-key model
- **What:** `settle_fill_signed` verifies order signatures against the account's **master** ed25519 key via `Address::to_payload()` (hazmat-address). If a user rotates their account signers (master key weight 0), order sigs still verify against the master key. Decide: acceptable (we verify intent, not account control) vs. add a check. Document the decision in `docs/SETTLEMENT_AUTH.md`.
- **Where:** `kryon-protocol/contracts/perp-order-gateway/src/lib.rs` (`verify_order_signature`), `docs/SETTLEMENT_AUTH.md`.
- **Acceptance:** Explicit documented decision; if "guard," a test covering the rotated-signer case.
- **Est.:** Half day.

### P2.3 — Rate limiting, abuse, and API hardening
- **What:** Production rate limits on all `client/app/api/**` routes (order submit, settlement sign, cancel), request-size limits (some exist — `bodyTooLarge`), bot/abuse protection, and CSP/headers review (`client/next.config.ts`).
- **Acceptance:** Load/abuse test shows graceful degradation; no unauthenticated state mutation.
- **Est.:** 2–3 days.

### P2.4 — Observability & on-chain reconciliation
- **What:** Dashboards + alerts for: settlement success rate, fill→settle latency, reconciler backlog (stuck `TxJob`s), oracle freshness per asset, vault solvency (sum of collateral vs. liabilities), insurance fund balance. Periodic on-chain vs. DB invariant check.
- **Acceptance:** A solvency dashboard exists; an alert fires if DB orderbook diverges from on-chain `filled` counters.
- **Est.:** 3–5 days.

---

## P3 — Pre-launch process (non-code, but gating)

- **P3.1 Legal/regulatory review** of operating a perpetual-futures DEX (jurisdiction, KYC/geofencing decisions). *Out of engineering scope — flag to founders.*
- **P3.2 Bug bounty** (Immunefi or similar) live before TVL grows.
- **P3.3 Incident response runbook** + on-call rotation + a tested **emergency pause** drill (the H4 pause exists on vault/gateway — rehearse using it).
- **P3.4 Staged rollout**: deposit caps / TVL caps / allowlist for the first weeks; gradually raise.
- **P3.5 Public docs & disclosures**: risk disclosures, contract addresses, audit reports, oracle/matcher trust model transparency.

---

## Suggested sequence

1. **P0.2 + P0.3** (governance-as-admin + key separation) — foundational; do first.
2. **P1.1 + P1.2 + P2.1 + P2.2** (state/limits/cleanup contract changes) — batch into one contract release **before** the audit so the audited code is final.
3. **P0.1** (external audit) on that frozen contract set.
4. In parallel with the audit: **P0.4 (oracle), P0.5 (infra), P0.6 (DB), P2.3, P2.4** (off-chain work needs no contract freeze).
5. **P1.3 + P1.4** (economic stress + liquidation ops) — feeds parameter choices.
6. Remediate audit findings → **P1.5** mainnet config → **P3** process gates → staged launch.

> **Rule of thumb:** freeze contracts → audit → only then deploy to mainnet. Never
> deploy unaudited contract changes that hold real funds.
