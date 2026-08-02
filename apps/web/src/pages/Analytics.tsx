import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsBucket, AnalyticsResponse } from "@tttrading/shared";
import { api } from "../api.js";
import { pct, pnlClass, shortTime, usd } from "../format.js";

type Range = "all" | "7d" | "30d" | "90d";

function fromDate(range: Range): string | undefined {
  if (range === "all") return undefined;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function Kpi({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

/** A sortable-by-PnL performance table over analytics buckets. */
function BucketTable({ title, rows }: { title: string; rows: AnalyticsBucket[] }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Trades</th>
              <th>Win %</th>
              <th>PnL</th>
              <th>PF</th>
              <th>Avg RR</th>
              <th>Expectancy</th>
              <th>Avg win</th>
              <th>Avg loss</th>
              <th>Max DD</th>
              <th>Avg hold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key}>
                <td>{b.label}</td>
                <td>{b.stats.trades}</td>
                <td>{pct(b.stats.winRate)}</td>
                <td className={pnlClass(b.stats.realizedPnl)}>{usd(b.stats.realizedPnl)}</td>
                <td>{Number.isFinite(b.stats.profitFactor) ? b.stats.profitFactor.toFixed(2) : "∞"}</td>
                <td className={pnlClass(b.stats.avgRR)} title={`${b.stats.rrSampleSize} trades with SL`}>
                  {b.stats.rrSampleSize ? `${b.stats.avgRR}R` : "—"}
                </td>
                <td className={pnlClass(b.stats.expectancy)}>{usd(b.stats.expectancy)}</td>
                <td className="pos">{usd(b.stats.avgWin)}</td>
                <td className="neg">{usd(b.stats.avgLoss)}</td>
                <td className="neg">{usd(b.stats.maxDrawdown)}</td>
                <td className="muted">
                  {b.stats.avgHoldHours >= 24
                    ? `${(b.stats.avgHoldHours / 24).toFixed(1)}d`
                    : `${b.stats.avgHoldHours}h`}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="empty">
                  No closed trades in range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PnlBars({ title, rows }: { title: string; rows: AnalyticsBucket[] }) {
  const data = rows
    .map((b) => ({ name: b.label, pnl: Number(b.stats.realizedPnl.toFixed(2)) }))
    .filter((d) => d.pnl !== 0);
  if (data.length === 0) return null;
  return (
    <div className="panel">
      <h2>{title}</h2>
      <ResponsiveContainer width="100%" height={Math.max(200, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ top: 6, right: 16, left: 10, bottom: 6 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#232838" />
          <XAxis type="number" stroke="#8b93a7" fontSize={11} />
          <YAxis type="category" dataKey="name" stroke="#8b93a7" fontSize={11} width={90} />
          <Tooltip
            contentStyle={{ background: "#131722", border: "1px solid #232838" }}
            formatter={(v: number) => usd(v)}
            cursor={{ fill: "#1a1f2e" }}
          />
          <Bar dataKey="pnl">
            {data.map((d, i) => (
              <Cell key={i} fill={d.pnl >= 0 ? "#22c55e" : "#ef4444"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Analytics() {
  const [range, setRange] = useState<Range>("all");
  const [includeShadow, setIncludeShadow] = useState(false);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .analytics({ from: fromDate(range), includeShadow })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [range, includeShadow]);

  useEffect(() => {
    load();
  }, [load]);

  const o = data?.overall;
  const equity = (data?.equityCurve ?? []).map((p) => ({ t: shortTime(p.t), pnl: p.pnl }));

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Analytics</h1>
        <div className="btn-row" style={{ alignItems: "center" }}>
          {(["7d", "30d", "90d", "all"] as const).map((r) => (
            <button key={r} className={range === r ? "primary" : "ghost"} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
          <button
            className={includeShadow ? "primary" : "ghost"}
            onClick={() => setIncludeShadow((v) => !v)}
            title="Include hypothetical blocked-red (shadow) trades"
          >
            {includeShadow ? "✓ shadow" : "shadow"}
          </button>
          <button
            className="ghost"
            title="Send a daily summary to the Telegram alert chat now"
            onClick={() =>
              api
                .sendReport("daily")
                .then(() => alert("Daily report sent to the alert chat."))
                .catch((e) => alert(`Report failed: ${e instanceof Error ? e.message : e}`))
            }
          >
            Send report
          </button>
          <button className="ghost" onClick={load}>
            ↻
          </button>
        </div>
      </div>

      {!data ? (
        <div className="empty">{loading ? "Loading…" : "No data."}</div>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            {data.closedTrades} closed trades in range
            {data.includesSimulated && " · includes simulated (test-mode) trades"}
          </div>

          <div className="kpi-grid">
            <Kpi label="Realized PnL" value={usd(o!.realizedPnl)} cls={pnlClass(o!.realizedPnl)} />
            <Kpi label="Win Rate" value={pct(o!.winRate)} />
            <Kpi label="Profit Factor" value={Number.isFinite(o!.profitFactor) ? o!.profitFactor.toFixed(2) : "∞"} />
            <Kpi label="Expectancy / trade" value={usd(o!.expectancy)} cls={pnlClass(o!.expectancy)} />
            <Kpi label="Avg RR" value={o!.rrSampleSize ? `${o!.avgRR}R` : "—"} cls={pnlClass(o!.avgRR)} />
            <Kpi label="Avg Win" value={usd(o!.avgWin)} cls="pos" />
            <Kpi label="Avg Loss" value={usd(o!.avgLoss)} cls="neg" />
            <Kpi label="Max Drawdown" value={usd(o!.maxDrawdown)} cls="neg" />
            <Kpi label="Avg Hold" value={o!.avgHoldHours >= 24 ? `${(o!.avgHoldHours / 24).toFixed(1)}d` : `${o!.avgHoldHours}h`} />
            <Kpi label="Best / Worst" value={`${usd(o!.bestTrade)} / ${usd(o!.worstTrade)}`} />
            <Kpi label="Total Fees" value={usd(o!.totalFees)} cls="neg" />
          </div>

          <div className="panel">
            <h2>Cumulative PnL</h2>
            {equity.length === 0 ? (
              <div className="empty">No closed trades in range.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={equity} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="aPnl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232838" />
                  <XAxis dataKey="t" stroke="#8b93a7" fontSize={11} minTickGap={40} />
                  <YAxis stroke="#8b93a7" fontSize={11} width={70} />
                  <Tooltip
                    contentStyle={{ background: "#131722", border: "1px solid #232838" }}
                    formatter={(v: number) => usd(v)}
                  />
                  <Area type="monotone" dataKey="pnl" stroke="#3b82f6" fill="url(#aPnl)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          <BucketTable title="Performance by group / trader" rows={data.byGroup} />
          <PnlBars title="PnL by group" rows={data.byGroup} />

          <BucketTable title="Performance by crypto" rows={data.bySymbol} />
          <PnlBars title="PnL by crypto" rows={data.bySymbol} />

          <BucketTable title="Long vs Short" rows={data.bySide} />
        </>
      )}
    </div>
  );
}
