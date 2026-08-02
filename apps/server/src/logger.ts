import { nanoid } from "nanoid";
import type { LogEntry, LogLevel } from "@tttrading/shared";

type Sink = (entry: LogEntry) => void;

const sinks: Sink[] = [];

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
