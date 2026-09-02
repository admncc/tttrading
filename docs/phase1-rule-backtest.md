<!-- Reproduce: dump second-opinions + fetch HL candles (pre-signal multi-TF for TA, and 15m from signal for outcome), then:
     tsx apps/server/src/scripts/backtestRules.ts <so.json> <ta_candles.json> <candles_by_op.json> docs/phase1-rule-backtest.md
     Numbers are computed by that script; do not edit by hand. -->

# Phase 1 — Second-Opinion rule backtest (old vs new)

Signals: **81** · TA recomputed point-in-time · outcomes via the repaired engine · scored (win/loss): 38, timeout: 2.

## Stance distribution — old (stored) vs new (3-zone rules)
| stance | old | new |
|---|---|---|
| positive | 7 (8.6%) | 10 (12.3%) |
| neutral | 0 (0.0%) | 16 (19.8%) |
| negative | 74 (91.4%) | 23 (28.4%) |
| none | 0 (0.0%) | 32 (39.5%) |

Positive share (degeneration guard: healthy 25–60%): old 8.6% → new 12.3%.

## New stance × outcome (scored only, n=38)
| zone | win | loss | win-rate |
|---|---|---|---|
| positive | 1 | 2 | 33.3% (n=3, CI 6.1%–79.2%) |
| neutral | 5 | 4 | 55.6% (n=9, CI 26.7%–81.1%) |
| negative | 7 | 10 | 41.2% (n=17, CI 21.6%–64.0%) |

Top-vs-bottom-zone win-rate: 33.3% vs 41.2% (positive discrimination = the new rules point the right way; tiny n, treat as directional only).

## Per-rule fire rate + win-rate lift (scored set, n=38)
| rule | fires | fire rate | WR flagged | WR unflagged |
|---|---|---|---|---|
| breakout | 0 | 2.0% | — | 44.7% (n=38, CI 30.1%–60.3%) |
| fadingExtreme | 2 | 4.1% | 0.0% (n=2, CI 0.0%–65.8%) | 47.2% (n=36, CI 32.0%–63.0%) |
| intoLevel | 17 | 44.9% | 52.9% (n=17, CI 31.0%–73.8%) | 38.1% (n=21, CI 20.8%–59.1%) |
| rangePos | 17 | 59.2% | 47.1% (n=17, CI 26.2%–69.0%) | 42.9% (n=21, CI 24.5%–63.5%) |
| riskReward | 20 | 65.3% | 35.0% (n=20, CI 18.1%–56.7%) | 55.6% (n=18, CI 33.7%–75.4%) |
| roomToLevel | 5 | 28.6% | 40.0% (n=5, CI 11.8%–76.9%) | 45.5% (n=33, CI 29.8%–62.0%) |
| staleEntry | 0 | 14.3% | — | 44.7% (n=38, CI 30.1%–60.3%) |
| stopTooTight | 1 | 2.0% | 0.0% (n=1, CI 0.0%–79.3%) | 45.9% (n=37, CI 31.0%–61.6%) |
| stopTooWide | 14 | 46.9% | 50.0% (n=14, CI 26.8%–73.2%) | 41.7% (n=24, CI 24.5%–61.2%) |
| stopWellPlaced | 13 | 46.9% | 38.5% (n=13, CI 17.7%–64.5%) | 48.0% (n=25, CI 30.0%–66.5%) |
| tradeWithTrend | 25 | 79.6% | 48.0% (n=25, CI 30.0%–66.5%) | 38.5% (n=13, CI 17.7%–64.5%) |

> Merge gate (dev-brief §8): no rule may fire on > 40% of signals without a win-rate lift. Rows above with a high fire rate and no separation are the ones to revisit as data grows.

## Score histogram (new rules)
- 0–10:  0
- 10–20: ███ 3
- 20–30: █████████████ 13
- 30–40: ███████ 7
- 40–50: ██████████ 10
- 50–60: ████ 4
- 60–70: █████████ 9
- 70–80: ███ 3
- 80–90:  0
- 90–100:  0

> n is tiny (38 scored). This harness exists so the rule set can never again drift to a rubber-stamp unnoticed; the win-rate/lift numbers become decisive only after ~100 cleanly-resolved signals (dev-brief §8).