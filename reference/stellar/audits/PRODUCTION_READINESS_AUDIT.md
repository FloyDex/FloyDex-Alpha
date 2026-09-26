# Kryon — Production Readiness Audit (Mainnet + Cloudflare Backend)

**Date:** 2026-07-05 · **Branch:** `main` @ `260059a` · **Scope:** full monorepo (contracts, risk engine, client/API, off-chain services, CI/CD, deployment configs)

**Verdict:** Kryon is a solid, well-hardened **testnet MVP**. The application layer (API validation, signature verification, rate limiting, atomic settlement claims, reconciler) is in genuinely good shape. What blocks mainnet is concentrated in four areas: **(1) unfrozen contract-layer open items + no external audit, (2) key management — one key still holds admin+oracle+dev roles and hot keys live in the web tier, (3) oracle centralization — one keeper, one price source (Binance), hardcoded USDC peg, (4) infrastructure — five stateful services on a laptop under PM2, stale deploy configs, no liquidation keeper.** The Cloudflare migration is feasible for the web tier today (Next 16 is supported by OpenNext), but the five worker services need Cloudflare Containers/Durable Objects or a container host — they cannot run as plain Workers.

---

## Part 1 — What is already production-grade (verified in current code)

| Area | Status |
|---|---|
| Order intake (`/api/orders`) | ✅ Body-size cap, JSON validation, market/size/price/nonce/expiry bounds, **ed25519 signature verified server-side** against canonical `orderSettlementMessage`, rate-limited per owner+IP |
| Cancel route | ✅ Signature-verified (`cancelSigningMessage`), nonce-validated, rate-limited |
| Settlement sign route | ✅ Atomic jsonb-merge + QUEUED→SUBMITTED claim (H2 fix intact), fresh fee-payer sequence rebuild, FAILED marking with `lastError` |
| Rate limiting | ✅ Upstash Redis (distributed) with fail-closed on Redis error, local fallback, key eviction |
| Matcher | ✅ Atomic `filledSize` guard (H3), `settle_fill_signed` fast path (C2), secrets check at startup |
| Reconciler | ✅ Handles SUBMITTED-stuck, QUEUED-with-both-entries, stale-QUEUED rollback |
| Contracts | ✅ All 2026-06-06 audit fixes present: bad-debt absorption (C1), on-chain sig verify (C2), isolated margin (H1), pause (H4), partial-liquidation cap (H5), multi-collateral health (H6), oracle source enforcement (H7), 48h governance timelock (H8), funding surplus routing (M1) |
| Mainnet config | ✅ `client/config/index.ts` fails fast on any missing `NEXT_PUBLIC_*` when `NEXT_PUBLIC_STELLAR_NETWORK=mainnet`; `mainnet-preflight.yml` workflow builds with full mainnet env under a protected GitHub environment |
| Security headers | ✅ CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy in `next.config.ts` |
| Secrets hygiene | ✅ No secrets committed to git (verified `git ls-files`); `secrets-check.ts` startup assertions; no `NEXT_PUBLIC_*SECRET*` leak path |

---

## Part 2 — Mainnet blockers (P0)

### P0.1 — External security audit (unchanged, non-negotiable)
No third-party audit yet. Leveraged perps holding user funds must be audited by a Soroban-specialist firm (OtterSec, Veridise, Certora, Runtime Verification). **Freeze the contract set first** — which means landing P0.5 (a)–(d) below before the audit starts, so the audited WASM is the deployed WASM.

### P0.2 — Key separation is still broken in three places
Verified in current code:

1. **`ORACLE_PUBLISHER_SECRET` is still the admin/deployer/dev-wallet key** (GA3SSO6D…). One leak = oracle manipulation + contract admin + full drain. Mainnet needs four distinct keys: cold admin (behind governance), oracle publisher, matcher operator, liquidator.
2. **The web tier holds hot keys.** `client/app/api/settlements/[id]/sign/route.ts:127` reads `MATCHER_OPERATOR_SECRET ?? ORACLE_PUBLISHER_SECRET` — the settlement fee-payer secret lives in the Next.js serverless environment (today Vercel, tomorrow Cloudflare). Every web-tier RCE/SSRF/env-leak becomes an operator-key compromise. Since the `settle_fill_signed` fast path made this interactive route a legacy fallback, either **delete the legacy path** or move submission behind an internal endpoint on the matcher/reconciler host so the web tier never sees a Stellar secret. At minimum remove the `?? ORACLE_PUBLISHER_SECRET` fallback (also present in `matcher-service.ts:330` and `settlement-reconciler.ts:135`).
3. **No managed secret store / rotation runbook.** Secrets live in `client/.env.local` on a laptop. Move to Cloudflare secrets + the container host's secret manager (or Doppler as source of truth), document rotation.

### P0.3 — Oracle is a single keeper reading a single exchange
Verified in `client/scripts/oracle-keeper.ts`:
- Price source is **one Binance REST endpoint** (`api.binance.com/api/v3/ticker/price`, line 46). Binance outage, geo-block, or a single bad tick = liquidation engine driven by garbage. Aggregate ≥3 sources (e.g. Binance + Coinbase + Kraken median, or Reflector on-chain) and publish via the contract's quorum path (`write_quorum_price`) with ≥2 independent publisher keys.
- **USDC is hardcoded at $1.00** (line 150). A USDC depeg (2023 SVB-style) would let users deposit depegged USDC valued at par and drain the vault. Source the USDC price; auto-pause markets on >X bps depeg.
- No deviation circuit breaker in the keeper (contract has `max_execution_deviation_bps` but nothing halts publication on a wild source tick).
- **Also settlement-critical:** vault `account_health` requires a fresh USDC price — if the keeper dies, all settlement halts with `StaleOracle`. Keeper needs HA + alerting (this exact failure was hit during testnet validation).

### P0.4 — Governance is deployed but is not the admin
All contracts have two-step `nominate_admin`/`accept_admin`, and governance enforces the 48h timelock — but **the admin of every contract is still the single EOA**. For mainnet: deploy → transfer admin of vault/engine/gateway/oracle/liquidation/insurance to the governance contract, with a multisig as the governance proposer. Add an integration test proving a direct EOA admin call fails. Ceremony steps belong in a runbook.

### P0.5 — Contract-layer open items (must land BEFORE the audit freeze)
Verified still present in current code:

| ID | Issue | Evidence | Fix |
|---|---|---|---|
| **I1** | `Filled(owner,nonce)` / `Cancelled(owner,nonce)` persistent entries never pruned; unbounded rent growth, and if rent lapses and entries expire, **nonce replay becomes possible** | `perp-order-gateway/src/lib.rs:20-21,129` | Expiry-tied reclamation (safe to delete once `expiry_ts` has passed — an expired order can't be replayed anyway) + explicit TTL-bump strategy for live entries |
| **I2** | `account_health` fixed 64-position buffer errors out above 64 → a user can brick their own health check (liquidation-evasion / self-DoS) | `crates/risk-engine/src/margin.rs:35`; no cap found in `perp-engine open_position` | Enforce a per-user open-position cap (e.g. 16) in the engine with a typed error |
| **L1** | Dead `checked_sub` confidence sub-expression | oracle-adapter (cleanup) | Remove |
| **P2.2** | `settle_fill_signed` verifies against the account **master key** via `Address::to_payload()` (`perp-order-gateway/src/lib.rs:337`) — ignores signer rotation / weight-0 master keys | Decide + document in `docs/SETTLEMENT_AUTH.md`; the `register_signer` path exists if you choose to honor rotation |
| **New** | Soroban **state archival/TTL management** — no service or script bumps TTLs on contract instance/persistent entries. On mainnet, an archived engine/vault instance = protocol outage | Add TTL extension to a keeper tick + monitor entry TTLs |

### P0.6 — No liquidation keeper exists
`grep liquidat client/scripts/` finds only redeploy/setup scripts. **Nothing in the repo calls `perp-liquidation` on a loop.** Underwater positions on mainnet would sit unliquidated → bad debt → insolvency. Build `liquidation-keeper.ts` (scan positions from the indexer DB, verify health on-chain, call `liquidate`), run it HA with its own key, alert on keeper lag. This is as critical as the matcher.

### P0.7 — Deploy configs are stale and would deploy the wrong protocol
- `client/render.yaml` pins the **pre-audit-fix contract addresses** (vault `CAYLME5C…`, engine `CB35YOPW…`, gateway `CA5ZKC7X…` — superseded 2026-06-06 by `CAULDUKS…`/`CDGU5MYL…`/`CD77MHYJ…`). Anyone deploying from it points services at contracts without the C1/C2/H* fixes. Same file uses `plan: free` (services sleep) for a reconciler that must run 24/7.
- Services still run under PM2 on the dev laptop (`ecosystem.config.cjs`) — single point of failure, no HA, no log aggregation, no alerting. `monitor.ts` exists but isn't deployed anywhere, and `stats-aggregator.ts` isn't scheduled in PM2/render/railway configs.

---

## Part 3 — Cloudflare backend deployment plan

### What Cloudflare can and cannot host here

The backend is two very different workloads:

| Workload | Shape | Cloudflare fit |
|---|---|---|
| Next.js app + API routes | Request/response, Neon HTTP driver, Upstash REST | ✅ **Workers via `@opennextjs/cloudflare`** — Next 16.x is fully supported, Node.js runtime APIs available via `nodejs_compat` |
| `ws-server.ts` | Long-lived WebSocket fan-out, 1s DB poll | ⚠️ The `ws` npm server won't run on Workers. Either **rewrite as a Durable Object** (WebSocket hibernation API — this is the canonical CF pattern and would be cheaper/more scalable than the current 1s DB-poll broadcast) or run it in a container |
| `matcher-service.ts` (1s loop), `oracle-keeper.ts` (8s), `state-indexer.ts` (5s), `settlement-reconciler.ts` (15s), future `liquidation-keeper` | Always-on Node loops holding Stellar keys | ❌ Not plain Workers (no persistent processes; Cron Triggers are 1-min granularity — too coarse). Options: **Cloudflare Containers** (your `Dockerfile.services` is already shaped for this — one image, `SERVICE` env selects the entrypoint), or keep them on a container host (Railway/Render/Fly). A Durable-Object-with-alarms rewrite is possible but a bigger refactor for marginal benefit |

**Recommended target architecture:**

1. **Cloudflare Workers (OpenNext)** — Next.js app + all `/api/*` routes. Bind Neon `DATABASE_URL` + Upstash as Worker secrets. **No Stellar secrets in this tier** (see P0.2).
2. **Durable Object** — real-time orderbook/trade streaming, replacing `ws-server.ts`. Bonus: the matcher can push updates to the DO instead of the DO polling the DB every second.
3. **Cloudflare Containers** (or Railway/Fly if you prefer boring) — matcher, oracle-keeper, indexer, reconciler, liquidation-keeper, monitor. Each with health checks, restart policy, and its own scoped secrets.
4. **Neon** stays (already serverless-driver based, Workers-compatible). **Upstash** stays (REST, Workers-compatible).

### Migration gaps found in the code (things that break on Workers)

| Gap | Where | Fix |
|---|---|---|
| 30-iteration × 1s confirmation poll inside the request handler | `settlements/[id]/sign/route.ts:171-199` | Don't hold a Worker request open ~30s. Return after `sendTransaction` + `submittedHash` persist; let the reconciler confirm (it already knows how). Or `ctx.waitUntil()` |
| `@stellar/stellar-sdk` on workerd | sign route (only if kept) | Needs `nodejs_compat`; run a spike — SDK is fetch/axios-based and generally works, but verify XDR + Keypair paths before committing |
| IP extraction trusts `x-forwarded-for` | `lib/rate-limit.ts:60` | On Cloudflare use `cf-connecting-ip` (or `request.headers.get("CF-Connecting-IP")`); `x-forwarded-for` is client-spoofable |
| Local in-memory rate-limit fallback is per-isolate | `lib/rate-limit.ts` | On Workers, isolates multiply → local fallback ≈ no limit. Make Upstash **required** in production (fail closed if unconfigured), or use a DO-based limiter |
| Deploy pipeline targets Vercel | `.github/workflows/deploy-production.yml` | Replace with `opennextjs-cloudflare build` + `wrangler deploy` (keep the readiness-gate job); keep `mainnet-preflight.yml`, it's env-agnostic |
| CSP `connect-src` | `next.config.ts:16` | Add your WS endpoint domain; drop `api.binance.com` from the **client** CSP if price display moves server-side (the browser currently fetches Binance directly — geo-blocked jurisdictions will see broken price UI) |
| Docs rewrites (`/docs` → static export) | `next.config.ts` rewrites | OpenNext supports rewrites, but verify the `public/docs` static-asset fallthrough behaves under Workers Static Assets |

### Cloudflare extras worth taking (cheap wins)
- **WAF + rate-limiting rules** at the edge in front of `/api/orders` and `/api/orders/cancel` (defense in depth above app-level limits), **Bot Fight Mode**.
- **Turnstile** on any faucet/onboarding endpoints if you add them.
- **Health checks + notifications** on the container services.
- `wrangler secret put` for Worker secrets; never `vars`.

---

## Part 4 — Remaining pre-launch items (P1/P2)

1. **Economic stress-testing & parameters.** `client/config/index.ts` still ships **200× max leverage on every market** (`maxLeverageBps: 2000000`), including XLM with 10% IM — note 200× and 10% initial margin are mutually inconsistent; the effective cap is 10×, so the config is at best misleading. BTC at 2% IM / 1% MM with 200× advertised is launch-risk. Decide real leverage tiers from simulation (oracle gap → liquidation cascade → insurance drawdown), seed the insurance fund with a documented amount, and set `max_execution_deviation_bps` back from the testnet-loosened 10% to something defensible.
2. **DB production posture.** Neon: paid tier with PITR + verified restore drill; migrations are currently ad-hoc scripts (`apply-migration.ts`, `migrate-add-order-signature.ts`) while `kryon-protocol/prisma/migrations` also exists — consolidate on Prisma migrations run from CI; least-privilege roles (API user: no DDL; indexer: write-only where needed).
3. **Observability.** Deploy `monitor.ts` (it already checks oracle freshness, matcher lag, indexer lag, DB latency, WS) as a container + wire alerts (PagerDuty/Telegram). Add: settlement success rate, reconciler backlog depth, vault-solvency invariant (Σ collateral vs Σ liabilities, on-chain vs DB), insurance balance.
4. **Isolated margin end-to-end.** Contract-side isolated margin is fixed (H1), but the gateway hardcodes `MarginMode::Cross` and the Order struct has no margin-mode field — the UI cannot actually open an isolated position through the gateway. Either wire it through (order intent field → gateway → engine) or don't advertise isolated mode at launch.
5. **API residuals.** `/api/orders` runs full validation (incl. ed25519 verify) **before** the rate-limit check — reorder so the limiter is first-touch after parsing the owner; read endpoints (portfolio, fills, leaderboard) have no rate limits (edge WAF covers this if you take the Cloudflare wins above).
6. **Process gates.** Bug bounty live before TVL; incident-response runbook + a rehearsed `emergency_pause` drill (pause exists on vault+gateway — practice the ceremony, including who holds the key once governance is admin: governance timelock is 48h, so you need a **separate fast-path pause authority** — decide and document this, it's a real design tension); staged rollout with deposit caps; risk disclosures + published contract addresses + trust-model docs (users must know the matcher/oracle are centralized at launch).

---

## Part 5 — Suggested sequence

1. **Contract batch (1 week):** I1 nonce reclamation, I2 position cap, L1 cleanup, P2.2 decision, TTL strategy, optional margin-mode wiring → one release, all tests green. **Freeze.**
2. **External audit** on the frozen set (4–8 weeks). In parallel:
3. **Key separation + secret store** (new oracle key, remove web-tier fallbacks, delete or isolate the legacy sign path).
4. **Oracle hardening** (multi-source median, quorum publishers, USDC depeg guard, keeper HA).
5. **Liquidation keeper** service + tests.
6. **Cloudflare migration:** OpenNext Worker for the app (with the 6 Workers-specific fixes above) → Durable Object WS → Containers (or Railway/Fly) for the five services → new CI deploy workflow → kill the laptop PM2 setup. Fix/regenerate `render.yaml` addresses or delete the file to remove the foot-gun.
7. **Stress testing → parameter finalization → insurance seeding.**
8. **Mainnet ceremony:** deploy contracts → wire operator/domain/insurance (extend `redeploy-core.ts` for mainnet with a dry-run mode) → transfer admin to governance → `mainnet-preflight.yml` → staged launch with deposit caps.

**Rule that overrides all sequencing: no unaudited contract byte-code ever holds mainnet funds.**

---

## Addendum — implemented 2026-07-05 (same session)

Contract layer (all 26 test binaries pass, clippy clean):
- **I1 fixed**: gateway `Filled`/`Cancelled` entries now carry the order expiry (`FilledEntry` struct; `cancel_order` takes `expiry_ts`); permissionless `reclaim_order_state` prunes entries past expiry + 24h grace; persistent-entry TTLs extended on write. Test: `reclaim_prunes_only_expired_entries`.
- **I2 fixed**: engine enforces `MAX_POSITIONS_PER_USER = 16` with new `CoreError::TooManyPositions`. Test: `open_position_enforces_per_user_cap`.
- **L1 fixed**: dead `checked_sub` removed from oracle confidence guard.
- **TTL**: permissionless `extend_instance_ttl` added to gateway/engine/vault/oracle; the liquidation keeper bumps them daily.
- **Governance execute now REAL**: previously `execute` was bookkeeping-only (never invoked the target — governance-as-admin would have bricked all admin ops). Proposals now carry `args: Vec<Val>` and `execute` cross-contract-invokes `target.action(args)` (invoker auth satisfies the target's `require_admin`); guardian pause vetoes execution; status set Executed before the call (no replay). Tests: `queues_and_executes_after_delay_invoking_target`, `guardian_pause_vetoes_execution`.

Off-chain (tsc clean, eslint 0 errors):
- **Key separation**: `?? ORACLE_PUBLISHER_SECRET` fallbacks removed from sign route, matcher, reconciler.
- **Sign route**: 30s in-request confirmation poll removed — returns after submit; reconciler owns confirmation (Workers-compatible).
- **Rate limiting**: `CF-Connecting-IP` preferred; production without Upstash now fails closed; orders/cancel routes rate-limit before ed25519 verification.
- **Liquidation keeper built** (`scripts/liquidation-keeper.ts`, `LIQUIDATOR_SECRET`): account scan → on-chain health check → largest-notional-first liquidation with 100%/50%/25% fallback; wired into PM2, render.yaml, env example.
- **Oracle keeper**: Binance+Coinbase+Kraken median, ≥2 sources required, 2% cross-source deviation guard (skip tick = fail-safe), USDC sourced with 1% depeg halt ($1 fallback only on testnet).
- **render.yaml**: current contract addresses, liquidator worker added, `starter` plans, regeneration warning.
- **Admin ceremony**: `scripts/transfer-admin-to-governance.ts` (nominate → queue via timelock → execute).
- **Cloudflare**: `@opennextjs/cloudflare` + `wrangler` installed; `wrangler.jsonc` (nodejs_compat), `open-next.config.ts`, `cf:build/preview/deploy` scripts; `deploy-production.yml` rewritten from Vercel to OpenNext build + `wrangler deploy` (readiness gate kept). **Verified: `cf:build` produces a working bundle and `wrangler deploy --dry-run` passes** (~9.9 MiB / 2.2 MiB gzip).

Still open (unchanged): external audit (P0.1), actual key rotation + secret store migration (ops), running the admin-transfer ceremony, ws-server → Durable Object (or container), containerizing the 6 services, economic stress testing/leverage tiers, Neon PITR + migration consolidation, monitoring deployment.
