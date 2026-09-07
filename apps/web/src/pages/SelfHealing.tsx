import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelfHealingEntry, SelfHealingLearning } from "@tttrading/shared";
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

export function SelfHealing({
  live,
  liveLearnings,
}: {
  live: SelfHealingEntry[];
  liveLearnings: SelfHealingLearning[];
}) {
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState("claude-fable-5-1");
  const [autoRepair, setAutoRepair] = useState(false);
  const [vetoFlow, setVetoFlow] = useState(false);
  const [savedModel, setSavedModel] = useState("claude-fable-5-1");
  const [saving, setSaving] = useState(false);

  const [history, setHistory] = useState<SelfHealingEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "error" | "warn" | "ok">("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [learnings, setLearnings] = useState<SelfHealingLearning[]>([]);
  const [showLearnings, setShowLearnings] = useState(false);

  const reloadLearnings = useCallback(() => {
    api.selfHealingLearnings().then(setLearnings).catch(() => {});
  }, []);

  // Load settings + history once on mount.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setEnabled(s.selfHealingEnabled);
        setModel(s.selfHealingModel || "claude-fable-5-1");
        setSavedModel(s.selfHealingModel || "claude-fable-5-1");
        setAutoRepair(s.selfHealingAutoRepair);
        setVetoFlow(s.selfHealingVetoFlow);
      })
      .catch(() => {});
    reload();
    reloadLearnings();
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
  // A live entry (e.g. one that just got a comment) supersedes the fetched copy.
  const merged = useMemo(() => {
    const seen = new Set(live.map((h) => h.id));
    return [...live, ...history.filter((h) => !seen.has(h.id))];
  }, [live, history]);

  const mergedLearnings = useMemo(() => {
    const seen = new Set(liveLearnings.map((l) => l.id));
    return [...liveLearnings, ...learnings.filter((l) => !seen.has(l.id))];
  }, [liveLearnings, learnings]);

  const submitComment = async (id: string) => {
    const text = (drafts[id] ?? "").trim();
    if (!text) return;
    try {
      const res = await api.commentSelfHealing(id, text);
      // Reflect the saved comment on the fetched row and drop the draft; the new
      // learning + updated entry also arrive over WS, but update locally for snappiness.
      setHistory((prev) => prev.map((h) => (h.id === id ? res.entry : h)));
      setLearnings((prev) => [res.learning, ...prev.filter((l) => l.id !== res.learning.id)]);
      setDrafts((d) => ({ ...d, [id]: "" }));
    } catch (e) {
      alert(`Comment failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const deleteLearning = async (id: string) => {
    try {
      await api.deleteSelfHealingLearning(id);
      setLearnings((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

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
    selfHealingVetoFlow?: boolean;
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

  const toggleVetoFlow = async () => {
    const next = !vetoFlow;
    if (next && !enabled) {
      alert("Enable Self-Healing review first — veto flow uses the same reviewer.");
      return;
    }
    if (
      next &&
      !confirm(
        "Enable VETO FLOW?\n\nEvery derived action (new entries and management) will be submitted to the " +
          "reviewer BEFORE it executes, and blocked if the reviewer rejects it. This changes live trading " +
          "behaviour. If the reviewer is unavailable, actions proceed (fail-open). Continue?",
      )
    ) {
      return;
    }
    setVetoFlow(next);
    await save({ selfHealingVetoFlow: next });
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
          <button
            className={showLearnings ? "primary" : "ghost"}
            onClick={() => setShowLearnings((v) => !v)}
            title="The reviewer's accumulated memory, distilled from your comments"
          >
            🧠 Learnings ({mergedLearnings.length})
          </button>
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
        flags anything it got wrong. It's briefed with the same desk memory + channel instructions the parser
        uses, plus its own <strong>learnings</strong> (distilled from your comments below). Comment on any
        review to teach it — that note becomes a learning it's briefed with next time. Analysis only — it never
        changes anything on its own.
      </div>

      {showLearnings && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>🧠 Learnings (reviewer memory)</h2>
            <span className="muted" style={{ fontSize: 11 }}>
              Folded into every future review's briefing (most recent {Math.min(mergedLearnings.length, 60)} used).
            </span>
          </div>
          {mergedLearnings.length === 0 ? (
            <div className="empty" style={{ padding: "8px 0" }}>
              No learnings yet. Comment on a review below and it's added here.
            </div>
          ) : (
            mergedLearnings.map((l) => (
              <div
                key={l.id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                  {shortTime(l.ts)}
                </span>
                <span style={{ flex: 1, fontSize: 13 }}>{l.text}</span>
                <button className="ghost" style={{ fontSize: 11 }} onClick={() => deleteLearning(l.id)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

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
            <input
              type="checkbox"
              checked={vetoFlow}
              onChange={toggleVetoFlow}
              disabled={saving || !enabled}
            />
            <span>
              <strong>Veto flow</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {" "}
                — reviewer approves/blocks every action <em>before</em> it executes
              </span>
            </span>
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            The system still reads messages and derives actions as usual, but each derived action (new entries
            and management) is submitted to the reviewer as the final, independent decision instance — it
            approves the action or blocks it. <strong>This changes live behaviour.</strong> If the reviewer is
            unavailable, the action proceeds (fail-open), so an LLM outage never halts trading.
          </div>
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
                {h.phase === "veto" ? (
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 12,
                      color: h.decision === "reject" ? "var(--neg)" : "var(--pos)",
                    }}
                    title="Pre-execution veto decision"
                  >
                    {h.decision === "reject" ? "⛔ VETO · BLOCKED" : "✓ VETO · OK"}
                  </span>
                ) : (
                  <span
                    style={{ color: VERDICT_COLOR[h.verdict] ?? "var(--text)", fontWeight: 700, fontSize: 12 }}
                  >
                    {VERDICT_LABEL[h.verdict] ?? h.verdict.toUpperCase()}
                  </span>
                )}
                {h.groupName && (
                  <span className="tag" style={{ fontSize: 11 }}>
                    {h.groupName}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 200 }}>{h.summary}</span>
                {h.comment && <span title="you commented" style={{ fontSize: 12 }}>💬</span>}
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
                <div style={{ marginTop: 8, display: "grid", gap: 8 }} onClick={(e) => e.stopPropagation()}>
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
                  <div>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
                      Your comment {h.comment ? "" : "(becomes a learning the reviewer is briefed with)"}
                    </div>
                    {h.comment && (
                      <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                        💬 {h.comment}
                        {h.commentedAt && (
                          <span className="muted" style={{ fontSize: 11 }}> · {shortTime(h.commentedAt)}</span>
                        )}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <textarea
                        value={drafts[h.id] ?? ""}
                        onChange={(ev) => setDrafts((d) => ({ ...d, [h.id]: ev.target.value }))}
                        placeholder={
                          h.comment
                            ? "Add another note (it's added as a new learning)…"
                            : "e.g. correct — never close on a 'stopped breakeven' recap"
                        }
                        rows={2}
                        style={{ flex: 1, resize: "vertical", fontSize: 12.5 }}
                      />
                      <button
                        className="primary"
                        disabled={!(drafts[h.id] ?? "").trim()}
                        onClick={() => submitComment(h.id)}
                        style={{ alignSelf: "flex-start" }}
                      >
                        Teach
                      </button>
                    </div>
                  </div>
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
