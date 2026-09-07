import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { pct, shortTime, usd } from "../format.js";
import { DEFAULT_RANGE, RangePicker, rangeLabel, rangeWindow, type RangeState } from "../dateRange.js";

/** PnL colour class in native v2 semantics. */
const gl = (n: number): string => (n > 0 ? "gain" : n < 0 ? "loss" : "");

const pf = (n: number): string =>
  Number.isNaN(n) ? "—" : Number.isFinite(n) ? n.toFixed(2) : "∞";

const holdText = (h: number): string => (h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h}h`);

/** Champagne sparkline path over a cumulative-PnL series (viewBox 0 0 96 30). */
function sparkPath(pnls: number[]): { d: string; cx: number; cy: number } | null {
  const n = pnls.length;
  if (n < 2) return null;
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const range = max - min || 1;
  const X0 = 2;
  const X1 = 94;
  const Y0 = 28;
  const Y1 = 2;
  const pts = pnls.map((v, i): [number, number] => {
    const x = X0 + (i * (X1 - X0)) / (n - 1);
    const y = Y0 - ((v - min) / range) * (Y0 - Y1);
    return [x, y];
  });
  const d = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1];
  if (!last) return null;
  return { d, cx: last[0], cy: last[1] };
}

function Kpi({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  cls?: string;
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
      {sub != null && <div className="delta">{sub}</div>}
    </div>
  );
}

/** A performance table over analytics buckets, rendered in native v2 markup. */
function BucketTable({
  title,
  hint,
  rows,
  symbol = false,
}: {
  title: string;
  hint?: string;
  rows: AnalyticsBucket[];
  symbol?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {title}
          {hint && <span className="sub">{hint}</span>}
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="panel-body">
          <div className="empty">
            <div className="e-title">No closed trades in range</div>
            <div className="e-why">Widen the date range or include shadow trades to see results here.</div>
          </div>
        </div>
      ) : (
        <div className="panel-body flush">
          <div className="table-scroll">
            <table className="table compact">
              <thead>
                <tr>
                  <th>{symbol ? "Crypto" : "Group / trader"}</th>
                  <th className="num">Trades</th>
                  <th className="num">Win %</th>
                  <th className="num sort">PnL</th>
                  <th className="num">PF</th>
                  <th className="num">Avg RR</th>
                  <th className="num">Expect.</th>
                  <th className="num">Avg win</th>
                  <th className="num">Avg loss</th>
                  <th className="num">Max DD</th>
                  <th className="num">Avg hold</th>
                  <th className="num">Slip bps</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.key}>
                    <td>
                      {symbol ? (
                        <span className="sym">
                          <span className="coin">{b.label.slice(0, 3).toUpperCase()}</span>
                          <span>{b.label}</span>
                        </span>
                      ) : (
                        <span className="w600">{b.label}</span>
                      )}
                    </td>
                    <td className="num">{b.stats.trades}</td>
                    <td className="num">{pct(b.stats.winRate)}</td>
                    <td className="num">
                      <span className={`num ${gl(b.stats.realizedPnl)}`}>{usd(b.stats.realizedPnl)}</span>
                    </td>
                    <td className="num">{pf(b.stats.profitFactor)}</td>
                    <td
                      className={`num ${gl(b.stats.avgRR)}`}
                      title={`${b.stats.rrSampleSize} trades with SL`}
                    >
                      {b.stats.rrSampleSize ? `${b.stats.avgRR}R` : "—"}
                    </td>
                    <td className="num">
                      <span className={`num ${gl(b.stats.expectancy)}`}>{usd(b.stats.expectancy)}</span>
                    </td>
                    <td className="num gain">{usd(b.stats.avgWin)}</td>
                    <td className="num loss">{usd(b.stats.avgLoss)}</td>
                    <td className="num loss">{usd(b.stats.maxDrawdown)}</td>
                    <td className="num muted">{holdText(b.stats.avgHoldHours)}</td>
                    <td
                      className={`num ${
                        b.stats.slippageSampleSize ? (b.stats.avgSlippageBps > 0 ? "loss" : "gain") : "muted"
                      }`}
                      title={`${b.stats.slippageSampleSize} trades with a signal entry (positive = adverse)`}
                    >
                      {b.stats.slippageSampleSize ? `${b.stats.avgSlippageBps}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Long-vs-Short compact table (a reduced column set). */
function SideTable({ rows }: { rows: AnalyticsBucket[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Long vs Short<span className="sub">range</span>
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="panel-body">
          <div className="empty">
            <div className="e-title">No closed trades in range</div>
          </div>
        </div>
      ) : (
        <div className="panel-body flush">
          <div className="table-scroll">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Side</th>
                  <th className="num">Trades</th>
                  <th className="num">Win %</th>
                  <th className="num">PnL</th>
                  <th className="num">PF</th>
                  <th className="num">Avg RR</th>
                  <th className="num">Expect.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.key}>
                    <td>{b.label}</td>
                    <td className="num">{b.stats.trades}</td>
                    <td className="num">{pct(b.stats.winRate)}</td>
                    <td className="num">
                      <span className={`num ${gl(b.stats.realizedPnl)}`}>{usd(b.stats.realizedPnl)}</span>
                    </td>
                    <td className="num">{pf(b.stats.profitFactor)}</td>
                    <td className={`num ${gl(b.stats.avgRR)}`}>
                      {b.stats.rrSampleSize ? `${b.stats.avgRR}R` : "—"}
                    </td>
                    <td className="num">
                      <span className={`num ${gl(b.stats.expectancy)}`}>{usd(b.stats.expectancy)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function PnlBars({ title, rows, columns }: { title: string; rows: AnalyticsBucket[]; columns?: boolean }) {
  const data = rows
    .map((b) => ({ name: b.label, pnl: Number(b.stats.realizedPnl.toFixed(2)) }))
    .filter((d) => d.pnl !== 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {title}
          <span className="sub">range</span>
        </h2>
      </div>
      <div className="panel-body">
        {data.length === 0 ? (
          <div className="empty">
            <div className="e-title">Nothing to plot</div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={columns ? 260 : Math.max(180, data.length * 34)}>
            {columns ? (
              <BarChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                <XAxis type="category" dataKey="name" stroke="#8a8478" fontSize={11} interval={0} angle={-30} textAnchor="end" height={54} />
                <YAxis type="number" stroke="#8a8478" fontSize={11} width={60} />
                <Tooltip
                  contentStyle={{ background: "#1b1a18", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                  formatter={(v: number) => usd(v)}
                  cursor={{ fill: "rgba(255,255,255,0.05)" }}
                />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? "#36c77e" : "#ef5560"} />
                  ))}
                </Bar>
              </BarChart>
            ) : (
              <BarChart data={data} layout="vertical" margin={{ top: 6, right: 20, left: 10, bottom: 6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                <XAxis type="number" stroke="#8a8478" fontSize={11} />
                <YAxis type="category" dataKey="name" stroke="#8a8478" fontSize={11} width={90} />
                <Tooltip
                  contentStyle={{ background: "#1b1a18", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                  formatter={(v: number) => usd(v)}
                  cursor={{ fill: "rgba(255,255,255,0.05)" }}
                />
                <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? "#36c77e" : "#ef5560"} />
                  ))}
                </Bar>
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

export function Analytics() {
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE);
  const [includeShadow, setIncludeShadow] = useState(false);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const { from, to } = rangeWindow(range);
    api
      .analytics({ from, to, includeShadow })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [range, includeShadow]);

  useEffect(() => {
    load();
  }, [load]);

  // Quick range presets mapped onto the existing RangeState (no invented data:
  // YTD resolves to a real custom [Jan 1 → today] window).
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ytdFrom = `${now.getFullYear()}-01-01`;
  const ytdTo = ymd(now);
  const segs: { key: string; label: string; state: RangeState }[] = [
    { key: "7d", label: "7d", state: { preset: "7d", from: "", to: "" } },
    { key: "30d", label: "30d", state: { preset: "30d", from: "", to: "" } },
    { key: "90d", label: "90d", state: { preset: "90d", from: "", to: "" } },
    { key: "ytd", label: "YTD", state: { preset: "custom", from: ytdFrom, to: ytdTo } },
    { key: "all", label: "All", state: { preset: "all", from: "", to: "" } },
  ];
  const segActive = (key: string): boolean =>
    key === "ytd"
      ? range.preset === "custom" && range.from === ytdFrom && range.to === ytdTo
      : range.preset === key;

  const sendReport = () =>
    api
      .sendReport("daily")
      .then(() => alert("Daily report sent to the alert chat."))
      .catch((e) => alert(`Report failed: ${e instanceof Error ? e.message : e}`));

  const exportCsv = () => {
    if (!data) return;
    const header = [
      "Section",
      "Name",
      "Trades",
      "Win %",
      "PnL",
      "PF",
      "Avg RR",
      "Expectancy",
      "Avg win",
      "Avg loss",
      "Max DD",
      "Avg hold (h)",
      "Slippage bps",
    ];
    const cell = (s: string | number): string => {
      const v = String(s);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const bucketRow = (section: string, b: AnalyticsBucket): (string | number)[] => [
      section,
      b.label,
      b.stats.trades,
      (b.stats.winRate * 100).toFixed(1),
      b.stats.realizedPnl.toFixed(2),
      Number.isFinite(b.stats.profitFactor) ? b.stats.profitFactor.toFixed(2) : "inf",
      b.stats.rrSampleSize ? b.stats.avgRR : "",
      b.stats.expectancy.toFixed(2),
      b.stats.avgWin.toFixed(2),
      b.stats.avgLoss.toFixed(2),
      b.stats.maxDrawdown.toFixed(2),
      b.stats.avgHoldHours,
      b.stats.slippageSampleSize ? b.stats.avgSlippageBps : "",
    ];
    const lines: (string | number)[][] = [header];
    for (const b of data.byGroup) lines.push(bucketRow("Group", b));
    for (const b of data.bySymbol) lines.push(bucketRow("Crypto", b));
    for (const b of data.bySide) lines.push(bucketRow("Side", b));
    const csv = lines.map((r) => r.map(cell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-${ymd(now)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const o = data?.overall;
  const equity = (data?.equityCurve ?? []).map((p) => ({ t: shortTime(p.t), pnl: p.pnl }));
  const lastPnl = data?.equityCurve.at(-1)?.pnl;
  const spark = sparkPath((data?.equityCurve ?? []).map((p) => p.pnl));
  const longTrades = data?.bySide.find((b) => /long/i.test(b.key) || /long/i.test(b.label))?.stats.trades;
  const shortTrades = data?.bySide.find((b) => /short/i.test(b.key) || /short/i.test(b.label))?.stats.trades;

  return (
    <>
      {/* Filter row */}
      <div className="panel">
        <div className="panel-body tight between">
          <div className="flex" style={{ gap: 10, flexWrap: "wrap" }}>
            <span className="caps">Range</span>
            <RangePicker value={range} onChange={setRange} />
            <div className="seg">
              {segs.map((s) => (
                <span
                  key={s.key}
                  className={`seg-item ${segActive(s.key) ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setRange(s.state)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setRange(s.state);
                    }
                  }}
                >
                  {s.label}
                </span>
              ))}
            </div>
            <span className="hr" style={{ width: 1, height: 22, margin: "0 6px" }} />
            <span
              className={`switch ${includeShadow ? "on" : ""}`}
              role="switch"
              aria-checked={includeShadow}
              tabIndex={0}
              title="Include hypothetical blocked-red (shadow) trades"
              onClick={() => setIncludeShadow((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIncludeShadow((v) => !v);
                }
              }}
            >
              <span className="track" />
              <span className="sw-text">
                <span>Include shadow</span>
                <span className="hint">hypothetical blocked-red trades</span>
              </span>
            </span>
            {data && (
              <>
                <span className="hr" style={{ width: 1, height: 22, margin: "0 6px" }} />
                <span className="chip">includes simulated: {data.includesSimulated ? "yes" : "no"}</span>
              </>
            )}
          </div>
          <div className="flex">
            <button className="btn sm" onClick={sendReport} title="Send a daily summary to the Telegram alert chat now">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
              </svg>
              Send report
            </button>
            <button className="btn ghost sm" onClick={exportCsv} disabled={!data} title="Download the breakdown tables as CSV">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
              </svg>
              Export CSV
            </button>
            <button className="btn ghost icon sm" onClick={load} title="Refresh" aria-label="Refresh">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={loading ? "pulse" : undefined}>
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {!data || !o ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty">
              <div className="e-title">{loading ? "Loading analytics…" : "No data"}</div>
              {!loading && <div className="e-why">No analytics could be loaded for this range.</div>}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* KPI grid */}
          <div className="kpi-grid">
            <div className="kpi hero accent">
              <div className="label">Realized PnL · range</div>
              <div className="value">
                <span className={gl(o.realizedPnl)}>{usd(o.realizedPnl)}</span>
              </div>
              <div className="delta">
                <span className="num">{data.closedTrades}</span> trades
              </div>
              {spark && (
                <svg className="spark" viewBox="0 0 96 30" width="96" height="30" aria-hidden="true">
                  <path className="l brand" d={spark.d} />
                  <circle className="m brand" cx={spark.cx} cy={spark.cy} r={2.5} />
                </svg>
              )}
            </div>

            <Kpi
              label="Win rate"
              value={
                Number.isFinite(o.winRate) ? (
                  <>
                    {(o.winRate * 100).toFixed(1)}
                    <small>%</small>
                  </>
                ) : (
                  "—"
                )
              }
              sub={
                <>
                  {o.wins} W · {o.losses} L
                </>
              }
            />

            <Kpi
              label="Profit factor"
              value={pf(o.profitFactor)}
              sub={
                <>
                  gross <span className="gain">{usd(o.grossProfit)}</span> /{" "}
                  <span className="loss">{usd(-Math.abs(o.grossLoss))}</span>
                </>
              }
            />

            <Kpi
              label="Expectancy / trade"
              value={<span className={gl(o.expectancy)}>{usd(o.expectancy)}</span>}
              sub="per closed trade"
            />

            <Kpi
              label="Avg RR"
              value={o.rrSampleSize ? <span className={gl(o.avgRR)}>{o.avgRR}R</span> : "—"}
              sub={o.rrSampleSize ? `n = ${o.rrSampleSize} with stop` : undefined}
            />

            <Kpi label="Avg win" value={<span className="gain">{usd(o.avgWin)}</span>} />
            <Kpi label="Avg loss" value={<span className="loss">{usd(o.avgLoss)}</span>} />
            <Kpi label="Max drawdown" value={<span className="loss">{usd(o.maxDrawdown)}</span>} />

            <Kpi
              label="Avg hold"
              value={
                o.avgHoldHours >= 24 ? (
                  <>
                    {(o.avgHoldHours / 24).toFixed(1)}
                    <small>d</small>
                  </>
                ) : (
                  <>
                    {o.avgHoldHours}
                    <small>h</small>
                  </>
                )
              }
            />

            <Kpi
              label="Avg slippage"
              value={
                o.slippageSampleSize ? (
                  <span className={o.avgSlippageBps > 0 ? "loss" : "gain"}>
                    {o.avgSlippageBps}
                    <small>bps</small>
                  </span>
                ) : (
                  "—"
                )
              }
              sub={o.slippageSampleSize ? `n = ${o.slippageSampleSize} fills` : undefined}
            />

            <Kpi
              label="Best / Worst"
              value={
                <span style={{ fontSize: 19 }}>
                  <span className="gain">{usd(o.bestTrade)}</span> <span className="muted">/</span>{" "}
                  <span className="loss">{usd(o.worstTrade)}</span>
                </span>
              }
            />

            <Kpi
              label="Total fees"
              value={<span className="loss">{usd(o.totalFees)}</span>}
              sub={o.grossProfit > 0 ? `${pct(o.totalFees / o.grossProfit)} of gross` : undefined}
            />

            <Kpi label="Margin · open (now)" value={usd(data.boundMargin.open)} />
            <Kpi label="Margin · working (now)" value={usd(data.boundMargin.working)} />
            <Kpi label="Max margin (range)" value={usd(data.boundMargin.maxInRange)} sub="peak concurrent" />
            <Kpi
              label="Running margin (range)"
              value={usd(data.boundMargin.runMargin)}
              sub={
                <>
                  <span className="num">{data.boundMargin.runCount}</span> trades flowed through
                </>
              }
            />
            <Kpi
              label="Trades in range"
              value={String(data.boundMargin.runCount)}
              sub={
                data.bySide.length > 0 ? (
                  <>
                    {longTrades ?? 0} long : {shortTrades ?? 0} short
                  </>
                ) : undefined
              }
            />
          </div>

          {/* Cumulative PnL */}
          <section className="panel">
            <div className="panel-head">
              <h2>
                Cumulative PnL
                <span className="sub">realized · {rangeLabel(range)} · hover for the day tooltip</span>
              </h2>
              {lastPnl !== undefined && (
                <div className="actions">
                  <span className={`num ${gl(lastPnl)}`} style={{ fontSize: 15, fontWeight: 600 }}>
                    {usd(lastPnl)}
                  </span>
                </div>
              )}
            </div>
            <div className="panel-body">
              {equity.length === 0 ? (
                <div className="empty">
                  <div className="e-title">No closed trades in range</div>
                  <div className="e-why">Once trades close in this window, the cumulative curve appears here.</div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={equity} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="aPnl" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#d8bb78" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#d8bb78" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                    <XAxis dataKey="t" stroke="#8a8478" fontSize={11} minTickGap={40} />
                    <YAxis stroke="#8a8478" fontSize={11} width={70} />
                    <Tooltip
                      contentStyle={{ background: "#1b1a18", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}
                      labelStyle={{ color: "#ebe6dc" }}
                      formatter={(v: number) => [usd(v), "Cum. PnL"]}
                      cursor={{ stroke: "#8a8478", strokeWidth: 1, strokeDasharray: "2 3" }}
                    />
                    <Area type="monotone" dataKey="pnl" stroke="#d8bb78" strokeWidth={2} fill="url(#aPnl)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="panel-foot">
              <span>
                Realized from closed trades over time; the final step folds in profit already banked from partials on
                still-open trades, so it ends at the Realized PnL above.
              </span>
            </div>
          </section>

          {/* Breakdown tables + PnL charts */}
          <BucketTable title="Performance by group / trader" hint="click a header to sort" rows={data.byGroup} />
          <BucketTable title="Performance by crypto" hint="by trades" rows={data.bySymbol} symbol />

          <div className="grid-11">
            <PnlBars title="PnL by crypto" rows={data.bySymbol} columns />
            <PnlBars title="PnL by group" rows={data.byGroup} />
          </div>

          <SideTable rows={data.bySide} />
        </>
      )}
    </>
  );
}
