import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketFeature, type SignalDatum } from "./buckets.js";

function mk(v: number | string, win: boolean | undefined, rR?: number): SignalDatum {
  return { win, rR, feats: { f: v } };
}

describe("bucketFeature", () => {
  it("categorical: one bucket per value, win-rate excludes non-scored", () => {
    const s = [mk("asia", true, 1), mk("asia", false, -1), mk("ny", true, 2), mk("ny", undefined, 0.3)];
    const r = bucketFeature(s, "f");
    assert.equal(r.kind, "categorical");
    const asia = r.buckets.find((b) => b.label === "asia")!;
    assert.equal(asia.n, 2);
    assert.equal(asia.wins, 1);
    assert.equal(asia.winRate, 0.5);
    const ny = r.buckets.find((b) => b.label === "ny")!;
    assert.equal(ny.n, 1); // the undefined-outcome row is not counted in n (scored)
  });

  it("numeric: splits into quantile buckets and computes expectancy", () => {
    const s: SignalDatum[] = [];
    for (let i = 0; i < 20; i++) s.push(mk(i, i % 2 === 0, i % 2 === 0 ? 1 : -1));
    const r = bucketFeature(s, "f");
    assert.equal(r.kind, "numeric");
    assert.ok(r.buckets.length >= 3);
    assert.equal(r.buckets.reduce((a, b) => a + b.n, 0), 20);
  });

  it("ignores signals where the feature is absent", () => {
    const s: SignalDatum[] = [{ win: true, feats: {} }, { win: false, feats: { f: "x" } }];
    const r = bucketFeature(s, "f");
    assert.equal(r.n, 1);
  });
});
