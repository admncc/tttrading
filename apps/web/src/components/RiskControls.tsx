import { useEffect, useState } from "react";
import { api } from "../api.js";
import { usd } from "../format.js";

interface Settings {
  tradingPaused: boolean;
  dailyLossLimitUsd: number;
  maxOpenTrades: number;
  maxExposureUsd: number;
  liveMaxOrderUsd: number;
  splitOpposingVenues: boolean;
  isolateSameCoinVenues: boolean;
}

export function RiskControls() {
  const [s, setS] = useState<Settings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ready, setReady] = useState<Awaited<ReturnType<typeof api.readiness>> | null>(null);

  const load = () =>
    api
      .getSettings()
      .then((d) => {
        setS({
          tradingPaused: d.tradingPaused,
          dailyLossLimitUsd: d.dailyLossLimitUsd,
          maxOpenTrades: d.maxOpenTrades,
          maxExposureUsd: d.maxExposureUsd,
          liveMaxOrderUsd: d.liveMaxOrderUsd,
          splitOpposingVenues: d.splitOpposingVenues,
          isolateSameCoinVenues: d.isolateSameCoinVenues,
        });
        setLoadErr(null);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
    api.readiness().then(setReady).catch(() => {});
  }, []);

  const save = async (patch: Partial<Settings>) => {
    // Drop non-finite numbers (e.g. an emptied field blurring to NaN) so we
    // never POST NaN — the field re-reads the server-normalized value on reload.
    for (const k of Object.keys(patch) as (keyof Settings)[]) {
      const v = patch[k];
      if (typeof v === "number" && !Number.isFinite(v)) delete patch[k];
    }
    if (Object.keys(patch).length === 0) return;
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
      setMsg(`Kill-switch: closed ${r.closed} positions, canceled ${r.canceled} working orders, trading paused.`);
      await load();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  if (!s) {
    if (loadErr) {
      return (
        <div className="panel">
          <div className="row-between">
            <h2 style={{ margin: 0 }}>Risk &amp; safety</h2>
            <button className="danger" disabled={busy} onClick={() => void kill()}>
              🛑 Kill-switch
            </button>
          </div>
          <div className="neg" style={{ fontSize: 12, marginTop: 8 }}>
            Could not load settings: {loadErr}{" "}
            <button className="ghost" onClick={() => void load()}>Retry</button>
          </div>
        </div>
      );
    }
    return null;
  }

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
        <div className="field">
          <label title="Caps the size of any REAL order (HL mainnet, Aster, MEXC). Testnet/paper are exempt.">
            Live order cap (USDC) {s.liveMaxOrderUsd > 0 && <span className="tag pending">on</span>}
          </label>
          <input
            type="number"
            min={0}
            defaultValue={s.liveMaxOrderUsd}
            onBlur={(e) => void save({ liveMaxOrderUsd: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        <strong>Live order cap</strong> clamps the notional of any <em>real</em> order (HL mainnet,
        Aster, MEXC) down to this value — testnet/paper/shadow orders are unaffected. Set a small
        number (e.g. 50) to validate mainnet, then raise or zero it. It only ever lowers a group's
        size, never raises it.
      </div>

      <label className="muted" style={{ fontSize: 12, display: "inline-flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={s.splitOpposingVenues}
          disabled={busy}
          onChange={(e) => void save({ splitOpposingVenues: e.target.checked })}
        />
        Route opposing signals to a backup venue (long on primary, opposite short on Aster/MEXC) instead of netting
      </label>

      <label className="muted" style={{ fontSize: 12, display: "inline-flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={s.isolateSameCoinVenues}
          disabled={busy}
          onChange={(e) => void save({ isolateSameCoinVenues: e.target.checked })}
        />
        Isolate same-coin trades from different traders on separate venues (avoids shared/netted positions where one trader's close flattens another's)
      </label>

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
