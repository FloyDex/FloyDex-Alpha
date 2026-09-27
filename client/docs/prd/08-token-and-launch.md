# 08 — Token (KRY) and launches

> Not legal or tax advice. A token on top of a stock-derivatives venue carries
> two layers of regulatory exposure. Get counsel **before** you publish
> tokenomics, run a points program, or raise money. See `10`.

"Token launches" means two different things in this plan:
- **A. Kryon's own token (KRY):** the utility, supply and launch path.
- **B. Launch markets as a product:** pre-listing perps for IPOs and new
  tokens (phase 3), which also give KRY a pre-market.

## A. KRY token

### A1. Principle: launch the token after the product, not before

A perps DEX token with no volume behind it is a meme. Hyperliquid's playbook
worked because the token followed real usage. Sequence:
1. Mainnet with no token → **points** for real, non-wash activity.
2. Reach the traction gates (below).
3. TGE: airdrop to points holders, liquidity, then utility switches on.

**TGE gates (all three):** 90-day cumulative volume ≥ $250M, ≥ 5,000 unique
funded traders, and zero unresolved critical findings from audits or the
bounty.

### A2. Utility: each item tied to something the protocol already has

| Utility | Mechanism | Existing code it builds on |
|---|---|---|
| **Backstop staking** | Stake KRY into a second-loss backstop behind the USDC insurance fund. Earns a share of fees; slashed on bad debt beyond the USDC fund | `perp-insurance` share/cooldown model → Solana `Insurance` + `StakePosition` |
| **Fee tiers** | Holding or staking KRY lowers taker fees and raises maker rebates | `fee_config` |
| **Buyback** | X% of net protocol fees buy KRY on the open market to the treasury or burn | fee vault + keeper |
| **Listing governance** | KRY holders vote on new equity markets and risk-parameter ranges; the Squads multisig executes after the time lock | Squads v4 (+ Realms voting if needed) |
| **Pre-listing market seeding** | Stakers get early access and fee rebates on new pre-listing markets | `08-B` |

Avoid promising revenue share or yield in marketing. Buyback plus fee
discounts is the lower-risk shape, and counsel decides the final design.

### A3. Supply sketch (to refine)

| Bucket | % | Vesting |
|---|---|---|
| Community: points airdrop + future seasons | 35 | Season 1 at TGE; later seasons over 24 months |
| Ecosystem / market-maker incentives / grants | 15 | Programmatic, 36 months |
| Treasury (DAO) | 15 | Squads-controlled, governance spend |
| Core contributors | 18 | 12-month cliff, 36-month linear |
| Investors | 12 | 12-month cliff, 24-month linear |
| Initial liquidity | 5 | At TGE |

Fixed supply of 1,000,000,000, SPL (Token-2022 metadata; no transfer hooks
and no freeze authority after TGE).

### A4. Points program (starts at mainnet beta)

- Points for **taker volume** (low weight), **maker volume inside ±10 bps of
  mid** (high weight), **open interest held across sessions** (weekend
  liquidity), and **xStocks collateral deposited**.
- **Anti-wash rules:** no points for self-matched or circular flow (we see
  both sides of every fill), a minimum holding time, and caps per wallet
  cluster.
- Weekly on-chain snapshots and a public points API. Make no promises about
  conversion.

### A5. Launch venue options on Solana

| Path | Pros | Cons | Fit |
|---|---|---|---|
| **Private round → TGE with Meteora DAMM/DLMM liquidity + CEX listings** | Standard for DeFi infrastructure; controlled | Needs investors | ✅ default |
| **MetaDAO-style raise** (futarchy / "ownership coin", treasury controls) | Aligned community, investor protection, Solana-native story | Newer model; less control over the treasury | ✅ strong option for a community-owned perps DEX |
| **Jupiter LFG launchpad** | Huge distribution; JUP holders vote | Competitive to get in; Jupiter is now a direct competitor | ⚠️ |
| Meteora Dynamic Bonding Curve (DBC) / pump-style | Permissionless, fast | Reads as a memecoin, bad for a venue that asks people for collateral | ❌ |

## B. Launch markets as a product (phase 3)

### B1. Pre-listing perps
For assets that don't trade yet: IPOs (e.g. the SPCX pattern that did $10B+ in
24h at listing) and upcoming Solana token TGEs, including KRY itself.
- **No oracle phase:** the mark is the book EMA with a hard band per day, OI
  caps of 5–10% of a normal market, max leverage 2–3x, and an isolated
  insurance sub-fund.
- **Conversion:** when the asset lists and a Pyth feed exists, governance sets
  `pyth_feed_id`. The market switches to Regular, and positions carry over at
  the new mark (liquidations can happen).
- **Fallback:** if the IPO or TGE doesn't happen by date D, the market
  cash-settles at the final EMA.
- This reuses `session.rs`: a pre-listing market is permanently `Closed` with
  a wide band until conversion.

### B2. Token-launch tie-ins (for other Solana projects)
- A self-serve form lets a project request a pre-launch perp; governance
  approves it.
- Market makers are onboarded on day 1 through the SDK.
- A revenue share with the launching project is possible. Legal review
  required.

## C. Timeline (see `09`)
Points start at mainnet beta. The TGE comes no sooner than 90 days after
mainnet, and only once the gates in A1 are met. Pre-listing markets launch
after TGE, or for KRY itself as the first pre-listing market, before TGE.
