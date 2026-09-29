# FloyDex — Trade desk

Next.js frontend for [FloyDex](https://floydex.com)
([FloyDex-Alpha](https://github.com/FloyDex/FloyDex-Alpha)):
Solana-native tokenized-stock perps. Telegram: [t.me/floydex_com](https://t.me/floydex_com) · X: [@floydex_com](https://x.com/floydex_com) · [$FLOYDEX](https://dexscreener.com/solana/2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy) (`2PuJ8eLNWeHLhG5YR5SD4mNwkQGduBiW2CWPuYq3vUPy`).

## Setup

```bash
npm install
```

Env lives at the **repo root** `.env` (see `.env.example` in this folder for keys).

```bash
npm run dev        # http://localhost:3000
```

## Stack

Next.js App Router, Solana wallet adapter, venue ledger APIs under `app/api/`.
