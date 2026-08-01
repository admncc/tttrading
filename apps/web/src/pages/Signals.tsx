import { useState } from "react";
import type { Group, Signal } from "@tttrading/shared";
import { api } from "../api.js";
import { num, shortTime } from "../format.js";

function ParsedCell({ signal }: { signal: Signal }) {
  const p = signal.parsed;
  if (!p) return <span className="muted">—</span>;
  return (
    <span>
      <span className={`tag ${p.side}`}>{p.side.toUpperCase()}</span> {p.symbol}
      {p.entry !== undefined && <span className="muted"> @ {num(p.entry)}</span>}
      {p.stopLoss !== undefined && <span className="muted"> · SL {num(p.stopLoss)}</span>}
      {p.takeProfits && p.takeProfits.length > 0 && (
        <span className="muted"> · TP {p.takeProfits.map((t) => num(t)).join("/")}</span>
      )}
      <span className="muted"> · {Math.round(p.confidence * 100)}% ({p.source})</span>
    </span>
  );
}

function SimulateBox({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [text, setText] = useState("LONG BTC entry 62000 SL 60500 TP 64000 65000");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!groupId || !text.trim()) return;
    setBusy(true);
    try {
      await api.simulate(groupId, text.trim());
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Test a signal</h2>
      <div className="field">
        <label>Group</label>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.settings.executionMode})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Raw message</label>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <button className="primary" disabled={busy || !groupId} onClick={submit}>
        {busy ? "Sending…" : "Parse & route"}
      </button>
    </div>
  );
}

export function Signals({
  signals,
  groups,
  onChange,
}: {
  signals: Signal[];
  groups: Group[];
  onChange: () => void;
}) {
  const pending = signals.filter((s) => s.status === "pending");

  const act = async (id: string, action: "confirm" | "reject") => {
    if (action === "confirm") await api.confirmSignal(id);
    else await api.rejectSignal(id);
    onChange();
  };

  return (
    <div>
      <h1>Signals</h1>

      <div className="grid-2">
        <div>
          <div className="panel">
            <h2>Pending confirmation ({pending.length})</h2>
            {pending.length === 0 ? (
              <div className="empty">Nothing waiting.</div>
            ) : (
              pending.map((s) => (
                <div key={s.id} className="row-between">
                  <div>
                    <ParsedCell signal={s} />
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {s.groupName} · {shortTime(s.receivedAt)}
                    </div>
                  </div>
                  <div className="btn-row">
                    <button className="primary" onClick={() => act(s.id, "confirm")}>
                      Confirm
                    </button>
                    <button className="danger" onClick={() => act(s.id, "reject")}>
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="panel">
            <h2>Recent signals</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Group</th>
                    <th>Parsed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <tr key={s.id}>
                      <td className="muted">{shortTime(s.receivedAt)}</td>
                      <td>{s.groupName}</td>
                      <td>
                        <ParsedCell signal={s} />
                      </td>
                      <td>
                        <span className={`tag ${s.status}`}>{s.status}</span>
                        {s.error && (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {" "}
                            {s.error}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {signals.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No signals yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <SimulateBox groups={groups} onChange={onChange} />
      </div>
    </div>
  );
}
