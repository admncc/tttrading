import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Bucket, type ChannelInsight } from "../api.js";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}`;
const netColor = (n: number) => (n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "var(--muted)");
const wrColor = (w: number) => (w >= 0.55 ? "#22c55e" : w >= 0.45 ? "#f59e0b" : "#ef4444");

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
  return (
    <span className="tag" style={{ marginLeft: 6, background: bg, color: "#fff", fontSize: 10 }}>
      {tier}
    </span>
  );
}

function BucketTable({
  rows,
  label,
  showTier,
  sparks,
}: {
  rows: Bucket[];
  label: string;
  showTier?: boolean;
  sparks?: Record<string, number[]>;
}) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>No settled trades yet.</div>;
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
            <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
              {r.key}
              {showTier && <TierTag tier={r.tier} />}
            </td>
            <td style={{ padding: "6px 8px", textAlign: "right" }} className="muted">{r.n}</td>
            <td style={{ padding: "6px 8px", textAlign: "right", color: wrColor(r.winRate), fontVariantNumeric: "tabular-nums" }}>
              {pct(r.winRate)}
            </td>
            <td style={{ padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              <div style={{ color: netColor(r.net) }}>{usd(r.net)}</div>
              <div style={{ height: 3, background: "var(--border)", borderRadius: 2, marginTop: 3, display: "flex", justifyContent: "flex-end" }}>
                <div style={{ height: "100%", width: `${(Math.abs(r.net) / maxAbs) * 100}%`, background: netColor(r.net), borderRadius: 2 }} />
              </div>
            </td>
            <td style={{ padding: "6px 8px", textAlign: "right", color: netColor(r.avg), fontVariantNumeric: "tabular-nums" }}>
              {usd(r.avg)}
            </td>
            {sparks && (
              <td style={{ padding: "6px 8px", width: 130 }}>
                <Sparkline data={sparks[r.key] ?? []} width={120} height={28} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel" style={{ margin: 0 }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

export function RiskInsights() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.riskInsights>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [channel, setChannel] = useState("__all__");

  const load = () => {
    api
      .riskInsights()
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const scope: Pick<ChannelInsight, "bySymbol" | "byTier" | "byPeriod"> | null = useMemo(() => {
    if (!data) return null;
    if (channel === "__all__") return { bySymbol: data.bySymbol, byTier: data.byTier, byPeriod: data.byPeriod };
    return data.channels.find((c) => c.name === channel) ?? { bySymbol: [], byTier: [], byPeriod: [] };
  }, [data, channel]);

  const byWeek = useMemo(
    () => (scope ? [...scope.byPeriod].sort((a, b) => a.key.localeCompare(b.key)) : []),
    [scope],
  );

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Risk Insights</h1>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      <p className="muted" style={{ marginTop: 4, maxWidth: 760 }}>
        How each channel performs by coin, market-cap tier and week of the month — the same signals that feed the
        traffic-light risk score. Built from settled (closed) trades{data ? ` · ${data.totalClosed} so far` : ""}. These
        breakdowns get sharper as data accumulates over the months.
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}
      {!data ? (
        <div className="empty">Loading…</div>
      ) : data.totalClosed === 0 ? (
        <div className="empty">No settled trades yet — insights appear once trades close.</div>
      ) : (
        <>
          <div className="panel">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Equity curve — cumulative net (all channels)</h3>
              <span style={{ color: netColor(data.equity[data.equity.length - 1] ?? 0), fontVariantNumeric: "tabular-nums" }}>
                {usd(data.equity[data.equity.length - 1] ?? 0)} USDC
              </span>
            </div>
            <div style={{ marginTop: 8 }}>
              <Sparkline data={data.equity} height={64} full />
            </div>
          </div>

          <h2 style={{ marginBottom: 4 }}>Channels</h2>
          <div className="panel" style={{ overflowX: "auto" }}>
            <BucketTable
              rows={data.byChannel}
              label="Channel"
              sparks={Object.fromEntries(data.channels.map((c) => [c.name, c.equity]))}
            />
          </div>

          <div className="row-between" style={{ marginTop: 8 }}>
            <h2 style={{ margin: 0 }}>Breakdown</h2>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: "auto", minWidth: 180 }}>
              <option value="__all__">All channels</option>
              {data.channels.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
          {channel !== "__all__" &&
            (() => {
              const sel = data.channels.find((c) => c.name === channel);
              return sel ? (
                <div className="panel" style={{ marginTop: 8 }}>
                  <div className="row-between">
                    <h3 style={{ margin: 0 }}>{sel.name} — equity</h3>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {sel.n} trades · {pct(sel.winRate)} win ·{" "}
                      <span style={{ color: netColor(sel.net) }}>{usd(sel.net)} USDC</span>
                    </span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Sparkline data={sel.equity} height={56} full />
                  </div>
                </div>
              ) : null;
            })()}
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginTop: 8 }}
          >
            <Card title="By coin">
              <BucketTable rows={scope?.bySymbol ?? []} label="Coin" showTier />
            </Card>
            <Card title="By market-cap tier">
              <BucketTable rows={scope?.byTier ?? []} label="Tier" />
            </Card>
            <Card title="By week of month">
              <BucketTable rows={byWeek} label="Week" />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
