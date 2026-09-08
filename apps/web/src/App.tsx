import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardStats, Group, LogEntry, SelfHealingEntry, SelfHealingLearning, Signal, Trade } from "@tttrading/shared";
import { api, openWs, getToken, setToken, setAuthErrorHandler, type AccountInfo } from "./api.js";
import { Overview } from "./pages/Overview.js";
import { Analytics } from "./pages/Analytics.js";
import { RiskInsights } from "./pages/RiskInsights.js";
import { SecondOpinion } from "./pages/SecondOpinion.js";
import { Trades } from "./pages/Trades.js";
import { Signals } from "./pages/Signals.js";
import { Messages } from "./pages/Messages.js";
import { Groups } from "./pages/Groups.js";
import { Logs } from "./pages/Logs.js";
import { SelfHealing } from "./pages/SelfHealing.js";
import { Settings } from "./pages/Settings.js";
import { Login } from "./pages/Login.js";
import { usd } from "./format.js";

type Tab =
  | "overview" | "trades" | "signals" | "messages"
  | "analytics" | "risk" | "secondopinion"
  | "selfhealing" | "logs"
  | "groups" | "settings";

/** Nav icon set (stroke, currentColor) — matches the v2 design. */
function Icon({ name }: { name: Tab | "update" | "logout" | "search" | "pause" }) {
  const p: Record<string, JSX.Element> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    trades: <><path d="M7 3v3M7 14v7M17 3v5M17 16v5" /><rect x="4.5" y="6" width="5" height="8" rx="1" /><rect x="14.5" y="8" width="5" height="8" rx="1" /></>,
    signals: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" /></>,
    messages: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" />,
    analytics: <><path d="M3 20h18" /><path d="M4 16l5-6 4 4 4-7 4 3" /></>,
    risk: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9.5 12l2 2 3.5-4" /></>,
    secondopinion: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    selfhealing: <path d="M3 12h4l2-5 4 10 2-5h6" />,
    logs: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    groups: <path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18" />,
    settings: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
    update: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
    logout: <><path d="M10 4H5v16h5" /><path d="M14 8l5 4-5 4M19 12H9" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
    pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
  };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name]}
    </svg>
  );
}

const NAV: { section: string; items: { id: Tab; label: string }[] }[] = [
  { section: "Monitor", items: [
    { id: "overview", label: "Overview" },
    { id: "trades", label: "Trades" },
    { id: "signals", label: "Signals" },
    { id: "messages", label: "Messages" },
  ] },
  { section: "Analyze", items: [
    { id: "analytics", label: "Analytics" },
    { id: "risk", label: "Risk Insights" },
    { id: "secondopinion", label: "Second Opinion" },
  ] },
  { section: "Supervise", items: [
    { id: "selfhealing", label: "Self Healing" },
    { id: "logs", label: "Logs" },
  ] },
  { section: "Configure", items: [
    { id: "groups", label: "Groups" },
    { id: "settings", label: "Settings" },
  ] },
];

const TAB_LABEL: Record<Tab, string> = Object.fromEntries(
  NAV.flatMap((s) => s.items).map((i) => [i.id, i.label]),
) as Record<Tab, string>;

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [health, setHealth] = useState<{
    env: string;
    activeNetwork?: string;
    live: boolean;
    shadowMode: boolean;
    tradingPaused?: boolean;
  } | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [heals, setHeals] = useState<SelfHealingEntry[]>([]);
  const [healLearnings, setHealLearnings] = useState<SelfHealingLearning[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => new Date());
  const [jump, setJump] = useState("");
  const [jumpOpen, setJumpOpen] = useState(false);

  const reloadLogs = useCallback(() => {
    api.logs(500).then(setLogs).catch(() => {});
  }, []);

  // Auth: "loading" until we know whether login is required and whether we're in.
  const [authState, setAuthState] = useState<"loading" | "in" | "out">("loading");

  const [updateEnabled, setUpdateEnabled] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const checkUpdate = async () => {
    setUpdateInfo("checking…");
    try {
      const r = await api.checkUpdate();
      if (r.error) setUpdateInfo(`error: ${r.error}`);
      else if ((r.behind ?? 0) === 0) setUpdateInfo(`up to date`);
      else setUpdateInfo(`${r.behind} behind`);
    } catch (e) {
      setUpdateInfo(`error: ${e instanceof Error ? e.message : e}`);
    }
  };

  const applyUpdate = async () => {
    if (!confirm("Pull the latest code and rebuild? The desk will restart (~1–2 min).")) return;
    setUpdating(true);
    setUpdateInfo("updating — the desk will restart…");
    try {
      await api.applyUpdate();
    } catch {
      /* the container is being recreated; the request may not return */
    }
  };

  const refresh = useCallback(async () => {
    const [h, s, g, sig, t, p, a] = await Promise.all([
      api.health().catch(() => null),
      api.stats().catch(() => null),
      api.groups().catch(() => []),
      api.signals().catch(() => []),
      api.trades().catch(() => []),
      api.prices().catch(() => ({})),
      api.account().catch(() => null),
    ]);
    if (h) setHealth({ env: h.env, activeNetwork: h.activeNetwork, live: h.live, shadowMode: h.shadowMode, tradingPaused: h.tradingPaused });
    if (s) setStats(s);
    setGroups(g);
    setSignals(sig);
    setTrades(t);
    setPrices(p);
    if (a) setAccount(a);
  }, []);

  // Determine auth state on mount, then load data if we're in.
  useEffect(() => {
    setAuthErrorHandler(() => setAuthState("out"));
    void (async () => {
      const h = await api.health().catch(() => null);
      if (h) {
        setHealth({ env: h.env, activeNetwork: h.activeNetwork, live: h.live, shadowMode: h.shadowMode, tradingPaused: h.tradingPaused });
        setUpdateEnabled(h.updateEnabled);
      }
      if (h && !h.authRequired) {
        setAuthState("in");
      } else if (getToken()) {
        setAuthState("in"); // optimistic; a 401 will flip us to "out"
      } else {
        setAuthState("out");
      }
    })();
  }, []);

  useEffect(() => {
    if (authState === "in") void refresh();
  }, [authState, refresh]);

  // A ticking UTC clock for the status bar.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ⌘K / Ctrl+K focuses the jump-to search; Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJumpOpen(true);
        setTimeout(() => document.getElementById("jump-input")?.focus(), 0);
      } else if (e.key === "Escape") {
        setJumpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Poll health + account so the badge/equity self-heal after a change that
  // doesn't broadcast — e.g. the Settings network switch.
  useEffect(() => {
    if (authState !== "in") return;
    const poll = setInterval(() => {
      api
        .health()
        .then((h) =>
          setHealth({
            env: h.env,
            activeNetwork: h.activeNetwork,
            live: h.live,
            shadowMode: h.shadowMode,
            tradingPaused: h.tradingPaused,
          }),
        )
        .catch(() => {});
      api.account().then(setAccount).catch(() => {});
    }, 20_000);
    return () => clearInterval(poll);
  }, [authState]);

  const logout = () => {
    setToken(null);
    setAuthState("out");
  };

  const toggleShadow = async () => {
    if (!health) return;
    const goingLive = health.shadowMode; // currently on -> turning off = live
    if (goingLive) {
      const ok = confirm(
        "Disable TEST mode and allow REAL orders?\n\n" +
          "From now on, incoming signals can place live trades on Hyperliquid " +
          "(per your TRADING_ENV and key). Continue?",
      );
      if (!ok) return;
    }
    const res = await api.updateSettings({ shadowMode: !health.shadowMode });
    setHealth((h) => (h ? { ...h, shadowMode: res.shadowMode } : h));
  };

  const togglePause = async () => {
    if (!health) return;
    const next = !health.tradingPaused;
    if (next && !confirm("Pause trading (kill-switch)?\n\nNo new entries will open; existing positions and their stops keep running.")) return;
    setHealth((h) => (h ? { ...h, tradingPaused: next } : h)); // optimistic; ws confirms
    try {
      await api.updateSettings({ tradingPaused: next });
    } catch {
      setHealth((h) => (h ? { ...h, tradingPaused: !next } : h)); // revert on failure
    }
  };

  // Live updates over WebSocket (only while authenticated).
  useEffect(() => {
    if (authState !== "in") return;
    return openWs((e) => {
      switch (e.type) {
        case "stats":
          setStats(e.stats);
          break;
        case "signal":
          setSignals((prev) => {
            const idx = prev.findIndex((s) => s.id === e.signal.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = e.signal;
              return next;
            }
            return [e.signal, ...prev];
          });
          break;
        case "trade":
          setTrades((prev) => {
            const idx = prev.findIndex((t) => t.id === e.trade.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = e.trade;
              return next;
            }
            return [e.trade, ...prev];
          });
          break;
        case "group":
          setGroups((prev) => {
            const idx = prev.findIndex((g) => g.id === e.group.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = e.group;
              return next;
            }
            return [...prev, e.group];
          });
          break;
        case "settings":
          setHealth((h) =>
            h ? { ...h, shadowMode: e.settings.shadowMode, tradingPaused: e.settings.tradingPaused } : h,
          );
          break;
        case "log":
          setLogs((prev) => [e.entry, ...prev].slice(0, 800));
          break;
        case "heal":
          setHeals((prev) => [e.entry, ...prev.filter((h) => h.id !== e.entry.id)].slice(0, 400));
          break;
        case "healLearning":
          setHealLearnings((prev) => [e.learning, ...prev.filter((l) => l.id !== e.learning.id)].slice(0, 400));
          break;
        case "prices":
          setPrices(e.prices);
          break;
      }
    }, () => {
      // On (re)connect, re-sync full state — events missed while the socket was
      // down are otherwise never delivered, leaving the desk stale.
      void refresh();
      reloadLogs();
    });
  }, [authState, refresh, reloadLogs]);

  // ---- Derived chrome state ----
  const openCount = useMemo(() => trades.filter((t) => t.status === "open" && !t.shadow).length, [trades]);
  const workingCount = useMemo(() => trades.filter((t) => t.status === "working" && !t.shadow).length, [trades]);
  const pendingCount = useMemo(() => signals.filter((s) => s.status === "pending").length, [signals]);
  const healErrorCount = useMemo(() => heals.filter((h) => h.verdict === "error" && !h.comment).length, [heals]);

  const env: "live" | "test" | "paused" = health?.shadowMode
    ? "test"
    : health?.tradingPaused
      ? "paused"
      : health?.live
        ? "live"
        : "test";
  const net = (health?.activeNetwork ?? health?.env ?? "").toUpperCase();
  const envState = env === "live" ? "LIVE" : env === "paused" ? "PAUSED" : "TEST";
  const clock = now.toLocaleTimeString("de-DE", {
    timeZone: "Europe/Berlin",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const countFor = (id: Tab): { n: number; cls: string } | null => {
    if (id === "trades" && openCount) return { n: openCount, cls: "gain" };
    if (id === "signals" && pendingCount) return { n: pendingCount, cls: "warn" };
    if (id === "selfhealing" && healErrorCount) return { n: healErrorCount, cls: "loss" };
    return null;
  };

  const closedCount = useMemo(() => trades.filter((t) => t.status === "closed").length, [trades]);
  const jumpMatches = useMemo(
    () => NAV.flatMap((s) => s.items).filter((i) => i.label.toLowerCase().includes(jump.toLowerCase())),
    [jump],
  );
  const goTab = (id: Tab) => { setTab(id); setJump(""); setJumpOpen(false); };

  // Per-venue equity for the status bar (margin isn't shared across venues, so
  // Hyperliquid + Aster + … are shown separately rather than one figure).
  const VENUE_LABEL: Record<string, string> = {
    hyperliquid: "HL",
    "hyperliquid-testnet": "HL-test",
    aster: "Aster",
    mexc: "MEXC",
  };
  const equityChips = useMemo(() => {
    const by = account?.equityByVenue ?? {};
    return Object.entries(by)
      .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ label: VENUE_LABEL[name] ?? name, value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);
  const pageMeta = (): string => {
    switch (tab) {
      case "overview":
        return `${now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${groups.length} groups`;
      case "trades":
        return `${openCount} open · ${workingCount} working · ${closedCount} closed`;
      case "signals":
        return `${pendingCount} pending · ${signals.length} recent`;
      case "messages":
        return `${groups.length} channels`;
      case "groups":
        return `${groups.length} channels`;
      case "selfhealing":
        return `independent review · learnings${health?.tradingPaused ? "" : ""}`;
      case "analytics":
        return "performance over the selected range";
      case "risk":
        return "live portfolio risk · per-channel edge";
      case "secondopinion":
        return "independent, observe-only assessments";
      case "settings":
        return "global config · exchanges · safety · diagnostic";
      case "logs":
        return `${logs.length} lines · live`;
      default:
        return "";
    }
  };

  if (authState === "loading") {
    return <div className="empty" style={{ paddingTop: 80 }}><div className="e-title">Loading…</div></div>;
  }
  if (authState === "out") {
    return <Login onSuccess={() => setAuthState("in")} />;
  }

  return (
    <div className="app" data-env={env}>
      <aside className="sidebar-col">
        <div className="sidebar">
          <div className="brand">
            <span className="mark">TT</span>
            <span>
              <div className="word">TT Desk</div>
              <div className="sub">Operator cockpit</div>
            </span>
          </div>

          <nav className="nav">
            {NAV.map((sec) => (
              <div key={sec.section}>
                <div className="nav-section">{sec.section}</div>
                {sec.items.map((it) => {
                  const c = countFor(it.id);
                  return (
                    <a
                      key={it.id}
                      className={`nav-item ${tab === it.id ? "active" : ""}`}
                      onClick={() => setTab(it.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setTab(it.id)}
                    >
                      <Icon name={it.id} />
                      <span>{it.label}</span>
                      {c && <span className={`count ${c.cls}`}>{c.n}</span>}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            {updateEnabled && updateInfo && updateInfo.includes("behind") && (
              <button className="btn sm block" onClick={applyUpdate} disabled={updating}>
                {updating ? "Updating…" : "Update & restart"}
              </button>
            )}
            <div
              className={`env-card ${env}`}
              title={
                health && health.activeNetwork && health.activeNetwork !== health.env
                  ? `Process TRADING_ENV=${health.env}; signals route to Hyperliquid ${health.activeNetwork}.`
                  : undefined
              }
            >
              <div className="env-head">
                <span className="env-state">
                  <span className={`dot ${env === "live" ? "live" : env === "paused" ? "paused" : "sim"}`} />
                  {envState}
                </span>
                <span className="env-net">{net}</span>
              </div>
              <div className="env-desc">
                {env === "live"
                  ? "Hyperliquid · real orders can fire"
                  : env === "paused"
                    ? "Kill-switch on · no new entries"
                    : "Simulated · no real orders are sent"}
              </div>
              {health && (
                <button className="btn sm block" onClick={toggleShadow}>
                  {health.shadowMode ? "Go live" : "Switch to test mode"}
                </button>
              )}
            </div>

            {health && (
              <button
                className={`btn kill ${health.tradingPaused ? "engaged" : ""}`}
                onClick={togglePause}
                title={health.tradingPaused ? "Trading is paused — click to resume." : "Pause new entries (existing positions keep running)."}
              >
                <Icon name="pause" />
                {health.tradingPaused ? "Resume trading" : "Pause trading"}
              </button>
            )}

            <div className="sidebar-links">
              {updateEnabled ? (
                <a onClick={checkUpdate} role="button" tabIndex={0}>
                  <Icon name="update" /> Update{updateInfo ? ` · ${updateInfo}` : ""}
                </a>
              ) : (
                <span />
              )}
              {getToken() && (
                <a onClick={logout} role="button" tabIndex={0}>
                  <Icon name="logout" /> Log out
                </a>
              )}
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="statusbar">
          <div className="page-title">
            <h1>{TAB_LABEL[tab]}</h1>
            {pageMeta() && <span className="meta">{pageMeta()}</span>}
          </div>
          <div className="status-cluster">
            <span className={`chip env ${env}`}>
              <span className={`dot ${env === "live" ? "live" : env === "paused" ? "paused" : "sim"}`} />
              {envState} · {net}
            </span>
            <span className="chip">
              <span className="dot live" /> Live feed
            </span>
            {equityChips.length > 0
              ? equityChips.map((v) => (
                  <span className="chip" key={v.label} title={`${v.label} equity`}>
                    {v.label} <span className="num">{usd(v.value)}</span>
                  </span>
                ))
              : account?.accountValue != null && (
                  <span className="chip">
                    Equity <span className="num">{usd(account.accountValue)}</span>
                  </span>
                )}
            <span className="chip num">{clock} Berlin</span>
            <div className="search" style={{ position: "relative" }}>
              <Icon name="search" />
              <input
                id="jump-input"
                value={jump}
                onChange={(e) => { setJump(e.target.value); setJumpOpen(true); }}
                onFocus={() => setJumpOpen(true)}
                onBlur={() => setTimeout(() => setJumpOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && jumpMatches[0]) { goTab(jumpMatches[0].id); (e.target as HTMLInputElement).blur(); }
                }}
                placeholder="Jump to…"
                style={{ border: "none", background: "transparent", height: "auto", padding: 0, width: "100%", color: "var(--ink)", outline: "none", boxShadow: "none", fontSize: "var(--fs-sm)" }}
              />
              <span className="kbd">⌘K</span>
              {jumpOpen && jump && jumpMatches.length > 0 && (
                <div style={{ position: "absolute", top: "120%", left: 0, right: 0, background: "var(--surface-overlay)", border: "1px solid var(--line-x)", borderRadius: 8, boxShadow: "var(--shadow-2)", zIndex: 50, overflow: "hidden" }}>
                  {jumpMatches.map((m) => (
                    <div
                      key={m.id}
                      onMouseDown={() => goTab(m.id)}
                      style={{ padding: "7px 10px", cursor: "pointer", color: tab === m.id ? "var(--champagne)" : "var(--ink-2)", fontSize: "var(--fs-sm)" }}
                    >
                      {m.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="content">
          {env === "test" && (
            <div className="banner test">
              <span className="b-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v5L5 19a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-11V3" /></svg>
              </span>
              <div>
                <div className="b-title">Test mode</div>
                <div className="b-text">Signals are processed and simulated at live prices — no real orders are sent. Flip “Go live” when you're ready.</div>
              </div>
              <div className="b-actions">
                <button className="btn sm ghost" onClick={() => setTab("settings")}>Readiness</button>
                <button className="btn sm warn" onClick={toggleShadow}>Go live…</button>
              </div>
            </div>
          )}
          {health?.tradingPaused && (
            <div className="banner paused">
              <span className="b-icon"><Icon name="pause" /></span>
              <div>
                <div className="b-title">Trading paused</div>
                <div className="b-text">No new entries are opened (kill-switch). Existing positions and their stops still run.</div>
              </div>
              <div className="b-actions">
                <button className="btn sm" onClick={togglePause}>Resume</button>
              </div>
            </div>
          )}

          {tab === "overview" && <Overview stats={stats} signals={signals} trades={trades} prices={prices} />}
          {tab === "analytics" && <Analytics />}
          {tab === "risk" && <RiskInsights />}
          {tab === "secondopinion" && <SecondOpinion />}
          {tab === "signals" && <Signals signals={signals} groups={groups} onChange={refresh} />}
          {tab === "messages" && <Messages signals={signals} groups={groups} onChange={refresh} />}
          {tab === "trades" && <Trades trades={trades} prices={prices} onChange={refresh} />}
          {tab === "groups" && <Groups groups={groups} onChange={refresh} />}
          {tab === "selfhealing" && <SelfHealing live={heals} liveLearnings={healLearnings} />}
          {tab === "settings" && <Settings />}
          {tab === "logs" && <Logs logs={logs} onReload={reloadLogs} />}
        </div>
      </main>
    </div>
  );
}
