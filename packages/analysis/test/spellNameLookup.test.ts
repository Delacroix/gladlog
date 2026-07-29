import { describe, expect, test } from "vitest";
import { ensureSpellNames } from "../src/data/spellEffectData";
import { englishNameIndex } from "../src/data/spellNameLookup";
import { SPELL_NAMES_ZH_GENERATED } from "../src/data/spellNamesZh";
import { OBSERVED_SPELL_IDS } from "../src/data/observedSpellIds";

describe("spellNameLookup", () => {
  test("英文名倒排:载入后可查,仅图标集,id 升序", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(idx).not.toBeNull();
    // 740 宁静:有图标、名字稳定
    expect(idx!.get("Tranquility")).toContain("740");
    // id 3 "Word of Mass Recall (OLD)" 在 spellNames 里但不在图标集 → 不入索引。
    // 注:brief 原例用 id 1 "Word of Recall (OLD)",但该 id 在语料 observed 集里
    // 出现过,被拉进图标生成宇宙,Blizzard DB2 给它分配了通用占位图标
    // trade_engineering(3213/41707 个 id 共享同一占位图标,老/已删除法术的
    // SpellIconFileDataID 常年指向这张默认图)——是真实数据而非生成脚本 bug,
    // 换成确认真正缺席图标集的 id 3。
    expect(idx!.get("Word of Mass Recall (OLD)")).toBeUndefined();
    for (const ids of idx!.values()) {
      const nums = ids.map(Number);
      expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    }
  });

  test("zh 表与 observed 集装载", () => {
    expect(SPELL_NAMES_ZH_GENERATED["740"]).toBe("宁静");
    expect(OBSERVED_SPELL_IDS.has("17")).toBe(true); // 真言术:盾,语料必有
  });
});
