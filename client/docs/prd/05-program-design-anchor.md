# 05 — `floydex_perps` Anchor program design

Target: Anchor 0.31.1, Solana 2.1 (Agave), `token_interface` (SPL Token and
Token-2022). One program, internal modules. Big accounts use zero-copy
(`#[account(zero_copy)]` + `AccountLoader`).

## 1. Accounts (PDAs)

| Account | Seeds | Key fields | Size target |
|---|---|---|---|
| `Exchange` | `["exchange"]` | `admin` (Squads vault), `pending_admin`, `guardian`, `operators: [Pubkey; 4]`, `paused: bool`, `fee_config`, `insurance`, `domain: [u8; 32]` (a hash of the cluster genesis hash and program id), `max_total_oi_policy_bps`, `bump` | < 1 KB |
| `Market` (zero-copy) | `["market", market_id: u16]` | `MarketConfig` fields; `pyth_feed_id: [u8; 32]`; `SessionPolicy`; `calendar: [SessionWindow; 16]` ring; `FundingConfig`, `FundingState`; `oi_long`, `oi_short`; `last_oracle_price`, `last_oracle_publish_time`; `closed_since`; `mark_ema`, `mark_ema_updated`; `oi_policy_bps`; `max_execution_deviation_bps` | ~1.5 KB |
| `Collateral` | `["collateral", mint]` | `mint`, `token_program`, `vault` (token account PDA `["vault", mint]`), `decimals`, `haircut_bps`, `pyth_feed_id`, `deposit_cap`, `total_deposited`, `active` | < 300 B |
| `UserAccount` (zero-copy) | `["user", owner, sub_id: u8]` | `owner`, `delegate`, `delegate_expiry`, `balances: [Balance; 8]` (collateral index + `i128` amount), `positions: [PositionSlot; 16]`, `cancel_all_below_nonce: u64`, `next_position_id`, counters | ~2.2 KB |
| `OrderRecord` | `["order", owner, sub_id: u8, nonce: u64 LE]` | `filled: i128`, `cancelled_until: u64` (tombstone), `expiry_ts`, `payer` | 80 B, closed on reclaim |
| `Insurance` | `["insurance"]` | `usdc_vault`, `fund`, `total_shares`, `bad_debt`, `epoch`, `unstake_cooldown_secs` | < 300 B |
| `StakePosition` | `["stake", owner]` | `shares`, `pending_unstake_shares`, `unlock_ts`, `epoch` | < 200 B |

Notes:
- **`positions: [PositionSlot; 16]`** — `risk-engine` caps a health computation
  at 64 positions (`MAX_POSITIONS_PER_ACCOUNT`). 16 is plenty and keeps
  compute bounded. Close a slot to free it.
- Convert `PositionSlot` ↔ `protocol_core::Position` at the boundary. Keep
  on-chain layouts `Pod`, and keep `risk-engine` free of Anchor.
- **Health needs every market in the account.** `remaining_accounts` carries
  the `Market` account and Pyth `PriceUpdateV2` for each open position.
  Validate each against `Market.pyth_feed_id`, then build `MarketSnapshot`s
  (a slice, which implements `MarketLookup`).
- **Settlement collateral at par (decided 2026-09-26).** Exactly one
  `Collateral` is flagged as the settlement asset (USDC). Realized PnL, fees
  and funding settle in it, and it is valued at exactly 1.0 with no oracle, so
  a missing USDC feed can never block settlement (`11` L2). Every other
  collateral must carry a Pyth feed id, checked at `add_collateral`.
- **Rounding against the user (decided 2026-09-26).** Realized PnL rounds
  toward −∞ and fees round up, so dust always stays with the protocol. This
  lives in the program; `protocol-core` gained `mul_div_floor`/`mul_div_ceil`
  alongside the unchanged truncating `mul_div`.
- **Platform fee (decided 2026-09-28).** Every fill charges 1% (`PLATFORM_FEE_BPS`
  = 100) on both sides — buy and sell, maker and taker. Fees debit settlement
  collateral and accrue in `Collateral.fees_accrued` until permissionless
  `collect_fees` sends them to `Exchange.fee_collector`
  (`HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn`). Cap stays 1% a side.
- Fixed-point: `protocol_core::PRECISION = 1e18` for prices and sizes, exactly
  as on Stellar. Convert token amounts (USDC 6 decimals, xStocks ~8 decimals,
  **verify per mint**) at the vault edge only.

## 2. Instructions

### Admin (Squads multisig through the time lock)
`initialize_exchange`, `nominate_admin`, `accept_admin`, `set_guardian`,
`set_operators`, `set_fee_config`, `set_fee_collector`, `create_market`, `update_market`
(risk params, session policy, funding config, OI policy),
`add_collateral`, `update_collateral` (haircut, cap, active),
`set_max_total_oi_policy_bps`, `unpause`.

### Guardian (hot key)
`pause` only. Unpausing needs the admin. This is stricter than Stellar, where
the admin did both.

### Calendar authority (keeper key, admin-assigned)
Pulled into Phase 1 (decided 2026-09-26): without a posted calendar every
market resolves to Closed. While Closed and before the Phase 2 mark EMA, the
mark is `closed_mark_price(last_oracle, last_oracle)`.

`post_session_calendar(market, windows[])`: only future windows, only
append/replace ahead of now. It can never rewrite the window currently in
effect.

### User (owner signs)
`init_user(sub_id)`, `set_delegate(delegate, expiry)`, `revoke_delegate`,
`deposit(mint, amount)`, `withdraw(mint, amount)` (health check via
`validate_withdrawal`), `cancel_order(nonce, expiry_ts)` (writes the
`OrderRecord` tombstone), `cancel_all(below_nonce)`.

### Operator (matcher)
`settle_fills(fills: Vec<FillArgs>)`. For each fill:
1. Check the operator is in `Exchange.operators` and the exchange is not
   paused.
2. **Verify the maker and taker signatures via Ed25519 introspection** (§5).
   The signer must be the owner, or a delegate that hasn't expired.
3. `validate_fill`, **copied from the Stellar gateway**:

   | Check | Error |
   |---|---|
   | `fill_size > 0 && fill_price > 0` | InvalidAmount |
   | `maker.owner != taker.owner` | SelfTrade |
   | `market_id != 0 && maker.market_id == taker.market_id` | InvalidConfig |
   | `maker.is_long != taker.is_long` | DirectionMismatch |
   | `now <= expiry_ts <= now + 7d` (MAX_ORDER_TTL_SECS) | OrderExpired |
   | not tombstoned, `nonce >= cancel_all_below_nonce` | OrderCancelled |
   | `filled + fill_size <= size` | OrderOverfilled |
   | long: `price <= limit`, short: `price >= limit` | PriceOutsideBand |
   | `\|price − mark\| <= max_execution_deviation_bps` | PriceOutsideBand |
4. Resolve the session (`resolve_session`). If the fill **increases**
   exposure, require `may_increase_exposure`.
5. Position effects (unchanged from Stellar): opposite position → reduce, then
   open the residual unless reduce_only; same side → increase with VWAP;
   none → open.
6. Fees; update OI; update `mark_ema` if Closed; require **session-scaled
   initial margin** for each side (`session_margin_bps`).
   **Reduce-only relief (decided 2026-09-26):** a side whose fill only
   reduced its exposure (no open, increase or flip) also passes if its
   health did not worsen: free collateral (equity − session-scaled initial
   margin) after the fill ≥ before. Stellar required initial margin on every
   fill, which trapped accounts below the requirement (e.g. when margin
   doubles at the close) until liquidation.
   **Tightened for liquidatable accounts (decided 2026-09-26):** if the side
   was liquidatable before the fill (session-scaled maintenance) and still
   misses initial margin after it, the fill price must be at or better than
   the mark for that side (a seller at ≥ mark, a buyer at ≤ mark), else
   `LiquidatableReduceOffMark`. Without it, an accomplice could buy a
   near-bankrupt position below the mark: the margin a reduce releases
   outweighs the equity it gives away, so health "improves" while the
   account goes negative and the insurance fund pays the accomplice. Chosen
   over "equity may fall by at most the fee" because the two are the same
   rule (the equity change of a reduce is `−fee + size·(price − mark)·dir`),
   and the price form is exact where the equity form needs a rounding
   tolerance (realized PnL floors, unrealized truncates). A side that meets
   initial margin after the fill keeps positive equity, so it is unaffected.
7. Create or update `OrderRecord` (the operator pays rent).

`reclaim_order_state(owner, nonce)`: after `max(expiry, tombstone)`, close the
`OrderRecord` and return rent to its payer.

### Permissionless keepers
`update_funding(market)` (hourly; premium from mark vs. index;
`MAX_FUNDING_ELAPSED_SECS` cap).
`collect_fees` (drains `fees_accrued` of the settlement collateral to
`Exchange.fee_collector`).

**`update_funding` as built (decided 2026-09-26):**
- Premium = the book against the index, never OI imbalance (`11` L8). In
  session: `(mark_ema − oracle) / oracle`. Closed:
  `(closed_mark_price(last_close, mark_ema) − last_close) / last_close`
  (`07` §4). Halted: 0. Also 0 when `mark_ema` is older than
  `MARK_EMA_MAX_AGE_SECS` = 900 s (no fill or posted mid in 15 min):
  a stale book price against a moving oracle is not a premium.
- No minimum interval: each call charges `rate × elapsed` with elapsed
  capped at 1 h, so calling more often only samples the premium more often
  (closer to a TWAP). The keeper runs it hourly; anyone may call it.
- Refused while paused: positions can't be closed then, so they shouldn't
  be charged. The first call after unpausing charges at most 1 h.
- Positions settle funding on their next fill (rounded against the holder);
  health counts the pending amount through the market's indexes.

`liquidate(user, position_id)` (uses
`plan_liquidation`; reward ≤ `max_reward_bps` ≤ 10%; the deficit goes to the
insurance fund; bad debt is recorded), `adl(...)` (only when
`Insurance.bad_debt > 0`, only against profitable positions, the same rules
as Stellar Q4).

**`liquidate` as built: position transfer (decided 2026-09-26, with the
owner).** Stellar closed only the distressed side against nobody, which
leaves OI one-sided (§7.3) and makes the protocol the silent counterparty.
Here the liquidator's own `UserAccount` (signed by its owner, never the
liquidated owner) takes the slice at the mark, like a fill:
1. Refused while paused, while the market is Halted (`07` §2: the mark is
   stale), before `init_insurance`, and for a healthy account. Maintenance
   is session-scaled and ramped, except inside a close's grace window for an
   account that added no exposure since the ramp began (`07` §2).
2. Size from `plan_liquidation`, per step capped at
   `Exchange.partial_liquidation_bps`.
3. The user pays `liquidation_fee_bps` of the closed notional; the
   liquidator gets `min(penalty, max_reward_bps · notional)`, the rest goes
   to the insurance fund. `max_reward_bps` must be in (0, 1,000]: zero
   would switch liquidation off economically.
4. The user's shortfall (maintenance − equity) must strictly shrink (§7.5).
5. A negative settlement balance is covered first by the user's other
   collateral, **sold to the liquidator** at its haircut value, lowest
   haircut first (Stellar `seize_for_deficit`). Each mint's ledger still
   balances and no protocol-owned inventory appears; the haircut is the
   liquidator's discount. A partial take rounds up (against the user) and
   credits exactly the debt.
6. If equity is still negative, `min(−equity, −settlement balance)` is
   covered by the fund, and what the fund can't cover is written off into
   `Insurance.bad_debt` (Stellar `absorb_bad_debt`). The user's balance
   returns to zero; it is never covered beyond −equity, since other
   positions may still be in profit.
7. The liquidator must meet initial margin afterwards (or only have reduced
   its own exposure without worsening health), exactly like a fill.

Measured: 155k CU with one position on each side (LiteSVM).

**`adl(winner_position_id, counterparty_position_id)` as built (decided
2026-09-26, with the owner).** Refused unless `Insurance.bad_debt > 0`
(Stellar Q4, `11` L12), while paused, or while the market is Halted. The
keeper names a position in trade profit at the mark and an opposite
position in the same market (in another account). Both close against each
other at the mark, so OI stays two-sided. The size is capped at
`⌈bad_debt / profit per unit⌉`, so a bad target costs at most one bounded
call. The winner's realized PnL (funding included) is cut by
`min(pnl, bad_debt)`, which pays the debt down; the counterparty closes at
the mark, which costs it nothing against the mark. Stellar instead credited
the winner in full and reduced `bad_debt` by the same amount, which moved the
shortfall between ledgers without closing it.

**OI against the fund (Stellar `require_insurance_headroom`, Q11).** A market
with `oi_policy_bps > 0` refuses any fill that adds exposure once
`notional(oi, mark) > (fund − bad_debt) · oi_policy_bps / 10⁴`
(`InsuranceFundInsufficient`); exits are never blocked. `settle_fills` takes
the `Insurance` account as an optional account for this. The aggregate
`Σ oi_policy_bps ≤ max_total_oi_policy_bps` is checked at `create_market`,
and `set_max_total_oi_policy_bps` may not set the ceiling below what markets
have already committed.

**`plan_liquidation` sizing fixed (decided 2026-09-26, with the owner).**
The Stellar formula closed notional equal to the shortfall. Closing at the
mark only releases `maintenance_bps − fee_bps` of each unit, so a step
cleared about a tenth of the shortfall, liquidations crawled geometrically,
and a bankrupt account never fully closed. Now a step closes
`⌈shortfall / (price · (mm − fee))⌉`, the smallest slice that restores
maintenance after the penalty, still `min`'d with the per-step cap (the L9
fix stands). It closes in full when that exceeds the position or when
`fee ≥ mm`. One step now restores a partially underwater account; a
bankrupt one closes in full.

### Insurance
`stake`, `request_unstake`, `withdraw_unstaked`, internal `cover_deficit`, and
retire shares when a loss wipes the pool.

**As built (decided 2026-09-26):**
- The fund's tokens sit in the settlement collateral's vault as a ledger
  entry (`Insurance.fund`, like `fees_accrued`), so conservation stays one
  equation per mint: `vault + bad_debt ≥ balances + fees + fund + Σ upnl`,
  with equality (to dust) when flat. `usdc_vault` records that vault.
- One pool, unlike Stellar's separate staked/operating balances with an
  admin sweep: `fund` is the stakers' NAV. Penalties grow it and
  `cover_deficit` draws it down directly. Stellar's explicit sweep existed
  to keep a new capital source out of hardened paths; here the waterfall is
  one instruction with its own tests.
- `stake` mints at NAV before the deposit (1:1 for the first staker or
  after a wipe). `request_unstake` → `unstake_cooldown_secs` (≤ 90 days) →
  `withdraw_unstaked` redeems at the NAV at withdrawal, in whole token
  units (sub-unit dust stays in the fund). Pending shares still absorb
  losses. One request at a time. `stake` stops while paused; withdrawing a
  matured request does not.
- A loss that takes `fund` to zero with shares outstanding bumps `epoch`
  and zeroes `total_shares` in one write; older positions are worth nothing
  and are reset on next touch.

## 3. Events (for the indexer)
`Deposit`, `Withdraw`, `FillSettled{market, maker, taker, size, price, maker_fee, taker_fee}`,
`FeesCollected{mint, collector, amount}`,
`PositionChanged`, `FundingUpdated`, `Liquidated`, `Adl`, `BadDebt`,
`SessionChanged`, `DelegateSet`, `OrderCancelled`. Use `emit_cpi!` so events
survive log truncation.

## 4. Order message (what the session key signs)

A compact binary layout, Borsh, little-endian, **108 bytes**:

```
0   8  magic        "FLOYDEX\0"
8  32  domain       sha256(genesis_hash || program_id)   // blocks cross-cluster/cross-deploy replay
40 32  owner        user wallet pubkey (NOT the delegate)
72  1  sub_id       u8, the UserAccount the order trades from
73  2  market_id    u16
75  1  flags        bit0 is_long, bit1 reduce_only, bit2 post_only; other bits must be 0
76  8  size         u64 (base units, 1e9 scale — narrowed from i128 on the wire)
84  8  limit_price  u64 (1e9 scale)
92  8  nonce        u64
100 8  expiry_ts    u64 (unix secs)
```

`sub_id` was added on 2026-09-26 (it was 107 bytes). Without it, the operator
could settle an order signed for one sub-account against another sub-account
of the same wallet. The self-trade check still compares wallet owners.
A program can't read the genesis hash, so `domain` is computed off-chain, stored
in `Exchange.domain` at `initialize_exchange`, and checked by the deploy
script (`11` L3).
Rules:
- **Golden test:** TS `encodeOrder()` and Rust `OrderMsg::try_to_vec()` must
  produce identical bytes for fixed vectors. This is the same discipline as
  Stellar's `canonical_digest_matches_offchain_golden`. Keep the vectors in
  `sdk/conformance/`, the way FloyDexSDK does.
- On-chain, widen `u64` → `i128` PRECISION (×1e9) before using `risk-engine`.
- The cancel message has its own magic `"KRYCANv1"`, so a signed order can
  never double as a cancel.

## 5. Ed25519 verification: the part that gets people hacked

The transaction carries one or more `Ed25519Program` instructions before
`settle_fills`. Inside `settle_fills`:
1. Load the `Instructions` sysvar and read the instruction at the index the
   caller claims. **Require `program_id == ed25519_program::ID`.**
2. Parse the `Ed25519SignatureOffsets` for each signature. **Require every
   `*_instruction_index == u16::MAX`** (meaning "this same instruction"). If
   an offset points at another instruction, an attacker can make the precompile
   verify bytes you never inspected. This is the classic ed25519-introspection
   bug class.
3. Compare the **pubkey bytes** at `public_key_offset` with the expected
   signer (owner or delegate), and the **message bytes** at
   `message_data_offset..+size` with the order you re-encoded from the
   `FillArgs`. Compare full bytes, not a prefix.
4. Reject if any check fails. Write tests where each of those checks is
   violated individually.

## 6. Compute and size budget (targets to measure early)

| Path | CU target |
|---|---|
| `settle_fills` with 1 fill, 2 users with 3 positions each | < 250k |
| `liquidate` with 5 positions | < 300k |
| `withdraw` with 8 positions | < 250k |

Request 400k CU per transaction plus a priority fee. `mul_div` uses `ethnum`
I256; benchmark it in Solana BPF during week 1. If it's heavy, replace it
with `u128` mul-div with overflow checks (inputs are bounded).

### Measured: `settle_fills` (LiteSVM, 2026-09-26)

| Path | CU | Tx size |
|---|---|---|
| 1 fill, fresh positions, creates both `OrderRecord`s | 131,864 | 1,150 B legacy (limit 1,232) |
| 1 fill, maker also holds a second market | 162,612 | — |
| 2 fills in one instruction | 272,682 | needs an address lookup table |

The SBF heap is a 32 KB bump allocator that never frees, so health code
sizes every allocation exactly; more than 2 fills per instruction is
untested against the heap limit.

One fill per legacy transaction fits. Two fills per transaction need a v0
transaction with an address lookup table (matcher, Phase 3).

### Measured: `mul_div` in SBF (2026-09-26)

Measured in LiteSVM 0.7.1 on platform-tools v1.43, release build, one call
per measurement via `sol_remaining_compute_units` (`--features bench`,
`integration/tests/bench.rs`). These are prototypes, not protocol code: the
crates still use I256.

| Case | I256 (current) | u128 fast path, I256 fallback | 64-bit limbs, u64 denominator |
|---|---|---|---|
| bps on 1e18 (`100e18·50/1e4`) | 3,773 | 440 | 1,021 |
| `mul_precision(2e18, 3e18)` | 4,255 | 824 | 1,404 |
| notional `1e6e18 · 250e18 / 1e18` | 5,433 | 5,683 (falls back) | 1,562 |
| negative pnl | 5,305 | 5,551 (falls back) | 1,675 |
| near the i128 limit / 1e18 | 5,979 | 6,232 (falls back) | 1,776 |

All prototypes returned results identical to I256 on these inputs. I256 was
too heavy: a health check does about 7–8 `mul_div`s per position, so two users
with 3 positions each spent ~225k CU on math alone.

**Decision (2026-09-26): adopted the limb path in `protocol-core`.**
`mul_div` now uses an exact 256-bit product in u64 limbs plus division by a
u64 denominator, and falls back to I256 (`mul_div_i256`) for denominators
wider than u64. A differential proptest (200k cases per run, plus an
edge-case grid including `i128::MIN/MAX`) pins bit-identical results.
Measured after the switch: **761 / 1,144 / 1,302 / 1,411 / 1,516 CU** for the
five cases above.

## 7. Invariants to fuzz (Trident or proptest on `risk-engine`)

1. Conservation (decided 2026-09-26), per mint. Realized PnL is paid out of
   the pool while the counterparty's loss is still unrealized, so a plain
   balance sum can't match the vault while positions are open. Instead:
   - **Solvency, always:** user balances + fees + insurance + Σ unrealized PnL
     of every open position (one common price) ≤ vault tokens, and short of
     it by at most a few base units per fill (rounding goes to the protocol).
   - **Strict, when flat:** once every position is closed, user balances +
     fees + insurance == vault tokens, in token base units.
2. `filled(order) <= size`, always.
3. OI long == OI short per market (every fill is two-sided).
4. A fill never leaves either side below session-scaled initial margin.
5. Liquidation never increases shortfall (`LiquidationWouldNotImproveHealth`).
6. Pause blocks deposit, settle and withdraw-with-positions; it never blocks
   withdrawing idle collateral once the timelock expires (an escape hatch —
   decide explicitly).

**How they are fuzzed (decided 2026-09-26):**
- Crates (proptest, `crates/risk-engine/tests/invariants.rs`): a
  liquidation step strictly shrinks the shortfall (5), never exceeds the
  position or (when partial) the per-step cap, and restores maintenance
  when the cap doesn't bind; withdrawals never leave equity below initial
  margin (4 for withdrawals); funding is zero-sum and capped (1 with 3);
  the mark EMA, the closed mark and the margin ramp stay in their bounds.
  These found that a market with `liquidation_fee_bps ≥
  maintenance_margin_bps` can never be liquidated; `create_market` now
  requires fee < maintenance.
- Program (a randomized LiteSVM harness, `integration/tests/fuzz_program.rs`,
  chosen over Trident: it reuses the test harness and runs in CI in about
  20 s): 6 traders, a keeper and a staker; random fills, price walks and
  ±40% gaps followed by liquidation sweeps, warps, `post_mark`,
  `update_funding`, `adl`, stake/unstake, and Closed/reopen. After every op:
  OI long == OI short == Σ open sizes (3), solvency with the insurance fund
  and bad debt at three prices with only dust as slack (1), and no negative
  fund or bad debt. At the end: every `OrderRecord` has filled ≤ size (2),
  everyone is flattened at the mark, and conservation holds strictly (1).
  It found that liquidation and ADL slices computed at 1e18 left positions
  with sub-order-unit dust that no signed order could close. **Every slice is
  now rounded up to whole order units (1e-9 share, the wire scale), capped
  at the position** (decided 2026-09-26), so positions only ever change by
  whole units.
