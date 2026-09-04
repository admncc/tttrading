import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWithRegex } from "./regex.js";

describe("extractSymbol — price-location fillers are not tickers (audit #9)", () => {
  for (const [text, expected] of [
    ["long AT 100 sl 90 tp 120", null], // "AT" was returned as the ticker
    ["buy ON dip 100 sl 90 tp 120", null], // "ON"
    ["short ZONE 200 sl 210 tp 180", null], // "ZONE"
    ["short at 4688 sl 4700 tp 4600", null], // "AT" again
  ] as const) {
    it(`${JSON.stringify(text)} → defers to LLM (no false ticker)`, () => {
      const r = parseWithRegex(text);
      assert.equal(r?.symbol ?? null, expected);
    });
  }

  for (const [text, sym] of [
    ["buy btc at 100 sl 90 tp 120", "BTC"],
    ["long ETH at 3000 sl 2900 tp 3200", "ETH"],
    ["sol long entry 100 sl 90 tp 120", "SOL"],
    ["long #BTC entry 100 sl 90 tp 120", "BTC"], // # cashtag in primary branch
    ["long $SOL entry 100 sl 90 tp 120", "SOL"],
  ] as const) {
    it(`${JSON.stringify(text)} → ${sym}`, () => {
      assert.equal(parseWithRegex(text)?.symbol, sym);
    });
  }
});
