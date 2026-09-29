import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isOpenStake,
  quoteStake,
  termByDays,
  type StakePosition,
} from "./stake";

interface StakeState {
  rows: StakePosition[];
}

const FILE = join(process.cwd(), ".data", "stakes.json");

function load(): StakeState {
  const g = globalThis as typeof globalThis & { __floydexStakes?: StakeState };
  if (g.__floydexStakes) return g.__floydexStakes;
  try {
    g.__floydexStakes = JSON.parse(readFileSync(FILE, "utf8")) as StakeState;
  } catch {
    g.__floydexStakes = { rows: [] };
  }
  return g.__floydexStakes;
}

function persist(state: StakeState) {
  try {
    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

export function listStakes(owner?: string): StakePosition[] {
  const rows = load().rows;
  if (!owner) return rows;
  return rows.filter((r) => r.owner === owner);
}

export function totalStaked(now = Date.now()): number {
  return load().rows.reduce((sum, r) => (isOpenStake(r, now) ? sum + r.principal : sum), 0);
}

export function lastStaker(): string | null {
  const rows = load().rows;
  return rows.at(-1)?.owner ?? null;
}

export function lockStake(
  owner: string,
  days: number,
  amount: number,
  now = Date.now(),
): { ok: true; position: StakePosition } | { ok: false; error: string } {
  const term = termByDays(days);
  if (!term) return { ok: false, error: "Pick a listed term" };
  if (!(amount >= 1) || amount > 1_000_000_000) return { ok: false, error: "Enter an amount of at least 1" };
  const quote = quoteStake(amount, term, now);
  if (!quote) return { ok: false, error: "Enter an amount of at least 1" };
  const position: StakePosition = {
    id: randomUUID(),
    owner,
    days: quote.days,
    apy: quote.apy,
    principal: quote.principal,
    reward: quote.reward,
    receive: quote.receive,
    lockedAt: now,
    unlockAt: quote.unlockAt,
  };
  const state = load();
  state.rows.push(position);
  persist(state);
  return { ok: true, position };
}
