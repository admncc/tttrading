import { useEffect, useState, type ReactNode } from "react";
import { api, type ExchangesConfig, type ExchangesPatch, type HlVenue } from "../api.js";

/** Local edit state for one Hyperliquid network venue. */
interface HlEdit {
  key: string;
  clear: boolean;
  addr: string;
  enabled: boolean;
}

/** Small single-path inline icon. `d` may hold several sub-paths separated by spaces. */
function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
const ICO = {
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M3 12a9 9 0 1 0 3-6.7 M3 4v5h5",
  check: "M5 12l4 4L19 6",
  download: "M12 3v12M6 11l6 6 6-6M4 21h16",
  warn: "M12 3l10 18H2z M12 10v4 M12 17.5h.01",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M18 13l-6 6-6-6",
};

/** v2 switch (span[role=switch]). */
function Switch({
  on,
  onToggle,
  disabled,
  variant,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  variant?: "danger" | "warn";
  children: ReactNode;
}) {
  const cls = `switch${variant ? ` ${variant}` : ""}${on ? " on" : ""}${disabled ? " disabled" : ""}`;
  return (
    <span
      className={cls}
      role="switch"
      aria-checked={on}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onToggle()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <span className="track" />
      <span className="sw-text">{children}</span>
    </span>
  );
}

/** v2 checkbox (span.check). */
function Check({
  on,
  onToggle,
  disabled,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`check${on ? " on" : ""}`}
      role="checkbox"
      aria-checked={on}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onToggle()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}
    >
      <span className="box" />
      <span>{children}</span>
    </span>
  );
}

/**
 * v2 masked secret field. Empty value means "leave unchanged"; the clear toggle
 * wipes the stored value on save. Because secrets are write-only (never echoed
 * back) the field always exposes an input so a stored value can be replaced —
 * the "configured / not set" state and the clear toggle mirror the design's
 * .secret component.
 */
function Secret({
  configured,
  value,
  onChange,
  clear,
  onClear,
  placeholder,
}: {
  configured: boolean;
  value: string;
  onChange: (v: string) => void;
  clear: boolean;
  onClear: (v: boolean) => void;
  placeholder?: string;
}) {
  const state = configured ? (clear ? "clearing" : "configured") : "not set";
  const tagCls = configured ? (clear ? "tag warn" : "tag ok") : "tag neutral";
  return (
    <div className="secret">
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        value={value}
        disabled={clear}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          placeholder ?? (configured ? "•••••••• (leave blank to keep)" : "Paste key — never echoed back")
        }
        style={{ borderRadius: "7px 0 0 7px" }}
      />
      <span className="state">
        <span className={tagCls}>{state}</span>
      </span>
      {configured && (
        <button
          type="button"
          className="btn icon"
          title={clear ? "Keep the stored value" : "Clear the stored value"}
          onClick={() => onClear(!clear)}
        >
          <Icon d={clear ? ICO.refresh : ICO.close} />
        </button>
      )}
    </div>
  );
}

/** Live/sim/off state tag for a venue. */
function VenueTag({ live, enabled }: { live: boolean; enabled: boolean }) {
  if (!enabled) return <span className="tag neutral plain">off</span>;
  if (live) return <span className="tag ok">live</span>;
  return <span className="tag warn">market-data / sim</span>;
}

/** One Hyperliquid network venue (mainnet or testnet) as a v2 callout card. */
function HlCard({
  label,
  subtitle,
  priorityLabel,
  venue,
  edit,
  onEdit,
}: {
  label: string;
  subtitle: string;
  priorityLabel: string;
  venue: HlVenue;
  edit: HlEdit;
  onEdit: (patch: Partial<HlEdit>) => void;
}) {
  return (
    <div className="callout" style={{ padding: "14px 16px" }}>
      <div className="between mb12">
        <div className="flex">
          <span className="w600">{label}</span>
          <span className="small muted">{subtitle}</span>
          <VenueTag live={venue.live} enabled={edit.enabled} />
        </div>
        <div className="flex">
          <span className="tag brand plain">{priorityLabel}</span>
          <Switch on={edit.enabled} onToggle={() => onEdit({ enabled: !edit.enabled })}>
            <span />
          </Switch>
        </div>
      </div>
      <div className="form-grid cols-3">
        <div className="field">
          <label>Private key (API / agent wallet, 0x…)</label>
          <Secret
            configured={venue.privateKeyConfigured}
            value={edit.key}
            onChange={(v) => onEdit({ key: v })}
            clear={edit.clear}
            onClear={(v) => onEdit({ clear: v })}
          />
        </div>
        <div className="field">
          <label>Account address (master, optional)</label>
          <input
            className="input mono"
            value={edit.addr}
            onChange={(e) => onEdit({ addr: e.target.value })}
            placeholder="0x… (defaults to the signer)"
          />
        </div>
        {venue.signer && (
          <div className="field">
            <label>Signer address</label>
            <input className="input mono" value={venue.signer} readOnly />
          </div>
        )}
      </div>
    </div>
  );
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "s-message", label: "Message processing" },
  { id: "s-notif", label: "Notifications" },
  { id: "s-ai", label: "AI (Anthropic)" },
  { id: "s-memory", label: "Global LLM memory" },
  { id: "s-diag", label: "Diagnostic API" },
  { id: "s-exchanges", label: "Exchanges" },
  { id: "s-risk", label: "Risk & safety" },
  { id: "s-backup", label: "Backup" },
];

export function Settings() {
  const [cfg, setCfg] = useState<ExchangesConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [active, setActive] = useState<string>(SECTIONS[0]!.id);
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
  // AI (Anthropic): key + model + auto-refine scheduler.
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);
  const [anthropicModel, setAnthropicModel] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicKeyClear, setAnthropicKeyClear] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [autoRefine, setAutoRefine] = useState(false);
  const [refineBusy, setRefineBusy] = useState(false);
  // Telegram notification categories.
  const [notif, setNotif] = useState({ configured: false, system: true, trades: true, classify: true });
  const [notifBusy, setNotifBusy] = useState(false);
  // Deterministic parsing rules (regex), loaded lazily when expanded.
  const [rules, setRules] = useState<Awaited<ReturnType<typeof api.rules>> | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  // Risk & safety.
  const [shadowMode, setShadowMode] = useState(true);
  const [tradingPaused, setTradingPaused] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [dailyLoss, setDailyLoss] = useState(0);
  const [maxOpen, setMaxOpen] = useState(0);
  const [maxExposure, setMaxExposure] = useState(0);
  const [liveMaxOrder, setLiveMaxOrder] = useState(0);
  const [splitOpposing, setSplitOpposing] = useState(false);
  const [isolateSameCoin, setIsolateSameCoin] = useState(false);
  const [directionalSplit, setDirectionalSplit] = useState(false);
  const [riskBusy, setRiskBusy] = useState(false);
  // Backup.
  const [backupBusy, setBackupBusy] = useState(false);

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
        setAnthropicConfigured(s.anthropicConfigured);
        setAnthropicModel(s.anthropicModel ?? "");
        setShadowMode(s.shadowMode);
        setTradingPaused(s.tradingPaused);
        setDailyLoss(s.dailyLossLimitUsd);
        setMaxOpen(s.maxOpenTrades);
        setMaxExposure(s.maxExposureUsd);
        setLiveMaxOrder(s.liveMaxOrderUsd);
        setSplitOpposing(s.splitOpposingVenues);
        setIsolateSameCoin(s.isolateSameCoinVenues);
        setDirectionalSplit(s.directionalVenueSplit);
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
    const prev = notif;
    const next = { ...notif, ...patch };
    setNotif(next); // optimistic
    try {
      await api.updateSettings({
        alertOnSystem: next.system,
        alertOnTrades: next.trades,
        alertOnClassify: next.classify,
      });
    } catch (e) {
      setNotif(prev); // save failed — roll the toggle back so it reflects the server
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

  const saveAi = async () => {
    setAiBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const key = anthropicKeyClear ? "" : anthropicKey || undefined;
      const r = await api.saveAnthropic(key, anthropicModel || undefined);
      setAnthropicConfigured(r.anthropicConfigured);
      setAnthropicModel(r.anthropicModel ?? "");
      setAnthropicKey("");
      setAnthropicKeyClear(false);
      setMsg("AI settings saved. Keys apply immediately.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
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

  const setMode = async (shadow: boolean) => {
    if (shadow === shadowMode) return;
    if (!shadow) {
      const ok = window.confirm(
        "Switch to LIVE mode?\n\nNew signals will place REAL orders with real funds. " +
          "Make sure the venue keys are set, the account is funded, and the risk limits below are correct.",
      );
      if (!ok) return;
    }
    setModeBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const s = await api.updateSettings({ shadowMode: shadow });
      setShadowMode(s.shadowMode);
      setMsg(`Mode: ${s.shadowMode ? "Test / shadow — orders are simulated" : "LIVE / mainnet — real orders can fire"}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setModeBusy(false);
    }
  };

  const togglePause = async (on: boolean) => {
    setPauseBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api.updateSettings({ tradingPaused: on });
      setTradingPaused(on);
      setMsg(on ? "Trading paused — no new entries." : "Trading resumed.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPauseBusy(false);
    }
  };

  const saveRisk = async () => {
    setRiskBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api.updateSettings({
        dailyLossLimitUsd: dailyLoss,
        maxOpenTrades: maxOpen,
        maxExposureUsd: maxExposure,
        liveMaxOrderUsd: liveMaxOrder,
        splitOpposingVenues: splitOpposing,
        isolateSameCoinVenues: isolateSameCoin,
        directionalVenueSplit: directionalSplit,
      });
      setMsg("Risk & safety settings saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRiskBusy(false);
    }
  };

  const downloadBackup = async () => {
    setBackupBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api.downloadBackup();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
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
      setPriority(c.priority);
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

  const prioLabel = (name: string) => {
    const i = priority.indexOf(name);
    return i < 0 ? "priority —" : `priority ${i + 1}`;
  };

  const goto = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      {err && (
        <div className="error-card">
          <span className="e-icon">
            <Icon d={ICO.warn} size={15} />
          </span>
          <span>{err}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: "var(--gap)", alignItems: "start" }}>
        {/* In-page sub-nav */}
        <div className="panel" style={{ position: "sticky", top: 72 }}>
          <div className="panel-body tight">
            <div className="nav">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  className={`nav-item${active === s.id ? " active" : ""}`}
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    goto(s.id);
                  }}
                >
                  <span>{s.label}</span>
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="col">
          {/* ---------- Message processing ---------- */}
          <section className="panel" id="s-message">
            <div className="panel-head">
              <h2>Message processing</h2>
              <div className="actions">
                <button className="btn ghost sm" onClick={load}>
                  <Icon d={ICO.refresh} />
                  Refresh
                </button>
              </div>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Parse order</h3>
                  <div className="desc">
                    Which engine gets the first shot at a message. The other engine is always used as a
                    cross-check — disagreements are logged under Logs → message.
                  </div>
                </div>
                <div>
                  <div className="field">
                    <label>Parse mode</label>
                    <div className="seg">
                      <button
                        className={`seg-item${parseMode === "regex" ? " active" : ""}`}
                        disabled={parseBusy}
                        onClick={() => void saveParseMode("regex")}
                      >
                        Rules first (regex)
                      </button>
                      <button
                        className={`seg-item${parseMode === "llm" ? " active" : ""}`}
                        disabled={parseBusy}
                        onClick={() => void saveParseMode("llm")}
                      >
                        LLM first
                      </button>
                    </div>
                    <span className="hint">
                      {parseMode === "llm"
                        ? "LLM parses first (needs an Anthropic key); a strong rules hit is the guardrail if the LLM declines."
                        : "Fast deterministic rules first; the LLM fills in when rules are unsure or a channel has custom instructions."}
                    </span>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div>
                  <h3>Parsing rules (regex)</h3>
                  <div className="desc">
                    The deterministic patterns the bot uses to read messages into signals and
                    trade-management actions. Read-only — source lives in <code>signals/regex.ts</code> and{" "}
                    <code>signals/management.ts</code>.
                  </div>
                </div>
                <div>
                  <button className="btn sm" onClick={toggleRules}>
                    {rulesOpen ? "Hide rules" : "Show rules"}
                  </button>
                  {rulesOpen &&
                    (rules ? (
                      <div style={{ marginTop: 12, overflowX: "auto" }}>
                        {[
                          {
                            title: "Entry parsing",
                            rows: rules.entry.map((r) => ({ name: r.name, kind: "", pattern: r.pattern, description: r.description })),
                          },
                          {
                            title: "Trade-management classifiers",
                            rows: rules.management.map((r) => ({ name: r.name, kind: r.kind, pattern: r.pattern, description: r.description })),
                          },
                        ].map((sec) => (
                          <div key={sec.title} style={{ marginBottom: 14 }}>
                            <div className="w600" style={{ fontSize: 13, margin: "6px 0" }}>
                              {sec.title}
                            </div>
                            <table className="table mini" style={{ fontSize: 12 }}>
                              <thead>
                                <tr>
                                  <th>name</th>
                                  {sec.title.startsWith("Trade") && <th>→ intent</th>}
                                  <th>what it matches</th>
                                  <th>pattern</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sec.rows.map((r) => (
                                  <tr key={r.name} style={{ verticalAlign: "top" }}>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <code>{r.name}</code>
                                    </td>
                                    {sec.title.startsWith("Trade") && <td style={{ whiteSpace: "nowrap" }}>{r.kind}</td>}
                                    <td style={{ whiteSpace: "normal" }}>{r.description}</td>
                                    <td style={{ whiteSpace: "normal" }}>
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
                      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                        Loading…
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </section>

          {/* ---------- Telegram notifications ---------- */}
          <section className="panel" id="s-notif">
            <div className="panel-head">
              <h2>
                Telegram notifications
                {notif.configured ? (
                  <span className="tag ok">bot configured</span>
                ) : (
                  <span className="tag warn">no alert bot</span>
                )}
              </h2>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Alert categories</h3>
                  <div className="desc">
                    What the bot posts to your alert Telegram chat. All on by default.
                    {!notif.configured && " Set ALERT_TG_BOT_TOKEN + ALERT_TG_CHAT_ID to enable delivery."}
                  </div>
                </div>
                <div>
                  <div className="stack" style={{ gap: 10 }}>
                    <Switch
                      on={notif.system}
                      disabled={notifBusy}
                      onToggle={() => void setNotifPref({ system: !notif.system })}
                    >
                      <span>System notifications</span>
                      <span className="hint">Errors &amp; operational alerts.</span>
                    </Switch>
                    <Switch
                      on={notif.trades}
                      disabled={notifBusy}
                      onToggle={() => void setNotifPref({ trades: !notif.trades })}
                    >
                      <span>Trades / Signals / SL-hit</span>
                      <span className="hint">Opened, filled, closed, stopped-out, blocked.</span>
                    </Switch>
                    <Switch
                      on={notif.classify}
                      disabled={notifBusy}
                      onToggle={() => void setNotifPref({ classify: !notif.classify })}
                    >
                      <span>Incoming messages</span>
                      <span className="hint">Every incoming message + how it was classified (can be chatty).</span>
                    </Switch>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- AI (Anthropic) ---------- */}
          <section className="panel" id="s-ai">
            <div className="panel-head">
              <h2>AI (Anthropic)</h2>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>API key &amp; model</h3>
                  <div className="desc">
                    A desk-stored key overrides the environment variable. Secrets are write-only — never
                    echoed back to the browser.
                  </div>
                </div>
                <div>
                  <div className="form-grid cols-3">
                    <div className="field">
                      <label>API key</label>
                      <Secret
                        configured={anthropicConfigured}
                        value={anthropicKey}
                        onChange={setAnthropicKey}
                        clear={anthropicKeyClear}
                        onClear={setAnthropicKeyClear}
                      />
                    </div>
                    <div className="field">
                      <label>Model</label>
                      <input
                        className="input mono"
                        value={anthropicModel}
                        onChange={(e) => setAnthropicModel(e.target.value)}
                        placeholder="claude-…"
                      />
                    </div>
                    <div className="field">
                      <label>Auto-refine</label>
                      <Switch on={autoRefine} disabled={refineBusy} onToggle={() => void toggleAutoRefine(!autoRefine)}>
                        <span>Refine parsing rules from outcomes</span>
                        <span className="hint">
                          {autoRefine
                            ? "Active — the bot periodically rewrites each channel's parsing instructions."
                            : "Off — message/parse settings are never changed automatically."}
                        </span>
                      </Switch>
                    </div>
                  </div>
                  <div className="btn-row mt12">
                    <button className="btn primary sm" onClick={saveAi} disabled={aiBusy}>
                      <Icon d={ICO.check} />
                      {aiBusy ? "Saving…" : "Save AI settings"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- Global LLM memory ---------- */}
          <section className="panel" id="s-memory">
            <div className="panel-head">
              <h2>Global LLM memory</h2>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Level-1 guidance</h3>
                  <div className="desc">
                    Applied to <strong>every</strong> channel when the LLM parses signals and
                    trade-management updates. Put durable, cross-channel rules here; per-channel quirks go in
                    each group's own instructions (level 2). Message content is always treated as untrusted.
                  </div>
                </div>
                <div>
                  <div className="field">
                    <textarea
                      className="input"
                      value={llmMemory}
                      onChange={(e) => {
                        setLlmMemory(e.target.value);
                        setMemDirty(true);
                      }}
                      rows={7}
                      maxLength={20000}
                      style={{ minHeight: 120 }}
                      placeholder={
                        "e.g.\n- Treat 'trade update', 'SL at breakeven', 'now up X%' as management, never a new entry.\n- Channel group X trades gold/silver on HIP-3; normalize XAU→GOLD.\n- Ignore purely educational posts and disclaimers."
                      }
                    />
                    <span className="hint">
                      {llmMemory.length.toLocaleString()} / 20,000 characters{memDirty ? " · unsaved" : ""}
                    </span>
                  </div>
                  <div className="btn-row mt8">
                    <button className="btn primary sm" onClick={saveMemory} disabled={memBusy || !memDirty}>
                      <Icon d={ICO.check} />
                      {memBusy ? "Saving…" : "Save memory"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- Diagnostic API ---------- */}
          <section className={`panel${diag.enabled ? " danger-zone" : ""}`} id="s-diag">
            <div className="panel-head">
              <h2>
                Diagnostic API
                <span className="sub">token-gated remote inspection · off by default</span>
              </h2>
              <div className="actions">
                {diag.enabled ? <span className="tag error">enabled</span> : <span className="tag neutral">off</span>}
              </div>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Remote diagnosis endpoint</h3>
                  <div className="desc">
                    Exposes a read snapshot of the whole system (secrets always redacted) and lets non-secret
                    settings be changed remotely, protected by the token below. Dangerous when on — anyone
                    holding the URL can read desk state and change non-secret settings.{" "}
                    <strong>Enable only while you need a diagnosis, then switch it off.</strong>
                  </div>
                </div>
                <div>
                  <div className="stack" style={{ gap: 12 }}>
                    <Switch
                      on={diag.enabled}
                      variant="danger"
                      disabled={diagBusy}
                      onToggle={() => void toggleDiag(!diag.enabled)}
                    >
                      <span>Diagnostic API enabled</span>
                      <span className="hint">Disabling closes the endpoint immediately.</span>
                    </Switch>

                    {diag.enabled && diagUrl ? (
                      <>
                        <div className="field">
                          <label>Diagnostic URL (contains the secret token)</label>
                          <div className="input-group">
                            <input className="input mono" value={diagUrl} readOnly />
                            <span className="addon" style={{ cursor: "pointer" }} onClick={copyDiagUrl}>
                              {copied ? "copied ✓" : "copy"}
                            </span>
                          </div>
                        </div>
                        <div className="btn-row">
                          <button
                            className="btn danger sm"
                            onClick={regenDiagToken}
                            disabled={diagBusy}
                            title="Invalidate the old URL and mint a new token"
                          >
                            <Icon d={ICO.refresh} />
                            Regenerate token…
                          </button>
                          <span className="small warn">
                            <Icon d={ICO.warn} size={12} /> Share only with your diagnosis session; regenerate
                            or disable when done.
                          </span>
                        </div>
                      </>
                    ) : (
                      <span className="hint">Turn it on to generate a URL you can hand to a diagnosis session.</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ---------- Exchanges ---------- */}
          <section className="panel" id="s-exchanges">
            <div className="panel-head">
              <h2>
                Exchanges
                <span className="sub">per-venue configuration and routing order</span>
              </h2>
            </div>
            <div className="panel-body">
              <p className="small muted mb12" style={{ maxWidth: 760 }}>
                Keys entered here are stored on the server and take precedence over any set via environment
                variables. Secrets are write-only — never sent back to the browser and stripped from backups. A
                signal routes to the first enabled venue (in priority order) that lists the coin.{" "}
                <strong>Test on each venue's testnet before going live.</strong>
              </p>

              {!cfg ? (
                <div className="empty">
                  <div className="e-title">Loading exchanges…</div>
                  <div className="e-why">Fetching venue configuration and routing order.</div>
                </div>
              ) : (
                <div className="stack" style={{ gap: 12 }}>
                  {/* Active Hyperliquid network — one-click mainnet ⇄ testnet switch */}
                  {(() => {
                    const activeNet = activeHlNetwork(cfg);
                    const isMain = activeNet === "mainnet";
                    const activeVenue = isMain ? cfg.hyperliquid : cfg.hyperliquidTestnet;
                    return (
                      <div
                        className="callout"
                        style={{ padding: "14px 16px", borderColor: isMain ? "var(--loss-line)" : undefined }}
                      >
                        <div className="between mb12">
                          <div className="flex">
                            <span className="w600">Hyperliquid network</span>
                            <span className="small muted">one-click switch · no restart</span>
                          </div>
                          <span className={`tag ${isMain ? "loss" : "warn"} lg`}>
                            {isMain ? "MAINNET · real funds" : "TESTNET · test funds"}
                          </span>
                        </div>
                        <div className="seg">
                          <button
                            className={`seg-item${activeNet === "testnet" ? " active" : ""}`}
                            disabled={switching || activeNet === "testnet"}
                            onClick={() => switchNet("testnet")}
                          >
                            Testnet
                          </button>
                          <button
                            className={`seg-item${activeNet === "mainnet" ? " active" : ""}`}
                            disabled={switching || activeNet === "mainnet"}
                            onClick={() => switchNet("mainnet")}
                          >
                            {switching ? "Switching…" : "Mainnet"}
                          </button>
                        </div>
                        {!activeVenue.live && (
                          <div className="small warn mt8">
                            <Icon d={ICO.warn} size={12} /> No {activeNet} key configured — orders on this
                            network are <strong>simulated</strong>. Add the key below to trade for real.
                          </div>
                        )}
                        {isMain && activeVenue.live && (
                          <div className="small loss mt8">
                            <span className="dot live" /> Live on mainnet — new signals place real orders. Keep
                            the kill-switch handy.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Routing priority */}
                  <div className="callout" style={{ padding: "14px 16px" }}>
                    <div className="between mb12">
                      <div className="flex">
                        <span className="w600">Routing priority</span>
                        <span className="small muted">first venue that lists the coin wins</span>
                      </div>
                    </div>
                    <div className="stack" style={{ gap: 6, maxWidth: 380 }}>
                      {priority.map((name, i) => (
                        <div
                          key={name}
                          className="flex"
                          style={{
                            gap: 10,
                            border: "1px solid var(--line-strong)",
                            borderRadius: 8,
                            padding: "6px 10px",
                          }}
                        >
                          <span className="tag brand plain">{i + 1}</span>
                          <span className="grow" style={{ textTransform: "capitalize" }}>
                            {name}
                          </span>
                          <button className="btn icon sm" disabled={i === 0} onClick={() => movePriority(i, -1)} title="Up">
                            <Icon d={ICO.up} size={13} />
                          </button>
                          <button
                            className="btn icon sm"
                            disabled={i === priority.length - 1}
                            onClick={() => movePriority(i, 1)}
                            title="Down"
                          >
                            <Icon d={ICO.down} size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Hyperliquid — mainnet & testnet as separate venues */}
                  <HlCard
                    label="Hyperliquid Mainnet"
                    subtitle="real funds"
                    priorityLabel={prioLabel("hyperliquid")}
                    venue={cfg.hyperliquid}
                    edit={hlMain}
                    onEdit={(p) => setHlMain((s) => ({ ...s, ...p }))}
                  />
                  <HlCard
                    label="Hyperliquid Testnet"
                    subtitle="test funds"
                    priorityLabel={prioLabel("hyperliquid-testnet")}
                    venue={cfg.hyperliquidTestnet}
                    edit={hlTest}
                    onEdit={(p) => setHlTest((s) => ({ ...s, ...p }))}
                  />

                  {/* Aster */}
                  <div className="callout" style={{ padding: "14px 16px" }}>
                    <div className="between mb12">
                      <div className="flex">
                        <span className="w600">Aster</span>
                        <span className="small muted">backup venue</span>
                        <VenueTag live={cfg.aster.live} enabled={asterEnabled} />
                      </div>
                      <div className="flex">
                        <span className="tag brand plain">{prioLabel("aster")}</span>
                        <Switch on={asterEnabled} onToggle={() => setAsterEnabled(!asterEnabled)}>
                          <span />
                        </Switch>
                      </div>
                    </div>
                    <p className="small muted mb12">
                      Aster V3 uses an <strong>API wallet</strong> (EIP-712 signing), not a key+secret. Paste
                      the master address, the API-wallet address, and the API-wallet private key. Without the
                      private key, Aster runs in market-data/simulation mode.
                    </p>
                    <div className="form-grid cols-3">
                      <div className="field">
                        <label>Master account address (user, 0x…)</label>
                        <input className="input mono" value={asterUser} onChange={(e) => setAsterUser(e.target.value)} placeholder="0x…" />
                      </div>
                      <div className="field">
                        <label>API wallet address (signer, 0x…)</label>
                        <input className="input mono" value={asterSigner} onChange={(e) => setAsterSigner(e.target.value)} placeholder="0x…" />
                      </div>
                      <div className="field">
                        <label>API wallet private key</label>
                        <Secret
                          configured={cfg.aster.privateKeyConfigured}
                          value={asterPk}
                          onChange={setAsterPk}
                          clear={asterPkClear}
                          onClear={setAsterPkClear}
                        />
                      </div>
                      <div className="field">
                        <label>REST base URL</label>
                        <input
                          className="input mono"
                          value={asterBase}
                          onChange={(e) => setAsterBase(e.target.value)}
                          placeholder="https://fapi.asterdex.com"
                        />
                        <span className="hint">Testnet: https://fapi.asterdex-testnet.com</span>
                      </div>
                    </div>
                  </div>

                  {/* MEXC */}
                  <div className="callout" style={{ padding: "14px 16px" }}>
                    <div className="between mb12">
                      <div className="flex">
                        <span className="w600">MEXC</span>
                        <span className="small muted">last backup (KYC account)</span>
                        <VenueTag live={cfg.mexc.live} enabled={mexcEnabled} />
                      </div>
                      <div className="flex">
                        <span className="tag brand plain">{prioLabel("mexc")}</span>
                        <Switch on={mexcEnabled} onToggle={() => setMexcEnabled(!mexcEnabled)}>
                          <span />
                        </Switch>
                      </div>
                    </div>
                    <div className="form-grid cols-3">
                      <div className="field">
                        <label>API key (KYC-enabled account)</label>
                        <Secret
                          configured={cfg.mexc.apiKeyConfigured}
                          value={mexcKey}
                          onChange={setMexcKey}
                          clear={mexcKeyClear}
                          onClear={setMexcKeyClear}
                        />
                      </div>
                      <div className="field">
                        <label>API secret</label>
                        <Secret
                          configured={cfg.mexc.apiSecretConfigured}
                          value={mexcSecret}
                          onChange={setMexcSecret}
                          clear={mexcSecretClear}
                          onClear={setMexcSecretClear}
                        />
                      </div>
                      <div className="field">
                        <label>REST base URL</label>
                        <input
                          className="input mono"
                          value={mexcBase}
                          onChange={(e) => setMexcBase(e.target.value)}
                          placeholder="https://api.mexc.com"
                        />
                      </div>
                    </div>
                    <div className="small warn mt8">
                      <Icon d={ICO.warn} size={12} /> MEXC sizes orders in contracts and has{" "}
                      <strong>no testnet</strong> — validate live with minimum size first and check that
                      stop-losses sit on the correct side. Without keys it routes &amp; simulates only.
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="panel-foot">
              <span>Secrets show configured / not set and are never echoed; clear a value to replace it.</span>
              <div className="btn-row">
                <button className="btn primary sm" onClick={save} disabled={saving || !cfg}>
                  <Icon d={ICO.check} />
                  {saving ? "Saving…" : "Save exchange settings"}
                </button>
              </div>
            </div>
          </section>

          {/* ---------- Risk & safety ---------- */}
          <section className="panel danger-zone" id="s-risk">
            <div className="panel-head">
              <h2>
                Risk &amp; safety
                <span className="sub">global switches — these change what real money can do</span>
              </h2>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Mode</h3>
                  <div className="desc">The master switch (shadow mode) and the kill-switch (trading paused).</div>
                </div>
                <div>
                  <div className="stack" style={{ gap: 14 }}>
                    <div className="flex" style={{ gap: 12, flexWrap: "wrap" }}>
                      <div className="seg">
                        <button
                          className={`seg-item${shadowMode ? " active" : ""}`}
                          disabled={modeBusy}
                          onClick={() => void setMode(true)}
                        >
                          Test · shadow
                        </button>
                        <button
                          className={`seg-item${!shadowMode ? " active" : ""}`}
                          disabled={modeBusy}
                          onClick={() => void setMode(false)}
                        >
                          Live · mainnet
                        </button>
                      </div>
                      <span className="small muted">
                        currently{" "}
                        <b className={shadowMode ? "warn" : "gain"}>{shadowMode ? "TEST" : "LIVE"}</b>
                        {" — switching to live asks for confirmation"}
                      </span>
                    </div>
                    <Switch
                      on={tradingPaused}
                      variant="danger"
                      disabled={pauseBusy}
                      onToggle={() => void togglePause(!tradingPaused)}
                    >
                      <span>Trading paused (kill-switch)</span>
                      <span className="hint">No new entries; existing positions and stops still run.</span>
                    </Switch>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div>
                  <h3>Limits</h3>
                  <div className="desc">Hard clamps applied to every real order.</div>
                </div>
                <div>
                  <div className="form-grid cols-4">
                    <div className="field">
                      <label>Live max order</label>
                      <div className="input-group">
                        <input
                          className="input num"
                          value={String(liveMaxOrder)}
                          onChange={(e) => setLiveMaxOrder(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                        />
                        <span className="addon">USD</span>
                      </div>
                      <span className="hint">validate mainnet with tiny size first</span>
                    </div>
                    <div className="field">
                      <label>Daily loss limit</label>
                      <div className="input-group">
                        <input
                          className="input num"
                          value={String(dailyLoss)}
                          onChange={(e) => setDailyLoss(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                        />
                        <span className="addon">USD</span>
                      </div>
                    </div>
                    <div className="field">
                      <label>Max open trades</label>
                      <div className="input-group">
                        <input
                          className="input num"
                          value={String(maxOpen)}
                          onChange={(e) => setMaxOpen(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                        />
                        <span className="addon">trades</span>
                      </div>
                    </div>
                    <div className="field">
                      <label>Max exposure</label>
                      <div className="input-group">
                        <input
                          className="input num"
                          value={String(maxExposure)}
                          onChange={(e) => setMaxExposure(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                        />
                        <span className="addon">USD</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="form-section">
                <div>
                  <h3>Venue routing</h3>
                  <div className="desc">Anti-netting and isolation across venues.</div>
                </div>
                <div>
                  <div className="stack" style={{ gap: 10 }}>
                    <Check on={splitOpposing} onToggle={() => setSplitOpposing(!splitOpposing)}>
                      Split opposing venues — a long and a short on the same coin never share a venue
                    </Check>
                    <Check on={isolateSameCoin} onToggle={() => setIsolateSameCoin(!isolateSameCoin)}>
                      Isolate same-coin venues — a coin trades on one venue at a time
                    </Check>
                    <Check on={directionalSplit} onToggle={() => setDirectionalSplit(!directionalSplit)}>
                      Directional venue split — longs prefer Hyperliquid, shorts prefer Aster
                    </Check>
                  </div>
                </div>
              </div>
            </div>
            <div className="panel-foot">
              <span>Changes are applied immediately on save and streamed to the desk over the socket.</span>
              <div className="btn-row">
                <button className="btn primary sm" onClick={saveRisk} disabled={riskBusy}>
                  <Icon d={ICO.check} />
                  {riskBusy ? "Saving…" : "Save risk settings"}
                </button>
              </div>
            </div>
          </section>

          {/* ---------- Backup ---------- */}
          <section className="panel" id="s-backup">
            <div className="panel-head">
              <h2>Backup</h2>
            </div>
            <div className="panel-body">
              <div className="form-section">
                <div>
                  <h3>Sanitized SQLite backup</h3>
                  <div className="desc">
                    Keys and tokens are stripped. Includes groups, signals, trades, learnings, logs.
                  </div>
                </div>
                <div>
                  <div className="btn-row">
                    <button className="btn primary sm" onClick={downloadBackup} disabled={backupBusy}>
                      <Icon d={ICO.download} />
                      {backupBusy ? "Preparing…" : "Download backup"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {msg && (
            <div className="between">
              <span className="small muted">{msg}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
