# 02 — Market, competitors, and how FloyDex stands out

Snapshot as of 2026-09-26. **Recheck before any pitch.** These numbers move
weekly. Sources are in `../sources.md`.

## 1. Landscape

| Venue | Chain | Model | Equities? | Notes |
|---|---|---|---|---|
| trade.xyz (HIP-3) | Hyperliquid | Order book | Yes, 59 markets (May 2026) | Category leader: ~$2B/day and ~90% of HIP-3 OI. Holds the last reference price when the market is closed; hourly funding |
| **Jupiter Perps (GUM engine)** | Solana | Order book (new) + JLP pool (legacy) | Yes: SPCX, SNDK, SKHYNIX (2026-09-22) | **Most direct threat.** Huge distribution; the order book is days old |
| Solayer Margin Trade | Solana | On-chain | MT500 synthetic US index, commodities | Chainlink oracles, hourly funding |
| Drift | Solana | DLOB (hybrid) | Mostly crypto | Largest Solana order-book perp venue |
| Zeta, Flash Trade | Solana | CLOB / pool | Crypto | — |
| edgeX | Multi | Order book | Tokenized stocks, up to 100x | — |
| Ostium | Arbitrum | Pool / oracle | RWA perps | — |

On the spot side, xStocks (Backed/Kraken) and Backpack-issued stocks dominate
Solana. Jupiter Lend already accepts SPYx, QQQx, NVDAx and TSLAx as
**lending** collateral. Meteora's StockLaunch (2026-09-15) pairs new tokens
against Backpack stocks.

**What this means:** "a CLOB for stock perps on Solana" is no longer a moat
alone. Jupiter has one as of this week. FloyDex has to win on **features the
incumbents can't copy quickly**, plus better execution for market makers.

## 2. Five things that make FloyDex different

### D1. Your stocks are your margin (stock-margined perps)
Deposit TSLAx, NVDAx, SPYx and so on as margin (with a haircut), not just USDC.
In phase 2 that becomes **portfolio margin**: long TSLAx spot plus short
TSLA-PERP is nearly delta-neutral, so the pair needs much less margin than the
two legs taken separately.
- It turns the $500M+ of idle xStocks into perps collateral, a supply
  advantage Hyperliquid doesn't have.
- It enables the **Basis Vault**: "hold your stock, earn funding". Longs pay
  shorts when the perp trades rich, which is the normal state for meme stocks.
  This is a yield product for passive holders and a steady source of short
  liquidity for the book.
- Engineering: the collateral haircut already exists
  (`collateral_value_after_haircut`). Portfolio margin is a new function in
  `risk-engine` (phase 2).

### D2. Risk that knows when the market is closed
Every competitor either stops trading or pretends the price is continuous.
FloyDex publishes and enforces **session-aware risk** on-chain
(`crates/risk-engine/src/session.rs`, already written and tested):
- Regular session: oracle mark, normal margin.
- Extended hours: oracle mark, 1.5x margin.
- Closed (weekend, holiday): the mark is the book EMA clamped to a band that
  widens over time; margin is 2x; new OI is capped.
- Halted (the oracle is stale during scheduled hours): reduce-only.
Pitch: **"No surprise weekend liquidations. The rules are public and on-chain,
and you can see the band on screen."** The UI shows a session badge, the
current band, and the effective leverage.

### D3. Trade without wallet popups
Carried over from Stellar, where it was the audit-proven core. The trader
approves a **session key** once on-chain. After that each order is a signed
intent: matching happens off-chain in milliseconds, and settlement is enforced
on-chain against exactly what was signed (size, price, nonce, expiry). The
operator can never do worse than what the user signed. See `05`.
On Solana this is also fast. Stellar capped FloyDex at ~13 fills/min; Solana
supports hundreds of fills per second across markets.

### D4. Built for market makers
- Maker rebates from day one, a REST/WS API, and the FloyDexSDK (reuse
  `FloyDexSDK` conformance vectors).
- Fees and rebates are known when you quote: no per-order gas, and settlement
  fees are paid by the operator.
- A designated market maker program for the equity markets, since spreads
  during closed hours are the product.

### D5. Pre-listing and event markets (phase 3, and the tie-in with the token)
- **IPO pre-market perps:** SpaceX tokenized-stock perps did more than $10B in
  24h at listing (June 2026). FloyDex lists such names **before** the token or
  IPO exists. The book sets the price, OI caps are hard, and the market
  converts to the Pyth price at listing.
- **Pre-launch token perps:** the same machinery works for upcoming Solana
  token launches, including **$FLOYDEX** (mint live — see `08`).
- **Earnings weeks:** the session calendar can mark earnings windows with a
  higher margin multiplier (a small extension of `SessionWindow`).

## 3. Positioning line

> **FloyDex: trade stocks 24/7 on Solana, with your stocks as margin.**
> Order-book perps with published weekend rules, popup-free trading, and
> built-in funding yield for holders.

## 4. What we don't compete on

- Leverage headlines: 100x on stocks is a liability, not a feature.
- Market count: fewer markets, each with deep books.
- Pool-based pricing: we remain a CLOB.
