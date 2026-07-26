/**
 * Generated at: 2026-07-25T10:27:30.252Z
 * Build: 12.1.0.68629
 * Mined: 41707(宇宙=语料实证∪SpellCooldowns∪候选)
 * 数据在同名 .json(vite json.stringify → JSON.parse 装载,大 JSON 教训)。
 * .json 是字典编码 {names, ids}:41,707 个 entry 只有 ~7,110 个不同图标名,
 * 平铺 Record 有 48% 是重复字符串(1.5MB→780KB);此处展开回 Record,
 * 消费方 API 不变。
 */

import rawIcons from "./spellIconsGenerated.json";

const { names, ids } = rawIcons as unknown as {
  names: string[];
  ids: Record<string, number>;
};

const expanded: Record<string, string> = {};
for (const id in ids) expanded[id] = names[ids[id]!]!;

export const SPELL_ICONS_GENERATED: Record<string, string> = expanded;
