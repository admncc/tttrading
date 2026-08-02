import { useEffect, useState } from "react";
import { api, type TelegramHealth } from "../api.js";
import { timeAgo, dateTimeSec } from "../format.js";

/** Is the given ISO timestamp within `maxMs` of now? */
function fresh(iso: string | null | undefined, maxMs: number): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= maxMs;
}

export function ListenerHealth() {
  const [h, setH] = useState<TelegramHealth | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => api.telegramHealth().then((d) => alive && setH(d)).catch(() => {});
    void load();
    const poll = setInterval(load, 10_000);
    // Re-render every 10s so the relative "ago" labels stay current.
    const tick = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  if (!h) return null;
  if (!h.configured) {
    return (
      <div className="panel">
        <h2>Listener health</h2>
        <div className="muted">
          <span className="dot sim" /> Telegram not configured — running on manual input only.
        </div>
      </div>
    );
  }

  // Healthy = connected AND the poller cycled recently (within 3 intervals).
  const pollFresh = fresh(h.lastPollCycleAt, h.pollIntervalSec * 3000);
  const ok = h.connected && pollFresh;
  const statusText = !h.connected
    ? "Disconnected — reconnecting"
    : !pollFresh
      ? "Connected, but no recent poll cycle"
      : "Connected & polling";

  return (
    <div className="panel">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Listener health</h2>
        <span style={{ fontSize: 12 }}>
          <span className={`dot ${ok ? "live" : "sim"}`} />
          {statusText}
          <span className="muted">
            {" · "}poll every {h.pollIntervalSec}s
            {h.lastPollCycleAt
              ? ` · last sweep ${dateTimeSec(h.lastPollCycleAt)} (${timeAgo(h.lastPollCycleAt)})`
              : ""}
          </span>
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Last message</th>
              <th>Last poll</th>
              <th>Recovered</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {h.groups.map((g) => (
              <tr key={g.groupId}>
                <td>
                  {g.name} <span className="muted">{g.channel}</span>
                </td>
                <td className="muted" title={g.lastMessageAt ? dateTimeSec(g.lastMessageAt) : ""}>
                  {g.lastMessageAt ? timeAgo(g.lastMessageAt) : "—"}
                </td>
                <td className="muted" title={g.lastPolledAt ? timeAgo(g.lastPolledAt) : ""}>
                  {g.lastPolledAt ? dateTimeSec(g.lastPolledAt) : "—"}
                </td>
                <td>{g.recoveredCount > 0 ? g.recoveredCount : <span className="muted">0</span>}</td>
                <td>
                  {g.lastError ? (
                    <span className="neg" title={g.lastError}>
                      error
                    </span>
                  ) : g.lastPolledAt ? (
                    <span className="pos">ok</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {h.groups.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No channels configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
