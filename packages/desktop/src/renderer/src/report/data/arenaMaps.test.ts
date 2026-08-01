import { describe, expect, test } from "vitest";

import { ARENA_MAPS, arenaMapUrl } from "./arenaMaps";

describe("arenaMapUrl(随包内置底图)", () => {
  test("每个有包围盒的竞技场都有对应底图", () => {
    // 底图 2026-08-01 从外部 CDN 改为入仓(docs/DATA-COMPLIANCE.md)。
    // 缺图不会报错、只会让回放少一层底 —— 所以在这里钉死一一对应。
    for (const zoneId of Object.keys(ARENA_MAPS)) {
      expect(arenaMapUrl(zoneId), `zoneId ${zoneId}`).toBeTruthy();
    }
  });

  test("未收录的 zoneId 返回 undefined,而不是拼出一个无效 URL", () => {
    // 调用方靠这个真值判断决定画不画 <image>。
    expect(arenaMapUrl("999999")).toBeUndefined();
  });

  test("底图是本地资源,不指向任何外部主机", () => {
    // 这条守的是别退回热链:Vite 资源 URL 是相对路径 / data URI,
    // 出现 http(s):// 即回归。
    for (const zoneId of Object.keys(ARENA_MAPS)) {
      expect(arenaMapUrl(zoneId)).not.toMatch(/^https?:\/\//);
    }
  });
});
