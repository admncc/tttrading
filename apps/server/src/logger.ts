import { nanoid } from "nanoid";
import type { LogEntry, LogLevel } from "@tttrading/shared";

type Sink = (entry: LogEntry) => void;

const sinks: Sink[] = [];

// In-memory ring buffer of the most recent log entries WITH their full metadata,
// for the diagnostic API. Larger and richer than what the desk paginates from the
// DB — this keeps `meta` objects intact so remote diagnosis has full context.
const RING_MAX = 2000;
const ring: LogEntry[] = [];
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/** Recent in-memory logs (newest last), optionally filtered by category/min-level. */
export function recentLogs(opts?: {
  limit?: number;
  category?: string;
  minLevel?: LogLevel;
  since?: string;
}): LogEntry[] {
  let out = ring;
  if (opts?.category) out = out.filter((e) => e.category === opts.category);
  if (opts?.minLevel) out = out.filter((e) => LEVEL_RANK[e.level] >= LEVEL_RANK[opts.minLevel!]);
  if (opts?.since) out = out.filter((e) => e.ts > opts.since!);
  const n = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, RING_MAX) : 300;
  return out.slice(-n);
}

/** Distinct categories currently present in the ring buffer (for diagnostics). */
export function logCategories(): string[] {
  return [...new Set(ring.map((e) => e.category))].sort();
}

/** Register an extra sink (WebSocket broadcast, DB persistence, …). */
export function addLogSink(sink: Sink): void {
  sinks.push(sink);
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(" ");
}

function emit(
  level: LogLevel,
  category: string,
  message: string,
  meta?: Record<string, unknown>,
  ids?: { groupId?: string; signalId?: string },
): void {
  const entry: LogEntry = {
    id: nanoid(),
    ts: new Date().toISOString(),
    level,
    category,
    message,
    meta,
    groupId: ids?.groupId,
    signalId: ids?.signalId,
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  const line = `[${entry.ts}] ${level.toUpperCase()} ${category}: ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // never let a sink break logging
    }
  }
}

/** Generic system logging (console-style). Category = "system". */
export const log = {
  info: (...args: unknown[]) => emit("info", "system", stringify(args)),
  warn: (...args: unknown[]) => emit("warn", "system", stringify(args)),
  error: (...args: unknown[]) => emit("error", "system", stringify(args)),
};

/**
 * Structured event logging with a category + optional metadata/ids — used to
 * trace exactly what happens as a message flows through the pipeline.
 */
export function event(
  category: string,
  message: string,
  meta?: Record<string, unknown>,
  opts?: { level?: LogLevel; groupId?: string; signalId?: string },
): void {
  emit(opts?.level ?? "info", category, message, meta, opts);
}
