import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelfHealingEntry, SelfHealingLearning } from "@tttrading/shared";
import { api } from "../api.js";
import { shortTime } from "../format.js";

/** A common option list; the desk can also type any model id by hand. */
const MODEL_OPTIONS = [
  { id: "claude-fable-5-1", label: "Fable 5.1 (default)" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-5", label: "Opus 5" },
];

type Filter = "all" | "ok" | "warn" | "error" | "veto";

/** The colored feed-row modifier for a single review row. */
function rowClass(h: SelfHealingEntry): string {
  if (h.phase === "veto") return h.decision === "reject" ? "veto" : "veto-ok";
  return h.verdict; // ok | warn | error | skipped
}

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
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [learnings, setLearnings] = useState<SelfHealingLearning[]>([]);
  const [hiddenLearningIds, setHiddenLearningIds] = useState<Set<string>>(new Set());

  const reloadLearnings = useCallback(() => {
    api.selfHealingLearnings().then(setLearnings).catch(() => {});
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
  }, [reload, reloadLearnings]);

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
    return [...liveLearnings, ...learnings.filter((l) => !seen.has(l.id))].filter((l) => !hiddenLearningIds.has(l.id));
  }, [liveLearnings, learnings, hiddenLearningIds]);

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
    // Optimistically hide it — the list renders `mergedLearnings`, which is
    // dominated by `liveLearnings` (WS-fed, a prop we can't mutate), so filtering
    // local `learnings` alone would leave the item on screen.
    setHiddenLearningIds((prev) => new Set(prev).add(id));
    try {
      await api.deleteSelfHealingLearning(id);
      setLearnings((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      // Roll the hide back so the failed item reappears.
      setHiddenLearningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const stats = useMemo(() => {
    const s = { total: 0, ok: 0, warn: 0, error: 0, skipped: 0, vetoBlocked: 0, vetoOk: 0, errUncommented: 0 };
    for (const h of merged) {
      s.total++;
      if (h.phase === "veto") {
        if (h.decision === "reject") s.vetoBlocked++;
        else s.vetoOk++;
      }
      if (h.verdict === "error") {
        s.error++;
        if (!h.comment) s.errUncommented++;
      } else if (h.verdict === "warn") s.warn++;
      else if (h.verdict === "ok") s.ok++;
      else if (h.verdict === "skipped") s.skipped++;
    }
    return s;
  }, [merged]);

  const vetoCount = stats.vetoBlocked + stats.vetoOk;
  const pct = (n: number) => (stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);

  const shown = merged.filter((h) =>
    filter === "all" ? true : filter === "veto" ? h.phase === "veto" : h.verdict === filter,
  );

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
    if (next && !vetoFlow) {
      alert("Turn on Veto flow first — auto-repair only acts on an action the veto blocked.");
      return;
    }
    if (
      next &&
      !confirm(
        "Enable AUTO-REPAIR?\n\nWhen the veto blocks an action AND the reviewer is ≥75% confident, the " +
          "reviewer's corrected action is applied AUTOMATICALLY — including moving stops, booking/closing, " +
          "and OPENING or CLOSING whole positions on real money. Continue?",
      )
    ) {
      return;
    }
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
    // Auto-repair requires veto — turning veto off also turns auto-repair off.
    if (!next && autoRepair) {
      setAutoRepair(false);
      await save({ selfHealingVetoFlow: next, selfHealingAutoRepair: false });
      return;
    }
    await save({ selfHealingVetoFlow: next });
  };

  const clear = async () => {
    if (!confirm("Clear all Self-Healing analyses?")) return;
    await api.clearSelfHealing();
    reload();
  };

  return (
    <>
      {/* ---------------- Independent reviewer ---------------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Independent reviewer
            <span className="sub">briefed with global memory + channel instructions + its own learnings</span>
          </h2>
          {vetoFlow && (
            <div className="actions">
              <span className="tag error">veto active</span>
              {autoRepair && <span className="tag brand">auto-repair active</span>}
              <span className="tag warn plain">fail-open</span>
            </div>
          )}
        </div>
        <div className="panel-body">
          <div
            className="form-grid"
            style={{ gridTemplateColumns: "1.2fr 1fr 1.2fr 1fr", gap: "16px 24px" }}
          >
            <div>
              <span
                className={`switch${enabled ? " on" : ""}${saving ? " disabled" : ""}`}
                role="switch"
                aria-checked={enabled}
                onClick={() => {
                  if (!saving) void toggleEnabled();
                }}
              >
                <span className="track" />
                <span className="sw-text">
                  <span>Enable Self-Healing review</span>
                  <span className="hint">review every incoming message and the action derived from it</span>
                </span>
              </span>
            </div>

            <div className="field">
              <label htmlFor="heal-model">Model</label>
              <input
                id="heal-model"
                className="input mono"
                list="heal-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => model.trim() && model !== savedModel && save({ selfHealingModel: model.trim() })}
                placeholder="claude-fable-5-1"
              />
              <datalist id="heal-models">
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
              {model !== savedModel ? (
                <button
                  className="btn primary sm mt8"
                  disabled={saving || !model.trim()}
                  onClick={() => save({ selfHealingModel: model.trim() })}
                >
                  Save
                </button>
              ) : (
                <span className="hint">any model id can be entered</span>
              )}
            </div>

            <div>
              <span
                className={`switch danger${vetoFlow ? " on" : ""}${saving || !enabled ? " disabled" : ""}`}
                role="switch"
                aria-checked={vetoFlow}
                onClick={() => {
                  if (!saving && enabled) void toggleVetoFlow();
                }}
              >
                <span className="track" />
                <span className="sw-text">
                  <span>Veto flow — pre-execution gate</span>
                  <span className="hint">
                    reviewer approves or blocks every action before it executes · fail-open if unavailable
                  </span>
                </span>
              </span>
            </div>

            <div>
              <span
                className={`switch danger${autoRepair ? " on" : ""}${saving || !vetoFlow ? " disabled" : ""}`}
                role="switch"
                aria-checked={autoRepair}
                title={vetoFlow ? undefined : "Requires Veto flow on"}
                onClick={() => {
                  if (!saving && (vetoFlow || autoRepair)) void toggleAutoRepair();
                }}
              >
                <span className="track" />
                <span className="sw-text">
                  <span>Auto-repair</span>
                  <span className="hint">
                    requires veto · applies the reviewer's fix on a blocked action when ≥75% confident
                    (incl. opening/closing positions)
                  </span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Verdict KPIs ---------------- */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
        <div className="kpi">
          <div className="label">Reviews</div>
          <div className="value">{stats.total}</div>
          <div className="delta">every message reviewed</div>
        </div>
        <div className="kpi">
          <div className="label">OK</div>
          <div className="value">
            <span className="gain">{stats.ok}</span>
          </div>
          <div className="delta">{pct(stats.ok)}%</div>
        </div>
        <div className="kpi">
          <div className="label">Warn</div>
          <div className="value">
            <span className="warn">{stats.warn}</span>
          </div>
          <div className="delta">{pct(stats.warn)}%</div>
        </div>
        <div className="kpi">
          <div className="label">Error</div>
          <div className="value">
            <span className="loss">{stats.error}</span>
          </div>
          <div className="delta">
            {pct(stats.error)}%
            {stats.errUncommented > 0 && ` · ${stats.errUncommented} uncommented`}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Vetoes</div>
          <div className="value">
            <span className="loss">{stats.vetoBlocked}</span> <small>blocked</small> ·{" "}
            <span className="gain">{stats.vetoOk}</span> <small>ok</small>
          </div>
          <div className="delta">pre-execution gate</div>
        </div>
        <div className="kpi">
          <div className="label">Learnings</div>
          <div className="value">{mergedLearnings.length}</div>
          <div className="delta">briefed on every review</div>
        </div>
      </div>

      {/* ---------------- Feed + side panels ---------------- */}
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        {/* Review feed */}
        <section className="panel">
          <div className="panel-head">
            <h2>
              Review feed<span className="sub">verdict-colored · veto rows render distinctly</span>
            </h2>
          </div>
          <div className="panel-body flush">
            <div className="between" style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
              <div className="seg">
                {(
                  [
                    ["all", "All", stats.total],
                    ["ok", "OK", stats.ok],
                    ["warn", "Warn", stats.warn],
                    ["error", "Error", stats.error],
                    ["veto", "Veto", vetoCount],
                  ] as const
                ).map(([id, label, n]) => (
                  <span
                    key={id}
                    className={`seg-item${filter === id ? " active" : ""}`}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                    <span className="n">{n}</span>
                  </span>
                ))}
              </div>
              <div className="flex">
                <span className="small muted">
                  <span className="dot live" /> live · newest first
                </span>
                <button className="btn ghost sm" onClick={reload} disabled={loading} title="Refresh">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v5h5" />
                  </svg>
                </button>
                <button className="btn danger sm" onClick={clear}>
                  Clear…
                </button>
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="empty">
                <span className="e-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12h4l2-5 4 10 2-5h6" />
                  </svg>
                </span>
                <div className="e-title">{loading ? "Loading…" : "No reviews yet"}</div>
                <div className="e-why">
                  {loading
                    ? "Fetching the review feed…"
                    : enabled
                      ? "Each incoming message is reviewed here as it arrives."
                      : "Self-Healing is off. Enable review above to start judging incoming messages."}
                </div>
              </div>
            ) : (
              <div className="feed">
                {shown.map((h) => {
                  const isVeto = h.phase === "veto";
                  const open = !!expanded[h.id];
                  return (
                    <div key={h.id}>
                      <div
                        className={`feed-row ${rowClass(h)}`}
                        role="button"
                        aria-expanded={open}
                        onClick={() => setExpanded((e) => ({ ...e, [h.id]: !e[h.id] }))}
                      >
                        <span className="vbar" />
                        <span>
                          {h.phase === "repair" ? (
                            <span className={`tag ${h.verdict === "error" ? "error" : "brand"} plain`}>
                              🔧 auto-repair{h.verdict === "error" ? " · failed" : ""}
                            </span>
                          ) : isVeto ? (
                            h.decision === "reject" ? (
                              <span className="tag error plain">⛔ veto · blocked</span>
                            ) : (
                              <span className="tag ok plain">✓ veto · ok</span>
                            )
                          ) : (
                            <span className={`tag ${h.verdict}`}>{h.verdict}</span>
                          )}
                        </span>
                        <span className="gist">
                          {h.summary}
                          {h.comment && " 💬"}
                          {h.systemAction && <span className="sys">→ {h.systemAction}</span>}
                        </span>
                        <span className="small ink2">{h.groupName ?? "—"}</span>
                        <span className="conf">
                          {h.confidence > 0 ? `conf ${h.confidence.toFixed(2)}` : "conf —"}
                        </span>
                        <span className="when">{shortTime(h.ts)}</span>
                        <span
                          className="chev"
                          style={{ transform: open ? "rotate(180deg)" : undefined }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </span>
                      </div>

                      {open && (
                        <div className="feed-detail">
                          <div>
                            {h.messageExcerpt && (
                              <>
                                <span className="caps">
                                  Original message{h.groupName ? ` · ${h.groupName}` : ""} · {shortTime(h.ts)}
                                </span>
                                <div className="quote mt8">{h.messageExcerpt}</div>
                              </>
                            )}
                            {h.systemAction && (
                              <>
                                <span className="caps mt12" style={{ display: "block" }}>
                                  What the system did
                                </span>
                                <div className="quote mono mt8">{h.systemAction}</div>
                              </>
                            )}
                          </div>

                          <div>
                            {h.suggestion && (
                              <div className="callout suggest">
                                <span className="k">Suggestion</span>
                                {h.suggestion}
                              </div>
                            )}
                            {h.comment && (
                              <div className={`callout learn${h.suggestion ? " mt12" : ""}`}>
                                <span className="k">Your comment → learning</span>
                                {h.comment}
                                {h.commentedAt && (
                                  <div className="small muted mt8">saved {shortTime(h.commentedAt)}</div>
                                )}
                              </div>
                            )}
                            <div className="field mt12">
                              <label htmlFor={`teach-${h.id}`}>
                                Teach the reviewer{" "}
                                <span className="hint">
                                  {h.comment ? "adds another learning" : "your note becomes a learning it's briefed with"}
                                </span>
                              </label>
                              <textarea
                                id={`teach-${h.id}`}
                                className="input"
                                value={drafts[h.id] ?? ""}
                                onChange={(ev) => setDrafts((d) => ({ ...d, [h.id]: ev.target.value }))}
                                placeholder={
                                  h.comment
                                    ? "Add another correction or context…"
                                    : "e.g. correct — never close on a 'stopped breakeven' recap"
                                }
                                style={{ minHeight: 56 }}
                              />
                            </div>
                            <div className="between mt8">
                              <span className="small muted">
                                model {h.model}
                                {isVeto && ` · ${h.decision === "reject" ? "blocked" : "approved"}`}
                              </span>
                              <button
                                className="btn primary sm"
                                disabled={!(drafts[h.id] ?? "").trim()}
                                onClick={() => submitComment(h.id)}
                              >
                                Save comment
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="panel-foot">
            <span>{merged.length} reviews loaded</span>
            {cursor && (
              <button className="btn ghost sm" onClick={loadMore} disabled={loading}>
                {loading ? "Loading…" : "Load older"}
              </button>
            )}
          </div>
        </section>

        {/* Side column */}
        <div className="col">
          {/* Learnings */}
          <section className="panel">
            <div className="panel-head">
              <h2>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 2 3v1a3 3 0 0 0 3 3h1V4z" />
                  <path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-2 3v1a3 3 0 0 1-3 3h-1V4z" />
                </svg>
                Learnings
                <span className="sub">the reviewer's accumulated memory · {mergedLearnings.length}</span>
              </h2>
            </div>
            <div className="panel-body">
              {mergedLearnings.length === 0 ? (
                <div className="empty">
                  <div className="e-why">No learnings yet. Comment on a review and it's distilled into one here.</div>
                </div>
              ) : (
                mergedLearnings.map((l) => (
                  <div key={l.id} className="learning">
                    <div>
                      <div>{l.text}</div>
                      <div className="src">
                        {l.groupName ? `${l.groupName} · ` : ""}
                        {shortTime(l.ts)}
                      </div>
                    </div>
                    <button
                      className="btn ghost icon sm"
                      title="Delete learning"
                      onClick={() => deleteLearning(l.id)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="panel-foot">
              <span>Every comment you save is distilled into one durable learning and briefed on all future reviews.</span>
            </div>
          </section>

          {/* How the loop works */}
          <section className="panel">
            <div className="panel-head">
              <h2>How the loop works</h2>
            </div>
            <div className="panel-body">
              <div className="stack" style={{ gap: 8 }}>
                <div className="flex">
                  <span className="tag review">1 · review</span>
                  <span className="small">independent LLM re-reads the message and judges the action</span>
                </div>
                <div className="flex">
                  <span className="tag brand">2 · teach</span>
                  <span className="small">you comment on a review → it becomes a learning</span>
                </div>
                <div className="flex">
                  <span className="tag error">3 · veto</span>
                  <span className="small">
                    with veto flow on, it approves or blocks every action <b>before</b> execution
                  </span>
                </div>
                <div
                  className="callout mt8"
                  style={{ borderColor: "var(--warn-line)", background: "var(--warn-soft)" }}
                >
                  <span className="k" style={{ color: "var(--warn)" }}>
                    Fail-open
                  </span>
                  If the reviewer is unavailable the action proceeds — an LLM outage never halts trading.
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
