import { ACTIVE_MARKETS, type MarketConfig } from "@/config";

export const MARKET_LABELS: Record<string, { name: string; about: string }> = {
  "TSLA-PERP": {
    name: "Tesla, Inc.",
    about:
      "Tesla designs and manufactures electric vehicles, energy storage, and solar products. Perps here track NASDAQ:TSLA.",
  },
  "NVDA-PERP": {
    name: "NVIDIA Corporation",
    about: "NVIDIA designs GPUs and accelerated computing platforms. Perps here track NASDAQ:NVDA.",
  },
  "AAPL-PERP": {
    name: "Apple Inc.",
    about: "Apple designs consumer electronics, software, and services. Perps here track NASDAQ:AAPL.",
  },
  "SPY-PERP": {
    name: "SPDR S&P 500 ETF",
    about: "SPY tracks the S&P 500. Perps here track AMEX:SPY.",
  },
  "META-PERP": {
    name: "Meta Platforms, Inc.",
    about: "Meta operates Facebook, Instagram, WhatsApp, and Reality Labs. Perps here track NASDAQ:META.",
  },
  "AMZN-PERP": {
    name: "Amazon.com, Inc.",
    about: "Amazon runs e-commerce, AWS, and advertising. Perps here track NASDAQ:AMZN.",
  },
  "QQQ-PERP": {
    name: "Invesco QQQ Trust",
    about: "QQQ tracks the Nasdaq-100. Perps here track NASDAQ:QQQ.",
  },
  "MSFT-PERP": {
    name: "Microsoft Corporation",
    about: "Microsoft builds cloud, productivity, and AI platforms. Perps here track NASDAQ:MSFT.",
  },
  "COIN-PERP": {
    name: "Coinbase Global, Inc.",
    about: "Coinbase operates a crypto exchange and custody platform. Perps here track NASDAQ:COIN.",
  },
  "MSTR-PERP": {
    name: "MicroStrategy Incorporated",
    about: "MicroStrategy holds bitcoin as a treasury asset and sells enterprise software. Perps here track NASDAQ:MSTR.",
  },
  "BTC-PERP": { name: "Bitcoin", about: "USDT-margined BTC perpetual. Chart and last price follow BINANCE:BTCUSDT." },
  "ETH-PERP": { name: "Ethereum", about: "USDT-margined ETH perpetual. Chart and last price follow BINANCE:ETHUSDT." },
  "SOL-PERP": { name: "Solana", about: "USDT-margined SOL perpetual. Chart and last price follow BINANCE:SOLUSDT." },
  "XLM-PERP": { name: "Stellar", about: "USDT-margined XLM perpetual. Chart and last price follow BINANCE:XLMUSDT." },
  "XRP-PERP": { name: "XRP", about: "USDT-margined XRP perpetual. Chart and last price follow BINANCE:XRPUSDT." },
  "ADA-PERP": { name: "Cardano", about: "USDT-margined ADA perpetual. Chart and last price follow BINANCE:ADAUSDT." },
  "BNB-PERP": { name: "BNB", about: "USDT-margined BNB perpetual. Chart and last price follow BINANCE:BNBUSDT." },
  "TRX-PERP": { name: "TRON", about: "USDT-margined TRX perpetual. Chart and last price follow BINANCE:TRXUSDT." },
};

export function marketLabel(market: MarketConfig): string {
  return MARKET_LABELS[market.symbol]?.name ?? market.baseAsset;
}

export function isTradFi(market: MarketConfig): boolean {
  return market.kind === "equity";
}

export function usdtPerpMarkets(): MarketConfig[] {
  const preferred = ["BTC-PERP", "ETH-PERP", "SOL-PERP"];
  return Object.values(ACTIVE_MARKETS)
    .filter((m) => !isTradFi(m))
    .sort((a, b) => {
      const ia = preferred.indexOf(a.symbol);
      const ib = preferred.indexOf(b.symbol);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
}

export function tradFiMarkets(): MarketConfig[] {
  return Object.values(ACTIVE_MARKETS).filter(isTradFi);
}
