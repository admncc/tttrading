import { useState } from "react";
import type { Group, Signal } from "@tttrading/shared";
import { api } from "../api.js";
import { shortTime } from "../format.js";
import { RiskDot } from "../components/Risk.js";

/**
 * Raw channel message feed. Every message from a tracked channel is recorded
 * (even non-signals), so this is where we watch what the channels actually post
 * — useful for tuning parsing together.
 */
export function Messages({
  signals,
  groups,
  onChange,
}: {
  signals: Signal[];
  groups: Group[];
  onChange: () => void;
}) {
  const [groupId, setGroupId] = useState<string>("all");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const shown = signals.filter((s) => (groupId === "all" ? true : s.groupId === groupId));

  const runBackfill = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.backfill(days);
      const total = res.reduce((s, r) => s + r.imported, 0);
      const errs = res.filter((r) => r.error);
      setResult(
        `Imported ${total} messages from ${res.length} channels.` +
          (errs.length ? ` Errors: ${errs.map((e) => `${e.groupName} (${e.error})`).join(", ")}` : ""),
      );
      onChange();
    } catch (e) {
      setResult(`Backfill failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

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

      <div className="panel" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="muted">Import channel history for learning:</span>
        <input
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ width: 90 }}
        />
        <span className="muted">days</span>
        <button className="primary" disabled={busy} onClick={runBackfill}>
          {busy ? "Importing…" : "Import"}
        </button>
        {result && <span className="muted" style={{ fontSize: 12 }}>{result}</span>}
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
