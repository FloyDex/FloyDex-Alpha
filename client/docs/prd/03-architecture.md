# 03 — System architecture on Solana

## 1. Shape: same hybrid CLOB, different chain

```
 Trader wallet (Phantom/Solflare/Backpack, Wallet Standard)
   │ ① on-chain tx once: init_user + set_delegate(session_key, expiry)
   │ ② deposit / withdraw (always signed by the main wallet)
   ▼
 Browser session key (ed25519, kept in IndexedDB, expires)
   │ ③ signs each order intent (compact binary, no popup)
   ▼
 API (Next.js route handlers)  ──► Postgres (orders, fills, projections)
   │                                  ▲
   ▼                                  │ ⑦ indexer (Helius/Yellowstone gRPC → Anchor events)
 Matcher (one writer per market)      │
   │ ④ settle_fills tx: [Ed25519Program ix(s)] + [kryon_perps::settle_fills]
   ▼                                  │
 ┌──────────────────── kryon_perps (single Anchor program) ────────────────────┐
 │ Exchange · Market · Collateral · UserAccount · OrderRecord · Insurance      │
 │ uses crates/protocol-core + crates/risk-engine (pure Rust, no_std)          │
 │ reads Pyth PriceUpdateV2 accounts ◄── ⑤ price pusher (Hermes API key)       │
 └──────────────────────────────────────────────────────────────────────────────┘
   ▲ ⑥ permissionless keepers: update_funding · liquidate · adl · post_session_calendar
 Squads v4 multisig + timelock  = admin + program upgrade authority
 Guardian key (hot, pause-only)
```

The trust model is unchanged from Stellar (`reference/stellar/docs/ARCHITECTURE.md`):
**nothing the operator does can move user funds beyond what the user
signed**, and every non-user flow is checked by the program.

## 2. Key decisions

| # | Decision | Why |
|---|---|---|
| A1 | **One Anchor program**, not 8 contracts | The Stellar split existed because of Soroban wasm size and upload fees. On Solana, calls between programs cost compute, are limited to depth 4, and make atomic accounting harder. Drift, Jupiter and Zeta are all essentially monolithic. Keep modules as Rust `mod`s inside one program |
| A2 | Keep **off-chain matching plus on-chain settlement** | A fully on-chain order book (Phoenix/Manifest style) makes every order a write transaction and gives up the no-popup UX. Our signed-intent model is proven and audited |
| A3 | **Session keys (delegates)** replace SEP-53 per-order signing | Solana wallets' `signMessage` works but pops up each time. One on-chain `set_delegate` puts a browser key in charge of orders only, with an expiry. Withdrawals always need the owner. Same pattern as Hyperliquid agent wallets |
| A4 | Verify signatures with the **native Ed25519 program plus instruction introspection** | Cheap, and the standard approach. Checking the offsets carefully is mandatory (see `05`, §5) |
| A5 | **Pyth pull oracle** (PriceUpdateV2) for the primary price, with our own pusher shard | The standard for equities on Solana. Covers regular hours; extended hours require Pyth Pro. See `06` |
| A6 | Governance = **Squads v4 multisig with a time lock**, not a custom contract | Removes ~400 lines of custom governance and its audit surface. Upgrade authority sits there too |
| A7 | Keep **Postgres as the projection DB**, fed by events | Same design as Stellar. The UI never waits on RPC |
| A8 | Services stay **TypeScript** (Node 22, `@solana/kit`, Anchor TS client) | ~2.9k lines of matcher and keeper logic port over, not rewritten |
| A9 | **Risk math compiled to WASM** for the frontend and SDK (`wasm-bindgen` on `risk-engine`) | The UI shows exactly the same liquidation price the chain enforces, from one source of truth |

## 3. Proposed folder layout (build here)

```
Kryon-sol/
├── Cargo.toml                  workspace (crates now; add programs/ next)
├── Anchor.toml                 (create with `anchor init`, see README)
├── crates/
│   ├── protocol-core/          ✅ ported, tested
│   └── risk-engine/            ✅ ported + session.rs, tested
├── programs/kryon-perps/       Anchor program (to build; see 05)
├── services/                   matcher, pusher, indexer, ws, liquidator, funding, reconciler, monitor
├── app/                        Next.js terminal (port from reference/stellar/frontend)
├── sdk/                        TS SDK + risk-engine WASM bindings
├── docs/prd/                   these documents
└── reference/stellar/          read-only original code (never compiled)
```

## 4. Throughput model

- Each fill needs two signature checks (maker and taker). The Ed25519
  instruction data is ~16 + 2×(32 + 64 + 107) ≈ 420 bytes, and the
  transaction limit is 1232 bytes. With an address lookup table, plan for
  **1–2 fills per transaction** and run transactions in parallel.
- The `Market` account is write-locked by every fill in that market, so fills
  serialize **per market**, not globally. That's fine: with a few fills per
  slot per market and 10+ markets, 50+ fills/s is reachable.
- Priority fees: the matcher uses dynamic priority fees, e.g. the Helius
  priority-fee API, with a cap.
- Future (not v1): batch-verify many orders by committing a Merkle root of
  signed intents per batch.

## 5. Environments

| Env | Cluster | RPC | Notes |
|---|---|---|---|
| local | `solana-test-validator` + Pyth receiver cloned | local | `anchor test` |
| devnet | devnet | Helius devnet | Public beta, faucet USDC mint we control, mock xStocks mints |
| mainnet-beta | mainnet | Helius/Triton dedicated | Deposit caps for the first 30 days |

Installed locally today: `anchor-cli 0.31.1`, `solana-cli 2.1.0` (Agave).
`pyth-solana-receiver-sdk` supports Anchor 0.31.1, so stay on 0.31.1 unless
Pyth's docs say otherwise.
