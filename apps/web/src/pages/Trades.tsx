import { useState } from "react";
import type { Trade } from "@tttrading/shared";
import { api } from "../api.js";
import { num, pnlClass, shortTime, usd } from "../format.js";
import { RiskDot } from "../components/Risk.js";

type Filter = "all" | "working" | "open" | "closed" | "shadow";

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
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const shown = trades.filter((t) =>
    filter === "shadow"
      ? t.shadow
      : !t.shadow && (filter === "all" ? true : t.status === filter),
  );

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

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Trades</h1>
        <div className="btn-row">
          {(["all", "working", "open", "closed", "shadow"] as const).map((f) => (
            <button
              key={f}
              className={filter === f ? "primary" : "ghost"}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
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
                <tr key={t.id}>
                  <td className="muted">{shortTime(t.openedAt)}</td>
                  <td>{t.groupName}</td>
                  <td>
                    <RiskDot risk={t.risk} />
                  </td>
                  <td>
                    {t.symbol}
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
                    {(t.status === "open" || t.status === "working") && !t.shadow && (
                      <button disabled={busyId === t.id} onClick={() => close(t.id)}>
                        {busyId === t.id ? "…" : t.status === "working" ? "Cancel" : "Close"}
                      </button>
                    )}
                  </td>
                </tr>
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
