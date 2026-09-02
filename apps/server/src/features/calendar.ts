/**
 * Phase 2.4 — event calendar (pure, no external feed). Computes the events whose
 * timing is RULE-BASED and therefore derivable exactly:
 *   - NFP (US non-farm payrolls): first Friday of the month, 08:30 America/New_York.
 *   - Crypto options expiry (Deribit): last Friday of the month, 08:00 UTC;
 *     quarterly on Mar/Jun/Sep/Dec.
 * Dates whose timing is NOT rule-based (FOMC, CPI, PCE, token unlocks) are NOT
 * invented here — they come from an operator-maintained JSON file (loadMacroFile)
 * so the schedule is data, never guessed code.
 *
 * Everything is observe-only feature context; nothing here trades.
 */

export type EventKind = "nfp" | "optionsExpiry" | "optionsExpiryQuarterly" | "fomc" | "cpi" | "pce" | "unlock" | string;
export interface CalEvent { kind: EventKind; timeMs: number; source: string }

const DAY = 86_400_000;

/** True if `date` falls in US Eastern DST (2nd Sun Mar → 1st Sun Nov). */
export function isUsEasternDst(d: Date): boolean {
  const y = d.getUTCFullYear();
  const secondSunMar = nthWeekdayUtc(y, 2, 0, 2); // March, 3rd month idx 2, Sunday=0, 2nd
  const firstSunNov = nthWeekdayUtc(y, 10, 0, 1); // November idx 10, Sunday, 1st
  const t = d.getTime();
  return t >= secondSunMar && t < firstSunNov;
}

/** UTC ms of the n-th `weekday` (0=Sun..6=Sat) of a given month (monthIdx 0-11). */
function nthWeekdayUtc(year: number, monthIdx: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIdx, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return Date.UTC(year, monthIdx, 1 + shift + (n - 1) * 7);
}

/** UTC ms of the LAST `weekday` of a month. */
function lastWeekdayUtc(year: number, monthIdx: number, weekday: number): number {
  const last = new Date(Date.UTC(year, monthIdx + 1, 0)); // last day of month
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return Date.UTC(year, monthIdx, last.getUTCDate() - shift);
}

/** NFP for a month: first Friday, 08:30 ET → UTC (DST-aware). */
export function nfpUtc(year: number, monthIdx: number): number {
  const firstFri = nthWeekdayUtc(year, monthIdx, 5, 1);
  const etOffset = isUsEasternDst(new Date(firstFri)) ? 4 : 5; // EDT=UTC-4, EST=UTC-5
  return firstFri + (8 + etOffset) * 3_600_000 + 30 * 60_000; // 08:30 ET
}

/** Monthly crypto options expiry: last Friday, 08:00 UTC. */
export function optionsExpiryUtc(year: number, monthIdx: number): number {
  return lastWeekdayUtc(year, monthIdx, 5) + 8 * 3_600_000;
}

/** Operator-maintained macro/unlock events (FOMC/CPI/PCE/unlocks), loaded from a
 *  JSON file of `{kind, iso}` — empty by default so nothing is invented. */
let MACRO: CalEvent[] = [];
export function setMacroEvents(events: { kind: EventKind; iso: string }[]): void {
  MACRO = events
    .map((e) => ({ kind: e.kind, timeMs: Date.parse(e.iso), source: "macro-file" }))
    .filter((e) => Number.isFinite(e.timeMs));
}

/** Load operator-maintained macro/unlock events from MACRO_CALENDAR_FILE (a JSON
 *  array of {kind, iso}). Best-effort; logs a count. Call once at startup. */
export async function loadMacroCalendarFromEnv(): Promise<number> {
  const file = process.env.MACRO_CALENDAR_FILE;
  if (!file) return 0;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(file, "utf8")) as { kind: EventKind; iso: string }[];
    setMacroEvents(raw);
    return MACRO.length;
  } catch {
    return 0;
  }
}

/** Build the full event list spanning [nowMs − 40d, nowMs + 40d]. */
export function eventsAround(nowMs: number): CalEvent[] {
  const out: CalEvent[] = [];
  const start = new Date(nowMs - 40 * DAY), end = new Date(nowMs + 40 * DAY);
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
    for (let m = 0; m < 12; m++) {
      out.push({ kind: "nfp", timeMs: nfpUtc(y, m), source: "rule:first-friday-0830ET" });
      const oe = optionsExpiryUtc(y, m);
      const quarterly = m === 2 || m === 5 || m === 8 || m === 11;
      out.push({ kind: quarterly ? "optionsExpiryQuarterly" : "optionsExpiry", timeMs: oe, source: "rule:last-friday-0800UTC" });
    }
  }
  out.push(...MACRO);
  return out
    .filter((e) => e.timeMs >= nowMs - 40 * DAY && e.timeMs <= nowMs + 40 * DAY)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export interface EventContext {
  hoursToNext?: number;   // hours until the next event (>= now)
  nextKind?: EventKind;
  inWindow: boolean;      // is an event scheduled within `windowMs` from now
  hoursSincePrev?: number;
}

/** Event context for a signal: nearest upcoming event + whether one falls inside
 *  the trade's expected horizon (windowMs). */
export function eventContext(nowMs: number, windowMs: number): EventContext {
  const all = eventsAround(nowMs);
  const upcoming = all.filter((e) => e.timeMs >= nowMs);
  const prev = all.filter((e) => e.timeMs < nowMs).pop();
  const next = upcoming[0];
  return {
    hoursToNext: next ? Number(((next.timeMs - nowMs) / 3_600_000).toFixed(1)) : undefined,
    nextKind: next?.kind,
    inWindow: upcoming.some((e) => e.timeMs <= nowMs + windowMs),
    hoursSincePrev: prev ? Number(((nowMs - prev.timeMs) / 3_600_000).toFixed(1)) : undefined,
  };
}
