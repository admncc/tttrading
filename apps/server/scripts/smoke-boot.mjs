/**
 * Boot smoke-test: spawn the COMPILED server exactly as prod does
 * (`node dist/index.js`) and assert it reaches "listening" without crashing.
 * Catches the class of bug where the build compiles but the runtime can't
 * resolve a module (e.g. a value import from a types-only workspace package).
 *
 * Exits 0 on success, 1 on early crash / timeout. Uses a temp DB and an
 * off-band port so it never touches real state.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TIMEOUT_MS = 30_000;
const dir = mkdtempSync(path.join(tmpdir(), "tt-smoke-"));
const env = {
  ...process.env,
  DB_PATH: path.join(dir, "smoke.sqlite"),
  PORT: "4998",
  HOST: "127.0.0.1",
  TRADING_ENV: process.env.TRADING_ENV || "testnet",
  NODE_ENV: "production",
};

const child = spawn("node", ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
let done = false;

const finish = (code, msg) => {
  if (done) return;
  done = true;
  if (msg) console.error(msg);
  try { child.kill("SIGKILL"); } catch {}
  process.exit(code);
};

const onData = (buf) => {
  out += buf.toString();
  if (/Desk API listening/i.test(out)) {
    console.log("✓ smoke-boot: server reached 'listening' — boot OK");
    finish(0);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

child.on("exit", (code) => {
  if (!done) finish(1, `✗ smoke-boot: server exited (code ${code}) before listening.\n--- output ---\n${out.slice(-2000)}`);
});
child.on("error", (err) => finish(1, `✗ smoke-boot: failed to spawn: ${err.message}`));
setTimeout(() => finish(1, `✗ smoke-boot: timed out after ${TIMEOUT_MS}ms without 'listening'.\n--- output ---\n${out.slice(-2000)}`), TIMEOUT_MS);
