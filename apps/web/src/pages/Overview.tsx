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
import type { DashboardStats, Signal, Trade } from "@tttrading/shared";
import { pct, pnlClass, shortTime, usd } from "../format.js";
import { ListenerHealth } from "../components/ListenerHealth.js";

function Kpi({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

/** Classify a message for the feed: a fresh entry, a trade change, or info. */
function messageType(s: Signal): { label: string; cls: string } {
  if (s.status === "managed") return { label: "Trade change", cls: "managed" };
  // A parsed entry that was actually treated as a signal. "unparseable" carries
  // a weak below-threshold parse that we did NOT act on — that's chatter.
  if (s.parsed && s.status !== "unparseable") return { label: "Signal", cls: "long" };
  return { label: "Info", cls: "" };
}

function oneLine(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
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
        ? { label: "PAUSED (TEST MODE)", cls: "pending", title: "Simulated — no real order sent" }
        : { label: "SUCCESSFUL", cls: "executed" };
    case "failed":
      return { label: `FAILED${paren(s.error)}`, cls: "rejected", title: s.error };
    case "blocked":
      return { label: "BLOCKED (red)", cls: "pending", title: s.error };
    case "pending":
      return { label: "PENDING", cls: "pending" };
    case "executing":
      return { label: "EXECUTING", cls: "" };
    case "rejected":
      return { label: "REJECTED", cls: "rejected" };
    case "ignored":
      return { label: `IGNORED${paren(s.error)}`, cls: "", title: s.error };
    default:
      return { label: s.status.toUpperCase(), cls: "" };
  }
}

export function Overview({
  stats,
  signals,
  trades,
}: {
  stats: DashboardStats | null;
  signals: Signal[];
  trades: Trade[];
}) {
  if (!stats) return <div className="empty">Loading…</div>;
  const o = stats.overall;

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
  const groupData = stats.byGroup.map((g) => ({
    name: g.groupName,
    pnl: Number(g.stats.realizedPnl.toFixed(2)),
  }));

  return (
    <div>
      <h1>Overview</h1>

      <div className="kpi-grid">
        <Kpi label="Realized PnL" value={usd(o.realizedPnl)} cls={pnlClass(o.realizedPnl)} />
        <Kpi label="Win Rate" value={pct(o.winRate)} />
        <Kpi label="Trades" value={String(o.trades)} />
        <Kpi label="Open" value={String(o.openTrades)} />
        <Kpi
          label="Profit Factor"
          value={Number.isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : "∞"}
        />
        <Kpi label="Avg PnL / trade" value={usd(o.avgPnl)} cls={pnlClass(o.avgPnl)} />
        <Kpi label="Best" value={usd(o.bestTrade)} cls="pos" />
        <Kpi label="Worst" value={usd(o.worstTrade)} cls="neg" />
      </div>

      <div className="panel">
        <h2>Latest messages</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Type</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((s) => {
                const mt = messageType(s);
                return (
                  <tr key={s.id}>
                    <td className="muted">{shortTime(s.receivedAt)}</td>
                    <td>{s.groupName}</td>
                    <td>
                      <span className={`tag ${mt.cls}`}>{mt.label}</span>
                    </td>
                    <td title={s.rawText} style={{ whiteSpace: "normal" }}>
                      {oneLine(s.rawText)}
                    </td>
                  </tr>
                );
              })}
              {feed.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No messages yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Latest signals</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Signal</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sigFeed.map((s) => {
                const st = signalStatus(s, s.tradeId ? tradeById.get(s.tradeId) : undefined);
                return (
                  <tr key={s.id}>
                    <td className="muted">{shortTime(s.receivedAt)}</td>
                    <td>{s.groupName}</td>
                    <td>
                      {s.parsed ? (
                        <>
                          <span className={`tag ${s.parsed.side}`}>{s.parsed.side}</span>{" "}
                          {s.parsed.symbol}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`tag ${st.cls}`} title={st.title}>
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {sigFeed.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No signals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ListenerHealth />

      <div className="panel">
        <h2>Cumulative PnL</h2>
        {equityData.length === 0 ? (
          <div className="empty">No closed trades yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={equityData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
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
              <Area type="monotone" dataKey="pnl" stroke="#3b82f6" fill="url(#pnlFill)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {stats.riskAudit.blocked > 0 && (
        <div className="panel">
          <h2>Risk classification audit (blocked red signals)</h2>
          <div className="kpi-grid" style={{ marginBottom: 8 }}>
            <Kpi label="Reds blocked" value={String(stats.riskAudit.blocked)} />
            <Kpi label="Resolved" value={String(stats.riskAudit.resolved)} />
            <Kpi
              label="Would have lost"
              value={`${stats.riskAudit.wouldLose}/${stats.riskAudit.resolved}`}
            />
            <Kpi
              label="PnL avoided"
              value={usd(stats.riskAudit.avoidedPnl)}
              cls={pnlClass(stats.riskAudit.avoidedPnl)}
            />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {stats.riskAudit.avoidedPnl >= 0
              ? "Blocking red trades has saved money — the classification is paying off."
              : "Blocked reds would have been profitable — consider loosening the filter."}
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="panel">
          <h2>Performance by Group</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Trades</th>
                  <th>Win %</th>
                  <th>PnL</th>
                  <th>PF</th>
                </tr>
              </thead>
              <tbody>
                {stats.byGroup.map((g) => (
                  <tr key={g.groupId}>
                    <td>{g.groupName}</td>
                    <td>{g.stats.trades}</td>
                    <td>{pct(g.stats.winRate)}</td>
                    <td className={pnlClass(g.stats.realizedPnl)}>{usd(g.stats.realizedPnl)}</td>
                    <td>
                      {Number.isFinite(g.stats.profitFactor)
                        ? g.stats.profitFactor.toFixed(2)
                        : "∞"}
                    </td>
                  </tr>
                ))}
                {stats.byGroup.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      No groups yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h2>Group PnL</h2>
          {groupData.length === 0 ? (
            <div className="empty">—</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={groupData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232838" />
                <XAxis dataKey="name" stroke="#8b93a7" fontSize={11} />
                <YAxis stroke="#8b93a7" fontSize={11} width={60} />
                <Tooltip
                  contentStyle={{ background: "#131722", border: "1px solid #232838" }}
                  formatter={(v: number) => usd(v)}
                  cursor={{ fill: "#1a1f2e" }}
                />
                <Bar dataKey="pnl">
                  {groupData.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? "#22c55e" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
