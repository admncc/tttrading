import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapEntryToBand } from "./engine.js";

describe("snapEntryToBand — mis-scaled entry corrected against its own SL/TP band (audit #4)", () => {
  it("GOLD-class 10× slip: entry 446 with SL 4688 / TP 4340 → 4460", () => {
    // The real leg that was silently dropped by the would-chase guard.
    assert.equal(snapEntryToBand(446, 4688, [4340]), 4460);
  });
  it("10× high slip corrects downward too: entry 44600 vs SL 4688 → 4460", () => {
    assert.equal(snapEntryToBand(44600, 4688, [4340]), 4460);
  });
  it("leaves a genuine deep-bid limit alone (entry shares the band's magnitude)", () => {
    // long entry 18, SL 15, TP 30 while a real deep bid — ratio ~0.8, untouched.
    assert.equal(snapEntryToBand(18, 15, [30]), 18);
  });
  it("leaves an aggressive-but-in-range entry alone (within ~5×)", () => {
    assert.equal(snapEntryToBand(100, 90, [130]), 100);
  });
  it("no band ⇒ entry unchanged (nothing to compare against)", () => {
    assert.equal(snapEntryToBand(446, undefined, undefined), 446);
    assert.equal(snapEntryToBand(446, undefined, []), 446);
  });
  it("non-positive entry ⇒ unchanged", () => {
    assert.equal(snapEntryToBand(0, 4688, [4340]), 0);
  });
});
