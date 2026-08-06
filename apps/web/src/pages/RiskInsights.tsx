import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type CapTier, type InsightTrade } from "../api.js";

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

function equity(trades: InsightTrade[]): number[] {
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

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
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

const ALL = "__all__";

export function RiskInsights() {
  const [trades, setTrades] = useState<InsightTrade[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fChannel, setFChannel] = useState(ALL);
  const [fCoin, setFCoin] = useState(ALL);
  const [fTier, setFTier] = useState(ALL);

  const load = () => {
    api
      .riskInsights()
      .then((d) => { setTrades(d.trades); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const channelOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.channel))].sort(), [trades]);
  const coinOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.symbol))].sort(), [trades]);

  const filtered = useMemo(
    () =>
      (trades ?? []).filter(
        (t) =>
          (fChannel === ALL || t.channel === fChannel) &&
          (fCoin === ALL || t.symbol === fCoin) &&
          (fTier === ALL || t.tier === fTier),
      ),
    [trades, fChannel, fCoin, fTier],
  );

  const byChannel = useMemo(() => agg(filtered, (t) => t.channel), [filtered]);
  const bySymbol = useMemo(() => agg(filtered, (t) => t.symbol, (t) => t.tier), [filtered]);
  const byTier = useMemo(() => agg(filtered, (t) => t.tier), [filtered]);
  const byWeek = useMemo(() => agg(filtered, (t) => weekLabel(t.at)).sort((a, b) => a.key.localeCompare(b.key)), [filtered]);
  const eq = useMemo(() => equity(filtered), [filtered]);
  const channelSparks = useMemo(
    () => Object.fromEntries(byChannel.map((r) => [r.key, equity(filtered.filter((t) => t.channel === r.key))])),
    [byChannel, filtered],
  );

  const filtersActive = fChannel !== ALL || fCoin !== ALL || fTier !== ALL;
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
      <p className="muted" style={{ marginTop: 4, maxWidth: 760 }}>
        How performance breaks down by channel, coin, market-cap tier and week of the month — the same signals that
        feed the traffic-light risk score. From settled (closed) trades{trades ? ` · ${trades.length} total` : ""}.
        Sharper as data accumulates over the months.
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}
      {!trades ? (
        <div className="empty">Loading…</div>
      ) : trades.length === 0 ? (
        <div className="empty">No settled trades yet — insights appear once trades close.</div>
      ) : (
        <>
          {/* filter bar */}
          <div className="panel" style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            {sel("Channel", fChannel, setFChannel, [{ v: ALL, l: "All channels" }, ...channelOpts.map((c) => ({ v: c, l: c }))])}
            {sel("Coin", fCoin, setFCoin, [{ v: ALL, l: "All coins" }, ...coinOpts.map((c) => ({ v: c, l: c }))])}
            {sel("Cap tier", fTier, setFTier, [
              { v: ALL, l: "All tiers" },
              { v: "large", l: "large" },
              { v: "mid", l: "mid" },
              { v: "small", l: "small" },
            ])}
            <div style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
              {filtered.length} trade{filtered.length === 1 ? "" : "s"} ·{" "}
              <span style={{ color: netColor(eq[eq.length - 1] ?? 0) }}>{usd(eq[eq.length - 1] ?? 0)} USDC net</span>
            </span>
            {filtersActive && (
              <button className="ghost" onClick={() => { setFChannel(ALL); setFCoin(ALL); setFTier(ALL); }}>Clear</button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="empty">No trades match these filters.</div>
          ) : (
            <>
              <div className="panel">
                <div className="row-between">
                  <h3 style={{ margin: 0 }}>Equity curve — cumulative net{filtersActive ? " (filtered)" : ""}</h3>
                  <span style={{ color: netColor(eq[eq.length - 1] ?? 0), fontVariantNumeric: "tabular-nums" }}>{usd(eq[eq.length - 1] ?? 0)} USDC</span>
                </div>
                <div style={{ marginTop: 8 }}><Sparkline data={eq} height={64} full /></div>
              </div>

              <h2 style={{ marginBottom: 4 }}>Channels</h2>
              <div className="panel" style={{ overflowX: "auto" }}>
                <BucketTable rows={byChannel} label="Channel" sparks={channelSparks} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 8 }}>
                <Card title="By coin"><BucketTable rows={bySymbol} label="Coin" showTier /></Card>
                <Card title="By market-cap tier"><BucketTable rows={byTier} label="Tier" /></Card>
                <Card title="By week of month"><BucketTable rows={byWeek} label="Week" /></Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
