import { useEffect, useState } from "react";
import { api, type AccountInfo } from "../api.js";
import { num, pnlClass, usd } from "../format.js";

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function AccountPanel() {
  const [a, setA] = useState<AccountInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Test order inputs (defaults: ETH, 10 USDC, 4x).
  const [toSymbol, setToSymbol] = useState("ETH");
  const [toUsd, setToUsd] = useState("15");
  const [toLev, setToLev] = useState("4");
  const [toSide, setToSide] = useState<"long" | "short">("long");
  const [toBusy, setToBusy] = useState(false);
  const [toMsg, setToMsg] = useState<string | null>(null);

  const load = () => api.account().then(setA).catch(() => {});
  useEffect(() => {
    let alive = true;
    const run = () => api.account().then((d) => alive && setA(d)).catch(() => {});
    void run();
    const poll = setInterval(run, 20_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, []);

  const move = async (toPerp: boolean) => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg("Enter a positive amount.");
      return;
    }
    const dir = toPerp ? "Spot → Perps" : "Perps → Spot";
    if (!confirm(`Transfer ${amt} USDC (${dir})? This is a real ${a?.env} transfer.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.transferUsd(amt, toPerp);
      setMsg(`Transferred ${amt} USDC (${dir}).`);
      setAmount("");
      await load();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const placeTest = async () => {
    const usd = Number(toUsd);
    const lev = Number(toLev);
    const sym = toSymbol.trim().toUpperCase();
    if (!sym) return setToMsg("Enter a symbol.");
    if (!Number.isFinite(usd) || usd <= 0) return setToMsg("Enter a valid USDC size.");
    if (!Number.isFinite(lev) || lev < 1) return setToMsg("Leverage must be ≥ 1.");
    const real = a && !a.simulating;
    const warn = real
      ? `Place a REAL ${toSide} order: ${usd} USDC ${sym} at ${lev}x on ${a?.env}?`
      : `Place a SIMULATED ${toSide} order (test mode): ${usd} USDC ${sym} at ${lev}x?`;
    if (!confirm(warn)) return;
    setToBusy(true);
    setToMsg(null);
    try {
      const t = await api.testOrder(sym, toSide, usd, lev);
      setToMsg(`Order placed: ${toSide} ${sym} @ ${t.entryPrice}${t.simulated ? " (simulated)" : ""}. See the Trades tab to manage/close it.`);
      await load();
    } catch (e) {
      setToMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setToBusy(false);
    }
  };

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
              <div className="label">Account (reads)</div>
              <div className="value" style={{ fontSize: 15 }} title={a.address ?? ""}>
                {a.address ? shortAddr(a.address) : "—"}
              </div>
              {a.signer && (
                <div
                  className="muted"
                  style={{ fontSize: 11, marginTop: 4 }}
                  title={a.signer}
                >
                  signs as {shortAddr(a.signer)}
                  {a.address && a.signer.toLowerCase() !== a.address.toLowerCase() ? " (agent)" : ""}
                </div>
              )}
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

          <div style={{ marginBottom: a.positions.length ? 16 : 0 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Move collateral between spot and the perps account. Perp trading uses
              the <strong>Perps</strong> balance.
            </div>
            <div className="btn-row" style={{ alignItems: "center" }}>
              <input
                style={{ maxWidth: 160 }}
                type="number"
                min={0}
                placeholder="USDC amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy}
                onClick={() => void move(true)}
                title="Fund perp trading"
              >
                {busy ? "…" : "Spot → Perps"}
              </button>
              <button className="ghost" disabled={busy} onClick={() => void move(false)}>
                Perps → Spot
              </button>
              {a.spotUsdc !== undefined && a.spotUsdc > 0 && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => setAmount(String(Math.floor(a.spotUsdc!)))}
                  title="Fill with your full spot balance"
                >
                  Max
                </button>
              )}
              {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
            </div>
          </div>

          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: 14,
              marginBottom: a.positions.length ? 16 : 0,
            }}
          >
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Place a one-off <strong>test order</strong>. It appears in the Trades tab and can be
              closed there. Hyperliquid requires a minimum order value of ~$10, so use ≥ 12 USDC.{" "}
              {a.simulating ? (
                <span className="tag pending">will be SIMULATED (test mode on)</span>
              ) : (
                <span className="tag executed">will be a REAL {a.env} order</span>
              )}
            </div>
            <div className="btn-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <input
                style={{ maxWidth: 90 }}
                placeholder="Symbol"
                value={toSymbol}
                onChange={(e) => setToSymbol(e.target.value)}
              />
              <input
                style={{ maxWidth: 110 }}
                type="number"
                min={1}
                placeholder="USDC"
                value={toUsd}
                onChange={(e) => setToUsd(e.target.value)}
              />
              <input
                style={{ maxWidth: 90 }}
                type="number"
                min={1}
                placeholder="Lev x"
                value={toLev}
                onChange={(e) => setToLev(e.target.value)}
              />
              <select
                style={{ maxWidth: 110 }}
                value={toSide}
                onChange={(e) => setToSide(e.target.value as "long" | "short")}
              >
                <option value="long">Buy / long</option>
                <option value="short">Sell / short</option>
              </select>
              <button className="primary" disabled={toBusy} onClick={() => void placeTest()}>
                {toBusy ? "Placing…" : "Place test order"}
              </button>
              {toMsg && <span className="muted" style={{ fontSize: 12 }}>{toMsg}</span>}
            </div>
          </div>

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
