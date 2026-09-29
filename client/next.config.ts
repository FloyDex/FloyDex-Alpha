import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { NextConfig } from "next";

/** Repo-root `.env` is the only env file. It is applied with override so those values always win. */
const rootEnv = resolve(__dirname, "../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    let v = t.slice(i + 1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[t.slice(0, i).trim()] = v;
  }
}

const publicEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("NEXT_PUBLIC_") && typeof v === "string") publicEnv[k] = v;
}

const isDev = process.env.NODE_ENV !== "production";

/**
 * WebSocket origins allowed by connect-src.
 *
 * The blanket `wss:` this replaced permitted a live-price connection to ANY
 * host on the internet — the one directive that matters most here, since the
 * feed drives the mark price a trader acts on. The origins are known at build
 * time (they are the tunnel hostnames), so name them.
 *
 * Falls back to `wss:` when neither is configured: a deployment that has not
 * set them would otherwise build a CSP that blocks its own feed, and silently
 * degrading to REST polling is a worse failure than a broad directive.
 */
const wsOrigins = [
  process.env.NEXT_PUBLIC_WS_URL_MAINNET,
  process.env.NEXT_PUBLIC_WS_URL_TESTNET,
  process.env.NEXT_PUBLIC_WS_URL,
]
  .filter((u): u is string => Boolean(u))
  .map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return "";
    }
  })
  .filter(Boolean);

const wsConnectSrc = wsOrigins.length
  ? [...new Set(wsOrigins)].join(" ")
  : "wss:";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://s3.tradingview.com`,
  "frame-src 'self' https://s.tradingview.com https://www.tradingview.com",
  // Both networks' RPC and Horizon endpoints are listed: the navbar toggle
  // serves both venues from one bundle, so a build for either must be able to
  // reach the other's chain endpoints after a switch.
  `connect-src 'self' https://api.binance.com https://*.tradingview.com wss://*.tradingview.com https://api.devnet.solana.com https://api.mainnet-beta.solana.com https://*.helius-rpc.com https://api.usepod.ai https://clawpump.tech ${wsConnectSrc}${isDev ? " ws://localhost:8080 ws://localhost:8081" : ""}`,
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  env: publicEnv,
  // Self-host / Docker: standalone. Vercel supplies its own output — leave unset there.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  reactCompiler: true,
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
  // The Docusaurus docs site is built into public/docs as a static export and
  // served from this same deployment under /docs. Next doesn't resolve a folder
  // request to its index.html, so map clean /docs URLs onto the static files.
  // `afterFiles` means real assets (js/css/img under /docs) are served directly;
  // only bare route paths fall through to these rewrites.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        // Docusaurus (trailingSlash:false) emits flat .html files, e.g.
        // /docs/architecture/protocol.html. Real assets (js/css/img) exist on
        // disk and are served before these afterFiles rewrites kick in.
        { source: "/docs", destination: "/docs/index.html" },
        { source: "/docs/:path+", destination: "/docs/:path+.html" },
      ],
      fallback: [],
    };
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
