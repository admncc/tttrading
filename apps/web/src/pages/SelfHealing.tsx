import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelfHealingEntry } from "@tttrading/shared";
import { api } from "../api.js";
import { shortTime } from "../format.js";

const VERDICT_COLOR: Record<string, string> = {
  ok: "var(--pos)",
  warn: "var(--warn)",
  error: "var(--neg)",
  skipped: "var(--muted)",
};

const VERDICT_LABEL: Record<string, string> = {
  ok: "OK",
  warn: "WARN",
  error: "ERROR",
  skipped: "SKIPPED",
};

/** A common option list; the desk can also type any model id by hand. */
const MODEL_OPTIONS = [
  { id: "claude-fable-5-1", label: "Fable 5.1 (default)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5", label: "Opus 5" },
];

export function SelfHealing({ live }: { live: SelfHealingEntry[] }) {
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState("claude-fable-5-1");
  const [autoRepair, setAutoRepair] = useState(false);
  const [savedModel, setSavedModel] = useState("claude-fable-5-1");
  const [saving, setSaving] = useState(false);

  const [history, setHistory] = useState<SelfHealingEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "error" | "warn" | "ok">("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Load settings + history once on mount.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setEnabled(s.selfHealingEnabled);
        setModel(s.selfHealingModel || "claude-fable-5-1");
        setSavedModel(s.selfHealingModel || "claude-fable-5-1");
        setAutoRepair(s.selfHealingAutoRepair);
      })
      .catch(() => {});
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .selfHealing({ limit: 200 })
      .then((r) => {
        setHistory(r.entries);
        setCursor(r.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadMore = () => {
    if (!cursor) return;
    setLoading(true);
    api
      .selfHealing({ limit: 200, before: cursor })
      .then((r) => {
        setHistory((prev) => [...prev, ...r.entries]);
        setCursor(r.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // Merge live WS entries (newest) ahead of the fetched history, de-duped by id.
  const merged = useMemo(() => {
    const seen = new Set(live.map((h) => h.id));
    return [...live, ...history.filter((h) => !seen.has(h.id))];
  }, [live, history]);

  const shown = merged.filter((h) => (filter === "all" ? true : h.verdict === filter));
  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, ok: 0 };
    for (const h of merged) {
      if (h.verdict === "error") c.error++;
      else if (h.verdict === "warn") c.warn++;
      else if (h.verdict === "ok") c.ok++;
    }
    return c;
  }, [merged]);

  const save = async (patch: {
    selfHealingEnabled?: boolean;
    selfHealingModel?: string;
    selfHealingAutoRepair?: boolean;
  }) => {
    setSaving(true);
    try {
      await api.updateSettings(patch);
      if (patch.selfHealingModel !== undefined) setSavedModel(patch.selfHealingModel);
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    await save({ selfHealingEnabled: next });
  };

  const toggleAutoRepair = async () => {
    const next = !autoRepair;
    setAutoRepair(next);
    await save({ selfHealingAutoRepair: next });
  };

  const clear = async () => {
    if (!confirm("Clear all Self-Healing analyses?")) return;
    await api.clearSelfHealing();
    reload();
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Self Healing</h1>
        <div className="btn-row">
          {(["all", "error", "warn", "ok"] as const).map((f) => (
            <button key={f} className={filter === f ? "primary" : "ghost"} onClick={() => setFilter(f)}>
              {f === "all"
                ? "all"
                : `${f} (${f === "error" ? counts.error : f === "warn" ? counts.warn : counts.ok})`}
            </button>
          ))}
          <button className="ghost" onClick={reload}>
            ↻
          </button>
          <button className="danger" onClick={clear}>
            Clear
          </button>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, margin: "6px 2px 12px" }}>
        An independent LLM re-reads every incoming message and the action the system derived from it, and
        flags anything it got wrong. Analysis only — it never changes anything on its own.
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={enabled} onChange={toggleEnabled} disabled={saving} />
            <span>
              <strong>Enable Self-Healing review</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {" "}
                — review every incoming message
              </span>
            </span>
          </label>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Model
            </span>
            <input
              list="heal-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => model.trim() && model !== savedModel && save({ selfHealingModel: model.trim() })}
              style={{ width: 240 }}
              placeholder="claude-fable-5-1"
            />
            <datalist id="heal-models">
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
            {model !== savedModel && (
              <button
                className="primary"
                disabled={saving || !model.trim()}
                onClick={() => save({ selfHealingModel: model.trim() })}
              >
                Save
              </button>
            )}
          </label>
        </div>

        <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={autoRepair} onChange={toggleAutoRepair} disabled={saving} />
            <span>
              <strong>Auto-repair</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {" "}
                — automatically apply low-risk fixes from the review
              </span>
            </span>
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            ⚠ Not active yet — this preference is stored but the reviewer never changes anything. Leave it off
            until the analyze-only reviews have proven reliable, then turn it on to let the system self-repair.
          </div>
        </div>
      </div>

      <div className="panel">
        {shown.length === 0 ? (
          <div className="empty">
            {loading
              ? "Loading…"
              : enabled
                ? "No analyses yet. Each incoming message is reviewed here as it arrives."
                : "Self-Healing is off. Enable it above to start reviewing incoming messages."}
          </div>
        ) : (
          shown.map((h) => (
            <div
              key={h.id}
              style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
              onClick={() => setExpanded((e) => ({ ...e, [h.id]: !e[h.id] }))}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {shortTime(h.ts)}
                </span>
                <span
                  style={{ color: VERDICT_COLOR[h.verdict] ?? "var(--text)", fontWeight: 700, fontSize: 12 }}
                >
                  {VERDICT_LABEL[h.verdict] ?? h.verdict.toUpperCase()}
                </span>
                {h.groupName && (
                  <span className="tag" style={{ fontSize: 11 }}>
                    {h.groupName}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 200 }}>{h.summary}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {Math.round((h.confidence ?? 0) * 100)}% · {h.model}
                </span>
              </div>
              {h.suggestion && (
                <div
                  style={{
                    fontSize: 12.5,
                    marginTop: 4,
                    color: h.verdict === "error" ? "var(--neg)" : "var(--warn)",
                  }}
                >
                  → {h.suggestion}
                </div>
              )}
              {expanded[h.id] && (
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {h.messageExcerpt && (
                    <div>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                        Incoming message
                      </div>
                      <pre style={preStyle}>{h.messageExcerpt}</pre>
                    </div>
                  )}
                  {h.systemAction && (
                    <div>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                        What the system did
                      </div>
                      <pre style={preStyle}>{h.systemAction}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {cursor && (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button className="ghost" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: "var(--bg)",
  borderRadius: 6,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};
