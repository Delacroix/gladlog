// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// 驱动器的编排单测:输入构建/构包 mock 成常量,只验证队列语义
// (跳过/串行/深挖触发/取消/shuffle 逐回合)。构建器本身另有真 fixture 冒烟。
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
  const done = new Set<string>(); // run 成功后可被 getCached 命中
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
  // 单例状态跨用例残留:每个用例前必须等上一轮彻底结束(startBatch 有
  // running 防重入,残留 running 会让后续用例静默 no-op)
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
    expect([...calls.run].sort()).toEqual(["b", "c"]); // a 被缓存谓词拦下
    expect(calls.deepen).toEqual(["b"]); // 失败场不深挖
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
        if (started === 3) release(); // 三路齐飞后放行(串行实现会在这里死锁)
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
    expect(maxInFlight).toBe(3); // 上限恰为 BATCH_CONCURRENCY,不多不少
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
          // 三路都在飞时取消:d 必须再也轮不上
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
    // 必须带 matchId:无参全局 cancel 会把用户手动在跑的别场分析一并 abort;
    // 并发下每个在飞单元各吃一发定点 cancel
    expect([...calls.cancel].sort()).toEqual(["a", "b", "c"]);
    expect(calls.cancel).not.toContain(undefined);
    expect([...calls.run].sort()).toEqual(["a", "b", "c"]); // d 没起跑
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
