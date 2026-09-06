/**
 * Shared time-range control for Analytics + Risk Insights. Presets (today,
 * yesterday, rolling 7/30/90d, this month, last month, all) plus a custom
 * date range. Resolves to ISO [from, to) bounds in the viewer's LOCAL time —
 * "today"/"this month" mean the local calendar day/month, which is what a user
 * expects — while trade timestamps stay UTC ISO (string comparison is correct
 * once the local boundaries are converted to ISO).
 */
export type RangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "month"
  | "lastmonth"
  | "all"
  | "custom";

export interface RangeState {
  preset: RangePreset;
  /** Custom "YYYY-MM-DD" (local). Used only when preset === "custom". */
  from: string;
  to: string;
}

export const DEFAULT_RANGE: RangeState = { preset: "all", from: "", to: "" };

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  month: "This month",
  lastmonth: "Last month",
  all: "All time",
  custom: "Custom range…",
};

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/** Resolve a range to ISO [from, to) bounds. Missing bound = open on that side. */
export function rangeWindow(s: RangeState): { from?: string; to?: string } {
  const now = new Date();
  const sod = startOfDay(now);
  switch (s.preset) {
    case "all":
      return {};
    case "today":
      return { from: sod.toISOString() };
    case "yesterday":
      return { from: addDays(sod, -1).toISOString(), to: sod.toISOString() };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString() };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString() };
    case "90d":
      return { from: new Date(now.getTime() - 90 * 86_400_000).toISOString() };
    case "month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    case "lastmonth":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
        to: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      };
    case "custom": {
      const from = s.from ? startOfDay(new Date(`${s.from}T00:00`)).toISOString() : undefined;
      // The custom end date is INCLUSIVE — cover through the end of that day.
      const to = s.to ? addDays(startOfDay(new Date(`${s.to}T00:00`)), 1).toISOString() : undefined;
      return { from, to };
    }
  }
}

/** Short human label for the active range (for the summary line). */
export function rangeLabel(s: RangeState): string {
  if (s.preset === "custom") {
    if (s.from && s.to) return `${s.from} → ${s.to}`;
    if (s.from) return `from ${s.from}`;
    if (s.to) return `until ${s.to}`;
    return "custom";
  }
  return RANGE_LABELS[s.preset];
}

/** A preset dropdown plus, when "Custom" is chosen, two date inputs. Controlled. */
export function RangePicker({ value, onChange }: { value: RangeState; onChange: (s: RangeState) => void }) {
  const set = (patch: Partial<RangeState>) => onChange({ ...value, ...patch });
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select
        value={value.preset}
        onChange={(e) => set({ preset: e.target.value as RangePreset })}
        style={{ width: "auto", minWidth: 130 }}
        aria-label="Time range"
      >
        {(Object.keys(RANGE_LABELS) as RangePreset[]).map((k) => (
          <option key={k} value={k}>
            {RANGE_LABELS[k]}
          </option>
        ))}
      </select>
      {value.preset === "custom" && (
        <>
          <input
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
            aria-label="From date"
            style={{ width: "auto" }}
          />
          <span className="muted">→</span>
          <input
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
            aria-label="To date"
            style={{ width: "auto" }}
          />
        </>
      )}
    </span>
  );
}
