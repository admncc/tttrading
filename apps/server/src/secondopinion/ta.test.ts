import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rsi } from "./index.js";

describe("rsi — SO-4 (flat-window guard)", () => {
  it("14 identical closes ⇒ undefined (no RSI), not 99", () => {
    const flat = new Array(20).fill(100);
    assert.equal(rsi(flat, 14), undefined);
  });
  it("too few closes ⇒ undefined", () => {
    assert.equal(rsi([1, 2, 3], 14), undefined);
  });
  it("a genuine down-move ⇒ a low RSI number", () => {
    const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85];
    const v = rsi(closes, 14);
    assert.ok(typeof v === "number" && v < 20, `expected low RSI, got ${v}`);
  });
  it("a genuine up-move ⇒ a high RSI number", () => {
    const closes = [85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
    const v = rsi(closes, 14);
    assert.ok(typeof v === "number" && v > 80, `expected high RSI, got ${v}`);
  });
});
