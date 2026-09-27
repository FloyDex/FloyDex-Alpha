/**
 * Postgres client. Self-hosted Postgres (docker compose locally, a real box
 * in production; see `[[postgres-migration-2026-08-22]]` on the Stellar side
 * for why we don't default to a serverless provider with its own quota
 * surprises). Thin wrapper over `pg` so every service retries the same
 * transient errors instead of each one reinventing it.
 */
import pg from "pg";

export type SqlClient = pg.Pool;

export function createDb(databaseUrl: string): SqlClient {
  return new pg.Pool({ connectionString: databaseUrl });
}

const TRANSIENT = /ECONNRESET|ETIMEDOUT|econnrefused|connection terminated|timeout|Connection terminated/i;

/**
 * Retries a DB operation on transient connection errors (reset, refused,
 * timeout). Constraint violations and bad SQL are never retried — they
 * surface immediately, same rule as the Stellar `withRetry` this is ported
 * from (`reference/stellar/offchain/lib/db.ts`).
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!TRANSIENT.test(msg) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastErr;
}
