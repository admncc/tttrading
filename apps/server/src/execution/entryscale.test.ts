import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapEntryToStop } from "./engine.js";

describe("snapEntryToStop — mis-scaled entry corrected against its own STOP (audit #4)", () => {
  it("GOLD-class 10× slip: entry 446 with SL 4688 → 4460", () => {
    // The real leg that was silently dropped by the would-chase guard.
    assert.equal(snapEntryToStop(446, 4688), 4460);
  });
  it("10× high slip corrects downward too: entry 44600 vs SL 4688 → 4460", () => {
    assert.equal(snapEntryToStop(44600, 4688), 4460);
  });
  it("leaves a genuine deep-bid limit alone (entry shares the stop's magnitude)", () => {
    // long entry 18, SL 15 while a real deep bid — ratio 1.2, untouched.
    assert.equal(snapEntryToStop(18, 15), 18);
  });
  it("leaves an aggressive-but-in-range entry alone (within ~5×)", () => {
    assert.equal(snapEntryToStop(100, 90), 100);
  });

  // Regression: a far take-profit must NEVER drag the reference and snap a legit
  // entry a decade (the mean-of-band bug found in Round-3 review).
  it("a moonshot long is left alone: entry 10, SL 9 (TP 100 irrelevant) → 10", () => {
    assert.equal(snapEntryToStop(10, 9), 10);
  });
  it("entry 1, SL 0.9 (TPs 6/8/10) → 1 — not snapped up to 10", () => {
    assert.equal(snapEntryToStop(1, 0.9), 1);
  });
  it("a single mistyped TP can't move the entry: entry 100, SL 95 → 100", () => {
    assert.equal(snapEntryToStop(100, 95), 100);
  });

  it("no stop ⇒ entry unchanged (can't tell mis-scale from a moonshot)", () => {
    assert.equal(snapEntryToStop(446, undefined), 446);
    assert.equal(snapEntryToStop(1, undefined), 1); // was wrongly snapped to 10 via TP band
  });
  it("non-positive entry ⇒ unchanged", () => {
    assert.equal(snapEntryToStop(0, 4688), 0);
  });
});
