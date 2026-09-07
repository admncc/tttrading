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
  directionalVenueSplit: boolean;
}

/** Full-width octagon icon for the kill-switch. */
function KillIcon() {
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
      <path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
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
          directionalVenueSplit: d.directionalVenueSplit,
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
        <div className="panel danger-zone">
          <div className="panel-head">
            <h2>Risk &amp; safety</h2>
            <div className="actions">
              <button className="btn danger sm" disabled={busy} onClick={() => void kill()}>
                <KillIcon />
                Kill-switch
              </button>
            </div>
          </div>
          <div className="panel-body">
            <div className="error-card">
              <span className="loss small">Could not load settings: {loadErr}</span>
              <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => void load()}>
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          Risk &amp; safety
          {s.tradingPaused && <span className="tag pending">PAUSED</span>}
        </h2>
        <div className="actions">
          <button
            className={`btn sm ${s.tradingPaused ? "primary" : "ghost"}`}
            disabled={busy}
            onClick={() => void save({ tradingPaused: !s.tradingPaused })}
          >
            {s.tradingPaused ? "Resume trading" : "Pause new entries"}
          </button>
        </div>
      </div>

      <div className="panel-body">
        <button className="btn kill" disabled={busy} onClick={() => void kill()}>
          <KillIcon />
          Kill-switch — close all &amp; pause
        </button>

        <div className="hint mt12 mb12">
          Auto-pause new entries when a limit is hit (0 = off). Existing positions keep running.
        </div>

        <div className="form-grid">
          <div className="field">
            <label>Daily loss limit</label>
            <div className="input-group">
              <input
                className="input num"
                type="number"
                min={0}
                defaultValue={s.dailyLossLimitUsd}
                onBlur={(e) => void save({ dailyLossLimitUsd: Number(e.target.value) })}
              />
              <span className="addon">USDC</span>
            </div>
          </div>
          <div className="field">
            <label>Max open trades</label>
            <div className="input-group">
              <input
                className="input num"
                type="number"
                min={0}
                defaultValue={s.maxOpenTrades}
                onBlur={(e) => void save({ maxOpenTrades: Number(e.target.value) })}
              />
              <span className="addon">trades</span>
            </div>
          </div>
          <div className="field">
            <label>Max exposure (notional)</label>
            <div className="input-group">
              <input
                className="input num"
                type="number"
                min={0}
                defaultValue={s.maxExposureUsd}
                onBlur={(e) => void save({ maxExposureUsd: Number(e.target.value) })}
              />
              <span className="addon">USDC</span>
            </div>
          </div>
          <div className="field">
            <label title="Caps the size of any REAL order (HL mainnet, Aster, MEXC). Testnet/paper are exempt.">
              Live order cap {s.liveMaxOrderUsd > 0 && <span className="tag pending">on</span>}
            </label>
            <div className="input-group">
              <input
                className="input num"
                type="number"
                min={0}
                defaultValue={s.liveMaxOrderUsd}
                onBlur={(e) => void save({ liveMaxOrderUsd: Number(e.target.value) })}
              />
              <span className="addon">USDC</span>
            </div>
          </div>
        </div>

        <div className="hint mt12">
          <strong>Live order cap</strong> clamps the notional of any <em>real</em> order (HL mainnet,
          Aster, MEXC) down to this value — testnet/paper/shadow orders are unaffected. Set a small
          number (e.g. 50) to validate mainnet, then raise or zero it. It only ever lowers a group's
          size, never raises it.
        </div>

        <div className="stack mt12" style={{ gap: 10 }}>
          <label className={`check ${s.splitOpposingVenues ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={s.splitOpposingVenues}
              disabled={busy}
              onChange={(e) => void save({ splitOpposingVenues: e.target.checked })}
              style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
            />
            <span className="box" />
            <span className="small">
              Route opposing signals to a backup venue (long on primary, opposite short on
              Aster/MEXC) instead of netting
            </span>
          </label>

          <label className={`check ${s.isolateSameCoinVenues ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={s.isolateSameCoinVenues}
              disabled={busy}
              onChange={(e) => void save({ isolateSameCoinVenues: e.target.checked })}
              style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
            />
            <span className="box" />
            <span className="small">
              Isolate same-coin trades from different traders on separate venues (avoids
              shared/netted positions where one trader's close flattens another's)
            </span>
          </label>

          <label className={`check ${s.directionalVenueSplit ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={s.directionalVenueSplit}
              disabled={busy}
              onChange={(e) => void save({ directionalVenueSplit: e.target.checked })}
              style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
            />
            <span className="box" />
            <span className="small">
              Directional venue split: ALL longs on the primary venue (Hyperliquid), ALL shorts on
              the secondary (Aster) — opposing trader views coexist instead of being rejected
              (overrides the two options above; same-side traders then net on one venue)
            </span>
          </label>
        </div>

        {ready && (
          <div className="mt12">
            <div className="hint mb8">
              Readiness ({ready.env}
              {ready.accountValue !== undefined ? ` · ${usd(ready.accountValue)}` : ""}):{" "}
              <strong className={ready.ready ? "gain" : "warn"}>
                {ready.ready ? "ready" : "not ready"}
              </strong>
            </div>
            <div className="btn-row">
              {ready.checks.map((c) => (
                <span key={c.key} className={`tag ${c.ok ? "ok" : "error"}`}>
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="btn-row mt16">
          <button className="btn ghost sm" onClick={() => api.downloadBackup().catch((e) => alert(String(e)))}>
            Download DB backup
          </button>
          {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
