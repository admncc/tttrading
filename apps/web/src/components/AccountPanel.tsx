import { useEffect, useState } from "react";
import { api, type AccountInfo } from "../api.js";
import { num, pnlClass, usd } from "../format.js";

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function AccountPanel() {
  const [a, setA] = useState<AccountInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.account().then((d) => alive && setA(d)).catch(() => {});
    void load();
    const poll = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, []);

  if (!a) return null;

  return (
    <div className="panel">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Exchange connection</h2>
        <span style={{ fontSize: 12 }}>
          <span className={`dot ${a.connected ? "live" : "sim"}`} />
          {a.connected ? "Connected" : "Not connected — simulated"}
          <span className="muted"> · {a.env}</span>
          {a.simulating && a.connected && (
            <span className="tag pending" style={{ marginLeft: 8 }} title="Global test mode is on — no real orders are sent">
              TEST MODE
            </span>
          )}
        </span>
      </div>

      {!a.connected ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No signing key configured — orders are simulated at the live price. Add
          <code> HL_PRIVATE_KEY</code> and <code>HL_ACCOUNT_ADDRESS</code> to connect.
        </div>
      ) : (
        <>
          <div className="kpi-grid" style={{ marginBottom: a.positions.length ? 16 : 0 }}>
            <div className="kpi">
              <div className="label">Account</div>
              <div className="value" style={{ fontSize: 15 }} title={a.address ?? ""}>
                {a.address ? shortAddr(a.address) : "—"}
              </div>
            </div>
            <div className="kpi">
              <div className="label">Perps equity</div>
              <div className="value">{a.accountValue !== undefined ? usd(a.accountValue) : "—"}</div>
            </div>
            <div className="kpi">
              <div className="label">Spot / unified USDC</div>
              <div className="value">{a.spotUsdc !== undefined ? usd(a.spotUsdc) : "—"}</div>
            </div>
            <div className="kpi">
              <div className="label">Margin used</div>
              <div className="value">
                {a.totalMarginUsed !== undefined ? usd(a.totalMarginUsed) : "—"}
              </div>
            </div>
          </div>

          {a.error && (
            <div className="neg" style={{ fontSize: 12, marginBottom: 8 }}>
              Could not read account: {a.error}
            </div>
          )}

          {a.positions.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Entry</th>
                    <th>uPnL</th>
                    <th>Lev</th>
                  </tr>
                </thead>
                <tbody>
                  {a.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td>{p.symbol}</td>
                      <td>
                        <span className={`tag ${p.size >= 0 ? "long" : "short"}`}>
                          {p.size >= 0 ? "long" : "short"}
                        </span>
                      </td>
                      <td>{num(Math.abs(p.size))}</td>
                      <td>{num(p.entryPrice)}</td>
                      <td className={pnlClass(p.unrealizedPnl)}>{usd(p.unrealizedPnl)}</td>
                      <td>{p.leverage}x</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
