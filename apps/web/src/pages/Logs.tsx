import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LogEntry, LogLevel } from "@tttrading/shared";
import { api } from "../api.js";
import { shortTime } from "../format.js";

const CATEGORIES = ["all", "message", "exec", "manage", "monitor", "audit", "system"];
const LEVELS: LogLevel[] = ["info", "warn", "error"];

/** Pretty-print structured meta as indented JSON with light key/string/number highlighting. */
function highlightJson(value: unknown): ReactNode {
  const json = JSON.stringify(value, null, 2);
  const regex = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(json)) !== null) {
    if (m.index > lastIndex) nodes.push(json.slice(lastIndex, m.index));
    const token = m[0];
    if (token.startsWith('"')) {
      // A string followed (after optional whitespace) by ':' is an object key.
      const rest = json.slice(regex.lastIndex);
      const isKey = /^\s*:/.test(rest);
      nodes.push(
        <span key={key++} className={isKey ? "k" : "s"}>
          {token}
        </span>,
      );
    } else {
      nodes.push(
        <span key={key++} className="n">
          {token}
        </span>,
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < json.length) nodes.push(json.slice(lastIndex));
  return nodes;
}

export function Logs({ logs, onReload }: { logs: LogEntry[]; onReload: () => void }) {
  const [category, setCategory] = useState("all");
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({ info: true, warn: true, error: true });
  const [filterText, setFilterText] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Load history once on mount.
  useEffect(() => {
    onReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of logs) counts[l.category] = (counts[l.category] ?? 0) + 1;
    return counts;
  }, [logs]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const l of logs) counts[l.level] += 1;
    return counts;
  }, [logs]);

  const q = filterText.trim().toLowerCase();
  const shown = logs.filter((l) => {
    if (category !== "all" && l.category !== category) return false;
    if (!levels[l.level]) return false;
    if (q && !l.message.toLowerCase().includes(q) && !l.category.toLowerCase().includes(q)) return false;
    return true;
  });

  const toggleLevel = (lvl: LogLevel) => setLevels((s) => ({ ...s, [lvl]: !s[lvl] }));

  const clear = async () => {
    if (!confirm("Clear all logs?")) return;
    await api.clearLogs();
    onReload();
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>
            Event trace<span className="sub">structured · newest first · {logs.length} lines</span>
          </h2>
          <div className="actions">
            <span className="small muted">
              <span className="dot live" /> live
            </span>
            <button className="btn danger sm" onClick={clear}>
              Clear…
            </button>
          </div>
        </div>

        <div className="panel-body flush">
          <div
            className="between"
            style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}
          >
            <div className="flex">
              <div className="chips">
                {CATEGORIES.map((c) => (
                  <span
                    key={c}
                    className={`chip filter${category === c ? " active" : ""}`}
                    onClick={() => setCategory(c)}
                  >
                    {c === "all" ? "All" : c}
                    <span className="num">{c === "all" ? logs.length : catCounts[c] ?? 0}</span>
                  </span>
                ))}
              </div>
              <span className="hr" style={{ width: 1, height: 22, margin: "0 6px" }} />
              <div className="chips">
                {LEVELS.map((lvl) => (
                  <span
                    key={lvl}
                    className={`chip filter${levels[lvl] ? " active" : ""}`}
                    onClick={() => toggleLevel(lvl)}
                  >
                    {lvl}
                    <span className="num">{levelCounts[lvl]}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex">
              <input
                className="input"
                style={{ minWidth: 200 }}
                placeholder="Filter text…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              <div className="e-title">{logs.length === 0 ? "No logs yet" : "No matching lines"}</div>
              <div className="e-why">
                {logs.length === 0
                  ? "Incoming messages and executions appear here live."
                  : "No log lines match the current filters."}
              </div>
            </div>
          ) : (
            <div className="log">
              {shown.map((l) => {
                const hasMeta = !!l.meta;
                const isOpen = hasMeta && !!expanded[l.id];
                return (
                  <div key={l.id}>
                    <div
                      className={`log-line ${l.level}`}
                      style={hasMeta ? { cursor: "pointer" } : undefined}
                      onClick={() => hasMeta && setExpanded((s) => ({ ...s, [l.id]: !s[l.id] }))}
                    >
                      <span className="ts">{shortTime(l.ts)}</span>
                      <span className={`lvl ${l.level}`}>{l.level.toUpperCase()}</span>
                      <span className="cat">{l.category}</span>
                      <span className="lmsg">
                        {l.message}
                        {hasMeta && (
                          <>
                            {" "}
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                              style={{ transform: isOpen ? "rotate(180deg)" : undefined }}
                            >
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </>
                        )}
                      </span>
                    </div>
                    {isOpen && <div className="log-meta">{highlightJson(l.meta)}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel-foot">
          <span>
            Lines with structured <span className="mono">meta</span> expand to pretty-printed JSON.
          </span>
        </div>
      </section>
    </>
  );
}
