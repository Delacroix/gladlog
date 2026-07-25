/**
 * DR(收益递减)分类表。
 * 2026-07-25 官方化:五大类(stun/incapacitate/disorient/silence/root)改由
 * DB2 SpellCategories.DiminishType 生成(drCategoriesGenerated,genDrCategories),
 * 键为**光环 id**,与战斗日志 SPELL_AURA_APPLIED 一致。迁移时官方数据抓出
 * 手工表 2 处错判(Mind Control 605 incap→disorient、Scatter Shot 213691
 * disorient→incap)与 5 个从未匹配过日志的施法 id 死条目(震荡波 46968 的
 * stun DR 因此一直失效,真光环 132168 ×512/30场 在官方集内)。
 * disarm/knockback 官方无 DiminishType 字段(缺口),保留手工。
 * DB2 已知怪癖(Cyclone 独立 DR、Incapacitating Roar 实为 disorient)由
 * drAnalysis 的 override 层垫后修正,勿在此处改。
 */
import { DR_CATEGORIES_GENERATED } from "./drCategoriesGenerated";

const cat = (ids: string[]): { spellId: string }[] =>
  ids.map((spellId) => ({ spellId }));

export const spellClassMap = {
  diminishingReturns: {
    ...Object.fromEntries(
      Object.entries(DR_CATEGORIES_GENERATED).map(([c, ids]) => [c, cat(ids)]),
    ),
    disarm: cat(["236077", "207777", "233759"]),
    knockback: cat(["51490", "132469", "108199"]),
  },
};
