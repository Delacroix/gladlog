import { arenaObstacles } from "@gladlog/analysis";
import { describe, expect, test } from "vitest";

import { ARENA_MAPS, arenaMap, arenaPx, arenaToPx } from "./arenaMaps";

describe("arenaMaps", () => {
  test("不再导出任何底图 URL —— 回放地面表现全部来自自有数据", async () => {
    // 2026-08-01: the minimap base images -- first hotlinked from the
    // wowarenalogs CDN, later briefly bundled with the app -- have all been
    // removed. Inspection showed those PNGs contain no map art at all, only
    // rectangles that sit exactly where arenaObstacles already are: zero visual
    // benefit in exchange for an external dependency or a binary of unclear
    // provenance. See docs/DATA-COMPLIANCE.md.
    // This test guards against quietly adding that layer back.
    const mod = await import("./arenaMaps");
    expect(Object.keys(mod)).not.toContain("arenaMapUrl");
    expect(JSON.stringify(mod)).not.toMatch(/wowarenalogs|\.png/);
  });

  test("每个有底图包围盒的竞技场都有自有障碍物几何", () => {
    // With the base image gone, obstacles are the only terrain reference in the
    // replay -- missing ones raise no error, they just make that arena look
    // like an empty box.
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
    // The bounding box's two opposite corners must land on the extremes of
    // [0,w]x[0,h] -- getting the flip direction backwards shows up right here.
    expect(arenaToPx(m, m.maxX, m.minY)).toEqual({ x: 0, y: 0 });
    expect(arenaToPx(m, m.minX, m.maxY)).toEqual({ x: w, y: h });
  });
});
