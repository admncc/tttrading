import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type SecondOpinion } from "../api.js";
import { shortTime } from "../format.js";

const ALL = "__all__";

function StanceBadge({ s }: { s?: "positive" | "negative" }) {
  if (!s) return <span className="tag">pending</span>;
  const pos = s === "positive";
  return (
    <span className="tag" style={{ background: pos ? "#16a34a" : "#dc2626", color: "#fff", fontWeight: 600 }}>
      {pos ? "POSITIVE" : "NEGATIVE"}
    </span>
  );
}

function scoreColor(n: number) {
  return n >= 60 ? "#22c55e" : n >= 45 ? "#f59e0b" : "#ef4444";
}

export function SecondOpinion() {
  const [rows, setRows] = useState<SecondOpinion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fGroup, setFGroup] = useState(ALL);
  const [fStance, setFStance] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    api.secondOpinions(500).then((d) => { setRows(d); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const groupOpts = useMemo(() => [...new Set((rows ?? []).map((r) => r.groupName))].sort(), [rows]);
  const shown = (rows ?? []).filter(
    (r) => (fGroup === ALL || r.groupName === fGroup) && (fStance === ALL || r.verdict?.stance === fStance),
  );

  // Agreement scorecard per channel: how often our stance matched the outcome.
  const scorecard = useMemo(() => {
    const m = new Map<string, { n: number; resolved: number; ourPos: number; agreed: number }>();
    for (const r of rows ?? []) {
      const e = m.get(r.groupName) ?? { n: 0, resolved: 0, ourPos: 0, agreed: 0 };
      e.n += 1;
      if (r.verdict?.stance === "positive") e.ourPos += 1;
      if (r.outcome?.resolved) {
        e.resolved += 1;
        const good = r.outcome.firstHit === "tp";
        const ourPositive = r.verdict?.stance === "positive";
        if (good === ourPositive) e.agreed += 1; // we called it right
      }
      m.set(r.groupName, e);
    }
    return [...m.entries()].map(([name, e]) => ({ name, ...e })).sort((a, b) => b.n - a.n);
  }, [rows]);

  return (
    <div>
      <div className="row-between">
        <h1 style={{ margin: 0 }}>Second Opinion</h1>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      <p className="muted" style={{ marginTop: 4, maxWidth: 780 }}>
        An independent, <b>observe-only</b> read of every signal from a professional trader / chart-analyst view
        (objective TA + a stance for or against the trader), plus how each call actually played out. It never
        places or manages orders — we track whether our read beats the trader's before any active use.
      </p>

      {err && <div className="panel" style={{ color: "#ef4444" }}>{err}</div>}

      {/* Scorecard: are WE right vs the outcome? */}
      {scorecard.length > 0 && (
        <div className="panel" style={{ overflowX: "auto" }}>
          <h3 style={{ margin: "0 0 8px" }}>Our accuracy vs. outcome (resolved calls)</h3>
          <table>
            <thead><tr><th>Channel</th><th>Signals</th><th>Resolved</th><th>We positive</th><th>We called right</th></tr></thead>
            <tbody>
              {scorecard.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.n}</td>
                  <td>{s.resolved}</td>
                  <td>{s.n ? Math.round((s.ourPos / s.n) * 100) : 0}%</td>
                  <td style={{ color: s.resolved ? scoreColor((s.agreed / s.resolved) * 100) : "var(--muted)" }}>
                    {s.resolved ? `${Math.round((s.agreed / s.resolved) * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label>
          <div className="muted" style={{ fontSize: 11 }}>Channel</div>
          <select value={fGroup} onChange={(e) => setFGroup(e.target.value)} style={{ width: "auto", minWidth: 150 }}>
            <option value={ALL}>All channels</option>
            {groupOpts.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label>
          <div className="muted" style={{ fontSize: 11 }}>Stance</div>
          <select value={fStance} onChange={(e) => setFStance(e.target.value)} style={{ width: "auto", minWidth: 130 }}>
            <option value={ALL}>All</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{shown.length} shown</span>
      </div>

      <div className="panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th><th>Channel</th><th>Signal</th><th>Our stance</th><th>Score</th>
                <th>Trend</th><th>R/R (claim→real)</th><th>Outcome</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const o = r.outcome;
                const outcomeTxt = !o
                  ? "—"
                  : o.firstHit === "tp" ? "TP hit first ✅" : o.firstHit === "sl" ? "SL hit first ⛔" : o.resolved ? "no hit (timeout)" : "running";
                return (
                  <Fragment key={r.id}>
                    <tr key={r.id}>
                      <td className="muted">{shortTime(r.createdAt)}</td>
                      <td>{r.groupName}</td>
                      <td><span className={`tag ${r.side}`}>{r.side}</span> {r.symbol}</td>
                      <td><StanceBadge s={r.verdict?.stance} /></td>
                      <td style={{ color: r.verdict ? scoreColor(r.verdict.score) : "var(--muted)", fontWeight: 600 }}>
                        {r.verdict ? r.verdict.score : "—"}
                        {r.verdict?.source === "heuristic" ? <span className="muted" style={{ fontSize: 10 }}> (rules)</span> : null}
                      </td>
                      <td className="muted">{r.ta?.trend ?? "—"}</td>
                      <td className="muted">
                        {r.ta?.rrClaimed?.toFixed(1) ?? "?"} → {r.ta?.rrRealistic?.toFixed(1) ?? "?"}
                      </td>
                      <td>
                        {outcomeTxt}
                        {o ? <span className="muted" style={{ fontSize: 11 }}> · MFE {o.mfePct}% / MAE {o.maePct}%</span> : null}
                      </td>
                      <td><button className="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "▲" : "▾"}</button></td>
                    </tr>
                    {open === r.id && (
                      <tr key={r.id + "d"}>
                        <td colSpan={9} style={{ background: "rgba(255,255,255,0.02)" }}>
                          <div style={{ padding: "6px 4px", display: "grid", gap: 8 }}>
                            <div><b>Verdict:</b> {r.verdict?.summary || "—"}</div>
                            {r.verdict?.redFlags?.length ? <div style={{ color: "#ef4444" }}>⚠ {r.verdict.redFlags.join(" · ")}</div> : null}
                            {r.verdict?.strengths?.length ? <div style={{ color: "#22c55e" }}>✓ {r.verdict.strengths.join(" · ")}</div> : null}
                            {r.ta ? (
                              <div className="muted" style={{ fontSize: 12 }}>
                                entry {r.entry ?? "CMP"} · SL {r.stopLoss ?? "—"} · TP {r.takeProfits?.join("/") ?? "—"} ·
                                {" "}price {r.ta.price} · ATR {r.ta.atr} ({(r.ta.atrPct * 100).toFixed(2)}%) ·
                                {" "}support {r.ta.support} · resistance {r.ta.resistance} ·
                                {" "}SL={r.ta.slAtrMultiple?.toFixed(2) ?? "?"}×ATR · {r.ta.entryLocation ?? ""}
                              </div>
                            ) : <div className="muted">No candle data.</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={9} className="empty">No second opinions yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
