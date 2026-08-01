import type { RiskRating } from "@tttrading/shared";

const COLORS: Record<string, string> = {
  green: "#22c55e",
  yellow: "#f59e0b",
  red: "#ef4444",
};

/** Small traffic-light dot with the score + reasons in the tooltip. */
export function RiskDot({ risk }: { risk?: RiskRating }) {
  if (!risk) return <span className="muted">—</span>;
  const title = `${risk.level.toUpperCase()} · ${risk.score}/100\n${risk.reasons.join("\n")}`;
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: COLORS[risk.level],
          display: "inline-block",
        }}
      />
      <span className="muted" style={{ fontSize: 12 }}>
        {risk.score}
      </span>
    </span>
  );
}
