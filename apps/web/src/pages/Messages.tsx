import { useState } from "react";
import type { Group, Signal } from "@tttrading/shared";
import { shortTime } from "../format.js";
import { RiskDot } from "../components/Risk.js";

/**
 * Raw channel message feed. Every message from a tracked channel is recorded
 * (even non-signals), so this is where we watch what the channels actually post
 * — useful for tuning parsing together.
 */
export function Messages({ signals, groups }: { signals: Signal[]; groups: Group[] }) {
  const [groupId, setGroupId] = useState<string>("all");

  const shown = signals.filter((s) => (groupId === "all" ? true : s.groupId === groupId));

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Messages</h1>
        <select
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          style={{ width: 220 }}
        >
          <option value="all">All channels</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.telegramChannel})
            </option>
          ))}
        </select>
      </div>

      <div className="panel">
        {shown.length === 0 ? (
          <div className="empty">
            No messages yet. Once your Telegram session is connected and a channel
            is added as a group, messages appear here live.
          </div>
        ) : (
          shown.map((s) => (
            <div
              key={s.id}
              style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4 }}>
                <strong>{s.groupName}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {shortTime(s.receivedAt)}
                </span>
                <RiskDot risk={s.risk} />
                <span className={`tag ${s.status}`}>{s.status}</span>
                {s.parsed && (
                  <span className={`tag ${s.parsed.side}`}>
                    {s.parsed.side.toUpperCase()} {s.parsed.symbol}
                  </span>
                )}
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{s.rawText}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
