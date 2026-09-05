import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldConsumeTp, TP_CONSUME_BAND } from "./engine.js";

describe("shouldConsumeTp — swallow the native TP rung only when booked VERY close to it", () => {
  it("the real LTC case: booked 53.643 vs native TP1 53.95 (0.58%) → swallow", () => {
    assert.equal(shouldConsumeTp(53.643, 53.95), true);
  });
  it("booked far below the next TP (mid-position 'book some here') → keep the ladder", () => {
    assert.equal(shouldConsumeTp(53.0, 57.98), false); // ~8.6% away
  });
  it("just inside the 1% band → swallow", () => {
    assert.equal(shouldConsumeTp(53.95 * 0.995, 53.95), true); // 0.5%
  });
  it("just outside the band → keep", () => {
    assert.equal(shouldConsumeTp(53.95 * (1 - TP_CONSUME_BAND * 2), 53.95), false); // 2%
  });
  it("works above the TP too (booked slightly through it)", () => {
    assert.equal(shouldConsumeTp(54.2, 53.95), true); // 0.46% above
  });
  it("invalid inputs ⇒ never swallow", () => {
    assert.equal(shouldConsumeTp(0, 53.95), false);
    assert.equal(shouldConsumeTp(53.6, 0), false);
  });
});
