import type {
  CandidateEvent,
  Finding,
  FindingCategory,
} from "@gladlog/analysis";
import { normalizeFindingCategory } from "@gladlog/analysis";

/**
 * finding/candidate 的渲染标签(P0-2):
 * - severity 是封闭枚举,渲染侧映射中文(EN 回复模式保持英文);
 *   category 是模型自由 string 且为错题本聚合键,不在渲染侧建词表
 *   (枚举化是独立任务,走 eval A/B)。
 * - 证据 chip 短标签与深挖 pack chips 同取法:优先技能名,否则事件类型。
 */

const SEV_ZH: Record<Finding["severity"], string> = {
  high: "高",
  med: "中",
  low: "低",
};

export const severityLabel = (
  sev: Finding["severity"],
  lang: "zh" | "en",
): string => (lang === "en" ? sev : (SEV_ZH[sev] ?? sev));

/** category slug(analysis 枚举单源)→ 中文类目。词表外(旧缓存自由词/
 * 模型抗命)先过 normalizeFindingCategory 归一,仍未知则原样显示。 */
const CATEGORY_ZH: Record<FindingCategory, string> = {
  survival: "生存",
  cooldowns: "冷却使用",
  positioning: "站位",
  "target-selection": "目标选择",
  cc: "控制",
  interrupts: "打断",
  dispels: "驱散",
  offense: "进攻",
};

export function categoryLabel(cat: string, lang: "zh" | "en"): string {
  const slug = normalizeFindingCategory(cat);
  if (lang === "en") return slug;
  return (CATEGORY_ZH as Record<string, string>)[slug] ?? cat;
}

/** candidateFindings.ts 的 type 全集(UI 兜底文案;新类型缺映射时回落原文)。 */
const TYPE_LABEL: Record<string, string> = {
  death: "死亡",
  "death-setup": "死亡铺垫",
  "cd-waste": "整场未用",
  "missed-cleanse": "漏解",
  "missed-purge": "漏偷",
  "cc-locked": "被控",
  "kick-eaten": "施法被断",
  "unconverted-burst": "爆发未转化",
  "burst-into-immunity": "打进免伤",
  "off-target-in-window": "窗口外目标",
  "juked-kick": "被骗打断",
  "dr-clipped-cc": "DR 冲突",
  "death-unused-defensive": "死亡时保命技可用",
  "external-unused": "外减可用未给",
  "wasted-trinket": "浪费饰品",
};

const MAX_LABEL = 12;

/** 证据 chip 短标签:技能名优先(日志语言),无技能落类型文案;超长截断
 * (完整文案由 chip 的 title 承载)。 */
export function candidateShortLabel(c: CandidateEvent): string {
  // 测试桩/旧数据的候选可能缺 type —— 空串兜底,别让整卡挂载抛
  const base = c.spell || TYPE_LABEL[c.type] || c.type || "";
  return base.length > MAX_LABEL ? `${base.slice(0, MAX_LABEL)}…` : base;
}
