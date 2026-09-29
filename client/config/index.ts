// Market definitions, precision constants, and the *active* network's
// addresses.
//
// The per-network address tables live in `./networks.ts`. This module picks one
// of them and re-exports it under the flat names the app has always used
// (`NETWORK`, `CONTRACTS`, `ASSETS`), so the ~20 existing consumers did not
// have to change.
//
// ── How the active network is chosen ─────────────────────────────────────────
// In the browser this is evaluated once per page load, from `?network=` or the
// `floydex_network` cookie (see lib/network-resolve.ts). Switching networks in the
// navbar performs a full reload, which re-evaluates this module — that is what
// makes a static const safe here, and it is deliberate: a full reload is the
// only way to guarantee no mainnet state survives into a testnet view. The
// memoised RPC client, the WebSocket connection, in-flight polls, and every
// component's cached balances/positions are all process-local singletons; an
// in-place swap would have to invalidate each one, and missing a single one
// means showing mainnet balances against testnet contracts.
//
// On the SERVER these consts resolve to the deployment's primary network and
// are therefore NOT per-request. Server code that must honour the caller's
// choice (API routes) resolves it explicitly with `getNetworkConfig(...)` and
// the helpers in `lib/network-server.ts`.
//
// Keeper scripts under `scripts/` run one network per process and get their
// network from `NEXT_PUBLIC_STELLAR_NETWORK` in their env file, exactly as
// before.

import {
  getNetworkConfig,
  PRIMARY_NETWORK,
  type NetworkConfig,
  type NetworkId,
} from "./networks";
import { resolveClientNetwork } from "@/lib/network-resolve";

export {
  NETWORKS,
  NETWORK_IDS,
  PRIMARY_NETWORK,
  getNetworkConfig,
  isNetworkId,
} from "./networks";
export type {
  NetworkId,
  NetworkConfig,
  ContractSet,
  AssetSet,
  CollateralAsset,
} from "./networks";

/** The network this module's flat exports are bound to. See the note above. */
export const ACTIVE_NETWORK_ID: NetworkId =
  typeof window === "undefined" ? PRIMARY_NETWORK : resolveClientNetwork();

const ACTIVE: NetworkConfig = getNetworkConfig(ACTIVE_NETWORK_ID);

export const NETWORK = {
  name: ACTIVE.id,
  rpcUrl: ACTIVE.rpcUrl,
  passphrase: ACTIVE.passphrase,
  horizonUrl: ACTIVE.horizonUrl,
} as const;

export const CONTRACTS = ACTIVE.contracts;

export const ASSETS = ACTIVE.assets;

/**
 * Assets the vault may accept as margin. This is the *candidate* list; call
 * `listVaultCollateral()` in lib/stellar/collateral.ts to narrow it to what the
 * vault has actually listed and left active on-chain.
 */
export const COLLATERAL = ACTIVE.collateral;

/**
 * The asset PnL, funding and liquidation settle in. Every market quotes in it,
 * and losses always debit it — other collateral is seized to cover that debit.
 */
export const SETTLEMENT_ASSET =
  ACTIVE.collateral.find((c) => c.settlement) ?? ACTIVE.collateral[0];

/** Trading fee charged on every fill, both sides (buy and sell). 100 bps = 1%. */
export const PLATFORM_FEE_BPS = 100;
/** USDC destination for collected platform fees. */
export const FEE_COLLECTOR = "HPXzdeaarrnLL8PKGi11PT2BBd8HY5yty7WwDBZavCbn";

export const MARKETS: Record<string, MarketConfig> = {
  "XLM-PERP": {
    marketId: 1,
    symbol: "XLM-PERP",
    displayName: "XLM-PERP",
    baseAsset: "XLM",
    quoteAsset: "USDC",
    oracleSymbol: "XLM",
    priceSourceSymbol: "XLMUSDT",
    reflectorSymbol: "XLM",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "BINANCE:XLMUSDT",
    maxLeverageBps: 100000, // 10x — 1e8/initialMarginBps; matches on-chain engine max_leverage_bps
    initialMarginBps: 1000,  // 10%
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 4,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 1_450_000,   // ≈ $300k @ $0.2038 (ref 2026-08-22)
    maxOpenInterestUsd: 300_000,
  },
  "BTC-PERP": {
    marketId: 2,
    symbol: "BTC-PERP",
    displayName: "BTC-PERP",
    baseAsset: "BTC",
    quoteAsset: "USDC",
    oracleSymbol: "BTC",
    priceSourceSymbol: "BTCUSDT",
    reflectorSymbol: "BTC",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "BINANCE:BTCUSDT",
    maxLeverageBps: 500000, // 50x
    initialMarginBps: 200,   // 2%
    maintenanceMarginBps: 100, // 1%
    liquidationFeeBps: 25,
    priceDecimals: 1,
    sizeDecimals: 4,
    tickSizes: [0.1, 1, 10, 100],
    maxOpenInterestBase: 25,          // ≈ $1.9M @ $77,334 (ref 2026-08-22)
    maxOpenInterestUsd: 2_000_000,
  },
  "ETH-PERP": {
    marketId: 3,
    symbol: "ETH-PERP",
    displayName: "ETH-PERP",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    oracleSymbol: "ETH",
    priceSourceSymbol: "ETHUSDT",
    reflectorSymbol: "ETH",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "BINANCE:ETHUSDT",
    maxLeverageBps: 200000, // 20x
    initialMarginBps: 500,   // 5%
    maintenanceMarginBps: 250, // 2.5%
    liquidationFeeBps: 35,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 10],
    maxOpenInterestBase: 400,         // ≈ $1M @ $2,441 (ref 2026-08-22)
    maxOpenInterestUsd: 1_000_000,
  },
  "SOL-PERP": {
    marketId: 4,
    symbol: "SOL-PERP",
    displayName: "SOL-PERP",
    baseAsset: "SOL",
    quoteAsset: "USDC",
    oracleSymbol: "SOL",
    priceSourceSymbol: "SOLUSDT",
    reflectorSymbol: "SOL",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "COINBASE:SOLUSD",
    maxLeverageBps: 100000, // 10x
    initialMarginBps: 1000,  // 10%
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 5_000,       // ≈ $500k @ $94.14 (ref 2026-08-22)
    maxOpenInterestUsd: 500_000,
  },
  "XRP-PERP": {
    marketId: 5,
    symbol: "XRP-PERP",
    displayName: "XRP-PERP",
    baseAsset: "XRP",
    quoteAsset: "USDC",
    oracleSymbol: "XRP",
    priceSourceSymbol: "XRPUSDT",
    reflectorSymbol: "XRP",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "BINANCE:XRPUSDT",
    maxLeverageBps: 100000, // 10x
    initialMarginBps: 1000,  // 10%
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 325_000,     // ≈ $500k @ $1.522 (ref 2026-08-22)
    maxOpenInterestUsd: 500_000,
  },
  "ADA-PERP": {
    marketId: 6,
    symbol: "ADA-PERP",
    displayName: "ADA-PERP",
    baseAsset: "ADA",
    quoteAsset: "USDC",
    oracleSymbol: "ADA",
    priceSourceSymbol: "ADAUSDT",
    reflectorSymbol: "ADA",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "BINANCE:ADAUSDT",
    maxLeverageBps: 50000,  // 5x
    initialMarginBps: 2000,  // 20%
    maintenanceMarginBps: 1000, // 10%
    liquidationFeeBps: 50,
    priceDecimals: 4,
    sizeDecimals: 1,
    tickSizes: [0.0001, 0.001, 0.01, 0.1],
    maxOpenInterestBase: 850_000,     // ≈ $200k @ $0.2320 (ref 2026-08-22)
    maxOpenInterestUsd: 200_000,
  },
  // NOTE: BNB and TRX have NO Reflector feed (absent from the External CEX &
  // DEX oracle's asset list on both networks), so `reflectorSymbol` is omitted
  // and the divergence guard in oracle-keeper.ts is skipped for them. They run
  // on the 3-source CEX median alone — a weaker posture, reflected in their
  // conservative leverage and OI caps.
  "BNB-PERP": {
    marketId: 7,
    symbol: "BNB-PERP",
    displayName: "BNB-PERP",
    baseAsset: "BNB",
    quoteAsset: "USDC",
    oracleSymbol: "BNB",
    priceSourceSymbol: "BNBUSDT",
    settlementAsset: ASSETS.usdc,
    // Coinbase does not list BNB; BINANCE:BNBUSDT is the pair the oracle uses.
    tvSymbol: "BINANCE:BNBUSDT",
    maxLeverageBps: 100000, // 10x
    initialMarginBps: 1000,  // 10%
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 425,         // ≈ $300k @ $695.18 (ref 2026-08-22)
    maxOpenInterestUsd: 300_000,
  },
  "TRX-PERP": {
    marketId: 8,
    symbol: "TRX-PERP",
    displayName: "TRX-PERP",
    baseAsset: "TRX",
    quoteAsset: "USDC",
    oracleSymbol: "TRX",
    priceSourceSymbol: "TRXUSDT",
    settlementAsset: ASSETS.usdc,
    // Coinbase has no TRX pair on TradingView (COINBASE:TRXUSD 404s and the
    // chart renders "This symbol doesn't exist"). Binance is the venue we
    // already price TRX against.
    tvSymbol: "BINANCE:TRXUSDT",
    maxLeverageBps: 50000,  // 5x
    initialMarginBps: 2000,  // 20%
    maintenanceMarginBps: 1000, // 10%
    liquidationFeeBps: 50,
    priceDecimals: 5,
    sizeDecimals: 0,
    tickSizes: [0.00001, 0.0001, 0.001, 0.01],
    maxOpenInterestBase: 575_000,     // ≈ $200k @ $0.3456 (ref 2026-08-22)
    maxOpenInterestUsd: 200_000,
  },
  "TSLA-PERP": {
    marketId: 9,
    symbol: "TSLA-PERP",
    displayName: "TSLA-PERP",
    kind: "equity",
    baseAsset: "TSLA",
    quoteAsset: "USDC",
    oracleSymbol: "TSLA",
    priceSourceSymbol: "TSLA",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:TSLA",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 700,
    maxOpenInterestUsd: 300_000,
  },
  "NVDA-PERP": {
    marketId: 10,
    symbol: "NVDA-PERP",
    displayName: "NVDA-PERP",
    kind: "equity",
    baseAsset: "NVDA",
    quoteAsset: "USDC",
    oracleSymbol: "NVDA",
    priceSourceSymbol: "NVDA",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:NVDA",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 1_600,
    maxOpenInterestUsd: 300_000,
  },
  "AAPL-PERP": {
    marketId: 11,
    symbol: "AAPL-PERP",
    displayName: "AAPL-PERP",
    kind: "equity",
    baseAsset: "AAPL",
    quoteAsset: "USDC",
    oracleSymbol: "AAPL",
    priceSourceSymbol: "AAPL",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:AAPL",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 1_300,
    maxOpenInterestUsd: 300_000,
  },
  "SPY-PERP": {
    marketId: 12,
    symbol: "SPY-PERP",
    displayName: "SPY-PERP",
    kind: "equity",
    baseAsset: "SPY",
    quoteAsset: "USDC",
    oracleSymbol: "SPY",
    priceSourceSymbol: "SPY",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "AMEX:SPY",
    maxLeverageBps: 50000,
    initialMarginBps: 2000,
    maintenanceMarginBps: 1000,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 500,
    maxOpenInterestUsd: 300_000,
  },
  "META-PERP": {
    marketId: 13,
    symbol: "META-PERP",
    displayName: "META-PERP",
    kind: "equity",
    baseAsset: "META",
    quoteAsset: "USDC",
    oracleSymbol: "META",
    priceSourceSymbol: "META",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:META",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 500,
    maxOpenInterestUsd: 300_000,
  },
  "AMZN-PERP": {
    marketId: 14,
    symbol: "AMZN-PERP",
    displayName: "AMZN-PERP",
    kind: "equity",
    baseAsset: "AMZN",
    quoteAsset: "USDC",
    oracleSymbol: "AMZN",
    priceSourceSymbol: "AMZN",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:AMZN",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 1_500,
    maxOpenInterestUsd: 300_000,
  },
  "QQQ-PERP": {
    marketId: 15,
    symbol: "QQQ-PERP",
    displayName: "QQQ-PERP",
    kind: "equity",
    baseAsset: "QQQ",
    quoteAsset: "USDC",
    oracleSymbol: "QQQ",
    priceSourceSymbol: "QQQ",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:QQQ",
    maxLeverageBps: 50000, // 5x — index ETF, same band as SPY
    initialMarginBps: 2000,
    maintenanceMarginBps: 1000,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 600,
    maxOpenInterestUsd: 300_000,
  },
  "MSFT-PERP": {
    marketId: 16,
    symbol: "MSFT-PERP",
    displayName: "MSFT-PERP",
    kind: "equity",
    baseAsset: "MSFT",
    quoteAsset: "USDC",
    oracleSymbol: "MSFT",
    priceSourceSymbol: "MSFT",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:MSFT",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 700,
    maxOpenInterestUsd: 300_000,
  },
  "COIN-PERP": {
    marketId: 17,
    symbol: "COIN-PERP",
    displayName: "COIN-PERP",
    kind: "equity",
    baseAsset: "COIN",
    quoteAsset: "USDC",
    oracleSymbol: "COIN",
    priceSourceSymbol: "COIN",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:COIN",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 1_200,
    maxOpenInterestUsd: 300_000,
  },
  "MSTR-PERP": {
    marketId: 18,
    symbol: "MSTR-PERP",
    displayName: "MSTR-PERP",
    kind: "equity",
    baseAsset: "MSTR",
    quoteAsset: "USDC",
    oracleSymbol: "MSTR",
    priceSourceSymbol: "MSTR",
    settlementAsset: ASSETS.usdc,
    tvSymbol: "NASDAQ:MSTR",
    maxLeverageBps: 100000,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    liquidationFeeBps: 50,
    priceDecimals: 2,
    sizeDecimals: 3,
    tickSizes: [0.01, 0.1, 1, 5],
    maxOpenInterestBase: 800,
    maxOpenInterestUsd: 300_000,
  },
};

// The intended production set. A missing NEXT_PUBLIC_ACTIVE_MARKETS must not
// silently collapse the venue to a single market (it did until 2026-08-22).
const DEFAULT_ACTIVE_MARKETS = [
  "TSLA-PERP",
  "NVDA-PERP",
  "AAPL-PERP",
  "SPY-PERP",
  "META-PERP",
  "AMZN-PERP",
  "QQQ-PERP",
  "MSFT-PERP",
  "COIN-PERP",
  "MSTR-PERP",
  "SOL-PERP",
  "BTC-PERP",
  "ETH-PERP",
  "XLM-PERP",
  "XRP-PERP",
  "ADA-PERP",
  "BNB-PERP",
  "TRX-PERP",
].join(",");

function parseActiveMarketSymbols(raw: string | undefined): string[] {
  const symbols = (raw ?? DEFAULT_ACTIVE_MARKETS)
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(symbols));
  const unknown = unique.filter((symbol) => !(symbol in MARKETS));
  if (unknown.length > 0) {
    throw new Error(`Unknown active market(s): ${unknown.join(", ")}`);
  }
  if (unique.length === 0) {
    throw new Error("NEXT_PUBLIC_ACTIVE_MARKETS must include at least one market");
  }
  return unique;
}

// `NEXT_PUBLIC_ACTIVE_MARKETS` is legacy and, like the OVERRIDES in
// networks.ts, only applies to the deployment's PRIMARY network — it was never
// network-scoped, so pinning it (e.g. to a single market during a phased
// mainnet rollout) silently capped BOTH sides of the navbar toggle at once.
// The secondary network now defaults to every known market instead, and can
// be pinned independently with `NEXT_PUBLIC_ACTIVE_MARKETS_MAINNET` /
// `NEXT_PUBLIC_ACTIVE_MARKETS_TESTNET`.
const ACTIVE_MARKETS_ENV_BY_NETWORK: Record<NetworkId, string | undefined> = {
  mainnet:
    process.env.NEXT_PUBLIC_ACTIVE_MARKETS_MAINNET ??
    (PRIMARY_NETWORK === "mainnet" ? process.env.NEXT_PUBLIC_ACTIVE_MARKETS : undefined),
  testnet:
    process.env.NEXT_PUBLIC_ACTIVE_MARKETS_TESTNET ??
    (PRIMARY_NETWORK === "testnet" ? process.env.NEXT_PUBLIC_ACTIVE_MARKETS : undefined),
};

export const ACTIVE_MARKET_SYMBOLS = parseActiveMarketSymbols(
  ACTIVE_MARKETS_ENV_BY_NETWORK[ACTIVE_NETWORK_ID]
);

export const ACTIVE_MARKETS: Record<string, MarketConfig> = Object.fromEntries(
  ACTIVE_MARKET_SYMBOLS.map((symbol) => [symbol, MARKETS[symbol]])
);
export const DEFAULT_MARKET_SYMBOL = ACTIVE_MARKET_SYMBOLS[0];

export interface MarketConfig {
  marketId: number;
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  oracleSymbol: string;
  priceSourceSymbol: string;
  settlementAsset: string;
  tvSymbol: string;
  maxLeverageBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;

  /** Price display precision. 1 for BTC ($76,996.5), 5 for TRX ($0.24187). */
  priceDecimals: number;
  /** Base-unit (size) display precision. */
  sizeDecimals: number;
  /** Order-book aggregation ladder, finest first. Drives OrderBook's TICKS. */
  tickSizes: number[];
  /**
   * Reflector "External CEX & DEX" asset symbol, used ONLY as an independent
   * divergence cross-check (never as the mark price — its 300s resolution is
   * far outside the 120s on-chain staleness guard). Omitted when Reflector has
   * no feed for the asset, which disables the guard for that market.
   */
  reflectorSymbol?: string;
  /** Crypto (Binance spot pair) vs tokenized equity (Yahoo / Binance RWA). */
  kind?: "crypto" | "equity";
  /**
   * On-chain `max_open_interest`, in whole base-asset units (registered as
   * PRECISION * units). A fixed unit cap sized to `maxOpenInterestUsd` at the
   * reference price noted per market — revisit if spot moves materially.
   */
  maxOpenInterestBase: number;
  /** The USD notional intent behind `maxOpenInterestBase`. Sizing/reference only. */
  maxOpenInterestUsd: number;
}

// Precision: oracle prices and PnL values use 1e18 scale; USDC amounts use 1e7 (Stellar stroop-equivalent)
export const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
export const AMOUNT_PRECISION = BigInt("1000000"); // 1e6 (USDC decimals)
export const BPS_PRECISION = 10000;

// ─── Off-chain service endpoints ─────────────────────────────────────────────
// The matcher and indexer are reached through this app's own /api routes, so
// they need no per-network URL — the route resolves the caller's network and
// picks the matching database.
//
// The WebSocket server is a separate process per network (one ws-server can
// only tail one database), so it DOES need a per-network address. The testnet
// var is optional: unset simply means the UI falls back to REST polling for
// testnet, which is the same graceful degradation mainnet already had.

// The legacy single-network `NEXT_PUBLIC_WS_URL` belongs to whichever network
// the deployment was built for — inheriting it into the other one would point
// the testnet UI at the mainnet feed (or vice versa).
const LEGACY_WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "";

const WS_URL_BY_NETWORK: Record<NetworkId, string> = {
  mainnet:
    process.env.NEXT_PUBLIC_WS_URL_MAINNET ??
    (PRIMARY_NETWORK === "mainnet" ? LEGACY_WS_URL : ""),
  testnet:
    process.env.NEXT_PUBLIC_WS_URL_TESTNET ??
    (PRIMARY_NETWORK === "testnet" ? LEGACY_WS_URL : ""),
};

export function getWsUrl(network: NetworkId): string {
  return WS_URL_BY_NETWORK[network] ?? "";
}

export const WS_URL = getWsUrl(ACTIVE_NETWORK_ID);

/** Whether the selected venue has keepers behind it (drives the degraded banner). */
export const KEEPERS_EXPECTED = ACTIVE.keepersExpected;

export const STELLAR_EXPERT_URL = ACTIVE.explorerUrl;

export const NETWORK_LABEL = ACTIVE.label;
