import { useEffect, useState } from "react";
import { api } from "../api.js";
import { usd } from "../format.js";

interface Settings {
  tradingPaused: boolean;
  dailyLossLimitUsd: number;
  maxOpenTrades: number;
  maxExposureUsd: number;
}

export function RiskControls() {
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ready, setReady] = useState<Awaited<ReturnType<typeof api.readiness>> | null>(null);

  const load = () =>
    api.getSettings().then((d) =>
      setS({
        tradingPaused: d.tradingPaused,
        dailyLossLimitUsd: d.dailyLossLimitUsd,
        maxOpenTrades: d.maxOpenTrades,
        maxExposureUsd: d.maxExposureUsd,
      }),
    );
  useEffect(() => {
    void load();
    api.readiness().then(setReady).catch(() => {});
  }, []);

  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.updateSettings(patch);
      await load();
      setMsg("Saved.");
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const kill = async () => {
    if (!confirm("KILL-SWITCH: close ALL open positions and pause trading now?")) return;
    setBusy(true);
    try {
      const r = await api.killSwitch();
      setMsg(`Kill-switch: closed ${r.closed} trades, trading paused.`);
      await load();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;

  return (
    <div className="panel">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Risk &amp; safety</h2>
        <div className="btn-row" style={{ alignItems: "center" }}>
          {s.tradingPaused && <span className="tag pending">PAUSED</span>}
          <button
            className={s.tradingPaused ? "primary" : "ghost"}
            disabled={busy}
            onClick={() => void save({ tradingPaused: !s.tradingPaused })}
          >
            {s.tradingPaused ? "Resume trading" : "Pause new entries"}
          </button>
          <button className="danger" disabled={busy} onClick={() => void kill()}>
            🛑 Kill-switch
          </button>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Auto-pause new entries when a limit is hit (0 = off). Existing positions keep running.
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Daily loss limit (USDC)</label>
          <input
            type="number"
            min={0}
            defaultValue={s.dailyLossLimitUsd}
            onBlur={(e) => void save({ dailyLossLimitUsd: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Max open trades</label>
          <input
            type="number"
            min={0}
            defaultValue={s.maxOpenTrades}
            onBlur={(e) => void save({ maxOpenTrades: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Max exposure (USDC notional)</label>
          <input
            type="number"
            min={0}
            defaultValue={s.maxExposureUsd}
            onBlur={(e) => void save({ maxExposureUsd: Number(e.target.value) })}
          />
        </div>
      </div>

      {ready && (
        <div style={{ marginTop: 6 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Readiness ({ready.env}
            {ready.accountValue !== undefined ? ` · ${usd(ready.accountValue)}` : ""}):{" "}
            <strong className={ready.ready ? "pos" : "warn"}>
              {ready.ready ? "ready" : "not ready"}
            </strong>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {ready.checks.map((c) => (
              <span key={c.key} style={{ fontSize: 12 }} className={c.ok ? "pos" : "neg"}>
                {c.ok ? "✓" : "✗"} {c.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="ghost" onClick={() => api.downloadBackup().catch((e) => alert(String(e)))}>
          Download DB backup
        </button>
        {msg && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{msg}</span>}
      </div>
    </div>
  );
}
