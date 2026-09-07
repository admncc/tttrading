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
        <div className="panel-head">
          <h2>
            Listener health<span className="sub">Telegram</span>
          </h2>
        </div>
        <div className="panel-body">
          <div className="flex">
            <span className="dot sim" />
            <span className="muted small">Telegram not configured — running on manual input only.</span>
          </div>
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
      <div className="panel-head">
        <h2>
          Listener health<span className="sub">Telegram</span>
        </h2>
        <div className="actions">
          <span className={`tag ${ok ? "ok" : "pending"}`}>{statusText}</span>
        </div>
      </div>
      <div className="panel-body flush">
        <div className="between" style={{ padding: "12px 16px 10px" }}>
          <div className="flex">
            <span className={`dot ${ok ? "live" : "sim"}`} />
            <span className="small muted">
              poll every {h.pollIntervalSec}s
              {h.lastPollCycleAt
                ? ` · last sweep ${dateTimeSec(h.lastPollCycleAt)} (${timeAgo(h.lastPollCycleAt)})`
                : ""}
            </span>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Last message</th>
                <th>Last poll</th>
                <th className="num">Recovered</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {h.groups.map((g) => (
                <tr key={g.groupId}>
                  <td>
                    <span className="w600">{g.name}</span>
                    <span className="sub">{g.channel}</span>
                  </td>
                  <td className="muted" title={g.lastMessageAt ? dateTimeSec(g.lastMessageAt) : ""}>
                    {g.lastMessageAt ? timeAgo(g.lastMessageAt) : "—"}
                  </td>
                  <td className="muted" title={g.lastPolledAt ? timeAgo(g.lastPolledAt) : ""}>
                    {g.lastPolledAt ? dateTimeSec(g.lastPolledAt) : "—"}
                  </td>
                  <td className="num">
                    {g.recoveredCount > 0 ? g.recoveredCount : <span className="muted">0</span>}
                  </td>
                  <td>
                    {g.lastError ? (
                      <span className="tag error" title={g.lastError}>
                        error
                      </span>
                    ) : g.lastPolledAt ? (
                      <span className="tag ok">ok</span>
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
    </div>
  );
}
