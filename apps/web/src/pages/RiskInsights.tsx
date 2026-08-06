import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Bucket, type ChannelInsight } from "../api.js";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}`;
const netColor = (n: number) => (n > 0 ? "#22c55e" : n < 0 ? "#ef4444" : "var(--muted)");
const wrColor = (w: number) => (w >= 0.55 ? "#22c55e" : w >= 0.45 ? "#f59e0b" : "#ef4444");

function TierTag({ tier }: { tier?: string }) {
  if (!tier) return null;
  const bg = tier === "large" ? "#16a34a" : tier === "small" ? "#b45309" : "#475569";
  return (
    <span className="tag" style={{ marginLeft: 6, background: bg, color: "#fff", fontSize: 10 }}>
      {tier}
    </span>
  );
}

function BucketTable({ rows, label, showTier }: { rows: Bucket[]; label: string; showTier?: boolean }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12, padding: "8px 0" }}>No settled trades yet.</div>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr className="muted" style={{ textAlign: "left", fontSize: 11 }}>
          <th style={{ padding: "6px 8px" }}>{label}</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>trades</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>win rate</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>net</th>
          <th style={{ padding: "6px 8px", textAlign: "right" }}>avg</th>
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
            <td style={{ padding: "6px 8px", textAlign: "right", color: netColor(r.net), fontVariantNumeric: "tabular-nums" }}>
              {usd(r.net)}
            </td>
            <td style={{ padding: "6px 8px", textAlign: "right", color: netColor(r.avg), fontVariantNumeric: "tabular-nums" }}>
              {usd(r.avg)}
            </td>
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
          <h2 style={{ marginBottom: 4 }}>Channels</h2>
          <div className="panel" style={{ overflowX: "auto" }}>
            <BucketTable rows={data.byChannel} label="Channel" />
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
