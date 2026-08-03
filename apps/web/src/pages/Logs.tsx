import { useEffect, useState } from "react";
import type { LogEntry } from "@tttrading/shared";
import { api } from "../api.js";
import { shortTime } from "../format.js";

const LEVEL_COLOR: Record<string, string> = {
  info: "var(--muted)",
  warn: "var(--warn)",
  error: "var(--neg)",
};

const CATEGORIES = ["all", "message", "exec", "manage", "monitor", "audit", "system"];

export function Logs({ logs, onReload }: { logs: LogEntry[]; onReload: () => void }) {
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Load history once on mount.
  useEffect(() => {
    onReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = logs.filter((l) => (category === "all" ? true : l.category === category));

  const clear = async () => {
    if (!confirm("Clear all logs?")) return;
    await api.clearLogs();
    onReload();
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Logs</h1>
        <div className="btn-row">
          {CATEGORIES.map((c) => (
            <button key={c} className={category === c ? "primary" : "ghost"} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
          <button className="danger" onClick={clear}>
            Clear
          </button>
        </div>
      </div>

      <div className="panel" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}>
        {shown.length === 0 ? (
          <div className="empty">No logs yet. Incoming messages and executions appear here live.</div>
        ) : (
          shown.map((l) => (
            <div
              key={l.id}
              style={{ padding: "4px 0", borderBottom: "1px solid var(--border)", cursor: l.meta ? "pointer" : "default" }}
              onClick={() => l.meta && setExpanded((e) => ({ ...e, [l.id]: !e[l.id] }))}
            >
              <span className="muted">{shortTime(l.ts)}</span>{" "}
              <span style={{ color: LEVEL_COLOR[l.level] ?? "var(--text)" }}>
                {l.level.toUpperCase()}
              </span>{" "}
              <span className="tag" style={{ fontSize: 11 }}>{l.category}</span>{" "}
              <span>{l.message}</span>
              {l.meta && expanded[l.id] && (
                <pre
                  style={{
                    margin: "6px 0 2px",
                    padding: 8,
                    background: "var(--bg)",
                    borderRadius: 6,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {JSON.stringify(l.meta, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
