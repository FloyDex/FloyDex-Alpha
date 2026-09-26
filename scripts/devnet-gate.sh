#!/usr/bin/env bash
# Phase 2 gate, part 2 (09): deploy (or upgrade) kryon_perps on devnet at its
# declared id, then execute a real liquidation against Pyth's sponsored
# shard-0 SOL/USD feed (tests/e2e/devnet.mts).
#
#   RPC_URL=... USDC_MINT=... [DEPLOYER=~/.config/solana/id.json] \
#   [USDC_FUNDER=<keypair: the mint authority, or a wallet holding devnet USDC>] \
#   scripts/devnet-gate.sh
#
# The deployer is the upgrade authority and becomes the exchange admin; it
# needs ~14 SOL for the first deploy (program + buffer). Test keys go to the
# gitignored .devnet/keys; addresses and signatures to deployments/devnet.json.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RPC_URL:?set RPC_URL}"
: "${USDC_MINT:?set USDC_MINT}"
DEPLOYER="${DEPLOYER:-$HOME/.config/solana/id.json}"

test -f target/deploy/kryon_perps.so || { echo "build first: yarn build"; exit 1; }
PROGRAM_ID=$(node -p 'JSON.parse(require("fs").readFileSync("target/idl/kryon_perps.json", "utf8")).address')
KEYPAIR_ID=$(solana-keygen pubkey target/deploy/kryon_perps-keypair.json)
[ "$PROGRAM_ID" = "$KEYPAIR_ID" ] || { echo "declared id $PROGRAM_ID != program keypair $KEYPAIR_ID"; exit 1; }

echo "deployer $(solana-keygen pubkey "$DEPLOYER"): $(solana balance -u "$RPC_URL" -k "$DEPLOYER")"
solana program deploy -u "$RPC_URL" -k "$DEPLOYER" \
  --program-id target/deploy/kryon_perps-keypair.json \
  --with-compute-unit-price 10000 --max-sign-attempts 20 \
  target/deploy/kryon_perps.so

RPC_URL="$RPC_URL" USDC_MINT="$USDC_MINT" DEPLOYER="$DEPLOYER" USDC_FUNDER="${USDC_FUNDER:-$DEPLOYER}" \
  node tests/e2e/devnet.mts
