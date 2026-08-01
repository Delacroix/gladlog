import { arenaObstacles } from "@gladlog/analysis";
import { describe, expect, test } from "vitest";

import { ARENA_MAPS, arenaMap, arenaPx, arenaToPx } from "./arenaMaps";

describe("arenaMaps", () => {
  test("不再导出任何底图 URL —— 回放地面表现全部来自自有数据", async () => {
    // 2026-08-01:先热链 wowarenalogs CDN、后一度随包内置的 minimap 底图都已删除。
    // 实测那些 PNG 里没有地图美术,只有与 arenaObstacles 逐个同位的方块 ——
    // 视觉收益为零,却要引入外部依赖或来源不明的二进制。见 docs/DATA-COMPLIANCE.md。
    // 这条守的是别把那层东西悄悄加回来。
    const mod = await import("./arenaMaps");
    expect(Object.keys(mod)).not.toContain("arenaMapUrl");
    expect(JSON.stringify(mod)).not.toMatch(/wowarenalogs|\.png/);
  });

  test("每个有底图包围盒的竞技场都有自有障碍物几何", () => {
    // 底图没了之后,障碍物是回放上唯一的地形参照 —— 缺了不会报错,只会让
    // 该竞技场看起来是个空框。
    for (const zoneId of Object.keys(ARENA_MAPS)) {
      expect(arenaObstacles[zoneId]?.length, `zone ${zoneId}`).toBeGreaterThan(
        0,
      );
    }
  });

  test("坐标换算:世界坐标 → 像素(x 轴翻转,y 向下)", () => {
    const m = arenaMap("1911")!;
    expect(m).toBeDefined();
    const { w, h } = arenaPx(m);
    // 包围盒的两个对角必须落在 [0,w]×[0,h] 的两端 —— 翻转方向写反会在这里露馅。
    expect(arenaToPx(m, m.maxX, m.minY)).toEqual({ x: 0, y: 0 });
    expect(arenaToPx(m, m.minX, m.maxY)).toEqual({ x: w, y: h });
  });
});
