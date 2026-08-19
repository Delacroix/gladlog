import {
  analyzeKickAudit,
  annotateMissedPurgesWithKillWindows,
  computeOffensiveWindows,
  extractCandidateFindings,
  reconstructDispelSummary,
  type CandidateEvent,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { resolveOwner } from "./analysisInput";
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
    // 2026-08-18 击杀尝试重设计(GH #16):打在有徽章目标上的失败尝试,同刻
    // 存在 prime 目标。severity 与 burst-into-mitigation 同档 —— 同一「机会
    // 成本」框架,判据换成了已验证的三档模型。
    type: "attempt-into-trinket",
    label: "开晕在有徽章的目标上",
    severity: "average",
    source: "candidate",
  },
  {
    type: "burst-into-immunity",
    label: "爆发打进免疫",
    severity: "major",
    source: "candidate",
  },
  {
    // OFFENSIVE-002 (2026-08-11, BACKLOG #18 second batch): a burst went into
    // a target with a major (non-immune) mitigation cooldown running, while a
    // softer target existed at that same moment. Same opportunity-cost framing
    // as burst-into-immunity, one tier down (mitigation is not full immunity).
    type: "burst-into-mitigation",
    label: "爆发打进大减伤",
    severity: "average",
    source: "candidate",
  },
  // off-target-in-window: RETIRED 2026-08-19 (user ruling: 集火按全队算;
  // candidateFindings 已摘发射,类型不再抵达 —— 见那边的退役注释)。
  {
    type: "dr-clipped-cc",
    label: "CC 打在递减上",
    severity: "average",
    source: "candidate",
  },
  // unconverted-burst: RETIRED 2026-08-19(用户裁定 C —— 被 [KILL ATTEMPTS]
  // 的逐尝试结果/归因替代;candidateFindings 已摘发射,类型不再抵达)。
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
  {
    // DEFENSIVE-003 (2026-08-11): the enemy opened a pressured offensive-CD
    // burst window and the healer owner's first defensive reaction came >8s
    // in or never, with a tool off cooldown and no CC excuse. Real team
    // damage is attached (unlike cc-held's pure uptime fact), hence
    // "average" rather than "minor" — same tier as healing-gap.
    type: "slow-defensive-response",
    label: "敌方开大应对迟缓",
    severity: "average",
    source: "candidate",
  },
  // P1/P2 起爆候选(Task 9,2026-08-15,四开关默认开启上线): same "fact, not
  // proven causation" discipline as cc-held/cd-waste above — B8 explicitly
  // designed missed-sync-window with NO HP gate (enemyMinHpPct is an
  // accelerator-only fact, never a proof of consequence), and unsynced-burst
  // is documented as unsynced-burst's sibling to unconverted-burst ("two
  // different coaching facts about the same button press") — same tier as
  // that sibling.
  {
    type: "missed-sync-window",
    label: "锁死未起爆",
    severity: "minor",
    source: "candidate",
  },
  {
    type: "unsynced-burst",
    label: "起爆未同步",
    severity: "minor",
    source: "candidate",
  },
  // cd-hoarded/cd-spent-idle both cite a real consequence context (a
  // teammate's crisis HP% for cd-hoarded; the match's own medium+ threat
  // gate for cd-spent-idle — B6 red line means it never fires in a calm
  // match) rather than a pure uptime fact, so "average" like
  // healing-gap/slow-defensive-response above rather than cc-held's "minor".
  {
    type: "cd-hoarded",
    label: "大 CD 囤积过久",
    severity: "average",
    source: "candidate",
  },
  {
    type: "cd-spent-idle",
    label: "保命 CD 打空当",
    severity: "average",
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
   * 这条是不是关于**你自己**的。失误卡默认只展开 owner 的,队友的整块折叠 ——
   * 2026-08-17 实测:UI 每回合中位 28 条,其中近 30% 是 DPS 专属类型
   * (off-target-in-window / unconverted-burst),owner 视角下一条都不会出,
   * 全部来自 mistakes.ts 对每个友方各跑一遍候选提取;position-mistake 更是被
   * 放大 8.2×。收敛到 owner 视角后每回合 9.9 条。
   *
   * 归属判定走共享谓词 `resolveOwner`(docs/predicate-index.md 已登记),
   * 不另起一套「谁是本场主角」的判断。
   */
  isOwner: boolean;
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
    case "attempt-into-trinket":
      return `${f.stun ?? ""} 开在 ${f.target ?? ""} 身上(徽章还在),当时 ${f.primeAlt ?? ""} 无徽章无控中减伤;失败原因 ${f.failedBy ?? "?"}`;
    case "burst-into-immunity":
      return `${f.spell ?? ""} 打进 ${f.target ?? ""} 的 ${f.immunity ?? ""}(重叠 ${f.overlap ?? "?"}s)`;
    case "burst-into-mitigation":
      return `${f.spell ?? ""} 打进 ${f.target ?? ""} 的 ${f.mitSpell ?? ""}(减伤 ${f.mitPct ?? "?"}%),当时 ${f.betterTarget ?? ""} 是更软的目标`;
    case "dr-clipped-cc":
      return `${f.spell ?? ""} 打在 ${f.target ?? ""} 的 ${f.dr ?? ""} 递减上(仅 ${f.duration ?? "?"}s)`;
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
    case "slow-defensive-response":
      return `${f.enemyCds ?? ""} 开启后${
        f.reacted === "none"
          ? "窗口内无防御反应"
          : `${f.delayS ?? "?"}s 才有防御反应(${f.reactSpell ?? ""})`
      },窗口承伤 ${f.damageK ?? "?"}k`;
    case "missed-sync-window":
      return `${f.healer ?? ""} 被 ${f.cc ?? ""} 控 ${f.durationS ?? "?"}s,${f.readyCds ?? ""} 均 ready 未按`;
    case "unsynced-burst":
      return `${f.spell ?? ""} 起爆时 ${f.healer ?? ""} 没有硬控在身,自由治疗`;
    case "cd-hoarded":
      return `${f.spell ?? ""} ready 后 ${f.lateS ?? "?"}s 才按,期间 ${f.crisisUnit ?? ""} 掉到 ${f.crisisHpPct ?? "?"}%${f.unresolved ? `(${f.unresolved})` : ""}`;
    case "cd-spent-idle":
      return `${f.spell ?? ""} 在无威胁时段打出`;
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
    // 共享谓词(docs/predicate-index.md 已登记),不另起一套主角判断。
    const ownerName = resolveOwner(legacy)?.name;
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
          isOwner: (c.unitNames[0] ?? p.name) === ownerName,
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
          isOwner: p.name === ownerName,
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
        // 漏剥离是整队责任、不归属某个友方 —— 归到 owner 侧,否则它会掉进
        // 「队友」折叠区里消失(unitName 是敌人名,不是任何友方)。
        isOwner: true,
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

// ─── 时刻分组(2026-08-17) ──────────────────────────────────────────────────

/**
 * 同一时刻内的失误合成一组的窗口(秒)。
 *
 * **这是展示参数,不是分析谓词** —— 它只决定「几条并成一行给人看」,不参与
 * 任何事实判断,所以证据标准与 `HP_SAMPLE_RADIUS_MS` 那类不同,不需要签字册。
 *
 * 依据(2026-08-17,200 回合 owner 视角实测,平均 11.0 条/回合):
 *   ±5s → 7.8 个时刻(压缩 28%) · **±10s → 6.1 个(44%)** · ±15s → 4.8 个(55%)
 * 取 10s:它落在压缩率曲线的拐点上,且与最常共现的类型对的语义跨度相符 ——
 * 实测最高频的共现是 `cc-locked + unsynced-burst`(51 次)、
 * `cc-locked + missed-sync-window`(45)、`cc-locked + missed-purge/cleanse`
 * (36/35),都是「你被控住的同一波」里的不同侧面,本来就该并成一件事讲。
 *
 * 刻意**不复用** `SLOW_DEF_RESPONSE_DEDUP_SLACK_S`(同样是 10):那是候选层
 * 的去重松弛,是另一个事实。审计记过 `POSITION_MAX_GAP_MS` 被当成 HP 半径
 * 用的教训 —— 数值相同不等于概念相同,不共享。
 */
export const MISTAKE_MOMENT_GAP_S = 10;

export interface MistakeMoment {
  /** 组内最早的时刻,用于排序与跳转。 */
  tS: number;
  /** 组内最高严重度 —— 一组里只要有一条重大,这一组就是重大。 */
  severity: MistakeSeverity;
  /** 组内是否有真实时间锚点(全是整场型观察时为 false)。 */
  timed: boolean;
  items: Mistake[];
}

const SEVERITY_RANK: Record<MistakeSeverity, number> = {
  major: 3,
  average: 2,
  minor: 1,
};

/**
 * 把一串失误按时刻并成组。**先合并再截断** —— 反过来会把同一件事的碎片
 * 当成不同的事截掉一半。
 *
 * 只对有时间锚点的条目分组;整场型观察(`timed: false`,如 cd-waste)各自
 * 独立成组并排在最后,因为它们没有「发生在哪一刻」可言。
 */
export function groupMistakesByMoment(
  mistakes: readonly Mistake[],
): MistakeMoment[] {
  const timed = mistakes.filter((m) => m.timed).sort((a, b) => a.tS - b.tS);
  const untimed = mistakes.filter((m) => !m.timed);
  const groups: MistakeMoment[] = [];
  for (const m of timed) {
    const last = groups[groups.length - 1];
    if (last && m.tS - last.items[last.items.length - 1]!.tS <= MISTAKE_MOMENT_GAP_S) {
      last.items.push(m);
      if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[last.severity]) {
        last.severity = m.severity;
      }
    } else {
      groups.push({ tS: m.tS, severity: m.severity, timed: true, items: [m] });
    }
  }
  for (const m of untimed) {
    groups.push({ tS: m.tS, severity: m.severity, timed: false, items: [m] });
  }
  return groups;
}

/** owner 的 / 队友的 —— 卡片默认只展开前者,后者整块折叠。 */
export function splitMistakesByOwner(mistakes: readonly Mistake[]): {
  own: Mistake[];
  teammates: Mistake[];
} {
  return {
    own: mistakes.filter((m) => m.isOwner),
    teammates: mistakes.filter((m) => !m.isOwner),
  };
}
