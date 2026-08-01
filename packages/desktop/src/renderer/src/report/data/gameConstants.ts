// 来源:暴雪官方 UI 色板与 specialization ID 公开文档;子项目 5 数据管线建成后由生成产物替换
import { SPEC_ICONS } from "@gladlog/analysis";

export const CLASS_COLORS: Record<number, string> = {
  1: "#C69B6D",
  2: "#F48CBA",
  3: "#AAD372",
  4: "#FFF468",
  5: "#FFFFFF",
  6: "#C41E3A",
  7: "#0070DD",
  8: "#3FC7EB",
  9: "#8788EE",
  10: "#00FF98",
  11: "#FF7C0A",
  12: "#A330C9",
  13: "#33937F",
};

export const CLASS_NAMES: Record<number, string> = {
  1: "Warrior",
  2: "Paladin",
  3: "Hunter",
  4: "Rogue",
  5: "Priest",
  6: "Death Knight",
  7: "Shaman",
  8: "Mage",
  9: "Warlock",
  10: "Monk",
  11: "Druid",
  12: "Demon Hunter",
  13: "Evoker",
};

export const SPEC_NAMES: Record<number, string> = {
  62: "Arcane Mage",
  63: "Fire Mage",
  64: "Frost Mage",
  65: "Holy Paladin",
  66: "Protection Paladin",
  70: "Retribution Paladin",
  71: "Arms Warrior",
  72: "Fury Warrior",
  73: "Protection Warrior",
  102: "Balance Druid",
  103: "Feral Druid",
  104: "Guardian Druid",
  105: "Restoration Druid",
  250: "Blood DK",
  251: "Frost DK",
  252: "Unholy DK",
  253: "Beast Mastery Hunter",
  254: "Marksmanship Hunter",
  255: "Survival Hunter",
  256: "Discipline Priest",
  257: "Holy Priest",
  258: "Shadow Priest",
  259: "Assassination Rogue",
  260: "Outlaw Rogue",
  261: "Subtlety Rogue",
  262: "Elemental Shaman",
  263: "Enhancement Shaman",
  264: "Restoration Shaman",
  265: "Affliction Warlock",
  266: "Demonology Warlock",
  267: "Destruction Warlock",
  268: "Brewmaster Monk",
  269: "Windwalker Monk",
  270: "Mistweaver Monk",
  577: "Havoc DH",
  581: "Vengeance DH",
  1480: "Devourer DH",
  1467: "Devastation Evoker",
  1468: "Preservation Evoker",
  1473: "Augmentation Evoker",
};

export function classColor(classId: number): string {
  return CLASS_COLORS[classId] || "#9d9d9d";
}

/** 2 字母职业字形(用于回放圆点/图例);classId 见暴雪 class ID。 */
export const CLASS_GLYPH: Record<number, string> = {
  1: "WA",
  2: "PA",
  3: "HU",
  4: "RO",
  5: "PR",
  6: "DK",
  7: "SH",
  8: "MG",
  9: "WL",
  10: "MK",
  11: "DR",
  12: "DH",
  13: "EV",
};

export function classGlyph(classId: number): string {
  return CLASS_GLYPH[classId] || "??";
}

export function className(classId: number): string {
  return CLASS_NAMES[classId] || "Unknown";
}

export function specName(specId: number): string {
  return SPEC_NAMES[specId] || "";
}

/**
 * specId → 图标基名(暴雪 ChrSpecialization.SpellIconFileID 解析所得,
 * 见 packages/analysis/scripts/datagen/genSpecIcons.ts)。
 *
 * 交给 <SpellIcon> 渲染 —— 走 main 进程 iconCache(永久磁盘缓存 + 会话预算),
 * 与技能图标同一条路。从前这里返回的是 images.wowarenalogs.com 的直链,
 * 那是第三方志愿者项目的 CDN,出货 App 每渲染一次对局列表就花他们一次带宽;
 * 已按 docs/DATA-COMPLIANCE.md 断开。未知 spec → null(调用方回退字形点)。
 */
export function specIconName(specId: number): string | null {
  return SPEC_ICONS[String(specId)] ?? null;
}
