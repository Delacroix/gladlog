import { describe, expect, test } from "vitest";
import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "./specNames";
import { specIconName } from "./gameConstants";

describe("specNames 一致性", () => {
  test("两表键集一致,specId 全部有图标", () => {
    expect(Object.keys(SPEC_ID_BY_EN).sort()).toEqual(
      Object.keys(SPEC_NAMES_ZH).sort(),
    );
    // 图标来源已从外部 CDN slug 改为暴雪 DB2 生成的图标基名
    // (specIconsGenerated);这条守的仍是「每个可命名专精都有图标」。
    for (const [en, id] of Object.entries(SPEC_ID_BY_EN)) {
      expect(specIconName(id), `${en} → ${id}`).toBeTruthy();
    }
  });
});
