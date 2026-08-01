import { describe, expect, it } from "vitest";

import type { DetailedMatchStub } from "./feedClient";
import {
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
  STOP_AFTER_KNOWN,
} from "./archivePlan";

function stub(over: Partial<DetailedMatchStub> = {}): DetailedMatchStub {
  return {
    typename: "ArenaMatchDataStub",
    id: "m1",
    logObjectUrl: "https://storage.googleapis.com/x/m1",
    playerId: "Player-1",
    hasAdvancedLogging: true,
    durationInSeconds: 120,
    bracket: "3v3",
    units: [],
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    result: 1,
    playerTeamRating: 2100,
    winningTeamId: "0",
    playerTeamId: "0",
    team0MMR: 2100,
    team1MMR: 2100,
    ...over,
  };
}

describe("matchDateKey", () => {
  it("按 UTC 归日,不受本机时区影响", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe("2026-08-01");
  });
  it("UTC 零点边界:23:59 与 00:01 分属两天", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
    expect(matchDateKey(Date.UTC(2026, 7, 2, 0, 0, 1))).toBe("2026-08-02");
  });
  it("月末跨月", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 31, 23, 59, 0))).toBe("2026-08-31");
  });
});

describe("shouldArchive", () => {
  it("新场次且有 advanced logging → 收", () => {
    expect(shouldArchive(stub(), new Set())).toBe(true);
  });
  it("已在账本里 → 不收", () => {
    expect(shouldArchive(stub({ id: "m1" }), new Set(["m1"]))).toBe(false);
  });
  it("没有 advanced logging → 不收(用户拍板跳过)", () => {
    expect(shouldArchive(stub({ hasAdvancedLogging: false }), new Set())).toBe(
      false,
    );
  });
  it("startTime 为 0(元数据损坏)→ 不收,否则会归到 1970 目录", () => {
    expect(shouldArchive(stub({ startTime: 0 }), new Set())).toBe(false);
  });
});

describe("shouldStopScanning", () => {
  it("连续已知未达阈值时继续扫", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN - 1)).toBe(false);
  });
  it("达到阈值才停 —— 防 feed 零星乱序导致的静默漏采", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN)).toBe(true);
  });
  it("阈值是 200(4 页),不是 1", () => {
    expect(STOP_AFTER_KNOWN).toBe(200);
    expect(shouldStopScanning(1)).toBe(false);
  });
});

describe("路径", () => {
  it("暂存路径按日期分目录,文件名是 matchId.txt.gz", () => {
    expect(stagingPathFor("/s", "2026-08-01", "abc")).toBe(
      "/s/2026-08-01/abc.txt.gz",
    );
  });
  it("Drive 目标是 YYYY/MM/DD", () => {
    expect(driveDestFor("2026-08-01")).toBe("2026/08/01");
  });
});

describe("shouldFlushBatch", () => {
  it("满 200 场即冲刷", () => {
    expect(shouldFlushBatch({ count: 200, bytes: 1 })).toBe(true);
  });
  it("满 500MB 即冲刷(场数未满也要)", () => {
    expect(shouldFlushBatch({ count: 3, bytes: 500 * 1024 * 1024 })).toBe(true);
  });
  it("两者都未满则继续攒", () => {
    expect(shouldFlushBatch({ count: 199, bytes: 1024 })).toBe(false);
  });
});
