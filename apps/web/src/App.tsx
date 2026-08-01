import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Group, Signal, Trade } from "@tttrading/shared";
import { api, openWs } from "./api.js";
import { Overview } from "./pages/Overview.js";
import { Trades } from "./pages/Trades.js";
import { Signals } from "./pages/Signals.js";
import { Groups } from "./pages/Groups.js";

type Tab = "overview" | "trades" | "signals" | "groups";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "signals", label: "Signals" },
  { id: "trades", label: "Trades" },
  { id: "groups", label: "Groups & Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [health, setHealth] = useState<{ env: string; live: boolean } | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  const refresh = useCallback(async () => {
    const [h, s, g, sig, t] = await Promise.all([
      api.health().catch(() => null),
      api.stats().catch(() => null),
      api.groups().catch(() => []),
      api.signals().catch(() => []),
      api.trades().catch(() => []),
    ]);
    if (h) setHealth({ env: h.env, live: h.live });
    if (s) setStats(s);
    setGroups(g);
    setSignals(sig);
    setTrades(t);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates over WebSocket.
  useEffect(() => {
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
      }
    });
  }, []);

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
          <span className={`dot ${health?.live ? "live" : "sim"}`} />
          {health ? `${health.env}${health.live ? " · live" : " · simulated"}` : "connecting…"}
        </div>
      </aside>

      <main className="main">
        {tab === "overview" && <Overview stats={stats} />}
        {tab === "signals" && (
          <Signals signals={signals} groups={groups} onChange={refresh} />
        )}
        {tab === "trades" && <Trades trades={trades} onChange={refresh} />}
        {tab === "groups" && <Groups groups={groups} onChange={refresh} />}
      </main>
    </div>
  );
}
