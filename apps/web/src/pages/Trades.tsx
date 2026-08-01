import { useState } from "react";
import type { Trade } from "@tttrading/shared";
import { api } from "../api.js";
import { num, pnlClass, shortTime, usd } from "../format.js";
import { RiskDot } from "../components/Risk.js";

type Filter = "all" | "open" | "closed" | "shadow";

export function Trades({ trades, onChange }: { trades: Trade[]; onChange: () => void }) {
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
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Trades</h1>
        <div className="btn-row">
          {(["all", "open", "closed", "shadow"] as const).map((f) => (
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
                    {t.shadow && (
                      <span className="tag" title="Blocked red signal (not a real position)" style={{ marginLeft: 6 }}>
                        shadow
                      </span>
                    )}
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
                  <td>{t.exitPrice !== undefined ? num(t.exitPrice) : "—"}</td>
                  <td className={pnlClass(t.realizedPnl)}>
                    {t.realizedPnl !== undefined ? usd(t.realizedPnl) : "—"}
                  </td>
                  <td>
                    <span className={`tag ${t.status}`}>{t.status}</span>
                  </td>
                  <td>
                    {t.status === "open" && !t.shadow && (
                      <button disabled={busyId === t.id} onClick={() => close(t.id)}>
                        {busyId === t.id ? "…" : "Close"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={14} className="empty">
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
