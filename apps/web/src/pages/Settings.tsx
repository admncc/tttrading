import { useEffect, useState } from "react";
import { api, type ExchangesConfig, type ExchangesPatch, type HlVenue } from "../api.js";

/** Local edit state for one Hyperliquid network venue. */
interface HlEdit {
  key: string;
  clear: boolean;
  addr: string;
  enabled: boolean;
}

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

/** One Hyperliquid network venue (mainnet or testnet) with keys + enable. */
function HlPanel({
  label,
  subtitle,
  venue,
  edit,
  onEdit,
}: {
  label: string;
  subtitle: string;
  venue: HlVenue;
  edit: HlEdit;
  onEdit: (patch: Partial<HlEdit>) => void;
}) {
  return (
    <div className="panel">
      <div className="row-between">
        <h3 style={{ margin: 0 }}>
          {label} <span className="muted" style={{ fontSize: 12 }}>· {subtitle}</span>
          <VenueBadge live={venue.live} enabled={edit.enabled} />
        </h3>
        <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
          <input type="checkbox" checked={edit.enabled} onChange={(e) => onEdit({ enabled: e.target.checked })} />
          enabled
        </label>
      </div>
      <SecretField
        label="Private key (API/agent wallet, 0x…)"
        configured={venue.privateKeyConfigured}
        value={edit.key}
        onChange={(v) => onEdit({ key: v })}
        clear={edit.clear}
        onClear={(v) => onEdit({ clear: v })}
      />
      <label style={{ display: "block", marginBottom: 8 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Account address (master, for reading state — optional)
        </div>
        <input
          value={edit.addr}
          onChange={(e) => onEdit({ addr: e.target.value })}
          placeholder="0x… (defaults to the signer)"
          style={{ width: "100%" }}
        />
      </label>
      {venue.signer && (
        <div className="muted" style={{ fontSize: 11 }}>
          Signer address: <code>{venue.signer}</code>
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const [cfg, setCfg] = useState<ExchangesConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Message-processing priority (LLM vs regex rules).
  const [parseMode, setParseMode] = useState<"regex" | "llm">("regex");
  const [parseBusy, setParseBusy] = useState(false);

  // HL (mainnet + testnet as separate venues)
  const [hlMain, setHlMain] = useState<HlEdit>({ key: "", clear: false, addr: "", enabled: false });
  const [hlTest, setHlTest] = useState<HlEdit>({ key: "", clear: false, addr: "", enabled: false });
  // Aster
  const [asterEnabled, setAsterEnabled] = useState(false);
  const [asterKey, setAsterKey] = useState("");
  const [asterKeyClear, setAsterKeyClear] = useState(false);
  const [asterSecret, setAsterSecret] = useState("");
  const [asterSecretClear, setAsterSecretClear] = useState(false);
  const [asterBase, setAsterBase] = useState("");
  // Routing priority (ordered venue names)
  const [priority, setPriority] = useState<string[]>([]);
  // MEXC
  const [mexcEnabled, setMexcEnabled] = useState(false);
  const [mexcKey, setMexcKey] = useState("");
  const [mexcKeyClear, setMexcKeyClear] = useState(false);
  const [mexcSecret, setMexcSecret] = useState("");
  const [mexcSecretClear, setMexcSecretClear] = useState(false);
  const [mexcBase, setMexcBase] = useState("");

  const load = () => {
    api
      .exchanges()
      .then((c) => {
        setCfg(c);
        setPriority(c.priority);
        setHlMain({ key: "", clear: false, addr: c.hyperliquid.accountAddress ?? "", enabled: c.hyperliquid.enabled });
        setHlTest({ key: "", clear: false, addr: c.hyperliquidTestnet.accountAddress ?? "", enabled: c.hyperliquidTestnet.enabled });
        setAsterEnabled(c.aster.enabled);
        setAsterBase(c.aster.baseUrl);
        setMexcEnabled(c.mexc.enabled);
        setMexcBase(c.mexc.baseUrl);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  useEffect(() => {
    api.getSettings().then((s) => setParseMode(s.parseMode)).catch(() => {});
  }, []);

  const saveParseMode = async (mode: "regex" | "llm") => {
    setParseBusy(true);
    try {
      await api.updateSettings({ parseMode: mode });
      setParseMode(mode);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setParseBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    setErr(null);
    const hlPatch = (e: HlEdit) => ({
      enabled: e.enabled,
      accountAddress: e.addr,
      ...(e.clear ? { privateKey: "" } : e.key ? { privateKey: e.key } : {}),
    });
    const patch: ExchangesPatch = {
      priority,
      hyperliquid: hlPatch(hlMain),
      hyperliquidTestnet: hlPatch(hlTest),
      aster: {
        enabled: asterEnabled,
        baseUrl: asterBase,
        ...(asterKeyClear ? { apiKey: "" } : asterKey ? { apiKey: asterKey } : {}),
        ...(asterSecretClear ? { apiSecret: "" } : asterSecret ? { apiSecret: asterSecret } : {}),
      },
      mexc: {
        enabled: mexcEnabled,
        baseUrl: mexcBase,
        ...(mexcKeyClear ? { apiKey: "" } : mexcKey ? { apiKey: mexcKey } : {}),
        ...(mexcSecretClear ? { apiSecret: "" } : mexcSecret ? { apiSecret: mexcSecret } : {}),
      },
    };
    try {
      const c = await api.saveExchanges(patch);
      setCfg(c);
      // Reset the secret inputs (values are write-only; never echoed back).
      setHlMain({ key: "", clear: false, addr: c.hyperliquid.accountAddress ?? "", enabled: c.hyperliquid.enabled });
      setHlTest({ key: "", clear: false, addr: c.hyperliquidTestnet.accountAddress ?? "", enabled: c.hyperliquidTestnet.enabled });
      setAsterKey("");
      setAsterKeyClear(false);
      setAsterSecret("");
      setAsterSecretClear(false);
      setMexcKey("");
      setMexcKeyClear(false);
      setMexcSecret("");
      setMexcSecretClear(false);
      setMsg("Saved. Keys apply immediately; a restart is not required.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Which Hyperliquid network is currently active (enabled + highest priority).
  const activeHlNetwork = (c: ExchangesConfig): "mainnet" | "testnet" => {
    const rank = (name: string) => {
      const i = c.priority.indexOf(name);
      return i < 0 ? 99 : i;
    };
    const mainOn = c.hyperliquid.enabled;
    const testOn = c.hyperliquidTestnet.enabled;
    if (mainOn && !testOn) return "mainnet";
    if (testOn && !mainOn) return "testnet";
    if (mainOn && testOn) return rank("hyperliquid") <= rank("hyperliquid-testnet") ? "mainnet" : "testnet";
    return "testnet";
  };

  const switchNet = async (network: "mainnet" | "testnet") => {
    if (network === "mainnet") {
      const ok = window.confirm(
        "Switch Hyperliquid to MAINNET?\n\nNew signals will trade with REAL funds. " +
          "Existing testnet positions stay on testnet and keep running there.\n\n" +
          "Make sure the mainnet key is set and the account is funded first.",
      );
      if (!ok) return;
    }
    setSwitching(true);
    setMsg(null);
    setErr(null);
    try {
      const c = await api.setHlNetwork(network);
      setCfg(c);
      setPriority(c.priority);
      setHlMain({ key: "", clear: false, addr: c.hyperliquid.accountAddress ?? "", enabled: c.hyperliquid.enabled });
      setHlTest({ key: "", clear: false, addr: c.hyperliquidTestnet.accountAddress ?? "", enabled: c.hyperliquidTestnet.enabled });
      const liveNow = network === "mainnet" ? c.hyperliquid.live : c.hyperliquidTestnet.live;
      setMsg(
        `Hyperliquid switched to ${network.toUpperCase()}.` +
          (liveNow ? "" : " ⚠️ No key configured — orders on this network will be simulated until you add one."),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  };

  const movePriority = (i: number, dir: -1 | 1) => {
    setPriority((p) => {
      const next = [...p];
      const j = i + dir;
      if (j < 0 || j >= next.length) return p;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Settings</h1>
        <button className="ghost" onClick={load}>
          Refresh
        </button>
      </div>

      <h2 style={{ marginBottom: 4 }}>Message processing</h2>
      <div className="panel">
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          How incoming messages are parsed into signals. The other engine is always used
          as a cross-check — disagreements are logged under Logs → message.
        </div>
        <div className="btn-row">
          <button
            className={parseMode === "regex" ? "primary" : "ghost"}
            disabled={parseBusy}
            onClick={() => void saveParseMode("regex")}
          >
            Rules first (regex)
          </button>
          <button
            className={parseMode === "llm" ? "primary" : "ghost"}
            disabled={parseBusy}
            onClick={() => void saveParseMode("llm")}
          >
            LLM first
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          {parseMode === "llm"
            ? "LLM parses first (needs an Anthropic key); a strong rules hit is the guardrail if the LLM declines."
            : "Fast deterministic rules first; the LLM fills in when rules are unsure or a channel has custom instructions."}
        </div>
      </div>

      <h2 style={{ marginBottom: 4 }}>Exchanges</h2>
      <p className="muted" style={{ marginTop: 0, maxWidth: 720 }}>
        Keys entered here are stored on the server and take precedence over any set via environment
        variables. Secrets are write-only — they're never sent back to the browser and are stripped
        from backups. A signal routes to the first enabled venue (in the priority order below) that
        lists the coin. <strong>Test on each venue's testnet before going live.</strong>
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}
      {!cfg ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {/* Active Hyperliquid network — one-click mainnet ⇄ testnet switch */}
          {(() => {
            const active = activeHlNetwork(cfg);
            const isMain = active === "mainnet";
            const activeVenue = isMain ? cfg.hyperliquid : cfg.hyperliquidTestnet;
            return (
              <div
                className="panel"
                style={{ borderColor: isMain ? "#ef4444" : "var(--border)" }}
              >
                <div className="row-between">
                  <h3 style={{ margin: 0 }}>Hyperliquid network</h3>
                  <span
                    className="tag"
                    style={{
                      background: isMain ? "#ef4444" : "#334155",
                      color: "#fff",
                      fontWeight: 600,
                    }}
                  >
                    {isMain ? "MAINNET · real funds" : "TESTNET · test funds"}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12, margin: "8px 0 12px" }}>
                  One click switches which network new signals trade on — no restart needed.
                  Open positions stay on the network they were opened on.
                </div>
                <div className="btn-row">
                  <button
                    className={active === "testnet" ? "primary" : "ghost"}
                    disabled={switching || active === "testnet"}
                    onClick={() => switchNet("testnet")}
                  >
                    Testnet
                  </button>
                  <button
                    className={active === "mainnet" ? "primary" : "ghost"}
                    disabled={switching || active === "mainnet"}
                    onClick={() => switchNet("mainnet")}
                  >
                    {switching ? "Switching…" : "Mainnet"}
                  </button>
                </div>
                {!activeVenue.live && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 10, color: "#f59e0b" }}>
                    ⚠️ No {active} key configured — orders on this network are <strong>simulated</strong>.
                    Add the key below to trade for real.
                  </div>
                )}
                {isMain && activeVenue.live && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 10, color: "#ef4444" }}>
                    ● Live on mainnet — new signals place real orders. Keep the kill-switch handy.
                  </div>
                )}
              </div>
            );
          })()}

          {/* Routing priority */}
          <div className="panel">
            <h3 style={{ margin: "0 0 8px" }}>Routing priority</h3>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              A signal goes to the first venue that lists its coin. If an opposing position is already
              open there, it moves to the next enabled venue (cross-venue hedge).
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 360 }}>
              {priority.map((name, i) => (
                <div
                  key={name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                  }}
                >
                  <span className="muted" style={{ width: 18 }}>{i + 1}.</span>
                  <span style={{ flex: 1, textTransform: "capitalize" }}>{name}</span>
                  <button className="ghost" disabled={i === 0} onClick={() => movePriority(i, -1)} title="Up">
                    ↑
                  </button>
                  <button
                    className="ghost"
                    disabled={i === priority.length - 1}
                    onClick={() => movePriority(i, 1)}
                    title="Down"
                  >
                    ↓
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Hyperliquid — mainnet & testnet as separate venues */}
          <HlPanel
            label="Hyperliquid Mainnet"
            subtitle="real funds"
            venue={cfg.hyperliquid}
            edit={hlMain}
            onEdit={(p) => setHlMain((s) => ({ ...s, ...p }))}
          />
          <HlPanel
            label="Hyperliquid Testnet"
            subtitle="test funds"
            venue={cfg.hyperliquidTestnet}
            edit={hlTest}
            onEdit={(p) => setHlTest((s) => ({ ...s, ...p }))}
          />

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
                <VenueBadge live={cfg.mexc.live} enabled={mexcEnabled} />
              </h3>
              <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
                <input type="checkbox" checked={mexcEnabled} onChange={(e) => setMexcEnabled(e.target.checked)} />
                enabled
              </label>
            </div>
            <SecretField
              label="API key (KYC-enabled account)"
              configured={cfg.mexc.apiKeyConfigured}
              value={mexcKey}
              onChange={setMexcKey}
              clear={mexcKeyClear}
              onClear={setMexcKeyClear}
            />
            <SecretField
              label="API secret"
              configured={cfg.mexc.apiSecretConfigured}
              value={mexcSecret}
              onChange={setMexcSecret}
              clear={mexcSecretClear}
              onClear={setMexcSecretClear}
            />
            <label style={{ display: "block" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>REST base URL</div>
              <input value={mexcBase} onChange={(e) => setMexcBase(e.target.value)} placeholder="https://api.mexc.com" style={{ width: "100%" }} />
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 6, color: "#f59e0b" }}>
              ⚠️ MEXC sizes orders in contracts and has <strong>no testnet</strong> — validate live with
              minimum size first, and check that stop-losses sit on the correct side. Without keys it
              routes & simulates only.
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
