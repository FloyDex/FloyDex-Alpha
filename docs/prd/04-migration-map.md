# 04 — Migration map: what to keep, change, remove and add

Every path under "From" is relative to `reference/stellar/`, which is a copy
of the Stellar repo at commit `cec0477` (2026-09-26). Nothing there is
compiled; it is source to port from.

Legend: ✅ done · ♻️ port (logic survives) · 🔁 rewrite (idea survives, code does not) · 🗑 remove · ➕ new

## 1. On-chain

| From (Stellar) | Lines | Action | To (Solana) | How |
|---|---|---|---|---|
| `onchain/crates/protocol-core` | 440 | ✅ | `crates/protocol-core` | Soroban removed. `Address`→`[u8;32]`, `Symbol`→`[u8;16]`, `Vec`→slices. All 8 tests pass |
| `onchain/crates/risk-engine` | 814 | ✅ + ➕ | `crates/risk-engine` | `Map`→`MarketLookup` trait, `Env` removed. All 10 tests pass. **New `session.rs`** (7 tests) |
| `onchain/contracts/perp-engine` | 1,937 | 🔁 | `programs/kryon-perps/src/engine/` | open/increase/reduce/close position, fees, OI, funding indexes, OI policy. The logic is portable; storage becomes zero-copy accounts |
| `onchain/contracts/perp-vault` | 1,699 | 🔁 | `…/vault/` | Balances live inside `UserAccount`; tokens move via `token_interface` (SPL and Token-2022). Keep deposit caps, pause, `apply_pnl`, `absorb_bad_debt`, `seize_for_deficit` semantics |
| `onchain/contracts/perp-order-gateway` | 1,429 | 🔁 | `…/settlement/` | Keep the `validate_fill` table **verbatim**. Replace SEP-53 with Ed25519 introspection; `filled`/`is_cancelled` become `OrderRecord` PDAs; keep `reclaim_order_state` |
| `onchain/contracts/perp-liquidation` | 1,105 | 🔁 | `…/liquidation/` | `liquidate`, `adl`, `max_reward_bps ≤ 1000`, driven by `plan_liquidation` |
| `onchain/contracts/perp-insurance` | 862 | 🔁 | `…/insurance/` | Share-based staking, unstake cooldown, `cover_deficit`, bad-debt ledger, "retire shares when a loss wipes the pool" (commit 652f967) |
| `onchain/contracts/perp-oracle-adapter` | 847 | 🔁 (much smaller) | `…/oracle.rs` | Read Pyth `PriceUpdateV2` → `OracleSnapshot` → `validate(guard)`. **Drop** `write_price`, `write_quorum_price` and publisher sets |
| `onchain/contracts/perp-risk` | 168 | 🗑 | — | A view-only contract. Views become client-side WASM of `risk-engine` |
| `onchain/contracts/perp-governance` | 408 | 🗑 | Squads v4 | Use a multisig with a time lock of at least 48h as program upgrade authority and `Exchange.admin` |
| `upgrade`, `extend_instance_ttl`, `migrate_import_*`, `seal_migration` in every contract | — | 🗑 | — | No TTL/archival on Solana (rent-exempt accounts). Upgrades go through the BPF upgrade authority. Fresh deployment, so no migration |
| `nominate_admin`/`accept_admin` | — | ♻️ | `Exchange` | Keep two-step admin handover |

## 2. Off-chain services (`offchain/scripts`, `offchain/lib`)

| From | Lines | Action | Notes |
|---|---|---|---|
| `lib/market/matcher.ts` | 107 | ♻️ as-is | Pure price-time matching |
| `lib/market/order-intent.ts`, `liquidation-sizing.ts` (+ tests) | — | ♻️ | Change only the number and address formats |
| `lib/market/signing-message.ts`, `signed-intent.ts` | — | 🔁 | New compact binary order layout (`05` §4). Keep the **golden cross-language test** idea: TS bytes ≡ Rust bytes |
| `scripts/matcher-service.ts` | 748 | ♻️ | Replace `submitSettleFillSigned` with a builder for `settle_fills` transactions (Ed25519 ix + program ix, ALT, priority fee). **Stop settling inside the 1 s tick loop** (the ~13 fills/min ceiling). Use a queue and concurrent submitters |
| `scripts/settlement-reconciler.ts` | 374 | ♻️ | Check by signature and status instead of Stellar tx hash polling |
| `scripts/liquidation-keeper.ts` | 454 | ♻️ | Scan `UserAccount`s (getProgramAccounts with memcmp) or the DB projection; call `liquidate` |
| `scripts/funding-keeper.ts` | 207 | ♻️ | Calls `update_funding(market)` hourly. Add verification of on-chain state (PR #45 idea) |
| `scripts/state-indexer.ts` | 194 | 🔁 | Stellar ledger cursor → Anchor events over Helius webhooks or Yellowstone gRPC; persist the slot cursor |
| `scripts/ws-server.ts` | 270 | ♻️ as-is | Chain-independent |
| `scripts/monitor.ts` | — | ♻️ | **Must post to a webhook** (the Stellar outage lesson) |
| `scripts/stats-aggregator.ts` | — | ♻️ | — |
| `scripts/oracle-keeper.ts` | 542 | 🔁 | Becomes the **Pyth price pusher** (Hermes, API key → post updates to our shard). Keep the 3-CEX median as a **deviation alarm only**, never a price source |
| `scripts/keeper-refill.ts` | — | ♻️ | SOL top-ups for operator and keeper wallets |
| `lib/stellar/*` (client, freighter, invoke, scval, simulate, reflector, settlement, collateral, contracts, oracle) | — | 🗑 → ➕ `lib/solana/*` | New: connection, Anchor program client, tx builder, ALT management, priority fees, PDA helpers |
| `prisma/schema.prisma` | — | ✅ ported (`services/db`) | Keep the models. Addresses are base58 pubkeys; `TxJob` gets `signature` + `slot`; `LedgerCursor` → `SlotCursor`; **the dead `Position` model is deleted**. 2026-09-27: also renamed `ledger`→`slot` and `txHash`→`signature` on every other model for Solana's own vocabulary, and re-scaled settlement-asset amounts from Stellar's 1e7 to USDC's native 1e6 (order/fill size and price stay 1e9, matching the wire format; funding indexes stay 1e18). 2026-09-27: added `Order.subId`/`Fill.{maker,taker}SubId` and rescoped `Order`'s unique key to `(owner, subId, nonce)` — Stellar had no sub-account concept, but on Solana `UserAccount` (and the `cancel_all_below_nonce` that scopes `nonce`) is keyed by `(owner, sub_id)`, matching the wire format's `sub_id` byte (`05` line 257). Local Postgres via `services/db/docker-compose.yml`; the schema round-trips against a real Postgres in CI (`services` job) |
| New: session calendar keeper | — | ➕ | Posts next week's windows (NYSE hours, DST, holidays) to each equity market |
| New: mark EMA feeder | — | ➕ | Tracks the book mid EMA during Closed sessions; also updated on-chain inside settlement |

## 3. Frontend (`frontend/`)

| From | Action | Notes |
|---|---|---|
| `features/trade/components/*` (OrderBook, OrderEntry, PositionsTable, TradeChart, …) | ♻️ | Markup and state survive. Rewire data hooks |
| `features/wallet` | 🔁 | Wallet Standard / `@solana/wallet-adapter-react`; add a **session-key enable** flow |
| `features/collateral/useCollateral.ts` | 🔁 | Multi-mint (USDC + xStocks), Token-2022 aware |
| `features/network` (mainnet/testnet toggle) | ♻️ | → mainnet-beta/devnet |
| `features/chart`, `components/ui`, `stores` | ♻️ | — |
| `app/api/*` routes | ♻️ | Keep orders, fills, markets, portfolio, leaderboard, health. Verify the delegate signature instead of SEP-53 |
| `DepositWithdrawDialog.tsx`, `SettlementModal.tsx` | 🔁 | — |
| ➕ Session badge + band indicator | new | Regular / Extended / Closed / Halted, with effective max leverage |
| ➕ Geofence + ToS gate | new | See `10` |
| `@stellar/stellar-sdk`, `@stellar/freighter-api` | 🗑 | — |

## 4. Remove entirely (don't bring across)

- Every `_drill_*`, `_loadtest_*`, `cutover-*`, `*-usdt0*`, `setup-usdc-*`,
  `redeploy-*`, `mainnet-*`, `testnet-*`, `ttl-keeper`, `governance-handover`,
  `transfer-admin-to-governance`, `update-oracle-publisher` and `test-settle-*`
  script. They are Stellar operations tooling. Rewrite load tests later
  against the new stack.
- `infra/a1flex`, Cloudflare/OpenNext config, Railway testnet entrypoints. Pick
  hosting again (see `09`).
- Any key or wallet JSON. None were copied; keep it that way.

## 5. Add (new work that has no Stellar equivalent)

1. Anchor program with zero-copy accounts (`05`).
2. Ed25519 introspection verifier + delegate/session keys.
3. Token-2022 collateral support (xStocks), haircuts, oracle per collateral.
4. Pyth pusher + session calendar + closed-session mark.
5. Portfolio margin (phase 2) and the Basis Vault (phase 2).
6. Squads v4 governance setup and runbooks.
7. `risk-engine` → WASM bindings for UI and SDK.
8. Compliance layer: geofence, sanctions screening, ToS (see `10`).
