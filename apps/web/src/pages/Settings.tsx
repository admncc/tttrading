import { useEffect, useState } from "react";
import { api, type ExchangesConfig, type ExchangesPatch } from "../api.js";

/** A masked secret field: empty means "leave unchanged"; a clear toggle wipes it. */
function SecretField({
  label,
  configured,
  value,
  onChange,
  clear,
  onClear,
  placeholder,
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (v: string) => void;
  clear: boolean;
  onClear: (v: boolean) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        {label}{" "}
        {configured ? (
          <span className="tag pos" style={{ marginLeft: 4 }}>
            configured
          </span>
        ) : (
          <span className="tag" style={{ marginLeft: 4 }}>
            not set
          </span>
        )}
      </div>
      <input
        type="password"
        autoComplete="off"
        value={value}
        disabled={clear}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? (configured ? "•••••••• (leave blank to keep)" : "not set")}
        style={{ width: "100%" }}
      />
      {configured && (
        <label className="muted" style={{ fontSize: 11, display: "inline-flex", gap: 6, marginTop: 4 }}>
          <input type="checkbox" checked={clear} onChange={(e) => onClear(e.target.checked)} /> clear stored value
        </label>
      )}
    </label>
  );
}

function VenueBadge({ live, enabled }: { live: boolean; enabled?: boolean }) {
  const label = live ? "LIVE" : enabled === false ? "off" : "market-data / sim";
  const cls = live ? "live" : enabled === false ? "sim" : "sim";
  return (
    <span className="tag" style={{ marginLeft: 8 }}>
      <span className={`dot ${cls}`} style={{ marginRight: 6 }} />
      {label}
    </span>
  );
}

export function Settings() {
  const [cfg, setCfg] = useState<ExchangesConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // HL
  const [hlKey, setHlKey] = useState("");
  const [hlKeyClear, setHlKeyClear] = useState(false);
  const [hlAddr, setHlAddr] = useState("");
  // Aster
  const [asterEnabled, setAsterEnabled] = useState(false);
  const [asterKey, setAsterKey] = useState("");
  const [asterKeyClear, setAsterKeyClear] = useState(false);
  const [asterSecret, setAsterSecret] = useState("");
  const [asterSecretClear, setAsterSecretClear] = useState(false);
  const [asterBase, setAsterBase] = useState("");
  // MEXC
  const [mexcEnabled, setMexcEnabled] = useState(false);
  const [mexcBase, setMexcBase] = useState("");

  const load = () => {
    api
      .exchanges()
      .then((c) => {
        setCfg(c);
        setHlAddr(c.hyperliquid.accountAddress ?? "");
        setAsterEnabled(c.aster.enabled);
        setAsterBase(c.aster.baseUrl);
        setMexcEnabled(c.mexc.enabled);
        setMexcBase(c.mexc.baseUrl);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    const patch: ExchangesPatch = {
      hyperliquid: {
        ...(hlKeyClear ? { privateKey: "" } : hlKey ? { privateKey: hlKey } : {}),
        accountAddress: hlAddr,
      },
      aster: {
        enabled: asterEnabled,
        baseUrl: asterBase,
        ...(asterKeyClear ? { apiKey: "" } : asterKey ? { apiKey: asterKey } : {}),
        ...(asterSecretClear ? { apiSecret: "" } : asterSecret ? { apiSecret: asterSecret } : {}),
      },
      mexc: { enabled: mexcEnabled, baseUrl: mexcBase },
    };
    try {
      const c = await api.saveExchanges(patch);
      setCfg(c);
      // Reset the secret inputs (values are write-only; never echoed back).
      setHlKey("");
      setHlKeyClear(false);
      setAsterKey("");
      setAsterKeyClear(false);
      setAsterSecret("");
      setAsterSecretClear(false);
      setHlAddr(c.hyperliquid.accountAddress ?? "");
      setMsg("Saved. Keys apply immediately; a restart is not required.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Settings</h1>
        <button className="ghost" onClick={load}>
          Refresh
        </button>
      </div>

      <h2 style={{ marginBottom: 4 }}>Exchanges</h2>
      <p className="muted" style={{ marginTop: 0, maxWidth: 720 }}>
        Keys entered here are stored on the server and take precedence over any set via environment
        variables. Secrets are write-only — they're never sent back to the browser and are stripped
        from backups. Signals route to Hyperliquid first, then to any enabled backup that lists the
        coin. <strong>Test on each venue's testnet before going live.</strong>
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}
      {!cfg ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {/* Hyperliquid */}
          <div className="panel">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>
                Hyperliquid <span className="muted" style={{ fontSize: 12 }}>· primary</span>
                <VenueBadge live={cfg.hyperliquid.live} />
              </h3>
              <span className="muted" style={{ fontSize: 12 }}>env: {cfg.env}</span>
            </div>
            <SecretField
              label="Private key (API/agent wallet, 0x…)"
              configured={cfg.hyperliquid.privateKeyConfigured}
              value={hlKey}
              onChange={setHlKey}
              clear={hlKeyClear}
              onClear={setHlKeyClear}
            />
            <label style={{ display: "block", marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Account address (master, for reading state — optional)
              </div>
              <input value={hlAddr} onChange={(e) => setHlAddr(e.target.value)} placeholder="0x… (defaults to the signer)" style={{ width: "100%" }} />
            </label>
            {cfg.hyperliquid.signer && (
              <div className="muted" style={{ fontSize: 11 }}>
                Signer address: <code>{cfg.hyperliquid.signer}</code>
              </div>
            )}
          </div>

          {/* Aster */}
          <div className="panel">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>
                Aster <span className="muted" style={{ fontSize: 12 }}>· backup</span>
                <VenueBadge live={cfg.aster.live} enabled={asterEnabled} />
              </h3>
              <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
                <input type="checkbox" checked={asterEnabled} onChange={(e) => setAsterEnabled(e.target.checked)} />
                enabled (route coins not on Hyperliquid)
              </label>
            </div>
            <SecretField
              label="API key"
              configured={cfg.aster.apiKeyConfigured}
              value={asterKey}
              onChange={setAsterKey}
              clear={asterKeyClear}
              onClear={setAsterKeyClear}
            />
            <SecretField
              label="API secret"
              configured={cfg.aster.apiSecretConfigured}
              value={asterSecret}
              onChange={setAsterSecret}
              clear={asterSecretClear}
              onClear={setAsterSecretClear}
            />
            <label style={{ display: "block" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                REST base URL (use the testnet host to validate first)
              </div>
              <input value={asterBase} onChange={(e) => setAsterBase(e.target.value)} placeholder="https://fapi.asterdex.com" style={{ width: "100%" }} />
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Without a key+secret, Aster runs in market-data/simulation mode (routes & tracks, no real orders).
            </div>
          </div>

          {/* MEXC */}
          <div className="panel">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>
                MEXC <span className="muted" style={{ fontSize: 12 }}>· last backup</span>
                <VenueBadge live={false} enabled={mexcEnabled} />
              </h3>
              <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
                <input type="checkbox" checked={mexcEnabled} onChange={(e) => setMexcEnabled(e.target.checked)} />
                enabled
              </label>
            </div>
            <label style={{ display: "block" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>REST base URL</div>
              <input value={mexcBase} onChange={(e) => setMexcBase(e.target.value)} placeholder="https://contract.mexc.com" style={{ width: "100%" }} />
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {cfg.mexc.note}. MEXC-only coins are routed and tracked as simulated trades so they aren't
              silently dropped; real order execution is a separate, validated step.
            </div>
          </div>

          <div className="btn-row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save exchange settings"}
            </button>
            {msg && <span className="muted" style={{ alignSelf: "center" }}>{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
