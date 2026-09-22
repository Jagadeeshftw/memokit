/**
 * Structured logs: one JSON object per line, on stdout.
 *
 * A service that races other services is debugged by correlating its timeline against theirs,
 * and that only works if every line is machine-readable and carries the same key for the same
 * thing. `txid` is the XRPL transaction id in every line that has one, so a single grep
 * reconstructs the whole life of an instruction.
 *
 * Set `LOG_PRETTY=1` for human-readable output while developing.
 */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A logger that stamps every line with these fields. */
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(options: {
  level?: Level;
  pretty?: boolean;
  base?: Record<string, unknown>;
  sink?: (line: string) => void;
} = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const pretty = options.pretty ?? process.env.LOG_PRETTY === "1";
  const sink = options.sink ?? ((l: string) => process.stdout.write(l + "\n"));
  const base = options.base ?? {};

  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const record = { ts: new Date().toISOString(), level, msg, ...base, ...fields };
    if (!pretty) {
      sink(JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      return;
    }
    const extra = { ...base, ...fields };
    const tail = Object.entries(extra)
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
      .join(" ");
    sink(`${record.ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail ? "  " + tail : ""}`);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
