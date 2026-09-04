import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { namedNearestToVerb, KIND_VERB_RE } from "./engine.js";

describe("namedNearestToVerb — asymmetric multi-symbol management attribution", () => {
  // The real Trader Bamp message that stopped JASMY out at a loss instead of BE.
  const bamp =
    "Ok Gang we have had a beautiful day in the market with multiple wins and great profits so far. " +
    "Will also book Tp1 here in Zama up over 3% and Sl already breakeven. Going to set Sl breakeven on Jasmy, " +
    "should we return to entry I will re assess and look for another entry tomorrow.";
  const named = ["ZAMA", "JASMY"];

  it("attributes the partial (book Tp1) to ZAMA — the coin nearest the 'book' verb", () => {
    // This is what keeps a partial off JASMY; breakeven is applied to ALL named
    // coins separately (safe/idempotent), so JASMY still gets its SL→BE.
    assert.equal(namedNearestToVerb(bamp, KIND_VERB_RE.partial_close!, named), "ZAMA");
  });
  it("works on bare (untagged) coin names", () => {
    assert.equal(namedNearestToVerb("book 50% off Jasmy now", KIND_VERB_RE.partial_close!, named), "JASMY");
  });
  it("returns undefined when the verb isn't present", () => {
    assert.equal(namedNearestToVerb("no action here", KIND_VERB_RE.close!, named), undefined);
  });
});
