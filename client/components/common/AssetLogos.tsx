// Local marks from CoinGecko/cryptocurrency-icons (crypto) and
// Financial Modeling Prep company icons (equities). Prefer logoFor() /
// <AssetLogo /> so every market renders a real mark.

import type { ReactNode } from "react";

type LogoFile = {
  src: string;
  bg?: string;
  pad?: number;
  invert?: boolean;
  /** Paint the mark solid white on a saturated brand disc. */
  knockout?: boolean;
  /** Zoom the glyph inside the disc (PNGs with extra canvas padding). */
  scale?: number;
};

const FILES: Record<string, LogoFile> = {
  USDC: { src: "/logos/usdc.svg" },
  BTC: { src: "/logos/btc.svg" },
  ETH: { src: "/logos/eth.svg" },
  SOL: { src: "/logos/sol.svg?v=6" },
  XLM: { src: "/logos/xlm.svg" },
  XRP: { src: "/logos/xrp.svg" },
  ADA: { src: "/logos/ada.svg" },
  BNB: { src: "/logos/bnb.svg" },
  TRX: { src: "/logos/trx.svg" },
  TSLA: { src: "/logos/TSLA.png", bg: "#E31937", pad: 0.16, knockout: true },
  NVDA: { src: "/logos/NVDA.png", bg: "#111111", pad: 0.1 },
  AAPL: { src: "/logos/aapl.svg?v=5" },
  SPY: { src: "/logos/SPY.png", bg: "#1A2A1C", pad: 0.14 },
  META: { src: "/logos/META.png", bg: "#0082FB", pad: 0.16, knockout: true },
  AMZN: { src: "/logos/AMZN.png?v=2", bg: "#FF9900", pad: 0.18, knockout: true },
  QQQ: { src: "/logos/qqq.svg" },
  MSFT: { src: "/logos/msft.svg", pad: 0.12 },
  COIN: { src: "/logos/coin.svg?v=2" },
  MSTR: { src: "/logos/MSTR.png?v=1", pad: 0 },
};

function FileLogo({ file, size }: { file: LogoFile; size: number }) {
  const inset = Math.round(size * (file.pad ?? 0));
  const filter = file.knockout ? "brightness(0) invert(1)" : file.invert ? "invert(1)" : undefined;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        background: file.bg ?? "transparent",
        padding: inset,
        boxShadow: file.bg ? "inset 0 0 0 1px rgba(255,255,255,0.1)" : undefined,
      }}
    >
      <img
        src={file.src}
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        style={{
          filter,
          transform: file.scale ? `scale(${file.scale})` : undefined,
        }}
        draggable={false}
      />
    </span>
  );
}

export function Usdt0Logo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="1000" cy="1000" r="1000" fill="#009393" />
      <circle cx="1000" cy="1000" r="880" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="55" />
      <path
        fill="#ffffff"
        d="M1128 872v-138h318V522H556v212h318v138c-258 12-452 63-452 124s194 112 452 124v442h254v-442c258-12 452-63 452-124s-194-112-452-124zm0 407v-1c-6 0-39 2-127 2-70 0-119-2-137-2v1c-274-12-478-60-478-117s204-105 478-117v186c18 1 69 4 138 4 84 0 119-3 126-4v-186c273 12 477 60 477 117s-204 105-477 117z"
      />
    </svg>
  );
}

export function UsdcLogo({ size = 16 }: { size?: number }) {
  return <FileLogo file={FILES.USDC} size={size} />;
}

export function LetterLogo({ symbol, size = 16 }: { symbol: string; size?: number }) {
  const letters = symbol.slice(0, 2).toUpperCase();
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="16" cy="16" r="16" fill={`hsl(${h} 42% 34%)`} />
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={letters.length > 1 ? 13 : 16}
        fontWeight="600"
        fill="#ffffff"
        fontFamily="system-ui, sans-serif"
      >
        {letters}
      </text>
    </svg>
  );
}

export function logoFor(symbol: string, size = 16): ReactNode {
  const base = (symbol ?? "").replace(/-PERP$/i, "").toUpperCase();
  if (base === "USDT0") return <Usdt0Logo size={size} />;
  const file = FILES[base];
  return file ? <FileLogo file={file} size={size} /> : <LetterLogo symbol={base || "?"} size={size} />;
}

export function AssetLogo({ symbol, size = 16 }: { symbol: string; size?: number }) {
  return <>{logoFor(symbol, size)}</>;
}
