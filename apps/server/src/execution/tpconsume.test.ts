import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldConsumeTp, TP_CONSUME_BAND } from "./engine.js";

describe("shouldConsumeTp — swallow the native TP rung only when booked VERY close to it", () => {
  it("band is 1%", () => {
    assert.equal(TP_CONSUME_BAND, 0.01);
  });
  it("the real LTC case: booked 53.643 vs native TP1 53.95 (0.58%) → swallow", () => {
    assert.equal(shouldConsumeTp(53.643, 53.95), true);
  });
  it("booked far below the next TP (mid-position 'book some here') → keep the ladder", () => {
    assert.equal(shouldConsumeTp(53.0, 57.98), false); // ~8.6% away
  });
  it("well inside the band → swallow", () => {
    assert.equal(shouldConsumeTp(53.95 * 0.995, 53.95), true); // 0.5%
  });
  it("just inside the band (1%) → swallow; just outside → keep", () => {
    assert.equal(shouldConsumeTp(53.95 * (1 - TP_CONSUME_BAND * 0.9), 53.95), true);
    assert.equal(shouldConsumeTp(53.95 * (1 - TP_CONSUME_BAND * 2), 53.95), false); // 2%
  });
  it("TAO case: booked ~270 vs TP 273 (1.1%) → just OUTSIDE 1% band, not swallowed by proximity", () => {
    assert.equal(shouldConsumeTp(270, 273), false);
  });
  it("invalid inputs ⇒ never swallow", () => {
    assert.equal(shouldConsumeTp(0, 53.95), false);
    assert.equal(shouldConsumeTp(53.6, 0), false);
  });
});
