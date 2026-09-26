# Kryon-sol: context for coding agents

Solana-native tokenized-stock perps. Hybrid CLOB: off-chain matching, on-chain
settlement of user-signed intents, one Anchor program.

## Read before you change anything
- `docs/prd/05-program-design-anchor.md`: accounts, instructions, order message, Ed25519 rules
- `docs/prd/07-session-risk-equities.md`: session model (Regular/Extended/Closed/Halted)
- `docs/prd/11-lessons-from-stellar.md`: bugs we already paid for

## Hard rules
- `crates/protocol-core` and `crates/risk-engine` stay **pure `no_std` Rust**: no Anchor, no solana-program, no alloc. The program converts its accounts into these types at the boundary.
- All prices and sizes inside the risk math are `i128` scaled by `PRECISION = 1e18`. Token decimals are converted only at the vault edge.
- Keep the `validate_fill` checks exactly as specified in `05` §2. Don't relax any of them.
- Ed25519 introspection: every offset's instruction index must be `u16::MAX`, and compare full pubkey and message bytes (`05` §5).
- The order message encoding must byte-match between Rust and TS, pinned by golden vectors.
- `reference/stellar/` is read-only source to port from. Never build it or import from it.
- Never commit keys, wallet JSON or `.env` files.

## Commands
- `cargo test`, `cargo clippy --all-targets`, `cargo fmt --all`
- Toolchain on this machine: anchor-cli 0.31.1, solana-cli 2.1.0 (Agave)

## Commit style
Commit as the repo owner, in plain English messages, and push often.
