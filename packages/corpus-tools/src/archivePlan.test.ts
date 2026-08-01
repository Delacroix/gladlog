import { describe, expect, it } from "vitest";

import type { LedgerEntry } from "./archiveLedger";
import type { DetailedMatchStub } from "./feedClient";
import {
  driveDestFor,
  matchDateKey,
  MAX_CONSECUTIVE_FAILURES,
  MIN_DOWNLOAD_SLEEP_MS,
  parseThrottleEnv,
  reconcileStaging,
  shouldAbortAfterFailures,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagedIdsFrom,
  stagedMatchIdFrom,
  stagingPathFor,
  STOP_AFTER_KNOWN,
} from "./archivePlan";

function ledgerEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "m1",
    logObjectUrl: "https://storage.googleapis.com/x/m1",
    dateKey: "2026-08-01",
    bracket: "3v3",
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    playerTeamRating: 2100,
    team0MMR: 2090,
    team1MMR: 2110,
    playerTeamId: "0",
    winningTeamId: "1",
    durationInSeconds: 120,
    specs: [],
    bytes: 1,
    uploaded: false,
    ...over,
  };
}

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
  it("logObjectUrl 已知 → 不收(SS 6 轮共享同一对象但 id 各异)", () => {
    const s = stub({ id: "轮次2", logObjectUrl: "gs://shuffle-A" });
    expect(shouldArchive(s, new Set(), new Set(["gs://shuffle-A"]))).toBe(
      false,
    );
    // id 集合里没有它 —— 只按 id 去重就会把同一个 GCS 对象再下一遍
    expect(shouldArchive(s, new Set())).toBe(true);
  });
  it("logObjectUrl 为空串时不被空串集合误判为已知", () => {
    expect(
      shouldArchive(stub({ logObjectUrl: "" }), new Set(), new Set([""])),
    ).toBe(true);
  });
  it("本轮内把下过的 id/URL 加进集合后即不再重下 —— feed 翻页会让同一 stub 再现", () => {
    const s = stub({ id: "m9", logObjectUrl: "gs://m9" });
    const known = new Set<string>();
    const knownLogs = new Set<string>();
    expect(shouldArchive(s, known, knownLogs)).toBe(true);
    known.add(s.id);
    knownLogs.add(s.logObjectUrl);
    // 下一页开头原样再现的同一场
    expect(shouldArchive(s, known, knownLogs)).toBe(false);
  });
});

describe("暂存文件名 ↔ matchId", () => {
  it("反解 id", () => {
    expect(stagedMatchIdFrom("abc.txt.gz")).toBe("abc");
  });
  it("非暂存文件返回 null(index.jsonl / .DS_Store 不能被当成场次)", () => {
    expect(stagedMatchIdFrom("index.jsonl")).toBeNull();
    expect(stagedMatchIdFrom(".DS_Store")).toBeNull();
    expect(stagedMatchIdFrom(".txt.gz")).toBeNull();
  });
  it("与 stagingPathFor 同一后缀,可往返", () => {
    const p = stagingPathFor("/s", "2026-08-01", "abc");
    expect(stagedMatchIdFrom(p.split("/").pop()!)).toBe("abc");
  });
  it("stagedIdsFrom 只挑暂存文件", () => {
    expect([...stagedIdsFrom(["a.txt.gz", "index.jsonl", "b.txt.gz"])]).toEqual(
      ["a", "b"],
    );
  });
});

describe("reconcileStaging", () => {
  it("有账本条目且未上传 → 该传", () => {
    const plan = reconcileStaging(
      ["a.txt.gz"],
      [ledgerEntry({ id: "a", uploaded: false })],
    );
    expect(plan.toUpload.map((e) => e.id)).toEqual(["a"]);
    expect(plan.alreadyUploaded).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });
  it("账本已 uploaded:true 却还在本地 → 只删不重传(记账与删除之间被 kill)", () => {
    const plan = reconcileStaging(
      ["a.txt.gz"],
      [ledgerEntry({ id: "a", uploaded: true })],
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.alreadyUploaded).toEqual(["a"]);
  });
  it("盘上有文件但账本查无此条 → 孤儿(落盘与记账之间被 kill),不盲传", () => {
    const plan = reconcileStaging(["ghost.txt.gz"], []);
    expect(plan.orphans).toEqual(["ghost"]);
    expect(plan.toUpload).toEqual([]);
  });
  it("同 id 多条按最后一条判定 —— 分片是 append-only,先 false 后 true", () => {
    const plan = reconcileStaging(
      ["a.txt.gz"],
      [
        ledgerEntry({ id: "a", uploaded: false }),
        ledgerEntry({ id: "a", uploaded: true }),
      ],
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.alreadyUploaded).toEqual(["a"]);
  });
  it("index.jsonl 不算场次", () => {
    const plan = reconcileStaging(["index.jsonl"], []);
    expect(plan.orphans).toEqual([]);
    expect(plan.toUpload).toEqual([]);
  });
  it("账本里有、盘上没有的条目不该被传(已被删或从未落盘)", () => {
    const plan = reconcileStaging([], [ledgerEntry({ id: "a" })]);
    expect(plan.toUpload).toEqual([]);
  });
});

describe("parseThrottleEnv", () => {
  it("未设置 → 默认值", () => {
    expect(parseThrottleEnv(undefined, 2000, 250)).toEqual({
      value: 2000,
      usedFallback: false,
    });
  });
  it("空串 → 默认值(?? 拦不住空串,Number('') 是 0)", () => {
    expect(parseThrottleEnv("", 2000, 250).value).toBe(2000);
  });
  it("非数字 → 默认值(setTimeout(r, NaN) 等价 0ms,节流会静默消失)", () => {
    const r = parseThrottleEnv("2s", 2000, 250);
    expect(r.value).toBe(2000);
    expect(r.usedFallback).toBe(true);
  });
  it("0 与负数低于下限 → 默认值(硬约束:不得默认为 0)", () => {
    expect(parseThrottleEnv("0", 2000, 250).value).toBe(2000);
    expect(parseThrottleEnv("-1", 2000, 250).value).toBe(2000);
  });
  it("合法且不低于下限 → 采用", () => {
    expect(parseThrottleEnv("500", 2000, 250)).toEqual({
      value: 500,
      usedFallback: false,
    });
  });
  it("下载间隔下限是 250ms,不是 0", () => {
    expect(MIN_DOWNLOAD_SLEEP_MS).toBe(250);
    expect(parseThrottleEnv("100", 2000, MIN_DOWNLOAD_SLEEP_MS).value).toBe(
      2000,
    );
  });
});

describe("shouldAbortAfterFailures", () => {
  it("零星失败不中止 22 小时的首次全量", () => {
    expect(shouldAbortAfterFailures(1)).toBe(false);
    expect(shouldAbortAfterFailures(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
  });
  it("连续失败达阈值就停 —— 继续空转只是在敲对方的 GCS", () => {
    expect(shouldAbortAfterFailures(MAX_CONSECUTIVE_FAILURES)).toBe(true);
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
