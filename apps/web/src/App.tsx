import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Group, LogEntry, Signal, Trade } from "@tttrading/shared";
import { api, openWs, getToken, setToken, setAuthErrorHandler } from "./api.js";
import { Overview } from "./pages/Overview.js";
import { Analytics } from "./pages/Analytics.js";
import { Trades } from "./pages/Trades.js";
import { Signals } from "./pages/Signals.js";
import { Messages } from "./pages/Messages.js";
import { Groups } from "./pages/Groups.js";
import { Logs } from "./pages/Logs.js";
import { Login } from "./pages/Login.js";

type Tab = "overview" | "analytics" | "trades" | "signals" | "messages" | "groups" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "analytics", label: "Analytics" },
  { id: "signals", label: "Signals" },
  { id: "messages", label: "Messages" },
  { id: "trades", label: "Trades" },
  { id: "groups", label: "Groups & Settings" },
  { id: "logs", label: "Logs" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [health, setHealth] = useState<{
    env: string;
    live: boolean;
    shadowMode: boolean;
    tradingPaused?: boolean;
  } | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});

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
      else if ((r.behind ?? 0) === 0) setUpdateInfo(`up to date (${r.current ?? "?"})`);
      else setUpdateInfo(`${r.behind} update(s) available`);
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
    const [h, s, g, sig, t, p] = await Promise.all([
      api.health().catch(() => null),
      api.stats().catch(() => null),
      api.groups().catch(() => []),
      api.signals().catch(() => []),
      api.trades().catch(() => []),
      api.prices().catch(() => ({})),
    ]);
    if (h) setHealth({ env: h.env, live: h.live, shadowMode: h.shadowMode, tradingPaused: h.tradingPaused });
    if (s) setStats(s);
    setGroups(g);
    setSignals(sig);
    setTrades(t);
    setPrices(p);
  }, []);

  // Determine auth state on mount, then load data if we're in.
  useEffect(() => {
    setAuthErrorHandler(() => setAuthState("out"));
    void (async () => {
      const h = await api.health().catch(() => null);
      if (h) {
        setHealth({ env: h.env, live: h.live, shadowMode: h.shadowMode, tradingPaused: h.tradingPaused });
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

  if (authState === "loading") {
    return <div className="empty" style={{ paddingTop: 80 }}>Loading…</div>;
  }
  if (authState === "out") {
    return <Login onSuccess={() => setAuthState("in")} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          TT<span>Desk</span>
        </div>
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </div>
        ))}
        <div className="env-badge">
          <span className={`dot ${health && !health.shadowMode && health.live ? "live" : "sim"}`} />
          {health
            ? `${health.env}${health.shadowMode ? " · TEST" : health.live ? " · LIVE" : " · simulated"}`
            : "connecting…"}
        </div>
        {health && (
          <button
            className={health.shadowMode ? "primary" : "danger"}
            style={{ marginTop: 8 }}
            onClick={toggleShadow}
            title={
              health.shadowMode
                ? "Currently simulating everything. Click to go live."
                : "Live trading is ON. Click to switch back to test mode."
            }
          >
            {health.shadowMode ? "Go live →" : "← Back to test mode"}
          </button>
        )}
        {updateEnabled && (
          <div style={{ marginTop: 8 }}>
            <button className="ghost" style={{ width: "100%" }} onClick={checkUpdate} disabled={updating}>
              Check for updates
            </button>
            {updateInfo && (
              <div className="muted" style={{ fontSize: 11, margin: "6px 2px" }}>
                {updateInfo}
              </div>
            )}
            <button
              className="primary"
              style={{ width: "100%", marginTop: 4 }}
              onClick={applyUpdate}
              disabled={updating}
            >
              {updating ? "Updating…" : "Update & restart"}
            </button>
          </div>
        )}
        {getToken() && (
          <button className="ghost" style={{ marginTop: 8 }} onClick={logout}>
            Log out
          </button>
        )}
      </aside>

      <main className="main">
        {health?.shadowMode && (
          <div className="test-banner">
            🧪 <strong>TEST MODE</strong> — signals are processed and simulated at live prices, but
            <strong> no real orders</strong> are sent. Flip “Go live” in the sidebar when you're ready.
          </div>
        )}
        {health?.tradingPaused && (
          <div className="test-banner" style={{ borderColor: "rgba(239,68,68,0.4)", color: "#ef4444", background: "rgba(239,68,68,0.1)" }}>
            ⏸ <strong>TRADING PAUSED</strong> — no new entries are opened (kill-switch). Existing
            positions still run. Resume under Overview → Risk &amp; safety.
          </div>
        )}
        {tab === "overview" && <Overview stats={stats} signals={signals} trades={trades} prices={prices} />}
        {tab === "analytics" && <Analytics />}
        {tab === "signals" && (
          <Signals signals={signals} groups={groups} onChange={refresh} />
        )}
        {tab === "messages" && (
          <Messages signals={signals} groups={groups} onChange={refresh} />
        )}
        {tab === "trades" && <Trades trades={trades} prices={prices} onChange={refresh} />}
        {tab === "groups" && <Groups groups={groups} onChange={refresh} />}
        {tab === "logs" && <Logs logs={logs} onReload={reloadLogs} />}
      </main>
    </div>
  );
}
