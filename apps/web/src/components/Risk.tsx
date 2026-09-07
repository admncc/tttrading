import type { RiskRating } from "@tttrading/shared";

/** v2 risk badge: color + letter + score in the tooltip (never color alone). */
export function RiskDot({ risk }: { risk?: RiskRating }) {
  if (!risk) return <span className="muted">—</span>;
  const letter = risk.level.charAt(0).toUpperCase();
  const title = `${risk.level.toUpperCase()} · ${risk.score}/100\n${risk.reasons.join("\n")}`;
  return (
    <span className={`risk ${risk.level}`} title={title}>
      <i>{letter}</i>
      {risk.score}
    </span>
  );
}
