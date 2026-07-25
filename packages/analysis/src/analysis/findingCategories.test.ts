import { describe, expect, it } from "vitest";

import {
  FINDING_CATEGORIES,
  normalizeFindingCategory,
} from "./findingCategories";

describe("findingCategories — category 枚举单源", () => {
  it("枚举内(含大小写变体)归一为 slug 本身", () => {
    for (const c of FINDING_CATEGORIES) {
      expect(normalizeFindingCategory(c)).toBe(c);
      expect(normalizeFindingCategory(c.toUpperCase())).toBe(c);
    }
  });

  it("历史自由词归一:SURVIVAL / 目标选择 / bottom 形态(2026-07 实测两形态)", () => {
    expect(normalizeFindingCategory("SURVIVAL")).toBe("survival");
    expect(normalizeFindingCategory("目标选择")).toBe("target-selection");
    expect(normalizeFindingCategory("COOLDOWNS")).toBe("cooldowns");
    expect(normalizeFindingCategory("Positioning")).toBe("positioning");
    expect(normalizeFindingCategory("cc-usage")).toBe("cc");
    expect(normalizeFindingCategory("dispel")).toBe("dispels");
  });

  it("词表外原样保留(未知形态不吞进 other,不互相污染)", () => {
    expect(normalizeFindingCategory("macro-usage")).toBe("macro-usage");
    expect(normalizeFindingCategory("  survival  ")).toBe("survival");
    expect(normalizeFindingCategory("")).toBe("");
  });
});
