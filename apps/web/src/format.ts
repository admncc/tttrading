export function usd(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pct(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * Number formatter for prices/sizes. For values ≥ 1 it shows up to `digits`
 * fraction digits (default 4). For sub-1 prices it EXTENDS precision so ~5
 * significant figures survive — a $0.004332 coin renders "0.004332", not the
 * misleading "0.0043" a fixed 4-digit cap would give. Display only; the stored
 * value is always full precision.
 */
export function num(n: number | undefined, digits = 4): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let maxFrac = digits;
  if (abs > 0 && abs < 1) {
    const leadingZeros = Math.floor(-Math.log10(abs)); // 0.0043 → 2
    maxFrac = Math.min(Math.max(digits, leadingZeros + 5), 12); // ~5 sig figs, capped
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Full local date + time to the second, e.g. "Aug 2, 14:03:07". */
export function dateTimeSec(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function pnlClass(n: number | undefined): string {
  if (n === undefined || n === 0) return "";
  return n > 0 ? "pos" : "neg";
}
