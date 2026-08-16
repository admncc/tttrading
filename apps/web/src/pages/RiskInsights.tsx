import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type CapTier, type InsightTrade, type OpenRisk } from "../api.js";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}`;
const netColor = (n: number) => (n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "var(--muted)");
const wrColor = (w: number) => (w >= 0.55 ? "#22c55e" : w >= 0.45 ? "#f59e0b" : "#ef4444");

interface Bucket { key: string; tier?: CapTier; n: number; winRate: number; net: number; avg: number }

function weekLabel(at: string): string {
  if (!at) return "";
  const d = new Date(at).getUTCDate();
  const w = Math.min(4, Math.ceil(d / 7));
  return `Week ${w} (${{ 1: "1–7", 2: "8–14", 3: "15–21", 4: "22–31" }[w]})`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function weekdayName(iso: string): string {
  if (!iso) return "";
  return DOW[new Date(iso).getUTCDay()] ?? "";
}
function weekShort(iso: string): string {
  if (!iso) return "";
  return `W${Math.min(4, Math.ceil(new Date(iso).getUTCDate() / 7))}`;
}

/* ---- trading session from an entry time (UTC) ----------------------------- */
// Crypto is 24/7 but liquidity still tracks the legacy sessions. Coarse buckets.
const SESSION_ORDER = ["Asia", "EU", "US", "Late"];
function sessionOf(iso: string): string {
  if (!iso) return "";
  const h = new Date(iso).getUTCHours();
  if (h < 7) return "Asia"; // ~00–07 UTC (Tokyo/Singapore)
  if (h < 12) return "EU"; // ~07–12 UTC (London)
  if (h < 21) return "US"; // ~12–21 UTC (New York)
  return "Late"; // ~21–24 UTC (thin)
}

/* ---- hold-time bucket ----------------------------------------------------- */
const HOLD_ORDER = ["Scalp <4h", "Intraday 4–24h", "Swing 1–3d", "Position >3d", "Unknown"];
function holdBucket(h?: number): string {
  if (h === undefined) return "Unknown";
  if (h < 4) return "Scalp <4h";
  if (h < 24) return "Intraday 4–24h";
  if (h < 72) return "Swing 1–3d";
  return "Position >3d";
}

/* ================= professional edge statistics ============================ */
interface Edge {
  n: number;
  winRate: number;
  net: number;
  avg: number;
  profitFactor: number; // gross profit / gross loss
  payoff: number; // avg win / avg loss
  breakEvenWr: number; // win rate needed to break even at this payoff
  nR: number; // trades with a known R (stop known)
  expectancyR?: number; // mean R — the average $ won per $ risked
  stdR?: number;
  sqn?: number; // Van Tharp System Quality Number = mean(R)/std(R) × √n
  maxDD: number; // max peak-to-trough drop on the cumulative-net curve ($)
  maxDDpct?: number; // as % of the peak reached
  maxLossStreak: number;
  maxWinStreak: number;
  avgHold?: number; // hours
  avgSlip?: number; // % (entry slippage)
  top3Share?: number; // share of gross profit from the 3 biggest winners (outlier dependence)
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function edgeOf(trades: InsightTrade[]): Edge {
  const n = trades.length;
  const wins = trades.filter((t) => t.net >= 0);
  const losses = trades.filter((t) => t.net < 0);
  const net = trades.reduce((s, t) => s + t.net, 0);
  const grossProfit = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const breakEvenWr = Number.isFinite(payoff) && payoff > 0 ? 1 / (1 + payoff) : 0;

  const rs = trades.map((t) => t.r).filter((r): r is number => r !== undefined && Number.isFinite(r));
  const nR = rs.length;
  const expectancyR = nR ? rs.reduce((s, r) => s + r, 0) / nR : undefined;
  const stdR = nR >= 2 ? std(rs) : undefined;
  // Van Tharp SQN: caps the sample at 100 so a large n can't inflate the score.
  const sqn = expectancyR !== undefined && stdR && stdR > 0 ? (expectancyR / stdR) * Math.sqrt(Math.min(nR, 100)) : undefined;

  // Drawdown + streaks on the settle-ordered cumulative-net curve.
  const asc = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let cum = 0, peak = 0, maxDD = 0, ddPeakAt = 0;
  let winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0;
  for (const t of asc) {
    cum += t.net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) { maxDD = dd; ddPeakAt = peak; }
    if (t.net >= 0) { winStreak++; lossStreak = 0; } else { lossStreak++; winStreak = 0; }
    if (winStreak > maxWin) maxWin = winStreak;
    if (lossStreak > maxLoss) maxLoss = lossStreak;
  }
  const maxDDpct = ddPeakAt > 0 ? maxDD / ddPeakAt : undefined;

  const holds = trades.map((t) => t.holdHours).filter((h): h is number => h !== undefined);
  const avgHold = holds.length ? holds.reduce((s, h) => s + h, 0) / holds.length : undefined;
  const slips = trades.map((t) => t.slipPct).filter((s): s is number => s !== undefined);
  const avgSlip = slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : undefined;

  // Outlier dependence: how much of gross profit comes from the 3 biggest wins.
  // High (>~50%) means the "edge" is a few lottery trades, not a repeatable process.
  const top3 = wins.map((t) => t.net).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
  const top3Share = grossProfit > 0 ? top3 / grossProfit : undefined;

  return {
    n, winRate: n ? wins.length / n : 0, net, avg: n ? net / n : 0,
    profitFactor, payoff, breakEvenWr, nR, expectancyR, stdR, sqn,
    maxDD, maxDDpct, maxLossStreak: maxLoss, maxWinStreak: maxWin, avgHold, avgSlip, top3Share,
  };
}

// Van Tharp SQN bands (100-trade scale).
function sqnColor(s?: number): string {
  if (s === undefined) return "var(--muted)";
  if (s >= 2.5) return "#22c55e";
  if (s >= 1.6) return "#f59e0b";
  return "#ef4444";
}
function sqnLabel(s?: number): string {
  if (s === undefined) return "—";
  if (s >= 5) return "superb";
  if (s >= 3) return "excellent";
  if (s >= 2.5) return "good";
  if (s >= 2) return "average";
  if (s >= 1.6) return "below avg";
  return "poor";
}
const pfColor = (p: number) => (p >= 2 ? "#22c55e" : p >= 1.3 ? "#f59e0b" : "#ef4444");
const expColor = (e?: number) => (e === undefined ? "var(--muted)" : e >= 0.3 ? "#22c55e" : e >= 0 ? "#f59e0b" : "#ef4444");
const fmt = (n?: number, d = 2) => (n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d));
const inf = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "∞");

/* ---- best factor combination per trader (Spotlight) ----------------------- */
interface Combo { label: string; n: number; winRate: number; net: number }
const SPOT_DIMS: ((t: InsightTrade) => string)[] = [
  (t) => t.side,
  (t) => `${t.tier}-cap`,
  (t) => t.symbol,
  (t) => weekdayName(t.openedAt),
  (t) => weekShort(t.at),
  (t) => sessionOf(t.openedAt),
];
const SPOT_SUBSETS: number[][] = (() => {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << SPOT_DIMS.length; mask++) {
    const s: number[] = [];
    for (let i = 0; i < SPOT_DIMS.length; i++) if (mask & (1 << i)) s.push(i);
    if (s.length > 3) continue;
    if (s.includes(1) && s.includes(2)) continue; // tier+coin redundant
    out.push(s);
  }
  return out;
})();
function bestCombos(trades: InsightTrade[], topN = 3, minN = 3): Combo[] {
  const m = new Map<string, { n: number; wins: number; net: number; label: string }>();
  for (const t of trades) {
    for (const sub of SPOT_SUBSETS) {
      const toks = sub.map((i) => SPOT_DIMS[i]!(t));
      if (toks.some((x) => !x)) continue;
      const key = sub.join(",") + "::" + toks.join("|");
      const e = m.get(key) ?? { n: 0, wins: 0, net: 0, label: toks.join(" · ") };
      e.n += 1;
      if (t.net >= 0) e.wins += 1;
      e.net += t.net;
      m.set(key, e);
    }
  }
  return [...m.values()]
    .filter((e) => e.n >= minN && e.wins / e.n >= 0.5)
    .map((e) => ({ label: e.label, n: e.n, winRate: e.wins / e.n, net: e.net }))
    .sort((a, b) => b.net - a.net || b.winRate - a.winRate)
    .slice(0, topN);
}

function agg(trades: InsightTrade[], keyOf: (t: InsightTrade) => string, tierOf?: (t: InsightTrade) => CapTier): Bucket[] {
  const m = new Map<string, { n: number; wins: number; net: number; tier?: CapTier }>();
  for (const t of trades) {
    const k = keyOf(t);
    if (!k) continue;
    const e = m.get(k) ?? { n: 0, wins: 0, net: 0, tier: tierOf?.(t) };
    e.n += 1;
    if (t.net >= 0) e.wins += 1;
    e.net += t.net;
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([key, e]) => ({ key, tier: e.tier, n: e.n, winRate: e.wins / e.n, net: e.net, avg: e.net / e.n }))
    .sort((a, b) => b.net - a.net);
}

function equitySeries(trades: InsightTrade[]): number[] {
  const asc = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let c = 0;
  return asc.map((t) => (c += t.net));
}

function Sparkline({ data, width = 200, height = 40, full }: { data: number[]; width?: number; height?: number; full?: boolean }) {
  if (!data.length) return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const span = max - min || 1;
  const n = data.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => height - ((v - min) / span) * height;
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = data[data.length - 1] ?? 0;
  const color = last >= 0 ? "#22c55e" : "#ef4444";
  return (
    <svg width={full ? "100%" : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <line x1={0} y1={y(0)} x2={width} y2={y(0)} stroke="var(--border)" strokeWidth={1} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TierTag({ tier }: { tier?: string }) {
  if (!tier) return null;
  const bg = tier === "large" ? "#16a34a" : tier === "small" ? "#b45309" : "#475569";
  return <span className="tag" style={{ marginLeft: 6, background: bg, color: "#fff", fontSize: 10 }}>{tier}</span>;
}

function Card({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <h3 style={{ margin: "0 0 4px" }}>{title}</h3>
      {hint && <p className="muted" style={{ margin: "0 0 8px", fontSize: 11 }}>{hint}</p>}
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

function BucketTable({ rows, label, showTier, sparks }: { rows: Bucket[]; label: string; showTier?: boolean; sparks?: Record<string, number[]> }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>No trades match.</div>;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr className="muted" style={{ textAlign: "left", fontSize: 11 }}>
          <th style={{ padding: "6px 8px" }}>{label}</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>trades</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>win rate</th>
          <th style={{ padding: "6px 8px", textAlign: "right", minWidth: 120 }}>net</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>avg</th>
          {sparks && <th style={{ padding: "6px 8px" }}>trend</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{r.key}{showTier && <TierTag tier={r.tier} />}</td>
            <td style={{ padding: "6px 8px", textAlign: "right" }} className="muted">{r.n}</td>
            <td style={{ padding: "6px 8px", textAlign: "right", color: wrColor(r.winRate), fontVariantNumeric: "tabular-nums" }}>{pct(r.winRate)}</td>
            <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              <div style={{ color: netColor(r.net) }}>{usd(r.net)}</div>
              <div style={{ height: 3, background: "var(--border)", borderRadius: 2, marginTop: 3, display: "flex", justifyContent: "flex-end" }}>
                <div style={{ height: "100%", width: `${(Math.abs(r.net) / maxAbs) * 100}%`, background: netColor(r.net), borderRadius: 2 }} />
              </div>
            </td>
            <td style={{ padding: "6px 8px", textAlign: "right", color: netColor(r.avg), fontVariantNumeric: "tabular-nums" }}>{usd(r.avg)}</td>
            {sparks && <td style={{ padding: "6px 8px", width: 130 }}><Sparkline data={sparks[r.key] ?? []} width={120} height={28} /></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---- R-multiple distribution --------------------------------------------- */
const R_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "≤ −2R", lo: -Infinity, hi: -2 },
  { label: "−2…−1R", lo: -2, hi: -1 },
  { label: "−1…0R", lo: -1, hi: 0 },
  { label: "0…1R", lo: 0, hi: 1 },
  { label: "1…2R", lo: 1, hi: 2 },
  { label: "2…3R", lo: 2, hi: 3 },
  { label: "≥ 3R", lo: 3, hi: Infinity },
];
function RHistogram({ trades }: { trades: InsightTrade[] }) {
  const rs = trades.map((t) => t.r).filter((r): r is number => r !== undefined && Number.isFinite(r));
  if (rs.length === 0) return <div className="muted" style={{ fontSize: 12 }}>No trades with a known stop yet — R-multiples need entry + stop.</div>;
  const counts = R_BUCKETS.map((b) => rs.filter((r) => r > b.lo && r <= b.hi).length);
  const max = Math.max(1, ...counts);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr 32px", gap: 4, alignItems: "center", fontSize: 12 }}>
      {R_BUCKETS.map((b, i) => (
        <div key={b.label} style={{ display: "contents" }}>
          <span className="muted" style={{ textAlign: "right", paddingRight: 6 }}>{b.label}</span>
          <div style={{ background: "var(--border)", borderRadius: 3, height: 14 }}>
            <div style={{ width: `${(counts[i]! / max) * 100}%`, height: "100%", background: b.hi <= 0 ? "#ef4444" : "#22c55e", borderRadius: 3 }} />
          </div>
          <span style={{ textAlign: "right" }}>{counts[i]}</span>
        </div>
      ))}
    </div>
  );
}

/* ---- edge scorecard table ------------------------------------------------- */
function EdgeTable({ rows }: { rows: { key: string; e: Edge }[] }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>No trades match.</div>;
  const th = (t: string, extra?: object) => <th style={{ padding: "6px 8px", textAlign: "right", ...extra }}>{t}</th>;
  const td = (v: ReactNode, color?: string) => (
    <td style={{ padding: "6px 8px", textAlign: "right", color, fontVariantNumeric: "tabular-nums" }}>{v}</td>
  );
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr className="muted" style={{ textAlign: "left", fontSize: 11 }}>
          <th style={{ padding: "6px 8px" }}>Channel</th>
          {th("trades")}{th("win")}{th("expectancy (R)")}{th("SQN")}{th("profit factor")}{th("payoff")}{th("max DD")}{th("loss streak")}{th("avg hold")}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, e }) => (
          <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={{ padding: "6px 8px", whiteSpace: "nowrap", fontWeight: 600 }}>{key}</td>
            {td(e.n, "var(--muted)")}
            {td(pct(e.winRate), wrColor(e.winRate))}
            {td(
              e.expectancyR === undefined ? "—" : `${e.expectancyR >= 0 ? "+" : ""}${fmt(e.expectancyR, 2)}R`,
              expColor(e.expectancyR),
            )}
            {td(
              <span style={{ opacity: e.nR < 30 ? 0.5 : 1 }} title={e.nR < 30 ? `only ${e.nR} trades with a stop — SQN needs ~30 to be reliable` : ""}>
                {fmt(e.sqn, 2)} <span className="muted" style={{ fontSize: 10 }}>{e.nR < 30 ? `N=${e.nR}` : sqnLabel(e.sqn)}</span>
              </span>,
              e.nR < 30 ? "var(--muted)" : sqnColor(e.sqn),
            )}
            {td(inf(e.profitFactor, 2), pfColor(e.profitFactor))}
            {td(inf(e.payoff, 2))}
            {td(<span style={{ color: "#ef4444" }}>−{e.maxDD.toFixed(0)}{e.maxDDpct !== undefined ? ` (${(e.maxDDpct * 100).toFixed(0)}%)` : ""}</span>)}
            {td(e.maxLossStreak, e.maxLossStreak >= 5 ? "#ef4444" : undefined)}
            {td(e.avgHold === undefined ? "—" : e.avgHold >= 24 ? `${(e.avgHold / 24).toFixed(1)}d` : `${e.avgHold.toFixed(1)}h`, "var(--muted)")}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatTile({ label, value, color, sub }: { label: string; value: ReactNode; color?: string; sub?: string }) {
  return (
    <div className="panel" style={{ margin: 0, padding: "10px 12px" }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

/* ================= portfolio risk (live open positions) ==================== */
function PortfolioRisk({ open, equity }: { open: OpenRisk[]; equity?: number }) {
  const real = open;
  if (real.length === 0) return <div className="muted" style={{ fontSize: 12 }}>No open positions.</div>;
  const longN = real.filter((p) => p.side === "long").reduce((s, p) => s + p.notional, 0);
  const shortN = real.filter((p) => p.side === "short").reduce((s, p) => s + p.notional, 0);
  const gross = longN + shortN;
  const netExp = longN - shortN;
  const knownRisk = real.filter((p) => p.riskUsd !== undefined).reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const naked = real.filter((p) => !p.hasStop);
  const nakedNotional = naked.reduce((s, p) => s + p.notional, 0);
  const heatPct = equity && equity > 0 ? knownRisk / equity : undefined;
  const grossPct = equity && equity > 0 ? gross / equity : undefined;
  const netPct = equity && equity > 0 ? netExp / equity : undefined;

  // Single-name + tier concentration (share of gross exposure).
  const byCoin = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const p of real) {
    byCoin.set(p.symbol, (byCoin.get(p.symbol) ?? 0) + p.notional);
    byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + p.notional);
  }
  const topCoin = [...byCoin.entries()].sort((a, b) => b[1] - a[1])[0];
  const topCoinPct = topCoin && gross > 0 ? topCoin[1] / gross : 0;

  const heatColor = heatPct === undefined ? "var(--muted)" : heatPct > 0.06 ? "#ef4444" : heatPct > 0.03 ? "#f59e0b" : "#22c55e";
  const dirColor = netPct === undefined ? undefined : Math.abs(netPct) > 1 ? "#f59e0b" : undefined;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <StatTile
          label="Portfolio heat (risk to stops)"
          value={heatPct === undefined ? `${knownRisk.toFixed(0)}` : `${(heatPct * 100).toFixed(1)}%`}
          color={heatColor}
          sub={heatPct === undefined ? "risk USDC (equity n/a)" : `${knownRisk.toFixed(0)} USDC · cap ~6%`}
        />
        <StatTile
          label="Naked positions (no stop)"
          value={naked.length}
          color={naked.length ? "#ef4444" : "#22c55e"}
          sub={naked.length ? `${nakedNotional.toFixed(0)} USDC unbounded · ${naked.map((p) => p.symbol).join(", ")}` : "all stopped"}
        />
        <StatTile
          label="Net exposure (long − short)"
          value={netPct === undefined ? usd(netExp) : `${netPct >= 0 ? "+" : ""}${(netPct * 100).toFixed(0)}%`}
          color={dirColor}
          sub={`long ${longN.toFixed(0)} / short ${shortN.toFixed(0)}`}
        />
        <StatTile
          label="Gross leverage"
          value={grossPct === undefined ? `${gross.toFixed(0)}` : `${grossPct.toFixed(1)}×`}
          sub={`gross ${gross.toFixed(0)} USDC${equity ? ` / equity ${equity.toFixed(0)}` : ""}`}
        />
        <StatTile
          label="Top-coin concentration"
          value={topCoin ? `${(topCoinPct * 100).toFixed(0)}%` : "—"}
          color={topCoinPct > 0.4 ? "#f59e0b" : undefined}
          sub={topCoin ? `${topCoin[0]} · ${topCoin[1].toFixed(0)} USDC` : ""}
        />
        <StatTile
          label="Open positions"
          value={real.length}
          sub={[...byTier.entries()].map(([t, v]) => `${t} ${((v / gross) * 100).toFixed(0)}%`).join(" · ")}
        />
      </div>
      {(naked.length > 0 || (heatPct !== undefined && heatPct > 0.06) || Math.abs(netPct ?? 0) > 1.2 || topCoinPct > 0.5) && (
        <div className="panel" style={{ marginTop: 10, borderColor: "#b45309", fontSize: 12 }}>
          <b>⚠ Risk flags:</b>{" "}
          {[
            naked.length ? `${naked.length} position(s) without a stop — unbounded downside` : "",
            heatPct !== undefined && heatPct > 0.06 ? `heat ${(heatPct * 100).toFixed(1)}% over the ~6% prudent cap` : "",
            Math.abs(netPct ?? 0) > 1.2 ? `directional: net exposure ${((netPct ?? 0) * 100).toFixed(0)}% of equity (one-way beta bet)` : "",
            topCoinPct > 0.5 ? `${topCoin?.[0]} is ${(topCoinPct * 100).toFixed(0)}% of gross — single-name concentration` : "",
          ].filter(Boolean).join(" · ")}
        </div>
      )}
    </>
  );
}

const ALL = "__all__";

export function RiskInsights() {
  const [trades, setTrades] = useState<InsightTrade[] | null>(null);
  const [open, setOpen] = useState<OpenRisk[]>([]);
  const [equity, setEquity] = useState<number | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [fChannel, setFChannel] = useState(ALL);
  const [fCoin, setFCoin] = useState(ALL);
  const [fTier, setFTier] = useState(ALL);
  const [fSide, setFSide] = useState(ALL);
  const [rangeDays, setRangeDays] = useState(0);

  const load = () => {
    api
      .riskInsights()
      .then((d) => { setTrades(d.trades); setOpen(d.open ?? []); setEquity(d.equity); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const channelOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.channel))].sort(), [trades]);
  const coinOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.symbol))].sort(), [trades]);

  const cutoff = useMemo(
    () => (rangeDays === 0 ? "" : new Date(Date.now() - rangeDays * 86_400_000).toISOString()),
    [rangeDays],
  );
  const filtered = useMemo(
    () =>
      (trades ?? []).filter(
        (t) =>
          (fChannel === ALL || t.channel === fChannel) &&
          (fCoin === ALL || t.symbol === fCoin) &&
          (fTier === ALL || t.tier === fTier) &&
          (fSide === ALL || t.side === fSide) &&
          (rangeDays === 0 || (t.at && t.at >= cutoff)),
      ),
    [trades, fChannel, fCoin, fTier, fSide, rangeDays, cutoff],
  );

  const overall = useMemo(() => edgeOf(filtered), [filtered]);
  const edgeRows = useMemo(() => {
    const byCh = new Map<string, InsightTrade[]>();
    for (const t of filtered) { const a = byCh.get(t.channel) ?? []; a.push(t); byCh.set(t.channel, a); }
    return [...byCh.entries()].map(([key, ts]) => ({ key, e: edgeOf(ts) })).sort((a, b) => (b.e.expectancyR ?? -99) - (a.e.expectancyR ?? -99));
  }, [filtered]);

  const byChannel = useMemo(() => agg(filtered, (t) => t.channel), [filtered]);
  const bySymbol = useMemo(() => agg(filtered, (t) => t.symbol, (t) => t.tier), [filtered]);
  const byTier = useMemo(() => agg(filtered, (t) => t.tier), [filtered]);
  const bySide = useMemo(() => agg(filtered, (t) => t.side), [filtered]);
  const bySession = useMemo(() => agg(filtered, (t) => sessionOf(t.openedAt)).sort((a, b) => SESSION_ORDER.indexOf(a.key) - SESSION_ORDER.indexOf(b.key)), [filtered]);
  const byHold = useMemo(() => agg(filtered, (t) => holdBucket(t.holdHours)).sort((a, b) => HOLD_ORDER.indexOf(a.key) - HOLD_ORDER.indexOf(b.key)), [filtered]);
  const byWeekday = useMemo(
    () => agg(filtered, (t) => weekdayName(t.openedAt)).sort((a, b) => WD_ORDER.indexOf(a.key) - WD_ORDER.indexOf(b.key)),
    [filtered],
  );
  const byWeek = useMemo(() => agg(filtered, (t) => weekLabel(t.at)).sort((a, b) => a.key.localeCompare(b.key)), [filtered]);
  const eq = useMemo(() => equitySeries(filtered), [filtered]);
  const spotlight = useMemo(() => {
    const byCh = new Map<string, InsightTrade[]>();
    for (const t of filtered) { const a = byCh.get(t.channel) ?? []; a.push(t); byCh.set(t.channel, a); }
    return [...byCh.entries()]
      .map(([channel, ts]) => ({ channel, n: ts.length, combos: bestCombos(ts) }))
      .sort((a, b) => (b.combos[0]?.net ?? -Infinity) - (a.combos[0]?.net ?? -Infinity));
  }, [filtered]);
  const channelSparks = useMemo(
    () => Object.fromEntries(byChannel.map((r) => [r.key, equitySeries(filtered.filter((t) => t.channel === r.key))])),
    [byChannel, filtered],
  );

  const filtersActive = fChannel !== ALL || fCoin !== ALL || fTier !== ALL || fSide !== ALL || rangeDays !== 0;
  const sel = (label: string, value: string, set: (v: string) => void, opts: { v: string; l: string }[]) => (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)} style={{ width: "auto", minWidth: 130 }}>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Risk Insights</h1>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      <p className="muted" style={{ marginTop: 4, maxWidth: 820 }}>
        A professional edge read on every provider — expectancy in R-multiples, System Quality (SQN), profit factor,
        payoff, drawdown and streaks — plus live portfolio risk (heat, naked stops, concentration) and the classic
        channel/coin/tier/side/session breakdowns. From settled trades{trades ? ` · ${trades.length} total` : ""}.
        Sharper as data accumulates.
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}
      {!trades ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {/* Live portfolio risk — independent of the closed-trade filters. */}
          <h2 style={{ marginBottom: 4 }}>Portfolio risk — live open positions</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 12, maxWidth: 820 }}>
            What you are exposed to <b>right now</b>. Heat = summed risk-to-stop as a share of equity (veterans cap total
            open risk near 6%); naked = positions with no stop (unbounded); net exposure &gt; ~100% of equity is a
            one-way directional bet.
          </p>
          <div className="panel"><PortfolioRisk open={open} equity={equity} /></div>

          {trades.length === 0 ? (
            <div className="empty" style={{ marginTop: 12 }}>No settled trades yet — edge stats appear once trades close.</div>
          ) : (
            <>
              {/* filter bar */}
              <div className="panel" style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
                {sel("Channel", fChannel, setFChannel, [{ v: ALL, l: "All channels" }, ...channelOpts.map((c) => ({ v: c, l: c }))])}
                {sel("Coin", fCoin, setFCoin, [{ v: ALL, l: "All coins" }, ...coinOpts.map((c) => ({ v: c, l: c }))])}
                {sel("Cap tier", fTier, setFTier, [{ v: ALL, l: "All tiers" }, { v: "large", l: "large" }, { v: "mid", l: "mid" }, { v: "small", l: "small" }])}
                {sel("Side", fSide, setFSide, [{ v: ALL, l: "Long + Short" }, { v: "long", l: "long" }, { v: "short", l: "short" }])}
                <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
                  <span className="muted" style={{ fontSize: 11 }}>Range</span>
                  <div className="btn-row" style={{ gap: 4 }}>
                    {[{ d: 7, l: "7d" }, { d: 30, l: "30d" }, { d: 90, l: "90d" }, { d: 0, l: "All" }].map((o) => (
                      <button key={o.d} className={rangeDays === o.d ? "primary" : "ghost"} onClick={() => setRangeDays(o.d)} style={{ padding: "6px 10px" }}>{o.l}</button>
                    ))}
                  </div>
                </label>
                <div style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                  {filtered.length} trade{filtered.length === 1 ? "" : "s"} ·{" "}
                  <span style={{ color: netColor(eq[eq.length - 1] ?? 0) }}>{usd(eq[eq.length - 1] ?? 0)} USDC net</span>
                </span>
                {filtersActive && <button className="ghost" onClick={() => { setFChannel(ALL); setFCoin(ALL); setFTier(ALL); setFSide(ALL); setRangeDays(0); }}>Clear</button>}
              </div>

              {filtered.length === 0 ? (
                <div className="empty">No trades match these filters.</div>
              ) : (
                <>
                  {/* headline edge tiles for the current selection */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
                    <StatTile label="Expectancy" value={overall.expectancyR === undefined ? "—" : `${overall.expectancyR >= 0 ? "+" : ""}${overall.expectancyR.toFixed(2)}R`} color={expColor(overall.expectancyR)} sub={`per trade · ${overall.nR}/${overall.n} with stop`} />
                    <StatTile label="System Quality (SQN)" value={fmt(overall.sqn, 2)} color={overall.nR < 30 ? "var(--muted)" : sqnColor(overall.sqn)} sub={overall.nR < 30 ? `low confidence · ${overall.nR}/30+ trades` : sqnLabel(overall.sqn)} />
                    <StatTile label="Win rate" value={pct(overall.winRate)} color={wrColor(overall.winRate)} sub={`break-even ${overall.breakEvenWr ? pct(overall.breakEvenWr) : "—"}`} />
                    <StatTile label="Profit factor" value={inf(overall.profitFactor)} color={pfColor(overall.profitFactor)} sub={`payoff ${inf(overall.payoff)}×`} />
                    <StatTile label="Max drawdown" value={`−${overall.maxDD.toFixed(0)}`} color="#ef4444" sub={overall.maxDDpct !== undefined ? `${(overall.maxDDpct * 100).toFixed(0)}% of peak` : "USDC"} />
                    <StatTile label="Worst loss streak" value={overall.maxLossStreak} color={overall.maxLossStreak >= 5 ? "#ef4444" : undefined} sub={`best win streak ${overall.maxWinStreak}`} />
                    <StatTile label="Top-3 trade dependence" value={overall.top3Share === undefined ? "—" : pct(overall.top3Share)} color={overall.top3Share !== undefined && overall.top3Share > 0.5 ? "#f59e0b" : undefined} sub="of gross profit from 3 best" />
                    <StatTile label="Avg hold" value={overall.avgHold === undefined ? "—" : overall.avgHold >= 24 ? `${(overall.avgHold / 24).toFixed(1)}d` : `${overall.avgHold.toFixed(1)}h`} sub={overall.avgSlip !== undefined ? `slippage ${overall.avgSlip >= 0 ? "+" : ""}${overall.avgSlip.toFixed(2)}%` : ""} />
                  </div>

                  <div className="panel" style={{ marginTop: 12 }}>
                    <div className="row-between">
                      <h3 style={{ margin: 0 }}>Equity curve — cumulative net{filtersActive ? " (filtered)" : ""}</h3>
                      <span style={{ color: netColor(eq[eq.length - 1] ?? 0), fontVariantNumeric: "tabular-nums" }}>{usd(eq[eq.length - 1] ?? 0)} USDC</span>
                    </div>
                    <div style={{ marginTop: 8 }}><Sparkline data={eq} height={64} full /></div>
                  </div>

                  <h2 style={{ marginBottom: 4, marginTop: 8 }}>Edge scorecard — per channel</h2>
                  <p className="muted" style={{ marginTop: 0, fontSize: 12, maxWidth: 820 }}>
                    Expectancy is average R (profit per unit risked); SQN is Van Tharp's System Quality (≥2.5 good,
                    ≥3 excellent); profit factor is gross profit ÷ gross loss (≥2 strong); payoff is avg win ÷ avg loss.
                  </p>
                  <div className="panel" style={{ overflowX: "auto" }}><EdgeTable rows={edgeRows} /></div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 12 }}>
                    <Card title="R-multiple distribution" hint="Shape of the edge — where outcomes land in units of initial risk (stop-based).">
                      <RHistogram trades={filtered} />
                    </Card>
                    <Card title="By trading session (entry, UTC)" hint="Asia 00–07 · EU 07–12 · US 12–21 · Late 21–24">
                      <BucketTable rows={bySession} label="Session" />
                    </Card>
                    <Card title="By hold time" hint="Does the edge live in scalps or swings?">
                      <BucketTable rows={byHold} label="Hold" />
                    </Card>
                    <Card title="By coin"><BucketTable rows={bySymbol} label="Coin" showTier /></Card>
                    <Card title="By market-cap tier"><BucketTable rows={byTier} label="Tier" /></Card>
                    <Card title="By side (long / short)"><BucketTable rows={bySide} label="Side" /></Card>
                    <Card title="By weekday (entry day)"><BucketTable rows={byWeekday} label="Weekday" /></Card>
                    <Card title="By week of month"><BucketTable rows={byWeek} label="Week" /></Card>
                  </div>

                  <h2 style={{ marginBottom: 4, marginTop: 8 }}>Channels</h2>
                  <div className="panel" style={{ overflowX: "auto" }}><BucketTable rows={byChannel} label="Channel" sparks={channelSparks} /></div>

                  <h2 style={{ marginBottom: 4, marginTop: 8 }}>Spotlight — best factor combination per trader</h2>
                  <p className="muted" style={{ marginTop: 0, fontSize: 12, maxWidth: 760 }}>
                    The most profitable mix of factors (side · cap-tier / coin · weekday · week · session) in each
                    channel's settled trades — at least 3 trades and a winning record.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                    {spotlight.map((s) => (
                      <Card key={s.channel} title={s.channel}>
                        {s.combos.length === 0 ? (
                          <div className="muted" style={{ fontSize: 12 }}>No standout combination yet — thin data.</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {s.combos.map((c, i) => (
                              <div key={c.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                                <span style={{ fontWeight: i === 0 ? 600 : 400 }}>{i === 0 ? "🏆 " : "• "}{c.label}</span>
                                <span style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                                  <span style={{ color: wrColor(c.winRate) }}>{pct(c.winRate)}</span>
                                  <span className="muted"> · </span>
                                  <span style={{ color: netColor(c.net) }}>{usd(c.net)}</span>
                                  <span className="muted"> · {c.n}×</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
