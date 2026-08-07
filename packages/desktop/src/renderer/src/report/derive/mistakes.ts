import {
  analyzeKickAudit,
  annotateMissedPurgesWithKillWindows,
  computeOffensiveWindows,
  extractCandidateFindings,
  reconstructDispelSummary,
  type CandidateEvent,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import { tInRange, type TimeRange } from "./timeRange";
import type { ReportSource } from "./types";

/**
 * Deterministic mistake engine (phase 4 ③ / backlog #8, the WoWAnalyzer
 * suggestions pattern): rules are enumerable data objects (three severity
 * tiers) that consume only analysis's existing deterministic predicates
 * (candidateFindings / kickAudit / dispelSummary) and go straight to the UI
 * without an LLM.
 * Anti-rot: when upstream candidateFindings adds a new type, it must be
 * declared in either MISTAKE_RULES or IGNORED_CANDIDATE_TYPES — see the
 * inventory test in report.mistakes.test.
 */

export type MistakeSeverity = "minor" | "average" | "major";

export interface MistakeRule {
  type: string;
  label: string;
  severity: MistakeSeverity;
  source: "candidate" | "kick" | "dispel";
}

export const MISTAKE_RULES: readonly MistakeRule[] = [
  // Of candidateFindings' five DPS-owner types, juked-kick is instead supplied
  // directly by kickAudit (the candidate version only covers DPS owners, so a
  // healer's kicks would be missed) — deliberately not taken here, to avoid
  // double counting.
  {
    type: "burst-into-immunity",
    label: "爆发打进免疫",
    severity: "major",
    source: "candidate",
  },
  {
    type: "off-target-in-window",
    label: "击杀窗口内伤害脱靶",
    severity: "average",
    source: "candidate",
  },
  {
    type: "dr-clipped-cc",
    label: "CC 打在递减上",
    severity: "average",
    source: "candidate",
  },
  {
    type: "unconverted-burst",
    label: "爆发未转化",
    severity: "minor",
    source: "candidate",
  },
  {
    type: "cd-waste",
    label: "保命 CD 整场未用",
    severity: "minor",
    source: "candidate",
  },
  {
    type: "juked-kick",
    label: "被假读条骗掉打断",
    severity: "average",
    source: "kick",
  },
  {
    type: "missed-kick",
    label: "打断空放",
    severity: "minor",
    source: "kick",
  },
  {
    type: "missed-purge-kill-window",
    label: "击杀窗口内漏 purge",
    severity: "major",
    source: "dispel",
  },
  {
    type: "death-unused-defensive",
    label: "死亡时保命技可用未按",
    severity: "major",
    source: "candidate",
  },
  {
    type: "external-unused",
    label: "队友阵亡时外减可用未给",
    severity: "major",
    source: "candidate",
  },
  {
    type: "wasted-trinket",
    label: "中立局面浪费饰品",
    severity: "major",
    source: "candidate",
  },
  {
    type: "questionable-external",
    label: "无压力窗口交出外减",
    severity: "average",
    source: "candidate",
  },
  // Signal-expansion batch 1 (2026-08-06, BACKLOG #18 second batch).
  {
    type: "healing-gap",
    label: "治疗空窗",
    severity: "average",
    source: "candidate",
  },
  {
    type: "position-mistake",
    label: "走位失误",
    severity: "average",
    source: "candidate",
  },
  {
    // Opportunity-cost framing, same tier as cd-waste (never-used defensive):
    // a control major sitting available is a fact about uptime, not a proven
    // damage consequence — see the no-causation guard on this type's prompt
    // legend (buildFindingsPrompt.ts).
    type: "cc-held",
    label: "压手未放",
    severity: "minor",
    source: "candidate",
  },
  {
    // DEFENSIVE-001 (2026-08-07, BACKLOG #18 second batch): a healer ate a
    // hard CC with a non-trinket avoidance tool evidenced-and-available
    // beforehand. Same opportunity-cost framing as cc-held (a fact about kit
    // availability, not a proven "this would have saved you" claim — see the
    // no-causation guard on this type's prompt legend, buildFindingsPrompt.ts).
    type: "cc-avoidable",
    label: "规避手段可用未用",
    severity: "minor",
    source: "candidate",
  },
] as const;

/** Types candidateFindings produces that are deliberately NOT mistakes (a death
 * is an outcome, not a mistake; death-setup is narrative-chain evidence that
 * goes into the AI pipeline but not the mistake list; juked-kick goes through
 * kickAudit).
 * The four 2026-07-24 teamwork types: missed-cleanse/missed-purge are supplied
 * directly by dispelSummary (the missed-cleanse / missed-purge rows of
 * DispelDashboard; the candidate version would double count); cc-locked and
 * kick-eaten are "things that happened TO you" — coachable, but not assertions
 * of a mistake, so they go into the AI pipeline but not the mistake list. */
export const IGNORED_CANDIDATE_TYPES: ReadonlySet<string> = new Set([
  "death",
  "death-setup",
  "juked-kick",
  "missed-cleanse",
  "missed-purge",
  "cc-locked",
  "kick-eaten",
]);

export interface Mistake {
  tS: number;
  unitName: string;
  type: string;
  label: string;
  severity: MistakeSeverity;
  detail: string;
  /** ▶ Units the replay camera should focus on when jumping. */
  seekNames: string[];
  /**
   * Whether tS is a real time anchor (rather than the sentinel of a
   * "whole-round observation"). The only fake anchor today is cd-waste
   * (`candidateFindings.ts`: `t: 0, // whole-round observation, not
   * time-specific`) — it has no `facts.t`. StructuredAnalysisPanel's
   * splitFindings distinguishes "whole round" from "has a moment" with the same
   * predicate (`facts.t !== undefined`); this mirrors that judgement rather
   * than starting a second one. The kick/dispel sources are always real moments
   * (a missed interrupt or dispel happens at a specific instant), hence always
   * true.
   *
   * Consumers (e.g. the sliding-window dedup of uncovered highlights, BACKLOG
   * #13) filter the anchor set on this — whole-round observations have no
   * specific moment and must not be treated as "covering a time span", or the
   * opening window gets falsely marked covered (cd-waste's t=0 falls exactly
   * inside the tolerance of the sliding window's first window).
   */
  timed: boolean;
}

const RULE_BY_TYPE = new Map(MISTAKE_RULES.map((r) => [r.type, r]));

function candidateDetail(c: CandidateEvent): string {
  const f = c.facts as Record<string, string | undefined>;
  switch (c.type) {
    case "burst-into-immunity":
      return `${f.spell ?? ""} 打进 ${f.target ?? ""} 的 ${f.immunity ?? ""}(重叠 ${f.overlap ?? "?"}s)`;
    case "off-target-in-window":
      return `窗口目标 ${f.target ?? ""},命中仅 ${f.onTargetPct ?? "?"}%${f.offTarget ? `(最大分流 ${f.offTarget})` : ""}`;
    case "dr-clipped-cc":
      return `${f.spell ?? ""} 打在 ${f.target ?? ""} 的 ${f.dr ?? ""} 递减上(仅 ${f.duration ?? "?"}s)`;
    case "unconverted-burst":
      return `${f.spell ?? ""} 对 ${f.target ?? ""} 打出 ${f.damageM ?? "?"}M 未转化(${f.hpStart ?? "?"}%→${f.hpEnd ?? "?"}%)`;
    case "cd-waste":
      return `${f.spell ?? ""} 整场未按`;
    case "death-unused-defensive":
      return `死亡时 ${f.walls ?? ""} 可用未按`;
    case "external-unused":
      return `${f.victim ?? ""} 阵亡时 ${f.external ?? ""} 可用`;
    case "wasted-trinket":
      return `全队最低血量 ${f.teamMinHpPct ?? "?"}% 时开饰品`;
    case "questionable-external":
      return `${f.spell ?? ""} 给 ${f.target ?? ""}(${f.targetHp ?? "?"}% HP,距最近爆发窗 ${f.nearestBurstGapS ?? "?"}s)`;
    default:
      return "";
  }
}

/**
 * Anchor extraction for the uncovered-highlights sliding-window dedup (BACKLOG
 * #13): take only rows with `timed=true`.
 * The tS of a "whole-round observation" (e.g. cd-waste) is a sentinel, not a
 * real time anchor — used as an anchor it falsely marks whichever sliding
 * window it happens to fall into within tolerance as "covered" (review-round
 * fix: the caller previously folded all of
 * `deriveMistakes(source).map(mk => mk.tS)` into the anchors, unfiltered).
 * Exported as its own small function so the consumer (MatchReport) and the
 * tests both import it, instead of each writing the same
 * `.filter((mk) => mk.timed)`.
 */
export function timedAnchorsFromMistakes(
  mistakes: readonly Mistake[],
): number[] {
  return mistakes.filter((mk) => mk.timed).map((mk) => mk.tS);
}

export function deriveMistakes(
  source: ReportSource,
  range?: TimeRange | null,
): Mistake[] {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction === CombatUnitReaction.Hostile,
    );
    if (friends.length === 0 || enemies.length === 0) return [];
    const out: Mistake[] = [];
    const seen = new Set<string>();

    // candidate source: run once per friendly as the owner; dedup by candidate id
    for (const p of friends) {
      for (const c of extractCandidateFindings(legacy, p.id)) {
        const rule = RULE_BY_TYPE.get(c.type);
        if (!rule || rule.source !== "candidate") continue;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({
          tS: c.t,
          unitName: c.unitNames[0] ?? p.name,
          type: c.type,
          label: rule.label,
          severity: rule.severity,
          detail: candidateDetail(c),
          seekNames: c.unitNames.slice(0, 1),
          timed: c.facts.t !== undefined,
        });
      }
    }

    // kick source: all friendlies (the candidate version only covers DPS owners)
    for (const p of friends) {
      for (const k of analyzeKickAudit(p, enemies, legacy)) {
        if (k.result !== "juked" && k.result !== "missed") continue;
        const rule = RULE_BY_TYPE.get(
          k.result === "juked" ? "juked-kick" : "missed-kick",
        )!;
        out.push({
          tS: k.atSeconds,
          unitName: p.name,
          type: rule.type,
          label: rule.label,
          severity: rule.severity,
          detail:
            k.result === "juked"
              ? `${k.kickSpellName} 被 ${k.jukedBySpellName ?? "假读条"} 骗掉`
              : `${k.kickSpellName} 空放`,
          seekNames: [p.name],
          timed: true, // an interrupt happens at a specific instant, not over the whole round
        });
      }
    }

    // dispel source: missed purges inside a kill window (same annotation
    // predicate as the prompt side)
    const dispels = reconstructDispelSummary(friends, enemies, {
      startTime: legacy.startTime,
      endTime: legacy.endTime,
    });
    annotateMissedPurgesWithKillWindows(
      dispels.missedPurgeWindows,
      computeOffensiveWindows(enemies, friends, legacy),
    );
    for (const w of dispels.missedPurgeWindows) {
      if (!w.duringKillWindow) continue;
      const rule = RULE_BY_TYPE.get("missed-purge-kill-window")!;
      out.push({
        tS: w.timeSeconds,
        unitName: w.enemyName,
        type: rule.type,
        label: rule.label,
        severity: rule.severity,
        detail: `${w.spellName} 挂在 ${w.enemyName} 身上 ${Math.round(w.durationSeconds)}s 未被驱散`,
        seekNames: [w.enemyName],
        timed: true, // a missed purge happens at a specific instant, not over the whole round
      });
    }

    return out
      .filter((mk) => tInRange(mk.tS, range))
      .sort((a, b) => a.tS - b.tS);
  } catch {
    return [];
  }
}
