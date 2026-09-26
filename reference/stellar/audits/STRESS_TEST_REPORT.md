# Kryon Economic Stress Test Report — Testnet, 2026-07-05

Harness: `client/scripts/stress-test.ts` (`npm run dev:stress`,
`STRESS_SCENARIOS=a,b,c` selectable), run against the LIVE testnet deployment
(Vercel app + PM2 services + Neon DB + 2026-07-05 contracts: engine
`CBSUYAO2…GTXN`, gateway `CAJGC2SI…ONL3`, vault `CBQ6634Z…TRYK`). Small sizes
throughout (≤ 40 USDC notional, throwaway friendbot wallets).

## Scenario results

| Scenario | Result | Evidence |
|---|---|---|
| (a) oracle gap — fail-stop + recovery | **PASS** | Baseline pair settled on-chain (TxJob CONFIRMED). Oracle paused 130 s (> engine `max_oracle_age_secs` = 120): crossed pair matched off-chain but **no settlement occurred** — engine fail-stop held. Oracle resumed: fresh pair settled within the poll window. |
| (b) liquidation near max leverage | **PASS** (after P0 remediation, 2026-07-06) | 200-XLM long (~8x on 5 USDC) opened and settled. Synthetic −10 % publish: `liquidatable=true`. **kryon-liquidator autonomously closed the position.** Victim internal balance 5.0000→1.0122 USDC (realized loss); insurance 18.5659→18.3864 (reward paid); liquidator wallet +0.1795 (== insurance decrease); **token-reserve drift 0.0000 USDC**; bad debt 0. See resolution section. |
| (c) burst load — 2x (`CONCURRENCY=40`, 30 s/endpoint) | **PASS** | 12/12 endpoints healthy on the clean run (~2.6 k req per endpoint, p50 ≈ 350 ms, p95 ≈ 400–500 ms, err 0 %). One earlier run during degraded local network showed the rate-limit abuse probe at p95 26 s / 9.2 % non-4xx — see recommendation 5. |

## ✅ P0 RESOLVED (2026-07-06) — fresh liquidation + insurance, proven end-to-end

Option 2 (below) was executed. Summary:

- **Deployed fresh instances** wired to the CURRENT core:
  - liquidation `CDCRNKXTTTOO7IRVC66KZR5QMVGGZIOF2QPJSVELLD7G7F4IVLM2DCMG`
  - insurance `CA3VD55APWCYLVN7PYGJ7NPKSQBE3VU4MWVCSKLOYAZI5RFWWR76G2CL`
  - `liquidation.initialize(admin, engine=CBSUYAO2, vault=CBQ6634Z, insurance=CA3VD55A, USDC, max_reward_bps=50)`; `engine.set_liquidation/set_insurance`; `vault.set_liquidation/set_insurance`; `insurance.set_vault`. Cross-wiring verified by direct instance-storage reads. Tool: `client/scripts/rewire-liquidation.ts`.
  - Insurance **seeded 20 USDC** (`insurance.deposit`).
- **Three real bugs surfaced and fixed while proving it** — a diagnostic ladder:
  1. `Error #6` (wrong-engine/stale) → the original P0; gone once liquidation pointed at the live engine.
  2. `Error #19 InsuranceFundInsufficient` → the fund was empty (first seed of 500 USDC silently failed — exceeded the deployer's ~36 USDC balance). Re-seeded 20 USDC; verified internal == actual token balance.
  3. `Error #13` (from the USDC token contract) → the **liquidator wallet had no USDC trustline**, so the reward payout trapped. Added the trustline.
- **Conservation proven correctly.** The harness originally summed vault *internal balances*, which ignore (a) the victim's realized loss retained as vault reserves backing the counterparty's open position and (b) the reward leaving insurance into the liquidator's *wallet* — showing a phantom −5.43 USDC "drift". Fixed the check to measure real **token reserves** (vault + insurance + liquidator wallet). Result: **drift 0.0000 USDC** — the protocol neither creates nor destroys USDC through a liquidation.

**Verified live 2026-07-06:** position opened at 8x, crashed −10%, flagged liquidatable, and the running `kryon-liquidator` on the Oracle Cloud VM closed it autonomously with the insurance reward paid and zero bad debt.

### Mainnet guard for this class of bug
The deploy manifest must fail if any live contract references a non-manifest
address, and the ceremony must verify every target's on-chain admin AND its
stored engine/vault pointers before launch. Insurance must be seeded (and its
sizing validated) as a launch prerequisite, and every keeper wallet must hold
a settlement-asset trustline.

## Original P0 finding (historical) — liquidation & insurance wired to the DEAD June core

**Contract-level deployment gap. Per instructions, STOPPED — no contract
deploys or Rust changes were made. This must be resolved before any further
mainnet-readiness claims: the protocol currently has NO working liquidation
path, so underwater positions accrue toward bad debt unchecked.**

- The 2026-07-05 core redeploy replaced vault/engine/gateway/risk but kept the
  June `perp-liquidation` (`CCIDLNMN…NRWK`) and `perp-insurance`
  (`CD45VRVG…54KT`) instances. Their stored `Engine`/`Vault` addresses still
  point at the superseded June contracts; `liquidate()` therefore routes
  health checks through the dead core and deterministically fails
  (`StaleOracle` #6 — observed on every attempt for every candidate, with
  perfectly fresh oracle data).
- The insurance contract's stored vault is likewise the June vault, so
  `cover_deficit` / `absorb_bad_debt` for the NEW vault cannot work either.
- Both contracts expose exactly the setters this needs (`set_engine`,
  `set_vault`, `set_liquidation` — the code comment even anticipates this
  failure mode), **but their admin is the ORIGINAL deployer
  `GBTL7SKB…TGDI`, whose key is not on this machine** (same blocker as the
  governance ceremony — see
  `kryon-protocol/infra/deploy/runbooks/governance-admin-transfer.md`).

Remediation options (operator decision required):

1. **Recover the original deployer key**, then as that key:
   `liquidation.set_engine(new)` + `set_vault(new)`;
   `insurance.set_vault(new)` (+ `set_liquidation` if a new liquidation is
   deployed); then `nominate_admin(governance)` on both.
2. **Deploy fresh liquidation + insurance instances** (current audited-freeze
   source, current deployer as admin), wire via
   `liquidation.initialize(admin, engine, vault, insurance, USDC,
   max_reward_bps)`, `insurance.initialize(admin, liquidation)` +
   `insurance.set_vault(vault)`, and on the new core (current-admin):
   `engine.set_liquidation/set_insurance`, `vault.set_liquidation/
   set_insurance`; seed the insurance fund; update all configs; add both to
   the governance ceremony. WASMs already build cleanly
   (`stellar contract build`, `target/wasm32v1-none/release/`).
   Then re-run `STRESS_SCENARIOS=b npm run dev:stress` — the harness's
   conservation check (Σ balances of victim+maker+liquidator+insurance
   pre/post, plus bad-debt delta) is ready to produce the missing numbers.

**On mainnet this class of error must be structurally impossible:** the
deploy manifest should fail if any live contract references a non-manifest
address (cross-wiring check), and the ceremony runbook now requires verifying
every contract's on-chain admin before phase 1.

## Off-chain bugs found and FIXED during this exercise

### F1 — API accepted order signatures the chain can never verify
`verifySignedMessage` accepted raw-ed25519 and bare-sha256 alongside SEP-53,
but `settle_fill_signed` verifies **SEP-53 only**. Orders signed with legacy
schemes passed `/api/orders`, matched, then failed on-chain forever
(`Error(Crypto, InvalidInput)`). → `signed-intent.ts` is now SEP-53-only,
keeping API admission in lockstep with the contract.

### F2 — matcher loops forever on deterministically-unsettleable fills
match → settle-sim fails → rollback → re-match every ~2 s, indefinitely.
Observed live twice: F1 orders, and two real testnet wallets crossing at
±100 % of mark (`PriceOutsideBand` #16, every 2 s for over an hour).
→ matcher-service.ts now (1) verifies stored signatures off-chain before
matching and cancels orders that cannot verify; (2) excludes resting orders
outside the oracle band (`MATCHER_MAX_DEVIATION_BPS`, default 1000 = engine
band) from the matching set — exclusion, not cancellation, so far-from-market
limits become matchable again when price reaches them. The exclusion must
happen **before** matchAll: price-time priority otherwise allocates incoming
volume to an unsettleable top-of-book quote, starving legitimate orders
behind it (observed: a stale $0.0996 ask absorbing every long at $0.199).

### F3 — liquidation keeper could never read the oracle (→ never liquidate)
`liquidation-keeper.ts` called `get_price(symbol)` against the current
`get_price(symbol, Option<OracleGuard>)` ABI — every simulation failed and
every candidate was skipped with "no fresh oracle price". The keeper has
never successfully liquidated anything on this deployment. → fixed (pass
`None` guard; engine enforces banding at execution). The same stale-ABI bug
existed in `monitor.ts` (fixed earlier today). **Lesson: any script that
still passes only one arg to `get_price` predates the oracle-guard ABI.**

### F4 — legacy soak-test signed with a dead scheme
`soak-test.ts` used the pre-settlement `orderSigningMessage` raw scheme; with
F1 fixed those orders are now rejected at the API instead of poisoning the
book. → soak-test signs SEP-53 now. Its legacy direct-submission settle path
is obsolete (matcher settles autonomously) — harmless, replace on next use.

### Non-finding: 90 s oracle gaps are within design tolerance
Deployed XLM-PERP `max_oracle_age_secs` = 120. A settlement at ≤ 120 s of
staleness is correct behavior; the fail-stop verifies at > 120 s.

## Parameter recommendations

1. **Leverage tiers**: client now advertises 10x/50x/20x = 1/initialMarginBps
   (this phase). Keep BTC/ETH OFF until each has its own liquidation drill —
   which requires the P0 fix first.
2. **`max_oracle_age_secs`**: 120 s ≈ 15 missed publishes at the 8 s cadence.
   For mainnet consider 60 s (market-config change via governance after the
   transfer executes).
3. **Matcher band**: keep `MATCHER_MAX_DEVIATION_BPS` equal to the engine's
   `max_execution_deviation_bps` (1000); change both together.
4. **Insurance seed**: cannot be sized from measurement until the P0 is fixed
   and scenario (b) produces conservation numbers. Directionally: observed
   loss-at-liquidation for a max-size testnet position (40 USDC notional,
   −10 % move) is ~4 USDC; a 100 USDC testnet seed covers dozens of events.
   Mainnet sizing must scale with `max_open_interest`.
5. **Rate-limit backend**: under 40-worker abuse of an invalid-address route
   during degraded network, the in-process fallback showed p95 26 s. Prod
   must run with Upstash configured (fail-closed already enforced) — worth a
   dedicated 2x load run against the CF Workers deployment after cutover.

## Operational notes

- Harness pauses `kryon-oracle` (shared deployer key + staleness scenarios)
  and, in scenario (b), publishes synthetic XLM prices. **TESTNET ONLY.** It
  restarts the oracle in `finally`/fatal handlers.
- Local network flakiness (Neon + Soroban RPC `ETIMEDOUT`) required
  retry-hardening of every chain/DB read in the harness; those retries are
  now part of `stress-test.ts`.
- The PM2 daemon died once during the degraded-network window and its dump
  was re-saved while empty; recovered via `dump.pm2.bak` → `pm2 resurrect`
  → `pm2 save`. All 7 services back online (verified via kryon-monitor).
- Residual harness limit orders rest in the book until their 1 h expiry;
  the monitor's matcher-lag check flags them until then (self-heals).
