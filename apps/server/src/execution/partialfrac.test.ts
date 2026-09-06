import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultPartialFraction } from "./engine.js";

describe("defaultPartialFraction — a TP hit books one rung's slice (audit [32])", () => {
  it("single TP ⇒ 50% (never flatten the whole position on 'TP1 booked')", () => {
    assert.equal(defaultPartialFraction(1, 50), 0.5);
  });
  it("three TPs ⇒ 1/3", () => {
    assert.equal(defaultPartialFraction(3, 50), 1 / 3);
  });
  it("two TPs ⇒ 1/2; four ⇒ 1/4", () => {
    assert.equal(defaultPartialFraction(2, 50), 0.5);
    assert.equal(defaultPartialFraction(4, 50), 0.25);
  });
  it("no TPs ⇒ group default (clamped)", () => {
    assert.equal(defaultPartialFraction(0, 50), 0.5);
    assert.equal(defaultPartialFraction(0, 30), 0.3);
    assert.equal(defaultPartialFraction(0, 0), 0.01);
  });
});
