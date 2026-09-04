import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nonNettingVenues } from "./engine.js";

const V = (name: string) => ({ ex: { name } });

describe("nonNettingVenues — opposing same-coin must never net onto one venue", () => {
  it("prefers a venue with no opposing leg", () => {
    const r = nonNettingVenues([V("hyperliquid"), V("aster")], new Set(["hyperliquid"]));
    assert.equal(r.wouldNet, false);
    assert.deepEqual(r.venues.map((v) => v.ex.name), ["aster"]);
  });
  it("no opposing anywhere ⇒ all candidates kept, not netting", () => {
    const r = nonNettingVenues([V("hyperliquid"), V("aster")], new Set());
    assert.equal(r.wouldNet, false);
    assert.equal(r.venues.length, 2);
  });
  it("only venue already holds the opposing leg ⇒ wouldNet (caller must skip)", () => {
    // The coin lists on Aster only and a long is open there → a short would net.
    const r = nonNettingVenues([V("aster")], new Set(["aster"]));
    assert.equal(r.wouldNet, true);
    assert.deepEqual(r.venues.map((v) => v.ex.name), ["aster"]); // unchanged; caller rejects
  });
  it("every listing venue is busy with an opposing leg ⇒ wouldNet", () => {
    const r = nonNettingVenues([V("hyperliquid"), V("aster")], new Set(["hyperliquid", "aster"]));
    assert.equal(r.wouldNet, true);
  });
});
