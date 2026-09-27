/**
 * Structured logging: one JSON object per line on stdout, so every service's
 * output is greppable/parseable the same way regardless of host. No external
 * dependency — this is deliberately small; reach for something heavier only
 * if we outgrow it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A logger that merges `fields` into every line it writes, for a request/job id and so on. */
  child(fields: Record<string, unknown>): Logger;
}

interface WriteTarget {
  write(line: string): void;
}

function makeLogger(service: string, baseFields: Record<string, unknown>, minLevel: LogLevel, out: WriteTarget): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...baseFields,
      ...fields,
    };
    out.write(JSON.stringify(line) + "\n");
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => makeLogger(service, { ...baseFields, ...fields }, minLevel, out),
  };
}

/**
 * Creates the root logger for a service. `LOG_LEVEL` (debug|info|warn|error,
 * default info) controls verbosity via env so it can be raised in production
 * without a redeploy.
 */
export function createLogger(
  service: string,
  opts: { level?: LogLevel; out?: WriteTarget; env?: NodeJS.ProcessEnv } = {},
): Logger {
  const env = opts.env ?? process.env;
  const level = opts.level ?? (env.LOG_LEVEL as LogLevel | undefined) ?? "info";
  const out = opts.out ?? { write: (line: string) => process.stdout.write(line) };
  return makeLogger(service, {}, level, out);
}
