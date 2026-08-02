import { getEnglishSpellName } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import { displaySpellName } from "../src/renderer/src/report/derive/spellDisplay";

// P2-1 single-source spell names in the render layer: the log name passes
// through, and only an empty one falls back to the dictionary. Regression
// anchor: CN logs used to be anglicized by getEnglishSpellName (measured on
// stress-cn-shuffle-r1: 1299 occurrences -> only 9 keeping the raw log text).
describe("displaySpellName", () => {
  it("日志名优先原样返回 —— CN 原名不被词典英文化", () => {
    expect(displaySpellName("642", "圣盾术")).toBe("圣盾术");
    expect(displaySpellName("", "近战")).toBe("近战");
  });

  it("日志名缺失(从未施放/只有 id)才落英文词典兜底,与 analysis 谓词同源", () => {
    expect(displaySpellName("642", "")).toBe(getEnglishSpellName("642", null));
    expect(displaySpellName("642", null)).toBe(
      getEnglishSpellName("642", null),
    );
    expect(displaySpellName("642", "")).not.toBe("");
  });

  it("词典也未收录时落 spellId(getEnglishSpellName 既有行为)", () => {
    expect(displaySpellName("999999999", undefined)).toBe("999999999");
  });
});
