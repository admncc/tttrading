import { useEffect, useState } from "react";
import type { BacktestResult, Group, GroupInput } from "@tttrading/shared";
import { api } from "../api.js";
import { pct, pnlClass, usd } from "../format.js";

/** Panel to configure the Anthropic key/model for LLM signal parsing. */
function AiSettings() {
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState("none");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.anthropicConfigured);
        setSource(s.anthropicKeySource);
        setModel(s.anthropicModel);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveAnthropic(key.trim() || undefined, model.trim() || undefined);
      setKey("");
      setMsg("Saved.");
      await load();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>AI parsing (Anthropic)</h2>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Enables the LLM fallback for messages the regex parser can't read.{" "}
        {configured ? `Key configured (source: ${source}).` : "No key set — regex only."}
      </div>
      <div className="form-grid">
        <div className="field">
          <label>API key {configured ? "(leave blank to keep current)" : ""}</label>
          <input
            type="password"
            placeholder={configured ? "•••••••• set" : "sk-ant-..."}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Model</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5" />
        </div>
      </div>
      <div className="btn-row">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save AI settings"}
        </button>
        {key && (
          <button className="danger" disabled={busy} onClick={() => { setKey(""); void api.saveAnthropic("", undefined).then(load); }}>
            Clear key
          </button>
        )}
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

const BLANK: GroupInput = {
  name: "",
  telegramChannel: "",
  enabled: true,
  settings: {
    leverage: 4,
    tradeSizeUsd: 5000,
    executionMode: "auto",
    marginMode: "cross",
    maxSlippage: 0.01,
    autoSplitSingleTp: false,
    tpLevels: 3,
    breakevenAfterTp: 0,
    blockRedTrades: false,
    instructions: "",
  },
};

function GroupForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: GroupInput;
  onSave: (g: GroupInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [g, setG] = useState<GroupInput>(initial);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<GroupInput>) => setG((prev) => ({ ...prev, ...patch }));
  const setS = (patch: Partial<GroupInput["settings"]>) =>
    setG((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));

  const save = async () => {
    setBusy(true);
    try {
      await onSave(g);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input value={g.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>Telegram channel (@handle or id)</label>
          <input
            value={g.telegramChannel}
            onChange={(e) => set({ telegramChannel: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Leverage (x)</label>
          <input
            type="number"
            min={1}
            value={g.settings.leverage}
            onChange={(e) => setS({ leverage: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Sizing mode</label>
          <select
            value={g.settings.sizingMode ?? "fixed"}
            onChange={(e) => setS({ sizingMode: e.target.value as "fixed" | "percentEquity" | "riskPerTrade" })}
          >
            <option value="fixed">Fixed notional</option>
            <option value="percentEquity">% of equity (× leverage)</option>
            <option value="riskPerTrade">Risk per trade (from SL)</option>
          </select>
        </div>
        {(g.settings.sizingMode ?? "fixed") === "fixed" ? (
          <div className="field">
            <label>Trade size (USDC)</label>
            <input
              type="number"
              min={1}
              value={g.settings.tradeSizeUsd}
              onChange={(e) => setS({ tradeSizeUsd: Number(e.target.value) })}
            />
          </div>
        ) : (
          <div className="field">
            <label>
              {g.settings.sizingMode === "percentEquity" ? "% of equity" : "Risk per trade (USDC)"}
            </label>
            <input
              type="number"
              min={0}
              step={g.settings.sizingMode === "percentEquity" ? 0.5 : 1}
              value={g.settings.riskValue ?? 0}
              onChange={(e) => setS({ riskValue: Number(e.target.value) })}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              fallback: {g.settings.tradeSizeUsd} USDC fixed
            </span>
          </div>
        )}
        <div className="field">
          <label>Symbol cooldown (min, 0 = off)</label>
          <input
            type="number"
            min={0}
            value={g.settings.symbolCooldownMinutes ?? 0}
            onChange={(e) => setS({ symbolCooldownMinutes: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Execution</label>
          <select
            value={g.settings.executionMode}
            onChange={(e) => setS({ executionMode: e.target.value as "auto" | "confirm" })}
          >
            <option value="auto">Auto</option>
            <option value="confirm">Confirm in desk</option>
          </select>
        </div>
        <div className="field">
          <label>Margin</label>
          <select
            value={g.settings.marginMode}
            onChange={(e) => setS({ marginMode: e.target.value as "cross" | "isolated" })}
          >
            <option value="cross">Cross</option>
            <option value="isolated">Isolated</option>
          </select>
        </div>
        <div className="field">
          <label>Max slippage (%)</label>
          <input
            type="number"
            step={0.1}
            min={0}
            value={g.settings.maxSlippage * 100}
            onChange={(e) => setS({ maxSlippage: Number(e.target.value) / 100 })}
          />
        </div>
        <div className="field">
          <label>Split single TP into levels?</label>
          <select
            value={g.settings.autoSplitSingleTp ? "1" : "0"}
            onChange={(e) => setS({ autoSplitSingleTp: e.target.value === "1" })}
          >
            <option value="0">No — use TPs as given</option>
            <option value="1">Yes — auto-split one target</option>
          </select>
        </div>
        <div className="field">
          <label>TP levels (when splitting)</label>
          <input
            type="number"
            min={2}
            max={10}
            value={g.settings.tpLevels}
            disabled={!g.settings.autoSplitSingleTp}
            onChange={(e) => setS({ tpLevels: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Move SL to break-even after TP #</label>
          <input
            type="number"
            min={0}
            max={10}
            value={g.settings.breakevenAfterTp}
            onChange={(e) => setS({ breakevenAfterTp: Number(e.target.value) })}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            0 = off
          </span>
        </div>
        <div className="field">
          <label>Block red (high-risk) trades?</label>
          <select
            value={g.settings.blockRedTrades ? "1" : "0"}
            onChange={(e) => setS({ blockRedTrades: e.target.value === "1" })}
          >
            <option value="0">No — execute all</option>
            <option value="1">Yes — skip reds, track shadow</option>
          </select>
        </div>
        <div className="field">
          <label>Allowed symbols (comma sep, blank = all)</label>
          <input
            value={g.settings.allowedSymbols?.join(", ") ?? ""}
            onChange={(e) =>
              setS({
                allowedSymbols: e.target.value
                  .split(",")
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <div className="field">
          <label>Enabled</label>
          <select
            value={g.enabled ? "1" : "0"}
            onChange={(e) => set({ enabled: e.target.value === "1" })}
          >
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Instructions for the AI parser (channel-specific)</label>
        <textarea
          rows={5}
          placeholder="e.g. Entries use '$SYM Buying Now / Entry: CMP till X / TP: y / SL: z'. 'Invalidation' means SL. Prices sometimes drop the leading '0.'. 'moving SL to entry' = break-even; 'invalidated'/'stopped' = close. Ignore education/Q&A posts."
          value={g.settings.instructions ?? ""}
          onChange={(e) => setS({ instructions: e.target.value })}
        />
      </div>
      <div className="btn-row">
        <button className="primary" disabled={busy || !g.name} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/** Backtest / channel-analysis result panel. */
function BacktestPanel({ r }: { r: BacktestResult }) {
  const s = r.stats;
  return (
    <div
      className="panel"
      style={{ background: "var(--panel-2)", margin: "0 0 10px", padding: 14 }}
    >
      {r.error ? (
        <div className="neg">Analysis error: {r.error}</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            <strong>Backtest</strong>{" "}
            <span className="muted">
              re-parsed {r.reparsed} · tested {r.tested} · skipped {r.skipped} · risk{" "}
              <span className="pos">{r.riskCounts.green}🟢</span>{" "}
              <span className="warn">{r.riskCounts.yellow}🟡</span>{" "}
              <span className="neg">{r.riskCounts.red}🔴</span>
            </span>
          </div>
          {r.tested === 0 ? (
            <div className="muted">
              No simulatable signals (channel is mostly prose/management — see the analysis
              notes; better handled with per-channel instructions + LLM).
            </div>
          ) : (
            <div className="kpi-grid" style={{ margin: 0 }}>
              <div className="kpi">
                <div className="label">Win rate</div>
                <div className="value">{pct(s.winRate)}</div>
              </div>
              <div className="kpi">
                <div className="label">PnL (sim)</div>
                <div className={`value ${pnlClass(s.realizedPnl)}`}>{usd(s.realizedPnl)}</div>
              </div>
              <div className="kpi">
                <div className="label">Profit factor</div>
                <div className="value">
                  {Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"}
                </div>
              </div>
              <div className="kpi">
                <div className="label">Avg / trade</div>
                <div className={`value ${pnlClass(s.avgPnl)}`}>{usd(s.avgPnl)}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface Suggestion {
  instructions: string;
  rationale: string;
  sampleSize: number;
  error?: string;
}

/** Panel showing an AI-suggested set of channel instructions for review. */
function SuggestionPanel({
  s,
  current,
  busy,
  onApply,
  onDismiss,
}: {
  s: Suggestion;
  current: string;
  busy: boolean;
  onApply: (text: string) => void;
  onDismiss: () => void;
}) {
  const [text, setText] = useState(s.instructions);
  if (s.error) {
    return (
      <div className="panel" style={{ background: "var(--panel-2)", margin: "0 0 10px", padding: 14 }}>
        <div className="neg">AI suggestion failed: {s.error}</div>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="ghost" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel" style={{ background: "var(--panel-2)", margin: "0 0 10px", padding: 14 }}>
      <div style={{ marginBottom: 8 }}>
        <strong>AI-suggested instructions</strong>{" "}
        <span className="muted" style={{ fontSize: 12 }}>
          from {s.sampleSize} messages · review &amp; edit before applying
        </span>
      </div>
      {s.rationale && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {s.rationale}
        </div>
      )}
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !text.trim()} onClick={() => onApply(text.trim())}>
          {busy ? "Applying…" : "Apply to channel"}
        </button>
        <button className="ghost" onClick={onDismiss}>Dismiss</button>
        {current.trim() && (
          <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
            replaces the current instructions
          </span>
        )}
      </div>
    </div>
  );
}

export function Groups({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<Record<string, BacktestResult>>({});
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

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

  const create = async (g: GroupInput) => {
    try {
      await api.createGroup(g);
      setCreating(false);
      onChange();
    } catch (e) {
      alert(`Create failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  const update = async (id: string, g: GroupInput) => {
    try {
      await api.updateGroup(id, g);
      setEditing(null);
      onChange();
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this group?")) return;
    try {
      await api.deleteGroup(id);
      onChange();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Groups & Settings</h1>
        <div className="btn-row">
          <button onClick={() => api.exportAll().catch((e) => alert(String(e)))}>
            Export all (.txt)
          </button>
          <button className="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? "Close" : "+ New group"}
          </button>
        </div>
      </div>

      <AiSettings />

      {creating && (
        <GroupForm initial={BLANK} onSave={create} onCancel={() => setCreating(false)} />
      )}

      {groups.map((g) =>
        editing === g.id ? (
          <GroupForm
            key={g.id}
            initial={g}
            onSave={(input) => update(g.id, input)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="panel" key={g.id}>
            <div className="row-between">
              <div>
                <strong>{g.name}</strong>{" "}
                <span className="muted">{g.telegramChannel}</span>{" "}
                {!g.enabled && <span className="tag">disabled</span>}
              </div>
              <div className="btn-row">
                <button
                  className="primary"
                  disabled={analyzing === g.id}
                  onClick={() => analyze(g.id)}
                >
                  {analyzing === g.id ? "Analyzing…" : "Analyze"}
                </button>
                <button
                  disabled={suggesting === g.id}
                  title="Let the AI study this channel's messages and propose improved parsing instructions"
                  onClick={() => suggest(g.id)}
                >
                  {suggesting === g.id ? "Thinking…" : "Improve instructions (AI)"}
                </button>
                <button onClick={() => api.exportGroup(g.id, g.name).catch((e) => alert(String(e)))}>
                  Export
                </button>
                <button onClick={() => setEditing(g.id)}>Edit</button>
                <button className="danger" onClick={() => remove(g.id)}>
                  Delete
                </button>
              </div>
            </div>
            {results[g.id] && <BacktestPanel r={results[g.id]!} />}
            {suggestions[g.id] && (
              <SuggestionPanel
                key={suggestions[g.id]!.instructions.length + suggestions[g.id]!.rationale}
                s={suggestions[g.id]!}
                current={g.settings.instructions ?? ""}
                busy={applying === g.id}
                onApply={(text) => applyInstructions(g, text)}
                onDismiss={() => dismissSuggestion(g.id)}
              />
            )}
            <div className="muted">
              {g.settings.leverage}x · {g.settings.tradeSizeUsd.toLocaleString()} USDC ·{" "}
              {g.settings.executionMode} · {g.settings.marginMode} ·{" "}
              {(g.settings.maxSlippage * 100).toFixed(1)}% slippage ·{" "}
              {g.settings.autoSplitSingleTp ? `split→${g.settings.tpLevels} TP` : "TP as-is"}
              {g.settings.breakevenAfterTp > 0 && ` · BE after TP${g.settings.breakevenAfterTp}`}
              {g.settings.blockRedTrades && " · blocks red"}
              {g.settings.instructions?.trim() && " · 📝 AI instructions"}
              {g.settings.allowedSymbols && g.settings.allowedSymbols.length > 0 && (
                <> · {g.settings.allowedSymbols.join(", ")}</>
              )}
            </div>
          </div>
        ),
      )}

      {groups.length === 0 && !creating && (
        <div className="empty">No groups yet. Create one to start listening for signals.</div>
      )}
    </div>
  );
}
