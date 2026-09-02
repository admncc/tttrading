# Dev-Anweisung: Trading-Prediction v2.2

**Mess-Bugs · Second Opinion re-kalibrieren · Datenströme · TA-Features · Modelle · Strategien · Risk Insights**
Stand: 02.09.2026 (v2.2: Review Phase 0/1 + Nachtrag, Abschnitt 11) · Auftraggeber: KH (Vision-Owner) · Adressat: Dev / Claude Code

## TL;DR

0. **Zuerst die Messung reparieren (Phase 0).** Die Code-Audits haben Bugs in der Outcome-Engine und in Risk Insights gefunden. Solange die stehen, sind Winrate, Konfusionsmatrix, Heat und R-Multiples teilweise falsch. Alle bisherigen empirischen Befunde (auch „die SO verpasst jeden Gewinner") gelten erst nach Phase 0 neu gerechnet.
1. Die Second Opinion (SO) ist aktuell ein Pauschal-„negativ"-Stempel (74/81 negativ). Ursache sind Regeln mit Horizont-/Kontextfehler und Doppelstrafen, nicht das Konzept. Phase 1 repariert das und baut einen Backtest-Harness, damit so etwas nie wieder unbemerkt passiert.
2. Ziel-Output der SO wird eine **kalibrierte Wahrscheinlichkeit** P(win) mit Unsicherheit. Verdicts (negativ / neutral / positiv) werden daraus abgeleitet.
3. Predictions werden für **Sizing** genutzt, nicht zum Blocken. Blocken erst mit Out-of-Sample-Nachweis.
4. Datenbasis ausbauen (Point-in-Time-Feature-Logging), damit in 3–6 Monaten echte Modelle trainierbar sind. Bis dahin: einfache, robuste Modelle (Geometrie-Baseline, Bayes-Trader-Modell, logistisches SO).
5. Jede Zahl in Reports und UI kommt mit n und Konfidenzintervall. 48 aufgelöste Trades sind eine winzige Stichprobe (Winrate-95%-Intervall grob 34–62 %).

Phasen in Reihenfolge abarbeiten. Nach jeder Phase ein Markdown-Report mit Zahlen. Keine Phase überspringen.

---

## 0. Leitplanken (gelten für alles Folgende)

1. **Shadow-Mode zuerst.** Alles Neue schreibt seine Prediction in die DB, wirkt aber nicht. Live-Blocken nur mit Out-of-Sample-Nachweis.
2. **Zeitliche Trennung statt Zufalls-Split.** Train = ältere Signale, Test = neuere (Walk-Forward). Überlappende Trades → Purging/Embargo: kein Test-Signal darf zeitlich mit Train-Signalen überlappen.
3. **Kein Threshold-Tuning gegen bekannte Outcomes.** Das war der Fehler der „alle-Verlierer-negativ"-Runde. Thresholds werden aus Bucket-Statistiken abgeleitet und auf Holdout geprüft.
4. **Metriken:** Brier-Score, Log-Loss, AUC, Reliability-Diagramm, Expectancy in R pro Score-Bucket, Lift Top- vs. Bottom-Tercil. Accuracy ist als Hauptmetrik verboten (Basisrate ~48 % macht sie wertlos).
5. **Stichprobe:** Jede Aussage mit n und Wilson-Konfidenzintervall. Buckets < 15 Trades werden in Reports nicht als „Befund" ausgewiesen.
6. **Point-in-Time:** Jedes Feature wird zum Signal-Zeitpunkt berechnet und persistiert (`computedAt ≤ signalAt`). Nachträgliche Berechnung mit späteren Daten = Look-Ahead = verboten.
7. **Kein Feature ohne Hypothese:** Ein Satz „warum sollte das Outcome vorhersagen" + Bucket-Statistik, bevor es in ein Modell darf.
8. **Erklärbarkeit:** Jeder Score liefert eine Beitrags-Aufschlüsselung (welche Regel / welches Feature wie viel bewegt).
9. **Zielgröße:** Jetzt P(win). Später zusätzlich erwarteter R (Regression), denn Winrate ohne R:R sagt nichts (ein +5R-Trade zählt sonst wie ein +1R-Trade).

---

## P0. Phase 0 — Mess-Bugs aus den Code-Audits (vor allem anderen)

Jedes Ticket bekommt einen Unit-Test mit Fixture, **bevor** der Fix gebaut wird (Test muss vorher rot sein). Nach Phase 0: Winrate, Konfusionsmatrix, Score-Verteilung, Heat und Expectancy komplett neu rechnen und als „vorher/nachher"-Report mit n ausgeben. Erst dann Phase 1.

### P0.1 Second Opinion — Outcome-Engine

| # | Prio | Bug | Fix | Akzeptanz-Test |
|---|---|---|---|---|
| SO-1 | HIGH | `mfe`/`maxR` laufen über das ganze Fenster weiter, auch nach SL-Hit → ausgestoppte Verlierer, die später zurücklaufen, zählen als „favorable" | Bei `firstHit === "sl"` Favorable-Excursion an der SL-Kerze abschneiden. Symmetrisch: bei `firstHit === "tp"` die Adverse-Excursion an der TP-Kerze abschneiden (sonst ist MAE für Gewinner genauso falsch) | Fixture: SL in Kerze 5, danach Rally auf +2R in Kerze 9 → Outcome `loss`, `mfeR` = Maximum vor Kerze 5 |
| SO-2 | MED-HIGH | Timeout-Auflösung unerreichbar: Fetch-Fenster kürzer als Timeout-Horizont → Chop-Trades werden nie `resolved` und fehlen im Sample | Fetch-Fenster ≥ Timeout-Horizont + Puffer (z. B. 21 d ≥ 14 d). Timeout-Horizont pro Trader aus Median-Haltedauer (Default 14 d). `timeout` ist eine eigene Klasse mit R zum Timeout-Close, kein Win und kein Loss | Fixture: 15 Tage weder TP noch SL → `timeout` mit R zum Close von Tag 14 |
| SO-3 | MED | Outcome ab Entry-Preis gemessen, auch wenn ein Limit nie gefüllt wurde → Phantom-Wins (ZRO, PUMP, SPX) | Messung beginnt erst, wenn eine Kerze durch den Entry handelt (Limit) bzw. zum Signalzeitpunkt inkl. Slippage (CMP/Market). Nie gefüllt innerhalb Gültigkeitsfenster → `notFilled`, raus aus der Kalibrierung. **Wichtig:** `notFilled` ist weder Bestätigung noch Widerlegung des Verdicts — das Modell „lag richtig" ist dort keine zulässige Aussage, es gibt schlicht kein Outcome | Fixture: Limit 5 % unter CMP, nie erreicht → `notFilled`; ZRO/PUMP/SPX müssen nach Relabel aus der Win-Spalte verschwinden |
| SO-3b | MED | Folgeproblem von SO-3: Fill-Kerze berührt auch den SL | Mit 1m-Daten auflösen, sonst `ambiguous` (raus aus der Winrate) | Fixture: Fill und SL in derselben 1h-Kerze ohne 1m-Daten → `ambiguous` |
| SO-4 | LOW | RSI = 99 bei flachem Markt (avgLoss = 0) | Division-Guard: bei zu wenig Bewegung `rsi = null`, und keine Regel darf auf `null` feuern | Fixture: 14 identische Closes → `rsi = null`, kein Flag |
| SO-5 | LOW | LLM-Stance/-Score nicht gegenvalidiert | `llmStance`, `llmScore` als Features loggen und wie jedes Feature per Bucket-Statistik auf Lift prüfen. Regelwerk und LLM-Prompt auf Widersprüche abgleichen (Beispiel: Regel bestraft RSI ≥ 82, Prompt nennt das gesunden Uptrend). Widersprüchliche Komponenten addieren sich zu Rauschen | Report: Winrate/Expectancy je `llmStance` mit n |

### P0.2 Second Opinion — Regel-Logik (Ursachen des Negativ-Bias)

| # | Bug | Fix |
|---|---|---|
| SO-6 | `recklessWide` misst Swing-Stops gegen ATR(1h), feuert auf 57 % | Siehe 1.2 (Horizont-ATR, zwei Flags, Bucket-Statistik). Alte Regel entfernen |
| SO-7 | Confluence-/With-Trend-Bonus wird mit nur **einem** Timeframe vergeben | Bonus nur, wenn ≥ 2 Timeframes tatsächlich berechnet wurden; sonst 0 und Flag `mtfUnavailable`. Sauber gelöst durch `mtfAlignment` (3.1) |
| SO-8 | Schwaches R/R wird doppelt bestraft | Ein Konzept = ein Feature. Im logistischen Modell (1.4) gibt es keine Doppelstrafen mehr; bis dahin Duplikat entfernen |
| SO-9 | `rsi ≥ 82 → −8` bestraft gesunden Uptrend | Regel entfernen. Ersatz: Extension in ATR mit Trend-Kontext (3.3), Threshold aus Bucket-Statistik |
| SO-10 | Counter-Trend-Strafen stapeln sich | Ein Feature `tradeWithTrend` (−1/0/+1 je TF, summiert), Deckel wie alle Regeln (max. 25 Punkte) |

### P0.3 Risk Insights

| # | Prio | Bug | Fix | Akzeptanz-Test |
|---|---|---|---|---|
| RI-1 | HIGH | Portfolio-Risiko-% teilen Multi-Venue-Exposure (HL/Aster/MEXC) durch Nur-Hyperliquid-Equity → Heat, Gross-Leverage, Net-Exposure überzeichnet; „> 6 % Heat"-Warnung kann falsch feuern | Equity über alle Venues summieren (in USD normalisiert). **Zusätzlich** Per-Venue-Heat ausweisen (Venue-Exposure / Venue-Equity): Margin ist zwischen Venues nicht geteilt, Liquidationsrisiko entsteht pro Venue — die Portfolio-Zahl allein verdeckt das | Fixture: 1 Position auf MEXC, Equity auf HL und MEXC → Portfolio-Heat nutzt Summe; Per-Venue-View zeigt MEXC-Heat gegen MEXC-Equity |
| RI-2 | MED | Ungefüllte Limit-Orders (`working()`) zählen als Live-Exposure | `working()` aus dem Live-Set entfernen. **Zusätzlich** zweite Kennzahl `heatIfAllFilled` (Worst Case: alle offenen Orders füllen in einem Flush) — die Info ist wertvoll, gehört nur nicht in „exposed right now" | Fixture: 2 Positionen + 3 Working-Orders → `heatLive` aus 2, `heatIfAllFilled` aus 5 |
| RI-3 | MED | R-Multiple nutzt Post-Partial-Size statt Initial-Size → R, Expectancy, SQN bei Teilschließungen überhöht | `initialSize` und `initialRisk` (= initialSize × Stop-Distanz) beim Entry persistieren. R = realisierter Netto-PnL / `initialRisk`, unabhängig von Partials | Fixture: 50 % bei +1R geschlossen, Rest bei +2R → R = 1,5 (nicht 2,0) |
| RI-4 | LOW | Break-even (net = 0) zählt als Win | Klasse `scratch`: \|net\| ≤ Schwelle (Vorschlag ±0,1R, Hypothese). Raus aus der Winrate, drin in der Expectancy | Fixture: net = +0,02R → `scratch` |
| RI-5 | LOW | `closed(3000)`-Cap + Sortier-Mismatch labelt „all-time" falsch | Paginieren oder Label „letzte 3000 Trades"; Sortierung fixen | Fixture: 3001 Trades → ältester Trade in „all-time" enthalten oder Label korrekt |

Als korrekt verifiziert (SQN-Formel nach Van Tharp mit Sample-Stdev und √N-Cap, R-Vorzeichen long/short, Slippage-Vorzeichen, kein Equity-Shadowing, Empty-Data-Sicherheit): **als Regressionstests einfrieren**, damit das so bleibt. Hinweis: SQN ist unter ~30 Trades kaum aussagekräftig → im UI nur mit n anzeigen.

### P0.4 Abschluss Phase 0

- Relabel aller historischen Signale mit der reparierten Engine, Klassen: `win`, `loss`, `timeout`, `scratch`, `notFilled`, `ambiguous`.
- Report „vorher/nachher": Winrate (nur win/loss), Expectancy (win/loss/timeout/scratch), Konfusionsmatrix der alten SO, Flag-Feuerraten — jeweils mit n und CI.
- Erst wenn dieser Report vorliegt, beginnt Phase 1. Die Ergebnisse können das Bild deutlich verändern: Die „verpassten Gewinner" waren teilweise Phantom-Wins, die Trennschärfe der alten SO ist also noch unbekannt. Unabhängig davon bleibt SO-6 ein Logikfehler, der repariert wird.

---

## 1. Phase 1 — Sofort-Fixes Second Opinion

### 1.1 Label-Qualität (Rest, nach Phase 0)

- Phase 0 liefert die Klassen `win / loss / timeout / scratch / notFilled / ambiguous`. Hier nur, was darüber hinausgeht:
- **Parsing-Check:** 20 Signale stichprobenartig manuell gegen die gespeicherten Entry/TP/SL abgleichen. Parsing-Fehler sind Label-Noise.
- **Pro Trade zusätzlich speichern:** MFE/MAE in R (korrekt abgeschnitten, SO-1), `timeToTp`, `timeToSl`, `entryDrift` (Signalpreis vs. Fill), Fees, Funding. Grundlage für Management-Backtests (5.3).
- **Mehrere TPs:** Labels parallel führen: `tp1First`, `rAtExitStdMgmt` (festes Standard-Management), `mfeR`.

### 1.2 `recklessWide` reparieren (Horizont-Mismatch)

- Ursache: Stop-Distanz / ATR(1h). Ein 5–7 %-Swing-Stop auf einem Coin mit 1 % Stunden-ATR ergibt automatisch 5–7×. ATR skaliert grob mit √Zeit: ATR(D1) ≈ 4–5× ATR(1h). Der „rücksichtslose" Stop ist also ≈ 1× Tages-ATR — völlig normal.
- Fix: `atrHorizon` = ATR des Trader-Zeithorizonts. Horizont aus Feld `trader.timeframe`, falls vorhanden; sonst aus Median-Haltedauer der aufgelösten Trades (≤ 8h → ATR(1h), ≤ 3d → ATR(4h), sonst ATR(D1)).
- Neue Features: `slAtrH = slDist / atrHorizon`, `tpAtrH = tpDist / atrHorizon`, `slPctOfDailyVol = slPct / realizedVolDaily`.
- Zwei Flags statt einer: `stopTooTight` (Noise-Stop; Start-Hypothese slAtrH < 0,7) und `stopTooWide` (Start-Hypothese > 3,5). Thresholds **nicht festnageln**: Winrate und Expectancy pro slAtrH-Bucket (0–0,5 / 0,5–1 / 1–2 / 2–3,5 / > 3,5) über die Historie ausgeben, dann setzen.
- Alte 1h-Regel entfernen, nicht nur abschwächen.

### 1.3 `poorLocation` reparieren

- Binär „nahe Resistance" → kontinuierlich: `distToResistanceAtr` (Abstand zur nächsten Resistance auf Horizont-TF, in ATR) und `sideOfLevel`. Preis **unter** Level = „into resistance". Preis **über** Level nach Close darüber = Breakout/Retest — das Gegenteil, darf nicht bestraft werden.
- „Chasing" direkt messen: `moveBeforeEntryAtr` (wie weit ist der Preis in den letzten k Kerzen schon gelaufen), `consecutiveGreenCandles`, `distToEma20Atr`.

### 1.4 Score-Architektur

- Additiven Strafen-Stapel ersetzen durch **logistisches Modell**: P(win) = σ(w0 + Σ wi·fi). Gewichte auf Historie fitten, stark L2-regularisiert (wegen n), Vorzeichen-Constraints wo die Hypothese klar ist (z. B. `stopTooTight` muss negativ wirken).
- Übergang bis genug Daten: Startgewichte = heutige Regelgewichte, aber gedeckelt: keine Regel bewegt mehr als 25 Punkte, und jede Regel muss einen Lift zeigen (Winrate flagged vs. unflagged). Regeln mit Feuerrate > 40 % brauchen den Lift-Nachweis vor Merge.
- **Drei Zonen** statt binär: `negative` (< 40), `neutral` (40–60), `positive` (> 60). Das Modell darf „kein Edge erkennbar" sagen.
- **Kalibrierung:** Score → P(win) per Isotonic Regression (oder Platt) auf aufgelösten Signalen, walk-forward. UI zeigt: „P(win) 41 % (n=48, ±13 pp)".
- **Degenerations-Alarm:** Anteil positiver Verdicts über die letzten 30 Signale < 15 % oder > 85 % → Warnung im Log. Genau dieser Zustand ist jetzt eingetreten und wurde nicht bemerkt.

### 1.5 Backtest-Harness (Pflicht, bevor 1.2–1.4 gemergt werden)

- CLI: alle historischen Signale durch eine beliebige Regel-/Modell-Version replayen. Regel-Sets versioniert (`soRulesVersion`).
- Output: Konfusionsmatrix (3 Zonen × Win/Loss/Timeout), Brier, AUC, Reliability-Tabelle (5 Buckets), Expectancy in R pro Zone, Score-Histogramm, Feuerrate je Regel mit Winrate-Delta (flagged vs. unflagged) inkl. n.
- Alt vs. neu im selben Report. Akzeptanz siehe Abschnitt 8.

---

## 2. Phase 2 — Datenströme

Alle Features Point-in-Time persistieren. Nur Quellen einbauen, die per API automatisiert abrufbar sind; Verfügbarkeit und Preise vor Integration prüfen (Stand der Anbieter kann sich geändert haben). Reihenfolge = Priorität nach Nutzen/Kosten.

### 2.1 Markt-Regime (kostenlos, höchster Hebel)

- **BTC-Regime:** Trend (EMA20/50/200-Stack auf D1, ADX D1), Vol-Regime (ATR-Perzentil über 1 Jahr → low/normal/high/extreme), 24h-/7d-Return.
- **Beta und Korrelation** des Coins zu BTC (rolling 30d) → `effectiveBtcExposure` (siehe 5.2).
- **Marktbreite:** BTC-Dominanz, ETH/BTC, TOTAL2/TOTAL3-Trend (CoinGecko o. ä.), Anteil Top-100-Coins über EMA50 (selbst berechnen).
- **Makro** (für XAU zwingend, für Crypto Kontext): DXY bzw. Broad-Dollar-Index (FRED), US10Y, 10y-Realrendite (TIPS, FRED), Richtung S&P/Nasdaq-Futures.
- **XAU-spezifisch:** CFTC-COT-Positionierung (wöchentlich), Gold-ETF-Flows, Fed-Erwartungen.

### 2.2 Derivate / Positionierung (Exchange-APIs überwiegend kostenlos)

- **Funding-Rate** je Coin (aktuell, 7d-Ø, Perzentil). Extrem positives Funding vor einem Long = Crowding/Squeeze-Risiko.
- **Open Interest** + Δ24h, OI/Marketcap; Long/Short-Ratio (Top-Trader und global); Taker-Buy/Sell-Ratio.
- **Liquidationen** 24h (long/short) und Liquidations-Cluster nahe SL/TP (z. B. Coinglass) → Flag `slInLiquidityCluster` (Stop-Hunt-Risiko).
- **Basis** Perp vs. Spot; für BTC/ETH: implizite Vol (Deribit DVOL) vs. realisierte Vol.
- Quellen prüfen: Binance/Bybit/OKX-Futures-APIs, Hyperliquid-API, Coinglass (kostenpflichtige Stufen), Deribit-API.

### 2.3 Volumen / Orderflow

- **RVOL** (Volumen vs. 20-Perioden-Ø, sessionadjustiert), Breakout-Volumen-Ratio (Breakout-Kerze vs. Ø).
- **CVD**-Slope (kumuliertes Volumen-Delta) über 4h/24h.
- **Orderbuch** zum Signalzeitpunkt: Imbalance Top-10-Levels, Spread → Liquiditäts-/Slippage-Proxy.
- **Volume-Profile** der letzten 20 Tage (POC/VAH/VAL): Lage von Entry/TP/SL relativ zu HVN/LVN.

### 2.4 Events / Kalender

- **Makro-Kalender:** FOMC, CPI, NFP, PCE → `eventWithinHours`, `eventInTpWindow`.
- **Crypto-spezifisch:** Token-Unlocks (Tokenomist o. ä.), Options-Expiry (monatlich/quartalsweise), Listings/Delistings, Netzwerk-Upgrades, BTC/ETH-ETF-Flows.
- **Zeit-Features:** Session (Asia/London/NY), Wochentag, Wochenend-Flag (dünne Liquidität), Stunde.

### 2.5 Asset-Stammdaten (einmalig + täglich aktualisiert)

- Marketcap-Tier, Alter des Coins, Sektor (Meme/L1/L2/DeFi/AI/…), Ø-Tagesvolumen → Liquiditätsklasse, Anzahl Exchange-Listings.
- **Coin-Basisrate:** Wie oft haben Signale auf diesem Coin historisch TP erreicht (mit Shrinkage, siehe 4.1).

### 2.6 Trader-Ebene (eigene Daten, kostenlos, oft der stärkste Prädiktor)

- Rolling-Stats je Trader: Winrate, Expectancy R, Profit-Factor, MaxDD, Konsistenz, Signal-Frequenz (Spam-Indikator), typisches R:R, Median-Haltedauer, Performance je Coin-Gruppe und je Regime.
- Bayes-Shrinkage (4.1), Zeitverfall (Halbwertszeit ~90 Tage oder 60 Trades — Hypothese, prüfen).
- `concurrentSignalsSameDirection`: mehrere Trader auf demselben Coin/Richtung im Zeitfenster (Konsens oder Crowding — der Backtest entscheidet).
- Streak-State (letzte 5/10) als Feature, ohne Annahme, dass Streaks etwas bedeuten.

### 2.7 On-Chain / Sentiment (später, teils kostenpflichtig, geringste Priorität)

- Exchange-Netflows, Stablecoin-Supply-Δ, Whale-Transfers (Glassnode/CryptoQuant/Nansen).
- Fear & Greed (Alternative.me), Social-Volume/Sentiment (LunarCrush/Santiment), News-Feed (CryptoPanic).
- News/Text → per LLM in strukturierte Flags (bullish/bearish/event) überführen, mit Quelle gespeichert. Sentiment ist Feature, nie Signal.

---

## 3. Technische Analyse — als Features, nicht als Signale

Regel: Kein Indikator kommt rein ohne Bucket-Statistik. Kollineare Oszillatoren (RSI/Stoch/CCI/Williams) → einer reicht.

### 3.1 Multi-Timeframe-Struktur

- Trend-Alignment D1/4h/1h: EMA-Stack, HH/HL vs. LH/LL, ADX → `mtfAlignment` (−3…+3), `tradeWithTrend` (Signalrichtung vs. D1-Trend).
- Markt-Struktur: letzte BOS/CHoCH, Swing-Highs/Lows, Supply/Demand-Zonen, Orderblocks, FVGs — ausschließlich als Abstände in ATR (`distToNearestZoneAtr`, `entryInsideZone`).
- Levels: Prior-Day/Week-High/Low, Pivots, runde Zahlen, Equal-Highs/Lows (Liquiditätspools), Gaps. Feature: liegt der SL direkt unter einem offensichtlichen Pool?

### 3.2 Volatilität

- ATR-Perzentil (eigene 1-Jahres-Historie), Bollinger-Bandwidth / Squeeze (BB innerhalb Keltner), realisierte Vol 7d/30d, Vol-Regime-Klasse.
- `tpUnrealisticForHorizon`: Median-Zeit bis TP aus der Monte-Carlo-Simulation (4.1) vs. Median-Haltedauer des Traders. Keine Faustformel, die Simulation liefert das gratis mit.

### 3.3 Momentum / Extension / Mean-Reversion

- RSI(14) auf Horizont-TF + Divergenzen, MACD-Histogramm-Richtung, ROC.
- Relative Stärke: Coin vs. BTC, Coin vs. Sektor (7d/30d).
- Extension: Abstand zu EMA20/VWAP in ATR, Z-Score zu 20-Perioden-Mittel, aufeinanderfolgende grüne Kerzen (Exhaustion) — die saubere Version von „chasing".

### 3.4 Breakout-Qualität

Die SO mag aktuell fast nur saubere Breakouts (alle 7 Positiven). Ob zu Recht, muss der Backtest zeigen. Features: Range-Länge vor Breakout, Anzahl Level-Tests, Close-Position der Breakout-Kerze relativ zum Level, Retest ja/nein, Volumen-Bestätigung, historische Fehlausbruchs-Quote am Level.

### 3.5 Volumen-Tools

- Anchored VWAP vom letzten Swing-Low/High, Session-VWAP mit Bändern, OBV-Slope, Volume-Climax-Erkennung.

### 3.6 Trade-Geometrie

- R:R, `slAtrH`, `tpAtrH`, `entryDrift`, **Fee-Drag in R** = (Round-Trip-Fees + erwartetes Funding über Haltedauer) / Stop-Distanz. Bei engen Stops frisst das den Edge.

---

## 4. Modelle (gestuft nach Datenmenge)

### 4.1 Stufe A — jetzt (n < 150 aufgelöst)

- **Geometrie-Baseline (Null-Skill-Benchmark).** Ohne Drift gilt: P(TP zuerst) = slDist / (tpDist + slDist) (Gambler's-Ruin). Ein 3R-Setup hat damit 25 % Baseline-Winrate. Mit Time-Barrier: Monte-Carlo (GBM, σ = realisierte Vol) → P(TP), P(SL), P(Timeout), Median-Zeit bis Exit je Signal. **Edge eines Traders = realisierte Winrate − Baseline-Winrate seiner Setups.** Jedes Modell muss diese Baseline im Brier schlagen, sonst ist es wertlos.
- **Bayes-Trader-Modell.** Beta-Binomial: Prior aus Population (Basisrate ~48 %, Prior-Stärke 10 Trades), Posterior je Trader. Hierarchisch je Trader×Regime und Trader×Coin-Gruppe mit Shrinkage zum Trader-Mittel. Liefert P(win) plus Unsicherheit, robust bei kleinem n.
- **Logistisches SO-Modell** (1.4) mit 8–12 Features, stark regularisiert.
- **Ensemble v1:** gewichtetes Mittel aus Baseline, Bayes-Trader, logistischem SO; Gewichte per Walk-Forward. Jede Komponente separat reporten.

### 4.2 Stufe B — ab ~300–500 aufgelösten Signalen

- **Gradient Boosting** (LightGBM/XGBoost) mit monotonen Constraints, starker Regularisierung, purged Walk-Forward-CV; SHAP-Beiträge im UI; Isotonic-Kalibrierung; Conformal Prediction für Intervalle.
- **Meta-Labeling** (López de Prado): Primärsignal = Trader (Richtung), Sekundärmodell entscheidet ob/wie viel (Size). Triple-Barrier-Labels (TP/SL/Zeit) — die Zeit-Barriere fehlt heute.
- **Regime-Modell:** HMM (2–3 Zustände) auf BTC-Returns/Vol als Regime-Feature.
- **Vol-Forecast** (EWMA/GARCH) statt rohem ATR für TP/SL-Machbarkeit.

### 4.3 Stufe C — optional, geringe Priorität

- Sequenzmodelle auf OHLCV: nur, wenn Stufe B nachweisbar an Grenzen stößt. Erfahrungsgemäß wenig Edge, viel Aufwand.
- LLM: ausschließlich unstrukturiert → strukturiert (News, Signal-Text-Parsing, Trader-Kommentar). Nie als Wahrscheinlichkeits-Schätzer. Outputs loggen und wie jedes Feature testen.

---

## 5. Strategien & Methoden (wie Predictions genutzt werden)

### 5.1 Sizing statt Blocken

- Positionsgröße = f(kalibrierte P(win), R:R): Fractional Kelly (¼ Kelly), Cap 2 % Risiko/Trade, Floor 0 = „skip". Kelly f* = p − (1−p)/b mit b = Ø Win-R / Ø Loss-R.
- Tiers A/B/C nach P(win)-Tercil; Expectancy je Tier tracken.
- `blockRedTrades` bleibt aus, bis Tier-C-Expectancy out-of-sample nachweislich < 0 ist (mit n).

### 5.2 Portfolio-Risiko (Risk-Insights-Erweiterung)

- **Heat** in drei Zahlen: `heatLive` (gefüllte Positionen / Gesamt-Equity aller Venues), `heatPerVenue` (Liquidationsrisiko entsteht pro Venue, siehe RI-1), `heatIfAllFilled` (Worst Case inkl. Working-Orders, siehe RI-2). Dazu Max-Concurrent-Positions und Sektor-Caps.
- **Korrelations-bewusste Exposure:** Σ (Position × Beta zu BTC) = effektive BTC-Wette. Zehn Alt-Longs sind meist eine BTC-Wette. Warnung ab Schwelle.
- **Drawdown-Throttle:** Risiko/Trade halbieren ab −X % DD; Tages-/Wochen-Verlustlimit.
- **Monte-Carlo** aus der eigenen R-Verteilung (Bootstrap): Risk of Ruin, erwarteter MaxDD, DD-Verteilung bei gegebenem Risiko/Trade.

### 5.3 Trade-Management-Backtests (braucht MFE/MAE aus 1.1)

- Varianten simulieren: SL auf BE bei +1R, Teil-TP 50 % bei +1R, ATR-Trailing, Time-Stop (kein Fortschritt nach N Kerzen → raus), TP-Skalierung.
- Expectancy je Variante vs. Original, walk-forward. Nur Varianten übernehmen, die out-of-sample besser sind.

### 5.4 Regime-Switching

- Trader-Gruppen/Strategien je Regime hoch-/runterstufen (z. B. Breakout-Trader in Low-Vol-Range → Tier runter). Erst als Feature (4.1), dann als Policy, wenn die Bucket-Statistik trägt.

### 5.5 Ausführungsrealismus

- Backtest mit Taker-Fees, Slippage-Modell nach Liquiditätsklasse, Funding über Haltedauer, Entry-Drift. Alle Expectancy-Zahlen netto.

---

## 6. Risk Insights — Mathe & Erweiterung

- Zuerst RI-1 bis RI-5 aus Phase 0 (P0.3). Jede Kennzahl bekommt einen Unit-Test mit Handrechnung: Expectancy, Profit-Factor, SQN, Sharpe/Sortino auf R-Basis, MaxDD, Winrate + Wilson-CI — alle auf Basis von `initialRisk` (RI-3) und mit `scratch` als eigener Klasse (RI-4).
- Neu: Kennzahlen je Trader / Coin-Gruppe / Regime / Score-Tier, Kelly und ¼-Kelly, Heat, effektive BTC-Exposure, Monte-Carlo-DD, Fee-Drag.
- Jede Kennzahl im UI mit n und Zeitraum.

---

## 7. Ops, Datenqualität, Tests

- **Tabellen:** `signalFeatures` (signalId, featureName, value, source, computedAt, version) und `modelPredictions` (signalId, modelVersion, pWin, verdict, contributions, createdAt). Das ist die Shadow-Mode-Basis.
- **Champion/Challenger:** Neues Modell läuft parallel; Wochenreport mit Brier/Expectancy je Modell.
- **Drift-Monitoring:** Feature-Verteilungen (PSI), Score-Verteilung, Anteil positiv/neutral/negativ; Alarm bei Degeneration.
- **Look-Ahead-Guard:** Assertion `computedAt ≤ signalAt + Toleranz`; ein Test, der einen absichtlich eingebauten Look-Ahead fängt.
- **Unit-Tests je Regel mit Fixtures**, u. a.: „5 %-Swing-Stop auf Coin mit 1 % 1h-ATR und 4 % D1-ATR darf `stopTooWide` NICHT auslösen"; „Entry über Level nach Close darüber ist Breakout, nicht `intoResistance`".
- **Dashboard:** Reliability-Diagramm, Score-Histogramm, Expectancy je Tercil, Feuerraten je Regel — alles mit n.

---

## 8. Reihenfolge & Akzeptanzkriterien

| Phase | Inhalt | Merge-Kriterium |
|---|---|---|
| 0 | Mess-Bugs SO-1…SO-5, RI-1…RI-5 (P0.1, P0.3); Regressionstests für die verifizierten Formeln; Relabel + Vorher/Nachher-Report | Alle Fixture-Tests grün; Report liegt vor; keine Phantom-Wins mehr in der Win-Spalte; Heat-Zahlen stimmen mit Handrechnung über alle Venues überein |
| 1 | Labels-Rest (1.1), SO-Fix (1.2–1.4, SO-6…SO-10), Harness (1.5) | Positiv-Anteil 25–60 %; Brier ≤ Geometrie-Baseline und ≤ alte SO (beide auf den **neuen** Labels); Expectancy Top-Tercil > Bottom-Tercil walk-forward; keine Regel > 40 % Feuerrate ohne Lift; Report mit n/CI |
| 2 | Datenströme 2.1, 2.2, 2.4, 2.5, 2.6; TA 3.1–3.3, 3.6 | Features geloggt, Bucket-Reports vorhanden; noch keine Modellintegration |
| 3 | Geometrie-Baseline, Bayes-Trader, Ensemble v1, Sizing, MC-Risk | 4–6 Wochen Shadow-Mode, dann Sizing-Empfehlung im UI |
| 4 | Stufe B, Management-Backtests, Regime-Policy, 2.3, 2.7 | Erst ab ~300 aufgelösten Signalen |

Zu Phase 1: Falls der Tercil-Unterschied bei der kleinen Stichprobe nicht signifikant ist, trotzdem mergen (SO-6 bis SO-10 sind Logikfehler, keine Kalibrierungsfrage) — aber als Shadow, und das Kriterium nach 100 sauber aufgelösten Signalen erneut prüfen. Phase 0 und 1 nicht in einem PR zusammenlegen: Erst muss sichtbar sein, was allein die korrekte Messung am Bild ändert.

---

## 9. Ausdrücklich NICHT tun

- Thresholds am gesamten aufgelösten Set „passend machen".
- Random-Split-CV bei überlappenden Trades.
- Accuracy als Erfolgskriterium.
- LLM als Wahrscheinlichkeits-Orakel.
- Weitere Regeln stapeln, die auf der Mehrheit der Signale feuern.
- Live-Blocken auf Basis eines Modells ohne Out-of-Sample-Nachweis.
- Kennzahlen ohne n und Zeitraum anzeigen.
- Zahlen erfinden oder „ungefähr" aus dem Kopf einsetzen — jede Zahl im Report stammt aus einer Berechnung, die reproduzierbar ist.

---

## 10. Offene Fragen an KH (vor Phase 2 klären)

1. Gibt es ein Feld für den Zeithorizont je Trader? Wenn nein: Ableitung aus Haltedauer (1.2) ok?
2. Budget für Datenanbieter? Exchange-APIs, CoinGecko, FRED, Deribit, Alternative.me sind kostenlos; Coinglass, Glassnode, Santiment, Nansen kosten Geld.
3. Sollen Sizing-Empfehlungen im UI erscheinen oder zunächst nur im Report?
4. Venues sind laut Audit Hyperliquid, Aster, MEXC. Fee-/Funding-Parameter je Venue bestätigen; in welcher Währung liegt die Equity je Venue (für die USD-Normalisierung in RI-1)?
5. Welche TP-Definition gilt als „Win" im Produkt: TP1 zuerst, oder R zum Exit unter Standard-Management?
6. Gültigkeitsfenster für Limit-Entries (SO-3): Wie lange darf ein Signal auf Fill warten, bevor es `notFilled` ist? Vorschlag: pro Trader aus Historie, Default 3 Tage.

---

## 11. Nachtrag v2.2 — Review Phase 0/1 (Commits fe71c2d, 1744570) und nächste Schritte

Grundlage: `docs/phase0-relabel-report.md`, `docs/phase1-rule-backtest.md`, Dev-Zusammenfassung vom 02.09.2026.

### 11.1 Entscheidung

- **Phase 0: abgenommen.** Red-first-Tests, getrennte Commits, reproduzierbarer Vorher/Nachher-Report, ehrliche Konfidenzintervalle. Offen sind nur Reproduzierbarkeitsfragen (11.3).
- **Phase 1: als Shadow abgenommen, Merge-Kriterien nicht erfüllt.** Der Pauschal-Stempel ist weg, aber der Report enthält einen Fehler und Lücken, die vor dem nächsten Report behoben sein müssen (11.2). Kriterium „Positiv-Anteil 25–60 %" ist nicht erreicht (siehe P1-R1/R2); wie in §8 vorgesehen bleibt die neue Regel-Logik trotzdem aktiv, weil SO-6…SO-10 Logikfehler waren.

### 11.2 Nachbesserungen Phase-1-Report (parallel zu Phase 2, vor dem nächsten Wochenreport)

| # | Befund | Anforderung |
|---|---|---|
| P1-R1 | **32 von 81 Signalen (39,5 %) haben Stance `none`.** In der Dev-Zusammenfassung nicht erwähnt. Damit ist die Coverage der SO auf 60 % gefallen | Je Signal `stanceNoneReason` loggen und im Report aufschlüsseln. Hypothesen prüfen: keine Point-in-Time-Candles (Nicht-HL-Assets wie XAU?), Parsing-Lücke (Entry/TP/SL fehlt), Regel-Vorbedingungen nicht erfüllt (z. B. < 2 Timeframes). Ziel: `none` < 5 % oder je Signal begründet |
| P1-R2 | **Gemischte Nenner.** Spalte `fires` zählt auf den 38 bewerteten Signalen, Spalte `fire rate` auf den 49 mit Stance (Beispiel: breakout „0 fires, 2,0 %"; riskReward „20 fires, 65,3 %" = 32/49). Positiv-Anteil 12,3 % ist auf 81 gerechnet, auf 49 sind es 20,4 % | Ein Nenner pro Tabelle, immer ausgewiesen. Degenerations-Alarm auf Signale **mit** Stance rechnen, Coverage (49/81) separat als eigene Kennzahl mit eigenem Alarm (< 90 %) |
| P1-R3 | **Vorzeichenfehler im Harness-Text.** „Top-vs-bottom 33,3 % vs 41,2 % (positive discrimination = the new rules point the right way)" — die Tabelle zeigt das Gegenteil: Positiv-Zone 1/3 gewinnt seltener als Negativ-Zone 7/17. Außerdem verletzt ein Richtungs-Satz über eine Zone mit n=3 Leitplanke 5 | Text aus `wrTop − wrBottom` ableiten, Unit-Test auf Vorzeichen ↔ Wortlaut. Zonen mit n < 15 bekommen keinen Richtungs-Satz, nur „n zu klein" |
| P1-R4 | **Nur Winrate, keine Expectancy** je Zone und je Regel. Für R:R-Regeln ist Winrate allein irreführend: ein schwaches R:R müsste per Geometrie eine *höhere* Winrate haben; entscheidend ist R | Expectancy in R (brutto und netto, mit Standardfehler) je Zone und je Regel (flagged vs. unflagged) ergänzen |
| P1-R5 | **Kein Brier, keine Baseline.** Korrektur der Anweisung: Die Geometrie-Baseline steht in §4.1/Phase 3, wird aber in §8 für Phase 1 als Messlatte verlangt. Die Formel-Variante ist eine Zeile und gehört jetzt in den Harness; nur die Monte-Carlo-Variante bleibt Phase 3 | Je Signal `pBase = slDist / (tpDist + slDist)`. Brier für (a) Baseline, (b) alte SO mit score/100, (c) neue SO mit score/100. Zur Einordnung: bei TP1 ≈ 2R liegt die Baseline bei ~33 %, gemessen sind 44,7 % (CI 30–60 %) — das CI schließt die Baseline ein, ein Trader-Edge ist damit noch nicht belegt |
| P1-R6 | **`stopTooWide` feuert auf 47 % und trennt in die falsche Richtung** (flagged 50 % vs. unflagged 41,7 %); `stopWellPlaced` ebenfalls verkehrt herum (38,5 % vs. 48 %). Auf n=38 ist das Rauschen, aber die in §1.2 verlangte Bucket-Tabelle fehlt | slAtrH-Bucket-Tabelle (0–0,5 / 0,5–1 / 1–2 / 2–3,5 / > 3,5) mit Winrate und Expectancy ausgeben. Dazu: Verteilung des gewählten Horizont-Timeframes je Trader (wer landete auf 1h/4h/D1 und warum). Threshold bleibt Hypothese, bis die Tabelle vorliegt |
| P1-R7 | Expectancy +0,30R ist brutto (TP1-or-SL-Proxy, ohne Fees/Funding/Slippage) und ohne Fehlerbalken | Netto-Expectancy mit Venue-Parametern (offene Frage 4) und Standardfehler daneben ausweisen |
| P1-R8 | **Reproduzierbarkeit.** Phantom-Win-Liste im Audit (ZRO, PUMP, SPX) ≠ im Report (PUMP, BTC, GRASS, ZRO). Backfill von `initial_size` für Legacy-Rows: Quelle unklar | Differenz der Listen begründen (welcher Lauf hatte recht, warum). `initialRiskSource` je Trade (`recorded` / `backfilled_estimate`); Kennzahlen optional nur auf `recorded` rechnen |
| P1-R9 | Replay läuft auf Hyperliquid-15m-Candles. Was passiert mit Assets, die dort nicht handelbar sind? | Eigene Klasse `noData` statt `unresolved`, damit „35 unresolved, alle < 14 d" überprüfbar bleibt. Alters-Verteilung der `unresolved` im Report |

### 11.3 Korrektur der Dev-Lesart: Phase 2 ist nicht „premature"

Die Dev-Zusammenfassung verschiebt Phase 2 als verfrüht. Das ist eine Fehllesart von §8: Das Volumen-Gate (~100 sauber aufgelöste Signale, ~300 für Stufe B) gilt für **Modell-Fitting, Kalibrierung und Sizing** (Phase 3/4). Phase 2 ist **Datensammlung** — Point-in-Time-Features loggen und Bucket-Reports erzeugen, ohne Modellintegration. Sie ist durch nichts blockiert und wird mit jeder Woche Verzögerung teurer: Funding, Open Interest, Orderbuch und Liquidations-Cluster lassen sich nachträglich nicht rekonstruieren. Jedes Signal ohne geloggte Features ist als Trainingsbeispiel verloren.

**Anweisung:** Phase 2 sofort starten, parallel zu 11.2. Reihenfolge: 2.1 (BTC-Regime, Beta), 2.6 (Trader-Stats mit Shrinkage), 2.2 (Funding, OI, Liquidationen), 2.4 (Kalender, Zeit-Features), dann TA 3.1–3.3 und 3.6. Ausgabe je Feature: Bucket-Statistik mit n, sonst nichts.

### 11.4 Gate-Präzisierung

Die 81 Signale stammen aus 22 Tagen (11.08.–02.09.) — ein einziges Marktregime. Jede Regel-Statistik daraus ist regimespezifisch. Das Gate „~100 sauber aufgelöste Signale" wird ergänzt um: **mindestens 8 Wochen Abdeckung und mindestens zwei BTC-Regime** (Trend up/down oder Vol low/high nach 2.1). Vorher werden Thresholds nicht „entschieden", nur beobachtet.

### 11.5 Wochenreport (Cron)

Phase-0- und Phase-1-Report als wöchentlichen Lauf automatisieren, mit Kopfzeile: sauber aufgelöste Signale x/100, Wochen-Abdeckung, BTC-Regime-Abdeckung, Coverage der SO, Positiv-Anteil (auf Signale mit Stance), Brier je Modell. Damit ist jederzeit sichtbar, wie weit das Gate entfernt ist, ohne dass jemand fragen muss.

### 11.6 Was gut war (beibehalten)

Red-first-Fixtures je Ticket, getrennte Commits für Messung und Regeln, Wilson-Intervalle an jeder Rate, klare Trennung „was die Messung allein verändert" von „was die Regeln verändern". Nebenbefund, der die Überkorrektur der alten SO erklärt: Die frühere Hand-Kalibrierung wurde gegen die korrupte „favorable"-Metrik (37/81, ganzes Fenster inkl. Post-Stop-Rally) abgestimmt — sie hat auf falsche Labels optimiert.
