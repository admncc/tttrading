import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  timeFeatures, geometryFeatures, taFeatures, btcRegimeFeatures, betaFeatures,
  traderStatsFeatures, horizonForHold, assetFeatures, coinBaseRateFeatures, ethBtcFeatures,
  fundingHistoryFeatures, crowdRatioFeatures, oiFeatures, type Feat,
} from "./compute.js";

const get = (fs: Feat[], name: string) => fs.find((f) => f.name === name);
type C = { t: number; o: number; h: number; l: number; c: number };
const day = (i: number, o: number, h: number, l: number, c: number): C => ({ t: i * 86_400_000, o, h, l, c });

describe("timeFeatures (2.4)", () => {
  it("classifies session and weekend from UTC", () => {
    const sun = Date.parse("2026-01-04T02:00:00Z"); // Sunday, 02:00 UTC → asia, weekend
    const f = timeFeatures(sun);
    assert.equal(get(f, "session")!.text, "asia");
    assert.equal(get(f, "weekday")!.text, "Sun");
    assert.equal(get(f, "weekend")!.num, 1);
    assert.equal(get(f, "hourUtc")!.num, 2);
  });
  it("NY session on a weekday", () => {
    const wed = Date.parse("2026-01-07T15:00:00Z");
    const f = timeFeatures(wed);
    assert.equal(get(f, "session")!.text, "ny");
    assert.equal(get(f, "weekend")!.num, 0);
  });
});

describe("geometryFeatures (3.6)", () => {
  it("rr, slAtrH, feeDragR from levels and horizon ATR", () => {
    // entry 100, sl 90 (risk 10), tp 130 (reward 30), atrH 8
    const f = geometryFeatures("long", 100, 90, 130, 100, 8, 0.0009);
    assert.equal(get(f, "rr")!.num, 3);
    assert.equal(get(f, "slAtrH")!.num, 10 / 8);
    // feeDragR = 0.0009*100 / 10 = 0.009
    assert.ok(Math.abs(get(f, "feeDragR")!.num! - 0.009) < 1e-9);
  });
});

describe("taFeatures (3.1–3.3)", () => {
  it("mtfAlignment sums signed per frame; +3 when all up and long", () => {
    const frames = [{ interval: "1h", trend: "up" as const }, { interval: "4h", trend: "up" as const }, { interval: "1d", trend: "up" as const }];
    const f = taFeatures("long", frames, []);
    assert.equal(get(f, "mtfAlignment")!.num, 3);
    assert.equal(get(f, "tradeWithTrendD1")!.num, 1);
  });
  it("mtfAlignment is negative for a long into downtrends", () => {
    const frames = [{ interval: "1h", trend: "down" as const }, { interval: "4h", trend: "down" as const }, { interval: "1d", trend: "down" as const }];
    assert.equal(get(taFeatures("long", frames, []), "mtfAlignment")!.num, -3);
  });
  it("counts consecutive green candles", () => {
    const c: C[] = [day(0, 1, 1, 1, 2), day(1, 2, 3, 2, 1), day(2, 1, 2, 1, 2), day(3, 2, 3, 2, 3), day(4, 3, 4, 3, 4)];
    // pad to >=21 with green
    while (c.length < 25) c.push(day(c.length, 1, 2, 1, 2));
    const f = taFeatures("long", [], c);
    assert.ok((get(f, "consecutiveGreen")!.num ?? 0) >= 1);
  });
});

describe("btcRegimeFeatures (2.1)", () => {
  it("detects an uptrend when EMAs stack up", () => {
    const c: C[] = [];
    for (let i = 0; i < 220; i++) { const p = 100 + i; c.push(day(i, p, p + 1, p - 1, p + 0.5)); }
    const f = btcRegimeFeatures(c);
    assert.equal(get(f, "btcTrendD1")!.text, "up");
    assert.ok(["low", "normal", "high", "extreme"].includes(get(f, "btcVolRegime")!.text!));
  });
});

describe("betaFeatures (2.1)", () => {
  it("beta ≈ 2 when the coin moves twice BTC each day", () => {
    const btc: C[] = [], coin: C[] = [];
    let pb = 100, pc = 100;
    for (let i = 0; i < 40; i++) {
      const rb = i % 2 ? 0.01 : -0.008;
      const nb = pb * (1 + rb), nc = pc * (1 + 2 * rb);
      btc.push(day(i, pb, nb, pb, nb)); coin.push(day(i, pc, nc, pc, nc));
      pb = nb; pc = nc;
    }
    const f = betaFeatures(coin, btc);
    assert.ok(Math.abs(get(f, "betaToBtc30d")!.num! - 2) < 0.05, `beta ${get(f, "betaToBtc30d")!.num}`);
    assert.ok((get(f, "corrToBtc30d")!.num ?? 0) > 0.99);
  });
});

describe("traderStatsFeatures (2.6)", () => {
  it("shrinks a tiny sample toward the population base rate", () => {
    // 2/2 wins, priorStrength 10, priorMean 0.48 → (2 + 4.8)/(2+10) = 0.5667
    const f = traderStatsFeatures({ resolved: 2, wins: 2 });
    assert.ok(Math.abs(get(f, "traderWinrateShrunk")!.num! - 0.5667) < 0.001);
  });
  it("a large sample stays close to its raw rate", () => {
    const f = traderStatsFeatures({ resolved: 200, wins: 120 }); // raw 0.60
    assert.ok(Math.abs(get(f, "traderWinrateShrunk")!.num! - 0.60) < 0.02);
  });
});

describe("assetFeatures + coinBaseRate (2.5)", () => {
  it("maps sector (incl. k-prefixed memes) and passes cap tier", () => {
    assert.equal(get(assetFeatures("BTC", "large"), "sector")!.text, "l1");
    assert.equal(get(assetFeatures("kPEPE", "small"), "sector")!.text, "meme");
    assert.equal(get(assetFeatures("SOMETHINGNEW", "micro"), "sector")!.text, "other");
    assert.equal(get(assetFeatures("BTC", "large"), "capTier")!.text, "large");
  });
  it("coin base rate shrinks a tiny sample toward the prior", () => {
    const f = coinBaseRateFeatures({ resolved: 2, tpFirst: 2 });
    assert.ok(Math.abs(get(f, "coinBaseRateShrunk")!.num! - 0.5667) < 0.001);
  });
});

describe("ethBtcFeatures (2.1 breadth)", () => {
  it("flags eth-strong when the ratio is rising", () => {
    const btc: C[] = [], eth: C[] = [];
    for (let i = 0; i < 60; i++) { const b = 100; const e = 2 + i * 0.02; btc.push(day(i, b, b, b, b)); eth.push(day(i, e, e, e, e)); }
    const f = ethBtcFeatures(eth, btc);
    assert.equal(get(f, "ethBtcRegime")!.text, "eth-strong");
  });
});

describe("fundingHistoryFeatures (2.2)", () => {
  const hist = (rates: number[], nowMs: number) => rates.map((r, i) => ({ time: nowMs - (rates.length - i) * 3_600_000, rate: r }));
  it("current at the top of its range ⇒ high percentile; long into it ⇒ extreme", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    const rates = Array.from({ length: 50 }, (_, i) => 0.00001 * i); // 0 .. 0.00049
    const f = fundingHistoryFeatures("long", 0.00048, hist(rates, now), now);
    assert.ok(get(f, "fundingPercentile")!.num! >= 0.9);
    assert.equal(get(f, "fundingExtremeVsTrade")!.num, 1);
  });
  it("a short at the same high funding is NOT crowded-vs-trade", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    const rates = Array.from({ length: 50 }, (_, i) => 0.00001 * i);
    const f = fundingHistoryFeatures("short", 0.00048, hist(rates, now), now);
    assert.equal(get(f, "fundingExtremeVsTrade")!.num, 0);
  });
  it("too little history ⇒ no features", () => {
    assert.equal(fundingHistoryFeatures("long", 0.0001, [], Date.now()).length, 0);
  });
});

describe("crowdRatioFeatures + oiFeatures (2.2 OKX)", () => {
  const hist = (ratios: number[], nowMs: number) => ratios.map((r, i) => ({ time: nowMs - i * 3_600_000, ratio: r })); // newest first
  it("long into a top-percentile long-heavy book flags crowded-same-side", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const ratios = [2.4, 1.2, 1.1, 1.0, 0.9, 1.05, 1.1, 1.2, 1.15, 1.0]; // current 2.4 = top
    const f = crowdRatioFeatures("long", hist(ratios, now), now);
    assert.equal(get(f, "lsAccountRatio")!.num, 2.4);
    assert.ok(get(f, "lsRatioPercentile")!.num! >= 0.9);
    assert.equal(get(f, "lsCrowdedSameSide")!.num, 1);
  });
  it("short into the same long-heavy book is NOT crowded-same-side", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const ratios = [2.4, 1.2, 1.1, 1.0, 0.9, 1.05, 1.1, 1.2, 1.15, 1.0];
    assert.equal(get(crowdRatioFeatures("short", hist(ratios, now), now), "lsCrowdedSameSide")!.num, 0);
  });
  it("oiFeatures computes 24h change", () => {
    const now = Date.parse("2026-02-02T00:00:00Z");
    const h = [] as { time: number; oi: number }[];
    for (let i = 0; i < 30; i++) h.push({ time: now - i * 3_600_000, oi: 800 + i * 10 }); // newest 800, 24h-ago 1040
    const f = oiFeatures(h, now);
    assert.equal(get(f, "okxOi")!.num, 800);
    assert.ok(get(f, "oiChange24hPct")!.num! < 0); // OI fell over the last 24h (800 < 1040)
  });
});

describe("horizonForHold (1.2)", () => {
  it("maps hold time to horizon TF", () => {
    assert.equal(horizonForHold(4), "1h");
    assert.equal(horizonForHold(48), "4h");
    assert.equal(horizonForHold(240), "1d");
    assert.equal(horizonForHold(undefined), "4h");
  });
});
