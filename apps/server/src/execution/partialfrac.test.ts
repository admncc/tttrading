import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultPartialFraction } from "./engine.js";

describe("defaultPartialFraction — book 1/(N+1) on a TP hit (audit [32])", () => {
  it("1 TP ⇒ 1/2 (never flatten the whole position on 'TP1 booked')", () => {
    assert.equal(defaultPartialFraction(1, 50), 0.5);
  });
  it("2 TPs ⇒ 1/3", () => {
    assert.equal(defaultPartialFraction(2, 50), 1 / 3);
  });
  it("3 TPs ⇒ 1/4", () => {
    assert.equal(defaultPartialFraction(3, 50), 0.25);
  });
  it("no TPs ⇒ group default (clamped)", () => {
    assert.equal(defaultPartialFraction(0, 50), 0.5);
    assert.equal(defaultPartialFraction(0, 30), 0.3);
    assert.equal(defaultPartialFraction(0, 0), 0.01);
  });
});
