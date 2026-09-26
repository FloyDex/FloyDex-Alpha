# 05 — `kryon_perps` Anchor program design

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
| `OrderRecord` | `["order", owner, nonce: u64 LE]` | `filled: i128`, `cancelled_until: u64` (tombstone), `expiry_ts`, `payer` | 80 B, closed on reclaim |
| `Insurance` | `["insurance"]` | `usdc_vault`, `total_shares`, `bad_debt`, `unstake_cooldown_secs` | < 300 B |
| `StakePosition` | `["stake", owner]` | `shares`, `pending_unstake_shares`, `unlock_ts` | < 200 B |

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
- Fixed-point: `protocol_core::PRECISION = 1e18` for prices and sizes, exactly
  as on Stellar. Convert token amounts (USDC 6 decimals, xStocks ~8 decimals,
  **verify per mint**) at the vault edge only.

## 2. Instructions

### Admin (Squads multisig through the time lock)
`initialize_exchange`, `nominate_admin`, `accept_admin`, `set_guardian`,
`set_operators`, `set_fee_config`, `create_market`, `update_market`
(risk params, session policy, funding config, OI policy),
`add_collateral`, `update_collateral` (haircut, cap, active),
`set_max_total_oi_policy_bps`, `unpause`.

### Guardian (hot key)
`pause` only. Unpausing needs the admin. This is stricter than Stellar, where
the admin did both.

### Calendar authority (keeper key, admin-assigned)
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
7. Create or update `OrderRecord` (the operator pays rent).

`reclaim_order_state(owner, nonce)`: after `max(expiry, tombstone)`, close the
`OrderRecord` and return rent to its payer.

### Permissionless keepers
`update_funding(market)` (hourly; premium from mark vs. index;
`MAX_FUNDING_ELAPSED_SECS` cap), `liquidate(user, position_id)` (uses
`plan_liquidation`; reward ≤ `max_reward_bps` ≤ 10%; the deficit goes to the
insurance fund; bad debt is recorded), `adl(...)` (only when
`Insurance.bad_debt > 0`, only against profitable positions, the same rules
as Stellar Q4).

### Insurance
`stake`, `request_unstake`, `withdraw_unstaked`, internal `cover_deficit`, and
retire shares when a loss wipes the pool.

## 3. Events (for the indexer)
`Deposit`, `Withdraw`, `FillSettled{market, maker, taker, size, price, maker_fee, taker_fee}`,
`PositionChanged`, `FundingUpdated`, `Liquidated`, `Adl`, `BadDebt`,
`SessionChanged`, `DelegateSet`, `OrderCancelled`. Use `emit_cpi!` so events
survive log truncation.

## 4. Order message (what the session key signs)

A compact binary layout, Borsh, little-endian, **107 bytes**:

```
0   8  magic        "KRYONv1\0"
8  32  domain       sha256(genesis_hash || program_id)   // blocks cross-cluster/cross-deploy replay
40 32  owner        user wallet pubkey (NOT the delegate)
72  2  market_id    u16
74  1  flags        bit0 is_long, bit1 reduce_only, bit2 post_only
75  8  size         u64 (base units, 1e9 scale — narrowed from i128 on the wire)
83  8  limit_price  u64 (1e9 scale)
91  8  nonce        u64
99  8  expiry_ts    u64 (unix secs)
```
Rules:
- **Golden test:** TS `encodeOrder()` and Rust `OrderMsg::try_to_vec()` must
  produce identical bytes for fixed vectors. This is the same discipline as
  Stellar's `canonical_digest_matches_offchain_golden`. Keep the vectors in
  `sdk/conformance/`, the way KryonSDK does.
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

1. Conservation: sum of user balances + insurance + fee vault == token vault
   balances (per mint), up to rounding in the protocol's favor.
2. `filled(order) <= size`, always.
3. OI long == OI short per market (every fill is two-sided).
4. A fill never leaves either side below session-scaled initial margin.
5. Liquidation never increases shortfall (`LiquidationWouldNotImproveHealth`).
6. Pause blocks deposit, settle and withdraw-with-positions; it never blocks
   withdrawing idle collateral once the timelock expires (an escape hatch —
   decide explicitly).
