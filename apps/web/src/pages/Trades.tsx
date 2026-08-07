import { Fragment, useMemo, useState } from "react";
import type { Trade, TradeStatus } from "@tttrading/shared";
import { api } from "../api.js";
import { num, pnlClass, shortTime, usd } from "../format.js";
import { RiskDot } from "../components/Risk.js";

type StatusChip = TradeStatus | "shadow";
const STATUS_CHIPS: StatusChip[] = ["open", "working", "closed", "failed", "canceled", "shadow"];

/** Net PnL already realized from partial exits (gross banked minus banked fees). */
function netBanked(t: Trade): number | undefined {
  if (t.bankedPnl === undefined && t.bankedFees === undefined) return undefined;
  return (t.bankedPnl ?? 0) - (t.bankedFees ?? 0);
}

/** Live unrealized PnL for an open trade from the current mark price. */
function unrealized(t: Trade, mark: number | undefined): number | undefined {
  if (t.status !== "open" || !mark || mark <= 0) return undefined;
  const dir = t.side === "long" ? 1 : -1;
  return (mark - t.entryPrice) * dir * t.size + (netBanked(t) ?? 0);
}

export function Trades({
  trades,
  prices,
  onChange,
}: {
  trades: Trade[];
  prices: Record<string, number>;
  onChange: () => void;
}) {
  const [statuses, setStatuses] = useState<Set<StatusChip>>(new Set(["open", "working"]));
  const [group, setGroup] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [bookInput, setBookInput] = useState("");

  const toggleStatus = (s: StatusChip) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const groupOpts = useMemo(() => [...new Set(trades.map((t) => t.groupName))].sort(), [trades]);

  const matchStatus = (t: Trade) => {
    if (statuses.size === 0) return !t.shadow; // no chip selected → all real trades
    if (t.shadow) return statuses.has("shadow");
    return statuses.has(t.status);
  };
  const shown = trades.filter((t) => matchStatus(t) && (group === "all" || t.groupName === group));

  const close = async (id: string) => {
    setBusyId(id);
    try {
      await api.closeTrade(id);
      onChange();
    } catch (e) {
      alert(`Close failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const sync = async (t: Trade) => {
    setBusyId(t.id);
    try {
      const res = await api.syncTrade(t.id);
      const on = res.venue ? ` on ${res.venue}` : "";
      if (res.changed) alert(`${t.symbol}: still live${on} — reopened${res.venue && res.venue !== t.exchange ? ` and re-homed to ${res.venue}` : ""} in the desk.`);
      else if (res.live) alert(`${t.symbol}: position confirmed live${on}.`);
      else alert(`${t.symbol}: no matching position on any connected venue — leaving as is.`);
      onChange();
    } catch (e) {
      alert(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const toggleManage = (t: Trade) => {
    if (manageId === t.id) {
      setManageId(null);
      return;
    }
    setManageId(t.id);
    setSlInput(t.stopLoss ? String(t.stopLoss) : "");
    setTpInput(t.takeProfits?.length ? t.takeProfits.join(", ") : "");
    setBookInput("");
  };

  const run = async (id: string, fn: () => Promise<unknown>, label: string) => {
    setBusyId(id);
    try {
      await fn();
      onChange();
    } catch (e) {
      alert(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const setStop = (t: Trade) => {
    const p = Number(slInput);
    if (!(p > 0)) return alert("Enter a valid stop price.");
    void run(t.id, () => api.setTradeStop(t.id, p), "Set SL");
  };
  const setTps = (t: Trade) => {
    const prices = tpInput
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    void run(t.id, () => api.setTradeTakeProfits(t.id, prices), "Set TPs");
  };
  const book = (t: Trade) => {
    const pct = Number(bookInput);
    if (!(pct > 0 && pct < 100)) return alert("Enter a percent between 0 and 100.");
    void run(t.id, () => api.bookPartial(t.id, pct / 100), "Book");
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Trades</h1>
      </div>

      <div className="panel" style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Status (multi-select)</div>
          <div className="btn-row">
            {STATUS_CHIPS.map((s) => (
              <button key={s} className={statuses.has(s) ? "primary" : "ghost"} onClick={() => toggleStatus(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <label>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Channel / group</div>
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ width: "auto", minWidth: 170 }}>
            <option value="all">All channels</option>
            {groupOpts.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{shown.length} shown</span>
        {(statuses.size !== 2 || !statuses.has("open") || !statuses.has("working") || group !== "all") && (
          <button className="ghost" onClick={() => { setStatuses(new Set(["open", "working"])); setGroup("all"); }}>Reset</button>
        )}
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Opened</th>
                <th>Group</th>
                <th>Risk</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Lev</th>
                <th>Notional</th>
                <th>Size</th>
                <th>Entry</th>
                <th>SL / TP</th>
                <th>Mark</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <Fragment key={t.id}>
                <tr>
                  <td className="muted">{shortTime(t.openedAt)}</td>
                  <td>{t.groupName}</td>
                  <td>
                    <RiskDot risk={t.risk} />
                  </td>
                  <td>
                    {t.symbol}
                    {t.exchange && t.exchange !== "hyperliquid" ? (
                      <span
                        className="tag"
                        title={`Executed on ${t.exchange}`}
                        style={{ marginLeft: 6, textTransform: "capitalize" }}
                      >
                        {t.exchange}
                      </span>
                    ) : null}
                    {t.shadow ? (
                      <span className="tag" title="Blocked red signal (not a real position)" style={{ marginLeft: 6 }}>
                        shadow
                      </span>
                    ) : t.simulated ? (
                      <span className="tag pending" title="Simulated (test mode) — no real order" style={{ marginLeft: 6 }}>
                        sim
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={`tag ${t.side}`}>{t.side}</span>
                  </td>
                  <td>{t.leverage}x</td>
                  <td>{usd(t.notionalUsd, 0)}</td>
                  <td>{num(t.size)}</td>
                  <td>{num(t.entryPrice)}</td>
                  <td>
                    {t.stopLoss === undefined && !t.takeProfits?.length ? (
                      <span className="muted">—</span>
                    ) : (
                      <span>
                        {t.bracketProtected && (
                          <span title="SL/TP live on exchange" style={{ marginRight: 4 }}>
                            🛡
                          </span>
                        )}
                        {t.slMovedToBreakeven && (
                          <span
                            className="tag"
                            title="Stop-loss moved to break-even"
                            style={{ marginRight: 4 }}
                          >
                            BE
                          </span>
                        )}
                        <span className="neg">{t.stopLoss ? num(t.stopLoss) : "—"}</span>
                        <span className="muted"> / </span>
                        <span className="pos">
                          {t.takeProfits?.length ? t.takeProfits.map((x) => num(x)).join(",") : "—"}
                        </span>
                        {t.takeProfits?.length && (t.tpFilledCount ?? 0) > 0 ? (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {" "}
                            ({t.tpFilledCount}/{t.takeProfits.length} hit)
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {t.status === "open" && prices[t.symbol.toUpperCase()] ? num(prices[t.symbol.toUpperCase()]) : "—"}
                  </td>
                  <td>{t.exitPrice !== undefined ? num(t.exitPrice) : "—"}</td>
                  <td className={pnlClass(t.realizedPnl ?? unrealized(t, prices[t.symbol.toUpperCase()]) ?? netBanked(t))}>
                    {t.realizedPnl !== undefined ? (
                      usd(t.realizedPnl)
                    ) : unrealized(t, prices[t.symbol.toUpperCase()]) !== undefined ? (
                      <span title="Live unrealized PnL (incl. banked partials)">
                        {usd(unrealized(t, prices[t.symbol.toUpperCase()])!)}
                        <span className="muted" style={{ fontSize: 11 }}> uPnL</span>
                      </span>
                    ) : netBanked(t) !== undefined ? (
                      <span title="Realized so far from partial exits (position still open)">
                        {usd(netBanked(t)!)}
                        <span className="muted" style={{ fontSize: 11 }}> banked</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className={`tag ${t.status}`}>{t.status}</span>
                  </td>
                  <td>
                    {!t.shadow && !t.simulated && (
                      <div className="btn-row">
                        {(t.status === "open" || t.status === "working") && (
                          <>
                            <button disabled={busyId === t.id} onClick={() => close(t.id)}>
                              {busyId === t.id ? "…" : t.status === "working" ? "Cancel" : "Close"}
                            </button>
                            <button
                              className={manageId === t.id ? "primary" : "ghost"}
                              onClick={() => toggleManage(t)}
                            >
                              Manage
                            </button>
                          </>
                        )}
                        {/* Reconcile against the exchange: if the desk booked it
                            closed but the position is still live (e.g. a false-close
                            after a network switch), Sync reopens it. */}
                        <button
                          className="ghost"
                          disabled={busyId === t.id}
                          title="Check the exchange — reopen if the position is still live"
                          onClick={() => sync(t)}
                        >
                          {busyId === t.id ? "…" : "Sync"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {manageId === t.id && (t.status === "open" || t.status === "working") && !t.shadow && (
                  <tr>
                    <td colSpan={15} style={{ background: "rgba(255,255,255,0.02)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", padding: "4px 2px" }}>
                        <label style={{ fontSize: 12 }}>
                          <div className="muted" style={{ marginBottom: 2 }}>Stop-loss</div>
                          <input
                            value={slInput}
                            onChange={(e) => setSlInput(e.target.value)}
                            placeholder="price"
                            style={{ width: 110 }}
                          />{" "}
                          <button disabled={busyId === t.id} onClick={() => setStop(t)}>Set SL</button>
                        </label>
                        <label style={{ fontSize: 12 }}>
                          <div className="muted" style={{ marginBottom: 2 }}>Take-profits (comma-separated)</div>
                          <input
                            value={tpInput}
                            onChange={(e) => setTpInput(e.target.value)}
                            placeholder="e.g. 65000, 66000"
                            style={{ width: 180 }}
                          />{" "}
                          <button disabled={busyId === t.id} onClick={() => setTps(t)}>Set TPs</button>
                        </label>
                        {t.status === "open" && (
                          <label style={{ fontSize: 12 }}>
                            <div className="muted" style={{ marginBottom: 2 }}>Book %</div>
                            <input
                              value={bookInput}
                              onChange={(e) => setBookInput(e.target.value)}
                              placeholder="e.g. 30"
                              style={{ width: 80 }}
                            />{" "}
                            <button disabled={busyId === t.id} onClick={() => book(t)}>Book</button>
                          </label>
                        )}
                        <span className="muted" style={{ fontSize: 11 }}>
                          {t.status === "working"
                            ? "Resting order — SL/TP are stored and applied on fill."
                            : "Live: SL/TP are placed on the exchange."}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={15} className="empty">
                    No trades.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
