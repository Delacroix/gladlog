import { AtomicArenaCombat, ICombatUnit } from "@gladlog/parser-compat";

import { getPressureThreshold, hasOffensiveSpellActive } from "./cooldowns";
import { matchMinHpPct } from "./killWindowTargetSelection";

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
 *  - `matchMinHpPct`(killWindowTargetSelection.ts,已导出,已在谓词索引):
 *    whole-match 最低血线。B6 参考例(44ea4cf6:敌方 sync 最深只打到我方 81%
 *    血 → 应判 low)直接落在这个谓词的语义上,`matchThreatLevel` 是它的分级
 *    包装,不重新采样 HP。
 *
 * 本文件唯一新增的口径:`threatActiveAt` 用多宽的窗口在 t 时刻附近求「己方承伤
 * 速率」。healingGaps 的 GAP_PRESSURE 窗口锚在一段无治疗区间(≥3.5s,长度由数据
 * 决定);panic press 的窗口锚在一次施放前后(3s 前 / 4s 后,不对称);
 * threatActiveAt 要回答的是「任意时刻 t 附近有没有威胁」,不锚在某个事件上,
 * 所以给了自己的对称窗口常量 —— 阈值/窗宽都待 Task 5 语料标定,标注见下。
 */

/** Symmetric half-width of the "friendly under fire" sampling window around a
 * queried instant. <Task 5 标定定稿>: not yet calibrated against corpus data. */
export const THREAT_DAMAGE_WINDOW_MS = 5_000;

/**
 * True when there is active enemy threat at `tSeconds`:
 *   - any enemy has an Offensive-tagged major CD aura active (existing table,
 *     real aura intervals via `hasOffensiveSpellActive`), OR
 *   - any friendly took damage totalling at least their own
 *     `getPressureThreshold` inside `[t - THREAT_DAMAGE_WINDOW_MS, t +
 *     THREAT_DAMAGE_WINDOW_MS]`.
 *
 * Consumed by the P2 CD-economy candidates: a defensive/self-preservation CD
 * spent while this is false is a "spent into a quiet window", the B6-gated
 * shape `cd-spent-idle` looks for.
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
 * Tier boundaries on the worst (lowest) whole-match `matchMinHpPct` across all
 * friendlies — `>= LOW_MIN_HP_PCT` is "low", `>= HIGH_MIN_HP_PCT` is "med",
 * below that is "high". <Task 5 标定定稿>: not yet calibrated against corpus
 * data; current values only pinned by the B6 reference point below.
 */
export const THREAT_LEVEL_LOW_MIN_HP_PCT = 70;
export const THREAT_LEVEL_HIGH_MIN_HP_PCT = 30;

/**
 * Whole-match pressure-peak classification (B6): "how dangerous did this match
 * ever get for my team". Reference point that pins the current thresholds —
 * match 44ea4cf6, where the enemy's deepest sync only brought a friendly down
 * to 81% HP — must classify as "low" (a slow win with real spare capacity;
 * coaching "you should have hoarded your CD" there is a false positive, B6's
 * whole point). 81 >= THREAT_LEVEL_LOW_MIN_HP_PCT (70) satisfies that.
 *
 * No advanced-logging data on any friendly → "low" (cannot confirm threat, and
 * B6's ruling is specifically that an unconfirmed/absent threat must not gate
 * a warning into existence — the conservative direction here is silence, the
 * mirror image of `cdWasteEvents`' "unknown pressure still emits" choice,
 * which exists to protect a *different* gate's coverage).
 */
export function matchThreatLevel(friendlies: ICombatUnit[]): MatchThreatLevel {
  const mins = friendlies
    .map((f) => matchMinHpPct(f))
    .filter((v): v is number => v !== null);
  if (mins.length === 0) return "low";
  const worst = Math.min(...mins);
  if (worst >= THREAT_LEVEL_LOW_MIN_HP_PCT) return "low";
  if (worst >= THREAT_LEVEL_HIGH_MIN_HP_PCT) return "med";
  return "high";
}
