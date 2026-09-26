# Kryon Protocol — Open Findings Follow-Up

**Date:** 2026-09-07
**Branch:** `fix/unsettleable-orders-and-test-runner`
**Scope:** Deep investigation of items left open after the prior audit (14 findings fixed and merged). This document does not re-audit closed items — it investigates the four items that were left open, verifying every claim against current source and live on-chain state (mainnet + testnet v3) rather than trusting the prior write-up.
**Method:** Each item was independently re-derived by reading `perp-engine`, `perp-liquidation`, `perp-insurance`, `perp-vault`, `perp-risk`, `perp-order-gateway`, `perp-governance`, and cross-checked with live `stellar contract invoke` / `stellar contract info interface` queries against mainnet and testnet v3.

---

## Finding Index

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| Q4 | HIGH | Liquidation has no counterparty — insurance fund is unbounded implicit counterparty | **Fixed** — `adl` entrypoint + aggregate OI ceiling + staked backstop pool (see below) |
| Q10 | **CRITICAL** | Mainnet contracts have no upgrade path — all 8 contracts, admin never handed to governance | **Partially addressed** — migration import tooling built; the actual redeploy/cutover was not (and could not be) executed in this session |
| Q11 | HIGH | OI cap on testnet v3 is a flat multiplier sized to today's exposure, not a risk budget | **Fixed** — per-market sizing + aggregate ceiling implemented |
| Q5-F | MEDIUM | Isolated margin loss-absorption is cosmetic (confirmed), but currently unreachable in production | **Fixed** — rejected at the entrypoint, hidden UI removed |

Fixes for Q4, Q11, and Q5-F have been implemented and are covered by new/updated contract tests (see "Fixes Implemented" at the end of this document). For Q10, the code-side migration tooling the plan called for (a one-time, admin-gated batch-import entrypoint on `perp-vault` and `perp-engine`) has been built and tested — but the actual mainnet redeploy, state export, and cutover were explicitly NOT attempted: that requires live admin credentials, real fund movements, and a multi-day operational window that is not something to execute inside a coding session. That part remains a separate, live operations project.

---

## Q4 — Liquidation Has No Counterparty

**Severity:** HIGH
**Files:** `contracts/perp-liquidation/src/lib.rs`, `contracts/perp-engine/src/lib.rs`, `contracts/perp-insurance/src/lib.rs`, `contracts/perp-risk/src/lib.rs`

### Verified behavior

`PerpLiquidationContract::liquidate` (`perp-liquidation/src/lib.rs:186-250`) calls `engine.liquidate_reduce(user, position_id, close_size, execution_price)` (line 208), which is `reduce_position_internal(..., require_initial_margin=false)` (`perp-engine/src/lib.rs:1133-1202`, entrypoint at 596-605). That function:

- Mutates only the **liquidated user's** `Positions(user)` entry (lines 1165-1171).
- Decrements `OpenInterest(market_id)` and only the liquidated side's `LongOpenInterest`/`ShortOpenInterest` (lines 1172-1185).
- Credits/debits realized PnL to the liquidated user via `vault_apply_pnl` (line 1186).

At no point is any specific counterparty address looked up or touched. This is structural, not an oversight: fills settle as two independent calls (`perp-order-gateway/src/lib.rs:280-320`, `684-738`), each updating only its own account's position — the maker/taker pairing is never persisted on-chain after settlement. There is no "trade" record linking two accounts for liquidation to later unwind.

If the resulting equity is still negative after seizing other collateral, `vault.absorb_bad_debt` pulls from the insurance fund (`perp-liquidation/src/lib.rs:236-238`; `perp-vault/src/lib.rs:203-219`); any remainder becomes recorded protocol bad debt (`perp-insurance/src/lib.rs:157-168`). The winning counterparty, already paid via `apply_pnl` at the original fill, keeps their position unchanged.

**Current mitigation — `set_oi_policy`** (`perp-engine/src/lib.rs:244-263`), enforced in `require_insurance_headroom` (lines 953-970):
```
cap = effective_insurance() * max_bps / 10_000
if notional(next_oi, price) > cap: reject
```
`effective_insurance()` = fund balance net of recorded bad debt, **global across all markets** (lines 924-946). The cap is checked only on `open_position`/`increase_position` — never on exit or liquidation (intentional, per the code comment: a cap that blocks exits turns a thin fund into a trap).

Two real gaps in this mitigation:
1. It bounds **gross** OI per market, not long/short imbalance — a balanced book (near-zero real counterparty risk) hits the same cap as a fully lopsided one (maximum counterparty risk).
2. It's checked per-market against the *same undivided* global fund balance — each of N markets can independently reach up to the cap, so aggregate implicit exposure the fund could be on the hook for scales with the number of markets, not a single fund-wide bound. See Q11 for the concrete numbers this produces on testnet v3.

### No on-chain index — confirmed

`Positions(Address)` in both `perp-engine` (`lib.rs:47`) and `perp-vault` (`lib.rs:37`) are keyed only by account address, read/written via per-user calls. `perp-risk` (`lib.rs:1-28`) is explicitly documented as not a source of truth — every entrypoint takes a caller-supplied snapshot and never reads real position state. There is no market-scoped or global enumeration entrypoint anywhere in these three contracts, and none is retrofittable without new state written on every position mutation. Off-chain, `prisma/schema.prisma` defines a `Position` table that could back a ranking service, but no code currently writes to it — it's dead, matching the existing project-memory note that this table is unpopulated.

### Recommendation

Do not pursue an ADL design that assumes a verifiably-optimal on-chain ranking — it's architecturally unavailable here, and building a global index purely to support ADL would add ongoing storage cost to every position mutation for a queue that fires rarely.

1. **Fix the OI-cap gap first** (small change, `require_insurance_headroom`): bound the fund-wide aggregate across markets rather than letting each market independently claim up to its own multiplier of the shared fund; prefer capping long/short imbalance over gross OI, since imbalance is what actually determines unhedged exposure at liquidation.
2. **Add a bad-debt-gated ADL entrypoint** as the actual fix for the "no counterparty" gap. Concretely:
   - New engine entrypoint (e.g. `adl_reduce`), callable only by a keeper role, gated on `insurance.bad_debt_of(asset) > 0` (or a governance-set threshold) — i.e. ADL only fires against an already-realized, on-chain-measured shortfall, never a speculative one.
   - Keeper supplies `(counterparty, position_id, close_size)`. The contract does not need to trust the ranking — it verifies two per-position invariants cheaply: (a) counterparty's unrealized PnL at current mark > 0, and (b) `close_size` capped at `min(requested, position.size, remaining_bad_debt / mark_price)`, recomputed from `insurance.bad_debt_of` rather than trusted from the caller.
   - New `perp-insurance` entrypoint `reduce_bad_debt`, mirroring the existing `record_bad_debt`, invoked as ADL offsets the shortfall.
   - Optional hardening: require k-of-n keeper attestations (reusing the domain-signing machinery already built for `settle_fill_signed`) to raise the cost of a single compromised keeper picking an arbitrary rather than genuinely optimal target.
3. **Treat a backstop LP pool as separate, longer-term work**, not a Q4 fix. `perp-insurance::deposit` (lines 101-114) today is a one-way donation with no share token, no depositor record, and no withdrawal path — anyone "staking" today has simply given the protocol money with no claim back. A cash-based, NAV-priced staking layer (mint shares at `effective_insurance()`-based NAV, cooldown-gated withdrawal to prevent front-running incoming liquidations) is a moderate addition to `perp-insurance` alone. A true position-taking clearing pool (the pool opens an actual `Position` via the engine) is a much larger change touching the engine's position model and vault health checks for a "pool as trader" account, and should be shelved.

**Trader-facing cost of the ADL design above, stated precisely:** a trader who is currently in-the-money can have some or all of that position involuntarily closed at the prevailing mark, PnL paid out immediately in full, capped at the actual unmet bad debt. The cost is losing further upside and needing to re-enter to maintain exposure — but the loss is targeted at exactly the winners of the unwound trade and bounded by the real shortfall, rather than a blanket fee spread across all traders or an open-ended draw on the insurance fund.

---

## Q10 — Mainnet Is Permanently Frozen (all 8 contracts, not 2)

**Severity:** CRITICAL
**Files:** all 8 mainnet contract deployments; `infra/deploy/mainnet-deployment.json`; `client/scripts/upgrade-contracts.ts`; `contracts/perp-governance/src/lib.rs`

### Verified — worse than initially flagged

Live `stellar contract info interface` queries against mainnet RPC (`https://mainnet.sorobanrpc.com`) confirm:

- `perp_engine` (`CD6OMHCRDDBDO7I57HCUU52RORFPP7DUIRULWFBOX5WLCO5H2OB3W6LZ`): 24 functions, no `upgrade`.
- `perp_liquidation` (`CBGSXCZTZOSBMM5RLGZWWLE2USNAXL5ZKCHTZQ6DOKBD3PIEUJXFYDRO`): 7 functions, no `upgrade`.
- The remaining 6 mainnet contracts (`perp_vault`, `perp_order_gateway`, `perp_risk`, `perp_oracle_adapter`, `perp_insurance`, `perp_governance`, addresses per `infra/deploy/mainnet-deployment.json`) were also queried live: **none expose `upgrade` either.** The entire mainnet contract set is frozen.

Root cause, confirmed by history: `upgrade()` (`env.deployer().update_current_contract_wasm`, admin-gated) was added to all 8 contracts in commit `9023c95` ("Add upgrade to every contract so changes stop needing a migration", 2026-09-05). `infra/deploy/mainnet-deployment.json` was committed 2026-07-08 — over a month before `upgrade()` existed in source. The capability cannot be retrofitted; it must have existed in the deployed WASM to be callable.

**Governance was never handed over**, compounding the problem: `perp_vault.admin()` on mainnet returns `GDG6QFEYHL76TPWYLKNG4A5PG6UQOWW4UF7SV2RBNGGU2G3WQSZKUI34` — a plain keypair, not the `perp_governance` contract address. Even a hypothetical retrofit of `upgrade` would still be single-key-controlled, not timelock-gated. This matches (and confirms) the existing project memory note "Mainnet Governance Not Handed Over."

The team's own tooling agrees: `client/scripts/upgrade-contracts.ts` (added `ea9609f`) probes each contract by simulating `upgrade(0x00...00)` and discriminating "function doesn't exist" from "function exists" errors, and correctly refuses to proceed when nothing is upgradeable — run against mainnet's deployment file, it reports all 8 frozen.

### Migration plan

1. **No new freeze action needed** — mainnet has been silent since 2026-07-10. Confirm no residual trading capability remains reachable (check `emergency_pause` state on vault/gateway, Guardian-gated); don't let anything new accrue during migration.
2. **Enumerate accounts.** No contract exposes a state-dump function, and Soroban has no "list all storage keys" RPC. Source of truth: the existing off-chain Postgres indexer (deposits/trades/orders), cross-checked against Horizon operation history for the vault/engine/gateway contract IDs to catch any indexer gaps (e.g. during the Neon-quota outage on record).
3. **Export state read-only**, per account: `perp_vault.balance_of(addr, asset)` for every configured asset, `perp_engine.positions(addr)`. Globally: `perp_engine.funding_state(market_id)` per market, market/collateral configs, `perp_insurance.balance_of`/`bad_debt_of`. Cross-check the sum of exported vault balances against the vault's real on-chain token balance before trusting the export — this is the point where a bug would silently create or destroy funds.
4. **Deploy the new contract set from current HEAD** (already carries `upgrade()` on all 8). Initialize **governance as admin from the start** — deploy `perp_governance` first, set its own admin to itself/a multisig, then initialize the other 7 with `admin = <governance address>` directly, avoiding any window where a bare keypair holds admin pending a later handover.
5. **Add a one-time admin-gated `migrate_*` batch-import entrypoint** (new, doesn't exist today) to the new `perp_vault`/`perp_engine` builds, callable once by governance to seed `Balance`, `Positions`, `FundingState` from the export, self-disabling after use (`MigrationComplete` flag checked at entry). Support a permissionless fallback claim path, cross-checked against the frozen old contract's `balance_of`, for any address the batch import misses.
6. **Order tombstones (`Filled`/`Cancelled` nonces, `perp-order-gateway`) do not need migrating** — they self-prune after expiry + 24h grace, and mainnet's silence since 07-10 means all outstanding order TTLs have long expired.
7. **Atomic cutover**: repoint client config, keeper fleet, and oracle publishers to the new addresses in a single deploy from one shared config source — the project's own `ea9609f` commit notes that non-atomic repointing across layers previously caused a 356-retry incident on testnet.
8. **Capitalize insurance before setting any OI policy** on the new deployment — an empty fund makes the OI-headroom check (Q11) reject all new positions, as already observed on testnet v3.
9. **Leave old mainnet contracts as effectively read-only**: since they can't be paused via `upgrade`, stop directing any deposit/UI traffic there and treat any late incoming deposit as requiring manual one-off reconciliation rather than assuming it's impossible.

**Governance note:** `perp_governance` (`lib.rs:8`, `MIN_SAFE_DELAY_SECS = 172_800` — 48h) already implements a sound queue/execute/cancel timelock with a separate emergency-pause-only fast path. The mainnet failure was never the governance contract's design — it's that mainnet's actual admin was left as a deployer keypair instead of the governance contract address. The redeploy should not repeat this: initialize with governance as admin from block zero.

---

## Q11 — Testnet v3 OI Cap Is Sized to Today's Exposure, Not a Risk Budget

**Severity:** HIGH
**Files:** `contracts/perp-engine/src/lib.rs`, `contracts/perp-insurance/src/lib.rs`, `contracts/perp-risk/src/lib.rs`, `client/scripts/set-risk-params.ts`, `infra/deploy/environments/testnet.toml`

### Verified on-chain (testnet v3, live query)

- Insurance fund `balance_of(USDC)` = exactly 200.00 USDC, `bad_debt_of` = 0.
- `oi_policy` for every market (1–8) = 1,500,000 bps = **150x, uniformly**.
- Per-market notional (derived from live `insurance_coverage_bps`), total ≈ **27,747 USDC** (claimed 27,668 — matches within bps-rounding):

| market | symbol | coverage | derived notional |
|---|---|---|---|
| 1 | XLM | 29.0% | ~689 |
| 2 | **BTC** | **1.00%** | **~20,000** |
| 3 | ETH | — | 0 |
| 4 | SOL | 17.3% | ~1,159 |
| 5 | XRP | 23.0% | ~870 |
| 6 | ADA | 10.2% | ~1,965 |
| 7 | BNB | 33.6% | ~595 |
| 8 | TRX | 8.1% | ~2,469 |

BTC = 72.1% of total notional at 1.00% coverage — the claimed figures are confirmed exactly.

### Root defect

`set_oi_policy` (`perp-engine/src/lib.rs:244-263`) already supports a distinct bps value per market; the flat-150x-everywhere outcome is a **deployment-script choice**, not a contract limitation — `client/scripts/set-risk-params.ts:171-180` loops over every market applying the same `OI_BPS` constant. The contract itself has no market-specific volatility/liquidity input at all — the cap only reacts to the fund shrinking via recorded bad debt.

Because `effective_insurance()` is one global number checked independently per market (`perp-insurance` pools funds across all markets with no partitioning — `perp-insurance/src/lib.rs:170-176`), the real worst case is not "BTC could reach 150× the fund in isolation" — it's that **all 8 markets can simultaneously reach their own 150× cap against the same 200 USDC**, i.e. up to 8 × 150 × 200 = 240,000 USDC of aggregate nominal backing claimed from a single 200 USDC fund. No cross-market aggregate check exists anywhere in `perp-engine`.

`perp-risk` has no volatility/liquidity parameters at all beyond the margin ratios already in `perp-engine`'s market config (`initial_margin_bps`, `maintenance_margin_bps`, `max_leverage_bps`) — but those ratios are themselves already an implicit per-market risk signal (BTC: 50x/2%/1%, ETH: 20x/5%/2.5%, mid-tier: 10x/10%/5%, ADA/TRX: 5x/20%/10%, per `infra/deploy/environments/testnet.toml`).

### Recommended sizing policy

Replace the flat multiplier with a risk-budget allocation keyed off each market's existing maintenance-margin bps (used as a liquidation-window stress-gap proxy), with an explicit allocation of the fund across markets:

```
stress_gap_i  = 2 × maintenance_margin_bps_i / 10_000      (doubled for slippage/gap risk during a fast decline)
risk_budget_i = Fund_effective × market_weight_i           (Σ market_weight_i ≤ 1 = fund fully covers one simultaneous stress event)
cap_i (notional) = risk_budget_i / stress_gap_i
```

Worked example at current Fund = 200 USDC, equal 1/8 weighting as a starting allocation:
- **BTC** (maintenance 1% → stress_gap 2%): risk_budget 25 USDC → **cap ≈ 1,250 USDC** (equivalent ≈ 6.25× fund — vs. today's 30,000 nominal cap and ~20,000 actual OI, both already well beyond what 200 USDC can plausibly absorb from a single-asset gap event).
- **ADA** (maintenance 10% → stress_gap 20%): risk_budget 25 USDC → **cap ≈ 125 USDC** (≈ 0.625× fund).

This correctly differentiates ~10:1 between BTC and ADA, driven by parameters the protocol already maintains, instead of today's uniform 150x.

### Implementation

- **No contract change required** to differentiate per market — fix `client/scripts/set-risk-params.ts` to compute `bps_i` per market from `maintenance_margin_bps_i` and `market_weight_i`, and call `set_oi_policy` per market with the differentiated value.
- **A contract change is required** to enforce the cross-market aggregate constraint (Σ commitment ≤ fund) — `require_insurance_headroom` currently checks only one market's own OI against the full fund with no cross-market bookkeeping. Either add a new "aggregate committed risk" storage entry updated on every open/increase across markets, or (no contract change, weaker guarantee) enforce Σweight_i ≤ 1 by discipline in the deploy script.
- **Underlying issue independent of formula shape:** 200 USDC is not a credible insurance fund for a protocol already carrying ~$27.7k of live notional under any capping scheme — the fund needs to grow by roughly 1–2 orders of magnitude before the choice of formula matters much in absolute terms.

---

## Q5-F — Isolated Margin Loss Absorption Is Cosmetic (Follow-Up to KRY-Q5)

**Severity:** MEDIUM (currently unreachable in production — see below)
**Files:** `crates/protocol-core/src/types.rs`, `contracts/perp-engine/src/lib.rs`, `contracts/perp-vault/src/lib.rs`, `crates/risk-engine/src/margin.rs`, `contracts/perp-order-gateway/src/lib.rs`, `client/features/trade/components/OrderEntry.tsx`

### Verified — confirmed, and already self-documented in-repo

`Position.mode: MarginMode` (`Cross`/`Isolated`) and `position.margin: i128` exist on the `Position` struct (`protocol-core/src/types.rs:5-8, 32-41`). At open, `perp-engine::open_position` computes `position_margin` for isolated positions and stores it **on the position struct only** (`perp-engine/src/lib.rs:487-503`) — nothing is moved in the vault.

`perp-vault`'s balance key is `Balance(user, asset)` (`perp-vault/src/lib.rs:34`) — one bucket per user per asset, with no per-position or per-market sub-account anywhere in the schema.

`reduce_position_internal` (`perp-engine/src/lib.rs:1133-1202`) computes `realized_pnl` uncapped and applies it unconditionally at line 1186 via `vault_apply_pnl`, with **no branch on `position.mode`** and no clamp to `position.margin`. Isolated and cross losses hit the exact same account balance identically.

This is already flagged in-repo: `crates/risk-engine/src/margin.rs:88-97` carries a comment left from the KRY-Q5 fix explicitly stating isolated losses are not floored at locked margin and will consume cross collateral once realized. The team knew when they removed the (incorrect) health floor.

**What isolated mode does do today**, confirmed real but narrow: `locked_isolated_margin` is excluded from `cross_collateral` available for new cross positions (`risk-engine/src/margin.rs:68-82`), and isolated positions get an independent per-position liquidation trigger decoupled from the cross book's health (lines 70-76, 126-140; test `isolated_does_not_contaminate_cross_health`). But total account equity always counts the isolated loss in full (lines 111-118) — the one guarantee users actually rely on ("my downside is capped at what I put up") is false.

### Material finding: isolated margin is currently unreachable in production

`perp-order-gateway` is the only authorized caller of `perp-engine::open_position` and **hardcodes `MarginMode::Cross`** on every order (`perp-order-gateway/src/lib.rs:683-703`). A repo-wide search shows `MarginMode::Isolated` appears nowhere outside internal engine branches and unit tests. The client already hides the toggle (`client/features/trade/components/OrderEntry.tsx:368-377`, `showMarginMode = false`, with a comment noting it's "kept in code but hidden until isolated/cross modes are functional"). **No user can select isolated margin today** — the defect is latent, not live.

### Scope to implement properly

Moderate-to-deep, cross-crate, not a patch: a new vault-side isolated-margin ledger (lock margin out of cross balance at open, release on close), capping realized loss at `-position.margin` with a defined fate for loss beyond that, reworking `perp-liquidation`'s currently `(user, asset)`-keyed `vault_seize_for_deficit`/`vault_absorb_bad_debt` to be bucket-aware (otherwise seizing cross collateral to cover an isolated deficit reproduces the same bug), and re-deriving `risk-engine::account_health` to match — touching `perp-vault`, `perp-engine`, `risk-engine`, and `perp-liquidation` together. The KRY-Q5 comment is explicit that patching health math alone, without matching real balances, is what produced the original bug.

### Recommendation: remove now, scope properly later if wanted

Because isolated margin is both unreachable today and self-documented as unsound, removal is nearly free and closes an attractive nuisance for any future gateway/integration change that might re-enable it without realizing the vault-side gap exists:

- Reject or drop `MarginMode::Isolated` in `open_position`.
- Delete the dead `locked_isolated_margin` / `any_isolated_liquidatable` / `isolated_equity` branches in `risk-engine`.
- Delete the already-hidden isolated-margin UI code in the client.
- Do not re-expose "Isolated" as a user-facing option until the vault-side ledger fix lands — the failure mode (losing the full cross balance instead of the capped amount promised) surfaces precisely during liquidation, when the trader is relying on the guarantee most.

No migration risk exists for this removal since no isolated positions can currently be opened.

---

## Summary of Recommended Next Actions

| Priority | Action | Est. scope | Status |
|---|---|---|---|
| 1 | Fix `set-risk-params.ts` to differentiate OI cap per market by maintenance-margin bps (Q11) | Small, script-only | **Done** |
| 2 | Remove unreachable `MarginMode::Isolated` code path (Q5-F) | Small, no migration risk | **Done** |
| 3 | Add fund-wide aggregate check to `require_insurance_headroom` (Q4, Q11) | Small-medium, contract change | **Done** |
| 4 | Add bad-debt-gated `adl` entrypoint + `perp-insurance::reduce_bad_debt` (Q4) | Medium, new contract logic | **Done** |
| 5 | Design and execute mainnet redeploy + migration with governance-as-admin-from-init (Q10) | Large, highest stakes — real user funds | **Tooling done**; live execution not started — needs separate scoping/approval |
| 6 | (Longer-term) cash-based NAV-priced insurance staking layer (Q4) | Medium-large, new feature | **Done** |

---

## Fixes Implemented (2026-09-07)

All four items below were implemented and verified against the full contract workspace test suite (`cargo test --workspace`, 89 tests, 0 failures) plus client typecheck/lint. Q10 was intentionally left untouched — it is the one item where implementation work should not proceed without a separate, explicit scoping and approval pass given it touches live mainnet funds.

**Q11 — OI cap sizing (`client/scripts/set-risk-params.ts`).** Replaced the flat `--oi-multiple` applied identically to every market with a per-market formula keyed off each market's own `maintenanceMarginBps`: `cap_i = fund_share / (2 × maintenance_margin_bps_i)`. `FUND_COVERAGE` (default 1.0x) is now a fund-wide budget split evenly across active markets rather than a per-market multiplier.

**Q5-F — Isolated margin.** `perp-engine::open_position` now rejects `MarginMode::Isolated` outright with a new `CoreError::IsolatedMarginDisabled` (`protocol-core/src/error.rs`), closing the gap at the contract level (defense in depth beyond the order gateway already hardcoding `Cross`). Removed the hidden isolated/cross margin-mode UI entirely from `OrderEntry.tsx`. Left the `MarginMode` enum and its dead branches in `risk-engine`/`perp-vault` untouched — deleting those touches contract ABIs and tests across several crates for no live-risk benefit now that the entrypoint refuses `Isolated`.

**Q4 + Q11 — Aggregate OI ceiling (`perp-engine/src/lib.rs`).** New storage `TotalOiPolicyBps` (running sum, maintained incrementally in `set_oi_policy`) and `MaxTotalOiPolicyBps` (opt-in ceiling, absent = uncapped, matching `OiPolicy`'s own default). `set_oi_policy` now rejects a change that would push the sum of every market's bps past the configured ceiling (`CoreError::AggregateOiPolicyExceeded`), and updates the running total on add/update/remove. New readers `total_oi_policy_bps`/`max_total_oi_policy_bps` and admin setter `set_max_total_oi_policy_bps`. `set-risk-params.ts` now sets this ceiling to the sum of the per-market caps it configures (or an explicit `--max-total-oi-bps` override) — clearing the ceiling before the per-market loop and setting it once after, to avoid a real ordering hazard where a tightening pass would otherwise be spuriously rejected mid-loop by stale running totals from markets not yet updated.

**Q4 — Bad-debt-gated ADL (`perp-liquidation/src/lib.rs`, `perp-insurance/src/lib.rs`).** New `PerpLiquidationContract::adl(keeper, counterparty, position_id, close_size, execution_price)` entrypoint, permissionless like `liquidate` (safety comes from on-chain checks, not caller restriction):
- Refuses to run unless `insurance.bad_debt_of(asset) > 0` (`CoreError::NoBadDebtToOffset`) — a response to an already-materialised shortfall, never a speculative control.
- Requires the counterparty's position to be in profit at `execution_price` (`CoreError::PositionNotInProfit`), verified via `protocol_core::signed_position_pnl` — a per-position check that needs no global ranking.
- Caps the close size via `mul_div(bad_debt_before, position.size, unrealized_pnl)` — the size cap goes through the position's own per-unit pnl (pnl scales with `size × (price − entry)`, not `size × price`), so the realized payout can never exceed the fund's actual recorded shortfall regardless of the requested size or the asset's price level.
- Reuses the existing, already-tested `engine.liquidate_reduce` mechanically (no new engine entrypoint needed — the mechanical reduce-and-apply-pnl step is identical to liquidation; only the caller-side preconditions differ).
- New `perp-insurance::reduce_bad_debt`, gated the same as `pay_liquidator`, clears the offset amount from recorded bad debt as it's paid out — otherwise the same shortfall would be double-counted as both pending and paid.
- Covered by 3 new tests in `perp-liquidation`: the happy path with hand-derived exact numbers (cap binds at 10 of a requested 100 units, bad debt clears from 900 to 0), refusal with no bad debt, and refusal against a losing counterparty.

No reward/incentive was added for the ADL keeper in this pass — the fund is typically near-depleted exactly when bad debt exists, so a mandatory reward paid from insurance could make ADL fail precisely when it's needed most. Keeper economics for ADL is flagged as a follow-up design question, not solved here.

**Q4 — Staked backstop pool (`perp-insurance/src/lib.rs`).** A cash-based, NAV-priced staking layer, added as its own separate ledger rather than sharing the existing donation pool:
- New `stake`/`request_unstake`/`withdraw_unstaked` on a fresh `StakedBalance(asset)`/`Shares(asset, staker)`/`TotalShares(asset)` ledger, completely separate from the existing `Balance(asset)` that plain `deposit()` donations and liquidation payouts use.
- **Real exploit found and fixed before it shipped**: pricing staker shares against the *existing* pooled `Balance` (which already holds prior donations) would let the very first staker walk away with every donation made before any shares existed, since there is no prior share supply to price that capital against. Fixed by giving staked capital its own ledger, `StakedBalance`, that plain donations never enter — confirmed by a dedicated test (`first_staker_gets_shares_1to1_and_cannot_claim_prior_donations`).
- 7-day cooldown (`UNSTAKE_COOLDOWN_SECS`) between `request_unstake` and `withdraw_unstaked`, priced at withdrawal time rather than request time, so a staker cannot dodge a loss they saw coming by requesting first — verified by `a_sweep_between_request_and_withdrawal_is_absorbed_by_the_staker`.
- Losses only ever enter via a new, explicit, admin-gated `sweep_to_operating(asset, amount)` that moves capital from the staked ledger into the existing operating `Balance` — a deliberate, visible, timelock-inherited governance action, never an automatic draw from `liquidate`/`absorb_bad_debt`. This was a scope decision, not an oversight: those are among the most sensitive, already-hardened paths in the protocol (C1, KRY-Q4), and wiring a brand-new capital source directly into them is exactly the kind of change that produces the next incident if rushed.
- `share_price` reader (NAV per share, `PRECISION`-scaled) so a staker or the UI can see a sweep's effect before deciding whether to stake or unstake.
- 6 new tests in a fresh `perp-insurance` test module, standalone (no engine/vault/liquidation wiring needed for this feature).

**Q10 — Migration import tooling (`perp-vault/src/lib.rs`, `perp-engine/src/lib.rs`).** The specific gap the migration plan flagged — "a one-time `migrate_*` batch-import entrypoint (doesn't exist yet)" — has been built:
- `perp-vault::migrate_import_balances(entries: Vec<MigratedBalance>)`: admin-gated, credits the internal ledger for a batch of `(user, asset, amount)` from an export, updates `TotalDeposited` so post-migration deposit caps are judged against real starting balances rather than zero, and records `UserAssets` so multi-collateral health lookups work immediately. Explicitly does **not** move tokens — the real tokens backing every imported balance must be deposited into the new vault's custody as its own step in the migration runbook, documented in the function's own doc comment so this can't be missed.
- `perp-engine::migrate_import_positions(entries: Vec<MigratedPositions>)`: admin-gated, seeds `Positions(user)`, recomputes `OpenInterest`/`LongOpenInterest`/`ShortOpenInterest` from the imported positions, and advances `NextPositionId` past every imported id so a position opened after migration can never collide with one imported from the old deployment. Also calls into the vault's existing `sync_positions` for each migrated user — a real gap caught while implementing this: the vault keeps its own mirrored copy of positions for `account_health`, normally kept current by every trade calling back into it, which a direct storage seed would otherwise have left stale, silently breaking health checks for every migrated account until they next traded. Verified by a test asserting `account_health` reflects an imported position immediately.
- Both entrypoints are callable repeatedly in batches (a full account export will rarely fit one transaction) until a separate `seal_migration()` call closes the window for good — tested to confirm a second import attempt after sealing is rejected.

**What was deliberately NOT done for Q10**: no mainnet contract was redeployed, no mainnet state was exported, and no funds were moved. That requires live admin credentials, a real multi-day operational sequence (account enumeration via the off-chain indexer, exported-vs-on-chain reconciliation, an atomic client/keeper/oracle cutover), and explicit, step-by-step authorization that goes well beyond what should happen inside a coding session. The code built here is the tooling that sequence will need when it's actually scoped and run.

---

*Investigation performed via parallel deep-dive agents, each independently re-verifying source and live on-chain state rather than trusting the prior audit's descriptions. Two findings in the original audit session were previously withdrawn as incorrect; the same scepticism was applied here — all four items above were confirmed true, with several materially refined (Q10's scope, Q11's aggregate-exposure math, Q5-F's unreachability) beyond the original framing. Q4, Q11, and Q5-F were subsequently implemented and tested; Q10's migration tooling was built and tested, but its live execution against mainnet remains a separate, unstarted operations project requiring dedicated scoping and explicit authorization at each step.*
