import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type SecondOpinion } from "../api.js";
import { num, pct, shortTime } from "../format.js";

const ALL = "__all__";

type Row = SecondOpinion;
type Outcome = NonNullable<Row["outcome"]>;
type Stance = NonNullable<Row["verdict"]>["stance"];

/** Favorable = provider TP hit first OR the trade reached ≥1R in its favor. */
function favorable(o: Outcome): boolean {
  return o.firstHit === "tp" || (o.maxR ?? 0) >= 1;
}

/** A call counts as right when our stance matched the outcome (SO scorecard rule). */
function calledRight(r: Row): boolean {
  const o = r.outcome;
  if (!o || !o.resolved) return false;
  return favorable(o) === (r.verdict?.stance === "positive");
}

/**
 * Realized R "if the agree calls had been taken" — a conservative simulation
 * from real outcome fields: SL first = −1R; a TP-first win is scored at the
 * provider's claimed R to TP1 (rrClaimed); a timeout at its realized rAtClose;
 * a scratch at 0. Unfilled/ambiguous rows contribute nothing.
 */
function realizedR(r: Row): number | null {
  const o = r.outcome;
  if (!o || !o.resolved) return null;
  switch (o.outcomeClass) {
    case "loss":
      return -1;
    case "scratch":
      return 0;
    case "timeout":
      return o.rAtClose ?? null;
    case "win":
      return r.ta?.rrClaimed ?? null;
    default:
      break;
  }
  if (o.firstHit === "sl") return -1;
  if (o.firstHit === "tp") return r.ta?.rrClaimed ?? null;
  return null;
}

/** R to display in the Outcome column for a resolved row. */
function outcomeR(r: Row): number | null {
  const o = r.outcome;
  if (!o || !o.resolved) return null;
  switch (o.outcomeClass) {
    case "win":
      return o.maxR ?? r.ta?.rrClaimed ?? null;
    case "loss":
      return -1;
    case "timeout":
      return o.rAtClose ?? null;
    case "scratch":
      return 0;
    default:
      return o.maxR ?? null;
  }
}

function fmtR(r: number): string {
  return `${r >= 0 ? "+" : ""}${r.toFixed(1)}R`;
}

function verdictMeta(stance?: Stance): { label: string; cls: string } {
  if (stance === "positive") return { label: "agree", cls: "ok" };
  if (stance === "negative") return { label: "disagree", cls: "error" };
  if (stance === "neutral") return { label: "caution", cls: "warn" };
  return { label: "pending", cls: "" };
}

/** Concise, objective technical read composed from the TA snapshot. */
function techRead(r: Row): string {
  const ta = r.ta;
  if (!ta) return "";
  const parts: string[] = [`${ta.trend} trend`];
  if (ta.mtfAlignment) parts.push(ta.mtfAlignment);
  if (ta.entryLocation) parts.push(ta.entryLocation);
  parts.push(`S ${num(ta.support)} / R ${num(ta.resistance)}`);
  if (ta.rrRealistic !== undefined) parts.push(`R/R ≈ ${ta.rrRealistic.toFixed(1)}`);
  return parts.join(" · ");
}

function OutcomeCell({ r }: { r: Row }) {
  const o = r.outcome;
  if (!o) return <span className="num muted">pending</span>;

  if (!o.resolved) {
    if (o.outcomeClass === "notFilled" || o.filled === false)
      return <span className="num muted">working</span>;
    const rr = o.maxR;
    const cls = rr === undefined ? "muted" : rr >= 0 ? "gain" : "loss";
    return (
      <span className={`num ${cls}`}>open{rr !== undefined ? ` · ${fmtR(rr)}` : ""}</span>
    );
  }

  if (o.outcomeClass === "notFilled") return <span className="num muted">not filled</span>;

  const dispR = outcomeR(r);
  const right = calledRight(r);
  const cls = dispR === null ? "muted" : dispR >= 0 ? "gain" : right ? "" : "loss";
  const rTxt = dispR !== null ? ` · ${fmtR(dispR)}` : "";
  const check = right ? " ✓" : "";
  const suffix = dispR !== null && dispR < 0 && right ? " (call was right)" : "";
  return (
    <span className={`num ${cls}`}>
      closed{rTxt}
      {check}
      {suffix}
    </span>
  );
}

export function SecondOpinion() {
  const [rows, setRows] = useState<SecondOpinion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fGroup, setFGroup] = useState(ALL);
  const [fStance, setFStance] = useState<Stance | typeof ALL>(ALL);
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    api
      .secondOpinions(500)
      .then((d) => {
        setRows(d);
        setErr(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const groupOpts = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.groupName))].sort(),
    [rows],
  );

  // Group filter drives the page; stance filter narrows the table only.
  const base = (rows ?? []).filter((r) => fGroup === ALL || r.groupName === fGroup);
  const shown = base.filter((r) => fStance === ALL || r.verdict?.stance === fStance);

  const positives = base.filter((r) => r.verdict?.stance === "positive");
  const neutrals = base.filter((r) => r.verdict?.stance === "neutral");
  const negatives = base.filter((r) => r.verdict?.stance === "negative");

  const stat = (list: Row[]) => {
    const resolved = list.filter((r) => r.outcome?.resolved);
    const good = resolved.filter((r) => (r.outcome ? favorable(r.outcome) : false));
    return { count: list.length, resolved: resolved.length, good: good.length };
  };
  const agreeS = stat(positives);
  const cautionS = stat(neutrals);
  const disagreeS = stat(negatives);
  const disagreeRight = negatives.filter(
    (r) => r.outcome?.resolved && r.outcome && !favorable(r.outcome),
  ).length;

  const resolvedTotal = base.filter((r) => r.outcome?.resolved).length;
  const agreeShare = base.length ? agreeS.count / base.length : 0;
  const agreeHit = agreeS.resolved ? agreeS.good / agreeS.resolved : null;
  const cautionHit = cautionS.resolved ? cautionS.good / cautionS.resolved : null;

  const edgeVals: number[] = [];
  for (const r of positives) {
    const v = realizedR(r);
    if (v !== null) edgeVals.push(v);
  }
  const edge = edgeVals.length ? edgeVals.reduce((a, b) => a + b, 0) / edgeVals.length : null;

  const toggleStance = (s: Stance) => setFStance((cur) => (cur === s ? ALL : s));

  return (
    <>
      {err && (
        <div className="error-card">
          <span className="e-icon" aria-hidden>
            !
          </span>
          <span>{err}</span>
        </div>
      )}

      {/* Filter row: group segments + verdict count chips + observe-only meta */}
      <div className="panel">
        <div className="panel-body tight between">
          <div className="flex">
            <div className="seg">
              <span
                className={`seg-item${fGroup === ALL ? " active" : ""}`}
                onClick={() => setFGroup(ALL)}
              >
                All groups
              </span>
              {groupOpts.map((g) => (
                <span
                  key={g}
                  className={`seg-item${fGroup === g ? " active" : ""}`}
                  onClick={() => setFGroup(g)}
                >
                  {g}
                </span>
              ))}
            </div>
            <span className="hr" style={{ width: 1, height: 22, margin: "0 6px" }} />
            <div className="chips">
              <span
                className={`chip filter${fStance === "positive" ? " active" : ""}`}
                onClick={() => toggleStance("positive")}
              >
                Agree <span className="num">{agreeS.count}</span>
              </span>
              <span
                className={`chip filter${fStance === "neutral" ? " active" : ""}`}
                onClick={() => toggleStance("neutral")}
              >
                Caution <span className="num">{cautionS.count}</span>
              </span>
              <span
                className={`chip filter${fStance === "negative" ? " active" : ""}`}
                onClick={() => toggleStance("negative")}
              >
                Disagree <span className="num">{disagreeS.count}</span>
              </span>
            </div>
          </div>
          <div className="flex">
            <span className="small muted">observe-only · never trades</span>
            <button className="btn ghost icon sm" onClick={load} title="Refresh" aria-label="Refresh">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
        <div className="kpi">
          <div className="label">Assessments</div>
          <div className="value">{base.length}</div>
          <div className="delta">{resolvedTotal} resolved</div>
        </div>
        <div className="kpi">
          <div className="label">Agree</div>
          <div className="value">
            <span className="gain">{agreeS.count}</span>
          </div>
          <div className="delta">
            {pct(agreeShare, 0)}
            {agreeHit !== null ? ` · hit rate ${pct(agreeHit, 0)}` : ""}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Caution</div>
          <div className="value">
            <span className="warn">{cautionS.count}</span>
          </div>
          <div className="delta">
            {cautionHit !== null ? `hit rate ${pct(cautionHit, 0)}` : "awaiting outcomes"}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Disagree</div>
          <div className="value">
            <span className="loss">{disagreeS.count}</span>
          </div>
          <div className="delta">
            {disagreeS.resolved
              ? `${disagreeRight} of ${disagreeS.resolved} were right to disagree`
              : "awaiting outcomes"}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Edge of the analyst</div>
          <div className="value">
            {edge !== null ? (
              <span className={edge >= 0 ? "gain" : "loss"}>
                {edge >= 0 ? "+" : ""}
                {edge.toFixed(2)}
                <small>R</small>
              </span>
            ) : (
              <span className="muted">—</span>
            )}
          </div>
          <div className="delta">
            {edge !== null ? "if only 'agree' calls were taken" : "no resolved agree calls yet"}
          </div>
        </div>
      </div>

      {/* Second-opinions table */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Second opinions
            <span className="sub">independent technical read per signal · outcome tracked over time</span>
          </h2>
        </div>
        <div className="panel-body flush">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Group</th>
                  <th>Signal</th>
                  <th>Technical read</th>
                  <th>Verdict · rationale</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const vm = verdictMeta(r.verdict?.stance);
                  const price = r.entry ?? r.ta?.price;
                  const read = techRead(r);
                  const expanded = open === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className={expanded ? "expanded" : ""}
                        style={{ cursor: "pointer" }}
                        onClick={() => setOpen(expanded ? null : r.id)}
                      >
                        <td>
                          <span className="num muted">{shortTime(r.createdAt)}</span>
                        </td>
                        <td>{r.groupName}</td>
                        <td>
                          <span className="flex" style={{ gap: 8 }}>
                            <span className={`tag side ${r.side}`}>{r.side}</span>
                            <span className="sym">
                              <span className="coin">{r.symbol.slice(0, 3)}</span>
                              <span className="num w600">{r.symbol}</span>
                            </span>
                            {price !== undefined ? (
                              <span className="num muted">@ {num(price)}</span>
                            ) : null}
                          </span>
                        </td>
                        <td>
                          {read ? (
                            <span
                              className="small ink2"
                              style={{ whiteSpace: "normal", display: "block", maxWidth: 360 }}
                            >
                              {read}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {r.verdict ? (
                            <>
                              <span className="flex" style={{ gap: 6 }}>
                                <span className={`tag ${vm.cls}`}>{vm.label}</span>
                                <span className="num muted small">
                                  {r.verdict.confidence.toFixed(2)}
                                </span>
                              </span>
                              {r.verdict.summary ? (
                                <span
                                  className="small ink2"
                                  style={{
                                    whiteSpace: "normal",
                                    display: "block",
                                    maxWidth: 300,
                                    marginTop: 3,
                                  }}
                                >
                                  {r.verdict.summary}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <span className="tag">pending</span>
                          )}
                        </td>
                        <td>
                          <span className="flex" style={{ justifyContent: "space-between", gap: 10 }}>
                            <OutcomeCell r={r} />
                            <span className="muted" aria-hidden>
                              {expanded ? "▴" : "▾"}
                            </span>
                          </span>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="detail">
                          <td colSpan={6}>
                            <div
                              className="stack"
                              style={{ gap: 6, lineHeight: 1.5, maxWidth: "min(1180px, 88vw)" }}
                            >
                              <div>
                                <b>Verdict:</b> {r.verdict?.summary || "—"}
                                {r.verdict?.source === "heuristic" ? (
                                  <span className="muted small"> (rules)</span>
                                ) : null}
                                {r.verdict ? (
                                  <span className="muted small"> · score {r.verdict.score}</span>
                                ) : null}
                              </div>
                              {r.verdict?.redFlags?.length ? (
                                <div className="loss small">⚠ {r.verdict.redFlags.join(" · ")}</div>
                              ) : null}
                              {r.verdict?.strengths?.length ? (
                                <div className="gain small">✓ {r.verdict.strengths.join(" · ")}</div>
                              ) : null}
                              {r.verdict?.contributions?.length ? (
                                <div className="muted small">
                                  <b>Score breakdown:</b>{" "}
                                  {r.verdict.contributions
                                    .slice()
                                    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                                    .map((c) => (
                                      <span key={c.rule} className={c.delta >= 0 ? "gain" : "loss"}>
                                        {c.rule} {c.delta >= 0 ? "+" : ""}
                                        {c.delta}
                                        {"  "}
                                      </span>
                                    ))}
                                </div>
                              ) : null}
                              {r.ta ? (
                                <>
                                  {r.ta.frames?.length ? (
                                    <div className="muted small">
                                      <b>MTF:</b>{" "}
                                      {r.ta.frames
                                        .map((f) => `${f.interval} ${f.trend}(rsi ${f.rsi ?? "?"})`)
                                        .join(" · ")}
                                      {r.ta.mtfAlignment ? ` — ${r.ta.mtfAlignment}` : ""}
                                    </div>
                                  ) : null}
                                  <div className="muted small">
                                    price {num(r.ta.price)} · ATR {num(r.ta.atr)} (
                                    {(r.ta.atrPct * 100).toFixed(2)}%) · RSI {r.ta.rsi ?? "?"} · range{" "}
                                    {r.ta.rangePosition !== undefined
                                      ? `${Math.round(r.ta.rangePosition * 100)}%`
                                      : "?"}{" "}
                                    · support {num(r.ta.support)} · resistance {num(r.ta.resistance)} · SL=
                                    {r.ta.slAtrMultiple?.toFixed(2) ?? "?"}×ATR
                                    {r.ta.slAtrH !== undefined
                                      ? ` (${r.ta.slAtrH.toFixed(2)}× ${r.ta.atrHorizonTf}-ATR)`
                                      : ""}{" "}
                                    · {r.ta.entryLocation ?? ""}
                                    {r.ta.entryVsPricePct !== undefined ? (
                                      <span className={r.ta.entryStale ? "loss" : undefined}>
                                        {" · "}entry {r.ta.entryVsPricePct > 0 ? "+" : ""}
                                        {r.ta.entryVsPricePct.toFixed(2)}% vs live
                                        {r.ta.entryStale ? " ⚠ stale" : ""}
                                      </span>
                                    ) : null}
                                  </div>
                                  {r.ta.funding !== undefined ? (
                                    <div className="muted small">
                                      funding {(r.ta.funding * 100).toFixed(4)}% · premium{" "}
                                      {r.ta.premiumBps?.toFixed(1) ?? "?"} bps · OI{" "}
                                      {r.ta.openInterest
                                        ? Math.round(r.ta.openInterest).toLocaleString()
                                        : "?"}{" "}
                                      · vol vs avg {r.ta.volumeTrendPct?.toFixed(0) ?? "?"}%
                                    </div>
                                  ) : null}
                                  <div className="small">
                                    <b>Provider:</b>{" "}
                                    <span className="muted">
                                      entry {r.entry ?? "CMP"} · SL {r.stopLoss ?? "—"} · TP{" "}
                                      {r.takeProfits?.join("/") ?? "—"} (R/R{" "}
                                      {r.ta.rrClaimed?.toFixed(1) ?? "?"})
                                    </span>
                                    {r.ta.suggestion ? (
                                      <>
                                        {" · "}
                                        <b>Ours:</b>{" "}
                                        <span className="muted">
                                          SL {r.ta.suggestion.stopLoss} · TP {r.ta.suggestion.takeProfit}{" "}
                                          (R/R {r.ta.suggestion.rr.toFixed(1)})
                                        </span>
                                      </>
                                    ) : null}
                                  </div>
                                  {r.outcome ? (
                                    <div className="muted small">
                                      <b>Outcome:</b> firstHit {r.outcome.firstHit ?? "—"}
                                      {r.outcome.hoursToFirstHit !== undefined
                                        ? ` after ${r.outcome.hoursToFirstHit}h`
                                        : ""}{" "}
                                      · MFE {r.outcome.mfePct}% / MAE {r.outcome.maePct}% · maxR{" "}
                                      {r.outcome.maxR ?? "?"} · allTP {r.outcome.allTpHit ? "yes" : "no"}
                                    </div>
                                  ) : null}
                                </>
                              ) : (
                                <div className="muted small">No candle data.</div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && (
              <div className="empty">
                <div className="e-title">No second opinions</div>
                <div className="e-why">
                  {rows === null
                    ? "Loading independent assessments…"
                    : "No assessments match the current filters yet."}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
