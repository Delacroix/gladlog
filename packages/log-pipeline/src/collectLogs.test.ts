import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDeferralWarnState,
  DEFERRAL_REMIND_EVERY,
  runCollection,
} from "./collectLogs";
import { buildSegmentKey } from "./protocol/segments";
import { MemoryStorageAdapter } from "./storage/MemoryStorageAdapter";

function cfg(dir: string) {
  return {
    storage: { provider: "localDir" as const, directory: "unused" },
    outputDir: dir,
    pollIntervalMs: 0,
    cleanup: false,
  };
}

describe("runCollection (overlap-aware, advance-by-actual)", () => {
  it("recovers dropped bytes when a longer re-flush overwrites a shorter segment's range", async () => {
    // Craft length-encoded keys directly to simulate a crash-window re-flush.
    const a = new MemoryStorageAdapter();
    const g = "abcd1234";
    // First flush wrote bytes [0,50); crash before checkpoint; re-flush wrote [0,120).
    await a.put(
      buildSegmentKey("pc", "L.txt", g, 0, 50),
      gzipSync(Buffer.alloc(50, 65)),
    ); // 'A'*50
    await a.put(
      buildSegmentKey("pc", "L.txt", g, 0, 120),
      gzipSync(Buffer.concat([Buffer.alloc(50, 65), Buffer.alloc(70, 66)])),
    ); // 'A'*50 + 'B'*70
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    const stats = await runCollection(cfg(dir), a);
    const outName = stats.filesUpdated[0];
    const out = readFileSync(join(dir, outName));
    expect(out.length).toBe(120); // no bytes lost, no stall
    expect(out.subarray(50).every((b) => b === 66)).toBe(true);
  });

  it("defers a partially-synced (truncated gzip) segment instead of appending garbage", async () => {
    const a = new MemoryStorageAdapter();
    const g = "abcd1234";
    const full = gzipSync(Buffer.alloc(40, 67)); // 'C'*40
    await a.put(
      buildSegmentKey("pc", "L.txt", g, 0, 40),
      full.subarray(0, full.length - 3),
    ); // truncated
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    const stats = await runCollection(cfg(dir), a);
    expect(stats.bytesAppended).toBe(0); // deferred, nothing applied
  });
});

// 2026-08-21: the collector sat on one Drive `dataless` placeholder for 27
// hours, writing the same two warning lines every 60s poll (53MB of log, zero
// information). Warnings must fire on first sight, stay quiet while nothing
// changes, remind periodically, and name the cause when the adapter knows it.
describe("runCollection deferral warnings", () => {
  afterEach(() => vi.restoreAllMocks());

  function truncated(bytes: number) {
    const full = gzipSync(Buffer.alloc(bytes, 67));
    return full.subarray(0, full.length - 3);
  }
  const deferrals = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.filter((c) => String(c[0]).includes("deferring"));
  const gaps = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.filter((c) => String(c[0]).includes("WARN") && String(c[0]).includes("gap at"));

  it("warns once per stuck segment across polls, not once per poll", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new MemoryStorageAdapter();
    await a.put(buildSegmentKey("pc", "L.txt", "abcd1234", 0, 40), truncated(40));
    // A later, healthy segment behind the stuck one → the real-world shape:
    // "deferring" followed by "gap at 0, next 40", both every poll.
    await a.put(
      buildSegmentKey("pc", "L.txt", "abcd1234", 40, 40),
      gzipSync(Buffer.alloc(40, 68)),
    );
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    const state = createDeferralWarnState();
    for (let i = 0; i < 5; i++) await runCollection(cfg(dir), a, state);
    expect(deferrals(warn)).toHaveLength(1);
    expect(gaps(warn)).toHaveLength(1);
  });

  it("reminds every DEFERRAL_REMIND_EVERY polls with how long it has been stuck", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new MemoryStorageAdapter();
    await a.put(buildSegmentKey("pc", "L.txt", "abcd1234", 0, 40), truncated(40));
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    const state = createDeferralWarnState();
    for (let i = 0; i < DEFERRAL_REMIND_EVERY + 1; i++)
      await runCollection(cfg(dir), a, state);
    const d = deferrals(warn);
    expect(d).toHaveLength(2);
    expect(String(d[1][0])).toMatch(/still stuck/);
    expect(String(d[1][0])).toMatch(new RegExp(`${DEFERRAL_REMIND_EVERY} polls`));
  });

  it("forgets a warning once the segment resolves, so a later stall warns again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = new MemoryStorageAdapter();
    const k = buildSegmentKey("pc", "L.txt", "abcd1234", 0, 40);
    await a.put(k, truncated(40));
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    const state = createDeferralWarnState();
    await runCollection(cfg(dir), a, state);
    await a.put(k, gzipSync(Buffer.alloc(40, 67))); // sync completes
    const ok = await runCollection(cfg(dir), a, state);
    expect(ok.bytesAppended).toBe(40);
    await a.put(k, truncated(40)); // same key degrades again (re-upload in flight)
    await a.delete(k);
    await a.put(buildSegmentKey("pc", "L.txt", "abcd1234", 40, 40), truncated(40));
    await runCollection(cfg(dir), a, state);
    expect(deferrals(warn)).toHaveLength(2);
  });

  it("appends the adapter's diagnosis when it can name the cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    class Diagnosing extends MemoryStorageAdapter {
      async diagnose(key: string): Promise<string | undefined> {
        return `cloud-only placeholder (dataless) at ${key}`;
      }
    }
    const a = new Diagnosing();
    await a.put(buildSegmentKey("pc", "L.txt", "abcd1234", 0, 40), truncated(40));
    const dir = mkdtempSync(join(tmpdir(), "collect-"));
    await runCollection(cfg(dir), a, createDeferralWarnState());
    const d = deferrals(warn);
    expect(d).toHaveLength(1);
    expect(String(d[0][0])).toMatch(/cloud-only placeholder \(dataless\)/);
  });
});
