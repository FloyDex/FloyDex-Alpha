# Kryon-sol: tokenized-stock perps on Solana

Kryon, rebuilt Solana-native for US stocks, ETFs and RWAs. It's an order-book
perps exchange where your **tokenized stocks are your margin** and the **risk
engine knows when the market is closed**.

Created 2026-09-26 from the Stellar codebase (`../Kryon`, commit `cec0477`).
The Stellar product stays live and untouched. This is a separate project.

## Start here

1. Read `docs/prd/01-product-prd.md` (what and why), then `02` (how we
   stand out).
2. Build from `docs/prd/09-roadmap.md`, phase by phase. The design
   references are `03` (architecture), `05` (Anchor program), `06` (Pyth)
   and `07` (session risk).
3. Before writing settlement code, read `11-lessons-from-stellar.md` and
   `05` §5 (Ed25519).

## What's in this folder

| Path | What it is | State |
|---|---|---|
| `crates/protocol-core` | Fixed-point math, types, oracle guard. Chain-agnostic, `no_std` | ✅ ported from Soroban, 8 tests |
| `crates/risk-engine` | Margin/health, funding, liquidation planning, **session-aware risk** | ✅ ported + new `session.rs`, 17 tests |
| `docs/prd/01…11` | PRDs: product, market, architecture, migration map, program design, oracle, session risk, token, roadmap, compliance, lessons | draft v1 |
| `docs/sources.md` | Every external source used, with dates | — |
| `reference/stellar/onchain` | The 8 Soroban contracts + original crates | read-only reference |
| `reference/stellar/offchain` | Matcher, keepers, indexer, WS server, `lib/`, Prisma schema | read-only reference |
| `reference/stellar/frontend` | Next.js app, features, components | read-only reference |
| `reference/stellar/docs`, `audits` | Architecture, settlement auth, security model, all audit reports | read-only reference |

No private keys, wallet files or `.env` files were copied. Don't add any.

## Verify

```bash
cd ~/Downloads/Kryon-sol
cargo test        # 25 tests: protocol-core 8, risk-engine 17
cargo clippy --all-targets
```

## Next build steps (Phase 0)

```bash
cd ~/Downloads/Kryon-sol
git init && git add . && git commit -m "Start Kryon on Solana: ported risk crates and PRDs"

# Anchor program next to the crates (anchor-cli 0.31.1 and solana 2.1.0 are installed)
anchor init kryon-perps-scaffold --no-git     # then move programs/ + Anchor.toml up into this root
# add "programs/*" to the workspace members in Cargo.toml
# programs/kryon-perps/Cargo.toml:
#   protocol-core = { path = "../../crates/protocol-core" }
#   risk-engine   = { path = "../../crates/risk-engine" }
#   pyth-solana-receiver-sdk = "<compatible with anchor 0.31.1>"
#   anchor-spl = { version = "0.31.1", features = ["token_2022"] }
```

After that, follow `09-roadmap.md` Phase 1.
