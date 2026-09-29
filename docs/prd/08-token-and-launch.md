# 08 — Protocol token ($FLOYDEX) and launch markets

> Not legal or tax advice. A token on top of a stock-derivatives venue carries
> two layers of regulatory exposure. Get counsel **before** you publish
> tokenomics, run a points program, or raise money. See `10`.

**$FLOYDEX is live** (launched Sep 29, 2026 via ClawPump / pump.fun).

| | |
|---|---|
| **Ticker** | `$FLOYDEX` |
| **Mint** | `2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy` |
| **Pair** | `7mmwd8DHp9S6mnkBUSFruynA5A3pUqp17Ka5KqxKdtCC` |
| **ClawPump** | https://clawpump.tech/tokens/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy |
| **DexScreener** | https://dexscreener.com/solana/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy |
| **Padre** | https://trade.padre.gg/trade/solana/7mmwd8DHp9S6mnkBUSFruynA5A3pUqp17Ka5KqxKdtCC |

Desk UI and agent skill copy should point at these links. Do **not** launch a
second mint.

"Token launches" means two different things in this plan:
- **A. FloyDex's own protocol token ($FLOYDEX):** mint is live; utility switches
  on after product gates below.
- **B. Launch markets as a product:** pre-listing perps for IPOs and new
  tokens (phase 3).

## A. Protocol token ($FLOYDEX)

### A1. Principle: product first, then utility

Mint is live for distribution and agent surface (ClawPump). Desk **utility**
(fee tiers, backstop staking, buyback) still follows traction — a perps DEX
token with no volume behind it is just a meme:

1. Mainnet desk + points for real, non-wash activity.
2. Reach the traction gates (below).
3. Switch on utility: fee tiers, backstop stake, buyback, listing votes.

**Utility gates (all three):** 90-day cumulative volume ≥ $250M, ≥ 5,000 unique
funded traders, and zero unresolved critical findings from audits or the
bounty.

### A2. Utility (once gates are met)

| Utility | Mechanism | Existing code it builds on |
|---|---|---|
| **Backstop staking** | Stake $FLOYDEX into a second-loss backstop behind the USDC insurance fund. Earns a share of fees; slashed on bad debt beyond the USDC fund | Solana `Insurance` + `StakePosition` |
| **Fee tiers** | Holding or staking lowers taker fees and raises maker rebates | `fee_config` |
| **Buyback** | X% of net protocol fees buy the token on the open market to the treasury or burn | fee vault + keeper |
| **Listing governance** | Token holders vote on new equity markets and risk-parameter ranges; the Squads multisig executes after the time lock | Squads v4 (+ Realms voting if needed) |
| **Pre-listing market seeding** | Stakers get early access and fee rebates on new pre-listing markets | `08-B` |

Avoid promising revenue share or yield in marketing. Buyback plus fee
discounts is the lower-risk shape, and counsel decides the final design.

### A3. Supply sketch (to refine against live mint metadata)

| Bucket | % | Vesting |
|---|---|---|
| Community: points airdrop + future seasons | 35 | Season 1 unlocked with utility; later seasons over 24 months |
| Ecosystem / market-maker incentives / grants | 15 | Programmatic, 36 months |
| Treasury (DAO) | 15 | Squads-controlled, governance spend |
| Core contributors | 18 | 12-month cliff, 36-month linear |
| Investors | 12 | 12-month cliff, 24-month linear |
| Initial liquidity | 5 | At launch |

Live mint supply and bonding-curve remnants are on-chain — treat the table as
the **utility allocation sketch**, not a second mint. No transfer hooks and no
freeze authority for desk-integrated utility.

### A4. Points program (starts at mainnet beta)

- Points for **taker volume** (low weight), **maker volume inside ±10 bps of
  mid** (high weight), **open interest held across sessions** (weekend
  liquidity), and **xStocks collateral deposited**.
- **Anti-wash rules:** no points for self-matched or circular flow (we see
  both sides of every fill), a minimum holding time, and caps per wallet
  cluster.
- Weekly on-chain snapshots and a public points API. Make no promises about
  conversion.

### A5. Launch path (what shipped)

| Path | Status |
|---|---|
| **ClawPump / pump.fun** | ✅ Live — mint and links above |
| Private round → Meteora / CEX | Optional later for deeper liquidity |
| MetaDAO-style / Jupiter LFG | Optional; evaluate after utility gates |

## B. Launch markets as a product (phase 3)

Pre-listing perps for IPOs and upcoming tokens: the book sets price, OI caps
are hard, and the market converts to oracle pricing once the asset lists.
Same machinery can cover equity IPOs and Solana token launches. Details stay
in `01` / `02` / `09`.
