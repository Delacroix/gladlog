import { describe, expect, it } from "vitest";

import {
  knownIdsFrom,
  latestById,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "./archiveLedger";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "m1",
    dateKey: "2026-08-01",
    bracket: "3v3",
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    playerTeamRating: 2100,
    team0MMR: 2090,
    team1MMR: 2110,
    playerTeamId: "0",
    winningTeamId: "1",
    durationInSeconds: 120,
    specs: ["105", "265"],
    bytes: 309855,
    uploaded: true,
    ...over,
  };
}

describe("recentDateKeys", () => {
  it("返回最近 N 天,含今天,新到旧", () => {
    const keys = recentDateKeys(Date.UTC(2026, 7, 3, 5, 0, 0), 3);
    expect(keys).toEqual(["2026-08-03", "2026-08-02", "2026-08-01"]);
  });
  it("默认窗口是 10 天 —— 比 feed 的 7 天留 3 天余量", () => {
    expect(LEDGER_WINDOW_DAYS).toBe(10);
    expect(
      recentDateKeys(Date.UTC(2026, 7, 3), LEDGER_WINDOW_DAYS),
    ).toHaveLength(10);
  });
  it("跨月边界正确", () => {
    expect(recentDateKeys(Date.UTC(2026, 8, 1), 2)).toEqual([
      "2026-09-01",
      "2026-08-31",
    ]);
  });
});

describe("分片路径", () => {
  it("一天一个 jsonl", () => {
    expect(ledgerShardPath("/l", "2026-08-01")).toBe("/l/2026-08-01.jsonl");
  });
});

describe("序列化", () => {
  it("一行一条,可往返", () => {
    const e = entry();
    expect(parseShard(serializeEntry(e))).toEqual([e]);
  });
  it("忽略空行与坏行,不让一行脏数据毁掉整个分片", () => {
    const text = `${serializeEntry(entry())}\n\n{不是json\n${serializeEntry(entry({ id: "m2" }))}\n`;
    expect(parseShard(text).map((e) => e.id)).toEqual(["m1", "m2"]);
  });
});

describe("knownIdsFrom", () => {
  it("只有 uploaded 为真的才算已归档 —— 上传失败的必须允许重下", () => {
    const ids = knownIdsFrom([
      entry({ id: "ok", uploaded: true }),
      entry({ id: "pending", uploaded: false }),
    ]);
    expect(ids.has("ok")).toBe(true);
    expect(ids.has("pending")).toBe(false);
  });
});

describe("latestById", () => {
  it("同一 id 后写的胜出 —— 分片是 append-only,同一场会先写 false 再写 true", () => {
    const out = latestById([
      entry({ id: "m1", uploaded: false }),
      entry({ id: "m1", uploaded: true }),
      entry({ id: "m2", uploaded: false }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.id === "m1")!.uploaded).toBe(true);
    expect(out.find((e) => e.id === "m2")!.uploaded).toBe(false);
  });
  it("保持首次出现的顺序,便于 index 稳定", () => {
    const out = latestById([
      entry({ id: "a" }),
      entry({ id: "b" }),
      entry({ id: "a" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("toIndexLine", () => {
  it("导出给 Drive 的 index 不带本地状态字段", () => {
    const line = JSON.parse(toIndexLine(entry()));
    expect(line.uploaded).toBeUndefined();
    expect(line.id).toBe("m1");
    expect(line.team0MMR).toBe(2090);
  });
});
