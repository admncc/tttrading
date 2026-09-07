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
import { AccountPanel } from "../components/AccountPanel.js";
import { RiskControls } from "../components/RiskControls.js";

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
        ? { label: "SIMULATED", cls: "pending", title: "Test mode — no real order sent" }
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
  prices,
}: {
  stats: DashboardStats | null;
  signals: Signal[];
  trades: Trade[];
  prices: Record<string, number>;
}) {
  if (!stats) return <div className="empty">Loading…</div>;
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
  const openMargin = trades
    .filter((t) => t.status === "open" && !t.shadow)
    .reduce((s, t) => s + marginOf(remainingSize(t) * t.entryPrice, t.leverage), 0);
  const workingMargin = workingList.reduce((s, t) => s + marginOf(t.notionalUsd, t.leverage), 0);

  // Live unrealized PnL across open (non-shadow) trades from current marks.
  const openTrades = trades.filter((t) => t.status === "open" && !t.shadow);
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
        {o.bankedOpenPnl !== 0 && (
          <Kpi
            label="Banked (open partials)"
            value={usd(o.bankedOpenPnl)}
            cls={pnlClass(o.bankedOpenPnl)}
          />
        )}
        <Kpi label="Win Rate" value={pct(o.winRate)} />
        <Kpi label="Trades" value={String(o.trades)} />
        <Kpi label="Open" value={String(o.openTrades)} />
        <Kpi label="Working orders" value={String(workingCount)} />
        <Kpi label="Margin — open" value={usd(openMargin)} />
        <Kpi label="Margin — working" value={usd(workingMargin)} />
        <Kpi
          label="Open uPnL"
          value={marked > 0 ? usd(openUpnl) : "—"}
          cls={marked > 0 ? pnlClass(openUpnl) : ""}
        />
        <Kpi
          label="Profit Factor"
          value={Number.isNaN(o.profitFactor) ? "—" : Number.isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : "∞"}
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

      <AccountPanel />

      <RiskControls />

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
      </div>
    </div>
  );
}
