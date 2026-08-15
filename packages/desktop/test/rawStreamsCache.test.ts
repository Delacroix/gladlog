// @vitest-environment jsdom
/**
 * rawStreamsCache.ts (BACKLOG #26 Task 2 review, Important finding): the
 * module's own doc comment spends ~40 lines justifying its write-confinement
 * design (only prefetchRawStreams/ensureRawStreams write; readers never
 * trigger a fetch, to avoid a reader guessing the wrong storageId and
 * poisoning the cache before the correct write lands) — this file pins that
 * behavior with tests, not just prose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/src/bridge");

import { bridge } from "../src/renderer/src/bridge";
import {
  ensureRawStreams,
  getRawStreamsSync,
  prefetchRawStreams,
} from "../src/renderer/src/report/derive/rawStreamsCache";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

/** Minimal valid ReportSource — same shape legacySource.test.ts's fixture
 * uses (toLegacySafe only needs units/startTime, not a full real match). */
function source(id: string, startTime = 0): ReportSource {
  return {
    id,
    units: {},
    events: [],
    winningTeamId: 0,
    playerId: "p1",
    arenaId: "arena1",
    startTime,
    endTime: startTime + 100,
    duration: 100,
    bracket: "3v3",
  } as unknown as ReportSource;
}

const AVAILABLE = {
  available: true,
  manaSamples: [],
  castFailed: [
    { tSeconds: 1, unitGuid: "p1", spellId: 1, spellName: "x", reason: "y" },
  ],
};

beforeEach(() => {
  vi.mocked(bridge).mockReset();
});

describe("rawStreamsCache: getRawStreamsSync 冷读不触发 fetch", () => {
  it("从未 prefetch 过的 matchId → undefined,且 bridge().matches.getRawStreams 从未被调用", () => {
    const getRawStreams = vi.fn();
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    expect(getRawStreamsSync("never-fetched-id")).toBeUndefined();
    expect(getRawStreams).not.toHaveBeenCalled();
  });
});

describe("rawStreamsCache: 写一次(per source.id),第二次 prefetch 不重复 fetch", () => {
  it("同一 source.id 连续两次 prefetchRawStreams → 底层 getRawStreams 只调用一次", async () => {
    const getRawStreams = vi.fn().mockResolvedValue(AVAILABLE);
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    const s = source("m-once", 1000);
    prefetchRawStreams(s, "storage-once");
    prefetchRawStreams(s, "storage-once");
    await ensureRawStreams(s, "storage-once"); // drains both + this call
    expect(getRawStreams).toHaveBeenCalledTimes(1);
    expect(getRawStreamsSync("m-once")).toEqual(AVAILABLE);
  });
});

describe("rawStreamsCache: 第二写入者不能污染缓存(race-avoidance 契约)", () => {
  it("正确 storageId 的 prefetch 先起飞后,同一 source.id 上另一个(错误 storageId 的)调用必须复用同一次 fetch 的结果,不得触发第二次 IPC 调用", async () => {
    const getRawStreams = vi.fn().mockResolvedValue(AVAILABLE);
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    const s = source("m-race", 2000);
    // First writer: correct storageId (in flight, not yet resolved when the
    // second writer arrives — fetchRawStreams's `inFlight` map is what
    // guards this).
    const p1 = ensureRawStreams(s, "correct-storage-id");
    // Second writer: a WRONG storageId for the same source.id — this must
    // short-circuit to the same in-flight promise, never issue its own IPC
    // call with the wrong id (that call would 404 against a nonexistent
    // directory and, per the module's doc comment, could otherwise poison
    // the cache with a false available:false that the correct result would
    // never overwrite).
    const p2 = ensureRawStreams(s, "WRONG-storage-id");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(AVAILABLE);
    expect(r2).toEqual(AVAILABLE); // not UNAVAILABLE — proves it rode the first fetch
    expect(getRawStreams).toHaveBeenCalledTimes(1);
    expect(getRawStreams).toHaveBeenCalledWith("correct-storage-id", 2000);
  });

  it("已落地(非 in-flight)后,再次以任意 storageId 调用 → 直接命中缓存,零新 IPC 调用", async () => {
    const getRawStreams = vi.fn().mockResolvedValue(AVAILABLE);
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    const s = source("m-settled", 3000);
    await ensureRawStreams(s, "correct-storage-id");
    expect(getRawStreams).toHaveBeenCalledTimes(1);
    const again = await ensureRawStreams(s, "some-other-id-entirely");
    expect(again).toEqual(AVAILABLE);
    expect(getRawStreams).toHaveBeenCalledTimes(1); // still 1 — cache hit, no re-fetch
  });
});

describe("rawStreamsCache: 优雅降级(绝不 throw)", () => {
  it("bridge() 无 matches.getRawStreams(fixture/无预加载桥)→ available:false,不抛", async () => {
    vi.mocked(bridge).mockReturnValue({ matches: {} } as unknown as ReturnType<
      typeof bridge
    >);
    const s = source("m-nobridge", 0);
    const r = await ensureRawStreams(s, "m-nobridge");
    expect(r).toEqual({ available: false, manaSamples: [], castFailed: [] });
  });

  it("底层 getRawStreams reject → available:false,不抛出到调用方", async () => {
    const getRawStreams = vi.fn().mockRejectedValue(new Error("ipc boom"));
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    const s = source("m-reject", 0);
    await expect(ensureRawStreams(s, "m-reject")).resolves.toEqual({
      available: false,
      manaSamples: [],
      castFailed: [],
    });
  });

  it("bridge() 本身抛出(无 preload 上下文)→ available:false,不抛", async () => {
    vi.mocked(bridge).mockImplementation(() => {
      throw new Error("no window.gladlog");
    });
    const s = source("m-nowindow", 0);
    await expect(ensureRawStreams(s, "m-nowindow")).resolves.toEqual({
      available: false,
      manaSamples: [],
      castFailed: [],
    });
  });
});

describe("rawStreamsCache: baseMs 取该 source 自己的 startTime", () => {
  it("getRawStreams 被以 [storageId, source.startTime] 调用(每轮各自的时间基,不是别的轮的)", async () => {
    const getRawStreams = vi.fn().mockResolvedValue(AVAILABLE);
    vi.mocked(bridge).mockReturnValue({
      matches: { getRawStreams },
    } as unknown as ReturnType<typeof bridge>);
    const roundA = source("round-a", 111);
    const roundB = source("round-b", 222);
    await ensureRawStreams(roundA, "lobby-id");
    await ensureRawStreams(roundB, "lobby-id"); // same lobby storageId, different round
    expect(getRawStreams.mock.calls).toEqual([
      ["lobby-id", 111],
      ["lobby-id", 222],
    ]);
  });
});
