import { useState } from "react";
import type { Group, GroupInput } from "@tttrading/shared";
import { api } from "../api.js";

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
          <label>Trade size (USDC)</label>
          <input
            type="number"
            min={1}
            value={g.settings.tradeSizeUsd}
            onChange={(e) => setS({ tradeSizeUsd: Number(e.target.value) })}
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

export function Groups({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const create = async (g: GroupInput) => {
    await api.createGroup(g);
    setCreating(false);
    onChange();
  };
  const update = async (id: string, g: GroupInput) => {
    await api.updateGroup(id, g);
    setEditing(null);
    onChange();
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this group?")) return;
    await api.deleteGroup(id);
    onChange();
  };

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Groups & Settings</h1>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "Close" : "+ New group"}
        </button>
      </div>

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
                <button onClick={() => setEditing(g.id)}>Edit</button>
                <button className="danger" onClick={() => remove(g.id)}>
                  Delete
                </button>
              </div>
            </div>
            <div className="muted">
              {g.settings.leverage}x · {g.settings.tradeSizeUsd.toLocaleString()} USDC ·{" "}
              {g.settings.executionMode} · {g.settings.marginMode} ·{" "}
              {(g.settings.maxSlippage * 100).toFixed(1)}% slippage ·{" "}
              {g.settings.autoSplitSingleTp ? `split→${g.settings.tpLevels} TP` : "TP as-is"}
              {g.settings.breakevenAfterTp > 0 && ` · BE after TP${g.settings.breakevenAfterTp}`}
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
