# Kryon Perps — Production & Security Audit Report

**Date:** 2026-06-06
**Auditor:** Senior protocol/security review (Claude)
**Scope:** Full repository — Soroban contracts, risk core, Rust services, Next.js runtime (matcher, settlement, indexer), realtime layer, data schema, infra/CI.
**Method:** Direct source review. `cargo check --workspace` → clean (0 warnings). No code changed (audit-only pass, per direction).

---

## 1. Executive summary

Kryon is **not a demo** — it is a genuinely well-architected perps protocol with a sound on-chain auth model, careful fixed-point math, a real oracle-quorum design, and a comprehensive indexer schema. The cryptographic and arithmetic foundations are strong.

However, it is **not yet mainnet-ready**. The gaps are not in the math — they are in **economic safety (solvency), settlement liveness, operational scalability, and governance/upgrade/pause wiring**. Several headline features (isolated margin, multi-collateral, emergency pause, contract upgrades, horizontal scaling, push-realtime) are **scaffolded but not actually wired end-to-end**.

**Overall posture:** Strong testnet system; **2 CRITICAL, 8 HIGH** issues block mainnet.

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 8 |
| MEDIUM | 6 |
| LOW/INFO | 6 |

---

## 2. Architecture as-built (ground truth)

**On-chain (Soroban, Rust):** `protocol-core` (math/types/oracle), `risk-engine` (margin/funding/liquidation), and 7 contracts: `perp-engine` (positions/funding/fees), `perp-order-gateway` (settle_fill), `perp-vault` (collateral/health), `perp-liquidation`, `perp-insurance`, `perp-oracle-adapter` (single + quorum), `perp-governance` (timelock+pause registry), `perp-risk` (advisory, unused in live path).

**Auth chain (sound):** user signs SEP-53 intent → off-chain matcher pairs maker/taker → each party signs a Soroban auth entry for the exact `settle_fill` args (`require_auth_for_args`) → operator + fee-payer submit. Engine mutations require gateway auth; liquidation requires the liquidation contract. Nonce-based `Filled`/`Cancelled` storage blocks replay/overfill (unit-tested).

**Off-chain runtime (the real services are Node, not the Rust `services/`):**
- `services/*` (Rust) are **pure libraries** (matcher CLOB, keepers decisions, oracle normalization, indexer replay) — algorithmic spec + unit tests, **no daemon/RPC/DB/server**.
- Live runtime is `client/scripts/*.ts`: `matcher-service.ts`, `ws-server.ts`, `state-indexer.ts`, `oracle-keeper.ts`, `monitor.ts` + Next.js API routes.
- Realtime to the browser is **REST polling** (oracle 3s, orderbook/trades 1.5s, stats 15s). A WS client + `ws-server.ts` exist but `WS_URL` is unset → dormant.
- Postgres (Neon) via Prisma: events, orders, fills, positions, oracle snapshots, funding, `TxJob` (retry/`nextAttemptAt`), keeper actions, pnl/funding/balance ledgers, leaderboard.

---

## 3. Findings

### CRITICAL

**C1 — Bad debt is recorded but never covered; insurance fund does not backstop vault solvency.**
`perp-liquidation::liquidate` calls `insurance_record_bad_debt(-equity)` when an account is liquidated into negative equity, but `perp-insurance::record_bad_debt` only **increments a counter** — it transfers nothing to the vault. Meanwhile `perp-vault::apply_pnl` drives the user's internal balance negative. Nothing socializes the loss or tops up the vault from the insurance fund. Result: aggregate internal balances can exceed actual token reserves → **protocol insolvency; the last withdrawers cannot withdraw**.
*Fix:* On bad debt, transfer from insurance to the vault to zero the negative balance (capped by insurance balance); if insufficient, socialize via ADL or a deficit counter that gates withdrawals. Add an invariant test: Σ(internal balances) ≤ token reserves + insurance.

**C2 — Settlement requires BOTH parties online to sign at fill time; resting maker liquidity cannot settle.**
A matched fill becomes a `TxJob`; settlement only submits once **both** maker and taker POST a `signedAuthEntry` to `/api/settlements/[id]/sign`. A passive limit maker who places an order and closes the tab is matched but can **never settle** (no one signs their auth entry). This breaks the core CLOB value proposition (passive liquidity). The off-chain SEP-53 signature authorizes *matching* only, not *settlement*.
*Fix:* Use **pre-signed Soroban auth entries**. Because the gateway authorizes *custom args* (order params only, not the counterparty), a maker can pre-sign an auth entry at order time (valid to `signatureExpirationLedger`) that the matcher attaches to any later fill. Build/sign the auth entry in `submitOrder`, store it, and have a settlement worker submit without live participation.

### HIGH

**H1 — Isolated margin is not implemented (required for v1).**
`risk-engine::account_health` pools *all* collateral and *all* positions as one cross account; it ignores `Position.margin` and `Position.mode`. `perp-order-gateway::settle_user_side` hardcodes `MarginMode::Cross`, and the `Order` struct has no margin-mode field. "Isolated margin" is effectively cross-only.
*Fix (cross-cutting):* add margin mode to `Order` + intent + signing message; ring-fence isolated positions in `account_health` (per-position equity/maintenance, isolated collateral not shared); thread mode through gateway→engine→vault; update the frontend.

**H2 — Settlement submission has no atomic state machine (race + liveness).**
`/api/settlements/[id]/sign` reads `status='QUEUED'`, writes the signing party's entry, and on both-signed submits **synchronously inside the request** (polls up to 30s). Two simultaneous both-signed requests can **double-submit**; interleaving can leave both writing only their own entry → **stuck "waiting"** forever (no worker re-checks). No `SUBMITTING` compare-and-set; no async settlement worker.
*Fix:* atomic `UPDATE … WHERE status='QUEUED' RETURNING` to claim; move submission to a background worker off the HTTP path; idempotency on `submittedHash`.

**H3 — Matcher is single-instance by design; not horizontally scalable.**
`matcher-service.ts` comments "Sequential loop — never overlap ticks, avoids fill race conditions." It does a non-transactional **read → match in memory → update `filledSize`**. Two instances would double-match (different takers against the same maker). On-chain overfill checks prevent *fund* loss, but the off-chain book corrupts.
*Fix:* `SELECT … FOR UPDATE SKIP LOCKED` partitioned by market, or a single-writer leader lock; wrap match+persist in one transaction.

**H4 — Governance timelock, emergency pause, and contract upgrades are decorative.**
`perp-governance::execute()` only flips a status enum — it never calls `target.upgrade(wasm_hash)` or the proposed action. No contract exposes an `update_current_contract_wasm` upgrade entrypoint → **contracts are immutable**. `emergency_pause()` sets a `Paused` flag that **no other contract reads** → pausing does nothing; trading/withdrawals continue.
*Fix:* add governance-gated `upgrade` to each contract; have engine/vault/gateway check a shared paused flag (or governance cross-call) on state-changing entrypoints; make `execute()` actually invoke the target.

**H5 — Over-liquidation: arbitrary `close_size`, no "minimum needed" cap.**
`perp-liquidation::liquidate` accepts any `close_size` (only bounded by ≤ position size and "health improved"), and `keepers::liquidation_actions` always sets `close_size = position.size` (full close). The partial-liquidation cap (`risk-engine::plan_liquidation`) exists but is **never used** on the live path. Liquidators/keepers can fully close positions that needed only partial liquidation, over-penalizing users.
*Fix:* enforce `close_size ≤ ceil(size_needed_to_restore_maintenance × buffer)` on-chain; drive keepers from `plan_liquidation`.

**H6 — Multi-collateral is not margined.**
`perp-vault::account_health(user, asset)` builds a snapshot with **only the one passed asset** as collateral; the engine always passes the settlement asset. Any other deposited collateral is ignored for margin/health, and withdrawing a non-settlement asset is validated against a snapshot that omits other collateral and mis-frames cross exposure.
*Fix:* aggregate all active collateral balances (with per-asset haircut + validated price) into the health snapshot; engine health must reflect the full collateral set.

**H7 — Single-source oracle feeds in production.**
`set_feed` creates a single-publisher feed (`min_sources=1`); `get_price` validates only freshness/confidence. The robust `set_quorum_feed` (median, deviation, odd `min_sources≥3`, per-source publisher auth) exists but isn't mandated. A single compromised/faulty publisher can move marks → liquidations.
*Fix:* require quorum feeds for all live markets on mainnet; treat single-source as testnet-only.

**H8 — Admin powers are EOA, not timelock/multisig.**
Every contract's admin is a single key that can instantly `set_market`, `set_collateral`, `set_fee_config`, `set_operator`, `set_oracle`, etc. Two-step transfer exists, but there is no timelock/multisig between admin and live parameters.
*Fix:* set each contract's admin to the governance timelock (or a multisig); route parameter changes through queued proposals.

### MEDIUM

- **M1 — Funding leakage on imbalanced OI.** `risk-engine::update_from_imbalance` moves `long_index += δ`, `short_index -= δ` symmetrically; when `oi_long ≠ oi_short`, total paid ≠ total received and the difference is unaccounted (no insurance routing).
- **M2 — Realtime is polling, not push.** 1.5–3s REST polling; `ws-server.ts` exists but `WS_URL` unset. Not Binance/Hyperliquid-grade. Wire and deploy the WS server; push orderbook/trades/fills/positions.
- **M3 — DB/chain desync on late settlement failure.** Matcher rolls back a fill only if simulation fails at queue time, not if the eventual on-chain submission fails; no reconciliation worker for stuck/failed `TxJob`s vs persisted `Fill`s.
- **M4 — Secrets management.** Operator/fee-payer + oracle publisher secrets in env vars; one operator key signs all settlements; no rotation/HSM/separation per market.
- **M5 — No live liquidation/funding execution worker confirmed.** Keeper decisioning is a Rust lib; live `oracle-keeper.ts` exists, but the on-chain liquidation/funding submission loop on the deployed runtime needs verification/implementation.
- **M6 — Market-order slippage protection is frontend-only.** Matcher/gateway accept `limit_price = MAX` market orders; the only bound is whatever limit the frontend encodes. A protocol-side max-slippage vs oracle would harden this.

### LOW / INFO

- **L1** `verifySignedMessage` accepts raw / sha256 / SEP-53 — safe (all verify against the owner key) but the raw path is test-only surface; gate it off in production.
- **L2** `protocol-core::oracle.rs` dead branch `checked_sub(...).is_ok() &&` (always true).
- **L3** `account_health` hard-caps 64 positions per account (fixed array) → `InvalidConfig` beyond.
- **L4** Gateway `Filled`/`Cancelled` persistent entries never archived → unbounded storage; nonce uniqueness/monotonicity unenforced.
- **L5** `pseudoTxHash` is a 32-bit JS hash; the `Fill` unique constraint omits `fillSize`, so two equal-size fills between the same (maker,nonce,taker,nonce) pair collide and the second is dropped.
- **L6** Settlement route injects signed auth entries without server-side binding verification (on-chain `require_auth_for_args` is authoritative — acceptable, but a sanity check would fail faster).

---

## 4. What is solid (credit where due)

- **Math:** `I256` intermediates in `mul_div`, `checked_*` everywhere, `overflow-checks = true`, `panic = abort`. Clean precision handling.
- **Auth model:** order → gateway (`require_auth_for_args`) → engine (gateway-only) → vault (engine-only); liquidation gated. Replay/overfill provably blocked (tests).
- **Oracle:** quorum median, per-source publisher auth, monotonic publish-time (anti-replay), odd `min_sources≥3`, source-deviation guard. Execution price validated against an oracle band on **every** position mutation including liquidation.
- **Indexer/data:** comprehensive Prisma schema with retry-aware `TxJob`, unique constraints for idempotency, pnl/funding/balance ledgers, leaderboard.
- **Intake hardening:** signature verification + numeric bounds + future-expiry + known-market + rate limiting + body-size limits.
- **Ops scaffolding:** multi-env infra, runbooks (oracle/matcher/settlement/rollback/incident), CI workflows, e2e/load/soak/failure-recovery scripts.

---

## 5. Coverage map

**Line-audited:** all of `protocol-core`, `risk-engine`; contracts `perp-engine` (core paths), `perp-order-gateway`, `perp-vault`, `perp-liquidation`, `perp-insurance`, `perp-oracle-adapter`, `perp-governance`, `perp-risk`; Rust `services/*` (confirmed libraries); `matcher-service.ts`, `/api/orders`, `/api/settlements/[id]/sign`, `validation.ts`, `signed-intent.ts`, `websocket.ts`, `MarketDataProvider` (data flow); Prisma schema; infra/CI inventory.

**Inventoried, not line-audited (next pass):** `ws-server.ts`, `state-indexer.ts`, `oracle-keeper.ts`, `monitor.ts`, `stats-aggregator.ts`; trade UI components (`OrderEntry`, `PositionsTable`, `DepositWithdrawDialog`, charts); `settlement.ts` internals; CI YAML contents; e2e/load/soak script internals.

---

## 6. Remediation roadmap (prioritized)

**Phase 1 — Solvency & liveness (mainnet blockers):** C1 (insurance backstop + invariant), C2 (pre-signed auth-entry settlement + worker), H2 (atomic settlement state machine).
**Phase 2 — Risk correctness:** H1 (isolated margin, **v1-required**), H5 (partial-liquidation cap), H6 (multi-collateral health), M1 (funding leakage routing).
**Phase 3 — Governance & ops safety:** H4 (real pause + upgradeable contracts), H8 (admin→timelock/multisig), H7 (mandatory quorum oracles), M4 (secrets).
**Phase 4 — Scale & realtime:** H3 (concurrent matcher), M2 (push WS), M3 (settlement reconciliation worker), M5/M6.
**Phase 5 — Cleanups & tests:** L1–L6, plus invariant/fuzz/attack-sim tests for each fix.

---

## 7. Mainnet gating checklist

- [ ] Solvency invariant enforced + tested (C1)
- [ ] Settlement works without makers online; atomic + async (C2, H2)
- [ ] Isolated + cross margin correct, multi-collateral health (H1, H6)
- [ ] Partial-liquidation cap on-chain (H5)
- [ ] Functional pause + governance-gated upgrades; admin = timelock/multisig (H4, H8)
- [ ] Quorum oracles for all live markets (H7)
- [ ] Concurrent-safe matcher + push realtime + settlement reconciliation (H3, M2, M3)
- [ ] Secrets hardened; keeper liquidation/funding workers live (M4, M5)
- [ ] Full attack-sim + invariant + load suite green on testnet
