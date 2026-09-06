import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyManagementAll } from "./management.js";

const kinds = (t: string) => classifyManagementAll(t).map((a) => a.kind).sort();
const partial = (t: string) => classifyManagementAll(t).find((a) => a.kind === "partial_close");

describe("management classification — recap gain vs booking (audit [37]/[08])", () => {
  it("[37] celebratory 'securing an impressive 18.5% unleveraged gain' → NO partial, NO close", () => {
    const t = "The $TAO trade delivered a clean and powerful move, securing an impressive 18.5% unleveraged gain. ✅";
    assert.deepEqual(kinds(t), []);
  });
  it("[08] 'now Book 20% profit and move Stop-loss to 1.456' → partial 20% (+ sl_move)", () => {
    const t = "$ATOM delivered a 4.5% unleveraged gain. now Book 20% profit and move Stop-loss to 1.456 zone.";
    const p = partial(t);
    assert.ok(p, "expected a partial_close");
    assert.equal(p!.fraction, 0.2);
    assert.ok(kinds(t).includes("sl_move"));
  });
  it("a bare gain recap 'up 30% from entry' → no partial", () => {
    assert.deepEqual(kinds("$TAO is now up 30% from my entry, rewarding patience."), []);
  });
});

describe("management classification — TP booked → default-fraction partial (audit [32])", () => {
  it("[32] 'TP1 booked here. Holding the rest' → partial_close with NO explicit fraction", () => {
    const t = "📊 $TAO Trade Update. Price is now up 5.7% from our entry. TP1 booked here. Holding the rest with the same plan.";
    const p = partial(t);
    assert.ok(p, "expected a partial_close for a booked TP");
    assert.equal(p!.fraction, undefined); // engine fills the default by TP count
  });
  it("'first TP done' → default-fraction partial", () => {
    assert.ok(partial("first TP done ✅ locking it in"));
  });
  it("'booked TP1' (reversed order) → default-fraction partial", () => {
    assert.ok(partial("just booked TP1 on this one"));
  });
});
