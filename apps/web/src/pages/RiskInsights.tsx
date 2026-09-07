import { useEffect, useMemo, useState } from "react";
import { api, type CapTier, type InsightTrade, type OpenRisk, type RiskHeat } from "../api.js";
import { usd as money } from "../format.js";
import { DEFAULT_RANGE, RangePicker, rangeWindow, type RangeState } from "../dateRange.js";

/* ---- local display helpers (compact, sign-first — preserved verbatim) ------ */
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}`;
const clampW = (n: number) => `${Math.max(0, Math.min(100, n)).toFixed(0)}%`;

/* Semantic colour → v2 class (money or danger only). */
const signCls = (n: number) => (n > 0 ? "gain" : n < 0 ? "loss" : "muted");
const wrCls = (w: number) => (w >= 0.55 ? "gain" : w >= 0.45 ? "warn" : "loss");
const pfCls = (p: number) => (p >= 2 ? "gain" : p >= 1.3 ? "warn" : "loss");
const expCls = (e?: number) => (e === undefined ? "muted" : e >= 0.3 ? "gain" : e >= 0 ? "warn" : "loss");
const sqnCls = (s?: number) => (s === undefined ? "muted" : s >= 2.5 ? "gain" : s >= 1.6 ? "warn" : "loss");
const meterCls = (cls: string) => (cls === "gain" ? "ok" : cls === "loss" ? "danger" : cls);

interface Bucket { key: string; tier?: CapTier; n: number; winRate: number; net: number; avg: number }

function weekLabel(at: string): string {
  if (!at) return "";
  const d = new Date(at).getUTCDate();
  const w = Math.min(4, Math.ceil(d / 7));
  return `Week ${w} (${{ 1: "1–7", 2: "8–14", 3: "15–21", 4: "22–31" }[w]})`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function weekdayName(iso: string): string {
  if (!iso) return "";
  return DOW[new Date(iso).getUTCDay()] ?? "";
}
function weekShort(iso: string): string {
  if (!iso) return "";
  return `W${Math.min(4, Math.ceil(new Date(iso).getUTCDate() / 7))}`;
}

/* ---- trading session from an entry time (UTC) ----------------------------- */
// Crypto is 24/7 but liquidity still tracks the legacy sessions. Coarse buckets.
const SESSION_ORDER = ["Asia", "EU", "US", "Late"];
function sessionOf(iso: string): string {
  if (!iso) return "";
  const h = new Date(iso).getUTCHours();
  if (h < 7) return "Asia"; // ~00–07 UTC (Tokyo/Singapore)
  if (h < 12) return "EU"; // ~07–12 UTC (London)
  if (h < 21) return "US"; // ~12–21 UTC (New York)
  return "Late"; // ~21–24 UTC (thin)
}

/* ---- hold-time bucket ----------------------------------------------------- */
const HOLD_ORDER = ["Scalp <4h", "Intraday 4–24h", "Swing 1–3d", "Position >3d", "Unknown"];
function holdBucket(h?: number): string {
  if (h === undefined) return "Unknown";
  if (h < 4) return "Scalp <4h";
  if (h < 24) return "Intraday 4–24h";
  if (h < 72) return "Swing 1–3d";
  return "Position >3d";
}
function holdFmt(h?: number): string {
  if (h === undefined) return "—";
  return h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
}

/* ================= professional edge statistics ============================ */
interface Edge {
  n: number;
  winRate: number;
  net: number;
  avg: number;
  profitFactor: number; // gross profit / gross loss
  payoff: number; // avg win / avg loss
  breakEvenWr: number; // win rate needed to break even at this payoff
  nR: number; // trades with a known R (stop known)
  expectancyR?: number; // mean R — the average $ won per $ risked
  stdR?: number;
  sqn?: number; // Van Tharp System Quality Number = mean(R)/std(R) × √n
  maxDD: number; // max peak-to-trough drop on the cumulative-net curve ($)
  maxDDpct?: number; // as % of the peak reached
  maxLossStreak: number;
  maxWinStreak: number;
  avgHold?: number; // hours
  avgSlip?: number; // % (entry slippage)
  top3Share?: number; // share of gross profit from the 3 biggest winners (outlier dependence)
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function edgeOf(trades: InsightTrade[]): Edge {
  const n = trades.length;
  // RI-4: classify by outcomeClass — scratch (≈0R break-even) is neither a win
  // nor a loss, so it drops out of win-rate but stays in expectancy/net.
  const wins = trades.filter((t) => t.outcomeClass === "win");
  const losses = trades.filter((t) => t.outcomeClass === "loss");
  const decided = wins.length + losses.length; // win-rate denominator excludes scratch
  const net = trades.reduce((s, t) => s + t.net, 0);
  const grossProfit = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const breakEvenWr = Number.isFinite(payoff) && payoff > 0 ? 1 / (1 + payoff) : 0;

  const rs = trades.map((t) => t.r).filter((r): r is number => r !== undefined && Number.isFinite(r));
  const nR = rs.length;
  const expectancyR = nR ? rs.reduce((s, r) => s + r, 0) / nR : undefined;
  const stdR = nR >= 2 ? std(rs) : undefined;
  // Van Tharp SQN: caps the sample at 100 so a large n can't inflate the score.
  const sqn = expectancyR !== undefined && stdR && stdR > 0 ? (expectancyR / stdR) * Math.sqrt(Math.min(nR, 100)) : undefined;

  // Drawdown + streaks on the settle-ordered cumulative-net curve.
  const asc = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let cum = 0, peak = 0, maxDD = 0, ddPeakAt = 0;
  let winStreak = 0, lossStreak = 0, maxWin = 0, maxLoss = 0;
  for (const t of asc) {
    cum += t.net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) { maxDD = dd; ddPeakAt = peak; }
    if (t.net >= 0) { winStreak++; lossStreak = 0; } else { lossStreak++; winStreak = 0; }
    if (winStreak > maxWin) maxWin = winStreak;
    if (lossStreak > maxLoss) maxLoss = lossStreak;
  }
  const maxDDpct = ddPeakAt > 0 ? maxDD / ddPeakAt : undefined;

  const holds = trades.map((t) => t.holdHours).filter((h): h is number => h !== undefined);
  const avgHold = holds.length ? holds.reduce((s, h) => s + h, 0) / holds.length : undefined;
  const slips = trades.map((t) => t.slipPct).filter((s): s is number => s !== undefined);
  const avgSlip = slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : undefined;

  // Outlier dependence: how much of gross profit comes from the 3 biggest wins.
  // High (>~50%) means the "edge" is a few lottery trades, not a repeatable process.
  const top3 = wins.map((t) => t.net).sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0);
  const top3Share = grossProfit > 0 ? top3 / grossProfit : undefined;

  return {
    n, winRate: decided ? wins.length / decided : 0, net, avg: n ? net / n : 0,
    profitFactor, payoff, breakEvenWr, nR, expectancyR, stdR, sqn,
    maxDD, maxDDpct, maxLossStreak: maxLoss, maxWinStreak: maxWin, avgHold, avgSlip, top3Share,
  };
}

// Van Tharp SQN bands (100-trade scale).
function sqnLabel(s?: number): string {
  if (s === undefined) return "—";
  if (s >= 5) return "superb";
  if (s >= 3) return "excellent";
  if (s >= 2.5) return "good";
  if (s >= 2) return "average";
  if (s >= 1.6) return "below avg";
  return "poor";
}
const fmt = (n?: number, d = 2) => (n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d));
const inf = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "∞");
const rMult = (e?: number) => (e === undefined ? "—" : `${e >= 0 ? "+" : ""}${e.toFixed(2)}R`);

/* ---- best factor combination per trader (Spotlight) ----------------------- */
interface Combo { label: string; n: number; winRate: number; net: number }
const SPOT_DIMS: ((t: InsightTrade) => string)[] = [
  (t) => t.side,
  (t) => `${t.tier}-cap`,
  (t) => t.symbol,
  (t) => weekdayName(t.openedAt),
  (t) => weekShort(t.at),
  (t) => sessionOf(t.openedAt),
];
const SPOT_SUBSETS: number[][] = (() => {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << SPOT_DIMS.length; mask++) {
    const s: number[] = [];
    for (let i = 0; i < SPOT_DIMS.length; i++) if (mask & (1 << i)) s.push(i);
    if (s.length > 3) continue;
    if (s.includes(1) && s.includes(2)) continue; // tier+coin redundant
    out.push(s);
  }
  return out;
})();
function bestCombos(trades: InsightTrade[], topN = 3, minN = 3): Combo[] {
  const m = new Map<string, { n: number; wins: number; losses: number; net: number; label: string }>();
  for (const t of trades) {
    for (const sub of SPOT_SUBSETS) {
      const toks = sub.map((i) => SPOT_DIMS[i]!(t));
      if (toks.some((x) => !x)) continue;
      const key = sub.join(",") + "::" + toks.join("|");
      const e = m.get(key) ?? { n: 0, wins: 0, losses: 0, net: 0, label: toks.join(" · ") };
      e.n += 1;
      if (t.outcomeClass === "win") e.wins += 1;
      else if (t.outcomeClass === "loss") e.losses += 1;
      e.net += t.net;
      m.set(key, e);
    }
  }
  return [...m.values()]
    .filter((e) => e.n >= minN && e.wins + e.losses > 0 && e.wins / (e.wins + e.losses) >= 0.5)
    .map((e) => ({ label: e.label, n: e.n, winRate: e.wins / (e.wins + e.losses), net: e.net }))
    .sort((a, b) => b.net - a.net || b.winRate - a.winRate)
    .slice(0, topN);
}

function agg(trades: InsightTrade[], keyOf: (t: InsightTrade) => string, tierOf?: (t: InsightTrade) => CapTier): Bucket[] {
  const m = new Map<string, { n: number; wins: number; losses: number; net: number; tier?: CapTier }>();
  for (const t of trades) {
    const k = keyOf(t);
    if (!k) continue;
    const e = m.get(k) ?? { n: 0, wins: 0, losses: 0, net: 0, tier: tierOf?.(t) };
    e.n += 1;
    if (t.outcomeClass === "win") e.wins += 1; // RI-4: scratch excluded from win-rate
    else if (t.outcomeClass === "loss") e.losses += 1;
    e.net += t.net;
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([key, e]) => ({ key, tier: e.tier, n: e.n, winRate: e.wins + e.losses ? e.wins / (e.wins + e.losses) : 0, net: e.net, avg: e.net / e.n }))
    .sort((a, b) => b.net - a.net);
}

/* Best-net bucket in each of a channel's headline dimensions. */
interface DimBest { dim: string; label: string; net: number }
function bestByDim(trades: InsightTrade[]): DimBest[] {
  const dims: { dim: string; keyOf: (t: InsightTrade) => string }[] = [
    { dim: "Session", keyOf: (t) => sessionOf(t.openedAt) },
    { dim: "Hold", keyOf: (t) => holdBucket(t.holdHours) },
    { dim: "Coin", keyOf: (t) => t.symbol },
    { dim: "Side", keyOf: (t) => t.side },
  ];
  const out: DimBest[] = [];
  for (const d of dims) {
    const best = agg(trades, d.keyOf)[0]; // agg is sorted by net desc
    if (best && best.key) out.push({ dim: d.dim, label: best.key, net: best.net });
  }
  return out;
}

function equitySeries(trades: InsightTrade[]): number[] {
  const asc = [...trades].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let c = 0;
  return asc.map((t) => (c += t.net));
}

function Sparkline({ data, width = 200, height = 40, full }: { data: number[]; width?: number; height?: number; full?: boolean }) {
  if (!data.length) return <span className="muted xs">—</span>;
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const span = max - min || 1;
  const n = data.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => height - ((v - min) / span) * height;
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = data[data.length - 1] ?? 0;
  const stroke = last >= 0 ? "var(--gain)" : "var(--loss)";
  return (
    <svg width={full ? "100%" : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="spark" style={{ display: "block" }}>
      <line x1={0} y1={y(0)} x2={width} y2={y(0)} stroke="var(--line)" strokeWidth={1} />
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TierTag({ tier }: { tier?: string }) {
  if (!tier) return null;
  return <span className="tag neutral plain" style={{ marginLeft: 6, fontSize: 10, height: 16 }}>{tier}</span>;
}

/* ================= portfolio risk (KPI grid + live positions) ============== */
function PortfolioRisk({ open, heat, onRefresh }: { open: OpenRisk[]; heat?: RiskHeat; onRefresh: () => void }) {
  // RI-2: heat is measured on FILLED positions only; working limit orders are
  // shown separately as the worst-case "if all fill" number, never as live heat.
  const real = open.filter((p) => !p.working);
  const workingOrders = open.filter((p) => p.working);

  const longN = real.filter((p) => p.side === "long").reduce((s, p) => s + p.notional, 0);
  const shortN = real.filter((p) => p.side === "short").reduce((s, p) => s + p.notional, 0);
  const gross = longN + shortN;
  const netExp = longN - shortN;
  const knownRisk = heat?.riskLiveUsd ?? real.filter((p) => p.riskUsd !== undefined).reduce((s, p) => s + (p.riskUsd ?? 0), 0);
  const naked = real.filter((p) => !p.hasStop);
  const nakedNotional = naked.reduce((s, p) => s + p.notional, 0);
  const equity = heat?.totalEquity; // RI-1: summed across all venues
  const heatPct = heat?.heatLive ?? (equity && equity > 0 ? knownRisk / equity : undefined);
  const heatIfAll = heat?.heatIfAllFilled;
  const grossPct = equity && equity > 0 ? gross / equity : undefined;
  const netPct = equity && equity > 0 ? netExp / equity : undefined;
  const perVenue = (heat?.perVenue ?? []).filter((v) => v.equity > 0 || v.riskUsd > 0);
  const venues = [...new Set(real.map((p) => p.venue))];

  // Single-name + tier concentration (share of gross exposure).
  const byCoin = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const p of real) {
    byCoin.set(p.symbol, (byCoin.get(p.symbol) ?? 0) + p.notional);
    byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + p.notional);
  }
  const topCoin = [...byCoin.entries()].sort((a, b) => b[1] - a[1])[0];
  const topCoinPct = topCoin && gross > 0 ? topCoin[1] / gross : 0;

  const heatKpiCls = heatPct === undefined ? "" : heatPct > 0.06 ? "loss" : heatPct > 0.03 ? "warn" : "gain";
  const venueHeatCls = (h?: number) => (h === undefined ? "muted" : h > 0.06 ? "loss" : h > 0.03 ? "warn" : "gain");

  const flags = [
    naked.length ? `${naked.length} position(s) without a stop — unbounded downside` : "",
    heatPct !== undefined && heatPct > 0.06 ? `heat ${(heatPct * 100).toFixed(1)}% over the ~6% prudent cap` : "",
    Math.abs(netPct ?? 0) > 1.2 ? `directional: net exposure ${((netPct ?? 0) * 100).toFixed(0)}% of equity (one-way beta bet)` : "",
    topCoinPct > 0.5 ? `${topCoin?.[0]} is ${(topCoinPct * 100).toFixed(0)}% of gross — single-name concentration` : "",
  ].filter(Boolean).join(" · ");

  const maxRisk = Math.max(1, ...real.map((p) => p.riskUsd ?? 0));

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
        <div className="kpi">
          <div className="label">Portfolio heat</div>
          <div className="value">
            {heatPct === undefined ? money(knownRisk, 0) : <span className={heatKpiCls}>{(heatPct * 100).toFixed(1)}<small>%</small></span>}
          </div>
          <div className="delta">
            {heatPct !== undefined && (
              <div className={`meter ${meterCls(heatKpiCls)}`} style={{ width: 56 }}><i style={{ width: clampW((heatPct / 0.06) * 100) }} /></div>
            )}
            <span className="small muted">
              {heatPct === undefined
                ? "risk USDC (equity n/a)"
                : `${money(knownRisk, 0)} at risk · cap ~6%${heatIfAll !== undefined ? ` · if all fill ${(heatIfAll * 100).toFixed(1)}%` : ""}`}
            </span>
          </div>
        </div>

        <div className="kpi">
          <div className="label">Naked positions</div>
          <div className="value"><span className={naked.length ? "loss" : "gain"}>{naked.length}</span></div>
          <div className="delta">{naked.length ? `${money(nakedNotional, 0)} unbounded · ${naked.map((p) => p.symbol).join(", ")}` : "every position has a stop"}</div>
        </div>

        <div className="kpi">
          <div className="label">Net exposure</div>
          <div className="value"><span className={signCls(netExp)}>{netExp >= 0 ? "+" : "−"}{money(Math.abs(netExp), 0)}</span></div>
          <div className="delta">
            long {money(longN, 0)} · short {money(shortN, 0)}{netPct !== undefined ? ` · ${netPct >= 0 ? "+" : ""}${(netPct * 100).toFixed(0)}% of equity` : ""}
          </div>
        </div>

        <div className="kpi">
          <div className="label">Gross leverage</div>
          <div className="value">{grossPct === undefined ? money(gross, 0) : <>{grossPct.toFixed(2)}<small>x</small></>}</div>
          <div className="delta">{money(gross, 0)} notional{equity ? ` / ${money(equity, 0)} equity` : ""}</div>
        </div>

        <div className="kpi">
          <div className="label">Top-coin concentration</div>
          <div className="value">
            {topCoin ? <span className={topCoinPct > 0.4 ? "warn" : ""}>{(topCoinPct * 100).toFixed(1)}<small>%</small></span> : "—"}
          </div>
          <div className="delta">{topCoin ? `${topCoin[0]} · ${money(topCoin[1], 0)} of ${money(gross, 0)}` : "no open exposure"}</div>
        </div>

        <div className="kpi">
          <div className="label">Open positions</div>
          <div className="value">{real.length}{workingOrders.length ? <small>+{workingOrders.length} working</small> : null}</div>
          <div className="delta">
            {gross > 0 ? [...byTier.entries()].map(([t, v]) => `${t} ${((v / gross) * 100).toFixed(0)}%`).join(" · ") : "—"}
            {venues.length ? ` · ${venues.length} venue${venues.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Portfolio risk — live open positions<span className="sub">all venues</span></h2>
          <div className="actions">
            <button className="btn ghost sm" onClick={onRefresh} title="Reload risk data">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
              Refresh
            </button>
          </div>
        </div>

        {real.length === 0 && workingOrders.length === 0 ? (
          <div className="panel-body">
            <div className="empty">
              <div className="e-title">No open positions</div>
              <div className="e-why">Nothing is at risk right now. Heat, exposure and concentration appear once positions are live.</div>
            </div>
          </div>
        ) : (
          <div className="panel-body flush">
            <div className="table-scroll">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Venue</th>
                    <th>Side</th>
                    <th className="num">Notional</th>
                    <th className="num">Lev</th>
                    <th className="num">Risk $ to stop</th>
                    <th className="num">% equity</th>
                    <th>Stop</th>
                    <th>Working?</th>
                    <th>Heat</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p, i) => {
                    const isWorking = p.working;
                    const riskKnown = !isWorking && p.riskUsd !== undefined;
                    const eqPct = riskKnown && equity && equity > 0 ? ((p.riskUsd ?? 0) / equity) * 100 : undefined;
                    const stop = isWorking
                      ? <span className="tag neutral">stop planned</span>
                      : !p.hasStop
                        ? <span className="tag loss">no stop</span>
                        : (p.riskUsd ?? -1) === 0
                          ? <span className="tag brand">at break-even</span>
                          : <span className="tag ok">stop set</span>;
                    return (
                      <tr key={`${p.symbol}-${p.channel}-${i}`}>
                        <td>
                          <span className="sym">
                            <span className="coin">{p.symbol.slice(0, 3)}</span>
                            <span>{p.symbol}<span className="sub">{p.channel}</span></span>
                          </span>
                        </td>
                        <td><span className="tag venue">{p.venue}</span></td>
                        <td><span className={`tag side ${p.side}`}>{p.side}</span></td>
                        <td className="num">{money(p.notional, 0)}</td>
                        <td className="num">{p.leverage}x</td>
                        <td className="num">
                          {!riskKnown ? <span className="muted">—</span>
                            : (p.riskUsd ?? 0) === 0 ? <span className="gain">{money(0, 2)}</span>
                              : <span className="loss">−{money(p.riskUsd ?? 0, 2)}</span>}
                        </td>
                        <td className="num">{eqPct === undefined ? <span className="muted">—</span> : `${eqPct.toFixed(2)}%`}</td>
                        <td>{stop}</td>
                        <td>{isWorking ? <span className="tag working">yes · resting</span> : <span className="tag neutral plain">no</span>}</td>
                        <td>
                          {riskKnown ? (
                            <div className={`meter ${(p.riskUsd ?? 0) / maxRisk >= 0.75 ? "warn" : "ok"}`} style={{ width: 72 }}>
                              <i style={{ width: clampW(((p.riskUsd ?? 0) / maxRisk) * 100) }} />
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="right w600">Total risk to stop</td>
                    <td className="num loss">−{money(knownRisk, 2)}</td>
                    <td className="num">{equity && equity > 0 ? `${((knownRisk / equity) * 100).toFixed(2)}%` : "—"}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {(perVenue.length > 1 || flags) && (
          <div className="panel-body" style={{ borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 10 }}>
            {perVenue.length > 1 && (
              <div>
                <div className="caps mb8">Per-venue heat <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>(margin isn't shared — liquidation risk is per venue)</span></div>
                <div className="flex" style={{ flexWrap: "wrap", gap: 8 }}>
                  {perVenue.map((v) => (
                    <span className="kv" key={v.venue}>
                      <span className="k">{v.venue}</span>
                      <b className={venueHeatCls(v.heat)}>{v.heat === undefined ? "—" : `${(v.heat * 100).toFixed(1)}%`}</b>
                      <span className="muted">{money(v.riskUsd, 0)} / {money(v.equity, 0)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {flags && <div className="callout suggest">⚠ Risk flags: {flags}</div>}
          </div>
        )}

        <div className="panel-foot">
          <span>Risk $ = distance to stop × size. Working orders commit margin but carry no stop risk until filled.</span>
          <span>Live heat <span className={heatKpiCls || "muted"}>{heatPct === undefined ? "n/a" : `${(heatPct * 100).toFixed(1)}%`}</span> · {money(knownRisk, 0)} at risk</span>
        </div>
      </section>
    </>
  );
}

/* ---- edge scorecard card (per channel) ------------------------------------ */
function EdgeCard({ rank, name, e, trades }: { rank: number; name: string; e: Edge; trades: InsightTrade[] }) {
  const dims = bestByDim(trades);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{name}<span className="sub">{e.n} trades</span></h2>
        <div className="actions"><span className="tag brand">rank {rank}</span></div>
      </div>
      <div className="panel-body">
        <div className="stat-grid">
          <div className="stat">
            <span className="caps">Expectancy</span>
            <span className={`v ${expCls(e.expectancyR)}`}>{rMult(e.expectancyR)}</span>
            <span className="d">{e.nR}/{e.n} with stop</span>
          </div>
          <div className="stat">
            <span className="caps">SQN</span>
            <span className={`v ${e.nR < 30 ? "muted" : sqnCls(e.sqn)}`}>{fmt(e.sqn, 2)}</span>
            <span className="d">{e.nR < 30 ? `N=${e.nR}` : sqnLabel(e.sqn)}</span>
          </div>
          <div className="stat">
            <span className="caps">Win rate</span>
            <span className={`v ${wrCls(e.winRate)}`}>{(e.winRate * 100).toFixed(1)}<small>%</small></span>
          </div>
          <div className="stat">
            <span className="caps">PF</span>
            <span className={`v ${pfCls(e.profitFactor)}`}>{inf(e.profitFactor)}</span>
            <span className="d">payoff {inf(e.payoff)}×</span>
          </div>
          <div className="stat">
            <span className="caps">Max DD</span>
            <span className="v loss">−{e.maxDD.toFixed(0)}</span>
            <span className="d">{e.maxDDpct !== undefined ? `${(e.maxDDpct * 100).toFixed(0)}% of peak` : "USDC"}</span>
          </div>
          <div className="stat">
            <span className="caps">Loss streak</span>
            <span className={`v ${e.maxLossStreak >= 5 ? "loss" : ""}`}>{e.maxLossStreak}<small>L</small></span>
            <span className="d">best win {e.maxWinStreak}</span>
          </div>
          <div className="stat">
            <span className="caps">Top-3 dep.</span>
            <span className={`v ${e.top3Share !== undefined && e.top3Share > 0.5 ? "warn" : ""}`}>{e.top3Share === undefined ? "—" : `${(e.top3Share * 100).toFixed(0)}`}<small>%</small></span>
            <span className="d">of gross profit</span>
          </div>
          <div className="stat">
            <span className="caps">Avg hold</span>
            <span className="v">{holdFmt(e.avgHold)}</span>
            <span className="d">{e.avgSlip !== undefined ? `slip ${e.avgSlip >= 0 ? "+" : ""}${e.avgSlip.toFixed(2)}%` : ""}</span>
          </div>
        </div>
        {dims.length > 0 && (
          <>
            <div className="caps mt16 mb8">Best factor per dimension</div>
            {dims.map((d) => (
              <div className="between small" key={d.dim} style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="muted" style={{ width: 56 }}>{d.dim}</span>
                <span className="grow">{d.label}</span>
                <span className={`num ${signCls(d.net)}`}>{usd(d.net)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/* ---- compact breakdown table panel ---------------------------------------- */
function BreakdownPanel({ title, sub, rows, nameLabel, showTier, sparks }: {
  title: string; sub?: string; rows: Bucket[]; nameLabel: string; showTier?: boolean; sparks?: Record<string, number[]>;
}) {
  const cols = sparks ? 6 : 5;
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}{sub && <span className="sub">{sub}</span>}</h2></div>
      <div className="panel-body flush">
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                <th>{nameLabel}</th>
                <th className="num">Trades</th>
                <th className="num">Win</th>
                <th className="num">Net</th>
                <th className="num">Avg</th>
                {sparks && <th>Trend</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={cols}><div className="empty"><div className="e-why">No trades match.</div></div></td></tr>
              ) : rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}{showTier && <TierTag tier={r.tier} />}</td>
                  <td className="num muted">{r.n}</td>
                  <td className={`num ${wrCls(r.winRate)}`}>{pct(r.winRate)}</td>
                  <td className={`num ${signCls(r.net)}`}>{usd(r.net)}</td>
                  <td className={`num ${signCls(r.avg)}`}>{usd(r.avg)}</td>
                  {sparks && <td style={{ width: 130 }}><Sparkline data={sparks[r.key] ?? []} width={120} height={26} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ---- R-multiple distribution --------------------------------------------- */
const R_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "≤ −2R", lo: -Infinity, hi: -2 },
  { label: "−2…−1R", lo: -2, hi: -1 },
  { label: "−1…0R", lo: -1, hi: 0 },
  { label: "0…1R", lo: 0, hi: 1 },
  { label: "1…2R", lo: 1, hi: 2 },
  { label: "2…3R", lo: 2, hi: 3 },
  { label: "≥ 3R", lo: 3, hi: Infinity },
];
function RHistogram({ trades }: { trades: InsightTrade[] }) {
  const rs = trades.map((t) => t.r).filter((r): r is number => r !== undefined && Number.isFinite(r));
  if (rs.length === 0) return <div className="empty"><div className="e-why">No trades with a known stop yet — R-multiples need entry + stop.</div></div>;
  const rows = R_BUCKETS.map((b) => ({ b, c: rs.filter((r) => r > b.lo && r <= b.hi).length }));
  const max = Math.max(1, ...rows.map((r) => r.c));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr 32px", gap: 6, alignItems: "center" }}>
      {rows.map(({ b, c }) => (
        <div key={b.label} style={{ display: "contents" }}>
          <span className="caps" style={{ textAlign: "right", letterSpacing: 0 }}>{b.label}</span>
          <div className={`meter ${b.hi <= 0 ? "danger" : "ok"}`}><i style={{ width: clampW((c / max) * 100) }} /></div>
          <span className="num right">{c}</span>
        </div>
      ))}
    </div>
  );
}

const ALL = "__all__";

export function RiskInsights() {
  const [trades, setTrades] = useState<InsightTrade[] | null>(null);
  const [open, setOpen] = useState<OpenRisk[]>([]);
  const [heat, setHeat] = useState<RiskHeat | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [fChannel, setFChannel] = useState(ALL);
  const [fCoin, setFCoin] = useState(ALL);
  const [fTier, setFTier] = useState(ALL);
  const [fSide, setFSide] = useState(ALL);
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE);

  const load = () => {
    api
      .riskInsights()
      .then((d) => { setTrades(d.trades); setOpen(d.open ?? []); setHeat(d.heat); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const channelOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.channel))].sort(), [trades]);
  const coinOpts = useMemo(() => [...new Set((trades ?? []).map((t) => t.symbol))].sort(), [trades]);

  const win = useMemo(() => rangeWindow(range), [range]);
  const filtered = useMemo(
    () =>
      (trades ?? []).filter(
        (t) =>
          (fChannel === ALL || t.channel === fChannel) &&
          (fCoin === ALL || t.symbol === fCoin) &&
          (fTier === ALL || t.tier === fTier) &&
          (fSide === ALL || t.side === fSide) &&
          (!win.from || (t.at && t.at >= win.from)) &&
          (!win.to || (t.at && t.at < win.to)),
      ),
    [trades, fChannel, fCoin, fTier, fSide, win],
  );

  const overall = useMemo(() => edgeOf(filtered), [filtered]);
  const edgeRows = useMemo(() => {
    const byCh = new Map<string, InsightTrade[]>();
    for (const t of filtered) { const a = byCh.get(t.channel) ?? []; a.push(t); byCh.set(t.channel, a); }
    return [...byCh.entries()].map(([key, ts]) => ({ key, e: edgeOf(ts) })).sort((a, b) => (b.e.expectancyR ?? -99) - (a.e.expectancyR ?? -99));
  }, [filtered]);
  const maxExp = useMemo(() => Math.max(0.0001, ...edgeRows.map((r) => r.e.expectancyR ?? 0)), [edgeRows]);

  const byChannel = useMemo(() => agg(filtered, (t) => t.channel), [filtered]);
  const bySymbol = useMemo(() => agg(filtered, (t) => t.symbol, (t) => t.tier), [filtered]);
  const byTier = useMemo(() => agg(filtered, (t) => t.tier), [filtered]);
  const bySide = useMemo(() => agg(filtered, (t) => t.side), [filtered]);
  const bySession = useMemo(() => agg(filtered, (t) => sessionOf(t.openedAt)).sort((a, b) => SESSION_ORDER.indexOf(a.key) - SESSION_ORDER.indexOf(b.key)), [filtered]);
  const byHold = useMemo(() => agg(filtered, (t) => holdBucket(t.holdHours)).sort((a, b) => HOLD_ORDER.indexOf(a.key) - HOLD_ORDER.indexOf(b.key)), [filtered]);
  const byWeekday = useMemo(
    () => agg(filtered, (t) => weekdayName(t.openedAt)).sort((a, b) => WD_ORDER.indexOf(a.key) - WD_ORDER.indexOf(b.key)),
    [filtered],
  );
  const byWeek = useMemo(() => agg(filtered, (t) => weekLabel(t.at)).sort((a, b) => a.key.localeCompare(b.key)), [filtered]);
  const eq = useMemo(() => equitySeries(filtered), [filtered]);
  const eqLast = eq[eq.length - 1] ?? 0;
  const spotlight = useMemo(() => {
    const byCh = new Map<string, InsightTrade[]>();
    for (const t of filtered) { const a = byCh.get(t.channel) ?? []; a.push(t); byCh.set(t.channel, a); }
    return [...byCh.entries()]
      .map(([channel, ts]) => ({ channel, n: ts.length, combos: bestCombos(ts) }))
      .sort((a, b) => (b.combos[0]?.net ?? -Infinity) - (a.combos[0]?.net ?? -Infinity));
  }, [filtered]);
  const channelSparks = useMemo(
    () => Object.fromEntries(byChannel.map((r) => [r.key, equitySeries(filtered.filter((t) => t.channel === r.key))])),
    [byChannel, filtered],
  );

  const filtersActive = fChannel !== ALL || fCoin !== ALL || fTier !== ALL || fSide !== ALL || range.preset !== "all";
  const sel = (label: string, value: string, set: (v: string) => void, opts: { v: string; l: string }[]) => (
    <div className="field" style={{ minWidth: 130 }}>
      <span className="label">{label}</span>
      <select className="input" value={value} onChange={(e) => set(e.target.value)}>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>
  );

  if (err) return <div className="error-card"><span>{err}</span></div>;
  if (!trades) return <div className="empty"><div className="e-title">Loading…</div></div>;

  return (
    <>
      {/* Live portfolio risk — independent of the closed-trade filters. */}
      <PortfolioRisk open={open} heat={heat} onRefresh={load} />

      {trades.length === 0 ? (
        <div className="empty">
          <div className="e-title">No settled trades yet</div>
          <div className="e-why">Edge stats — expectancy, SQN, profit factor, drawdown — appear once trades close.</div>
        </div>
      ) : (
        <>
          {/* filter bar */}
          <section className="panel">
            <div className="panel-body tight" style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
              {sel("Channel", fChannel, setFChannel, [{ v: ALL, l: "All channels" }, ...channelOpts.map((c) => ({ v: c, l: c }))])}
              {sel("Coin", fCoin, setFCoin, [{ v: ALL, l: "All coins" }, ...coinOpts.map((c) => ({ v: c, l: c }))])}
              {sel("Cap tier", fTier, setFTier, [{ v: ALL, l: "All tiers" }, { v: "large", l: "large" }, { v: "mid", l: "mid" }, { v: "small", l: "small" }])}
              {sel("Side", fSide, setFSide, [{ v: ALL, l: "Long + Short" }, { v: "long", l: "long" }, { v: "short", l: "short" }])}
              <div className="field"><span className="label">Range</span><RangePicker value={range} onChange={setRange} /></div>
              <div style={{ flex: 1 }} />
              <span className="small muted" style={{ alignSelf: "center" }}>
                {filtered.length} trade{filtered.length === 1 ? "" : "s"} · <span className={signCls(eqLast)}>{usd(eqLast)} USDC net</span>
              </span>
              {filtersActive && <button className="btn ghost sm" onClick={() => { setFChannel(ALL); setFCoin(ALL); setFTier(ALL); setFSide(ALL); setRange(DEFAULT_RANGE); }}>Clear</button>}
            </div>
          </section>

          {filtered.length === 0 ? (
            <div className="empty"><div className="e-title">No trades match these filters</div><div className="e-why">Widen the range or clear a filter to see edge stats.</div></div>
          ) : (
            <>
              {/* headline edge for the current selection */}
              <section className="panel">
                <div className="panel-head"><h2>Edge — current selection<span className="sub">expectancy · system quality · profit factor · drawdown</span></h2></div>
                <div className="panel-body">
                  <div className="stat-grid">
                    <div className="stat"><span className="caps">Expectancy</span><span className={`v ${expCls(overall.expectancyR)}`}>{rMult(overall.expectancyR)}</span><span className="d">per trade · {overall.nR}/{overall.n} with stop</span></div>
                    <div className="stat"><span className="caps">System Quality</span><span className={`v ${overall.nR < 30 ? "muted" : sqnCls(overall.sqn)}`}>{fmt(overall.sqn, 2)}</span><span className="d">{overall.nR < 30 ? `low conf · ${overall.nR}/30+` : sqnLabel(overall.sqn)}</span></div>
                    <div className="stat"><span className="caps">Win rate</span><span className={`v ${wrCls(overall.winRate)}`}>{(overall.winRate * 100).toFixed(1)}<small>%</small></span><span className="d">break-even {overall.breakEvenWr ? pct(overall.breakEvenWr) : "—"}</span></div>
                    <div className="stat"><span className="caps">Profit factor</span><span className={`v ${pfCls(overall.profitFactor)}`}>{inf(overall.profitFactor)}</span><span className="d">payoff {inf(overall.payoff)}×</span></div>
                    <div className="stat"><span className="caps">Max drawdown</span><span className="v loss">−{overall.maxDD.toFixed(0)}</span><span className="d">{overall.maxDDpct !== undefined ? `${(overall.maxDDpct * 100).toFixed(0)}% of peak` : "USDC"}</span></div>
                    <div className="stat"><span className="caps">Worst loss streak</span><span className={`v ${overall.maxLossStreak >= 5 ? "loss" : ""}`}>{overall.maxLossStreak}<small>L</small></span><span className="d">best win {overall.maxWinStreak}</span></div>
                    <div className="stat"><span className="caps">Top-3 dependence</span><span className={`v ${overall.top3Share !== undefined && overall.top3Share > 0.5 ? "warn" : ""}`}>{overall.top3Share === undefined ? "—" : `${(overall.top3Share * 100).toFixed(0)}`}<small>%</small></span><span className="d">of gross profit</span></div>
                    <div className="stat"><span className="caps">Avg hold</span><span className="v">{holdFmt(overall.avgHold)}</span><span className="d">{overall.avgSlip !== undefined ? `slip ${overall.avgSlip >= 0 ? "+" : ""}${overall.avgSlip.toFixed(2)}%` : ""}</span></div>
                  </div>
                </div>
              </section>

              {/* equity curve */}
              <section className="panel">
                <div className="panel-head">
                  <h2>Equity curve — cumulative net{filtersActive ? " (filtered)" : ""}</h2>
                  <div className="actions"><span className={`num ${signCls(eqLast)}`}>{usd(eqLast)} USDC</span></div>
                </div>
                <div className="panel-body"><Sparkline data={eq} height={72} full /></div>
              </section>

              {/* edge scorecard cards */}
              <div className="section-title"><h2>Edge scorecard — per channel</h2><span className="sub">expectancy (avg R) · SQN (≥2.5 good) · profit factor (≥2 strong) · streaks · dependence</span></div>
              <div className="grid-3">
                {edgeRows.map((r, i) => (
                  <EdgeCard key={r.key} rank={i + 1} name={r.key} e={r.e} trades={filtered.filter((t) => t.channel === r.key)} />
                ))}
              </div>

              {/* channels — ranked, with an edge meter */}
              <section className="panel">
                <div className="panel-head"><h2>Channels<span className="sub">ranked by expectancy</span></h2></div>
                <div className="panel-body flush">
                  <div className="table-scroll">
                    <table className="table compact">
                      <thead>
                        <tr>
                          <th>#</th><th>Channel</th><th className="num">Trades</th><th className="num">Win %</th>
                          <th className="num">Net</th><th className="num">Avg</th><th className="num">Expectancy</th>
                          <th className="num">PF</th><th className="num">Max DD</th><th>Trend</th><th>Edge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {edgeRows.map((r, i) => {
                          const exp = r.e.expectancyR;
                          const eCls = exp === undefined ? (r.e.net >= 0 ? "ok" : "danger") : exp >= 0.3 ? "ok" : exp >= 0 ? "warn" : "danger";
                          const width = exp === undefined ? 0 : (Math.max(0, exp) / maxExp) * 100;
                          return (
                            <tr key={r.key}>
                              <td className="num muted">{i + 1}</td>
                              <td className="w600">{r.key}</td>
                              <td className="num muted">{r.e.n}</td>
                              <td className={`num ${wrCls(r.e.winRate)}`}>{(r.e.winRate * 100).toFixed(1)}%</td>
                              <td className={`num ${signCls(r.e.net)}`}>{usd(r.e.net)}</td>
                              <td className={`num ${signCls(r.e.avg)}`}>{usd(r.e.avg)}</td>
                              <td className={`num ${expCls(exp)}`}>{rMult(exp)}</td>
                              <td className={`num ${pfCls(r.e.profitFactor)}`}>{inf(r.e.profitFactor)}</td>
                              <td className="num loss">−{r.e.maxDD.toFixed(0)}</td>
                              <td style={{ width: 120 }}><Sparkline data={channelSparks[r.key] ?? []} width={110} height={24} /></td>
                              <td><div className={`meter ${eCls}`} style={{ width: 80 }}><i style={{ width: clampW(width) }} /></div></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>

              {/* extra breakdowns — nothing dropped */}
              <div className="section-title"><h2>Breakdowns</h2><span className="sub">where the edge lives — session · hold · coin · tier · side · time</span></div>
              <div className="grid-3">
                <section className="panel">
                  <div className="panel-head"><h2>R-multiple distribution<span className="sub">outcomes in units of initial risk</span></h2></div>
                  <div className="panel-body"><RHistogram trades={filtered} /></div>
                </section>
                <BreakdownPanel title="By trading session" sub="Asia 00–07 · EU 07–12 · US 12–21 · Late 21–24 (UTC)" rows={bySession} nameLabel="Session" />
                <BreakdownPanel title="By hold time" sub="scalps vs swings" rows={byHold} nameLabel="Hold" />
                <BreakdownPanel title="By coin" rows={bySymbol} nameLabel="Coin" showTier />
                <BreakdownPanel title="By market-cap tier" rows={byTier} nameLabel="Tier" />
                <BreakdownPanel title="By side" sub="long / short" rows={bySide} nameLabel="Side" />
                <BreakdownPanel title="By weekday" sub="entry day" rows={byWeekday} nameLabel="Weekday" />
                <BreakdownPanel title="By week of month" rows={byWeek} nameLabel="Week" />
              </div>

              {/* spotlight */}
              <div className="section-title"><h2>Spotlight — best factor combination per trader</h2><span className="sub">most profitable factor mix (side · tier/coin · weekday · week · session) · ≥3 trades, winning record</span></div>
              <div className="grid-3">
                {spotlight.map((s) => (
                  <div className="callout learn" key={s.channel}>
                    <span className="k">{s.channel} · {s.n} trades</span>
                    {s.combos.length === 0 ? (
                      <div className="muted small">No standout combination yet — thin data.</div>
                    ) : (
                      <div className="stack" style={{ gap: 6 }}>
                        {s.combos.map((c, i) => (
                          <div className="between" key={c.label} style={{ alignItems: "baseline", gap: 10 }}>
                            <span className={i === 0 ? "w600" : ""}>{i === 0 ? "🏆 " : "• "}{c.label}</span>
                            <span className="nowrap small">
                              <span className={wrCls(c.winRate)}>{pct(c.winRate)}</span>
                              <span className="muted"> · </span>
                              <span className={signCls(c.net)}>{usd(c.net)}</span>
                              <span className="muted"> · {c.n}×</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
