import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHeat, type HeatPosition } from "./insightsMath.js";
import { rMultiple, classifyOutcome, sqn, wilson, profitFactor } from "@tttrading/shared";

describe("rMultiple — RI-3 (R from initial risk, not post-partial size)", () => {
  it("50% off at +1R, rest at +2R ⇒ 1.5R (net 150 on initial risk 100)", () => {
    assert.equal(rMultiple(150, 100), 1.5);
  });
  it("undefined when initial risk is unknown or zero", () => {
    assert.equal(rMultiple(50, undefined), undefined);
    assert.equal(rMultiple(50, 0), undefined);
  });
});

describe("classifyOutcome — RI-4 (scratch class)", () => {
  it("net ≈ +0.02R ⇒ scratch (out of win-rate)", () => {
    assert.equal(classifyOutcome(2, 0.02), "scratch");
  });
  it("+0.5R ⇒ win, −0.5R ⇒ loss", () => {
    assert.equal(classifyOutcome(50, 0.5), "win");
    assert.equal(classifyOutcome(-50, -0.5), "loss");
  });
  it("without R, exact break-even ⇒ scratch, else sign of net", () => {
    assert.equal(classifyOutcome(0, undefined), "scratch");
    assert.equal(classifyOutcome(10, undefined), "win");
    assert.equal(classifyOutcome(-10, undefined), "loss");
  });
});

describe("computeHeat — RI-1 (multi-venue equity + per-venue heat)", () => {
  it("portfolio heat uses summed equity; per-venue heat uses the venue's own equity", () => {
    const live: HeatPosition[] = [{ venue: "mexc", notional: 1000, riskUsd: 60, side: "long" }];
    const r = computeHeat(live, [], { hyperliquid: 400, mexc: 600 });
    assert.equal(r.totalEquity, 1000);
    assert.equal(r.heatLive, 0.06); // 60 / 1000 summed
    const mexc = r.perVenue.find((v) => v.venue === "mexc")!;
    assert.equal(mexc.heat, 0.1); // 60 / 600 MEXC-local — the real liquidation view
    const hl = r.perVenue.find((v) => v.venue === "hyperliquid")!;
    assert.equal(hl.heat, 0); // no MEXC risk sits on HL
  });
});

describe("computeHeat — RI-2 (working orders excluded from live heat)", () => {
  it("heatLive from filled only; heatIfAllFilled includes working", () => {
    const live: HeatPosition[] = [
      { venue: "hyperliquid", notional: 1000, riskUsd: 20, side: "long" },
      { venue: "hyperliquid", notional: 1000, riskUsd: 20, side: "short" },
    ];
    const working: HeatPosition[] = [
      { venue: "hyperliquid", notional: 1000, riskUsd: 20, side: "long" },
      { venue: "hyperliquid", notional: 1000, riskUsd: 20, side: "long" },
      { venue: "hyperliquid", notional: 1000, riskUsd: 20, side: "long" },
    ];
    const r = computeHeat(live, working, { hyperliquid: 1000 });
    assert.equal(r.riskLiveUsd, 40); // 2 filled
    assert.equal(r.riskIfAllFilledUsd, 100); // 5 total
    assert.equal(r.heatLive, 0.04);
    assert.equal(r.heatIfAllFilled, 0.1);
    assert.equal(r.netExposureLive, 0); // one long, one short, equal notional
  });
});

describe("frozen regression tests — verified-correct formulas", () => {
  it("SQN = mean(R)/std(R) × √min(n,100)", () => {
    // rs = [1, -1, 2, -1, 1]  mean 0.4, sample-std √1.8 ≈ 1.3416, √5 ≈ 2.2360
    const v = sqn([1, -1, 2, -1, 1])!;
    assert.ok(Math.abs(v - (0.4 / 1.3416407) * Math.sqrt(5)) < 1e-6, `got ${v}`);
  });
  it("SQN caps N at 100", () => {
    const rs = new Array(400).fill(0).map((_, i) => (i % 2 ? 1 : -0.9));
    const v = sqn(rs)!;
    const m = rs.reduce((s, x) => s + x, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, x) => s + (x - m) * (x - m), 0) / (rs.length - 1));
    assert.ok(Math.abs(v - (m / sd) * Math.sqrt(100)) < 1e-6);
  });
  it("profit factor = gross wins / gross losses", () => {
    assert.equal(profitFactor([2, 2, -1, -1]), 2); // gross win 4 / gross loss 2
    assert.equal(profitFactor([1, 2, 3]), undefined); // no losing $
  });
  it("Wilson 95% interval brackets the point estimate and stays in [0,1]", () => {
    const w = wilson(24, 48);
    assert.equal(w.p, 0.5);
    assert.ok(w.lo > 0.34 && w.lo < 0.5 && w.hi > 0.5 && w.hi < 0.67, `got ${w.lo}..${w.hi}`);
  });
});

import { geoBaselineP, brier, discriminationNote } from "@tttrading/shared";

describe("geoBaselineP — geometry baseline (P1-R5)", () => {
  it("3R setup ⇒ 25% baseline win-rate", () => {
    // entry 100, stop 90 (risk 10), tp 130 (reward 30) → 10/40 = 0.25
    assert.equal(geoBaselineP(100, 90, 130), 0.25);
  });
  it("1:1 ⇒ 50%", () => {
    assert.equal(geoBaselineP(100, 90, 110), 0.5);
  });
});

describe("brier (P1-R5)", () => {
  it("perfect predictions ⇒ 0", () => {
    assert.equal(brier([{ p: 1, win: true }, { p: 0, win: false }]), 0);
  });
  it("always 0.5 on a 50/50 set ⇒ 0.25", () => {
    assert.equal(brier([{ p: 0.5, win: true }, { p: 0.5, win: false }]), 0.25);
  });
});

describe("discriminationNote — sign matches wording (P1-R3)", () => {
  it("bottom zone winning more ⇒ WRONG direction, direction −1", () => {
    const r = discriminationNote(0.33, 20, 0.5, 20);
    assert.equal(r.direction, -1);
    assert.match(r.text, /WRONG/);
  });
  it("top zone winning more ⇒ correct direction, +1", () => {
    const r = discriminationNote(0.6, 20, 0.4, 20);
    assert.equal(r.direction, 1);
    assert.match(r.text, /correct/);
  });
  it("n below threshold ⇒ no directional read, direction 0", () => {
    const r = discriminationNote(1, 3, 0.4, 20);
    assert.equal(r.direction, 0);
    assert.match(r.text, /too small/);
  });
});
