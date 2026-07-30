import { describe, expect, test } from "vitest";
import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "./specNames";
import { SPEC_SLUGS } from "./gameConstants";

describe("specNames 一致性", () => {
  test("两表键集一致,specId 全部有图标 slug", () => {
    expect(Object.keys(SPEC_ID_BY_EN).sort()).toEqual(
      Object.keys(SPEC_NAMES_ZH).sort(),
    );
    for (const [en, id] of Object.entries(SPEC_ID_BY_EN)) {
      expect(SPEC_SLUGS[id], `${en} → ${id}`).toBeTruthy();
    }
  });
});
