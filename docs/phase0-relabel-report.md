<!-- Reproduce: dump second-opinions from the Diagnostic API + fetch HL candles per signal (scratchpad/fetch_all.py writes bundle.json), then:
     tsx apps/server/src/scripts/relabelReport.ts <so.json> <post_clean.json> docs/phase0-relabel-report.md    (post_clean = {opId: bundle.post})
     Numbers are computed by that script; do not edit by hand. -->

# Phase 0 — Relabel: before/after report

Signals: **81** · window 2026-08-11 → 2026-09-02 · replayed on fresh Hyperliquid 15m candles through the repaired engine (SO-1/2/3/3b).

## Old engine (as stored)
- Marked resolved: **48/81** (41 were left hanging by the too-short window / missing timeout class).
- firstHit = TP: 24 · firstHit = SL: 24
- Old win-rate (TP / (TP+SL)): 50.0% (n=48, 95% CI 36.4%–63.6%)
- Old "favorable" grade (TP-first **or** maxR≥1, run over the whole window): 37/81 → this is the metric SO-1 corrupts.

## New engine (repaired)
| class | n | note |
|---|---|---|
| win | 18 | TP reached before SL |
| loss | 22 | SL reached before TP |
| timeout | 2 | no TP/SL in 14 d — carries R at close (SO-2) |
| notFilled | 6 | limit never traded through entry — no outcome (SO-3) |
| ambiguous | 0 | fill/SL or TP/SL in one bar (SO-3b) |
| unresolved | 33 | still open, < 14 d old |

- **New win-rate (win / (win+loss)):** 45.0% (n=40, 95% CI 30.7%–60.2%)
- Resolved into a scored outcome: 40/81; incl. timeout: 42/81.

## What correct measurement changed
- **Phantom wins removed:** 4 signal(s) the old engine graded as TP-first are now `notFilled`/`ambiguous` (no real fill). → PUMP, BTC, GRASS, ZRO
- **Post-stop-rally losers reclassified (SO-1):** 2 signal(s) that scored "favorable" under the old whole-window MFE are losses once the excursion is cut at the SL bar.

## Old SO stance × new outcome (scored only, n=40)
| stance | win | loss | win-rate |
|---|---|---|---|
| positive | 1 | 1 | 50.0% (n=2, 95% CI 9.5%–90.5%) |
| negative | 17 | 21 | 44.7% (n=38, 95% CI 30.1%–60.3%) |
| neutral | 0 | 0 | — |

## recklessWide (SO-6, old rule slAtrMultiple>5) — fire rate & lift
- Fires on **25/40** scored signals (62.5%).
- Win-rate when flagged: 44.0% (n=25, 95% CI 26.7%–62.9%)
- Win-rate when NOT flagged: 46.7% (n=15, 95% CI 24.8%–69.9%)
- A flag that fires on the majority with no win-rate separation is noise — this is exactly the horizon-ATR mismatch Phase 1 (SO-6) fixes.

## Expectancy in R (TP1-or-SL proxy, stated not tuned)
- positive: +0.00R (n=2)
- negative: +0.30R (n=40)
- neutral: — (n=0)
- all: +0.28R (n=42)

> Caveat: n is tiny; every rate above carries a wide Wilson interval. These numbers exist to show what the measurement fix alone moves — not to judge the SO's edge yet. That is Phase 1, on out-of-sample data.