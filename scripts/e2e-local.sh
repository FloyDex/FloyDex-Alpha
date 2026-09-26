#!/usr/bin/env bash
# Phase 1 gate (09): a local validator, two users with session keys, 1,000
# random fills, conservation checked throughout. Everything lives in .e2e/
# (gitignored). Test keys are written before any chain call (11 L14).
#
#   scripts/e2e-local.sh [fills]      # default 1000
set -euo pipefail
cd "$(dirname "$0")/.."
FILLS="${1:-1000}"
E2E=.e2e
RPC=http://127.0.0.1:8899
FEED=7575757575757575757575757575757575757575757575757575757575757575

rm -rf "$E2E" && mkdir -p "$E2E/keys"
for k in admin operator guardian calendar alice bob alice_session bob_session mint_authority; do
  solana-keygen new --no-bip39-passphrase --silent --force -o "$E2E/keys/$k.json" >/dev/null
done
chmod 400 "$E2E"/keys/*.json

test -f target/deploy/kryon_perps.so || { echo "build first: yarn build"; exit 1; }
# The declared id, from the IDL: the validator loads the .so at this address,
# so no program keypair is needed (CI never has one; it is never committed).
PROGRAM_ID=$(node -p 'JSON.parse(require("fs").readFileSync("target/idl/kryon_perps.json", "utf8")).address')

# Mocked Pyth TSLA/USD at $250.00, 0.01% conf, published now.
NOW=$(date +%s)
node tests/e2e/mock-pyth.mts "$E2E/pyth-tsla.json" "$FEED" 0 25000000000 -8 2500000 "$NOW" >/dev/null

solana-test-validator --reset --quiet --ledger "$E2E/ledger" \
  --upgradeable-program "$PROGRAM_ID" target/deploy/kryon_perps.so "$E2E/keys/admin.json" \
  --account - "$E2E/pyth-tsla.json" \
  >"$E2E/validator.log" 2>&1 &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  solana -u "$RPC" cluster-version >/dev/null 2>&1 && break
  sleep 1
done
solana -u "$RPC" cluster-version >/dev/null

E2E_DIR="$E2E" E2E_FILLS="$FILLS" E2E_FEED="$FEED" RPC_URL="$RPC" node tests/e2e/gate.mts
