export type LiqMapBin = {
  price: number;
  longUsd: number;
  shortUsd: number;
  cumLongUsd: number;
  cumShortUsd: number;
  atUsd: number;
};

export type LiqMapPayload = {
  marketId: number;
  mark: number;
  source: string;
  updatedAt: number;
  points: LiqMapBin[];
  venueUsd: number;
  oiUsd: number;
};

export type VenueLiqPos = {
  isLong: boolean;
  size: number;
  entry: number;
  margin: number;
};

/** Isolated-style liq price from entry + leverage + maintenance. */
export function liqPriceAt(
  isLong: boolean,
  entry: number,
  leverage: number,
  mmBps: number,
): number {
  if (!(entry > 0) || !(leverage > 1)) return 0;
  const mm = mmBps / 10_000;
  const lev = Math.max(1.05, leverage);
  const px = isLong ? entry * (1 - 1 / lev + mm) : entry * (1 + 1 / lev - mm);
  return px > 0 ? px : 0;
}

/** Typical retail/pro leverage mix used by CoinGlass-style maps. */
export const LEVERAGE_WEIGHTS: { lev: number; w: number }[] = [
  { lev: 5, w: 0.1 },
  { lev: 10, w: 0.2 },
  { lev: 20, w: 0.22 },
  { lev: 25, w: 0.16 },
  { lev: 50, w: 0.18 },
  { lev: 75, w: 0.08 },
  { lev: 100, w: 0.06 },
];

export function weightsForMaxLev(maxLev: number): { lev: number; w: number }[] {
  const cap = Math.max(2, maxLev);
  const raw = LEVERAGE_WEIGHTS.filter((b) => b.lev <= cap + 0.01);
  const list = raw.length ? raw : [{ lev: cap, w: 1 }];
  const sum = list.reduce((s, b) => s + b.w, 0) || 1;
  return list.map((b) => ({ lev: b.lev, w: b.w / sum }));
}

function gauss(bins: number[], minP: number, step: number, center: number, usd: number, sigma: number) {
  if (!(usd > 0) || !(sigma > 0) || bins.length === 0) return;
  let total = 0;
  const w = new Array<number>(bins.length);
  for (let i = 0; i < bins.length; i++) {
    const p = minP + (i + 0.5) * step;
    const z = (p - center) / sigma;
    const ww = Math.exp(-0.5 * z * z);
    w[i] = ww;
    total += ww;
  }
  if (!(total > 0)) return;
  for (let i = 0; i < bins.length; i++) bins[i] += usd * (w[i] / total);
}

/** OurBit / KCEX pair id: BTC → BTC_USDT. */
export function ourbitPair(baseAsset: string): string {
  return `${baseAsset.replace(/[^A-Z0-9]/gi, "").toUpperCase()}_USDT`;
}

export type AggregatedMapRaw = {
  ts?: number;
  lp: number;
  x: number[];
  y: number[];
  l: number[];
  r: number[];
};

/** Convert OurBit `aggregated_map` `{x,y,l,r,lp}` into desk bins. */
export function binsFromAggregatedMap(raw: AggregatedMapRaw): { points: LiqMapBin[]; mark: number } {
  const x = raw.x ?? [];
  const y = raw.y ?? [];
  const l = raw.l ?? [];
  const r = raw.r ?? [];
  const mark = raw.lp;
  const n = x.length;
  if (!(n > 1) || !(mark > 0)) return { points: [], mark: 0 };
  const lPad = l.concat(new Array(Math.max(0, n - l.length)).fill(0));
  const rPad = new Array(Math.max(0, n - r.length)).fill(0).concat(r);
  const points: LiqMapBin[] = [];
  for (let i = 0; i < n; i++) {
    const price = x[i] ?? 0;
    const atUsd = y[i] ?? 0;
    points.push({
      price,
      longUsd: price <= mark ? atUsd : 0,
      shortUsd: price > mark ? atUsd : 0,
      cumLongUsd: lPad[i] ?? 0,
      cumShortUsd: rPad[i] ?? 0,
      atUsd,
    });
  }
  return { points, mark };
}

export function recomputeCum(points: LiqMapBin[], mark: number): LiqMapBin[] {
  const split = points.reduce((s, p, i) => (p.price <= mark ? i : s), -1);
  let run = 0;
  for (let i = split; i >= 0; i--) {
    run += points[i].atUsd;
    points[i].cumLongUsd = run;
    points[i].cumShortUsd = 0;
    points[i].longUsd = points[i].atUsd;
    points[i].shortUsd = 0;
  }
  run = 0;
  for (let i = split + 1; i < points.length; i++) {
    run += points[i].atUsd;
    points[i].cumShortUsd = run;
    points[i].cumLongUsd = 0;
    points[i].shortUsd = points[i].atUsd;
    points[i].longUsd = 0;
  }
  return points;
}

export function overlayVenueBins(
  points: LiqMapBin[],
  mark: number,
  venue: VenueLiqPos[],
  mmBps: number,
): { points: LiqMapBin[]; venueUsd: number } {
  if (!points.length) return { points, venueUsd: 0 };
  let venueUsd = 0;
  for (const p of venue) {
    if (!(p.size > 0) || !(p.entry > 0)) continue;
    const notional = p.size * p.entry;
    const lev = p.margin > 0 ? notional / p.margin : 10;
    const px = liqPriceAt(p.isLong, p.entry, lev, mmBps);
    if (!(px > 0)) continue;
    venueUsd += notional;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].price - px);
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    points[best].atUsd += notional;
  }
  if (venueUsd > 0) recomputeCum(points, mark);
  return { points, venueUsd };
}

export function assembleLiqMap(args: {
  mark: number;
  rangeLow: number;
  rangeHigh: number;
  mmBps: number;
  maxLev: number;
  oiUsd: number;
  longShare: number;
  venue: VenueLiqPos[];
  bins?: number;
}): { points: LiqMapBin[]; venueUsd: number } {
  const mark = args.mark;
  const n = Math.max(24, Math.min(args.bins ?? 80, 160));
  let low = Math.min(args.rangeLow, mark * 0.92);
  let high = Math.max(args.rangeHigh, mark * 1.08);
  if (!(low > 0) || !(high > low) || !(mark > 0)) {
    return { points: [], venueUsd: 0 };
  }
  const pad = (high - low) * 0.04;
  low = Math.max(mark * 0.5, low - pad);
  high = high + pad;
  const step = (high - low) / n;
  const longAt = new Array<number>(n).fill(0);
  const shortAt = new Array<number>(n).fill(0);

  const longShare = Math.min(0.9, Math.max(0.1, args.longShare));
  const longOi = Math.max(0, args.oiUsd) * longShare;
  const shortOi = Math.max(0, args.oiUsd) * (1 - longShare);
  const weights = weightsForMaxLev(args.maxLev);

  for (const b of weights) {
    const longPx = liqPriceAt(true, mark, b.lev, args.mmBps);
    const shortPx = liqPriceAt(false, mark, b.lev, args.mmBps);
    const sigma = mark * Math.max(0.003, 0.35 / b.lev);
    gauss(longAt, low, step, longPx, longOi * b.w, sigma);
    gauss(shortAt, low, step, shortPx, shortOi * b.w, sigma);
  }

  let venueUsd = 0;
  for (const p of args.venue) {
    if (!(p.size > 0) || !(p.entry > 0)) continue;
    const notional = p.size * p.entry;
    const lev = p.margin > 0 ? notional / p.margin : args.maxLev;
    const px = liqPriceAt(p.isLong, p.entry, lev, args.mmBps);
    if (!(px > 0)) continue;
    venueUsd += notional;
    const sigma = Math.max(step * 1.2, p.entry * 0.004);
    if (p.isLong) gauss(longAt, low, step, px, notional, sigma);
    else gauss(shortAt, low, step, px, notional, sigma);
  }

  const points: LiqMapBin[] = [];
  for (let i = 0; i < n; i++) {
    const price = low + (i + 0.5) * step;
    let cumLong = 0;
    let cumShort = 0;
    if (price <= mark) {
      for (let j = i; j < n; j++) {
        const pj = low + (j + 0.5) * step;
        if (pj > mark) break;
        cumLong += longAt[j];
      }
    } else {
      for (let j = i; j >= 0; j--) {
        const pj = low + (j + 0.5) * step;
        if (pj < mark) break;
        cumShort += shortAt[j];
      }
    }
    const atUsd = longAt[i] + shortAt[i];
    points.push({
      price,
      longUsd: longAt[i],
      shortUsd: shortAt[i],
      cumLongUsd: cumLong,
      cumShortUsd: cumShort,
      atUsd,
    });
  }
  return { points, venueUsd };
}
