type Level = "info" | "warn" | "error";

type Sink = (level: Level, message: string) => void;

const sinks: Sink[] = [];

/** Register an extra sink (e.g. WebSocket broadcast) for log lines. */
export function addLogSink(sink: Sink): void {
  sinks.push(sink);
}

function emit(level: Level, args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()} ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  for (const sink of sinks) {
    try {
      sink(level, message);
    } catch {
      // never let a sink break logging
    }
  }
}

export const log = {
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
