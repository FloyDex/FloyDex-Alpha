# FloyDex — Trade desk

Next.js frontend for [FloyDex](https://floydex.com)
([FloyDex-Alpha](https://github.com/FloyDex/FloyDex-Alpha)):
Solana-native tokenized-stock perps.

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
