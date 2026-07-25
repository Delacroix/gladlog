/**
 * finding category 枚举单源(2026-07-25,agy 辩论定稿的独立任务落地)。
 *
 * category 此前是模型自由 string(buildFindingsPrompt 无约束),但它是
 * 错题本的跨场聚合键(StatsDashboard group by category)与 findingKey 的
 * 组成部分 —— 自由 string 随语言/措辞漂移会让聚合断裂(中文模式实测出过
 * SURVIVAL / 目标选择 两种形态)。修法:模型输出收敛到英文 slug 枚举,
 * 本地化只在渲染侧做;归一化在审计层确定性执行,词表外的原样保留
 * (不吞进 "other" —— 未知值合并会把不同的新形态互相踩掉)。
 */

export const FINDING_CATEGORIES = [
  "survival",
  "cooldowns",
  "positioning",
  "target-selection",
  "cc",
  "interrupts",
  "dispels",
  "offense",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

const CANON = new Set<string>(FINDING_CATEGORIES);

/** 同义/历史形态 → slug。键一律小写比对;覆盖:模型历史输出(SURVIVAL、
 * 目标选择)、常见英文近义、candidateFindings type 的域名近亲。 */
const ALIASES: Record<string, FindingCategory> = {
  // survival
  survivability: "survival",
  defense: "survival",
  defensives: "survival",
  生存: "survival",
  // cooldowns
  cd: "cooldowns",
  cooldown: "cooldowns",
  "cooldown-usage": "cooldowns",
  "cd-usage": "cooldowns",
  "cd-waste": "cooldowns",
  cds: "cooldowns",
  冷却: "cooldowns",
  // positioning
  position: "positioning",
  站位: "positioning",
  走位: "positioning",
  // target-selection
  "target selection": "target-selection",
  targeting: "target-selection",
  "target-priority": "target-selection",
  目标选择: "target-selection",
  // cc
  "cc-usage": "cc",
  "crowd control": "cc",
  "crowd-control": "cc",
  控制: "cc",
  // interrupts
  interrupt: "interrupts",
  kicks: "interrupts",
  打断: "interrupts",
  // dispels
  dispel: "dispels",
  cleanse: "dispels",
  purge: "dispels",
  驱散: "dispels",
  // offense
  offensive: "offense",
  damage: "offense",
  burst: "offense",
  进攻: "offense",
};

/** 确定性归一:枚举内原样;别名映射;其余 trim 后原样返回(未知形态保留,
 * 聚合虽不合并但也不互相污染)。 */
export function normalizeFindingCategory(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  if (CANON.has(lower)) return lower;
  return ALIASES[lower] ?? ALIASES[t] ?? t;
}
