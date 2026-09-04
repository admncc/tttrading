<!-- Consolidated work report for the Trading-Prediction v2.1/v2.2 dev instructions.
     For re-verification: every code change is a separate commit on
     claude/hyperliquid-trading-bot-desk-5zpuia; every number below is reproduced by
     a committed script under apps/server/src/scripts or docs/*.md. -->

# Work report — Trading-Prediction v2.1 → v2.2

Branch: `claude/hyperliquid-trading-bot-desk-5zpuia`. All work is committed and
pushed; the Docker build now runs a boot smoke-test, so a build that compiles but
can't start is rejected before deploy.

## 1. Phase 0 — repair the measurement (commit `fe71c2d`) — **accepted**
Fixed the outcome/risk measurement bugs, red-first fixtures per ticket.
- **SO-1** favorable excursion cut at the SL bar (adverse at TP bar).
- **SO-2** `timeout` its own class (R at close); verify window 14→21 d.
- **SO-3 / 3b** limit fill detection → `notFilled`; one-bar fill+SL → `ambiguous`.
- **SO-4** flat-window RSI → undefined (was 99).
- **RI-1** equity summed across venues + per-venue heat; **RI-2** working orders
  out of live heat + `heatIfAllFilled`; **RI-3** R from `initialRisk` frozen at
  entry; **RI-4** `scratch` class; **RI-5** honest capped-window label.
- SQN / R-sign / slippage / profit-factor / Wilson frozen as regression tests.
- Report: `docs/phase0-relabel-report.md` — win-rate 50.0%→**44.7%** (n=38→40),
  **4 phantom wins** removed (PUMP, BTC, GRASS, ZRO).

## 2. Phase 1 — recalibrate the SO rules (commit `1744570`) — **accepted as Shadow**
- **SO-6** stop sanity on the horizon-ATR (`slAtrH`), old 1h rule removed; **SO-7**
  trend credit only with ≥2 timeframes; **SO-8** one R/R feature; **SO-9** no blanket
  overbought penalty; **SO-10** single `tradeWithTrend`; 3 zones (neg/neutral/pos);
  per-rule cap ±25; degeneration alarm.
- Backtest harness `scripts/backtestRules.ts` → `docs/phase1-rule-backtest.md`.
- Merge criteria NOT met (positive share 15.7% < 25%, Brier not ≤ baseline) → stays
  **Shadow**, as decided. Re-check at ≥100 scored / ≥2 regimes.

## 3. Phase-1 report fixes — v2.2 §11.2, P1-R1…R9 (commit `31852d3`)
Single stated denominators; live SO coverage (100%) vs replay coverage (86.4%,
the 11 gaps are non-HL assets); sign-correct, n-gated discrimination; expectancy
per zone/rule; **Brier vs geometry baseline** (0.271 vs new 0.288, uncalibrated by
construction); slAtrH bucket table; net expectancy (placeholder fee); `noData`
class + unresolved age; `initial_risk_source` (recorded|backfilled_estimate);
phantom-win definition aligned (4). Saved dev doc `docs/dev-anweisung-trading-prediction-v2.md`.

## 4. Phase 2 — point-in-time feature logging (§11.3) — **the instructed order, complete**
Observe-only; every feature computed at signal time and persisted (`signal_features`).
Reports: `docs/phase2-feature-buckets.md` + live `scripts/featureBuckets.ts`.
- **2.1** BTC regime (trend, 1y ATR-percentile vol regime, 24h/7d return), beta &
  correlation to BTC, ETH/BTC breadth. (commits `c8fcbb0`, `0612ae7`)
- **2.6** Bayes-shrunk trader win-rate, expectancy R, median hold, signals/week,
  concurrent-same-direction. (`c8fcbb0`)
- **2.2** funding 7d-avg + percentile + crowding; **OKX** crowd long/short account
  ratio + OI (Binance/Bybit geo-blocked). (`ecaf83f`, `b55eda8`)
- **2.4** rule-based event calendar (NFP, options expiry) + `MACRO_CALENDAR_FILE`
  extension point for FOMC/CPI/PCE; `eventInTpWindow`. (`d513d07`)
- **2.5** sector, cap tier, coin base rate (shrunk). (`0612ae7`)
- **TA 3.1–3.3 / 3.6** mtfAlignment, tradeWithTrendD1, distToEma20Atr,
  consecutiveGreen, extensionZ20, rr, slAtrH, tpAtrH, feeDragR. (`c8fcbb0`)
- **§11.5 weekly cron** `reports/weekly.ts` — gate progress, coverage, positive
  share, Brier, headline buckets; writes a dated file + logs a header. (`c8fcbb0`)

## 5. Operational fixes found along the way
- **Prod outage (metrics move, `85dc0d8`)** — Phase 0 imported shared runtime
  values into the server; `node dist` couldn't resolve `@tttrading/shared` (types-
  only exports). Moved metrics to `apps/server/src/lib`. Added a **boot smoke-test**
  in the Dockerfile (`f1291bb`) so this can't ship again.
- **Feature logging was inert (`b885e3c`)** — the SO ran before the signal record
  existed, so `signalId` was undefined and logging was skipped. Now uses a stable
  correlation id. (Needs the redeploy to start recording.)
- **Diagnostic under-reported open trades** — built its open list from `list(80)`,
  dropping old still-open positions (this is why the 美元 SOL long looked "gone").
  Now sourced from the uncapped `tradesRepo.open()`.
- **uPnL** now excludes banked (open unrealized only); **Analytics Cumulative PnL**
  curve reconciled to the Realized-PnL KPI (adds banked-on-open at the endpoint).
- **Management scoping** — symmetric partial/breakeven now applied across multiple
  named held symbols (the SEI+SUI / VIRTUAL+SAND misses); cross-trader BTC
  contamination was a false alarm (management is already group-scoped).

## 6. Daily audits performed
Full message→action audits for 2026-09-03 (and multi-day earlier): entries and
management verified correct, every malformed/opposing case caught by a guard, no
erroneous trades. Trader 美元 SOL: opened Aug 9, 50% booked (+769 banked), never
fully closed, **still live** (Sync confirms); the **Aug-30 SL→breakeven was
missed** (symbol-ambiguity — now fixed for the multi-symbol case).

## 7. Not done / open (need a feed or your input)
- **Phase 1 merge** gated on data (≥100 scored, ≥2 BTC regimes; window so far is
  one regime).
- **Data streams not built:** 2.3 orderflow/CVD/volume-profile, liquidation
  clusters, full 2.5 (marketcap tier / coin age / listings), 2.7 on-chain — all
  need paid/heavy feeds. Macro calendar FOMC/CPI dates: seed `MACRO_CALENDAR_FILE`.
- **Open questions Q1–Q6** block: wiring trader median-hold into the live verdict's
  `slAtrH` (Q1), and net-fee numbers per venue (Q4).

## 8. Message audit (3 independent agents) + JASMY root cause
Every stored message was re-audited by three independent agents against its
derived signal/action. Consolidated ranked list of real defects; the highest was
the **JASMY missed SL→breakeven** ("book Tp1 Zama … set SL breakeven on Jasmy"):
the LLM *did* read it correctly (no `$/#` needed), but the flat schema + a
reconsider-collapse + the recap guard downstream dropped the JASMY breakeven.
Root-caused and fixed (§9).

## 9. QA-and-fix loop — 3 rounds, all areas (message→action first)
All committed on the branch; 110 tests green, typecheck/build/boot-smoke green.

**Round 1 — parsing (message → signal):**
- Entry mis-scaled vs its own **stop** snapped to scale (GOLD 446 / SL 4688 leg
  was silently dropped by the would-chase guard) — `snapEntryToStop`. (`5d7c0a6`,
  corrected to stop-only in `2d59ebb`)
- Price-location fillers (`AT`/`ON`/`ZONE`/…) no longer read as tickers; a real
  `#TICKER` still resolves. (`f4f0333`; `NEAR`/`TRADE`/`BREAK` un-listed as real
  coins in `25f4567`; `#` removed from the primary branch in `2d59ebb`)

**Round 2 — management (actions/signals):**
- **P0** reconsider-collapse restore + recap-close veto (JASMY/GOLD). (`3ffe6c2`)
- Breakeven never arms an **unfilled working leg** (instant-stopout trap). (`90f6187`,
  residual `sl_move`==working-entry case closed in `126ab67`)
- **Per-coin actions** (`per_symbol` LLM schema) for asymmetric multi-coin messages
  ("Closed BTC, book 50% ETH") — the flat schema lost the second coin's action.
  (`3fc7acb`; 100%-partial→close + restore-safety fixed in `2d59ebb`)
- Single-close trusted below 0.85 **only with positional evidence** (verb-nearest
  tag agrees) — never on confidence alone. (`3a27bf8`)

**Round 3 — cross-review (3 independent agents) + fixes:**
- Caught **3 regressions my own Round-1/2 fixes introduced** (NEAR swallowed,
  `snapEntryToBand` mean-skew, `#`-hashtag noise) — all fixed before deploy.
  (`25f4567`, `2d59ebb`)
- **Serious pre-existing money bug:** a **rejected stop-loss at entry** was masked
  as "protected" when a TP rested → position ran naked, no operator alert. Fixed
  across all three venues (`stopMissing` flag, one stop-only retry, loud
  `alertError`); size/$10/minQty/minVol guards hardened against NaN. (`91ba891`)
- MEXC market orders now cross the book (protective closes must fill); SPX-class
  `size→0` now an actionable error, not opaque. (`3a27bf8`, `126ab67`)

## 10. Action items for you
1. **Redeploy** (`git pull && docker compose up -d --build`) to activate feature
   logging + every §5/§9 fix (including the naked-position guard).
2. **Policy decisions:** `directionalVenueSplit` (#6/#7/T7) and `defaultStopPct`
   (#3/T6) — explained; awaiting your call (not bugs).
3. **Raise the 美元 SOL stop to entry** (76.473) via Manage — a +$1.5k runner
   with no breakeven stop.
4. **Disable the Diagnostic API** (unencrypted, token-in-URL).
5. Answer Q1–Q6 when you can, so I can close the horizon + net-fee loops.
