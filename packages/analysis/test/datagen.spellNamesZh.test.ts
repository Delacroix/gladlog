import { describe, expect, test } from "vitest";
import { transformSpellNamesZh } from "../scripts/datagen/genSpellNamesZh";

describe("transformSpellNamesZh", () => {
  const csv =
    'ID,Name_lang\n740,宁静\n17,真言术:盾\n999,"Test Spell"\n25,昏迷\n';
  const iconIds = new Set(["740", "17", "999"]);
  const enMap: Record<string, string> = {
    "740": "Tranquility",
    "17": "Power Word: Shield",
    "999": "Test Spell",
    "25": "Stun",
  };

  test("仅收:有图标 且 zh 与 en 不同(真翻译)", () => {
    expect(transformSpellNamesZh(csv, iconIds, enMap)).toEqual({
      "740": "宁静",
      "17": "真言术:盾",
    });
    // 999:zh==en(wago 未翻译回落)→ 丢弃,运行时兜底链本来就落英文;
    // 25:无图标 → 丢弃(倒排索引也只收图标集,存了也没人查)。
  });
});
