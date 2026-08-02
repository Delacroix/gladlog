import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type { GladMatch } from "@gladlog/parser";
import { MatchStore } from "../src/main/matchStore";

const dir = () => mkdtempSync(join(tmpdir(), "gl-devpanel-"));

function richMatch(id: string): GladMatch {
  return {
    kind: "match",
    id,
    bracket: "3v3",
    zoneId: "1825",
    startTime: 100_000,
    endTime: 245_000,
    playerId: "a",
    playerTeamId: 0,
    winningTeamId: 1,
    result: "loss",
    linesTotal: 3,
    linesDropped: 0,
    rawLines: ["l1", "l2"],
    hasAdvancedLogging: true,
    timezone: "UTC",
    units: {
      a: {
        kind: "Player",
        specId: 105,
        classId: 11,
        info: { teamId: 0, personalRating: 2400 },
      },
      c: {
        kind: "Player",
        specId: 64,
        classId: 8,
        info: { teamId: 1, personalRating: 2500 },
      },
    },
  } as unknown as GladMatch;
}

/** 富行字段被剥掉的「旧索引」状态,rebuild/reparse 的输入前提。 */
function stripRich(s: MatchStore, id: string): void {
  const index = (
    s as unknown as { index: Map<string, Record<string, unknown>> }
  ).index;
  const stripped = { ...index.get(id)! };
  delete stripped["durationS"];
  delete stripped["avgRating"];
  delete stripped["teams"];
  index.set(id, stripped);
}

describe("rebuildIndex 进度回调(开发者页行内进度替代 alert)", () => {
  it("逐场回报 i/n,末次 i === n", async () => {
    const s = new MatchStore(dir());
    for (const id of ["p1", "p2", "p3"]) s.store(richMatch(id));
    const seen: Array<{ i: number; n: number }> = [];

    const r = await s.rebuildIndex((p) => seen.push({ i: p.i, n: p.n }));

    expect(r.updated).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen.map((p) => p.i)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.n === 3)).toBe(true);
  });

  it("不传回调也照常跑完(既有调用点不受影响)", async () => {
    const s = new MatchStore(dir());
    s.store(richMatch("p1"));
    await expect(s.rebuildIndex()).resolves.toEqual({ updated: 1, failed: 0 });
  });

  it("跟车的第二次调用不重开循环,只等在飞的那次", async () => {
    const s = new MatchStore(dir());
    s.store(richMatch("p1"));
    let calls = 0;
    const a = s.rebuildIndex(() => calls++);
    const b = s.rebuildIndex(() => calls++);
    await Promise.all([a, b]);
    // 单飞:只有第一次的回调被喂,循环只跑一遍
    expect(calls).toBe(1);
  });
});

describe("reparse 单场(右栏「重新解析此对局」)", () => {
  it("重读 match.json 重提炼富行字段,只动这一场", async () => {
    const d = dir();
    const s = new MatchStore(d);
    s.store(richMatch("one"));
    s.store(richMatch("two"));
    stripRich(s, "one");
    stripRich(s, "two");

    const r = await s.reparse("one");

    expect(r.ok).toBe(true);
    expect(s.list().find((m) => m.id === "one")!.durationS).toBe(145);
    // 未点的那场保持原样 —— 单场操作不能顺手全库重建
    expect(s.list().find((m) => m.id === "two")!.durationS).toBeUndefined();
  });

  it("重提炼的结果写回 meta.json,不只是内存索引", async () => {
    const d = dir();
    const s = new MatchStore(d);
    s.store(richMatch("one"));
    stripRich(s, "one");
    await s.reparse("one");
    const onDisk = JSON.parse(
      readFileSync(join(d, "one", "meta.json"), "utf-8"),
    );
    expect(onDisk.durationS).toBe(145);
  });

  it("未知 id → ok:false,不抛", async () => {
    const s = new MatchStore(dir());
    await expect(s.reparse("nope")).resolves.toEqual({ ok: false });
  });
});

describe("dirOf(对局目录定位)", () => {
  it("已入库的 id 给出目录路径", () => {
    const d = dir();
    const s = new MatchStore(d);
    s.store(richMatch("one"));
    expect(s.dirOf("one")).toBe(join(d, "one"));
  });

  it("未入库的 id → null(不给外部构造任意路径的口子)", () => {
    const s = new MatchStore(dir());
    expect(s.dirOf("../../etc")).toBeNull();
  });
});
