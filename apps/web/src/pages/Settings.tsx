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
  // Global LLM memory (level-1 guidance applied to every channel).
  const [llmMemory, setLlmMemory] = useState("");
  const [memDirty, setMemDirty] = useState(false);
  const [memBusy, setMemBusy] = useState(false);
  // Diagnostic API (toggle + secret token).
  const [diag, setDiag] = useState<{ enabled: boolean; token: string }>({ enabled: false, token: "" });
  const [diagBusy, setDiagBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Auto-refine scheduler (global): auto-optimize channel parsing instructions.
  const [autoRefine, setAutoRefine] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  // Telegram notification categories.
  const [notif, setNotif] = useState({ configured: false, system: true, trades: true, classify: true });
  const [notifBusy, setNotifBusy] = useState(false);
  // Deterministic parsing rules (regex), loaded lazily when expanded.
  const [rules, setRules] = useState<Awaited<ReturnType<typeof api.rules>> | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  // HL (mainnet + testnet as separate venues)
  const [hlMain, setHlMain] = useState<HlEdit>({ key: "", clear: false, addr: "", enabled: false });
  const [hlTest, setHlTest] = useState<HlEdit>({ key: "", clear: false, addr: "", enabled: false });
  // Aster (V3: master address + API-wallet address + API-wallet private key)
  const [asterEnabled, setAsterEnabled] = useState(false);
  const [asterUser, setAsterUser] = useState("");
  const [asterSigner, setAsterSigner] = useState("");
  const [asterPk, setAsterPk] = useState("");
  const [asterPkClear, setAsterPkClear] = useState(false);
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
        setAsterUser(c.aster.user ?? "");
        setAsterSigner(c.aster.signer ?? "");
        setAsterBase(c.aster.baseUrl);
        setMexcEnabled(c.mexc.enabled);
        setMexcBase(c.mexc.baseUrl);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setParseMode(s.parseMode);
        setLlmMemory(s.llmMemory ?? "");
        setMemDirty(false);
        setAutoRefine(s.autoRefine);
        setNotif({ configured: s.alertsConfigured, system: s.alertOnSystem, trades: s.alertOnTrades, classify: s.alertOnClassify });
        setDiag({ enabled: s.diagnosticEnabled, token: s.diagnosticToken });
      })
      .catch(() => {});
  }, []);

  const saveMemory = async () => {
    setMemBusy(true);
    try {
      const s = await api.updateSettings({ llmMemory });
      setLlmMemory(s.llmMemory ?? "");
      setMemDirty(false);
      setMsg("Global LLM memory saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMemBusy(false);
    }
  };

  const toggleRules = () => {
    setRulesOpen((o) => !o);
    if (!rules) api.rules().then(setRules).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  const setNotifPref = async (patch: Partial<{ system: boolean; trades: boolean; classify: boolean }>) => {
    setNotifBusy(true);
    const next = { ...notif, ...patch };
    setNotif(next);
    try {
      await api.updateSettings({
        alertOnSystem: next.system,
        alertOnTrades: next.trades,
        alertOnClassify: next.classify,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNotifBusy(false);
    }
  };

  const toggleAutoRefine = async (on: boolean) => {
    setRefineBusy(true);
    setMsg(null);
    try {
      await api.updateSettings({ autoRefine: on });
      setAutoRefine(on);
      setMsg(`Auto-refine scheduler ${on ? "activated" : "deactivated"}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefineBusy(false);
    }
  };

  const toggleDiag = async (enabled: boolean) => {
    setDiagBusy(true);
    setMsg(null);
    try {
      const s = await api.updateSettings({ diagnosticEnabled: enabled });
      setDiag({ enabled: s.diagnosticEnabled, token: s.diagnosticToken });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagBusy(false);
    }
  };

  const regenDiagToken = async () => {
    setDiagBusy(true);
    try {
      const s = await api.updateSettings({ diagnosticRegenerateToken: true });
      setDiag({ enabled: s.diagnosticEnabled, token: s.diagnosticToken });
      setMsg("New diagnostic token generated — the old URL no longer works.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagBusy(false);
    }
  };

  const diagUrl = diag.token ? `${window.location.origin}/diagnostic?token=${diag.token}` : "";
  const copyDiagUrl = () => {
    if (!diagUrl) return;
    void navigator.clipboard?.writeText(diagUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

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
        user: asterUser,
        signer: asterSigner,
        ...(asterPkClear ? { privateKey: "" } : asterPk ? { privateKey: asterPk } : {}),
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
      setAsterUser(c.aster.user ?? "");
      setAsterSigner(c.aster.signer ?? "");
      setAsterPk("");
      setAsterPkClear(false);
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
  // Mirror the server's activeHyperliquid(): among enabled HL venues, prefer the
  // one that can actually trade (live) with the higher routing priority; only
  // fall back to priority when neither/both are live, so the badge can't claim
  // "MAINNET · real funds" while the server actually routes to testnet.
  const activeHlNetwork = (c: ExchangesConfig): "mainnet" | "testnet" => {
    const rank = (name: string) => {
      const i = c.priority.indexOf(name);
      return i < 0 ? 99 : i;
    };
    const main = { on: c.hyperliquid.enabled, live: c.hyperliquid.live, rank: rank("hyperliquid") };
    const test = { on: c.hyperliquidTestnet.enabled, live: c.hyperliquidTestnet.live, rank: rank("hyperliquid-testnet") };
    const mainEligible = main.on && main.live;
    const testEligible = test.on && test.live;
    if (mainEligible && !testEligible) return "mainnet";
    if (testEligible && !mainEligible) return "testnet";
    if (mainEligible && testEligible) return main.rank <= test.rank ? "mainnet" : "testnet";
    // Neither live → fall back to enabled + priority (what would route once keyed).
    if (main.on && !test.on) return "mainnet";
    if (test.on && !main.on) return "testnet";
    if (main.on && test.on) return main.rank <= test.rank ? "mainnet" : "testnet";
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

      <h2 style={{ marginBottom: 4 }}>Telegram Notifications</h2>
      <div className="panel">
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          What the bot posts to your alert Telegram chat. All on by default.{" "}
          {notif.configured ? (
            <span className="tag pos">bot configured</span>
          ) : (
            <span className="tag" style={{ color: "#f59e0b" }}>
              no alert bot — set ALERT_TG_BOT_TOKEN + ALERT_TG_CHAT_ID
            </span>
          )}
        </div>
        {[
          { key: "system" as const, label: "System notifications", hint: "Errors & operational alerts." },
          { key: "trades" as const, label: "Trades / Signals / SL-hit", hint: "Opened, filled, closed, stopped-out, blocked." },
          { key: "classify" as const, label: "Incoming messages", hint: "Every incoming message + how it was classified (can be chatty)." },
        ].map((row) => (
          <label
            key={row.key}
            style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)" }}
          >
            <input
              type="checkbox"
              checked={notif[row.key]}
              disabled={notifBusy}
              onChange={(e) => void setNotifPref({ [row.key]: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span style={{ flex: 1 }}>
              <div style={{ fontSize: 14, color: "var(--text)" }}>{row.label}</div>
              <div className="muted" style={{ fontSize: 11 }}>{row.hint}</div>
            </span>
          </label>
        ))}
      </div>

      <div className="panel">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Parsing rules (regex)</h3>
          <button className="ghost" onClick={toggleRules}>
            {rulesOpen ? "Hide" : "Show rules"}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          The deterministic patterns the bot uses to read messages into signals and trade-management
          actions. The LLM path is separate (governed by parse mode + the global memory and per-channel
          instructions above/below). These are read-only — source lives in <code>signals/regex.ts</code>{" "}
          and <code>signals/management.ts</code>.
        </div>
        {rulesOpen &&
          (rules ? (
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              {[
                { title: "Entry parsing", rows: rules.entry.map((r) => ({ name: r.name, kind: "", pattern: r.pattern, description: r.description })) },
                { title: "Trade-management classifiers", rows: rules.management.map((r) => ({ name: r.name, kind: r.kind, pattern: r.pattern, description: r.description })) },
              ].map((sec) => (
                <div key={sec.title} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, margin: "6px 0" }}>{sec.title}</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr className="muted" style={{ textAlign: "left" }}>
                        <th style={{ padding: "4px 8px" }}>name</th>
                        {sec.title.startsWith("Trade") && <th style={{ padding: "4px 8px" }}>→ intent</th>}
                        <th style={{ padding: "4px 8px" }}>what it matches</th>
                        <th style={{ padding: "4px 8px" }}>pattern</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.rows.map((r) => (
                        <tr key={r.name} style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
                          <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}><code>{r.name}</code></td>
                          {sec.title.startsWith("Trade") && <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{r.kind}</td>}
                          <td style={{ padding: "4px 8px" }}>{r.description}</td>
                          <td style={{ padding: "4px 8px" }}>
                            <code style={{ fontSize: 11, wordBreak: "break-all", opacity: 0.8 }}>{r.pattern}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Loading…</div>
          ))}
      </div>

      <div className="panel">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>
            Auto-refine scheduler
            <span className="tag" style={{ marginLeft: 8, background: autoRefine ? "#22c55e" : "#334155", color: "#fff" }}>
              {autoRefine ? "ACTIVE" : "off"}
            </span>
          </h3>
          <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
            <input
              type="checkbox"
              checked={autoRefine}
              disabled={refineBusy}
              onChange={(e) => void toggleAutoRefine(e.target.checked)}
            />
            active
          </label>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Global for all channels. When <strong>active</strong>, the bot periodically rewrites each
          channel's parsing instructions from its recent message history (needs an Anthropic key).
          When <strong>off</strong>, message/parse settings are never changed automatically — you keep
          full manual control of each channel's instructions and the global memory above.
        </div>
      </div>

      <h2 style={{ marginBottom: 4 }}>Global LLM memory</h2>
      <div className="panel">
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Level-1 guidance the LLM applies to <strong>every</strong> channel when parsing signals and
          trade-management updates. Put durable, cross-channel rules here (house conventions, how to treat
          updates vs. new calls, symbols to watch). Per-channel quirks go in each group's own instructions
          (level 2). Message content is always treated as untrusted — these notes only guide interpretation.
        </div>
        <textarea
          value={llmMemory}
          onChange={(e) => {
            setLlmMemory(e.target.value);
            setMemDirty(true);
          }}
          rows={7}
          maxLength={20000}
          placeholder={"e.g.\n- Treat 'trade update', 'SL at breakeven', 'now up X%' as management, never a new entry.\n- Channel group X trades gold/silver on HIP-3; normalize XAU→GOLD.\n- Ignore purely educational posts and disclaimers."}
          style={{ width: "100%", fontFamily: "inherit", fontSize: 13, resize: "vertical" }}
        />
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="primary" onClick={saveMemory} disabled={memBusy || !memDirty}>
            {memBusy ? "Saving…" : "Save memory"}
          </button>
          <span className="muted" style={{ alignSelf: "center", fontSize: 11 }}>
            {llmMemory.length}/20000{memDirty ? " · unsaved" : ""}
          </span>
        </div>
      </div>

      <h2 style={{ marginBottom: 4 }}>Diagnostic API</h2>
      <div className="panel" style={{ borderColor: diag.enabled ? "#f59e0b" : "var(--border)" }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>
            Remote diagnosis endpoint
            <span className="tag" style={{ marginLeft: 8, background: diag.enabled ? "#f59e0b" : "#334155", color: "#fff" }}>
              {diag.enabled ? "ENABLED" : "off"}
            </span>
          </h3>
          <label className="muted" style={{ fontSize: 13, display: "inline-flex", gap: 6 }}>
            <input
              type="checkbox"
              checked={diag.enabled}
              disabled={diagBusy}
              onChange={(e) => void toggleDiag(e.target.checked)}
            />
            enable
          </label>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: "8px 0 10px" }}>
          Exposes a read snapshot of the whole system (trades, signals, positions, logs, settings — secrets
          always redacted) and lets non-secret settings be changed remotely, protected by the secret token
          below. Off by default. <strong>Enable only while you need a diagnosis, then switch it off.</strong>
        </div>
        {diag.enabled && diagUrl ? (
          <>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Diagnostic URL (contains the secret token):</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code
                style={{
                  flex: 1,
                  minWidth: 240,
                  overflowX: "auto",
                  whiteSpace: "nowrap",
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                {diagUrl}
              </code>
              <button className="ghost" onClick={copyDiagUrl}>{copied ? "Copied ✓" : "Copy"}</button>
              <button className="ghost" onClick={regenDiagToken} disabled={diagBusy} title="Invalidate the old URL and mint a new token">
                Regenerate
              </button>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 8, color: "#f59e0b" }}>
              ⚠️ Anyone with this URL can read system state and change non-secret settings. Share it only with
              your diagnosis session, and regenerate or disable when done.
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: 11 }}>
            Turn it on to generate a URL you can hand to a diagnosis session.
          </div>
        )}
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
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Aster V3 uses an <strong>API wallet</strong> (EIP-712 signing), not a key+secret. Create
              one in Aster → API, then paste the master address, the API-wallet address, and the
              API-wallet private key.
            </div>
            <label style={{ display: "block", marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Master account address (user, 0x…)</div>
              <input value={asterUser} onChange={(e) => setAsterUser(e.target.value)} placeholder="0x…" style={{ width: "100%" }} />
            </label>
            <label style={{ display: "block", marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>API wallet address (signer, 0x…)</div>
              <input value={asterSigner} onChange={(e) => setAsterSigner(e.target.value)} placeholder="0x…" style={{ width: "100%" }} />
            </label>
            <SecretField
              label="API wallet private key"
              configured={cfg.aster.privateKeyConfigured}
              value={asterPk}
              onChange={setAsterPk}
              clear={asterPkClear}
              onClear={setAsterPkClear}
            />
            <label style={{ display: "block" }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                REST base URL (testnet: https://fapi.asterdex-testnet.com)
              </div>
              <input value={asterBase} onChange={(e) => setAsterBase(e.target.value)} placeholder="https://fapi.asterdex.com" style={{ width: "100%" }} />
            </label>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Without the API-wallet private key, Aster runs in market-data/simulation mode (routes &amp; tracks, no real orders).
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
