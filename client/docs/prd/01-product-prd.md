# 01 — Product Requirements: FloyDex on Solana (tokenized-stock perps)

Status: draft v1 · 2026-09-26 · owner: FloyDex core team

## 1. One line

**FloyDex is a Solana-native order-book perps exchange for US stocks, ETFs and
other real-world assets. You can post your tokenized stocks as margin, and the
risk engine is built around stock-market hours, including weekends and closed
sessions.**

## 2. Why this, why now

Numbers are as of Sept 2026. Links are in `../sources.md`.

- Tokenized-stock **perps** open interest reached ~$2.25B in Q1 2026 and
  peaked near $2.4B on Hyperliquid's HIP-3 (mostly trade.xyz). That demand is
  real, but most of it trades off Solana.
- Tokenized-stock **spot** trading lives on Solana: ~95–97% of global
  tokenized-equity DEX volume, $5.8B in Q2 2026, and xStocks at 190k+ holders
  and $500M+ AUM.
- So Solana holds the stocks, and most of the leverage on those stocks trades
  somewhere else. FloyDex's job is to bring that leverage to where the stocks
  already are, and to let the stocks themselves be margin.
- The main competitor on Solana is **Jupiter**, which added order-book (GUM
  engine) perps for SPCX/SNDK/SKHYNIX on 2026-09-22. Solayer Margin Trade
  offers a synthetic US-equity index (MT500). Drift and Zeta are mostly crypto.
  Nobody yet offers **tokenized stocks as margin netted against their own
  perp**, and nobody publishes a **session-aware risk model** with on-chain
  enforcement. See `02-market-and-differentiation.md`.

## 3. Users

| Persona | Needs | What FloyDex gives them |
|---|---|---|
| Crypto-native trader | Trade NVDA/TSLA/SPY with leverage around the clock, no broker, no KYC wall | 24/7 order book, gasless popup-free trading, USDC margin |
| xStocks holder | Earn on idle stock tokens; hedge through a weekend or earnings | Post xStocks as margin; one-click "hold + short perp = earn funding" |
| Market maker | Tight quotes need a fast, fair, cheap venue with an API | Off-chain matching, maker rebates, SDK (reuse FloyDexSDK), signed intents |
| Launch speculator | Trade an IPO or new listing before it exists as a token | Pre-listing perps (phase 3) |

## 4. Scope

### MVP (mainnet beta)
1. **Markets:** 6–10 US single stocks and ETFs (SPY, QQQ, NVDA, TSLA, AAPL,
   MSFT, META, AMZN, COIN, MSTR) plus SOL/BTC/ETH for liquidity and gas.
   Leverage 5–10x for stocks and 20x for crypto. Stock leverage is lower
   outside regular hours (see `07`).
2. **Collateral:** USDC (SPL). The xStocks basket (SPYx, QQQx, NVDAx, TSLAx)
   is added at launch with haircuts of 20–40%.
3. **Order types:** limit, market (IOC walk), post-only, reduce-only, TP/SL as
   stored triggers the matcher fires.
4. **Margin:** cross margin only at launch. Isolated margin stays disabled
   until the vault has a real per-position margin ledger, the same finding as
   KRY-Q5 on Stellar.
5. **Trading UX:** connect a wallet, approve one delegated **session key**
   on-chain, and then trade with no wallet popups. Withdrawals always need the
   main wallet.
6. **Risk:** oracle-guarded mark, session-aware margin and bands, partial
   liquidations, insurance fund with staked shares, ADL as a last resort.
7. **Surfaces:** trade terminal, portfolio, markets page, leaderboard (reuse
   the Stellar UI), public REST/WS API, TypeScript SDK.

### Phase 2
- Stock-collateral **portfolio margin**: a spot xStock held against a short
  perp on the same underlying gets a margin offset.
- The **Basis Vault** product: deposit TSLAx and the vault shorts TSLA-PERP to
  earn funding.
- More markets: commodities (XAU, XAG, WTI), FX, sector ETFs.
- Referral and points program.

### Phase 3
- **Pre-listing markets** for IPOs and upcoming token launches. The book sets
  the price, OI caps are hard, and the market converts to oracle pricing once
  the asset lists.
- Protocol token **$FLOYDEX** (mint live; utility after gates — see `08`).

### Not doing (explicitly)
- No spot trading venue. Spot routing goes through Jupiter and Raydium.
- No issuing our own tokenized stocks. We use xStocks, Backpack and other
  issuers.
- No cross-chain deployment in v1.
- No country geofencing — the desk is open to any user worldwide.

## 5. Functional requirements

| ID | Requirement | Acceptance |
|---|---|---|
| F1 | Deposit and withdraw USDC and whitelisted xStocks into a per-user margin account | Balances match vault token accounts to the atomic unit. Withdrawal checks initial margin via `risk-engine::validate_withdrawal` |
| F2 | Place, cancel and cancel-all orders by signed intent, with no transaction per order | Order to resting in the book in under 150 ms p95. Cancel works immediately off-chain and is enforceable on-chain |
| F3 | Price-time-priority matching with partial fills | Deterministic, single writer per market (as on Stellar) |
| F4 | On-chain settlement of every fill, bounded by the signed order | The program enforces the full `validate_fill` table from the Stellar gateway |
| F5 | Session resolution for each market (Regular / Extended / Closed / Halted) | `risk-engine::session` rules. Halted is reduce-only |
| F6 | Mark price = Pyth price in session; clamped book EMA while closed | `closed_mark_price` |
| F7 | Funding: hourly, premium-based, capped per update | `risk-engine::funding` (already ported, tested) |
| F8 | Permissionless liquidation with a capped reward; insurance covers deficits; ADL only against recorded bad debt | Same invariants as the Stellar audit fixes C1/H5/Q4 |
| F9 | Emergency pause by the guardian; parameter changes by multisig with a timelock | Squads v4 with a time lock of at least 48h (matches Stellar H8) |
| F10 | Indexer that projects chain state into Postgres for the UI | UI never waits on RPC for reads |
| F11 | Public desk — no country geofence; optional operator wallet bans only | Anyone can load the UI; admin bans are per-wallet, not by jurisdiction |

## 6. Non-functional requirements

- **Throughput:** at least 50 settled fills/s sustained across markets. On
  Stellar the ceiling was ~12–13 fills/min; this is the headline improvement.
- **Latency:** fill to on-chain confirmation in under 2 s p95 (2 slots plus
  RPC).
- **Correctness:** every invariant from the Stellar audits has a test here
  (`11-lessons-from-stellar.md`).
- **Security:** two independent audits before real funds, a bug bounty at
  launch, and deposit caps for the first 30 days (reuse the `set_deposit_cap`
  idea).
- **Ops:** every keeper is idempotent and restart-safe, and alerts go to a real
  webhook. The Stellar mainnet was silent for weeks because the monitor had no
  webhook.

## 7. Success metrics (first 90 days after mainnet)

| Metric | Target |
|---|---|
| Cumulative volume | $250M |
| Daily active traders | 1,500 |
| Share of volume from equity markets | ≥ 50% |
| xStocks posted as collateral | $10M |
| Bad debt / volume | < 0.5 bps |
| Settlement failure rate | < 0.1% |
