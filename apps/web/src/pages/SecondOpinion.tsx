import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type SecondOpinion } from "../api.js";
import { shortTime } from "../format.js";

const ALL = "__all__";

function StanceBadge({ s }: { s?: "positive" | "negative" | "neutral" }) {
  if (!s) return <span className="tag">pending</span>;
  if (s === "neutral")
    return <span className="tag" style={{ background: "#64748b", color: "#fff", fontWeight: 600 }}>NEUTRAL</span>;
  const pos = s === "positive";
  return (
    <span className="tag" style={{ background: pos ? "#16a34a" : "#dc2626", color: "#fff", fontWeight: 600 }}>
      {pos ? "POSITIVE" : "NEGATIVE"}
    </span>
  );
}

function scoreColor(n: number) {
  // Aligned with the 3 verdict zones: >60 positive, 40–60 neutral, <40 negative.
  return n > 60 ? "#22c55e" : n >= 40 ? "#f59e0b" : "#ef4444";
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
        // Favorable = provider TP hit first OR the trade reached at least 1R in its favor.
        const good = r.outcome.firstHit === "tp" || (r.outcome.maxR ?? 0) >= 1;
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
          <h3 style={{ margin: "0 0 4px" }}>Our accuracy vs. outcome (resolved calls)</h3>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 11 }}>
            A call counts as right when our stance matched the outcome — favorable = provider TP hit first <b>or</b> the trade reached ≥1R in its favor.
          </p>
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
                  : o.outcomeClass === "win" ? "WIN (TP first) ✅"
                  : o.outcomeClass === "loss" ? "LOSS (SL first) ⛔"
                  : o.outcomeClass === "timeout" ? `timeout (${o.rAtClose ?? "?"}R)`
                  : o.outcomeClass === "notFilled" ? "not filled"
                  : o.outcomeClass === "ambiguous" ? "ambiguous"
                  : o.resolved ? "resolved" : "running";
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
                          <div
                            style={{
                              padding: "8px 6px",
                              display: "grid",
                              gap: 6,
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                              wordBreak: "break-word",
                              maxWidth: "min(1180px, 88vw)",
                              lineHeight: 1.5,
                              position: "sticky",
                              left: 8,
                            }}
                          >
                            <div><b>Verdict:</b> {r.verdict?.summary || "—"}</div>
                            {r.verdict?.redFlags?.length ? <div style={{ color: "#ef4444" }}>⚠ {r.verdict.redFlags.join(" · ")}</div> : null}
                            {r.verdict?.strengths?.length ? <div style={{ color: "#22c55e" }}>✓ {r.verdict.strengths.join(" · ")}</div> : null}
                            {r.verdict?.contributions?.length ? (
                              <div className="muted" style={{ fontSize: 12 }}>
                                <b>Score breakdown:</b>{" "}
                                {r.verdict.contributions
                                  .slice()
                                  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                                  .map((c) => (
                                    <span key={c.rule} style={{ color: c.delta >= 0 ? "#22c55e" : "#ef4444" }}>
                                      {c.rule} {c.delta >= 0 ? "+" : ""}{c.delta}{"  "}
                                    </span>
                                  ))}
                              </div>
                            ) : null}
                            {r.ta ? (
                              <>
                                {r.ta.frames?.length ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    <b>MTF:</b>{" "}
                                    {r.ta.frames.map((f) => `${f.interval} ${f.trend}(rsi ${f.rsi})`).join(" · ")}
                                    {r.ta.mtfAlignment ? ` — ${r.ta.mtfAlignment}` : ""}
                                  </div>
                                ) : null}
                                <div className="muted" style={{ fontSize: 12 }}>
                                  price {r.ta.price} · ATR {r.ta.atr} ({(r.ta.atrPct * 100).toFixed(2)}%) · RSI {r.ta.rsi ?? "?"} ·
                                  {" "}range {r.ta.rangePosition !== undefined ? `${Math.round(r.ta.rangePosition * 100)}%` : "?"} ·
                                  {" "}support {r.ta.support} · resistance {r.ta.resistance} ·
                                  {" "}SL={r.ta.slAtrMultiple?.toFixed(2) ?? "?"}×ATR{r.ta.slAtrH !== undefined ? ` (${r.ta.slAtrH.toFixed(2)}× ${r.ta.atrHorizonTf}-ATR)` : ""} · {r.ta.entryLocation ?? ""}
                                  {r.ta.entryVsPricePct !== undefined ? (
                                    <span style={{ color: r.ta.entryStale ? "#ef4444" : undefined }}>
                                      {" · "}entry {r.ta.entryVsPricePct > 0 ? "+" : ""}{r.ta.entryVsPricePct.toFixed(2)}% vs live
                                      {r.ta.entryStale ? " ⚠ stale" : ""}
                                    </span>
                                  ) : null}
                                </div>
                                {r.ta.funding !== undefined ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    funding {(r.ta.funding * 100).toFixed(4)}% · premium {r.ta.premiumBps?.toFixed(1) ?? "?"} bps ·
                                    {" "}OI {r.ta.openInterest ? Math.round(r.ta.openInterest).toLocaleString() : "?"} ·
                                    {" "}vol vs avg {r.ta.volumeTrendPct?.toFixed(0) ?? "?"}%
                                  </div>
                                ) : null}
                                <div style={{ fontSize: 12 }}>
                                  <b>Provider:</b> <span className="muted">entry {r.entry ?? "CMP"} · SL {r.stopLoss ?? "—"} · TP {r.takeProfits?.join("/") ?? "—"} (R/R {r.ta.rrClaimed?.toFixed(1) ?? "?"})</span>
                                  {r.ta.suggestion ? (
                                    <> {" · "}<b>Ours:</b> <span className="muted">SL {r.ta.suggestion.stopLoss} · TP {r.ta.suggestion.takeProfit} (R/R {r.ta.suggestion.rr.toFixed(1)})</span></>
                                  ) : null}
                                </div>
                                {r.outcome ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    <b>Outcome:</b> firstHit {r.outcome.firstHit ?? "—"}
                                    {r.outcome.hoursToFirstHit !== undefined ? ` after ${r.outcome.hoursToFirstHit}h` : ""} ·
                                    {" "}MFE {r.outcome.mfePct}% / MAE {r.outcome.maePct}% ·
                                    {" "}maxR {r.outcome.maxR ?? "?"} · allTP {r.outcome.allTpHit ? "yes" : "no"}
                                  </div>
                                ) : null}
                              </>
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
