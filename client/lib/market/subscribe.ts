import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), ".data", "subscribers.json");
const MAX_SUBSCRIBERS = 50_000;
const MAX_EMAIL_LEN = 254;

export type Subscriber = { email: string; at: number };
export type SubscriberState = { emails: Subscriber[] };

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (!email || email.length > MAX_EMAIL_LEN) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
}

export function addSubscriber(
  state: SubscriberState,
  raw: string,
  at = Date.now(),
): { ok: true; created: boolean; email: string } | { ok: false; error: string } {
  const email = normalizeEmail(raw);
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email" };
  if (state.emails.some((r) => r.email === email)) {
    return { ok: true, created: false, email };
  }
  if (state.emails.length >= MAX_SUBSCRIBERS) {
    return { ok: false, error: "List is full" };
  }
  state.emails.push({ email, at });
  return { ok: true, created: true, email };
}

function load(): SubscriberState {
  const g = globalThis as typeof globalThis & { __floydexSubscribers?: SubscriberState };
  if (g.__floydexSubscribers) return g.__floydexSubscribers;
  try {
    g.__floydexSubscribers = JSON.parse(readFileSync(FILE, "utf8")) as SubscriberState;
    if (!Array.isArray(g.__floydexSubscribers.emails)) g.__floydexSubscribers = { emails: [] };
  } catch {
    g.__floydexSubscribers = { emails: [] };
  }
  return g.__floydexSubscribers;
}

function persist(state: SubscriberState) {
  try {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/** Append a landing-page signup. Idempotent on the same address. */
export function recordSubscriber(raw: string, at = Date.now()) {
  const state = load();
  const result = addSubscriber(state, raw, at);
  if (result.ok) persist(state);
  return result;
}
