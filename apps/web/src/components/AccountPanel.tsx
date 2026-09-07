import { useEffect, useState } from "react";
import { api, type AccountInfo } from "../api.js";
import { num, usd } from "../format.js";

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** v2 PnL color class (never rely on old .pos/.neg). */
function pnlCls(n: number | undefined): string {
  if (n === undefined || n === 0) return "";
  return n > 0 ? "gain" : "loss";
}

function SyncIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
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
  // Enabled venues + which one the test order targets, and the global test switch.
  const [venues, setVenues] = useState<{ name: string; live: boolean }[]>([]);
  const [shadow, setShadow] = useState(false);
  const [toVenue, setToVenue] = useState("");

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
  useEffect(() => {
    let alive = true;
    const run = () =>
      api
        .health()
        .then((h) => {
          if (!alive) return;
          setVenues(h.exchanges);
          setShadow(h.shadowMode);
          setToVenue((cur) => cur || h.exchanges.find((v) => v.live)?.name || h.exchanges[0]?.name || "");
        })
        .catch(() => {});
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
    const usdSize = Number(toUsd);
    const lev = Number(toLev);
    const sym = toSymbol.trim().toUpperCase();
    if (!sym) return setToMsg("Enter a symbol.");
    if (!Number.isFinite(usdSize) || usdSize <= 0) return setToMsg("Enter a valid USDC size.");
    if (!Number.isFinite(lev) || lev < 1) return setToMsg("Leverage must be ≥ 1.");
    if (!toVenue) return setToMsg("Pick a venue.");
    const venueLive = !!venues.find((v) => v.name === toVenue)?.live;
    const real = venueLive && !shadow;
    const warn = real
      ? `Place a REAL ${toSide} order: ${usdSize} USDC ${sym} at ${lev}x on ${toVenue}?`
      : `Place a SIMULATED ${toSide} order (${shadow ? "test mode on" : "venue not live"}): ${usdSize} USDC ${sym} at ${lev}x on ${toVenue}?`;
    if (!confirm(warn)) return;
    setToBusy(true);
    setToMsg(null);
    try {
      const t = await api.testOrder(sym, toSide, usdSize, lev, toVenue);
      setToMsg(`Order placed on ${toVenue}: ${toSide} ${sym} @ ${t.entryPrice}${t.simulated ? " (simulated)" : ""}. See the Trades tab to manage/close it.`);
      await load();
    } catch (e) {
      setToMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setToBusy(false);
    }
  };

  // Test order — targets ANY enabled venue. Extracted so it renders even when
  // the HL account read fails (a backup venue can still be exercised).
  const testOrderBlock = (
    <div className="mt12">
      <div className="hr" />
      <div className="hint mb8">
        Place a one-off <strong>test order</strong> on any enabled venue. It appears in the Trades
        tab and can be closed there. Min order value is ~$10, so use ≥ 12 USDC.{" "}
        {(() => {
          const v = venues.find((x) => x.name === toVenue);
          const real = !!v?.live && !shadow;
          return real ? (
            <span className="tag executed">will be a REAL order on {toVenue}</span>
          ) : (
            <span className="tag pending">
              will be SIMULATED ({shadow ? "test mode on" : "venue not live"})
            </span>
          );
        })()}
      </div>
      <div className="btn-row">
        <select
          className="input"
          style={{ maxWidth: 180 }}
          value={toVenue}
          onChange={(e) => setToVenue(e.target.value)}
        >
          {venues.length === 0 && <option value="">(no enabled venue)</option>}
          {venues.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
              {v.live ? "" : " (sim)"}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ maxWidth: 90 }}
          placeholder="Symbol"
          value={toSymbol}
          onChange={(e) => setToSymbol(e.target.value)}
        />
        <input
          className="input num"
          style={{ maxWidth: 110 }}
          type="number"
          min={1}
          placeholder="USDC"
          value={toUsd}
          onChange={(e) => setToUsd(e.target.value)}
        />
        <input
          className="input num"
          style={{ maxWidth: 90 }}
          type="number"
          min={1}
          placeholder="Lev x"
          value={toLev}
          onChange={(e) => setToLev(e.target.value)}
        />
        <select
          className="input"
          style={{ maxWidth: 130 }}
          value={toSide}
          onChange={(e) => setToSide(e.target.value as "long" | "short")}
        >
          <option value="long">Buy / long</option>
          <option value="short">Sell / short</option>
        </select>
        <button className="btn primary sm" disabled={toBusy || !toVenue} onClick={() => void placeTest()}>
          {toBusy ? "Placing…" : "Place test order"}
        </button>
        {toMsg && <span className="muted small">{toMsg}</span>}
      </div>
    </div>
  );

  if (!a) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2>
            Account<span className="sub">account read unavailable</span>
          </h2>
        </div>
        <div className="panel-body">{testOrderBlock}</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Account<span className="sub">{a.env}</span>
        </h2>
        <div className="actions">
          <span className={`tag ${a.connected ? "ok" : "neutral"}`}>
            {a.connected ? "Connected" : "Not connected"}
          </span>
          {a.simulating && a.connected && (
            <span className="tag pending" title="Global test mode is on — no real orders are sent">
              TEST MODE
            </span>
          )}
          <button className="btn ghost sm" disabled={busy} onClick={() => void load()}>
            <SyncIcon />
            Sync
          </button>
        </div>
      </div>

      <div className="panel-body">
        <div className="between mb12">
          <div className="flex">
            <span className={`dot ${a.connected ? "live" : "sim"}`} />
            <span className="small muted" title={a.address ?? ""}>
              {a.connected ? "" : "Simulated · "}
              {a.address ? shortAddr(a.address) : "no address"}
              {a.signer && (
                <>
                  {" · signs as "}
                  {shortAddr(a.signer)}
                  {a.address && a.signer.toLowerCase() !== a.address.toLowerCase() ? " (agent)" : ""}
                </>
              )}
            </span>
          </div>
        </div>

        {testOrderBlock}

        {!a.connected ? (
          <div className="hint mt12">
            No Hyperliquid signing key — HL orders simulate at the live price. Other enabled venues
            (Aster/MEXC) can still trade if their keys are set. Add HL keys in Settings → Exchanges.
          </div>
        ) : (
          <>
            <div className="hr" />
            <div className="stat-grid mb16">
              <div className="stat">
                <span className="caps">Account value</span>
                <span className="v num">{usd(a.accountValue)}</span>
              </div>
              <div className="stat">
                <span className="caps">Withdrawable</span>
                <span className="v num">{usd(a.withdrawable)}</span>
              </div>
              <div className="stat">
                <span className="caps">Margin used</span>
                <span className="v num">{usd(a.totalMarginUsed)}</span>
              </div>
              <div className="stat">
                <span className="caps">Spot USDC</span>
                <span className="v num">{usd(a.spotUsdc)}</span>
              </div>
            </div>

            {a.error && (
              <div className="loss small mb12">Could not read account: {a.error}</div>
            )}

            <div className="hint mb8">
              Move collateral between spot and the perps account. Perp trading uses the{" "}
              <strong>Perps</strong> balance.
            </div>
            <div className="btn-row mb16">
              <div className="input-group" style={{ maxWidth: 200 }}>
                <input
                  className="input num"
                  type="number"
                  min={0}
                  placeholder="Amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <span className="addon">USDC</span>
              </div>
              <button
                className="btn primary sm"
                disabled={busy}
                onClick={() => void move(true)}
                title="Fund perp trading"
              >
                {busy ? "…" : "Spot → Perps"}
              </button>
              <button className="btn ghost sm" disabled={busy} onClick={() => void move(false)}>
                Perps → Spot
              </button>
              {a.spotUsdc !== undefined && a.spotUsdc > 0 && (
                <button
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => setAmount(String(Math.floor(a.spotUsdc!)))}
                  title="Fill with your full spot balance"
                >
                  Max
                </button>
              )}
              {msg && <span className="muted small">{msg}</span>}
            </div>

            {a.positions.length > 0 && (
              <>
                <div className="caps mb8">Live positions · {a.positions.length}</div>
                <div className="table-scroll">
                  <table className="table compact mini">
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th className="num">Size</th>
                        <th className="num">Entry</th>
                        <th className="num">uPnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.positions.map((p) => {
                        const long = p.size >= 0;
                        return (
                          <tr key={p.symbol}>
                            <td>
                              <span className="sym">
                                <span className="coin">{p.symbol.slice(0, 3).toUpperCase()}</span>
                                <span>
                                  {p.symbol}
                                  <span className="sub">
                                    <span className={long ? "gain" : "loss"}>
                                      {long ? "↗ long" : "↘ short"}
                                    </span>{" "}
                                    · {p.leverage}x
                                  </span>
                                </span>
                              </span>
                            </td>
                            <td className="num">{num(Math.abs(p.size))}</td>
                            <td className="num">{num(p.entryPrice)}</td>
                            <td className="num">
                              <span className={`num ${pnlCls(p.unrealizedPnl)}`}>
                                {usd(p.unrealizedPnl)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
