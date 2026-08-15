import { AtomicArenaCombat, ICombatUnit } from "@gladlog/parser-compat";

import { getPressureThreshold, hasOffensiveSpellActive } from "./cooldowns";
import { getLowestHpPercentInWindow } from "./killWindowTargetSelection";

/**
 * threatAssessment.ts — P2 共用威胁谓词(单源 export),供 `cd-hoarded` /
 * `cd-spent-idle` 两个候选类型的威胁分级门消费(spec:
 * docs/superpowers/specs/2026-08-15-p1p2-distillation-design.md「威胁谓词」节,
 * B6 裁决:威胁不分级不出 cd-spent-idle)。
 *
 * 复用清单(先读后写,CLAUDE.md 共享谓词规则 —— 不重新发明既有压力判定):
 *  - `hasOffensiveSpellActive`(cooldowns.ts):panic-press 检测器
 *    (`detectPanicDefensives`)原有的私有判定,现导出复用。判「敌方进攻大 CD
 *    光环活跃」用的是真实光环区间(既有表 OFFENSIVE_SPELL_IDS,SpellTag.Offensive
 *    在 classMetadata 里的既有标注),不是从 extractMajorCooldowns 的施放时刻 +
 *    spellEffectGenerated 时长外推的估算窗口 —— 真实数据优先于估算这条先例见
 *    burstLedger.ts 里 defensivesHit 的同类注释。
 *  - `getPressureThreshold`(cooldowns.ts,已导出):同一「有意义的压力量」单源
 *    (面板血量 15%,无进阶数据时按角色兜底)。panic press 已用它反向判「无威胁
 *    才算 panic」;threatActiveAt 判「有威胁」是它的直接对偶,不新造一套阈值。
 *  - `getLowestHpPercentInWindow`(killWindowTargetSelection.ts,已导出,同一
 *    文件里 `matchMinHpPct` 也是它的一个特化调用)。**本文件不调用
 *    `matchMinHpPct`**——2026-08-15 复审明确指出两者语义不同,不能混用:
 *    `matchMinHpPct` 回答的是「整场有没有出现过任何一次真实险情」(无界窗口,
 *    单次险情就该算,cdWasteEvents 的承压门要的正是这个语义);
 *    `matchThreatLevel` 要回答的是「这场是不是持续/反复危险」,一次孤立的
 *    亚秒级 HP 谷值不能单独定性整场——同一个原始采样器
 *    `getLowestHpPercentInWindow`,两处各自传自己的窗口边界,不是同一个事实。
 *
 * ## `threatActiveAt` 的窗口口径
 * 判「t 时刻附近己方承伤」用多宽的窗口求和——healingGaps 的窗口锚在一段无治疗
 * 区间(变长,≥3.5s),panic press 的窗口锚在一次施放前后(3s前/4s后,不对称);
 * `threatActiveAt` 要回答的是「任意 t 附近有没有威胁」,不锚在某个事件,于是给
 * 了自己的对称窗口常量 `THREAT_DAMAGE_WINDOW_MS`(未做语料标定)。
 *
 * ## `matchThreatLevel` 的聚合形状(2026-08-15 复审 FINDING 1 修法)
 * 原实现直接分级 `matchMinHpPct`(全场最小值),被复审当场推翻:一次真实的
 * ~150ms HP 谷值(三敌合围瞬间打穿再被急救拉回)在原口径下会把「转好即用、
 * 危机被完美化解」的一局误判成 high——这正是 B6「威胁不分级就会反向误报」要
 * 防的那类事故,只是换了个方向发生。改为**事件式聚合**:固定步长采样
 * `threatActiveAt`,收拢成连续「威胁片段」;丢弃时长小于地板的片段(单个亚秒级
 * 样本形成的片段不算数);片段必须真的把某个友方打穿到 `THREAT_LEVEL_LOW_MIN_HP_PCT`
 * 分界线以下才算候选(44ea4cf6 第二个窗口——4:26 只打到 81% ——在这一步就被
 * 挡掉,根本不需要靠「持续时长」去救);候选片段若在结束后的恢复窗内回升到
 * 分界线以上,判定为「答坑」(B11:玩家 48% 开圣盾,守住即为正解,不计入错过),
 * 不计入升级;`"high"` 仅当剩余的「真实」片段持续够长,或出现 ≥2 个独立的真实
 * 片段(复现)。
 */

/** Symmetric half-width of the "friendly under fire" sampling window around a
 * queried instant. <Task 5 标定定稿>: not yet corpus-calibrated. */
export const THREAT_DAMAGE_WINDOW_MS = 5_000;

/**
 * True when there is active enemy threat at `tSeconds`:
 *   - any enemy has an Offensive-tagged major CD aura active (existing table,
 *     real aura intervals via `hasOffensiveSpellActive`), OR
 *   - any friendly took damage totalling at least their own
 *     `getPressureThreshold` inside `[t - THREAT_DAMAGE_WINDOW_MS, t +
 *     THREAT_DAMAGE_WINDOW_MS]`.
 *
 * A per-instant primitive — `matchThreatLevel` samples this at a fixed step to
 * reconstruct threat *segments*; it is not itself a claim about how long or
 * how often the danger lasted.
 */
export function threatActiveAt(
  tSeconds: number,
  enemies: ICombatUnit[],
  friendlies: ICombatUnit[],
  combat: Pick<AtomicArenaCombat, "startTime">,
): boolean {
  const tMs = combat.startTime + tSeconds * 1000;

  if (enemies.some((e) => hasOffensiveSpellActive(e, tMs, null))) return true;

  const fromMs = tMs - THREAT_DAMAGE_WINDOW_MS;
  const toMs = tMs + THREAT_DAMAGE_WINDOW_MS;
  for (const f of friendlies) {
    const dmg = f.damageIn
      .filter(
        (d) => d.logLine.timestamp >= fromMs && d.logLine.timestamp <= toMs,
      )
      .reduce((sum, d) => sum + Math.abs(d.effectiveAmount), 0);
    if (dmg >= getPressureThreshold(f)) return true;
  }
  return false;
}

export type MatchThreatLevel = "low" | "med" | "high";

/**
 * Depth line a threat segment must actually cross to count as dangerous at
 * all, and the bar a segment must recover back above ("answered") to be
 * forgiven. <Task 5 标定定稿>: not yet corpus-calibrated; the number is shared
 * for both directions on purpose — a segment that never went below it never
 * needed forgiveness, and a segment that climbs back above it has, by the
 * same definition, stopped being a low-HP scare.
 */
export const THREAT_LEVEL_LOW_MIN_HP_PCT = 70;

/** Fixed-step grid `matchThreatLevel` samples `threatActiveAt` on to
 * reconstruct contiguous threat segments. <Task 5 标定定稿>. */
export const THREAT_SAMPLE_STEP_S = 1;
/** A run of true samples shorter than this is a lone/sub-step blip, not a
 * segment — this is what keeps a single ~150ms HP trough (one sample wide at
 * this grid) from reading as "a period of danger" on its own.
 * <Task 5 标定定稿>. */
export const THREAT_SEGMENT_MIN_DURATION_S = 2;
/** A single un-answered segment lasting at least this long counts as "high"
 * even without a second segment (the "persists" half of B6's "high only when
 * a segment persists or recurs"). <Task 5 标定定稿>. */
export const THREAT_SEGMENT_PERSIST_S = 20;
/** Window after a segment ends in which every friendly must recover back
 * above THREAT_LEVEL_LOW_MIN_HP_PCT for the segment to count as "answered"
 * (B11). <Task 5 标定定稿>. */
export const THREAT_RECOVERY_WINDOW_S = 15;

interface IThreatSegment {
  fromS: number;
  toS: number;
}

/**
 * Fixed-step reconstruction of `threatActiveAt`'s true/false timeline into
 * contiguous segments (step 1), dropping any segment shorter than
 * `THREAT_SEGMENT_MIN_DURATION_S` (step... the floor half of step 1).
 */
function threatSegments(
  enemies: ICombatUnit[],
  friendlies: ICombatUnit[],
  combat: Pick<AtomicArenaCombat, "startTime" | "endTime">,
): IThreatSegment[] {
  const matchDurationS = (combat.endTime - combat.startTime) / 1000;
  const segments: IThreatSegment[] = [];
  let openFromS: number | null = null;

  for (let t = 0; t <= matchDurationS; t += THREAT_SAMPLE_STEP_S) {
    const active = threatActiveAt(t, enemies, friendlies, combat);
    if (active && openFromS === null) {
      openFromS = t;
    } else if (!active && openFromS !== null) {
      segments.push({ fromS: openFromS, toS: t });
      openFromS = null;
    }
  }
  if (openFromS !== null) {
    segments.push({ fromS: openFromS, toS: matchDurationS });
  }

  return segments.filter(
    (s) => s.toS - s.fromS >= THREAT_SEGMENT_MIN_DURATION_S,
  );
}

/**
 * The worst (lowest) HP% any friendly reached DURING the segment's own span —
 * bounded to the segment, unlike `matchMinHpPct`'s whole-match unbounded
 * window (see the file header: deliberately not the same predicate). A
 * segment whose worst point never actually dropped below
 * `THREAT_LEVEL_LOW_MIN_HP_PCT` never counted as dangerous — the gate that
 * keeps the 44ea4cf6 second window (4:26, only down to 81%) from reading as
 * its own dangerous episode.
 */
function segmentWorstHpPct(
  seg: IThreatSegment,
  friendlies: ICombatUnit[],
  matchStartMs: number,
): number | null {
  const vals = friendlies
    .map((f) => getLowestHpPercentInWindow(f, seg.fromS, seg.toS, matchStartMs))
    .filter((v): v is number => v !== null);
  return vals.length > 0 ? Math.min(...vals) : null;
}

/**
 * "Answered the pit" (B11: player pressed a 48% defensive, held, and the user
 * ruled that surviving it is the correct play — not a miss to coach). Every
 * friendly must recover back above `THREAT_LEVEL_LOW_MIN_HP_PCT` within
 * `THREAT_RECOVERY_WINDOW_S` of the segment ending for it to count as
 * answered. Missing data in the recovery window (e.g. the friendly died and
 * left no further samples) is NOT recovery — silence here must not read as
 * "fine", or a death right at a segment's edge would be forgiven.
 */
function segmentAnswered(
  seg: IThreatSegment,
  friendlies: ICombatUnit[],
  matchStartMs: number,
): boolean {
  return friendlies.every((f) => {
    const recovered = getLowestHpPercentInWindow(
      f,
      seg.toS,
      seg.toS + THREAT_RECOVERY_WINDOW_S,
      matchStartMs,
    );
    return recovered !== null && recovered >= THREAT_LEVEL_LOW_MIN_HP_PCT;
  });
}

/**
 * Whole-match pressure classification (B6): "was this match sustained or
 * recurringly dangerous for my team" — deliberately NOT "did HP ever dip
 * anywhere" (see the file header). No advanced-logging data on any friendly →
 * "low" (cannot confirm threat, and B6's ruling is specifically that an
 * unconfirmed/absent threat must not gate a warning into existence).
 *
 * Otherwise: reconstruct threat segments (see `threatSegments`), keep only
 * the ones that (a) actually crossed `THREAT_LEVEL_LOW_MIN_HP_PCT` and (b)
 * were not "answered" within the recovery window. Zero such segments → low;
 * a single one shorter than `THREAT_SEGMENT_PERSIST_S` → med; a single one at
 * least that long, or two or more independent ones (recurrence) → high.
 */
export function matchThreatLevel(
  enemies: ICombatUnit[],
  friendlies: ICombatUnit[],
  combat: Pick<AtomicArenaCombat, "startTime" | "endTime">,
): MatchThreatLevel {
  const hasAnyHpData = friendlies.some((f) => f.advancedActions.length > 0);
  if (!hasAnyHpData) return "low";

  const matchStartMs = combat.startTime;
  const real = threatSegments(enemies, friendlies, combat).filter((seg) => {
    const worst = segmentWorstHpPct(seg, friendlies, matchStartMs);
    if (worst === null || worst >= THREAT_LEVEL_LOW_MIN_HP_PCT) return false;
    return !segmentAnswered(seg, friendlies, matchStartMs);
  });

  if (real.length >= 2) return "high";
  if (real.length === 1) {
    const durationS = real[0].toS - real[0].fromS;
    return durationS >= THREAT_SEGMENT_PERSIST_S ? "high" : "med";
  }
  return "low";
}
