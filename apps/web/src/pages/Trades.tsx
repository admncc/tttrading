import { Fragment, useMemo, useState } from "react";
import type { Trade, TradeStatus } from "@tttrading/shared";
import { api } from "../api.js";
import { num, shortTime, usd } from "../format.js";

type StatusChip = TradeStatus | "shadow";
const STATUS_CHIPS: StatusChip[] = ["open", "working", "closed", "failed", "canceled", "shadow"];
const CHIP_LABEL: Record<StatusChip, string> = {
  open: "Open",
  working: "Working",
  closed: "Closed",
  failed: "Failed",
  canceled: "Canceled",
  shadow: "Shadow",
};

/** Net PnL already realized from partial exits — MANUAL books (bankedPnl − fees)
 *  plus NATIVE TP scale-outs (tpRealizedPnl), both while the position is open. */
function netBanked(t: Trade): number | undefined {
  const manual = t.bankedPnl === undefined && t.bankedFees === undefined ? undefined : (t.bankedPnl ?? 0) - (t.bankedFees ?? 0);
  const tp = t.tpRealizedPnl;
  if (manual === undefined && tp === undefined) return undefined;
  return (manual ?? 0) + (tp ?? 0);
}

/** The size still open on the exchange — openSize once a native TP scaled out,
 *  else the accounting size (which manual partials already reduce). */
function openSize(t: Trade): number {
  return t.openSize ?? t.size;
}

/** Live unrealized PnL for an open trade from the current mark price — the
 *  actual open PnL on the REMAINING size only. Banked partials are NOT included
 *  here; they're shown separately on their own line. */
function unrealized(t: Trade, mark: number | undefined): number | undefined {
  if (t.status !== "open" || !mark || mark <= 0) return undefined;
  const dir = t.side === "long" ? 1 : -1;
  return (mark - t.entryPrice) * dir * openSize(t);
}

/** v2 semantic class for a signed money figure. */
function pnlCls(n: number | undefined): string {
  if (n === undefined || n === 0 || !Number.isFinite(n)) return "";
  return n > 0 ? "gain" : "loss";
}
/** usd() with an explicit leading + for positives (design shows "+$236.10"). */
function usdSigned(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const s = usd(n, digits);
  return n > 0 ? `+${s}` : s;
}

/** Short venue label for the position sub-line. */
function venueLabel(ex: Trade["exchange"]): string {
  switch (ex) {
    case undefined:
    case "hyperliquid":
      return "HL";
    case "hyperliquid-testnet":
      return "HL-test";
    case "aster":
      return "Aster";
    case "mexc":
      return "MEXC";
    default:
      return ex;
  }
}

/* ---------------------------------- icons --------------------------------- */
const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const IconSearch = () => (
  <svg width={13} height={13} {...svgProps}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);
const IconSync = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);
const IconExport = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M12 3v12M6 11l6 6 6-6M4 21h16" />
  </svg>
);
const IconClose = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const IconChevron = () => (
  <svg width={14} height={14} {...svgProps}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/* --------------------------- timeline classing ---------------------------- */
/** Map a history event category onto a timeline dot class. Display only. */
function tlClass(category: string): string {
  const c = category.toLowerCase();
  if (c.includes("open") || c.includes("entry") || c.includes("fill")) return "open";
  if (c.includes("breakeven") || c.includes("be")) return "be";
  if (c.includes("tp") || c.includes("target") || c.includes("take")) return "tp";
  if (c.includes("partial") || c.includes("book")) return "partial";
  if (c.includes("close") || c.includes("exit")) return "close";
  if (c.includes("stop") || c.includes("sl")) return "sl";
  return "";
}

export function Trades({
  trades,
  prices,
  onChange,
}: {
  trades: Trade[];
  prices: Record<string, number>;
  onChange: () => void;
}) {
  const [statuses, setStatuses] = useState<Set<StatusChip>>(new Set(["open"]));
  const [group, setGroup] = useState("all");
  const [outcome, setOutcome] = useState<"all" | "profit" | "loss">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [slInput, setSlInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [bookInput, setBookInput] = useState("");
  // A single expandable detail row per trade: it carries BOTH the inline Manage
  // panel and the History & TP-ladder (fetched async on expand).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.tradeHistory>> | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const prefill = (t: Trade) => {
    setSlInput(t.stopLoss ? String(t.stopLoss) : "");
    setTpInput(t.takeProfits?.length ? t.takeProfits.join(", ") : "");
    setBookInput("");
  };

  const toggle = async (t: Trade): Promise<void> => {
    if (expandedId === t.id) {
      setExpandedId(null);
      setHistory(null);
      setHistoryErr(null);
      return;
    }
    setExpandedId(t.id);
    prefill(t);
    setHistory(null);
    setHistoryErr(null);
    setHistoryBusy(true);
    try {
      setHistory(await api.tradeHistory(t.id));
    } catch (e) {
      setHistoryErr(`History failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const toggleStatus = (s: StatusChip) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const groupOpts = useMemo(() => [...new Set(trades.map((t) => t.groupName))].sort(), [trades]);
  const archivedCount = useMemo(() => trades.filter((t) => t.archived).length, [trades]);

  const statusCount = (s: StatusChip) =>
    s === "shadow"
      ? trades.filter((t) => !t.archived && t.shadow).length
      : trades.filter((t) => !t.archived && !t.shadow && t.status === s).length;

  const matchStatus = (t: Trade) => {
    if (statuses.size === 0) return !t.shadow; // no chip selected → all real trades
    if (t.shadow) return statuses.has("shadow");
    return statuses.has(t.status);
  };
  const matchOutcome = (t: Trade) => {
    if (outcome === "all") return true;
    if (t.realizedPnl === undefined) return false; // profit/loss only applies to settled trades
    return outcome === "profit" ? t.realizedPnl > 0 : t.realizedPnl < 0;
  };
  const q = query.trim().toLowerCase();
  const matchQuery = (t: Trade) =>
    !q ||
    t.symbol.toLowerCase().includes(q) ||
    t.groupName.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q);

  // A settled trade can be filed away; anything still live cannot.
  const canArchive = (t: Trade) => !t.shadow && t.status !== "open" && t.status !== "working";

  const shown = trades.filter((t) => {
    if (group !== "all" && t.groupName !== group) return false;
    if (!matchOutcome(t)) return false;
    if (!matchQuery(t)) return false;
    // Archived trades appear only when "Show archived" is on; the status chips
    // don't apply to them (they are all settled). Everything else honours chips.
    if (t.archived) return showArchived;
    return matchStatus(t);
  });

  /* ------------------------------ KPI strip ------------------------------ */
  const realTrades = useMemo(() => trades.filter((t) => !t.archived && !t.shadow), [trades]);
  const openReal = realTrades.filter((t) => t.status === "open");
  const workingReal = realTrades.filter((t) => t.status === "working");

  const openUpnl = openReal.reduce((a, t) => a + (unrealized(t, prices[t.symbol.toUpperCase()]) ?? 0), 0);
  const bankedTotal = openReal.reduce((a, t) => a + (netBanked(t) ?? 0), 0);
  const marginOpen = openReal.reduce((a, t) => a + (openSize(t) * t.entryPrice) / (t.leverage > 0 ? t.leverage : 1), 0);
  const marginWorking = workingReal.reduce((a, t) => a + t.notionalUsd / (t.leverage > 0 ? t.leverage : 1), 0);

  const todayStr = new Date().toDateString();
  const closedToday = realTrades.filter(
    (t) => t.status === "closed" && t.closedAt && new Date(t.closedAt).toDateString() === todayStr,
  );
  const realizedToday = closedToday.reduce((a, t) => a + (t.realizedPnl ?? 0), 0);

  const positions = [...openReal, ...workingReal];
  const targetsTotal = positions.reduce((a, t) => a + (t.manualPartials ?? 0) + (t.takeProfits?.length ?? 0), 0);
  const targetsNative = positions.reduce((a, t) => a + (t.tpFilledCount ?? 0), 0);
  const targetsManual = positions.reduce((a, t) => a + (t.manualPartials ?? 0), 0);
  const targetsHit = targetsNative + targetsManual;

  const naked = openReal.filter((t) => t.stopLoss === undefined).length;

  const filtersActive =
    statuses.size !== 1 || !statuses.has("open") || group !== "all" || outcome !== "all" || q !== "" || showArchived;
  const resetFilters = () => {
    setStatuses(new Set(["open"]));
    setGroup("all");
    setOutcome("all");
    setQuery("");
    setShowArchived(false);
  };

  /* ------------------------------ actions ------------------------------- */
  const close = async (t: Trade) => {
    const action = t.status === "working" ? "Cancel working order" : "Close position at market";
    if (!confirm(`${action}?\n\n${t.side.toUpperCase()} ${t.symbol} · ${t.groupName}`)) return;
    setBusyId(t.id);
    try {
      await api.closeTrade(t.id);
      onChange();
    } catch (e) {
      alert(`Close failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const sync = async (t: Trade) => {
    setBusyId(t.id);
    try {
      const res = await api.syncTrade(t.id);
      const on = res.venue ? ` on ${res.venue}` : "";
      if (res.note) alert(res.note);
      else if (res.changed)
        alert(`${t.symbol}: still live${on} — reopened${res.venue && res.venue !== t.exchange ? ` and re-homed to ${res.venue}` : ""} in the desk.`);
      else if (res.live) alert(`${t.symbol}: position confirmed live${on}.`);
      else alert(`${t.symbol}: no matching position on any connected venue — leaving as is.`);
      onChange();
    } catch (e) {
      alert(`Sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const syncAll = async () => {
    const targets = shown.filter((t) => !t.simulated && !t.shadow && (t.status === "open" || t.status === "working"));
    if (!targets.length) return alert("No live positions to sync.");
    if (!confirm(`Sync ${targets.length} position${targets.length > 1 ? "s" : ""} against the exchange?`)) return;
    setSyncingAll(true);
    let live = 0;
    let changed = 0;
    let errors = 0;
    for (const t of targets) {
      try {
        const r = await api.syncTrade(t.id);
        if (r.changed) changed++;
        else if (r.live) live++;
      } catch {
        errors++;
      }
    }
    setSyncingAll(false);
    onChange();
    alert(`Sync complete — ${live} confirmed live, ${changed} changed${errors ? `, ${errors} failed` : ""}.`);
  };

  const archive = async (t: Trade, on: boolean) => {
    if (!confirm(`${on ? "Archive" : "Restore"} ${t.symbol} (${t.groupName})?`)) return;
    setBusyId(t.id);
    try {
      await api.archiveTrade(t.id, on);
      onChange();
    } catch (e) {
      alert(`${on ? "Archive" : "Restore"} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const run = async (id: string, fn: () => Promise<unknown>, label: string) => {
    setBusyId(id);
    try {
      await fn();
      onChange();
    } catch (e) {
      alert(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusyId(null);
    }
  };

  const setStop = (t: Trade) => {
    const p = Number(slInput);
    if (!(p > 0)) return alert("Enter a valid stop price.");
    if (!confirm(`Set ${t.symbol} stop-loss to ${p}?\n\n${t.side.toUpperCase()} · ${t.groupName}`)) return;
    void run(t.id, () => api.setTradeStop(t.id, p), "Set SL");
  };
  const setBreakeven = (t: Trade) => {
    if (!confirm(`Move ${t.symbol} stop-loss to break-even (entry ${t.entryPrice})?\n\n${t.side.toUpperCase()} · ${t.groupName}`)) return;
    void run(t.id, () => api.setTradeBreakeven(t.id), "SL to BE");
  };
  const setTps = (t: Trade) => {
    const parsed = tpInput
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!confirm(`Replace ${t.symbol} take-profits with [${parsed.join(", ")}]?\n\n${t.side.toUpperCase()} · ${t.groupName}`)) return;
    void run(t.id, () => api.setTradeTakeProfits(t.id, parsed), "Set TPs");
  };
  const book = (t: Trade) => {
    const p = Number(bookInput);
    if (!(p > 0 && p < 100)) return alert("Enter a percent between 0 and 100.");
    if (!confirm(`Book ${p}% of ${t.symbol} at market?\n\n${t.side.toUpperCase()} · ${t.groupName}`)) return;
    void run(t.id, () => api.bookPartial(t.id, p / 100), "Book");
  };

  const exportCsv = () => {
    const cols = [
      "id",
      "opened",
      "symbol",
      "group",
      "venue",
      "side",
      "status",
      "leverage",
      "notionalUsd",
      "openSize",
      "entry",
      "mark",
      "exit",
      "stopLoss",
      "takeProfits",
      "realizedPnl",
      "unrealizedPnl",
      "banked",
      "riskScore",
    ];
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = shown.map((t) => {
      const mark = prices[t.symbol.toUpperCase()];
      return [
        t.id,
        t.openedAt,
        t.symbol,
        t.groupName,
        venueLabel(t.exchange),
        t.side,
        t.status,
        t.leverage,
        t.notionalUsd,
        openSize(t),
        t.entryPrice,
        mark ?? "",
        t.exitPrice ?? "",
        t.stopLoss ?? "",
        (t.takeProfits ?? []).join(" "),
        t.realizedPnl ?? "",
        unrealized(t, mark) ?? "",
        netBanked(t) ?? "",
        t.risk?.score ?? "",
      ];
    });
    const csv = [cols, ...rows].map((r) => r.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* -------------------------------- render ------------------------------- */
  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        <div className="kpi">
          <div className="label">Open uPnL</div>
          <div className="value">
            <span className={`num ${pnlCls(openUpnl)}`}>{usdSigned(openUpnl)}</span>
          </div>
          <div className="delta">
            {openReal.length} position{openReal.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Banked</div>
          <div className="value">
            <span className={pnlCls(bankedTotal)}>{usdSigned(bankedTotal)}</span>
          </div>
          <div className="delta">open partials</div>
        </div>
        <div className="kpi">
          <div className="label">Margin bound</div>
          <div className="value">{usd(marginOpen + marginWorking, 0)}</div>
          <div className="delta">
            open {usd(marginOpen, 0)} · working {usd(marginWorking, 0)}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Realized today</div>
          <div className="value">
            <span className={pnlCls(realizedToday)}>{usdSigned(realizedToday)}</span>
          </div>
          <div className="delta">
            {closedToday.length} closed
          </div>
        </div>
        <div className="kpi">
          <div className="label">Targets hit</div>
          <div className="value">
            {targetsHit} <small>/ {targetsTotal}</small>
          </div>
          <div className="delta">
            {targetsNative} native · {targetsManual} manual
          </div>
        </div>
        <div className="kpi">
          <div className="label">Naked positions</div>
          <div className="value">
            <span className={naked === 0 ? "gain" : "loss"}>{naked}</span>
          </div>
          <div className="delta">{naked === 0 ? "all positions have a stop" : `${naked} without a stop`}</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>
            Positions
            <span className="sub">
              {statusCount("open")} open · {statusCount("working")} working · {statusCount("closed")} closed
            </span>
          </h2>
          <div className="actions">
            <span className="small muted">default view shows open only — working/closed are opt-in</span>
          </div>
        </div>

        <div style={{ padding: "12px 16px" }}>
          <div className="between">
            <div className="flex" style={{ flexWrap: "wrap" }}>
              <div className="chips">
                {STATUS_CHIPS.map((s) => (
                  <span
                    key={s}
                    className={`chip filter${statuses.has(s) ? " active" : ""}`}
                    onClick={() => toggleStatus(s)}
                  >
                    {CHIP_LABEL[s]} <span className="num">{statusCount(s)}</span>
                  </span>
                ))}
              </div>
              <span className="hr" style={{ width: 1, height: 20, margin: "0 4px" }} />
              <span
                className={`check${showArchived ? " on" : ""}`}
                onClick={() => setShowArchived((v) => !v)}
              >
                <span className="box" />
                <span>Show archived{archivedCount ? ` (${archivedCount})` : ""}</span>
              </span>
            </div>
            <div className="flex" style={{ flexWrap: "wrap" }}>
              <span className="search" style={{ minWidth: 200 }}>
                <IconSearch />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Symbol, group, id…"
                  style={{
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    boxShadow: "none",
                    color: "var(--ink)",
                    width: "100%",
                    height: "100%",
                    padding: 0,
                    fontFamily: "inherit",
                    fontSize: "var(--fs-sm)",
                  }}
                />
              </span>
              <select
                className="input"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                style={{ width: "auto", minWidth: 150, height: 28 }}
              >
                <option value="all">All channels</option>
                {groupOpts.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <div className="seg">
                {(["all", "profit", "loss"] as const).map((o) => (
                  <button
                    key={o}
                    className={`seg-item${outcome === o ? " active" : ""}`}
                    onClick={() => setOutcome(o)}
                  >
                    {o === "all" ? "All" : o === "profit" ? "Profit" : "Loss"}
                  </button>
                ))}
              </div>
              <button className="btn sm" onClick={() => void syncAll()} disabled={syncingAll}>
                <IconSync />
                {syncingAll ? "Syncing…" : "Sync all"}
              </button>
              <button className="btn ghost sm" onClick={exportCsv} disabled={shown.length === 0}>
                <IconExport />
                Export
              </button>
              {filtersActive && (
                <button className="btn ghost sm" onClick={resetFilters}>
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="table-scroll">
          <table className="table dense">
            <thead>
              <tr>
                <th>Position</th>
                <th>Side / Status</th>
                <th className="num">Notional</th>
                <th className="num">Size</th>
                <th className="num">Entry</th>
                <th className="num">Mark / Exit</th>
                <th className="num">Stop</th>
                <th>Targets</th>
                <th className="num">PnL</th>
                <th>Risk</th>
                <th>Opened</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const sym = t.symbol.toUpperCase();
                const mark = prices[sym];
                const uPnl = unrealized(t, mark);
                const banked = netBanked(t);
                const expanded = expandedId === t.id;
                const canManage = (t.status === "open" || t.status === "working") && !t.shadow && !t.simulated;

                // NOTIONAL: original stays; a partial (manual or native TP) trims
                // the remaining position value = openSize × entry. Margin = /lev.
                const remNotional = openSize(t) * t.entryPrice;
                const lev = t.leverage > 0 ? t.leverage : 1;
                const trimmed = t.status === "open" && remNotional < t.notionalUsd * 0.995;

                // SIZE: full filled amount vs remaining after scale-outs.
                const fullSize = t.initialSize ?? t.size;
                const reduced = fullSize > openSize(t) + 1e-9;

                // TARGETS: manual books (info) + native TP fills (gain), then empties.
                const tps = t.takeProfits ?? [];
                const manualP = t.manualPartials ?? 0;
                const tpFilled = t.tpFilledCount ?? 0;
                const totalLegs = manualP + tps.length;
                const takenLegs = manualP + tpFilled;
                const emptyLegs = Math.max(0, totalLegs - takenLegs);
                const nextTp = tps[tpFilled];
                const showNext = (t.status === "open" || t.status === "working") && nextTp !== undefined;

                return (
                  <Fragment key={t.id}>
                    <tr className={expanded ? "expanded" : ""}>
                      <td>
                        <span className="sym">
                          <span className="coin">{sym.slice(0, 3)}</span>
                          <span>
                            {t.symbol}
                            {t.shadow ? (
                              <span className="tag" title="Blocked red signal (not a real position)" style={{ marginLeft: 6 }}>
                                shadow
                              </span>
                            ) : t.simulated ? (
                              <span className="tag pending" title="Simulated (test mode) — no real order" style={{ marginLeft: 6 }}>
                                sim
                              </span>
                            ) : null}
                            <span className="sub">
                              {t.groupName} · {venueLabel(t.exchange)} · {t.leverage}x
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="stack" style={{ gap: 3, alignItems: "flex-start" }}>
                          <span className={`tag side ${t.side}`}>{t.side}</span>
                          <span className={`tag ${t.status}`}>{t.status}</span>
                        </span>
                      </td>
                      <td className="num">
                        {usd(t.notionalUsd, 0)}
                        {trimmed && <span className="muted" title="Notional after partial TP">{` → ${usd(remNotional, 0)}`}</span>}
                        <span className="sub">
                          margin {usd(t.notionalUsd / lev, 0)}
                          {trimmed && <span title="Margin after partial TP">{` → ${usd(remNotional / lev, 0)}`}</span>}
                        </span>
                      </td>
                      <td className="num">
                        {t.status === "working" ? (
                          <>
                            <span className="muted">—</span>
                            <span className="sub">limit resting</span>
                          </>
                        ) : (
                          <>
                            {num(openSize(t))}
                            {reduced && <span className="sub">of {num(fullSize)} filled</span>}
                          </>
                        )}
                      </td>
                      <td className="num">
                        {num(t.entryPrice)}
                        {t.status === "working" && <span className="sub">limit</span>}
                      </td>
                      <td className="num">
                        {t.exitPrice !== undefined ? (
                          <>
                            {num(t.exitPrice)}
                            <span className="sub">exit</span>
                          </>
                        ) : (t.status === "open" || t.status === "working") && mark ? (
                          num(mark)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {t.stopLoss !== undefined ? (
                          <>
                            {t.bracketProtected && (
                              <span className="gain" title="SL/TP live on the exchange (protected)">
                                ✓{" "}
                              </span>
                            )}
                            {num(t.stopLoss)}
                            {t.slMovedToBreakeven && (
                              <span className="sub" style={{ color: "var(--champagne)" }}>
                                at break-even
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {totalLegs > 0 ? (
                          <>
                            <span className="targets">
                              {Array.from({ length: manualP }).map((_, i) => (
                                <i key={`m${i}`} className="hit manual" />
                              ))}
                              {Array.from({ length: tpFilled }).map((_, i) => (
                                <i key={`n${i}`} className="hit" />
                              ))}
                              {Array.from({ length: emptyLegs }).map((_, i) => (
                                <i key={`e${i}`} />
                              ))}
                              <span className="t-label">
                                {takenLegs}/{totalLegs}
                              </span>
                            </span>
                            {showNext && (
                              <span className="sub">
                                next <span className="num">{num(nextTp)}</span>
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num">
                        {t.realizedPnl !== undefined ? (
                          <>
                            <span className={`num ${pnlCls(t.realizedPnl)}`}>{usdSigned(t.realizedPnl)}</span>
                            <span className="sub">realized</span>
                          </>
                        ) : uPnl !== undefined ? (
                          <>
                            <span className={`num ${pnlCls(uPnl)}`} title="Open unrealized PnL on the remaining size only">
                              {usdSigned(uPnl)}
                            </span>
                            <span className="sub">uPnL</span>
                            {banked !== undefined ? (
                              <span className="sub" title="Realized separately from partial exits so far">
                                banked{" "}
                                <span style={{ color: banked >= 0 ? "var(--gain)" : "var(--loss)" }}>
                                  {usdSigned(banked)}
                                </span>
                              </span>
                            ) : (
                              <span className="sub muted">no partials booked</span>
                            )}
                          </>
                        ) : banked !== undefined ? (
                          <>
                            <span className={`num ${pnlCls(banked)}`}>{usdSigned(banked)}</span>
                            <span className="sub">banked</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {t.risk ? (
                          <span
                            className={`risk ${t.risk.level}`}
                            title={`Risk ${t.risk.level} · ${t.risk.score}/100\n${t.risk.reasons.join("\n")}`}
                          >
                            <i>{t.risk.level.charAt(0).toUpperCase()}</i>
                            {t.risk.score}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <span className="num muted">{shortTime(t.openedAt)}</span>
                        {t.status === "closed" && (
                          <span className="sub" title={t.closedAt ? shortTime(t.closedAt) : undefined}>
                            closed
                          </span>
                        )}
                      </td>
                      <td className="right nowrap">
                        {t.shadow ? null : (
                          <span className="btn-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                            {t.archived ? (
                              <button
                                className="btn ghost sm"
                                disabled={busyId === t.id}
                                title="Restore this trade to the active list and analytics"
                                onClick={() => archive(t, false)}
                              >
                                {busyId === t.id ? "…" : "Restore"}
                              </button>
                            ) : (
                              <>
                                {canManage && t.status === "working" && (
                                  <button className="btn danger sm" disabled={busyId === t.id} onClick={() => close(t)}>
                                    {busyId === t.id ? "…" : "Cancel"}
                                  </button>
                                )}
                                {canManage && (
                                  <button
                                    className="btn sm"
                                    aria-expanded={expanded}
                                    onClick={() => void toggle(t)}
                                    style={expanded ? { borderColor: "var(--champagne-line)", color: "var(--champagne-2)" } : undefined}
                                  >
                                    Manage
                                  </button>
                                )}
                                {!canManage && !t.simulated && (
                                  <button
                                    className="btn ghost sm"
                                    disabled={busyId === t.id}
                                    title="Check the exchange — reopen if the position is still live"
                                    onClick={() => sync(t)}
                                  >
                                    {busyId === t.id ? "…" : "Sync"}
                                  </button>
                                )}
                                {canArchive(t) && (
                                  <button
                                    className="btn ghost sm"
                                    disabled={busyId === t.id}
                                    title="Archive — hide from the active list and exclude from analytics"
                                    onClick={() => archive(t, true)}
                                  >
                                    {busyId === t.id ? "…" : "Archive"}
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              className="btn ghost icon sm"
                              aria-expanded={expanded}
                              title={expanded ? "Hide history" : "History"}
                              onClick={() => void toggle(t)}
                              style={expanded ? { color: "var(--champagne-2)", transform: "rotate(180deg)" } : undefined}
                            >
                              <IconChevron />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>

                    {expanded && (
                      <tr className="detail">
                        <td colSpan={12}>
                          <div
                            className={canManage ? "grid-2" : undefined}
                            style={{
                              gridTemplateColumns: canManage ? "minmax(0,1fr) minmax(0,1fr)" : undefined,
                              gap: 16,
                              paddingTop: 12,
                            }}
                          >
                            {canManage && (
                              <div>
                                <div className="caps mb8">
                                  Manage · {t.symbol} {t.side} · {t.id}
                                </div>
                                <div className="manage">
                                  <div className="m-row">
                                    <div className="m-field">
                                      <span className="caps">Position</span>
                                      <div className="btn-row">
                                        <button className="btn danger sm" disabled={busyId === t.id} onClick={() => close(t)}>
                                          <IconClose />
                                          {t.status === "working" ? "Cancel order…" : "Close position…"}
                                        </button>
                                        {t.status === "open" && (
                                          <button
                                            className="btn gain sm"
                                            disabled={busyId === t.id}
                                            title="Move the stop-loss to break-even (entry). Only works when the trade is in profit."
                                            onClick={() => setBreakeven(t)}
                                          >
                                            SL to BE
                                          </button>
                                        )}
                                        <button className="btn sm" disabled={busyId === t.id} onClick={() => sync(t)}>
                                          <IconSync />
                                          Sync
                                        </button>
                                        <button
                                          className="btn ghost sm"
                                          title="Reset the fields below to the trade's current values"
                                          onClick={() => prefill(t)}
                                        >
                                          Reset
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="m-row">
                                    <div className="m-field">
                                      <span className="caps">Stop-loss</span>
                                      <div className="row">
                                        <input
                                          className="input num"
                                          value={slInput}
                                          onChange={(e) => setSlInput(e.target.value)}
                                          placeholder="price"
                                          style={{ width: 110 }}
                                        />
                                        <button className="btn sm" disabled={busyId === t.id} onClick={() => setStop(t)}>
                                          Set SL
                                        </button>
                                      </div>
                                      <span className="hint">
                                        {t.status === "open"
                                          ? `BE = entry ${num(t.entryPrice)} · guarded to in-profit`
                                          : "resting order — applied on fill"}
                                      </span>
                                    </div>
                                    <div className="m-field">
                                      <span className="caps">Take-profits</span>
                                      <div className="row">
                                        <input
                                          className="input num"
                                          value={tpInput}
                                          onChange={(e) => setTpInput(e.target.value)}
                                          placeholder="e.g. 65000, 66000"
                                          style={{ width: 210 }}
                                        />
                                        <button className="btn sm" disabled={busyId === t.id} onClick={() => setTps(t)}>
                                          Set TPs
                                        </button>
                                      </div>
                                      <span className="hint">comma-separated · replaces the ladder</span>
                                    </div>
                                    {t.status === "open" && (
                                      <div className="m-field">
                                        <span className="caps">Book partial</span>
                                        <div className="row">
                                          <div className="input-group" style={{ width: 96 }}>
                                            <input
                                              className="input num"
                                              value={bookInput}
                                              onChange={(e) => setBookInput(e.target.value)}
                                              placeholder="50"
                                            />
                                            <span className="addon">%</span>
                                          </div>
                                          <button className="btn primary sm" disabled={busyId === t.id} onClick={() => book(t)}>
                                            Book
                                          </button>
                                        </div>
                                        <span className="hint">
                                          {Number(bookInput) > 0 && Number(bookInput) < 100
                                            ? `≈ ${num((openSize(t) * Number(bookInput)) / 100)} ${t.symbol} at market`
                                            : "percent of remaining size at market"}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}

                            <div>
                              <div className="caps mb8">History &amp; TP ladder</div>
                              {historyBusy && <div className="muted small">Loading…</div>}
                              {historyErr && <div className="small loss">{historyErr}</div>}
                              {!historyBusy &&
                                history &&
                                (() => {
                                  const s = history.summary;
                                  const totalTargets = s.manualPartials + s.takeProfits.length;
                                  const hitLegs = s.manualPartials + s.tpFilledCount;
                                  const remOpen = s.openSize ?? s.size;
                                  return (
                                    <>
                                      <div className="ladder">
                                        <span className="rung">
                                          <span className="k">Entry</span>
                                          {num(s.entryPrice)}
                                        </span>
                                        <span className="rung">
                                          <span className="k">SL</span>
                                          {s.stopLoss !== undefined ? num(s.stopLoss) : "—"}
                                          {s.slMovedToBreakeven ? " · BE" : ""}
                                        </span>
                                        {s.takeProfits.map((tp, i) => {
                                          const filled = i < s.tpFilledCount;
                                          return (
                                            <span key={i} className={`rung${filled ? " hit" : ""}`}>
                                              <span className="k">TP{i + 1}</span>
                                              {num(tp)}
                                              {filled ? " ✓ native" : ""}
                                            </span>
                                          );
                                        })}
                                        {s.manualPartials > 0 && (
                                          <span className="rung manual">
                                            <span className="k">Manual</span>
                                            {s.manualPartials} book{s.manualPartials > 1 ? "s" : ""}
                                          </span>
                                        )}
                                        <span className="rung">
                                          <span className="k">State</span>
                                          {totalTargets > 0 ? `${hitLegs}/${totalTargets} hit · ` : ""}
                                          {num(remOpen)} open{s.slMovedToBreakeven ? " · BE set" : ""}
                                        </span>
                                      </div>
                                      {history.events.length > 0 ? (
                                        <div className="mt12">
                                          <div className="timeline">
                                            {history.events.map((h, i) => (
                                              <div key={i} className={`tl-item ${tlClass(h.category)}`}>
                                                <span className="when">{shortTime(h.ts)}</span>
                                                <span
                                                  className="what"
                                                  style={{
                                                    color:
                                                      h.level === "error"
                                                        ? "var(--loss)"
                                                        : h.level === "warn"
                                                          ? "var(--warn)"
                                                          : undefined,
                                                  }}
                                                >
                                                  {h.message}
                                                </span>
                                                <span className="amt muted">{h.level !== "info" ? h.level : ""}</span>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="muted xs mt12">
                                          No timestamped events recorded (this trade predates per-event tagging — the summary
                                          above is reconstructed from the trade record; new trades show a full event timeline).
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={12}>
                    <div className="empty">
                      <div className="e-icon">
                        <svg {...svgProps} width={18} height={18}>
                          <path d="M7 3v3M7 14v7M17 3v5M17 16v5" />
                          <rect x="4.5" y="6" width="5" height="8" rx="1" />
                          <rect x="14.5" y="8" width="5" height="8" rx="1" />
                        </svg>
                      </div>
                      <div className="e-title">No trades</div>
                      <div className="e-why">
                        {showArchived
                          ? "Nothing matches the current filters. Try clearing the search or status chips."
                          : "No positions match. Adjust the status chips, channel, or search — or enable “Show archived”."}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel-foot">
          <span>
            Sizes show the <b>actual filled</b> amount; remaining size after partial scale-outs. Sub-$1 prices keep
            significant figures.
          </span>
          <span>{shown.length} shown</span>
        </div>
      </section>
    </>
  );
}
