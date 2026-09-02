import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeOutcome, type OutcomeCandle } from "./outcome.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const M15 = 900_000;

/** Build bars at 15m spacing; each entry is [open, high, low, close]. */
function bars(rows: [number, number, number, number][], t0 = T0): OutcomeCandle[] {
  return rows.map((r, i) => ({ t: t0 + i * M15, o: r[0], h: r[1], l: r[2], c: r[3] }));
}

// "now" far in the future so age never blocks resolution unless we want it to.
const NOW = T0 + 60 * 86_400_000;

describe("computeOutcome — SO-1 (excursion cut at the resolving bar)", () => {
  it("stopped-out loser that later rallies to +2R stays a loss; mfe cut before the SL bar", () => {
    // long, market fill at 100, SL 90 (risk 10), TP 130 (never reached before SL)
    const c = bars([
      [100, 104, 99, 102], // bar0
      [102, 105, 100, 103], // bar1  favorable high 105 → mfe 5 (0.5R)
      [103, 104, 101, 102], // bar2
      [102, 103, 98, 100], // bar3
      [100, 101, 95, 96], // bar4
      [96, 97, 89, 91], // bar5  SL 90 touched → loss here
      [91, 126, 90, 125], // bar6  rally to 126 AFTER the stop — must NOT count
      [125, 130, 120, 128], // bar7  would be +2R+ — must NOT count
    ]);
    const o = computeOutcome({ side: "long", stopLoss: 90, takeProfits: [130], createdMs: T0 }, c, { nowMs: NOW });
    assert.ok(o);
    assert.equal(o!.outcomeClass, "loss");
    assert.equal(o!.firstHit, "sl");
    assert.equal(o!.maxR, 0.5); // favorable excursion 5/10 measured before the SL bar only
    assert.ok((o!.maxR ?? 0) < 1, "post-stop rally excluded");
  });

  it("winner cuts adverse excursion at the TP bar", () => {
    // long, market fill 100, SL 70 (risk 30), TP 110. Dip to 96 before TP; deep dip 60 AFTER TP must not count.
    const c = bars([
      [100, 101, 96, 99], // mae 4 so far
      [99, 100, 98, 99],
      [99, 111, 98, 110], // TP 110 hit → win here
      [110, 112, 60, 65], // crash after TP — must NOT count toward MAE
    ]);
    const o = computeOutcome({ side: "long", stopLoss: 70, takeProfits: [110], createdMs: T0 }, c, { nowMs: NOW });
    assert.equal(o!.outcomeClass, "win");
    assert.equal(o!.firstHit, "tp");
    // adverse excursion 4/30 ≈ 0.13R, cut at the TP bar (not the later crash)
    assert.ok((o!.maeR ?? 9) < 0.2, `maeR should be small, got ${o!.maeR}`);
  });
});

describe("computeOutcome — SO-2 (timeout is its own class)", () => {
  it("no TP/SL over the horizon ⇒ timeout with R at the last close", () => {
    // 20 bars of chop, neither TP(130) nor SL(70) touched; horizon short so it resolves.
    const rows: [number, number, number, number][] = [];
    for (let i = 0; i < 20; i++) rows.push([100, 105, 96, 101]);
    const c = bars(rows);
    const o = computeOutcome(
      { side: "long", stopLoss: 70, takeProfits: [130], createdMs: T0 },
      c,
      { nowMs: NOW, timeoutHorizonMs: 60 * 60_000 }, // 1h horizon (< 20×15m window)
    );
    assert.equal(o!.outcomeClass, "timeout");
    assert.equal(o!.firstHit, "none");
    // last close 101, base 100, risk 30 → rAtClose = 1/30 ≈ 0.03
    assert.equal(o!.rAtClose, 0.03);
    assert.equal(o!.resolved, true);
  });

  it("still-young chop with no hit stays unresolved (not a timeout yet)", () => {
    const rows: [number, number, number, number][] = [];
    for (let i = 0; i < 4; i++) rows.push([100, 102, 98, 100]);
    const c = bars(rows);
    const o = computeOutcome(
      { side: "long", stopLoss: 70, takeProfits: [130], createdMs: T0 },
      c,
      { nowMs: T0 + 30 * 60_000, timeoutHorizonMs: 14 * 86_400_000 },
    );
    assert.equal(o!.resolved, false);
    assert.equal(o!.outcomeClass, undefined);
  });
});

describe("computeOutcome — SO-3 (limit fill / notFilled)", () => {
  it("limit 5% below CMP that never trades through ⇒ notFilled, no outcome", () => {
    // entry 95 (limit), price stays above 97 the whole window
    const rows: [number, number, number, number][] = [];
    for (let i = 0; i < 10; i++) rows.push([100, 102, 98, 100]);
    const c = bars(rows);
    const o = computeOutcome(
      { side: "long", entry: 95, stopLoss: 90, takeProfits: [120], createdMs: T0 },
      c,
      { nowMs: NOW, fillWindowMs: 2 * 60 * 60_000 }, // 2h window, all bars inside it
    );
    assert.equal(o!.outcomeClass, "notFilled");
    assert.equal(o!.filled, false);
    assert.equal(o!.resolved, true);
  });

  it("limit that DOES trade through starts measuring from the fill", () => {
    const c = bars([
      [100, 102, 98, 100], // no touch of 95
      [99, 100, 94, 96], // trades through 95 → filled here (base 95)
      [96, 121, 95, 120], // TP 120 hit
    ]);
    const o = computeOutcome(
      { side: "long", entry: 95, stopLoss: 90, takeProfits: [120], createdMs: T0 },
      c,
      { nowMs: NOW },
    );
    assert.equal(o!.filled, true);
    assert.equal(o!.outcomeClass, "win");
    assert.equal(o!.firstHit, "tp");
  });
});

describe("computeOutcome — SO-3b (ambiguous)", () => {
  it("limit fill and SL in the same bar ⇒ ambiguous", () => {
    const c = bars([
      [100, 101, 99, 100], // no touch of entry 98
      [99, 100, 90, 92], // trades through entry 98 AND SL 91 in the same bar
      [92, 95, 91, 94],
    ]);
    const o = computeOutcome(
      { side: "long", entry: 98, stopLoss: 91, takeProfits: [120], createdMs: T0 },
      c,
      { nowMs: NOW },
    );
    assert.equal(o!.outcomeClass, "ambiguous");
    assert.equal(o!.resolved, true);
  });

  it("TP and SL in the same resolving bar ⇒ ambiguous", () => {
    const c = bars([
      [100, 100.5, 99.5, 100],
      [100, 121, 89, 100], // both TP 120 and SL 90 inside one bar
    ]);
    const o = computeOutcome(
      { side: "long", stopLoss: 90, takeProfits: [120], createdMs: T0 },
      c,
      { nowMs: NOW },
    );
    assert.equal(o!.outcomeClass, "ambiguous");
  });
});

describe("computeOutcome — short side", () => {
  it("short win: TP below entry hit first", () => {
    const c = bars([
      [100, 102, 99, 100], // short from 100, SL 110, TP 90
      [100, 101, 89, 90], // TP 90 hit
    ]);
    const o = computeOutcome({ side: "short", stopLoss: 110, takeProfits: [90], createdMs: T0 }, c, { nowMs: NOW });
    assert.equal(o!.outcomeClass, "win");
    assert.equal(o!.firstHit, "tp");
  });
  it("short loss: SL above entry hit first, later drop excluded", () => {
    const c = bars([
      [100, 105, 99, 104], // SL 103 touched → loss
      [104, 106, 50, 55], // huge favorable drop AFTER stop — excluded
    ]);
    const o = computeOutcome({ side: "short", stopLoss: 103, takeProfits: [90], createdMs: T0 }, c, { nowMs: NOW });
    assert.equal(o!.outcomeClass, "loss");
    assert.ok((o!.maxR ?? 9) < 1, "post-stop favorable move excluded");
  });
});
