import type { ReactNode } from "react";
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
import type { DashboardStats, RiskRating, Signal, Trade } from "@tttrading/shared";
import { num, pct, pnlClass, shortTime, usd } from "../format.js";
import { ListenerHealth } from "../components/ListenerHealth.js";
import { AccountPanel } from "../components/AccountPanel.js";
import { RiskControls } from "../components/RiskControls.js";

/** A v2 KPI tile: label + value, with an optional delta sub-line and sparkline. */
function Kpi({
  label,
  value,
  cls,
  delta,
  spark,
  hero,
  accent,
}: {
  label: string;
  value: ReactNode;
  cls?: string;
  delta?: ReactNode;
  spark?: ReactNode;
  hero?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={`kpi${accent ? " accent" : ""}${hero ? " hero" : ""}`}>
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
      {delta !== undefined && delta !== false && <div className="delta">{delta}</div>}
      {spark}
    </div>
  );
}

/** Inline SVG sparkline built from a numeric series (champagne/gain/loss line + end dot). */
function Spark({ data, cls, w = 64, h = 26 }: { data: number[]; cls?: string; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return [x, y] as const;
  });
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path className={`l ${cls ?? ""}`} d={d} />
      <circle className={`m ${cls ?? ""}`} cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r={2.5} />
    </svg>
  );
}

/** v2 empty state used inside panels. */
function Empty({ title, why }: { title: string; why?: string }) {
  return (
    <div className="empty">
      <div className="e-title">{title}</div>
      {why && <div className="e-why">{why}</div>}
    </div>
  );
}

/** Classify a message for the feed: a fresh entry, a trade change, or info. */
function messageType(s: Signal): { label: string; cls: string } {
  if (s.status === "managed") return { label: "Trade change", cls: "managed" };
  // A parsed entry that was actually treated as a signal. "unparseable" carries
  // a weak below-threshold parse that we did NOT act on — that's chatter.
  if (s.parsed && s.status !== "unparseable") return { label: "Signal", cls: "long" };
  return { label: "Info", cls: "neutral" };
}

/** A recognized trade signal (not chatter / management / imported history). */
function isSignalRow(s: Signal): boolean {
  return (
    s.parsed !== undefined &&
    s.status !== "unparseable" &&
    s.status !== "managed" &&
    s.status !== "backfill"
  );
}

/** Compact status label + colour for the latest-signals table. */
function signalStatus(s: Signal, trade?: Trade): { label: string; cls: string; title?: string } {
  const paren = (err?: string) => {
    if (!err) return "";
    const short = err.split(/[:—-]/)[0]!.trim();
    return ` (${short})`;
  };
  switch (s.status) {
    case "executed":
      return trade?.simulated
        ? { label: "SIMULATED", cls: "pending", title: "Test mode — no real order sent" }
        : { label: "SUCCESSFUL", cls: "executed" };
    case "failed":
      return { label: `FAILED${paren(s.error)}`, cls: "rejected", title: s.error };
    case "blocked":
      return { label: "BLOCKED (red)", cls: "pending", title: s.error };
    case "pending":
      return { label: "PENDING", cls: "pending" };
    case "executing":
      return { label: "EXECUTING", cls: "neutral" };
    case "rejected":
      return { label: "REJECTED", cls: "rejected" };
    case "ignored":
      return { label: `IGNORED${paren(s.error)}`, cls: "neutral", title: s.error };
    default:
      return { label: s.status.toUpperCase(), cls: "neutral" };
  }
}

/** The parsed instruction, rendered as v2 side tag + symbol + price/SL/TP context. */
function ParsedCell({ s }: { s: Signal }) {
  const p = s.parsed;
  if (!p) return <span className="muted">—</span>;
  const tpCount = p.takeProfits?.length ?? 0;
  const lev = p.leverageHint;
  const meta =
    tpCount > 0 && lev !== undefined
      ? `${tpCount} TP · ${lev}x`
      : tpCount > 0
        ? `${tpCount} TP`
        : lev !== undefined
          ? `${lev}x`
          : "";
  return (
    <>
      <span className={`tag side ${p.side}`}>{p.side}</span>{" "}
      <span className="num">{p.symbol}</span>
      {p.entry !== undefined && (
        <>
          {" "}
          <span className="muted">@</span> <span className="num">{num(p.entry)}</span>
        </>
      )}
      {p.stopLoss !== undefined && (
        <>
          {" "}
          <span className="muted">SL</span> <span className="num">{num(p.stopLoss)}</span>
        </>
      )}
      {meta && <span className="muted"> · {meta}</span>}
    </>
  );
}

/** Traffic-light risk badge — letter + score, never colour alone. */
function RiskChip({ r }: { r?: RiskRating }) {
  if (!r) return <span className="muted">—</span>;
  const letter = r.level === "green" ? "G" : r.level === "yellow" ? "Y" : "R";
  return (
    <span className={`risk ${r.level}`} title={`Risk ${r.level} · ${r.score}/100`}>
      <i>{letter}</i>
      {r.score}
    </span>
  );
}

export function Overview({
  stats,
  signals,
  trades,
  prices,
}: {
  stats: DashboardStats | null;
  signals: Signal[];
  trades: Trade[];
  prices: Record<string, number>;
}) {
  if (!stats) return <Empty title="Loading…" />;
  const o = stats.overall;

  // Resting limit orders waiting for a fill (not yet positions).
  const workingList = trades.filter((t) => t.status === "working" && !t.shadow);
  const workingCount = workingList.length;

  // Bound capital (initial margin = notional / leverage): what's locked right now
  // in open positions (current remaining size) vs reserved by resting orders.
  const marginOf = (notional: number, lev: number) => notional / Math.max(1, lev);
  // Live remaining size: openSize when the monitor has synced it, else subtract the
  // NATIVE TP fills — a native TP bumps tpFilledCount but does NOT decrement `size`,
  // so without this a TP-hit position would still show its full margin.
  const remainingSize = (t: Trade): number => {
    if (t.openSize !== undefined) return t.openSize;
    const n = t.takeProfits?.length ?? 0;
    const filled = t.tpFilledCount ?? 0;
    if (n > 0 && filled > 0) return t.size * Math.max(0, Math.min(1, (n - filled) / n));
    return t.size;
  };
  const openTrades = trades.filter((t) => t.status === "open" && !t.shadow);
  const openMargin = openTrades.reduce(
    (s, t) => s + marginOf(remainingSize(t) * t.entryPrice, t.leverage),
    0,
  );
  const workingMargin = workingList.reduce((s, t) => s + marginOf(t.notionalUsd, t.leverage), 0);

  // Long/short split of live positions (for the "Open" tile sub-line).
  const openLong = openTrades.filter((t) => t.side === "long").length;
  const openShort = openTrades.length - openLong;

  // Live unrealized PnL across open (non-shadow) trades from current marks.
  let openUpnl = 0;
  let marked = 0;
  for (const t of openTrades) {
    const mark = prices[t.symbol.toUpperCase()];
    if (mark && mark > 0) {
      const dir = t.side === "long" ? 1 : -1;
      // uPnL is the UNREALIZED mark-to-market on the remaining size only. Profit
      // already banked from partials is now counted as realized (o.realizedPnl),
      // so it must NOT be added here too, or it would be double-counted.
      openUpnl += (mark - t.entryPrice) * dir * t.size;
      marked++;
    }
  }

  // Best / worst closed trade — derived from the trade list so we can label the
  // Best/Worst tiles with the symbol + group behind the figure.
  const closedReal = trades.filter(
    (t) => t.status === "closed" && !t.shadow && !t.archived && t.realizedPnl !== undefined,
  );
  let bestT: Trade | undefined;
  let worstT: Trade | undefined;
  for (const t of closedReal) {
    if (!bestT || t.realizedPnl! > bestT.realizedPnl!) bestT = t;
    if (!worstT || t.realizedPnl! < worstT.realizedPnl!) worstT = t;
  }

  // Latest 10 messages across all channels (signals arrive newest-first).
  const feed = [...signals]
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .slice(0, 10);

  // Latest 10 recognized signals, with their trade (for test-mode detection).
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const sigFeed = [...signals]
    .filter(isSignalRow)
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .slice(0, 10);

  const equityData = stats.equityCurve.map((p) => ({ t: shortTime(p.t), pnl: p.pnl }));
  const equitySeries = stats.equityCurve.map((p) => p.pnl);
  const groupData = stats.byGroup.map((g) => ({
    name: g.groupName,
    pnl: Number(g.stats.realizedPnl.toFixed(2)),
  }));

  const profitFactor = Number.isNaN(o.profitFactor)
    ? "—"
    : Number.isFinite(o.profitFactor)
      ? o.profitFactor.toFixed(2)
      : "∞";

  return (
    <>
      <div className="kpi-grid">
        <Kpi
          label="Realized PnL"
          value={<span className={pnlClass(o.realizedPnl)}>{usd(o.realizedPnl)}</span>}
          hero
          accent
          delta={
            o.bankedOpenPnl !== 0 ? (
              <>
                incl. <b className={pnlClass(o.bankedOpenPnl)}>{usd(o.bankedOpenPnl)}</b> banked from
                open partials
              </>
            ) : (
              <>
                {o.trades} closed · avg {usd(o.avgPnl)}
              </>
            )
          }
          spark={equitySeries.length > 1 ? <Spark data={equitySeries} cls="brand" w={96} h={30} /> : undefined}
        />

        {o.bankedOpenPnl !== 0 && (
          <Kpi
            label="Banked (open partials)"
            value={usd(o.bankedOpenPnl)}
            cls={pnlClass(o.bankedOpenPnl)}
          />
        )}

        <Kpi
          label="Win rate"
          value={pct(o.winRate)}
          delta={
            <>
              {o.wins}W · {o.losses}L
            </>
          }
        />
        <Kpi label="Trades" value={String(o.trades)} />
        <Kpi
          label="Open"
          value={String(o.openTrades)}
          delta={
            openTrades.length > 0 ? (
              <>
                {openLong} long · {openShort} short
              </>
            ) : undefined
          }
        />
        <Kpi
          label="Working orders"
          value={String(workingCount)}
          delta={workingCount > 0 ? <span className="warn">{workingCount} resting</span> : undefined}
        />
        <Kpi label="Margin — open" value={usd(openMargin)} />
        <Kpi
          label="Margin — working"
          value={usd(workingMargin)}
          delta={workingMargin > 0 ? "committed, not a position yet" : undefined}
        />
        <Kpi
          label="Open uPnL"
          value={marked > 0 ? usd(openUpnl) : "—"}
          cls={marked > 0 ? pnlClass(openUpnl) : ""}
          delta={
            marked > 0 ? (
              <>
                live · <span className="num">{marked}</span> position{marked === 1 ? "" : "s"}
              </>
            ) : undefined
          }
        />
        <Kpi label="Profit factor" value={profitFactor} delta="gross win ÷ gross loss" />
        <Kpi label="Avg PnL / trade" value={usd(o.avgPnl)} cls={pnlClass(o.avgPnl)} />
        <Kpi
          label="Best"
          value={usd(o.bestTrade)}
          cls="pos"
          delta={
            bestT ? (
              <>
                {bestT.symbol} {bestT.side} · {bestT.groupName}
              </>
            ) : undefined
          }
        />
        <Kpi
          label="Worst"
          value={usd(o.worstTrade)}
          cls="neg"
          delta={
            worstT ? (
              <>
                {worstT.symbol} {worstT.side} · {worstT.groupName}
              </>
            ) : undefined
          }
        />
      </div>

      <div className="grid-2">
        <div className="col">
          {/* Cumulative PnL */}
          <section className="panel">
            <div className="panel-head">
              <h2>
                Cumulative PnL<span className="sub">realized</span>
              </h2>
            </div>
            <div className="panel-body">
              {equityData.length === 0 ? (
                <Empty title="No closed trades yet." why="The curve appears once a trade closes." />
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={equityData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#d8bb78" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#d8bb78" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#26241f" />
                    <XAxis dataKey="t" stroke="#8a8478" fontSize={11} minTickGap={40} />
                    <YAxis stroke="#8a8478" fontSize={11} width={70} />
                    <Tooltip
                      contentStyle={{ background: "#1b1a18", border: "1px solid #26241f" }}
                      formatter={(v: number) => usd(v)}
                    />
                    <Area type="monotone" dataKey="pnl" stroke="#d8bb78" fill="url(#pnlFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            {o.bankedOpenPnl !== 0 && (
              <div className="panel-foot">
                <span>
                  Includes <b>profit banked from partials</b> on still-open trades (
                  {usd(o.bankedOpenPnl)}).
                </span>
              </div>
            )}
          </section>

          {/* Performance by group */}
          <section className="panel">
            <div className="panel-head">
              <h2>Performance by group</h2>
            </div>
            <div className="panel-body flush">
              <div className="table-scroll">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th className="num">Trades</th>
                      <th className="num">Win %</th>
                      <th className="num">PnL</th>
                      <th className="num">PF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byGroup.map((g) => (
                      <tr key={g.groupId}>
                        <td>
                          <span className="w600">{g.groupName}</span>
                        </td>
                        <td className="num">{g.stats.trades}</td>
                        <td className="num">{pct(g.stats.winRate)}</td>
                        <td className="num">
                          <span className={`num ${pnlClass(g.stats.realizedPnl)}`}>
                            {usd(g.stats.realizedPnl)}
                          </span>
                        </td>
                        <td className="num">
                          {Number.isFinite(g.stats.profitFactor)
                            ? g.stats.profitFactor.toFixed(2)
                            : "∞"}
                        </td>
                      </tr>
                    ))}
                    {stats.byGroup.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <Empty title="No groups yet." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {stats.byGroup.length > 0 && (
                    <tfoot>
                      <tr>
                        <td>All groups</td>
                        <td className="num">{o.trades}</td>
                        <td className="num">{pct(o.winRate)}</td>
                        <td className="num">
                          <span className={`num ${pnlClass(o.realizedPnl)}`}>
                            {usd(o.realizedPnl)}
                          </span>
                        </td>
                        <td className="num">{profitFactor}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
            <div className="panel-body">
              <div className="caps mb8">PnL by group</div>
              {groupData.length === 0 ? (
                <Empty title="—" />
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={groupData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#26241f" />
                    <XAxis dataKey="name" stroke="#8a8478" fontSize={11} />
                    <YAxis stroke="#8a8478" fontSize={11} width={60} />
                    <Tooltip
                      contentStyle={{ background: "#1b1a18", border: "1px solid #26241f" }}
                      formatter={(v: number) => usd(v)}
                      cursor={{ fill: "#262422" }}
                    />
                    <Bar dataKey="pnl">
                      {groupData.map((d, i) => (
                        <Cell key={i} fill={d.pnl >= 0 ? "#36c77e" : "#ef5560"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          {/* Risk-classification audit */}
          {stats.riskAudit.blocked > 0 && (
            <>
              <div className="section-title">
                <h2>Risk classification audit</h2>
                <span className="sub">blocked red signals · were the blocks right?</span>
              </div>
              <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                <Kpi
                  label="Reds blocked"
                  value={String(stats.riskAudit.blocked)}
                  delta="tracked as shadow trades"
                />
                <Kpi
                  label="Resolved"
                  value={String(stats.riskAudit.resolved)}
                  delta={
                    stats.riskAudit.blocked - stats.riskAudit.resolved > 0
                      ? `${stats.riskAudit.blocked - stats.riskAudit.resolved} still running`
                      : undefined
                  }
                />
                <Kpi
                  label="Would have lost"
                  value={
                    <>
                      {stats.riskAudit.wouldLose} <small>of {stats.riskAudit.resolved}</small>
                    </>
                  }
                  delta={
                    stats.riskAudit.resolved > 0 ? (
                      <>
                        <b className="gain">
                          {Math.round((stats.riskAudit.wouldLose / stats.riskAudit.resolved) * 100)}%
                        </b>{" "}
                        of blocks were right
                      </>
                    ) : undefined
                  }
                />
                <Kpi
                  label="PnL avoided"
                  value={usd(stats.riskAudit.avoidedPnl)}
                  cls={pnlClass(stats.riskAudit.avoidedPnl)}
                  delta="hypothetical, at live prices"
                />
              </div>
            </>
          )}

          {/* Latest signals */}
          <section className="panel">
            <div className="panel-head">
              <h2>
                Latest signals<span className="sub">live</span>
              </h2>
            </div>
            <div className="panel-body flush">
              <div className="table-scroll">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Group</th>
                      <th>Parsed</th>
                      <th>Status</th>
                      <th>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sigFeed.map((s) => {
                      const st = signalStatus(
                        s,
                        s.tradeId ? tradeById.get(s.tradeId) : undefined,
                      );
                      return (
                        <tr key={s.id}>
                          <td>
                            <span className="num muted">{shortTime(s.receivedAt)}</span>
                          </td>
                          <td>{s.groupName}</td>
                          <td>
                            <ParsedCell s={s} />
                          </td>
                          <td>
                            <span className={`tag ${st.cls}`} title={st.title}>
                              {st.label}
                            </span>
                          </td>
                          <td>
                            <RiskChip r={s.risk} />
                          </td>
                        </tr>
                      );
                    })}
                    {sigFeed.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <Empty title="No signals yet." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Latest messages */}
          <section className="panel">
            <div className="panel-head">
              <h2>
                Latest messages<span className="sub">as received</span>
              </h2>
            </div>
            <div className="panel-body flush">
              {feed.length === 0 ? (
                <Empty title="No messages yet." />
              ) : (
                feed.map((s) => {
                  const mt = messageType(s);
                  return (
                    <div className="msg" key={s.id}>
                      <div className="thumb" style={s.hasImage ? undefined : { background: "var(--surface-2)" }}>
                        {s.hasImage ? (
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <rect x="3" y="4" width="18" height="16" rx="2" />
                            <circle cx="9" cy="10" r="1.6" />
                            <path d="M21 16l-5-5-8 9" />
                          </svg>
                        ) : (
                          <span className="xs muted">text</span>
                        )}
                      </div>
                      <div>
                        <div className="head">
                          <span className="grp">{s.groupName}</span>
                          <span className={`tag ${mt.cls}`}>{mt.label}</span>
                          <span className="when">{shortTime(s.receivedAt)}</span>
                        </div>
                        <div
                          className="body"
                          title={s.rawText}
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                          }}
                        >
                          {s.rawText}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        {/* Right column — existing child components, rendered as-is */}
        <div className="col">
          <AccountPanel />
          <RiskControls />
          <ListenerHealth />
        </div>
      </div>
    </>
  );
}
