import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandPerSymbol } from "./engine.js";

describe("expandPerSymbol — asymmetric per-coin management (audit #11)", () => {
  it("close X + partial Y: one close on X, one partial on Y, both explicit", () => {
    // "Closed BTC, booking 50% on ETH" — the flat schema lost the ETH partial.
    const acts = expandPerSymbol([
      { symbol: "BTC", closed: true },
      { symbol: "ETH", partialPercent: 50 },
    ]);
    assert.deepEqual(
      acts.map((a) => ({ kind: a.kind, symbol: a.symbol, fraction: a.fraction, explicit: a.explicitSymbol })),
      [
        { kind: "close", symbol: "BTC", fraction: undefined, explicit: true },
        { kind: "partial_close", symbol: "ETH", fraction: 0.5, explicit: true },
      ],
    );
  });

  it("close X + breakeven Y ('stopped SOL out, moved SUI to breakeven')", () => {
    const acts = expandPerSymbol([
      { symbol: "SOL", closed: true },
      { symbol: "SUI", breakeven: true },
    ]);
    assert.equal(acts.length, 2);
    assert.equal(acts[0]!.kind, "close");
    assert.equal(acts[0]!.symbol, "SOL");
    assert.equal(acts[1]!.kind, "sl_breakeven");
    assert.equal(acts[1]!.symbol, "SUI");
    assert.ok(acts.every((a) => a.explicitSymbol));
  });

  it("a coin with multiple actions expands to one action each", () => {
    const acts = expandPerSymbol([{ symbol: "ENA", partialPercent: 40, breakeven: true }]);
    assert.deepEqual(acts.map((a) => a.kind), ["partial_close", "sl_breakeven"]);
    assert.equal(acts[0]!.fraction, 0.4);
  });

  it("newStop becomes an explicit sl_move", () => {
    const acts = expandPerSymbol([{ symbol: "LINK", newStop: 12.5 }]);
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.kind, "sl_move");
    assert.equal(acts[0]!.newStop, 12.5);
    assert.equal(acts[0]!.symbol, "LINK");
  });

  it("a 100% partial IS a full close (not a no-op that would leave the position open)", () => {
    const acts = expandPerSymbol([{ symbol: "OP", partialPercent: 100 }]);
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.kind, "close");
    assert.equal(acts[0]!.symbol, "OP");
    assert.ok(acts[0]!.explicitSymbol);
  });
  it("a 0% partial is a no-op", () => {
    assert.deepEqual(expandPerSymbol([{ symbol: "OP", partialPercent: 0 }]), []);
  });
});
