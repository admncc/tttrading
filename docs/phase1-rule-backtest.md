<!-- Reproduce: scratchpad/fetch_all.py writes bundle.json (HL universe-resolved, retried), then:
     tsx apps/server/src/scripts/backtestRules.ts <so.json> <bundle.json> docs/phase1-rule-backtest.md [roundTripFeePct]
     Numbers are computed by that script; do not edit by hand. -->

# Phase 1 — Second-Opinion rule backtest (v2.2, §11.2 corrected)

Signals: **81** · window 2026-08-11 → 2026-09-02 (22 days, one BTC regime — §11.4). Round-trip fee assumed 0.1% (placeholder, open Q4).

## Coverage (replay) — P1-R1/R2
- Live SO coverage on this set: **81/81 (100%)** — every signal received a verdict in production. The numbers below are *replay* coverage (can we rebuild point-in-time TA from HL candles), a different quantity.
- Replay coverage: **70/81 (86.4%)** ⚠ below the 90% alarm.
- Stance-none breakdown (n=11): noData:not-on-HL 11.
  - `noData:not-on-HL`: MANA, EGLD, GOLD, JASMY, GOLD, RAY, XAU, BTW, VELVET, H, APR — gold/index/alt not listed on Hyperliquid (10 distinct). These are a data gap, not an SO failure.

## Stance distribution — old (stored) vs new (denominator = 81 signals)
| stance | old | new |
|---|---|---|
| positive | 7 (8.6%) | 11 (13.6%) |
| neutral | 0 (0.0%) | 23 (28.4%) |
| negative | 74 (91.4%) | 36 (44.4%) |
| none | 0 (0.0%) | 11 (13.6%) |

Positive share **among signals with a stance** (degeneration guard 25–60%): 15.7% (11/70). On all 81: 13.6%.

## New zone × outcome (denominator = 40 scored win/loss)
| zone | win | loss | win-rate | expectancy (gross) | expectancy (net) |
|---|---|---|---|---|---|
| positive | 1 | 5 | 16.7% (n=6, CI 3.0%–56.4%) | -0.33R ±0.67 (n=6) | -0.35R (n=6) |
| neutral | 6 | 6 | 50.0% (n=12, CI 25.4%–74.6%) | +0.94R ±0.84 (n=13) | +0.91R (n=12) |
| negative | 11 | 11 | 50.0% (n=22, CI 30.7%–69.3%) | +0.01R ±0.23 (n=23) | -0.06R (n=21) |

Top-vs-bottom discrimination: n too small for a directional read (top n=6, bottom n=22; need ≥15 each).

## Per-rule fire rate + win-rate lift + expectancy (denominator = 40 scored)
| rule | fires | fire rate | WR flagged | WR unflagged | exp flagged |
|---|---|---|---|---|---|
| breakout | 0 | 0.0% | — (n=0) | 45.0% (n=40, CI 30.7%–60.2%) | — |
| fadingExtreme | 2 | 5.0% | 0.0% (n=2, CI 0.0%–65.8%) | 47.4% (n=38, CI 32.5%–62.7%) | -1.00R ±0.00 |
| intoLevel | 25 | 62.5% | 48.0% (n=25, CI 30.0%–66.5%) | 40.0% (n=15, CI 19.8%–64.3%) | +0.08R ±0.28 |
| rangePos | 24 | 60.0% | 45.8% (n=24, CI 27.9%–64.9%) | 43.8% (n=16, CI 23.1%–66.8%) | +0.07R ±0.29 |
| riskReward | 26 | 65.0% | 34.6% (n=26, CI 19.4%–53.8%) | 64.3% (n=14, CI 38.8%–83.7%) | -0.36R ±0.20 |
| roomToLevel | 6 | 15.0% | 50.0% (n=6, CI 18.8%–81.2%) | 44.1% (n=34, CI 28.9%–60.5%) | +0.31R ±0.68 |
| staleEntry | 1 | 2.5% | 100.0% (n=1, CI 20.7%–100.0%) | 43.6% (n=39, CI 29.3%–59.0%) | +1.56R |
| stopTooTight | 1 | 2.5% | 0.0% (n=1, CI 0.0%–79.3%) | 46.2% (n=39, CI 31.6%–61.4%) | -1.00R |
| stopTooWide | 16 | 40.0% | 56.3% (n=16, CI 33.2%–76.9%) | 37.5% (n=24, CI 21.2%–57.3%) | +0.33R ±0.39 |
| stopWellPlaced | 21 | 52.5% | 33.3% (n=21, CI 17.2%–54.6%) | 57.9% (n=19, CI 36.3%–76.9%) | -0.26R ±0.26 |
| tradeWithTrend | 34 | 85.0% | 47.1% (n=34, CI 31.5%–63.3%) | 33.3% (n=6, CI 9.7%–70.0%) | +0.12R ±0.24 |

> Merge gate (§8): no rule may fire on > 40% of scored signals without a win-rate lift. High fire-rate rows with negative/zero lift (e.g. riskReward, tradeWithTrend) are the ones to revisit as data grows — on n=40 the intervals overlap, so this is a watch-list, not a verdict.

## slAtrH buckets (P1-R6, dev-brief 1.2) — denominator = scored with a stop
| slAtrH bucket | n (scored) | win-rate | expectancy (gross) |
|---|---|---|---|
| 0–0.5 | 0 | — (n=0) | — |
| 0.5–1 | 3 | 33.3% (n=3, CI 6.1%–79.2%) | -0.47R ±0.53 |
| 1–2 | 5 | 20.0% (n=5, CI 3.6%–62.4%) | -0.49R ±0.51 |
| 2–3.5 | 14 | 35.7% (n=14, CI 16.3%–61.2%) | +0.46R ±0.72 |
| >3.5 | 16 | 56.3% (n=16, CI 33.2%–76.9%) | +0.33R ±0.39 |

Horizon-TF used: 4h:66 · ?:4 — currently fixed at 4h for all (trader median-hold not yet wired; open Q1). Thresholds stay hypotheses until the buckets fill.

## Brier — geometry baseline vs old SO vs new SO (denominator = 38 scored with levels)
- Geometry baseline (pBase = slDist/(slDist+tpDist)): **0.271**
- Old SO (score/100, uncalibrated): 0.275
- New SO (score/100, uncalibrated): 0.288

> Caveat: SO score/100 was never fit as a probability, so its Brier trails the baseline by construction — that argues for the Phase-3 isotonic calibration, not against the rules. Mean baseline P(win) on the scored set: 46.8% vs realised 45.0% (n=40, CI 30.7%–60.2%) — the CI includes the baseline, so no trader edge is proven yet.

## Outcome classes (denominator = 81)
unresolved: 22 · win: 18 · noData: 11 · loss: 22 · notFilled: 6 · timeout: 2

Unresolved age (n=22): <3d 11 · 3–7d 5 · 7–14d 6 · >14d 0. (>14d unresolved would be a bug — the horizon is 14d.)

## Phantom wins + reproducibility (P1-R8)
- Phantom WINS (old engine called TP-first, repaired engine says never filled): PUMP, BTC, GRASS, ZRO — matches the Phase-0 relabel.
- All never-filled/ambiguous this run (incl. old non-wins): PUMP, BTC, GRASS, ZRO, BNB, INJ.
- The earlier manual audit named ZRO/PUMP/SPX; the reproducible relabel (Phase 0) named PUMP/BTC/GRASS/ZRO. The difference is method: the audit eyeballed a subset, the relabel ran computeOutcome over fetched candles for all 81. SPX is `noData` (not on HL), so it can't be a win or a phantom — it simply has no outcome. Trust the reproducible run.
- initialRisk provenance is now tagged per trade (`recorded` vs `backfilled_estimate`); Risk-Insights can restrict to `recorded` once enough real entries accumulate.

> n is tiny (40 scored, 22 days, one regime). Every number here is a "how far from the gate" reading, not a decision. Gate (§11.4): ≥100 cleanly-resolved signals, ≥8 weeks, ≥2 BTC regimes.