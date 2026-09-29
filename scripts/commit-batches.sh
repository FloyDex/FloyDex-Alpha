#!/usr/bin/env bash
# One-shot: commit the FloyDex desk/program work in logical batches.
# Never stages .env or key material.
set -euo pipefail
cd "$(dirname "$0")/.."

commit() {
  local msg="$1"
  shift
  # shellcheck disable=SC2086
  git add "$@"
  if git diff --cached --quiet; then
    echo "skip (empty): $msg"
    return 0
  fi
  git commit -m "$(cat <<EOF
$msg

EOF
)"
  echo "ok: $msg"
}

# --- Meta / license / brand docs ---
commit "docs: add MIT license" LICENSE
commit "docs: rewrite README for FloyDex product and ops addresses" README.md
commit "chore: point package metadata at FloyDex/FloyDex-Alpha" package.json
commit "docs: refresh agent context for floydex-perps" CLAUDE.md
commit "chore: ignore local env and ledger artifacts" .gitignore
commit "ci: keep program and desk checks green" .github/workflows/ci.yml

# --- Anchor / workspace rename ---
commit "build: retarget Anchor workspace to floydex-perps" Anchor.toml Cargo.toml Cargo.lock
commit "program: rename kryon-perps tree to floydex-perps" programs/

# --- Protocol crates ---
commit "protocol: keep order encoding pinned for Solana domain" \
  crates/protocol-core/Cargo.toml crates/protocol-core/src/order.rs

# --- Integration tests ---
commit "test: refresh LiteSVM harness for floydex-perps" \
  integration/Cargo.toml integration/Cargo.lock integration/src/lib.rs
commit "test: update settle and funds suites for program rename" \
  integration/tests/settle_ed25519.rs integration/tests/settle_effects.rs \
  integration/tests/settle_rules.rs integration/tests/settle_size.rs \
  integration/tests/funds.rs
commit "test: update risk suites (liq, funding, insurance, adl)" \
  integration/tests/liquidate.rs integration/tests/funding.rs \
  integration/tests/insurance.rs integration/tests/adl.rs
commit "test: update admin, delegate, oracle and mark session suites" \
  integration/tests/admin.rs integration/tests/delegate.rs \
  integration/tests/oracle_calendar.rs integration/tests/mark_session.rs \
  integration/tests/common/mod.rs
commit "test: update fuzz, bench and xstocks suites" \
  integration/tests/fuzz_program.rs integration/tests/bench.rs \
  integration/tests/xstocks.rs

# --- SDK ---
commit "sdk: update package homepage and repository" sdk/package.json sdk/package-lock.json
commit "sdk: align order encoder comments with FloyDex domain" sdk/src/order.ts
commit "sdk: refresh golden order vectors" sdk/conformance/order-v1.json sdk/conformance/generate.py

# --- Services ---
commit "services: set repository metadata across workspace packages" \
  services/package.json services/kit/package.json services/db/package.json \
  services/matcher/package.json services/order-intake/package.json \
  services/submitter/package.json services/reconciler/package.json
commit "services(kit): load floydex deployments and IDL fixtures" \
  services/kit/src/deployments.ts services/kit/test/deployments.test.ts \
  services/kit/test/fixtures/exchange-idl.json
commit "services(db): retitle Prisma schema and compose labels" \
  services/db/README.md services/db/docker-compose.yml \
  services/db/prisma/schema.prisma services/db/src/index.ts
commit "services(matcher): brand logs and tick identity" \
  services/matcher/src/main.ts services/matcher/src/tick.ts \
  services/matcher/test/tick.test.ts
commit "services(order-intake): brand delegate and HTTP boot" \
  services/order-intake/src/delegate.ts services/order-intake/src/main.ts \
  services/order-intake/src/server.ts
commit "services(submitter): brand claim/build/worker paths" \
  services/submitter/src/accounts.ts services/submitter/src/build.ts \
  services/submitter/src/claim.ts services/submitter/src/main.ts \
  services/submitter/src/worker.ts services/submitter/test/claim.test.ts
commit "services(reconciler): brand confirm and rollback logs" \
  services/reconciler/src/main.ts services/reconciler/src/reconcile.ts \
  services/reconciler/test/reconcile.test.ts

# --- Scripts / e2e ---
commit "scripts: update e2e and gate paths for floydex-perps" \
  scripts/devnet-gate.sh scripts/e2e-local.sh scripts/submitter/lookup-table.mts \
  tests/e2e/devnet.mts tests/e2e/gate.mts

# --- Product docs ---
commit "docs: open access policy and drop country geofence" \
  docs/prd/01-product-prd.md docs/prd/10-compliance-and-risks.md \
  client/docs/prd/01-product-prd.md client/docs/prd/10-compliance-and-risks.md
commit "docs: token section stays ticker-TBD until launch" \
  docs/prd/08-token-and-launch.md client/docs/prd/08-token-and-launch.md
commit "docs: refresh competitive and architecture PRDs" \
  docs/prd/02-market-and-differentiation.md docs/prd/03-architecture.md \
  docs/prd/04-migration-map.md docs/prd/05-program-design-anchor.md \
  client/docs/prd/02-market-and-differentiation.md client/docs/prd/03-architecture.md \
  client/docs/prd/04-migration-map.md client/docs/prd/05-program-design-anchor.md
commit "docs: oracle, roadmap and lessons pass" \
  docs/prd/06-oracle-pyth.md docs/prd/09-roadmap.md docs/prd/11-lessons-from-stellar.md \
  client/docs/prd/06-oracle-pyth.md client/docs/prd/09-roadmap.md \
  client/docs/prd/11-lessons-from-stellar.md

# --- Client package / config ---
commit "client: package metadata and Next config for Solana desk" \
  client/package.json client/package-lock.json client/next.config.ts \
  client/README.md client/.gitignore
commit "client: env examples for mainnet desk (no secrets)" \
  client/.env.example client/.env.mainnet.example client/.env.production.example \
  client/.env.testnet.example
commit "client: network and market config with fee collector" \
  client/config/index.ts client/config/networks.ts client/config/markets.test.ts \
  client/config/labels.ts
commit "client: deploy and ecosystem configs" \
  client/docker-compose.yml client/ecosystem.config.cjs \
  client/ecosystem.testnet.config.cjs client/ecosystem.web.config.cjs \
  client/render.yaml client/wrangler.jsonc

# --- Solana libs ---
commit "client: add Solana connection and address helpers" \
  client/lib/solana/connection.ts client/lib/solana/address.ts client/lib/solana/rpc.ts
commit "client: add vault, treasury and funds transfer helpers" \
  client/lib/solana/vault.ts client/lib/solana/treasury.ts client/lib/solana/funds.ts
commit "client: add account and health readers" \
  client/lib/solana/account.ts client/lib/solana/health.ts client/lib/solana/book.ts
commit "client: Solana RPC proxy route" client/app/api/solana/

# --- Venue ledger ---
commit "client: venue ledger with fees, gifts and bans" client/lib/market/venue.ts
commit "client: signup gift rules and tests" \
  client/lib/market/gift.ts client/lib/market/gift.test.ts
commit "client: venue deposit API with confirm polling" client/app/api/venue/deposit/
commit "client: venue withdraw API with principal auto-pay" client/app/api/venue/withdraw/
commit "client: venue account, gift and stake APIs" \
  client/app/api/venue/account/ client/app/api/venue/gift/ client/app/api/stake/
commit "client: stake math and persistence" \
  client/lib/market/stake.ts client/lib/market/stakes.ts client/lib/market/stake.test.ts

# --- Marks / AI / desk intel ---
commit "client: live marks from Yahoo and Binance" \
  client/lib/market/marks.ts client/lib/market/marks.test.ts client/app/api/prices/
commit "client: LLM router with UsePod first" client/lib/market/llm.ts
commit "client: market AI analysis and desk brief APIs" \
  client/lib/market/ai-analysis.ts client/lib/market/ai-analysis.test.ts \
  client/app/api/markets/\[id\]/ai/ client/app/api/desk/
commit "client: callouts, thesis and subscribe stores" \
  client/lib/market/callouts.ts client/lib/market/callouts-store.ts \
  client/lib/market/callouts.test.ts client/lib/market/subscribe.ts \
  client/lib/market/subscribe.test.ts client/app/api/callouts/ client/app/api/subscribe/
commit "client: liquidation map and symbol details" \
  client/lib/market/liquidation-map.ts client/lib/market/liquidation-map.test.ts \
  client/lib/market/symbol-details.ts client/lib/market/symbol-details.test.ts \
  client/app/api/markets/\[id\]/liquidation-map/ client/app/api/markets/\[id\]/details/
commit "client: market info, on-chain book and quick market helpers" \
  client/lib/market/info.ts client/lib/market/onchain-book.ts \
  client/lib/market/onchain-book.test.ts client/lib/market/quick-market.ts \
  client/lib/market/quick-market.test.ts client/app/api/markets/\[id\]/info/
commit "client: TP/SL helpers and leaderboard utils" \
  client/lib/market/tpsl.ts client/lib/market/tpsl.test.ts \
  client/lib/market/leaderboard.ts client/lib/market/leaderboard.test.ts \
  client/lib/market/desk-tour.ts client/lib/market/desk-tour.test.ts

# --- Admin ---
commit "client: harden admin session auth" client/lib/admin-auth.ts client/middleware.ts
commit "client: admin login and session APIs" \
  client/app/api/admin/login/ client/app/api/admin/logout/ \
  client/app/api/admin/session/
commit "client: admin overview, traders, payouts and bans APIs" \
  client/app/api/admin/overview/ client/app/api/admin/traders/ \
  client/app/api/admin/payouts/ client/app/api/admin/bans/
commit "client: admin shell and login UI" \
  client/components/admin/ client/app/admin/login/ client/app/admin/layout.tsx
commit "client: admin overview, traders and payouts pages" \
  client/app/admin/page.tsx client/app/admin/traders/ client/app/admin/payouts/

# --- Wallet / providers ---
commit "client: Solana wallet provider wiring" \
  client/features/wallet/SolanaWalletProvider.tsx \
  client/features/wallet/components/WalletConnect.tsx \
  client/components/common/Providers.tsx
commit "client: FloyDex logo and asset logos" \
  client/components/common/FloyDexLogo.tsx client/components/common/AssetLogos.tsx \
  client/components/common/ErrorBoundary.tsx client/components/common/TopNav.tsx

# --- Trade UI ---
commit "client: FloyDex chart replaces Kryon chart" \
  client/features/chart/components/FloyDexChart.tsx \
  client/features/chart/components/TradingViewWidget.tsx \
  client/features/chart/types.ts \
  client/features/chart/components/ChartTopBar.tsx \
  client/features/chart/components/KryonChart.tsx
commit "client: deposit/withdraw dialog for venue USDC" \
  client/features/trade/components/DepositWithdrawDialog.tsx
commit "client: order entry with platform fee display" \
  client/features/trade/components/OrderEntry.tsx \
  client/features/trade/hooks/usePlaceMarketOrder.ts \
  client/features/trade/hooks/useSignupGift.ts
commit "client: quick market bar and market picker" \
  client/features/trade/components/QuickMarketBar.tsx \
  client/features/trade/components/MarketPicker.tsx \
  client/features/trade/components/MarketHeader.tsx \
  client/features/trade/components/MarketInfo.tsx
commit "client: AI analysis, liquidation map and thesis panels" \
  client/features/trade/components/AiAnalysisPanel.tsx \
  client/features/trade/components/AiSpark.tsx \
  client/features/trade/components/LiquidationMap.tsx \
  client/features/trade/components/ThesisFeed.tsx \
  client/features/trade/components/SymbolDetails.tsx \
  client/features/trade/components/DeskTour.tsx
commit "client: trade terminal grid and chart shell" \
  client/features/trade/components/TradeTerminalGrid.tsx \
  client/features/trade/components/TradeChart.tsx \
  client/features/trade/components/BottomPanel.tsx \
  client/features/trade/components/AccountBar.tsx
commit "client: order book, positions and history tables" \
  client/features/trade/components/OrderBook.tsx \
  client/features/trade/components/PositionsTable.tsx \
  client/features/trade/components/OpenOrdersTable.tsx \
  client/features/trade/components/OrderHistoryTable.tsx \
  client/features/trade/components/TradeHistoryTable.tsx \
  client/features/trade/components/FundingHistoryTable.tsx \
  client/features/trade/components/MarketsTable.tsx \
  client/features/trade/components/SettlementModal.tsx \
  client/features/trade/components/MarketDataProvider.tsx
commit "client: navbar futures menu and popular ticker" \
  client/features/navbar/components/FuturesMenu.tsx \
  client/features/navbar/components/PopularTicker.tsx \
  client/features/navbar/components/NotificationBell.tsx \
  client/features/navbar/components/SettingsMenu.tsx \
  client/features/network/components/NetworkToggle.tsx \
  client/features/collateral/useCollateral.ts \
  client/features/desk/

# --- App routes / branding ---
commit "client: landing and layout brand pass" \
  client/app/LandingPage.tsx client/app/layout.tsx client/app/globals.css \
  client/app/shift5.css
commit "client: trade, markets, portfolio and leaderboard pages" \
  client/app/trade/ client/app/markets/page.tsx client/app/portfolio/ \
  client/app/leaderboard/
commit "client: stake page" client/app/stake/
commit "client: favicons, logos and PWA manifest" \
  client/app/favicon.ico client/app/icon.png client/app/icon.svg \
  client/app/apple-icon.png client/app/manifest.ts client/app/robots.ts \
  client/public/
commit "client: logo render script" client/scripts/render-logo.mjs

# --- Shared client libs / API cleanup ---
commit "client: format, rate-limit and validation helpers" \
  client/lib/format.ts client/lib/format.test.ts client/lib/rate-limit.ts \
  client/lib/validation.ts client/lib/device.ts client/lib/secrets-check.ts \
  client/lib/db.ts client/lib/network-resolve.ts client/lib/network-server.ts
commit "client: order intent and matcher brand cleanup" \
  client/lib/market/matcher.ts client/lib/market/order-intent.ts \
  client/lib/market/signing-message.ts client/lib/market/websocket.ts
commit "client: keep stellar stubs as read-only adapters" \
  client/lib/stellar/contracts.ts client/lib/stellar/reflector.ts
commit "client: refresh core trading API routes" \
  client/app/api/fills/route.ts client/app/api/health/route.ts \
  client/app/api/leaderboard/route.ts client/app/api/orders/route.ts \
  client/app/api/orders/cancel/route.ts \
  client/app/api/portfolio/\[address\]/route.ts \
  client/app/api/markets/\[id\]/orderbook/route.ts \
  client/app/api/markets/\[id\]/trades/route.ts
commit "client: stores and keeper script brand cleanup" \
  client/stores/ client/scripts/

# --- ClawPump skill ---
commit "skills: add FloyDex perps ClawPump skill (no token launch)" skills/

# --- Catch-all remaining ---
# Anything left that is not ignored
git add -A
# Ensure secrets never land
git reset HEAD -- .env 2>/dev/null || true
git reset HEAD -- '**/.env' 2>/dev/null || true
git reset HEAD -- '**/*keys*.json' 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "$(cat <<'EOF'
chore: sweep remaining FloyDex desk and docs sync

EOF
)"
fi

echo "----"
git rev-list --count origin/main..HEAD 2>/dev/null || git rev-list --count HEAD
git status -sb
