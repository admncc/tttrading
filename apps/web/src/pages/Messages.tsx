import { useState } from "react";
import type { Group, Signal } from "@tttrading/shared";
import { api, messageImageUrl } from "../api.js";
import { num, shortTime } from "../format.js";
import { RiskDot } from "../components/Risk.js";

/** Filters over the already-loaded signal stream (view-only, no refetch). */
type Kind = "all" | "entries" | "management" | "recaps" | "chart";

/**
 * Raw channel message feed. Every message from a tracked channel is recorded
 * (even non-signals), so this is where we watch what the channels actually post
 * — useful for tuning parsing together.
 */
export function Messages({
  signals,
  groups,
  onChange,
}: {
  signals: Signal[];
  groups: Group[];
  onChange: () => void;
}) {
  const [groupId, setGroupId] = useState<string>("all");
  const [kind, setKind] = useState<Kind>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"time" | "group">("time");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Manual "paste a message and process it" tester.
  const [testGroup, setTestGroup] = useState<string>(groups[0]?.id ?? "");
  const [testText, setTestText] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const runTest = async () => {
    const gid = testGroup || groups[0]?.id;
    if (!gid || !testText.trim()) {
      setTestResult("Pick a channel and paste a message.");
      return;
    }
    setTestBusy(true);
    setTestResult(null);
    try {
      const sig = await api.simulate(gid, testText.trim());
      const p = sig.parsed;
      const desc = p
        ? `${p.side.toUpperCase()} ${p.symbol}${p.entries && p.entries.length > 1 ? ` · scale-in ×${p.entries.length}` : p.entry !== undefined ? ` @ ${p.entry}` : " @ market"}${p.stopLoss !== undefined ? ` · SL ${p.stopLoss}` : ""}${p.takeProfits?.length ? ` · TP ${p.takeProfits.join("/")}` : ""} (${p.source})`
        : "no signal parsed";
      setTestResult(`→ ${sig.status.toUpperCase()}: ${desc}${sig.error ? ` — ${sig.error}` : ""}`);
      onChange();
    } catch (e) {
      setTestResult(`Failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setTestBusy(false);
    }
  };

  const runBackfill = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.backfill(days);
      const total = res.reduce((s, r) => s + r.imported, 0);
      const errs = res.filter((r) => r.error);
      setResult(
        `Imported ${total} messages from ${res.length} channels.` +
          (errs.length ? ` Errors: ${errs.map((e) => `${e.groupName} (${e.error})`).join(", ")}` : ""),
      );
      onChange();
    } catch (e) {
      setResult(`Backfill failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  // Group filter first — kind chip counts reflect what's visible for the channel.
  const groupFiltered = signals.filter((s) => (groupId === "all" ? true : s.groupId === groupId));
  const counts = {
    entries: groupFiltered.filter((s) => !!s.parsed).length,
    management: groupFiltered.filter((s) => s.status === "managed").length,
    recaps: groupFiltered.filter((s) => !s.parsed && s.status !== "managed").length,
    chart: groupFiltered.filter((s) => !!s.hasImage).length,
  };

  const q = search.trim().toLowerCase();
  const shown = groupFiltered
    .filter((s) => {
      if (kind === "entries") return !!s.parsed;
      if (kind === "management") return s.status === "managed";
      if (kind === "recaps") return !s.parsed && s.status !== "managed";
      if (kind === "chart") return !!s.hasImage;
      return true;
    })
    .filter((s) => (q ? (s.rawText ?? "").toLowerCase().includes(q) : true))
    .slice()
    .sort((a, b) => {
      if (sort === "group") {
        const g = a.groupName.localeCompare(b.groupName);
        if (g !== 0) return g;
      }
      // Within a group (or overall for "time"), newest first.
      return (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "");
    });

  const toggleKind = (k: Kind) => setKind((cur) => (cur === k ? "all" : k));

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Manual message tester — paste a real message and run it through the
          full pipeline (parse → route → execute per the group's mode). */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Test a message
            <span className="sub">
              runs the real pipeline: parse → route → execute per the group's mode
            </span>
          </h2>
        </div>
        <div className="panel-body">
          <div className="form-grid" style={{ gridTemplateColumns: "220px 1fr" }}>
            <div className="field">
              <label>Group</label>
              <select
                className="input"
                value={testGroup}
                onChange={(e) => setTestGroup(e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.settings.executionMode})
                  </option>
                ))}
              </select>
              <span className="hint">
                With test mode on it's simulated; on a live/auto group it can place a real order.
              </span>
            </div>
            <div className="field">
              <label>Message text</label>
              <textarea
                className="input"
                rows={3}
                placeholder="Paste a channel message here…"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
              />
            </div>
          </div>
          <div className="between" style={{ marginTop: 12 }}>
            <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>
              {testResult ?? "Paste a message to see how it's parsed and routed."}
            </div>
            <button className="btn primary sm" disabled={testBusy} onClick={runTest}>
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
              {testBusy ? "Processing…" : "Run pipeline"}
            </button>
          </div>
        </div>
      </section>

      {/* Import channel history for learning/backfill. */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Import channel history
            <span className="sub">backfill past messages for parsing analysis — never executed</span>
          </h2>
        </div>
        <div className="panel-body">
          <div className="flex" style={{ flexWrap: "wrap" }}>
            <span className="small muted">Import the last</span>
            <input
              className="input num"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              style={{ width: 90 }}
            />
            <span className="small muted">days</span>
            <button className="btn primary sm" disabled={busy} onClick={runBackfill}>
              {busy ? "Importing…" : "Import"}
            </button>
            {result && <span className="small muted">{result}</span>}
          </div>
        </div>
      </section>

      {/* The message stream itself. */}
      <section className="panel">
        <div className="panel-head">
          <h2>
            Message stream
            <span className="sub">{shown.length} shown · as received from Telegram</span>
          </h2>
          <div className="actions">
            <select
              className="input"
              value={sort}
              onChange={(e) => setSort(e.target.value as "time" | "group")}
            >
              <option value="time">Sort: newest</option>
              <option value="group">Sort: by channel</option>
            </select>
          </div>
        </div>
        <div className="panel-body flush">
          {/* Filter row */}
          <div
            className="between"
            style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)" }}
          >
            <div className="flex" style={{ flexWrap: "wrap" }}>
              <div className="seg">
                <span
                  className={`seg-item${groupId === "all" ? " active" : ""}`}
                  onClick={() => setGroupId("all")}
                >
                  All groups
                </span>
                {groups.map((g) => (
                  <span
                    key={g.id}
                    className={`seg-item${groupId === g.id ? " active" : ""}`}
                    onClick={() => setGroupId(g.id)}
                    title={g.telegramChannel}
                  >
                    {g.name}
                  </span>
                ))}
              </div>
              <span className="hr" style={{ width: 1, height: 22, margin: "0 6px" }} />
              <div className="seg">
                <span
                  className={`seg-item${kind === "entries" ? " active" : ""}`}
                  onClick={() => toggleKind("entries")}
                >
                  Entries<span className="n">{counts.entries}</span>
                </span>
                <span
                  className={`seg-item${kind === "management" ? " active" : ""}`}
                  onClick={() => toggleKind("management")}
                >
                  Management<span className="n">{counts.management}</span>
                </span>
                <span
                  className={`seg-item${kind === "recaps" ? " active" : ""}`}
                  onClick={() => toggleKind("recaps")}
                >
                  Recaps<span className="n">{counts.recaps}</span>
                </span>
                <span
                  className={`seg-item${kind === "chart" ? " active" : ""}`}
                  onClick={() => toggleKind("chart")}
                >
                  With chart<span className="n">{counts.chart}</span>
                </span>
              </div>
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
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search text…"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  outline: "none",
                  width: "100%",
                  font: "inherit",
                }}
              />
            </span>
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              <div className="e-title">No messages</div>
              <div className="e-why">
                Once your Telegram session is connected and a channel is added as a group, messages
                appear here live. Adjust the filters above if you expected to see something.
              </div>
            </div>
          ) : (
            shown.map((s) => {
              const p = s.parsed;
              const isPdf = s.hasImage && s.attachmentType === "pdf";
              const isImg = s.hasImage && s.attachmentType !== "pdf";
              const entryVal =
                p && p.entries && p.entries.length > 1
                  ? `scale-in ×${p.entries.length}`
                  : p && p.entry !== undefined
                    ? num(p.entry)
                    : "market";
              return (
                <div className="msg" key={s.id}>
                  {/* Thumb: chart image, PDF placeholder, or text glyph. */}
                  {isImg ? (
                    <a
                      className="thumb"
                      href={messageImageUrl(s.id)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the attached chart at full size"
                    >
                      <img
                        src={messageImageUrl(s.id)}
                        alt="chart"
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    </a>
                  ) : isPdf ? (
                    <a
                      className="thumb"
                      href={messageImageUrl(s.id)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the attached PDF"
                    >
                      <span className="stack" style={{ alignItems: "center", gap: 2 }}>
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
                        </svg>
                        <span className="xs">PDF</span>
                      </span>
                    </a>
                  ) : (
                    <div className="thumb">
                      <span className="xs muted">text</span>
                    </div>
                  )}

                  <div>
                    <div className="head">
                      <span className="grp">{s.groupName}</span>
                      {p && <span className={`tag side ${p.side}`}>{p.side}</span>}
                      <span className={`tag ${s.status}`}>{s.status}</span>
                      <RiskDot risk={s.risk} />
                      {s.hasImage && (
                        <span className="small muted flex" style={{ gap: 4 }}>
                          {isPdf ? (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
                            </svg>
                          ) : (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <rect x="3" y="4" width="18" height="16" rx="2" />
                              <circle cx="9" cy="10" r="1.6" />
                              <path d="M21 16l-5-5-8 9" />
                            </svg>
                          )}
                          {isPdf ? "PDF" : "chart image"}
                        </span>
                      )}
                      <span className="when">{shortTime(s.receivedAt)}</span>
                    </div>

                    {s.rawText && <div className="body">{s.rawText}</div>}

                    {p && (
                      <div className="parsed">
                        <span className="kv">
                          <span className="k">sym</span>
                          <b>{p.symbol}</b>
                        </span>
                        <span className="kv">
                          <span className="k">side</span>
                          <b>{p.side}</b>
                        </span>
                        <span className="kv">
                          <span className="k">entry</span>
                          <b>{entryVal}</b>
                        </span>
                        {p.stopLoss !== undefined && (
                          <span className="kv">
                            <span className="k">sl</span>
                            <b>{num(p.stopLoss)}</b>
                          </span>
                        )}
                        {p.takeProfits && p.takeProfits.length > 0 && (
                          <span className="kv">
                            <span className="k">tp</span>
                            <b>
                              {p.takeProfits.length} level{p.takeProfits.length > 1 ? "s" : ""}
                            </b>
                          </span>
                        )}
                        {p.leverageHint !== undefined && (
                          <span className="kv">
                            <span className="k">lev</span>
                            <b>{p.leverageHint}x</b>
                          </span>
                        )}
                        <span className="kv">
                          <span className="k">conf</span>
                          <b>{p.confidence.toFixed(2)}</b>
                        </span>
                      </div>
                    )}

                    {s.error && !p && (
                      <div className="body small" style={{ color: "var(--loss)" }}>
                        {s.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
