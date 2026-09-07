import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExchangeConnector } from "./types.js";
import { connectorEnv, envRoutingWarning } from "./registry.js";

// connectorEnv reads only `.name`; a minimal stub is enough.
const ex = (name: string): ExchangeConnector => ({ name } as unknown as ExchangeConnector);

test("connectorEnv: a simulated fill is always paper, regardless of venue", () => {
  assert.equal(connectorEnv(ex("hyperliquid"), true), "paper");
  assert.equal(connectorEnv(ex("hyperliquid-testnet"), true), "paper");
  assert.equal(connectorEnv(ex("aster"), true), "paper");
});

test("connectorEnv: a real fill takes the venue's actual network", () => {
  // Only the dedicated testnet HL venue is testnet…
  assert.equal(connectorEnv(ex("hyperliquid-testnet"), false), "testnet");
  // …every real venue is mainnet (this is the mislabel the fix corrects: a real
  // mainnet fill must never be stamped from TRADING_ENV).
  assert.equal(connectorEnv(ex("hyperliquid"), false), "mainnet");
  assert.equal(connectorEnv(ex("aster"), false), "mainnet");
  assert.equal(connectorEnv(ex("mexc"), false), "mainnet");
});

test("envRoutingWarning: returns a string or undefined without throwing", () => {
  // Depends on runtime credentials/settings; just assert the contract holds so a
  // boot-time call can never crash the server (it's wrapped, but be defensive).
  const w = envRoutingWarning();
  assert.ok(w === undefined || typeof w === "string");
});
