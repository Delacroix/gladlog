import { describe, expect, test } from "vitest";
import { ensureSpellNames } from "../src/data/spellEffectData";
import { englishNameIndex } from "../src/data/spellNameLookup";
import { SPELL_NAME_STOPWORDS } from "../src/data/spellNameStopwords";
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

  test("超短名(<3 字符)不入索引 —— 实证 DB2 占位条目会撞车 AI 正文里的 30s/5s. 时长写法", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(idx!.get("s")).toBeUndefined();
  });

  test("停用词撞车实证:Stun/Death 不入索引(审计 Critical——常见英文词撞车 DB2 罕见法术名,被 inlineRich.tsx 兜底成随机图标)", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    // "Stun" 撞车 id 56/2880/17308/23454/34510,语料从未观测过任何一个,
    // 兜底会退到最小 id 56 → 通用锤子图标 inv_mace_02,AI 正文里 "full Stun"
    // 这类大白话被包成法术图标——本例是本次修复的直接触发 repro。
    expect(idx!.get("Stun")).toBeUndefined();
    // "Death"=id 327095 虽然在 OBSERVED_SPELL_IDS 里,但那是 Shadowlands
    // 盟约边角效果(图标 spell_necro_deathlyecho),不是任何职业教学向技能;
    // f79e90c 曾显式推迟此类、承诺停用词表出口,本文件是那个承诺的落地。
    expect(idx!.get("Death")).toBeUndefined();
    // 复核轮加判:"Heal" 47 个候选 id 全零观测,healer 教练产品里裸词
    // "Heal" 是这个 bug 类最可能的近期复现路径(批阅者独立复核标记 strong add)。
    expect(idx!.get("Heal")).toBeUndefined();
  });

  test("停用词表守卫(防未来 datagen 重跑复活):表里每个名字都必须真的从索引里消失,不是靠注释保证", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(SPELL_NAME_STOPWORDS.size).toBeGreaterThan(0);
    for (const name of SPELL_NAME_STOPWORDS) {
      expect(idx!.get(name)).toBeUndefined();
    }
  });

  test("反例护栏:'Charge' 是真实语料常用技能,不该被停用词表误伤", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(SPELL_NAME_STOPWORDS.has("Charge")).toBe(false);
    expect(idx!.get("Charge")).toBeDefined();
  });

  test("zh 表与 observed 集装载", () => {
    expect(SPELL_NAMES_ZH_GENERATED["740"]).toBe("宁静");
    expect(OBSERVED_SPELL_IDS.has("17")).toBe(true); // 真言术:盾,语料必有
  });
});
