# 06 — Oracle: taking Pyth on Solana

**As of 2026-09-26. Pyth changed its access model in Aug 2026, so re-read the
Pyth docs before you sign up.** Sources are in `../sources.md`.

## 1. What changed in 2026, and why it matters

| Date | Change | Impact on Kryon |
|---|---|---|
| 2026-06-15 | Extended-hours US equity feeds (`.PRE`, `.POST`, `.ON`) moved from Pyth Core to **Pyth Pro** | Pre-market, post-market and overnight prices are paid |
| 2026-07-31 / 08-26 | **Pyth Core upgrade**: Hermes requires an API key (`Authorization: Bearer <key>`); unauthenticated calls get 401. New endpoint `https://pyth.dourolabs.app/hermes` | Our pusher needs a paid key. The free tier is view-only, 10 s updates, rate-limited |
| Pricing seen in public sources | Core plans: Starter ~$500/mo, Pro ~$2,500/mo (sub-second). Pyth Pro: US Equities $5,000/mo, All Asset Classes $10,000/mo | Budget line item, see §5 |
| Sept 2026 | Pyth is migrating from Pythnet to **Lazer** infrastructure | Pin SDK versions; watch the changelog |

## 2. How we consume it (the pull model)

On-chain (Rust, inside `kryon_perps`):

```toml
# programs/kryon-perps/Cargo.toml
pyth-solana-receiver-sdk = "<latest compatible with anchor 0.31.1>"
```

```rust
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

// Market stores the feed id; never trust a feed id passed by the caller.
let price = price_update.get_price_no_older_than(
    &Clock::get()?,
    market.max_oracle_age_secs,   // e.g. 10s in session
    &market.pyth_feed_id,
)?;
// price.price: i64, price.conf: u64, price.exponent: i32, price.publish_time: i64
// → rescale to PRECISION (1e18) → protocol_core::OracleSnapshot { source: Pyth, .. }
// → snapshot.validate(now, &OracleGuard { max_age_secs, max_confidence_bps })
```

Account checks: `PriceUpdateV2` is owned by the Pyth receiver program (Anchor
`Account<>` checks this). Require
`verification_level == VerificationLevel::Full` for anything that moves money.
Partially verified updates are fine only for UI simulation.

Off-chain (TypeScript, `services/pyth-pusher`):

```bash
npm i @pythnetwork/hermes-client @pythnetwork/pyth-solana-receiver
```

```ts
const hermes = new HermesClient("https://pyth.dourolabs.app/hermes", {
  accessToken: process.env.PYTH_API_KEY,
});
const { binary } = await hermes.getLatestPriceUpdates(FEED_IDS, { encoding: "base64" });
const receiver = new PythSolanaReceiver({ connection, wallet });
const tx = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
await tx.addUpdatePriceFeed(binary.data, KRYON_SHARD_ID); // write to our own price-feed accounts (check the method name against the installed SDK version)
```

Two ways to get fresh prices on-chain:
1. **Our own price-feed accounts (recommended for v1).** The pusher updates a
   fixed account per feed, `getPriceFeedAccountAddress(KRYON_SHARD_ID, feedId)`,
   every ~1 s in session and every ~10 s when closed. `settle_fills`,
   `liquidate` and `update_funding` read those accounts. Transactions stay
   small because no VAA goes inside the matcher's transactions.
2. **Post in the same transaction.** Post the update and consume it
   atomically. This gives the freshest price, but the transactions are big
   and don't fit alongside Ed25519 fill verification. Use it only for
   `liquidate` if needed.

Use a shard id of our own, e.g. `1`, so we don't depend on Pyth's sponsored
shard-0 cadence, and so equity feeds get updated even if Pyth doesn't sponsor
them.

## 3. Finding feed ids

- Browse `https://www.pyth.network/price-feeds` or query Hermes
  `/v2/price_feeds?query=TSLA&asset_type=equity` (with the key).
- Equity symbols look like `Equity.US.TSLA/USD`. Extended sessions have
  separate feeds with `.PRE`, `.POST` and `.ON` suffixes (Pyth Pro).
- **Tokenized-stock feeds are different from the underlying.** Pyth publishes
  some tokenized-asset feeds (e.g. SPCX). Decide per market whether the perp
  tracks **the underlying stock** (recommended: deeper, cleaner) or **the
  token**.
- Store `pyth_feed_id` in `Market` (and in `Collateral` for xStocks). Changes
  go through the time lock.

## 4. Session handling with Pyth

| Session | Primary price | Guard |
|---|---|---|
| Regular | `Equity.US.X/USD` | age ≤ 10 s, conf ≤ 50 bps |
| Extended (pre/post/overnight) | the `.PRE`/`.POST`/`.ON` feed (**Pyth Pro only**) | age ≤ 30 s, conf ≤ 150 bps; margin ×1.5 |
| Closed | none. `closed_mark_price(last_regular_close, book_ema, secs_closed)` | band 2% + 0.25%/h, max 15% |
| Scheduled open but the feed is stale | → **Halted**, reduce-only | alert |

**If we can't afford Pyth Pro at launch:** treat extended hours as Closed.
Book-driven mark, clamped, with 2x margin. That's still safe, and we upgrade
later. It's a policy change, not a code change.

## 5. Budget (monthly, estimates to confirm)

| Item | Launch | Scale |
|---|---|---|
| Pyth Core plan (sub-second, API) | ~$500–2,500 | ~$2,500 |
| Pyth Pro US Equities (extended hours) | $0 (defer) | $5,000 |
| Pusher transaction fees (~15 feeds × 1/s in session) | ~2–5 SOL | ~10 SOL |
| Backup oracle (RedStone or Stork, quote needed) | $0 (xStocks DEX TWAP check) | quote |

## 6. Fallback and sanity checks

- **Secondary oracle:** ~~Switchboard~~ **deprecated 2026-09-19, support ended
  2026-09-25. Do not use.** Candidates: RedStone (live on Solana, pull model,
  RWA feeds), Stork (24/7 equity data, powers equity perps elsewhere; pricing
  by quote), Chainlink Data Streams (paid). Use a secondary as a **deviation
  check only**: if |primary − secondary| > X bps, the market goes Halted.
  Never average the two sources.
- **Off-chain alarm:** reuse the Stellar `oracle-keeper` 3-CEX median as a
  monitor for crypto markets. For equities, compare against the xStocks DEX
  TWAP. That TWAP is informative only, because it's manipulable.
- **Collateral valuation for xStocks:** value at the underlying's Pyth price
  × multiplier (corporate actions!), then apply the haircut. In Closed
  sessions, add an extra haircut of 5–10%.

## 7. Tokenized-stock specifics to verify before listing a collateral mint

- Token program: many xStocks are **Token-2022**, so handle extensions via
  `token_interface`. Reject mints with extensions we don't support (transfer
  hooks, permanent delegate, pausable). Read each mint's extensions on-chain
  before whitelisting.
- Decimals and **scaled-UI / multiplier** extensions (used for splits and
  dividends): the on-chain amount may not equal the share count. Read the
  multiplier and include it in valuation.
- Issuer freeze/pause powers: they're a risk to collateral, so reflect them in
  the haircut.
- Holder restrictions: xStocks are not for US persons. This lines up with our
  geofence (`10`).

**Built (decided 2026-09-26):**
- **Allow-list, read from raw TLV** (`token_ext.rs`). The pinned
  `spl-token-2022` v6 (held back by the rustc 1.79 SBF toolchain) predates
  the scaled-UI-amount (type 25) and pausable (26) extensions, and its
  `get_extension_types` fails on any type it doesn't know. So the program
  walks the TLV entries itself. Allowed: mint close authority,
  metadata/group pointers and data, and the scaled-UI amount. Everything
  else is refused, including a type number from the future: transfer hook,
  permanent delegate, pausable, transfer fee, interest-bearing,
  non-transferable, default account state and confidential mints.
- `add_collateral` creates the vault token account itself, after the
  check. Anchor's `init` sizes Token-2022 accounts with the same v6 crate
  and failed on scaled-UI mints; the token program (v8 on-chain) now reports
  the size through `GetAccountDataSize`.
- **Multiplier in valuation.** Health takes `[Collateral, PriceUpdateV2,
  Mint]` per non-settlement collateral. A raw token is worth
  `multiplier × price`, where the multiplier is the mint's current one, or
  its scheduled `new_multiplier` once its timestamp has passed. That way a
  split is valued correctly from the second it takes effect, with no keeper
  in between. The `f64` is decoded from its bits with integer math
  (`protocol_core::f64_bits_to_precision`, exact, rounded down); no floats
  on-chain.
- **Closed-market haircut.** `Collateral.closed_haircut_bps` (≤ 100% with
  the base haircut) and `max_closed_age_secs` (0 = off, else above the fresh
  age and at most 5 days). A price past its fresh age but inside the closed
  age values the collateral at `haircut + closed_haircut`; older is
  `StaleOracle`. Staleness is the signal, not the calendar, so an in-session
  feed outage is covered the same way (conservative), and collateral needs
  no market account.
- Tests build the extensions with crafted mint bytes run by LiteSVM's
  bundled Token-2022 v8 program.

## 8. Zero-cost path (MVP before there's budget)

What is still **free** as of 2026-09-26:

| Source | Free? | Good enough for |
|---|---|---|
| **Pyth sponsored push feeds, Solana shard 0** | Yes. Reading on-chain accounts needs no API key | **Primary price on mainnet v1**, but only for tickers Pyth sponsors. Default update is 55 s heartbeat / 0.5% deviation |
| Pyth Hermes free tier | View-only, 10 s, rate-limited | UI charts only, not settlement |
| xStocks DEX pools (Raydium/Orca/Meteora TWAP) | Yes, on-chain | Deviation alarm and closed-session sanity check. **Never primary**, because it's manipulable |
| Own keeper (the port of Stellar `oracle-keeper`) | Yes, but free stock APIs forbid commercial use/redistribution | **Devnet only** |
| Switchboard | Shut down 2026-09-25 | ❌ |

How to run v1 on the free sponsored feeds:
1. **Only list tickers that have a sponsored `Equity.US.*` feed on shard 0.**
   Check the table at `docs.pyth.network/price-feeds/core/push-feeds/solana`
   and read each account on mainnet to confirm it updates. Crypto majors are
   sponsored.
2. The program reads the fixed shard-0 `PriceUpdateV2` account (same code as
   §2; only the shard changes, and no pusher service is needed).
3. Set `max_oracle_age_secs` to **≥ 70 s** (55 s heartbeat plus slack).
   Otherwise the market flips to Halted between heartbeats.
4. Because the price can lag up to 0.5% or 55 s: **cap leverage at 5x for
   stocks**, widen `max_execution_deviation_bps` to ~100, and let the matcher
   reject fills where the book has run ahead of a stale oracle.
5. Extended hours are treated as **Closed** (book mark, clamped), which the
   session engine already does when no feed is available.
6. Upgrade to a paid Pyth plan with our own pusher shard (§2 option 1) when
   volume justifies ~$500/mo. That's a config change, not a code change.

**Devnet gate (decided 2026-09-26):** `yarn devnet:gate`
(`scripts/devnet-gate.sh` → `tests/e2e/devnet.mts`) lists a SOL-PERP market on
the sponsored shard-0 SOL/USD push feed (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`,
the shard-0 PDA of feed `ef0d8b6f…b56d`) with `max_oracle_age_secs = 120`.
Before trading it refuses a feed that is missing, not owned by the Pyth
receiver, not fully verified, or older than 120 s (`11` L2). The run writes
`deployments/devnet.json` only when the cluster's genesis hash is devnet's
(`11` L3). A rehearsal on a local validator with the feed mocked at the same
address passes.

