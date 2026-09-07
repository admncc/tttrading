import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalSymbol, sameAsset, symbolAliases } from "./symbols.js";

test("metal aliases canonicalize to one ticker", () => {
  assert.equal(canonicalSymbol("XAU"), "GOLD");
  assert.equal(canonicalSymbol("XAG"), "SILVER");
  assert.equal(sameAsset("GOLD", "XAU"), true);
});

test("project name resolves to the exchange ticker (Pumpfun → PUMP)", () => {
  // The management miss: 'set SL breakeven on Pumpfun' must match the held PUMP
  // position. canonicalSymbol is case-insensitive (upper-cased internally).
  assert.equal(canonicalSymbol("PUMPFUN"), "PUMP");
  assert.equal(canonicalSymbol("pumpfun"), "PUMP");
  assert.equal(canonicalSymbol("PUMP.FUN"), "PUMP");
  assert.equal(sameAsset("PUMPFUN", "PUMP"), true);
  assert.ok(symbolAliases("PUMP").includes("PUMPFUN"));
});

test("an unknown ticker canonicalizes to itself", () => {
  assert.equal(canonicalSymbol("BTC"), "BTC");
  assert.equal(sameAsset("BTC", "ETH"), false);
});
