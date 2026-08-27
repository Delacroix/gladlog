import { describe, expect, it } from "vitest";

import { DR_CATEGORIES_GENERATED } from "../src/data/drCategoriesGenerated";
import { DR_CATEGORY_MAP, drCategoryIds } from "../src/utils/drAnalysis";

// GH #33: the per-category id set must be the product's view (override layer
// applied), not the raw DB2 arrays — the two disagree on exactly these ids.
describe("drCategoryIds (GH #33 — inverse of DR_CATEGORY_MAP)", () => {
  it("applies the override layer: Cyclone is its own category, Incapacitating Roar is Disorient", () => {
    expect(DR_CATEGORIES_GENERATED.disorient).toContain("33786");
    expect(drCategoryIds("Disorient").has("33786")).toBe(false);
    expect(drCategoryIds("Cyclone")).toEqual(new Set(["33786"]));

    expect(DR_CATEGORIES_GENERATED.incapacitate).toContain("99");
    expect(drCategoryIds("Incapacitate").has("99")).toBe(false);
    expect(drCategoryIds("Disorient").has("99")).toBe(true);
  });

  it("is exactly the inverse of DR_CATEGORY_MAP", () => {
    for (const label of new Set(Object.values(DR_CATEGORY_MAP))) {
      const ids = drCategoryIds(label);
      for (const [id, cat] of Object.entries(DR_CATEGORY_MAP))
        expect(ids.has(id)).toBe(cat === label);
    }
  });
});
