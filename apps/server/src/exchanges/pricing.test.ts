import { test } from "node:test";
import assert from "node:assert/strict";
import {
  midDeviatesFromRef,
  notionalOffFraction,
  resolveSizingMid,
  MID_REF_MAX_DEVIATION,
} from "./pricing.js";

const noSleep = async () => {};

test("midDeviatesFromRef: within band is fine, gross gap flagged", () => {
  assert.equal(midDeviatesFromRef(0.55, 0.55105), false); // ~0.2% off
  assert.equal(midDeviatesFromRef(0.6, 0.55, 0.2), false); // ~9% off, under an explicit 20%
  assert.equal(midDeviatesFromRef(32.6, 0.55105), true); // the MNT bad tick (~5800%)
  // Default band is 0.5 (50%): a legitimate large drift from a stale entry passes,
  // only order-of-magnitude corruption is flagged.
  assert.equal(midDeviatesFromRef(0.4, 0.55), false); // ~27% off, under default 50%
  assert.equal(midDeviatesFromRef(0.25, 0.55), true); // ~55% off, over default 50%
});

test("midDeviatesFromRef: non-positive inputs never flag (nothing to compare)", () => {
  assert.equal(midDeviatesFromRef(0, 0.55), false);
  assert.equal(midDeviatesFromRef(0.55, 0), false);
});

test("resolveSizingMid: no reference price accepts the initial mid", async () => {
  const r = await resolveSizingMid(undefined, 32.6, async () => 0.55, { sleepFn: noSleep });
  assert.deepEqual(r, { mid: 32.6 });
});

test("resolveSizingMid: initial mid within band is accepted without re-reading", async () => {
  let reads = 0;
  const r = await resolveSizingMid(0.55105, 0.5512, async () => {
    reads++;
    return 0.55;
  }, { sleepFn: noSleep });
  assert.deepEqual(r, { mid: 0.5512 });
  assert.equal(reads, 0, "should not re-read when the first mid is sane");
});

test("resolveSizingMid: a transient bad tick self-heals on re-read", async () => {
  // First mid is the corrupt 32.6; the re-read returns the true ~0.55 → sized against it.
  const r = await resolveSizingMid(0.55105, 32.6, async () => 0.551, {
    sleepFn: noSleep,
  });
  assert.deepEqual(r, { mid: 0.551 });
});

test("resolveSizingMid: a persistent gross deviation fails closed", async () => {
  const r = await resolveSizingMid(0.55105, 32.6, async () => 32.7, {
    tries: 2,
    sleepFn: noSleep,
  });
  assert.ok("error" in r, "should not size against a persistently wrong price");
});

test("resolveSizingMid: unreadable re-reads fail closed", async () => {
  const r = await resolveSizingMid(0.55105, 32.6, async () => undefined, {
    tries: 2,
    sleepFn: noSleep,
  });
  assert.ok("error" in r);
});

test("notionalOffFraction: consistent order is ~0 off, mis-size is caught", () => {
  // Correct: 3629 MNT × 0.55105 ≈ 2000 → ~0 off.
  assert.ok((notionalOffFraction(3629, 0.55105, 2000) ?? 1) < 0.01);
  // The MNT bug: 61.3 MNT × 0.55105 ≈ 34 vs configured 2000 → ~98% off.
  const off = notionalOffFraction(61.3, 0.55105, 2000);
  assert.ok(off !== undefined && off > 0.9);
});

test("notionalOffFraction: non-positive inputs return undefined", () => {
  assert.equal(notionalOffFraction(0, 1, 2000), undefined);
  assert.equal(notionalOffFraction(10, 0, 2000), undefined);
  assert.equal(notionalOffFraction(10, 1, 0), undefined);
});

test("MID_REF_MAX_DEVIATION is a sane guard band", () => {
  assert.ok(MID_REF_MAX_DEVIATION > 0 && MID_REF_MAX_DEVIATION < 1);
});
