import { useState } from "react";
import type { ReactNode } from "react";
import type { BacktestResult, Group, GroupInput } from "@tttrading/shared";
import { api } from "../api.js";
import { pct, shortTime, usd } from "../format.js";

// Tuned baseline for a new group (matches how our providers actually post):
// group leverage 4x, fixed 1000 USD size, market/limit auto-picked per signal,
// single-target signals auto-split into 3 TPs, no auto break-even (SL only moves
// on the trader's own management messages), red-rated signals still execute
// (traffic-light is informational), and a 30-min same-symbol cooldown to swallow
// reposts. The global live-order cap still limits real size on top of this.
const BLANK: GroupInput = {
  name: "",
  telegramChannel: "",
  enabled: true,
  settings: {
    leverage: 4,
    tradeSizeUsd: 1000,
    executionMode: "auto",
    marginMode: "cross",
    maxSlippage: 0.01,
    autoSplitSingleTp: true,
    tpLevels: 3,
    defaultPartialPct: 50,
    breakevenAfterTp: 0,
    slWideningMult: 1,
    defaultStopPct: 0,
    blockRedTrades: false,
    entryMode: "limit",
    limitTimeoutHours: 336,
    symbolCooldownMinutes: 30,
    instructions: "",
  },
};

interface Suggestion {
  instructions: string;
  rationale: string;
  sampleSize: number;
  error?: string;
}

/* ---------- tiny inline icons ---------- */
const svgProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const IconPlus = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const IconCheck = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M5 12l4 4L19 6" />
  </svg>
);
const IconWarn = () => (
  <svg {...svgProps} width={12} height={12} aria-hidden="true">
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v4M12 17.5h.01" />
  </svg>
);
const IconPlay = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M7 4l12 8-12 8z" />
  </svg>
);
const IconDownload = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
  </svg>
);
const IconTrash = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </svg>
);
const IconSparkle = () => (
  <svg {...svgProps} aria-hidden="true">
    <path d="M12 3l1.8 4.9L18.7 9l-4.9 1.8L12 15l-1.8-4.2L5.3 9l4.9-1.1z" />
  </svg>
);

/* ---------- switch ---------- */
function Toggle({
  on,
  onClick,
  tone,
  disabled,
  stop,
  children,
}: {
  on: boolean;
  onClick: () => void;
  tone?: "warn" | "danger";
  disabled?: boolean;
  stop?: boolean;
  children?: ReactNode;
}) {
  const act = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    if (disabled) return;
    if (stop) e.stopPropagation();
    onClick();
  };
  return (
    <span
      className={`switch${tone ? ` ${tone}` : ""}${on ? " on" : ""}${disabled ? " disabled" : ""}`}
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => act(e)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          act(e);
        }
      }}
    >
      <span className="track" />
      {children ? <span className="sw-text">{children}</span> : null}
    </span>
  );
}

function tone(n: number): string {
  return n > 0 ? "gain" : n < 0 ? "loss" : "";
}

/* ---------- backtest result ---------- */
function BacktestView({ r }: { r: BacktestResult }) {
  if (r.error) {
    return (
      <div className="callout" style={{ borderColor: "var(--loss-line)", background: "var(--loss-soft)" }}>
        <span className="loss">Analysis error: {r.error}</span>
      </div>
    );
  }
  const s = r.stats;
  return (
    <div className="callout">
      <span className="k">Backtest</span>
      <div className="small muted mb8">
        re-parsed {r.reparsed} · tested {r.tested} · skipped {r.skipped} · risk{" "}
        <span className="gain num">{r.riskCounts.green}</span> ·{" "}
        <span className="warn num">{r.riskCounts.yellow}</span> ·{" "}
        <span className="loss num">{r.riskCounts.red}</span>
      </div>
      {r.tested === 0 ? (
        <div className="small muted">
          No simulatable signals (channel is mostly prose/management — better handled with
          per-channel instructions + LLM).
        </div>
      ) : (
        <div className="stat-grid">
          <div className="stat">
            <div className="caps">Win rate</div>
            <div className="v num">{pct(s.winRate)}</div>
          </div>
          <div className="stat">
            <div className="caps">PnL (sim)</div>
            <div className={`v num ${tone(s.realizedPnl)}`}>{usd(s.realizedPnl)}</div>
          </div>
          <div className="stat">
            <div className="caps">Profit factor</div>
            <div className="v num">
              {Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"}
            </div>
          </div>
          <div className="stat">
            <div className="caps">Avg / trade</div>
            <div className={`v num ${tone(s.avgPnl)}`}>{usd(s.avgPnl)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- AI suggestion callout ---------- */
function SuggestionCallout({
  s,
  busy,
  onApply,
  onDismiss,
}: {
  s: Suggestion;
  busy: boolean;
  onApply: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState(s.instructions);
  if (s.error) {
    return (
      <div className="callout mt12" style={{ borderColor: "var(--loss-line)", background: "var(--loss-soft)" }}>
        <span className="loss">AI suggestion failed: {s.error}</span>
        <div className="btn-row mt8">
          <button className="btn ghost sm" onClick={onDismiss}>
            Dismiss suggestions
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="callout learn mt12">
      <span className="k">Suggested from channel history · from {s.sampleSize} messages</span>
      {s.rationale && <div className="small mb8">{s.rationale}</div>}
      <textarea
        className="input"
        style={{ minHeight: 100 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="btn-row mt8">
        <button
          className="btn primary sm"
          disabled={busy || !s.instructions.trim()}
          onClick={() => onApply(s.instructions.trim())}
          title="Replace the channel instructions with the full AI suggestion"
        >
          <IconCheck />
          {busy ? "Applying…" : "Apply all"}
        </button>
        <button
          className="btn sm"
          disabled={busy || !text.trim()}
          onClick={() => onApply(text.trim())}
          title="Replace the channel instructions with your edited version above"
        >
          Apply selected
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onDismiss}>
          Dismiss suggestions
        </button>
      </div>
    </div>
  );
}

export function Groups({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<GroupInput | null>(null);
  const [saving, setSaving] = useState(false);

  const [results, setResults] = useState<Record<string, BacktestResult>>({});
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const toInput = (g: Group): GroupInput => ({
    name: g.name,
    telegramChannel: g.telegramChannel,
    enabled: g.enabled,
    settings: g.settings,
  });

  const selectedGroup = selectedId ? groups.find((g) => g.id === selectedId) ?? null : null;
  const enabledCount = groups.filter((g) => g.enabled).length;
  const dirty =
    !creating &&
    !!draft &&
    !!selectedGroup &&
    JSON.stringify(draft) !== JSON.stringify(toInput(selectedGroup));

  const selectGroup = (g: Group) => {
    setCreating(false);
    setSelectedId(g.id);
    setDraft(toInput(g));
  };
  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setDraft({ ...BLANK, settings: { ...BLANK.settings } });
  };
  const discard = () => {
    if (creating) {
      setCreating(false);
      setDraft(null);
    } else if (selectedGroup) {
      setDraft(toInput(selectedGroup));
    }
  };

  const set = (patch: Partial<GroupInput>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const setS = (patch: Partial<GroupInput["settings"]>) =>
    setDraft((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (creating) {
        await api.createGroup(draft);
        setCreating(false);
        setDraft(null);
        setSelectedId(null);
      } else if (selectedId) {
        await api.updateGroup(selectedId, draft);
      }
      onChange();
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (g: Group) => {
    try {
      await api.updateGroup(g.id, {
        name: g.name,
        telegramChannel: g.telegramChannel,
        enabled: !g.enabled,
        settings: g.settings,
      });
      if (selectedId === g.id) set({ enabled: !g.enabled });
      onChange();
    } catch (e) {
      alert(`Toggle failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this group?")) return;
    try {
      await api.deleteGroup(id);
      if (selectedId === id) {
        setSelectedId(null);
        setDraft(null);
      }
      onChange();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const analyze = async (id: string) => {
    setAnalyzing(id);
    try {
      const res = await api.backtest(id);
      setResults((r) => ({ ...r, [id]: res }));
    } catch (e) {
      alert(`Analyze failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setAnalyzing(null);
    }
  };

  const suggest = async (id: string) => {
    setSuggesting(id);
    try {
      const res = await api.suggestInstructions(id);
      setSuggestions((s) => ({ ...s, [id]: res }));
    } catch (e) {
      alert(`Suggestion failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSuggesting(null);
    }
  };

  const applyInstructions = async (g: Group, text: string) => {
    setApplying(g.id);
    try {
      await api.updateGroup(g.id, {
        name: g.name,
        telegramChannel: g.telegramChannel,
        enabled: g.enabled,
        settings: { ...g.settings, instructions: text },
      });
      setSuggestions((s) => {
        const next = { ...s };
        delete next[g.id];
        return next;
      });
      if (selectedId === g.id) setS({ instructions: text });
      onChange();
    } catch (e) {
      alert(`Apply failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setApplying(null);
    }
  };

  const dismissSuggestion = (id: string) =>
    setSuggestions((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });

  const showEditor = creating || (selectedId !== null && selectedGroup !== null);

  return (
    <div className="grid-12" style={{ gridTemplateColumns: "300px minmax(0,1fr)", alignItems: "start" }}>
      {/* ---------- LEFT: channels list ---------- */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Channels
            <span className="sub">
              {enabledCount} of {groups.length} enabled
            </span>
          </h2>
          <div className="actions">
            <button
              className="btn ghost sm"
              onClick={() => api.exportAll().catch((e) => alert(String(e)))}
              title="Export all channels (.txt)"
            >
              <IconDownload />
            </button>
            <button className="btn primary icon sm" title="Add channel" onClick={startCreate}>
              <IconPlus />
            </button>
          </div>
        </div>
        <div className="panel-body">
          {groups.length === 0 && !creating ? (
            <div className="empty">
              <div className="e-icon">
                <IconPlus />
              </div>
              <div className="e-title">No channels yet</div>
              <div className="e-why">Add one to start listening for signals.</div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {groups.map((g) => {
                const selected = !creating && selectedId === g.id;
                const conf = g.settings.executionMode === "confirm";
                return (
                  <div
                    key={g.id}
                    className="callout"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      cursor: "pointer",
                      ...(selected
                        ? { borderColor: "var(--champagne-line)", background: "var(--champagne-soft)" }
                        : {}),
                    }}
                    onClick={() => selectGroup(g)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectGroup(g);
                      }
                    }}
                  >
                    <div className="between">
                      <div className="flex">
                        <span className="w600">{g.name}</span>
                        <span className={`tag ${conf ? "warn" : "ok"}`}>
                          {conf ? "confirm" : "auto"}
                        </span>
                      </div>
                      <Toggle on={g.enabled} stop onClick={() => void toggleEnabled(g)} />
                    </div>
                    <div className="small muted">
                      {g.telegramChannel || "—"} · {g.settings.leverage}x · $
                      {g.settings.tradeSizeUsd.toLocaleString()} · {g.settings.entryMode ?? "limit"}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ---------- RIGHT: editor / empty ---------- */}
      {!showEditor || !draft ? (
        <section className="panel">
          <div className="panel-body">
            <div className="empty">
              <div className="e-icon">
                <IconSparkle />
              </div>
              <div className="e-title">No channel selected</div>
              <div className="e-why">
                Pick a channel on the left to edit its trading rules, or add a new one.
              </div>
              <div className="btn-row mt12">
                <button className="btn primary sm" onClick={startCreate}>
                  <IconPlus />
                  Add channel
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>
              {creating ? draft.name || "New channel" : selectedGroup?.name}
              <span className="sub">
                {creating
                  ? "unsaved · configure and create"
                  : `${draft.telegramChannel || "—"} · created ${
                      selectedGroup ? shortTime(selectedGroup.createdAt) : "—"
                    } · updated ${selectedGroup ? shortTime(selectedGroup.updatedAt) : "—"}`}
              </span>
            </h2>
            <div className="actions">
              {!creating && dirty && (
                <span className="small warn flex">
                  <IconWarn />
                  unsaved changes
                </span>
              )}
              <button
                className="btn ghost sm"
                disabled={saving || (!creating && !dirty)}
                onClick={discard}
              >
                Discard
              </button>
              <button
                className="btn primary sm"
                disabled={saving || !draft.name || (!creating && !dirty)}
                onClick={() => void save()}
              >
                <IconCheck />
                {saving ? "Saving…" : creating ? "Create channel" : "Save changes"}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {/* Identity */}
            <div className="form-section">
              <div>
                <h3>Identity</h3>
                <div className="desc">Which Telegram source this is and whether it trades.</div>
              </div>
              <div>
                <div className="form-grid cols-3">
                  <div className="field">
                    <label>Name</label>
                    <input
                      className="input"
                      type="text"
                      value={draft.name}
                      onChange={(e) => set({ name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Telegram channel</label>
                    <input
                      className="input mono"
                      type="text"
                      value={draft.telegramChannel}
                      placeholder="@handle or id"
                      onChange={(e) => set({ telegramChannel: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Enabled</label>
                    <Toggle on={draft.enabled} onClick={() => set({ enabled: !draft.enabled })}>
                      <span>Trading enabled</span>
                      <span className="hint">disable to keep listening without trading</span>
                    </Toggle>
                  </div>
                </div>
              </div>
            </div>

            {/* Sizing */}
            <div className="form-section">
              <div>
                <h3>Sizing</h3>
                <div className="desc">How much capital each signal gets.</div>
              </div>
              <div>
                <div className="form-grid cols-4">
                  <div className="field">
                    <label>Leverage</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={1}
                        value={draft.settings.leverage}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n > 0) setS({ leverage: n });
                        }}
                      />
                      <span className="addon">x</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>Trade size</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={1}
                        value={draft.settings.tradeSizeUsd}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n > 0) setS({ tradeSizeUsd: n });
                        }}
                      />
                      <span className="addon">USDC</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>Sizing mode</label>
                    <select
                      className="input"
                      value={draft.settings.sizingMode ?? "fixed"}
                      onChange={(e) =>
                        setS({
                          sizingMode: e.target.value as "fixed" | "percentEquity" | "riskPerTrade",
                        })
                      }
                    >
                      <option value="fixed">Fixed notional</option>
                      <option value="percentEquity">% of equity (× leverage)</option>
                      <option value="riskPerTrade">Risk per trade (from SL)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Risk value</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        step={draft.settings.sizingMode === "percentEquity" ? 0.5 : 1}
                        value={draft.settings.riskValue ?? 0}
                        onChange={(e) => setS({ riskValue: Number(e.target.value) })}
                      />
                      <span className="addon">
                        {draft.settings.sizingMode === "percentEquity" ? "% equity" : "USDC"}
                      </span>
                    </div>
                    <span className="hint">
                      used by % of equity / risk-per-trade · fixed falls back to trade size
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Entry */}
            <div className="form-section">
              <div>
                <h3>Entry</h3>
                <div className="desc">How and when entries are placed.</div>
              </div>
              <div>
                <div className="form-grid cols-4">
                  <div className="field">
                    <label>Entry mode</label>
                    <select
                      className="input"
                      value={draft.settings.entryMode ?? "limit"}
                      onChange={(e) => setS({ entryMode: e.target.value as "limit" | "market" })}
                    >
                      <option value="limit">Limit — rest at entry, wait for fill</option>
                      <option value="market">Market — enter now</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Working-order timeout</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        value={draft.settings.limitTimeoutHours ?? 336}
                        disabled={(draft.settings.entryMode ?? "limit") !== "limit"}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 0) setS({ limitTimeoutHours: n });
                        }}
                      />
                      <span className="addon">hours</span>
                    </div>
                    <span className="hint">cancel unfilled after this (336 = 14d; 0 = never)</span>
                  </div>
                  <div className="field">
                    <label>Symbol cooldown</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        value={draft.settings.symbolCooldownMinutes ?? 0}
                        onChange={(e) => setS({ symbolCooldownMinutes: Number(e.target.value) })}
                      />
                      <span className="addon">min</span>
                    </div>
                    <span className="hint">0 = off</span>
                  </div>
                  <div className="field">
                    <label>Margin mode</label>
                    <select
                      className="input"
                      value={draft.settings.marginMode}
                      onChange={(e) => setS({ marginMode: e.target.value as "cross" | "isolated" })}
                    >
                      <option value="cross">Cross</option>
                      <option value="isolated">Isolated</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Max slippage</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        step={0.05}
                        value={+(draft.settings.maxSlippage * 100).toFixed(4)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 0) setS({ maxSlippage: n / 100 });
                        }}
                      />
                      <span className="addon">%</span>
                    </div>
                    <span className="hint">applies to entries; stops/TPs/closes always fill</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Take-profit */}
            <div className="form-section">
              <div>
                <h3>Take-profit</h3>
                <div className="desc">
                  Splitting a single target into a ladder and the default partial size.
                </div>
              </div>
              <div>
                <div className="form-grid cols-4">
                  <div className="field">
                    <label>Auto-split single TP</label>
                    <Toggle
                      on={draft.settings.autoSplitSingleTp}
                      onClick={() => setS({ autoSplitSingleTp: !draft.settings.autoSplitSingleTp })}
                    >
                      <span>Split into levels</span>
                    </Toggle>
                  </div>
                  <div className="field">
                    <label>Number of levels</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={2}
                        max={10}
                        value={draft.settings.tpLevels}
                        disabled={!draft.settings.autoSplitSingleTp}
                        onChange={(e) => setS({ tpLevels: Number(e.target.value) })}
                      />
                      <span className="addon">levels</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>Default partial</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        max={100}
                        value={draft.settings.defaultPartialPct ?? 50}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 0 && n <= 100) setS({ defaultPartialPct: n });
                        }}
                      />
                      <span className="addon">%</span>
                    </div>
                    <span className="hint">for “book profits” with no number</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Break-even */}
            <div className="form-section">
              <div>
                <h3>Break-even</h3>
                <div className="desc">When the stop moves to entry automatically.</div>
              </div>
              <div>
                <div className="form-grid cols-4">
                  <div className="field">
                    <label>Move SL to BE after</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        max={10}
                        value={draft.settings.breakevenAfterTp}
                        onChange={(e) => setS({ breakevenAfterTp: Number(e.target.value) })}
                      />
                      <span className="addon">take-profit</span>
                    </div>
                    <span className="hint">0 = off</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Stops */}
            <div className="form-section">
              <div>
                <h3>Stops</h3>
                <div className="desc">Room for DCA-style holds and a protective default.</div>
              </div>
              <div>
                <div className="form-grid cols-4">
                  <div className="field">
                    <label>SL widening multiple</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={1}
                        max={3}
                        step={0.25}
                        value={draft.settings.slWideningMult ?? 1}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 1 && n <= 3) setS({ slWideningMult: n });
                        }}
                      />
                      <span className="addon">×</span>
                    </div>
                    <span className="hint">1.0 = use the posted stop as-is</span>
                  </div>
                  <div className="field">
                    <label>Default protective stop</label>
                    <div className="input-group">
                      <input
                        className="input num"
                        type="number"
                        min={0}
                        max={50}
                        step={1}
                        value={draft.settings.defaultStopPct ?? 0}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 0 && n <= 50) setS({ defaultStopPct: n });
                        }}
                      />
                      <span className="addon">%</span>
                    </div>
                    <span className="hint">when a signal has no SL · 0 = off · never overrides a real SL</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Risk & execution */}
            <div className="form-section">
              <div>
                <h3>Risk &amp; execution</h3>
                <div className="desc">Blocking red signals and whether entries wait for you.</div>
              </div>
              <div>
                <div className="form-grid cols-3">
                  <div className="field">
                    <label>Red (high-risk) signals</label>
                    <Toggle
                      on={draft.settings.blockRedTrades}
                      tone="warn"
                      onClick={() => setS({ blockRedTrades: !draft.settings.blockRedTrades })}
                    >
                      <span>Block red trades</span>
                      <span className="hint">tracked as shadow trades so you can audit the block</span>
                    </Toggle>
                  </div>
                  <div className="field">
                    <label>Execution</label>
                    <select
                      className="input"
                      value={draft.settings.executionMode}
                      onChange={(e) => setS({ executionMode: e.target.value as "auto" | "confirm" })}
                    >
                      <option value="auto">Auto</option>
                      <option value="confirm">Confirm in desk</option>
                    </select>
                    <span className="hint">auto = entries fire without confirmation</span>
                  </div>
                  <div className="field">
                    <label>Allowed symbols</label>
                    <input
                      className="input mono"
                      type="text"
                      value={draft.settings.allowedSymbols?.join(", ") ?? ""}
                      onChange={(e) =>
                        setS({
                          allowedSymbols: e.target.value
                            .split(",")
                            .map((x) => x.trim().toUpperCase())
                            .filter(Boolean),
                        })
                      }
                    />
                    <span className="hint">optional allow-list · empty = all</span>
                  </div>
                </div>
              </div>
            </div>

            {/* AI parsing */}
            <div className="form-section">
              <div>
                <h3>AI parsing (Anthropic)</h3>
                <div className="desc">
                  Per-channel instructions handed to the LLM. Formats, conventions, quirks.
                </div>
              </div>
              <div>
                <div className="field">
                  <label>Parsing instructions</label>
                  <textarea
                    className="input"
                    style={{ minHeight: 110 }}
                    placeholder="e.g. Entries use '$SYM Buying Now / Entry: CMP till X / TP: y / SL: z'. 'Invalidation' means SL. 'moving SL to entry' = break-even; 'invalidated'/'stopped' = close. Ignore education/Q&A posts."
                    value={draft.settings.instructions ?? ""}
                    onChange={(e) => setS({ instructions: e.target.value })}
                  />
                </div>
                {!creating && selectedGroup && (
                  <div className="btn-row mt8">
                    <button
                      className="btn sm"
                      disabled={suggesting === selectedGroup.id}
                      title="Let the AI study this channel's messages and propose improved parsing instructions"
                      onClick={() => void suggest(selectedGroup.id)}
                    >
                      <IconSparkle />
                      {suggesting === selectedGroup.id ? "Thinking…" : "Suggest from history (AI)"}
                    </button>
                  </div>
                )}
                {!creating &&
                  selectedGroup &&
                  suggestions[selectedGroup.id] !== undefined &&
                  (() => {
                    const sug = suggestions[selectedGroup.id]!;
                    const g = selectedGroup;
                    return (
                      <SuggestionCallout
                        key={sug.instructions.length + sug.rationale}
                        s={sug}
                        busy={applying === g.id}
                        onApply={(text) => void applyInstructions(g, text)}
                        onDismiss={() => dismissSuggestion(g.id)}
                      />
                    );
                  })()}
              </div>
            </div>

            {/* Danger zone */}
            {!creating && selectedGroup && (
              <div className="form-section">
                <div>
                  <h3 className="loss">Danger zone</h3>
                  <div className="desc">Irreversible or heavy operations.</div>
                </div>
                <div>
                  <div className="btn-row">
                    <button
                      className="btn sm"
                      disabled={analyzing === selectedGroup.id}
                      onClick={() => void analyze(selectedGroup.id)}
                    >
                      <IconPlay />
                      {analyzing === selectedGroup.id ? "Backtesting…" : "Backtest channel history…"}
                    </button>
                    <button
                      className="btn sm"
                      onClick={() =>
                        api
                          .exportGroup(selectedGroup.id, selectedGroup.name)
                          .catch((e) => alert(String(e)))
                      }
                    >
                      <IconDownload />
                      Export messages
                    </button>
                    <button className="btn danger sm" onClick={() => void remove(selectedGroup.id)}>
                      <IconTrash />
                      Delete group…
                    </button>
                  </div>
                  {results[selectedGroup.id] !== undefined && (
                    <div className="mt12">
                      <BacktestView r={results[selectedGroup.id]!} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
