import { test } from "node:test";
import assert from "node:assert/strict";
import type { Signal } from "@tttrading/shared";
import { describeStatus } from "./selfheal.js";

function sig(partial: Partial<Signal>): Signal {
  return {
    id: "s1",
    groupId: "g1",
    groupName: "Test",
    rawText: "",
    status: "ignored",
    receivedAt: "",
    updatedAt: "",
    ...partial,
  };
}

test("describeStatus: an executed entry reads as an opened trade and names the trade id", () => {
  const d = describeStatus(sig({ status: "executed", tradeId: "t42" }));
  assert.match(d, /OPENED/);
  assert.match(d, /t42/);
});

test("describeStatus: a managed message reads as management, not a new position", () => {
  const d = describeStatus(sig({ status: "managed" }));
  assert.match(d, /MANAGEMENT/);
  assert.doesNotMatch(d, /OPENED/);
});

test("describeStatus: an ignored message reads as no action", () => {
  assert.match(describeStatus(sig({ status: "ignored" })), /IGNORED/);
});

test("describeStatus: a blocked (shadow) message is not reported as executed", () => {
  const d = describeStatus(sig({ status: "blocked" }));
  assert.match(d, /BLOCKED|shadow/i);
  assert.doesNotMatch(d, /OPENED\/executed/);
});
