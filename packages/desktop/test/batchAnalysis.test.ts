// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Orchestration unit tests for the driver: input building / pack building are
// mocked to constants, so only the queue semantics are verified (skipping /
// serialization / deep-dive triggering / cancellation / per-round shuffle).
// The builders themselves have their own smoke test on a real fixture.
vi.mock("../src/renderer/src/report/derive/analysisInput", () => ({
  buildAnalysisInput: vi.fn((_source: unknown, matchId: string) => ({
    matchId,
    candidates: [{ id: "c1" }],
    richContext: "ctx",
    spec: "spec",
    ownerName: "me",
    enemySpecs: [],
  })),
  buildDeepenPacks: vi.fn(() => [{ findingIndex: 0 }]),
}));
vi.mock("@gladlog/analysis", () => ({
  ensureAnalysisData: async () => {},
}));

import {
  cancelBatch,
  getBatchStatus,
  startBatch,
  subscribeBatch,
} from "../src/renderer/src/batch/batchAnalysis";

type Calls = {
  run: string[];
  deepen: string[];
  cancel: Array<string | undefined>;
};

function stubBridge(opts: {
  cachedIds?: string[];
  failIds?: string[];
  rejectStateIds?: string[];
  docs: Record<string, { kind: string; data: unknown }>;
  onRun?: (matchId: string) => Promise<void> | void;
}): Calls {
  const calls: Calls = { run: [], deepen: [], cancel: [] };
  const done = new Set<string>(); // After a successful run, getCached can hit
  (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
    matches: {
      get: async (id: string) => opts.docs[id] ?? null,
    },
    analysis: {
      getState: async (matchId: string) => {
        if (opts.rejectStateIds?.includes(matchId)) throw new Error("ipc boom");
        return {
          cached: opts.cachedIds?.includes(matchId) ? { findings: [] } : null,
          running: false,
        };
      },
      run: async (input: { matchId: string }) => {
        calls.run.push(input.matchId);
        await opts.onRun?.(input.matchId);
        if (!opts.failIds?.includes(input.matchId)) done.add(input.matchId);
      },
      getCached: async (matchId: string) =>
        done.has(matchId)
          ? { findings: [{ severity: "high" }], hadNarration: true }
          : null,
      deepen: async (input: { matchId: string }) => {
        calls.deepen.push(input.matchId);
      },
      cancel: async (matchId?: string) => {
        calls.cancel.push(matchId);
      },
    },
  };
  return calls;
}

const src = { units: {} };

beforeEach(() => {
  // Singleton state leaks across tests: each test must wait for the previous
  // round to fully finish (startBatch has a `running` re-entrancy guard, so a
  // leftover `running` makes later tests silently no-op)
  expect(getBatchStatus().running).toBe(false);
});

describe("批量分析驱动器", () => {
  it("已缓存跳过、正常场跑 run+deepen、失败场计 failed(并发下顺序不定,比集合)", async () => {
    const calls = stubBridge({
      cachedIds: ["a"],
      failIds: ["c"],
      docs: {
        a: { kind: "match", data: src },
        b: { kind: "match", data: src },
        c: { kind: "match", data: src },
      },
    });
    await startBatch([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
    const st = getBatchStatus();
    expect([...calls.run].sort()).toEqual(["b", "c"]); // a is stopped by the cache predicate
    expect(calls.deepen).toEqual(["b"]); // No deep dive for a failed match
    expect({ ok: st.ok, skipped: st.skipped, failed: st.failed }).toEqual({
      ok: 1,
      skipped: 1,
      failed: 1,
    });
    expect(st.done).toBe(3);
    expect(st.running).toBe(false);
    expect(st.finishedAt).not.toBeNull();
  });

  it("shuffle 逐回合(round.id 为缓存键),整场计一次 ok", async () => {
    const calls = stubBridge({
      docs: {
        s1: {
          kind: "shuffle",
          data: {
            rounds: [
              { ...src, id: "r1" },
              { ...src, id: "r2" },
            ],
          },
        },
      },
    });
    await startBatch([{ id: "s1", label: "S1" }]);
    expect([...calls.run].sort()).toEqual(["r1", "r2"]);
    const st = getBatchStatus();
    expect(st.ok).toBe(1);
    expect(st.done).toBe(1);
  });

  it("并发池:三路同时在飞,第四场等有空位才起跑", async () => {
    let inFlightNow = 0;
    let maxInFlight = 0;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubBridge({
      docs: {
        a: { kind: "match", data: src },
        b: { kind: "match", data: src },
        c: { kind: "match", data: src },
        d: { kind: "match", data: src },
      },
      onRun: async () => {
        inFlightNow++;
        maxInFlight = Math.max(maxInFlight, inFlightNow);
        started++;
        if (started === 3) release(); // Release once all three are in flight (a serial implementation deadlocks here)
        await gate;
        inFlightNow--;
      },
    });
    await startBatch([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ]);
    expect(maxInFlight).toBe(3); // Exactly BATCH_CONCURRENCY, no more and no less
    expect([...calls.run].sort()).toEqual(["a", "b", "c", "d"]);
    const st = getBatchStatus();
    expect(st.ok).toBe(4);
    expect(st.done).toBe(4);
  });

  it("doc 拉不到 → failed,继续下一场", async () => {
    const calls = stubBridge({
      docs: { b: { kind: "match", data: src } },
    });
    await startBatch([
      { id: "gone", label: "G" },
      { id: "b", label: "B" },
    ]);
    expect(calls.run).toEqual(["b"]);
    const st = getBatchStatus();
    expect(st.failed).toBe(1);
    expect(st.ok).toBe(1);
  });

  it("取消:逐个定点 cancel 在飞单元(不无参全局取消),未起跑的场不再跑", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubBridge({
      docs: {
        a: { kind: "match", data: src },
        b: { kind: "match", data: src },
        c: { kind: "match", data: src },
        d: { kind: "match", data: src },
      },
      onRun: async () => {
        started++;
        if (started === 3) {
          // Cancel while all three are in flight: d must never get its turn
          cancelBatch();
          release();
        }
        await gate;
      },
    });
    await startBatch([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ]);
    // The matchId is mandatory: an argument-less global cancel would also
    // abort another analysis the user started by hand; under concurrency each
    // in-flight unit takes its own targeted cancel
    expect([...calls.cancel].sort()).toEqual(["a", "b", "c"]);
    expect(calls.cancel).not.toContain(undefined);
    expect([...calls.run].sort()).toEqual(["a", "b", "c"]); // d never started
    const st = getBatchStatus();
    expect(st.cancelled).toBe(true);
    expect(st.running).toBe(false);
  });

  it("IPC 意外 reject 只废该场,批次继续(agy F3)", async () => {
    const calls = stubBridge({
      rejectStateIds: ["a"],
      docs: {
        a: { kind: "match", data: src },
        b: { kind: "match", data: src },
      },
    });
    await startBatch([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    expect(calls.run).toEqual(["b"]);
    const st = getBatchStatus();
    expect(st.failed).toBe(1);
    expect(st.ok).toBe(1);
    expect(st.running).toBe(false);
  });

  it("跑批中订阅者能收到进度通知", async () => {
    stubBridge({ docs: { a: { kind: "match", data: src } } });
    const seen: number[] = [];
    const off = subscribeBatch(() => seen.push(getBatchStatus().done));
    await startBatch([{ id: "a", label: "A" }]);
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
