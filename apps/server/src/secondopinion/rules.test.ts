import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { heuristicVerdict } from "./index.js";
import type { ParsedSignal, SecondOpinionTA, SecondOpinionTFrame } from "@tttrading/shared";

function parsed(side: "long" | "short"): ParsedSignal {
  return { symbol: "TEST", side, action: "open" } as unknown as ParsedSignal;
}
function frame(interval: string, trend: "up" | "down" | "sideways"): SecondOpinionTFrame {
  return { interval, trend, ema20: 0, ema50: 0, ema200: 0, atr: 1, support: 0, resistance: 0 };
}
function ta(over: Partial<SecondOpinionTA>): SecondOpinionTA {
  return {
    interval: "1h", price: 100, trend: "up",
    emaFast: 100, emaMid: 99, emaSlow: 98, atr: 1, atrPct: 0.01,
    support: 90, resistance: 110,
    frames: [frame("1h", "up"), frame("4h", "up")],
    ...over,
  };
}

describe("heuristicVerdict — SO-6 / 1.2 (horizon-ATR stop, no 1h false positive)", () => {
  it("5% swing-stop that is ~1.25× horizon-ATR does NOT flag stopTooWide (even at 5× 1h-ATR)", () => {
    const v = heuristicVerdict(parsed("long"), ta({ slAtrMultiple: 5, slAtrH: 1.25, atrHorizonTf: "4h" }));
    assert.ok(!v.redFlags.some((f) => /wide/i.test(f)), `no wide flag, got: ${v.redFlags.join(" | ")}`);
    assert.ok(v.strengths.some((s) => /horizon/i.test(s)), "credits a horizon-sized stop");
  });
  it("a genuinely oversized stop (>3.5× horizon-ATR) still flags stopTooWide", () => {
    const v = heuristicVerdict(parsed("long"), ta({ slAtrH: 5, atrHorizonTf: "4h" }));
    assert.ok(v.redFlags.some((f) => /wide/i.test(f)));
    assert.ok((v.contributions ?? []).some((c) => c.rule === "stopTooWide" && c.delta < 0));
  });
  it("a noise-tight stop (<0.7× horizon-ATR) flags stopTooTight", () => {
    const v = heuristicVerdict(parsed("long"), ta({ slAtrH: 0.4, atrHorizonTf: "4h" }));
    assert.ok((v.contributions ?? []).some((c) => c.rule === "stopTooTight"));
  });
});

describe("heuristicVerdict — 1.3 (breakout is not intoResistance)", () => {
  it("entry above resistance after trading through it is a breakout, not penalised", () => {
    const v = heuristicVerdict(parsed("long"), ta({ distToLevelAtrH: -0.6 }));
    assert.ok(!(v.contributions ?? []).some((c) => c.rule === "intoLevel"));
    assert.ok((v.contributions ?? []).some((c) => c.rule === "breakout" && c.delta > 0));
  });
  it("entry jammed just under resistance is penalised (little room)", () => {
    const v = heuristicVerdict(parsed("long"), ta({ distToLevelAtrH: 0.2 }));
    assert.ok((v.contributions ?? []).some((c) => c.rule === "intoLevel" && c.delta < 0));
  });
});

describe("heuristicVerdict — SO-9 (no blanket overbought penalty)", () => {
  it("RSI 85 while long WITH an uptrend is not penalised", () => {
    const v = heuristicVerdict(parsed("long"), ta({ trend: "up", rsi: 85 }));
    assert.ok(!(v.contributions ?? []).some((c) => c.rule === "fadingExtreme"));
  });
  it("RSI 85 while SHORT into an uptrend (fading a rip) IS penalised", () => {
    const v = heuristicVerdict(parsed("short"), ta({ trend: "up", rsi: 85, frames: [frame("1h", "up"), frame("4h", "up")] }));
    assert.ok((v.contributions ?? []).some((c) => c.rule === "fadingExtreme" && c.delta < 0));
  });
});

describe("heuristicVerdict — SO-7 (confluence needs ≥2 frames)", () => {
  it("a single computed frame does not award a trend bonus and flags mtfUnavailable", () => {
    const v = heuristicVerdict(parsed("long"), ta({ frames: [frame("1h", "up")] }));
    assert.ok(!(v.contributions ?? []).some((c) => c.rule === "tradeWithTrend"));
    assert.ok(v.redFlags.some((f) => /mtfUnavailable/i.test(f)));
  });
});

describe("heuristicVerdict — 1.4 (three zones + rule cap)", () => {
  it("a bland setup lands in the neutral zone (40–60)", () => {
    // sideways trend on both frames → tradeWithTrend nets ~0; nothing else set.
    const v = heuristicVerdict(parsed("long"), ta({ trend: "sideways", frames: [frame("1h", "sideways"), frame("4h", "sideways")] }));
    assert.equal(v.stance, "neutral");
    assert.ok(v.score >= 40 && v.score <= 60, `score ${v.score}`);
  });
  it("no single rule moves the score more than the cap", () => {
    // four aligned up-frames would be 4×6=24 for tradeWithTrend; ensure ≤ cap 25.
    const v = heuristicVerdict(
      parsed("long"),
      ta({ frames: [frame("15m", "up"), frame("1h", "up"), frame("4h", "up"), frame("1d", "up")] }),
    );
    for (const c of v.contributions ?? []) assert.ok(Math.abs(c.delta) <= 25, `${c.rule} = ${c.delta}`);
  });
  it("strong confluence + good geometry reaches the positive zone (>60)", () => {
    const v = heuristicVerdict(
      parsed("long"),
      ta({
        frames: [frame("15m", "up"), frame("1h", "up"), frame("4h", "up"), frame("1d", "up")],
        slAtrH: 1.5, atrHorizonTf: "4h", rrClaimed: 3, distToLevelAtrH: 2,
      }),
    );
    assert.equal(v.stance, "positive");
    assert.ok(v.score > 60);
  });
});
