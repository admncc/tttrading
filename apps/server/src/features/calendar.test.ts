import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nfpUtc, optionsExpiryUtc, isUsEasternDst, eventContext, setMacroEvents, loadMacroCalendarFromEnv } from "./calendar.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const iso = (ms: number) => new Date(ms).toISOString();

describe("calendar — rule-based dates (2.4)", () => {
  it("NFP is the first Friday of the month", () => {
    // Jan 2026: first Friday is Jan 2.
    const d = new Date(nfpUtc(2026, 0));
    assert.equal(d.getUTCDay(), 5); // Friday
    assert.equal(d.getUTCDate(), 2);
  });
  it("NFP time is 08:30 ET (13:30 UTC in winter/EST)", () => {
    // January → EST (UTC-5) → 13:30 UTC.
    assert.equal(iso(nfpUtc(2026, 0)).slice(11, 16), "13:30");
  });
  it("NFP time is 12:30 UTC in summer (EDT)", () => {
    // July → EDT (UTC-4) → 12:30 UTC.
    assert.equal(iso(nfpUtc(2026, 6)).slice(11, 16), "12:30");
  });
  it("options expiry is the last Friday, 08:00 UTC", () => {
    const d = new Date(optionsExpiryUtc(2026, 0));
    assert.equal(d.getUTCDay(), 5);
    assert.equal(iso(d.getTime()).slice(11, 16), "08:00");
    // last Friday of Jan 2026 is Jan 30
    assert.equal(d.getUTCDate(), 30);
  });
  it("US DST boundaries", () => {
    assert.equal(isUsEasternDst(new Date(Date.UTC(2026, 0, 15))), false); // Jan
    assert.equal(isUsEasternDst(new Date(Date.UTC(2026, 6, 15))), true); // Jul
  });
});

describe("eventContext (2.4)", () => {
  it("flags an event inside the window and reports hours to next", () => {
    // A moment 10h before an NFP → within a 24h window.
    const nfp = nfpUtc(2026, 2); // March
    const now = nfp - 10 * 3_600_000;
    const c = eventContext(now, 24 * 3_600_000);
    assert.equal(c.inWindow, true);
    assert.ok(c.hoursToNext !== undefined && Math.abs(c.hoursToNext - 10) < 0.2);
    assert.equal(c.nextKind, "nfp");
  });
  it("no event inside a short window far from any", () => {
    // mid-month, tiny 1h window — unlikely to hit a rule-based event
    const c = eventContext(Date.UTC(2026, 3, 15, 3, 0), 60 * 60_000);
    assert.equal(c.inWindow, false);
  });
  it("operator macro events merge in", () => {
    const now = Date.UTC(2026, 4, 1, 0, 0);
    setMacroEvents([{ kind: "fomc", iso: new Date(now + 5 * 3_600_000).toISOString() }]);
    const c = eventContext(now, 12 * 3_600_000);
    assert.equal(c.nextKind, "fomc");
    setMacroEvents([]); // reset so other tests are unaffected
  });
  it("loads the { events: [...] } template file shape (ignoring _README/_comment)", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const example = path.resolve(here, "../../../../docs/macro-calendar.example.json");
    process.env.MACRO_CALENDAR_FILE = example;
    const n = await loadMacroCalendarFromEnv();
    delete process.env.MACRO_CALENDAR_FILE;
    setMacroEvents([]); // reset
    assert.ok(n >= 1, `expected the example file to load >=1 event, got ${n}`);
  });
});
