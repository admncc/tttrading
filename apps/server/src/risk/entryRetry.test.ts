import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNoCrossError, tierSlippage, ENTRY_RETRY_SLIPPAGE } from "./score.js";

describe("isNoCrossError — only the IOC-didn't-cross rejection is retryable (SKR class)", () => {
  it("matches Hyperliquid's no-resting-liquidity message", () => {
    assert.equal(isNoCrossError("Order 0 failed: Order could not immediately match against any resting orders. asset=227"), true);
  });
  it("does NOT match real errors that must not be retried", () => {
    assert.equal(isNoCrossError("Insufficient margin to place order"), false);
    assert.equal(isNoCrossError("Order value 3.20 below Hyperliquid's $10 minimum"), false);
    assert.equal(isNoCrossError(undefined), false);
    assert.equal(isNoCrossError(""), false);
  });
});

describe("entry tier slippage — scaled to liquidity (small widest, large tightest)", () => {
  it("small caps get the widest bound (0.5%) so a wide-spread IOC can cross", () => {
    assert.equal(tierSlippage("SKR"), 0.005); // unknown → small tier
  });
  it("large caps get the tightest bound (0.1%)", () => {
    assert.equal(tierSlippage("BTC"), 0.001);
    assert.equal(tierSlippage("ETH"), 0.001);
  });
});

describe("entry retry gating — retry only when the tier bound is below the ceiling", () => {
  it("a small cap already sits at the 0.5% ceiling → NOT retried wider", () => {
    assert.ok(!(tierSlippage("SKR") < ENTRY_RETRY_SLIPPAGE));
  });
  it("large/mid caps sit below the ceiling → eligible to widen once on a no-cross", () => {
    assert.ok(tierSlippage("BTC") < ENTRY_RETRY_SLIPPAGE); // 0.1% < 0.5%
  });
});
