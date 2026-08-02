/**
 * Rule application (spec §4): deterministically match rules against a new
 * match's post-audit findings, with no AI call. The matching predicates are
 * single-source with patternScan (findingMatchesGroup / matchInCondition) —
 * "the pattern that was mined" and "the finding that gets badged" must be the
 * same decision.
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

/** Badge text: pure interpolation of stats, never touching a model. "committed N
 * times" is a statement of historical fact; it deliberately does not say "the
 * (N+1)th time" — that would be an assertion about the current match, which must
 * be guaranteed by the statistics rather than the rendering layer. */
export function habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string {
  const { windowMatches, hits } = rule.stats;
  return lang === "zh"
    ? `惯性问题 · 近 ${windowMatches} 场已犯 ${hits} 次`
    : `Recurring · ${hits} of last ${windowMatches} matches`;
}
