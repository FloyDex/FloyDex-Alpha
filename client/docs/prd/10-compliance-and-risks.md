# 10 — Compliance and top risks

> Not legal advice. Engage specialist counsel (derivatives + digital assets)
> before mainnet and before any token activity.

## 1. Access policy (product decision)

**FloyDex does not geofence by country.** The website and APIs are operable by
anyone worldwide. There is no US / UK / EU / sanctions-jurisdiction IP block in
the frontend or API. Operator tools may still ban **individual wallets** for
abuse (fraud, drain attempts, etc.) — that is not a country filter.

Counsel may still advise entity structure, ToS language, and marketing limits;
those are legal/ops choices, not product geoblocks.

## 2. Regulatory shape (high level)

| Topic | Why it matters | Baseline action |
|---|---|---|
| Global access | Product is open worldwide | No country geofence in UI/API |
| Sanctions / abuse | Wallet-level risk, not IP country | Optional operator wallet bans; counsel may add address screening later |
| Entity | An operator entity is needed for ToS, contracts, audits and hiring | Counsel picks the jurisdiction |
| Protocol token | Securities-law exposure depends on marketing, rights and distribution | Utility-first design, no yield promises, points ToS, a legal opinion before TGE |
| Data licensing | Pyth terms restrict redistribution of feeds | Show prices within licence terms; don't re-publish raw feeds through our API without checking |

## 3. Top risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Jupiter's GUM order book captures the equity-perps category first | High | High | Win on D1 (stocks as margin) and D2 (session risk); court MMs early; niche first (weekend and earnings trading) |
| R2 | Ed25519 introspection bug lets an attacker forge fills | Med | Critical | `05` §5 rules, a tampering test suite, two audits |
| R3 | Monday gap causes bad debt | Med | High | `07` session model, closed OI cap, margin ×2, backtests, insurance seed |
| R4 | Thin weekend book gets pushed to trigger liquidations | Med | High | Clamped band, EMA mark (not the last print), step-limited `post_mark`, closed OI caps |
| R5 | Oracle outage or change (Pyth pricing and infrastructure changing) | Med | High | Halted = reduce-only; secondary deviation check (RedStone/Stork, or xStocks DEX TWAP); pin SDKs; monitor Pyth announcements. Switchboard shut down 2026-09-25, which proves oracle providers can disappear on six days' notice |
| R6 | xStocks issuer freezes or pauses, or a corporate-action mismatch | Low–Med | Med | Haircuts, extension allow-list, multiplier-aware valuation, per-mint caps |
| R7 | Operator key compromise | Low | High | The operator can only settle signed fills (bounded); keys in a KMS/HSM; operator rotation through admin |
| R8 | Admin key never handed to the multisig | Med | Critical | Squads set up **before** the first deposit; roadmap gate |
| R9 | Silent outage | Med | High | Webhook alerts, heartbeat checks from outside the VM, a status page |
| R10 | Regulatory action | Med | Critical | Counsel + ToS; **no** product geofence by design |
| R11 | Token launched before traction damages credibility | Med | Med | `08` §A1 gates |
