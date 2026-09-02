<!-- Reproduce: scratchpad/fetch_all.py -> bundle.json, fetch BTC 1d -> btc_d1.json, then:
     tsx apps/server/src/scripts/backfillFeatureReport.ts <so.json> <bundle.json> <btc_d1.json> docs/phase2-feature-buckets.md
     Live equivalent: tsx apps/server/src/scripts/featureBuckets.ts [days] [out.md]  (reads the DB once features accrue).
     Numbers are computed by that script; do not edit by hand. -->

# Phase 2 — feature bucket report (offline backfill over history)

Signals with recomputed features: **70** (HL-listed) · scored win/loss: **40**. Point-in-time: features use only pre-signal candles + a BTC daily slice ending at the signal.

> Descriptive only — no model, no thresholds set (§11.3/§11.4). 22-day, one-regime sample: every bucket is far below the n=15 finding bar and the ≥100-signal / ≥2-regime gate. Funding/OI/liquidations are absent here (not in the historical snapshot); they will be logged live going forward.

### betaToBtc30d (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 1.000 | 3 | 33.3% (6–79) ·small | -0.32R |
| 1.000–1.221 | 15 | 40.0% (20–64) | +0.37R |
| 1.221–1.463 | 10 | 60.0% (31–83) ·small | +0.47R |
| > 1.463 | 12 | 41.7% (19–68) ·small | +0.15R |

### btcAtrPctile (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 0.041 | 12 | 50.0% (25–75) ·small | +1.18R |
| 0.041–0.442 | 13 | 46.2% (23–71) ·small | -0.03R |
| 0.442–0.721 | 10 | 20.0% (6–51) ·small | -0.63R |
| > 0.721 | 5 | 80.0% (38–96) ·small | +0.39R |

### btcRet24h (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.006 | 7 | 57.1% (25–84) ·small | -0.01R |
| -0.006–0.000 | 6 | 16.7% (3–56) ·small | -0.66R |
| 0.000–0.026 | 12 | 33.3% (14–61) ·small | +0.38R |
| > 0.026 | 15 | 60.0% (36–80) | +0.73R |

### btcRet7d (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.013 | 7 | 42.9% (16–75) ·small | -0.19R |
| -0.013–0.008 | 7 | 57.1% (25–84) ·small | +1.21R |
| 0.008–0.150 | 10 | 50.0% (24–76) ·small | +0.73R |
| > 0.150 | 16 | 37.5% (18–61) | -0.23R |

### btcTrendD1 (categorical, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| sideways | 23 | 43.5% (26–63) | -0.16R |
| down | 17 | 47.1% (26–69) | +0.82R |

### btcVolRegime (categorical, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| low | 23 | 47.8% (29–67) | +0.65R |
| high | 9 | 55.6% (27–81) ·small | -0.00R |
| normal | 8 | 25.0% (7–59) ·small | -0.54R |

### coinRet7d (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.023 | 5 | 40.0% (12–77) ·small | -0.25R |
| -0.023–0.046 | 14 | 57.1% (33–79) ·small | +0.99R |
| 0.046–0.213 | 9 | 44.4% (19–73) ·small | +0.31R |
| > 0.213 | 12 | 33.3% (14–61) ·small | -0.36R |

### coinVsBtcRs7d (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.023 | 6 | 50.0% (19–81) ·small | +0.03R |
| -0.023–0.000 | 5 | 60.0% (23–88) ·small | +0.89R |
| 0.000–0.049 | 17 | 41.2% (22–64) | +0.34R |
| > 0.049 | 12 | 41.7% (19–68) ·small | +0.05R |

### consecutiveGreen (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| 0.000–1.000 | 12 | 33.3% (14–61) ·small | -0.18R |
| 1.000–3.000 | 18 | 44.4% (25–66) | +0.06R |
| > 3.000 | 10 | 60.0% (31–83) ·small | +1.16R |

### corrToBtc30d (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 0.579 | 11 | 45.5% (21–72) ·small | +0.21R |
| 0.579–0.756 | 10 | 70.0% (40–89) ·small | +0.83R |
| 0.756–0.868 | 9 | 33.3% (12–65) ·small | -0.43R |
| > 0.868 | 10 | 30.0% (11–60) ·small | +0.43R |

### distToEma20Atr (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.096 | 7 | 42.9% (16–75) ·small | -0.21R |
| -0.096–1.033 | 11 | 54.5% (28–79) ·small | +0.05R |
| 1.033–2.264 | 9 | 44.4% (19–73) ·small | +1.26R |
| > 2.264 | 13 | 38.5% (18–64) ·small | +0.02R |

### extensionZ20 (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -0.130 | 7 | 42.9% (16–75) ·small | -0.21R |
| -0.130–1.009 | 12 | 33.3% (14–61) ·small | +0.44R |
| 1.009–1.950 | 9 | 66.7% (35–88) ·small | +0.72R |
| > 1.950 | 12 | 41.7% (19–68) ·small | +0.11R |

### feeDragR (numeric, n=66)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 0.010 | 10 | 40.0% (17–69) ·small | -0.26R |
| 0.010–0.013 | 11 | 54.5% (28–79) ·small | +0.02R |
| 0.013–0.020 | 11 | 45.5% (21–72) ·small | +0.42R |
| > 0.020 | 6 | 16.7% (3–56) ·small | +1.08R |

### hourUtc (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 7.000 | 8 | 25.0% (7–59) ·small | +0.63R |
| 7.000–9.000 | 5 | 60.0% (23–88) ·small | +0.69R |
| 9.000–14.000 | 11 | 45.5% (21–72) ·small | +0.06R |
| > 14.000 | 16 | 50.0% (28–72) | +0.08R |

### mtfAlignment (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ -2.000 | 2 | 100.0% (34–100) ·small | +0.93R |
| -2.000–-1.000 | 13 | 46.2% (23–71) ·small | +0.85R |
| -1.000–1.000 | 11 | 18.2% (5–48) ·small | -0.69R |
| > 1.000 | 14 | 57.1% (33–79) ·small | +0.33R |

### rr (numeric, n=65)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 0.603 | 10 | 50.0% (24–76) ·small | -0.17R |
| 0.603–1.059 | 11 | 36.4% (15–65) ·small | -0.31R |
| 1.059–2.844 | 11 | 36.4% (15–65) ·small | -0.18R |
| > 2.844 | 6 | 50.0% (19–81) ·small | +1.22R |

### session (categorical, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ny | 15 | 53.3% (30–75) | +0.13R |
| london | 14 | 50.0% (27–73) ·small | +0.35R |
| asia | 8 | 25.0% (7–59) ·small | +0.63R |
| offhours | 3 | 33.3% (6–79) ·small | -0.33R |

### slAtrH (numeric, n=66)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 2.175 | 8 | 25.0% (7–59) ·small | -0.47R |
| 2.175–3.392 | 11 | 45.5% (21–72) ·small | +0.88R |
| 3.392–4.718 | 11 | 45.5% (21–72) ·small | +0.34R |
| > 4.718 | 8 | 50.0% (22–78) ·small | -0.08R |

### tpAtrH (numeric, n=67)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| ≤ 2.256 | 11 | 54.5% (28–79) ·small | -0.02R |
| 2.256–3.760 | 13 | 46.2% (23–71) ·small | -0.08R |
| 3.760–7.735 | 10 | 40.0% (17–69) ·small | +0.02R |
| > 7.735 | 6 | 33.3% (10–70) ·small | +0.56R |

### tradeWithTrendD1 (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| -1.000–0.000 | 13 | 46.2% (23–71) ·small | +0.87R |
| > 0.000 | 27 | 44.4% (28–63) | -0.04R |

### weekday (categorical, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| Thu | 10 | 50.0% (24–76) ·small | +0.88R |
| Wed | 7 | 42.9% (16–75) ·small | -0.14R |
| Tue | 6 | 33.3% (10–70) ·small | -0.45R |
| Mon | 6 | 50.0% (19–81) ·small | +1.22R |
| Fri | 4 | 75.0% (30–95) ·small | +0.32R |
| Sat | 4 | 25.0% (5–70) ·small | -0.46R |
| Sun | 3 | 33.3% (6–79) ·small | -0.44R |

### weekend (numeric, n=70)
| bucket | n | win-rate (95% CI) | expectancy R |
|---|---|---|---|
| > 0.000 | 40 | 45.0% (31–60) | +0.28R |
