import {
  meterGroups,
  meterRows,
} from "../src/renderer/src/report/derive/meterRows";
import { deriveSummary } from "../src/renderer/src/report/derive/summary";
import {
  sideOfTeamId,
  sideOfUnit,
  teamSideByName,
  teamSidesByUnitId,
} from "../src/renderer/src/report/derive/teamSide";
import type { ReportSource } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

describe("敌我判定(单源)", () => {
  it("玩家按 teamId 分两边,与 playerTeamId 一致", () => {
    const sides = teamSidesByUnitId(m);
    const players = Object.values(m.units).filter(
      (u) => u.kind === "Player" && u.info,
    );
    expect(players.length).toBeGreaterThan(1);
    for (const u of players) {
      const expected = u.info!.teamId === m.playerTeamId ? "friendly" : "enemy";
      expect(sides.get(u.id), u.name).toBe(expected);
    }
    // HAS TEETH: both sides must actually occur, or "everyone is friendly"
    // would pass this test
    const vals = [...sides.values()];
    expect(vals).toContain("friendly");
    expect(vals).toContain("enemy");
  });

  it("宠物/图腾继承主人的阵营(事件表按名字标记要用)", () => {
    const all = Object.values(m.units);
    const pet = all.find((u) => u.ownerId && m.units[u.ownerId]?.info);
    expect(pet, "fixture 应含至少一个有主人的单位").toBeTruthy();
    expect(sideOfUnit(m, pet!.id)).toBe(sideOfUnit(m, pet!.ownerId!));
    expect(sideOfUnit(m, pet!.id)).not.toBe("unknown");
  });

  it("没有 playerTeamId(导入的旧日志)→ 一律 unknown,绝不猜", () => {
    const noSide = { ...m, playerTeamId: null } as unknown as ReportSource;
    const sides = teamSidesByUnitId(noSide);
    expect([...sides.values()].every((s) => s === "unknown")).toBe(true);
    expect(sideOfTeamId(noSide, 0)).toBe("unknown");
    // …and the leaderboard therefore does not split into teams
    const rows = meterRows(deriveSummary(noSide), "damage");
    const g = meterGroups(rows, (id) => sides.get(id) ?? "unknown");
    expect(g).toHaveLength(1);
    expect(g[0]!.side).toBe("unknown");
  });

  it("认不出的单位不给记号(而不是默认敌方)", () => {
    expect(sideOfUnit(m, "no-such-guid")).toBe("unknown");
  });

  it("名字表用短名,与各表格渲染的写法一致", () => {
    const byName = teamSideByName(m);
    for (const u of Object.values(m.units)) {
      if (u.kind !== "Player" || !u.info) continue;
      const short = u.name.split("-")[0]!;
      expect(byName.get(short), short).toBe(sideOfUnit(m, u.id));
      // The full name is deliberately NOT a key — every consumer shortens first
      if (u.name !== short) expect(byName.has(u.name)).toBe(false);
    }
  });
});

describe("榜单按队分组", () => {
  const rows = meterRows(deriveSummary(m), "damage");
  const sides = teamSidesByUnitId(m);
  const sideOf = (id: string) => sides.get(id) ?? "unknown";

  it("我方在前、敌方在后,组内保持原排名", () => {
    const g = meterGroups(rows, sideOf);
    expect(g.map((x) => x.side)).toEqual(["friendly", "enemy"]);
    for (const grp of g) {
      const vals = grp.rows.map((r) => r.value);
      expect(vals).toEqual([...vals].sort((a, b) => b - a));
    }
  });

  it("分组不吃行、不重复行", () => {
    const flat = meterGroups(rows, sideOf).flatMap((x) => x.rows);
    expect(flat).toHaveLength(rows.length);
    expect(new Set(flat.map((r) => r.unitId)).size).toBe(rows.length);
  });

  it("不传 sideOf → 保持原来的平铺顺序(忠实度检查走的就是这条路)", () => {
    const g = meterGroups(rows);
    expect(g).toHaveLength(1);
    expect(g[0]!.rows).toEqual(rows);
  });
});
