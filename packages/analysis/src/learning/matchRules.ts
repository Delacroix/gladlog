/**
 * 规则应用(spec §4):新对局的审计后 findings 上确定性匹配规则,不调 AI。
 * 匹配谓词与 patternScan 同源(findingMatchesGroup / matchInCondition)——
 * 「筛出来的模式」与「打上徽章的 finding」必须是同一个判定。
 */
import type { CandidateEvent, Finding } from "../analysis/types";
import { findingMatchesGroup, matchInCondition } from "./patternScan";
import type { LearnedRule } from "./types";

export function ruleAppliesToFinding(
  rule: LearnedRule,
  finding: Pick<Finding, "category" | "eventIds">,
  candidates: CandidateEvent[],
  meta: { zoneId?: string; enemySpecs: number[] },
): boolean {
  if (rule.status !== "active") return false;
  if (!matchInCondition(meta, rule.condition)) return false;
  const byId = new Map(candidates.map((c) => [c.id, c.type]));
  const eventTypes = [
    ...new Set(
      (finding.eventIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is string => !!t),
    ),
  ];
  return findingMatchesGroup(
    { category: finding.category, severity: "", eventTypes },
    rule.category,
    rule.eventTypes,
  );
}

/** 徽章文本:纯 stats 插值,不经过任何模型。「已犯 N 次」是历史事实陈述,
 * 不写「第 N+1 次」—— 后者对本场是断言,须由统计而非渲染层保证。 */
export function habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string {
  const { windowMatches, hits } = rule.stats;
  return lang === "zh"
    ? `惯性问题 · 近 ${windowMatches} 场已犯 ${hits} 次`
    : `Recurring · ${hits} of last ${windowMatches} matches`;
}
