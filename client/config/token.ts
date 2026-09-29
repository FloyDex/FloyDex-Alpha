/** Live $FLOYDEX mint and public trade links (pump.fun via ClawPump). */
export const FLOYDEX_TOKEN = {
  symbol: "FLOYDEX",
  name: "FloyDex",
  /** Fixed pump.fun supply. Confirmed on the mint account. */
  supply: 1_000_000_000,
  decimals: 6,
  mint: "2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy",
  pair: "7mmwd8DHp9S6mnkBUSFruynA5A3pUqp17Ka5KqxKdtCC",
  clawpump: "https://clawpump.tech/tokens/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy",
  dexscreener: "https://dexscreener.com/solana/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy",
  padre: "https://trade.padre.gg/trade/solana/7mmwd8DHp9S6mnkBUSFruynA5A3pUqp17Ka5KqxKdtCC",
  pumpfun: "https://pump.fun/coin/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy",
} as const;
