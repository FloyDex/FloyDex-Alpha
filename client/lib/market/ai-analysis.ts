export type FearClass = "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed";

export type AiBullet = {
  text: string;
  posts: number;
};

export type AiStance = "bullish" | "bearish" | "neutral";

export type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AiAnalysis = {
  marketId: number;
  symbol: string;
  base: string;
  generatedAt: number;
  meter: { kind: "fng" | "technicals"; value: number; label: string; source: string };
  summary: string;
  stance: AiStance;
  bullish: AiBullet[];
  bearish: AiBullet[];
  source: string;
  llm: boolean;
};

export const AI_PANEL_WIDTH_MIN = 300;
export const AI_PANEL_WIDTH_MAX = 720;
export const AI_PANEL_HEIGHT_MIN = 42;
export const AI_PANEL_HEIGHT_MAX = 100;
export const AI_QUESTION_MAX = 500;
export const AI_HISTORY_MAX = 8;

export function clampAiWidth(px: number): number {
  const n = Number.isFinite(px) ? px : 400;
  return Math.round(Math.max(AI_PANEL_WIDTH_MIN, Math.min(AI_PANEL_WIDTH_MAX, n)));
}

export function clampAiHeightPct(pct: number): number {
  const n = Number.isFinite(pct) ? pct : 80;
  return Math.round(Math.max(AI_PANEL_HEIGHT_MIN, Math.min(AI_PANEL_HEIGHT_MAX, n)));
}

export function sanitizeQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > AI_QUESTION_MAX) return null;
  return text;
}

export function clampChatHistory(raw: unknown): AiChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AiChatMessage[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { role?: unknown; content?: unknown };
    if (rec.role !== "user" && rec.role !== "assistant") continue;
    if (typeof rec.content !== "string") continue;
    const content = rec.content.trim().slice(0, 2_000);
    if (!content) continue;
    out.push({ role: rec.role, content });
  }
  return out.slice(-AI_HISTORY_MAX);
}

export function parseLlmJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
const EMOJI_SPLIT = /(?=[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}])/u;

/** Strip emoji, dingbats, and leftover leading bullets so the desk reads as text. */
export function stripDeskEmoji(text: string): string {
  return String(text ?? "")
    .replace(EMOJI, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s*•·\-–—]+/, "")
    .trim();
}

/** Models sometimes dump three emoji-led sentences into one array slot. */
export function expandBulletText(text: string, _side?: "bull" | "bear"): string[] {
  const trimmed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(EMOJI_SPLIT)
    .map((p) => stripDeskEmoji(p))
    .filter((p) => p.length > 8);
  return parts.length ? parts : [stripDeskEmoji(trimmed)].filter((p) => p.length > 8);
}

function asBulletList(value: unknown, posts = 0): AiBullet[] {
  if (!Array.isArray(value)) return [];
  const out: AiBullet[] = [];
  const count = posts > 0 ? posts : 0;
  for (const item of value) {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "text" in item
          ? String((item as { text?: unknown }).text ?? "")
          : "";
    for (const text of expandBulletText(raw)) {
      out.push({ text, posts: count });
    }
  }
  return out.slice(0, 4);
}

export function parseAnalysisPayload(
  raw: unknown,
  _posts?: { long: number; short: number },
): { summary: string; stance: AiStance; bullish: AiBullet[]; bearish: AiBullet[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const summary =
    typeof rec.summary === "string" ? rec.summary.replace(/\s+/g, " ").trim() : "";
  const stanceRaw = typeof rec.stance === "string" ? rec.stance.toLowerCase() : "";
  const stance: AiStance =
    stanceRaw === "bullish" || stanceRaw === "bearish" || stanceRaw === "neutral"
      ? stanceRaw
      : "neutral";
  const bullish = asBulletList(rec.bullish);
  const bearish = asBulletList(rec.bearish);
  if (!summary && !bullish.length && !bearish.length) return null;
  return {
    summary: summary.slice(0, 480),
    stance,
    bullish,
    bearish,
  };
}

export function stanceFromTechnicals(label: string): AiStance {
  if (/buy/i.test(label)) return "bullish";
  if (/sell/i.test(label)) return "bearish";
  return "neutral";
}

/** Map SMA/RSI score (-1..1) onto the 0–100 meter used by the AI gauge. */
export function meterFromTechnicals(score: number, label: string): {
  kind: "technicals";
  value: number;
  label: string;
  source: string;
} {
  const n = Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
  return {
    kind: "technicals",
    value: Math.round(((n + 1) / 2) * 100),
    label,
    source: "SMA/RSI",
  };
}

export function tapeSummary(base: string, changePct: number | null, price: number | null): string {
  if (changePct == null || !price) {
    return `${base} desk is reading the live USDT perp tape. Ask a follow-up for levels, funding, or session risk.`;
  }
  const dir = changePct >= 0 ? "up" : "down";
  return `${base} is ${dir} ${Math.abs(changePct).toFixed(2)}% on the 24h tape at ${fmt(price)}. This is a desk read, not a trade signal.`;
}

export function fearClass(value: number): FearClass {
  if (value < 25) return "Extreme Fear";
  if (value < 45) return "Fear";
  if (value < 55) return "Neutral";
  if (value < 75) return "Greed";
  return "Extreme Greed";
}

/** Map a 24h percent move onto a 0–100 greed score when we have no FNG feed. */
export function greedFromChange(changePct: number): number {
  const n = Number.isFinite(changePct) ? changePct : 0;
  return Math.max(0, Math.min(100, Math.round(50 + n * 8)));
}

const UP = /\b(up|surge|rally|beat|record|buy|bull|gain|soar|breakout|inflow)\b/i;
const DOWN = /\b(down|fall|drop|miss|cut|lawsuit|bear|sell|crash|outflow|liquidat)\b/i;

export function classifyHeadline(title: string): "bull" | "bear" | "skip" {
  if (UP.test(title) && !DOWN.test(title)) return "bull";
  if (DOWN.test(title) && !UP.test(title)) return "bear";
  return "skip";
}

export function localBullets(args: {
  base: string;
  price: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  fundingRate: number | null;
  volumeUsd: number | null;
  volumeShares?: number | null;
  equity?: boolean;
  news: string[];
  longPosts: string[];
  shortPosts: string[];
}): { bullish: AiBullet[]; bearish: AiBullet[] } {
  const { base, price, changePct, high, low, fundingRate, volumeUsd } = args;
  const px = price && price > 0 ? price : null;
  const chg = changePct;
  const bullish: AiBullet[] = [];
  const bearish: AiBullet[] = [];

  if (chg != null && chg >= 0 && px) {
    bullish.push({
      text: `${base} is ${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(2)}% on the 24h tape at ${fmt(px)}.`,
      posts: 0,
    });
  } else if (chg != null && px) {
    bearish.push({
      text: `${base} is down ${Math.abs(chg).toFixed(2)}% on the 24h tape at ${fmt(px)}.`,
      posts: 0,
    });
  }

  if (high && px && high > 0) {
    const off = ((high - px) / high) * 100;
    if (off > 1.5) {
      bearish.push({
        text: `Price is ${off.toFixed(1)}% below the 24h high (${fmt(high)}) — sellers still defending that level.`,
        posts: 0,
      });
    }
  }
  if (low && px && low > 0) {
    const bounce = ((px - low) / low) * 100;
    if (bounce > 0.4) {
      bullish.push({
        text: `${base} is holding ${bounce.toFixed(1)}% above the 24h low (${fmt(low)}).`,
        posts: 0,
      });
    }
  }

  if (fundingRate != null && Number.isFinite(fundingRate) && !args.equity) {
    if (fundingRate > 0.01) {
      bearish.push({
        text: `Funding is ${fundingRate.toFixed(4)}% — longs are paying, crowded upside.`,
        posts: 0,
      });
    } else if (fundingRate < -0.01) {
      bullish.push({
        text: `Funding is ${fundingRate.toFixed(4)}% — shorts are paying, squeeze risk if it holds.`,
        posts: 0,
      });
    }
  }

  if (args.equity && args.volumeShares && args.volumeShares > 0) {
    const shares =
      args.volumeShares >= 1e6
        ? `${(args.volumeShares / 1e6).toFixed(2)}M`
        : args.volumeShares >= 1e3
          ? `${(args.volumeShares / 1e3).toFixed(1)}K`
          : args.volumeShares.toFixed(0);
    const notional =
      volumeUsd && volumeUsd >= 1e9
        ? `$${(volumeUsd / 1e9).toFixed(2)}B notional`
        : volumeUsd && volumeUsd > 0
          ? `$${(volumeUsd / 1e6).toFixed(1)}M notional`
          : null;
    const side = chg != null && chg < 0 ? bearish : bullish;
    side.push({
      text: `24h volume is ${shares} shares${notional ? ` (${notional})` : ""}.`,
      posts: 0,
    });
  } else if (volumeUsd && volumeUsd > 0) {
    const vol =
      volumeUsd >= 1e9 ? `$${(volumeUsd / 1e9).toFixed(2)}B` : `$${(volumeUsd / 1e6).toFixed(1)}M`;
    const side = chg != null && chg < 0 ? bearish : bullish;
    side.push({
      text: `24h venue volume prints ${vol} around the ${base} USDT perp.`,
      posts: 0,
    });
  }

  for (const title of args.news.slice(0, 8)) {
    const tone = classifyHeadline(title);
    if (tone === "bull") bullish.push({ text: stripDeskEmoji(title), posts: 0 });
    if (tone === "bear") bearish.push({ text: stripDeskEmoji(title), posts: 0 });
  }

  for (const t of args.longPosts.slice(0, 2)) {
    bullish.push({ text: stripDeskEmoji(t), posts: args.longPosts.length });
  }
  for (const t of args.shortPosts.slice(0, 2)) {
    bearish.push({ text: stripDeskEmoji(t), posts: args.shortPosts.length });
  }

  return {
    bullish: bullish.slice(0, 4),
    bearish: bearish.slice(0, 4),
  };
}

function fmt(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (n >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}
