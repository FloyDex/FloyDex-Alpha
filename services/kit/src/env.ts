/**
 * Boot-time environment validation (`11` L16: "a hand-rolled rate limiter
 * failed closed in production without Upstash, rejecting every order — every
 * env var must be checked at boot with a clear error").
 *
 * Every service calls `loadEnv(spec)` as its first line. It checks every
 * declared variable in one pass and throws a single error listing every
 * problem, rather than the process getting halfway up and failing confusingly
 * later on the first variable nobody happened to test.
 *
 * Ported from `reference/stellar/offchain/lib/secrets-check.ts`, generalized
 * from "secrets only" to every required var, and made a pure function (throws
 * instead of `process.exit`) so it's testable; `bootEnv` below is the thin
 * process-exiting wrapper actual entrypoints use.
 */

const PLACEHOLDER_PREFIXES = ["change_me", "replace_me", "your_", "todo", "fixme", "<", "example"];

export interface EnvVarSpec {
  /** Shown in the error message so a missing var is fixable without reading source. */
  description: string;
  /** Skip the missing/placeholder checks; the value is read as-is if present. */
  optional?: boolean;
  /** Treat as a secret: also reject short values and known test-key prefixes. */
  secret?: boolean;
  /** Extra validation beyond presence/placeholder; return an error string or null. */
  validate?: (value: string) => string | null;
}

export type EnvSpec = Record<string, EnvVarSpec>;

// Well-known Stellar test-vector key prefixes leaking into a Solana deployment
// would itself be a sign something was copy-pasted wrong; kept from the
// Stellar checker as a defense against exactly that.
const KNOWN_TEST_KEY_PREFIXES = ["SCZANGBA", "SBGJMPZ"];

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p));
}

function looksLikeTestKey(value: string): boolean {
  return KNOWN_TEST_KEY_PREFIXES.some((p) => value.startsWith(p));
}

export class EnvValidationError extends Error {
  readonly problems: string[];
  readonly warnings: string[];

  constructor(problems: string[], warnings: string[]) {
    super(`env validation failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.problems = problems;
    this.warnings = warnings;
  }
}

/**
 * Validates `process.env` (or `source`, for tests) against `spec`. Returns
 * the resolved values (missing optionals are simply absent from the result)
 * plus any non-fatal warnings. Throws `EnvValidationError` listing every
 * problem found, not just the first.
 */
export function loadEnv<S extends EnvSpec>(
  spec: S,
  source: NodeJS.ProcessEnv = process.env,
): { values: { [K in keyof S]: string }; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const values = {} as { [K in keyof S]: string };

  for (const [name, rules] of Object.entries(spec)) {
    const value = source[name];
    if (!value) {
      if (!rules.optional) problems.push(`${name} is not set — ${rules.description}`);
      continue;
    }
    if (!rules.optional && looksLikePlaceholder(value)) {
      problems.push(`${name} looks like a placeholder value ("${value.slice(0, 12)}…") — ${rules.description}`);
      continue;
    }
    if (rules.secret) {
      if (value.length < 8) {
        problems.push(`${name} is too short to be a real secret — ${rules.description}`);
        continue;
      }
      if (looksLikeTestKey(value)) {
        warnings.push(`${name} matches a known test-key prefix — rotate before mainnet`);
      }
    }
    if (rules.validate) {
      const err = rules.validate(value);
      if (err) {
        problems.push(`${name} is invalid: ${err}`);
        continue;
      }
    }
    (values as Record<string, string>)[name] = value;
  }

  if (problems.length > 0) throw new EnvValidationError(problems, warnings);
  return { values, warnings };
}

/**
 * Process-exiting wrapper for service entrypoints: prints every problem to
 * stderr and exits 1, rather than letting a stack trace stand in for "which
 * env vars are missing". Call this as the first line of `main()`.
 */
export function bootEnv<S extends EnvSpec>(spec: S, source: NodeJS.ProcessEnv = process.env): { [K in keyof S]: string } {
  try {
    const { values, warnings } = loadEnv(spec, source);
    for (const w of warnings) process.stderr.write(`WARNING: ${w}\n`);
    return values;
  } catch (e) {
    if (e instanceof EnvValidationError) {
      process.stderr.write(`FATAL: missing or invalid environment variables:\n`);
      for (const p of e.problems) process.stderr.write(`  - ${p}\n`);
      process.stderr.write(`\nSet these in a gitignored .env, not in the shell history.\n`);
      process.exit(1);
    }
    throw e;
  }
}
