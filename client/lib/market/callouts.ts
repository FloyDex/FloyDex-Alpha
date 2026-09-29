export type CalloutSide = "long" | "short" | "neutral";

export type Callout = {
  id: string;
  marketId: number;
  owner: string;
  side: CalloutSide;
  text: string;
  likes: string[];
  createdAt: number;
};

export const CALLOUT_MAX_CHARS = 280;

export function normalizeCalloutText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function parseCalloutSide(raw: unknown): CalloutSide | null {
  if (raw === "long" || raw === "short" || raw === "neutral") return raw;
  return null;
}

export function validateCallout(text: string, side: unknown): { ok: true; text: string; side: CalloutSide } | { ok: false; error: string } {
  const parsed = parseCalloutSide(side);
  if (!parsed) return { ok: false, error: "Pick long, short, or a neutral thesis" };
  const clean = normalizeCalloutText(text);
  if (clean.length < 8) return { ok: false, error: "Thesis is too short" };
  if (clean.length > CALLOUT_MAX_CHARS) return { ok: false, error: `Keep it under ${CALLOUT_MAX_CHARS} characters` };
  return { ok: true, text: clean, side: parsed };
}
