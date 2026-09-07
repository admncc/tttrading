import { useMemo, useState } from "react";
import type { Group, ParsedSignal, RiskRating, Signal } from "@tttrading/shared";
import { api } from "../api.js";
import { num, shortTime, usd } from "../format.js";

/* ---------- shared bits ---------- */

function Dash() {
  return <span className="muted">—</span>;
}

/** Risk rating badge — champagne-system letter + score, never colour alone. */
function RiskChip({ risk }: { risk?: RiskRating }) {
  if (!risk) return <Dash />;
  const letter = risk.level === "green" ? "G" : risk.level === "yellow" ? "Y" : "R";
  const title = `Risk ${risk.level} · ${risk.score}/100${
    risk.reasons.length ? `\n${risk.reasons.join("\n")}` : ""
  }`;
  return (
    <span className={`risk ${risk.level}`} title={title}>
      <i>{letter}</i>
      {risk.score}
    </span>
  );
}

/** Confidence bar (.meter) + numeric value. */
function ConfMeter({ value }: { value: number }) {
  const cls = value >= 0.8 ? "ok" : value >= 0.6 ? "warn" : "danger";
  const width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div className="flex" style={{ gap: 8 }}>
      <span style={{ width: 56 }}>
        <div className={`meter ${cls}`}>
          <i style={{ width }} />
        </div>
      </span>
      <span className="num small">{value.toFixed(2)}</span>
    </div>
  );
}

function sideTag(side: ParsedSignal["side"]) {
  return <span className={`tag side ${side}`}>{side}</span>;
}

/** Best single entry representation: explicit entry, first leg, or "market". */
function entryText(p: ParsedSignal): string {
  if (p.entries && p.entries.length > 1) return `${p.entries.length} legs`;
  if (p.entry !== undefined) return num(p.entry);
  const first = p.entries?.[0];
  if (first) return first.mode === "market" ? "market" : first.price !== undefined ? num(first.price) : "market";
  return "market";
}

/** Take-profit levels joined as prices, e.g. "149 / 155". */
function tpJoined(p: ParsedSignal): string | null {
  const tps = p.takeProfits;
  if (!tps || tps.length === 0) return null;
  return tps.map((t) => num(t)).join(" / ");
}

/** Take-profit levels as a compact count, e.g. "3 levels". */
function tpCount(p: ParsedSignal): string | null {
  const n = p.takeProfits?.length ?? 0;
  if (n === 0) return null;
  return n === 1 ? num(p.takeProfits![0]!) : `${n} levels`;
}

function levText(p: ParsedSignal): string | null {
  return p.leverageHint !== undefined ? `${p.leverageHint}x` : null;
}

/* ---------- Test a signal ---------- */

function SimulateBox({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [text, setText] = useState("Long SOL here 141.9, sl 138.5, targets 149 / 155, 5x");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Signal | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!groupId || !text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await api.simulate(groupId, text.trim());
      setResult(s);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const p = result?.parsed;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Test a signal
          <span className="sub">preview the parser without waiting for a live post</span>
        </h2>
      </div>
      <div className="panel-body">
        <div className="form-grid" style={{ gridTemplateColumns: "200px 1fr" }}>
          <div className="field">
            <label>Group</label>
            <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.settings.executionMode})
                </option>
              ))}
            </select>
            <span className="hint">uses that channel's parsing instructions</span>
          </div>
          <div className="field">
            <label>Raw text</label>
            <textarea
              className="input"
              style={{ minHeight: 64 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>

        <div className="between mt12">
          {p ? (
            <div className="flex" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="kv">
                <span className="k">Parsed</span>
                <b>
                  {p.symbol} {p.side}
                </b>
              </span>
              <span className="kv">
                <span className="k">Entry</span>
                <b>{entryText(p)}</b>
              </span>
              <span className="kv">
                <span className="k">SL</span>
                <b>{p.stopLoss !== undefined ? num(p.stopLoss) : "—"}</b>
              </span>
              <span className="kv">
                <span className="k">TP</span>
                <b>{tpJoined(p) ?? "—"}</b>
              </span>
              <span className="kv">
                <span className="k">Lev</span>
                <b>{levText(p) ?? "—"}</b>
              </span>
              <span className="kv">
                <span className="k">Conf</span>
                <b>{p.confidence.toFixed(2)}</b>
              </span>
              <RiskChip risk={result?.risk} />
              {result && <span className={`tag ${result.status}`}>{result.status}</span>}
            </div>
          ) : err ? (
            <span className="tag error" title={err}>
              simulate failed
            </span>
          ) : result ? (
            <span className="muted small">No signal parsed from that message.</span>
          ) : (
            <span className="muted small">Run a message to see the parsed result.</span>
          )}
          <button className="btn primary sm" disabled={busy || !groupId} onClick={submit}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 4l12 8-12 8z" />
            </svg>
            {busy ? "Running…" : "Run through pipeline"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------- Pending confirmation ---------- */

function PendingCard({
  s,
  group,
  onAct,
}: {
  s: Signal;
  group?: Group;
  onAct: (id: string, action: "confirm" | "reject") => void;
}) {
  const p = s.parsed;
  const sizingMode = group?.settings.sizingMode;
  const sizeText =
    group && (sizingMode === undefined || sizingMode === "fixed")
      ? usd(group.settings.tradeSizeUsd, 0)
      : null;
  const mode = group?.settings.executionMode ?? "confirm";

  return (
    <div className="callout" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="between">
        <div className="flex">
          {p ? sideTag(p.side) : <span className="tag neutral plain">signal</span>}
          <span className="num w600">{p?.symbol ?? "—"}</span>
          <span className="muted small">
            · {s.groupName} · {shortTime(s.receivedAt)}
          </span>
        </div>
        <RiskChip risk={s.risk} />
      </div>
      <div className="flex" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="kv">
          <span className="k">Entry</span>
          <b>{p ? entryText(p) : "—"}</b>
        </span>
        <span className="kv">
          <span className="k">SL</span>
          <b>{p?.stopLoss !== undefined ? num(p.stopLoss) : "—"}</b>
        </span>
        <span className="kv">
          <span className="k">TP</span>
          <b>{(p && tpCount(p)) ?? "—"}</b>
        </span>
        <span className="kv">
          <span className="k">Lev</span>
          <b>{(p && levText(p)) ?? "—"}</b>
        </span>
        <span className="kv">
          <span className="k">Size</span>
          <b>{sizeText ?? "—"}</b>
        </span>
        <span className="kv">
          <span className="k">Conf</span>
          <b>{p ? p.confidence.toFixed(2) : "—"}</b>
        </span>
      </div>
      <div className="between">
        <span className="small muted">
          expires in <span className="num">—</span> · {mode} mode
        </span>
        <div className="btn-row">
          <button className="btn danger sm" onClick={() => onAct(s.id, "reject")}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            Reject
          </button>
          <button className="btn primary sm" onClick={() => onAct(s.id, "confirm")}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12l4 4L19 6" />
            </svg>
            Confirm &amp; execute
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Recent signals table ---------- */

const FILTERS: { key: string; label: string; match?: Signal["status"] }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending", match: "pending" },
  { key: "executed", label: "Executed", match: "executed" },
  { key: "managed", label: "Managed", match: "managed" },
  { key: "blocked", label: "Blocked", match: "blocked" },
  { key: "rejected", label: "Rejected", match: "rejected" },
  { key: "ignored", label: "Ignored", match: "ignored" },
];

function RecentSignals({ signals }: { signals: Signal[] }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: signals.length };
    for (const f of FILTERS) {
      if (f.match) c[f.key] = signals.filter((s) => s.status === f.match).length;
    }
    return c;
  }, [signals]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return signals.filter((s) => {
      if (filter !== "all" && s.status !== filter) return false;
      if (!needle) return true;
      const hay = `${s.groupName} ${s.parsed?.symbol ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [signals, filter, q]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Recent signals
          <span className="sub">live stream · newest first</span>
        </h2>
      </div>
      <div className="panel-body flush">
        <div
          className="between"
          style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}
        >
          <div className="seg">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`seg-item${filter === f.key ? " active" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="n">{counts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <span className="search" style={{ minWidth: 220 }}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Symbol, group…"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "inherit",
                font: "inherit",
                width: "100%",
                minWidth: 0,
              }}
            />
          </span>
        </div>

        {signals.length === 0 ? (
          <div className="empty">
            <span className="e-icon">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="2" />
                <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
              </svg>
            </span>
            <div className="e-title">No signals yet</div>
            <div className="e-why">Parsed messages from your channels will stream in here.</div>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Group</th>
                  <th>Signal</th>
                  <th>Entry / SL</th>
                  <th className="num">Lev</th>
                  <th>Confidence</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const p = s.parsed;
                  const tps = p?.takeProfits?.length ?? 0;
                  return (
                    <tr key={s.id}>
                      <td>
                        <span className="num muted">{shortTime(s.receivedAt)}</span>
                      </td>
                      <td>{s.groupName}</td>
                      <td>
                        {p ? (
                          <>
                            {sideTag(p.side)} <span className="num w600">{p.symbol}</span>
                          </>
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td>
                        {p ? (
                          <>
                            <span className="num">{entryText(p)}</span>{" "}
                            <span className="muted">/</span>{" "}
                            <span className="num">
                              {p.stopLoss !== undefined ? num(p.stopLoss) : "—"}
                            </span>
                            {tps > 0 && <span className="muted"> · {tps} TP</span>}
                          </>
                        ) : (
                          <span className="muted">{s.error ?? "—"}</span>
                        )}
                      </td>
                      <td className="num">{(p && levText(p)) ?? <Dash />}</td>
                      <td>{p ? <ConfMeter value={p.confidence} /> : <Dash />}</td>
                      <td>{p ? <span className="tag neutral plain">{p.source}</span> : <Dash />}</td>
                      <td>
                        <span className={`tag ${s.status}`} title={s.error}>
                          {s.status}
                        </span>
                      </td>
                      <td>
                        <RiskChip risk={s.risk} />
                      </td>
                      <td className="right">
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          title="Source message"
                        >
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M14 4h6v6M20 4l-9 9" />
                            <path d="M19 13v6H5V5h6" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10}>
                      <div className="empty">
                        <div className="e-title">No matching signals</div>
                        <div className="e-why">Try a different filter or search term.</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- Page ---------- */

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
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  const act = async (id: string, action: "confirm" | "reject") => {
    try {
      if (action === "confirm") await api.confirmSignal(id);
      else await api.rejectSignal(id);
      onChange();
    } catch (e) {
      alert(`${action} failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <>
      <div
        className="grid-2"
        style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}
      >
        <SimulateBox groups={groups} onChange={onChange} />

        <section className="panel">
          <div className="panel-head">
            <h2>
              Pending confirmation
              <span className="sub">
                {pending.length} awaiting your decision
              </span>
            </h2>
            <div className="actions">
              <span className="tag warn plain">{pending.length}</span>
            </div>
          </div>
          <div className="panel-body">
            {pending.length === 0 ? (
              <div className="empty">
                <div className="e-title">Nothing waiting</div>
                <div className="e-why">
                  Signals from confirm-mode channels appear here for your decision.
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {pending.map((s) => (
                  <PendingCard key={s.id} s={s} group={groupById.get(s.groupId)} onAct={act} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <RecentSignals signals={signals} />
    </>
  );
}
