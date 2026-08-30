import type { ICombatUnit } from "@gladlog/parser-compat";
import {
  CombatUnitClass,
  CombatUnitReaction,
  LogEvent,
} from "@gladlog/parser-compat";

import { lookupBehaviorPrior } from "../data/behaviorPrior";
import { CANDIDATE_TYPE_FLAGS } from "../data/candidateTypeFlags";
import { costNormPhrase } from "../data/curatedAbilityFacts";
import { CORPUS_OBSERVED_DISPEL_IDS } from "../data/dispelObservedGenerated";
import { MITIGATION_TABLE } from "../data/mitigationData";
import { spellEffectData } from "../data/spellEffectData";
import { ccSpellIds, trinketSpellIds } from "../data/spellTags";
import { buildAuraIntervals } from "../utils/auraIntervals";
import { analyzeBurstLedger } from "../utils/burstLedger";
import {
  analyzePlayerCCAndTrinket,
  applicableCCAvoidanceIds,
  CC_AVOIDANCE_BUFF_SPELLS,
  type ICCInstance,
  REPOSITIONING_SPELL_IDS,
  trinketStateFact,
} from "../utils/ccTrinketAnalysis";
import {
  annotateDefensiveTimings,
  applyCdTalentModifiers,
  canHelpAnotherUnit,
  cdAvailableAt,
  chargesAvailableAt,
  DEFENSIVE_TAGS,
  extractMajorCooldowns,
  getUnitHpAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  type IAvailableWindow,
  type IMajorCooldownInfo,
  isAllyCastableDefensive,
  isHealerSpec,
  isMeleeSpec,
  isProcOnlyActivation,
  MAJOR_DEFENSIVE_IDS,
  playerTalentIdSets,
  PRE_WALL_SECONDS,
  specToString,
} from "../utils/cooldowns";
import {
  annotateMissedPurgesWithKillWindows,
  canDefensiveCleanse,
  hardCastOccupancyWithin,
  type IMissedCleanseWindow,
  type IMissedPurgeWindow,
  reconstructDispelSummary,
} from "../utils/dispelAnalysis";
import { drResetMsAt } from "../utils/drAnalysis";
import {
  type IAlignedBurstWindow,
  reconstructEnemyCDTimeline,
} from "../utils/enemyCDs";
import { detectHealingGaps, type IHealingGap } from "../utils/healingGaps";
import {
  attemptIntoTrinketEvents,
  extractKillAttempts,
} from "../utils/killAttempts";
import {
  analyzeKillWindowTargetSelection,
  matchMinHpPct,
} from "../utils/killWindowTargetSelection";
import { computeOffensiveWindows } from "../utils/offensiveWindows";
import {
  computeOwnerPositionEvents,
  type IPositionEvent,
  POSITION_MISTAKES,
  stayedInHadRealCost,
} from "../utils/positionAnalysis";
import { type RawStreams } from "../utils/rawStreams";
import { renderedWindowSeconds, toRenderSecond } from "../utils/renderGrid";
import { getTalentAvoidanceTriggers } from "../utils/talentBehaviors";
import { matchThreatLevel, threatActiveAt } from "../utils/threatAssessment";
import {
  cdHoardedEvents,
  cdSpentIdleEvents,
  enemyHealerCcWindows,
  enemyMinHpPctInWindow,
  friendlyCrisisMomentInWindow,
  missedSyncWindowEvents,
  unsyncedBurstEvents,
} from "./candidates/cooldownTiming";
import { crisisNoResponseEvents } from "./candidates/crisisNoResponse";
import {
  deathSetupEvents,
  type DeathSetupParts,
  deathUnusedDefensiveEvents,
  externalUnusedEvents,
  questionableExternalEvents,
} from "./candidates/death";
import {
  CYCLONE_SPELL_ID,
  DIVINE_SHIELD_SPELL_ID,
  ICE_BLOCK_SPELL_ID,
  type IStrategicHolder,
  MD_SPELL_ID,
  mdCycloneWindowEvents,
} from "./candidates/massDispel";
import { crisisDecisionPoints } from "./crisisDecisionPoints";
import { fmtFactNum as fmt } from "./factFormat";
import type { CandidateEvent } from "./types";

// Cooldown-timing producers moved to `candidates/cooldownTiming.ts` in the
// 2026-08-16 theme split; re-exported so importers keep their paths.
export {
  CD_HOARD_CRISIS_HP_PCT,
  CD_HOARD_MIN_LATE_S,
  cdHoardedEvents,
  cdSpentIdleEvents,
  enemyHealerCcWindows,
  enemyMinHpPctInWindow,
  friendlyCrisisMomentInWindow,
  HARD_CC_CATEGORIES,
  type ICrisisMoment,
  type IEnemyHealerCcWindow,
  missedSyncWindowEvents,
  unsyncedBurstEvents,
} from "./candidates/cooldownTiming";

// Death-anchored producers moved to `candidates/death.ts` in the 2026-08-16
// theme split; re-exported so importers keep their paths.
export {
  DEATH_SETUP_LOOKBACK_S,
  deathSetupEvents,
  type DeathSetupParts,
  deathUnusedDefensiveEvents,
  EXTERNAL_FREE_MIN_GAP_S,
  EXTERNAL_FREE_WINDOW_S,
  externalUnusedEvents,
  questionableExternalEvents,
} from "./candidates/death";

// The mana producers and their calibrated thresholds moved to
// `candidates/mana.ts` in the 2026-08-16 theme split. Re-exported here so the
// package barrel, eval's calibration sweep and the existing tests keep their
// import paths — the split is mechanical, the public surface is unchanged.
export {
  MANA_EFF_FLOOR,
  MANA_EFF_MIN_CASTS,
  MANA_PRESSURE_LOW_PCT,
  MANA_PRESSURE_MIN_FAILED,
  MANA_PRESSURE_MIN_WINDOW_S,
  MANA_PRESSURE_TAIL_MAX_GAP_S,
  manaEfficiencyEvents,
  manaPressureEvents,
} from "./candidates/mana";

// crisis-no-response (spec 2026-08-29): lives in `candidates/crisisNoResponse.ts`
// alongside the shared `crisisDecisionPoints` predicate it consumes;
// re-exported here so the package barrel and existing tests keep one import
// path, same convention as the mana/cooldownTiming/death splits above.
export {
  CRISIS_NO_RESPONSE_CAP,
  crisisNoResponseEvents,
} from "./candidates/crisisNoResponse";

/** Single-source predicate (CLAUDE.md shared-predicate rule; review round 1,
 * BACKLOG #26 Task 2 Minor finding): the two candidate types
 * `formatAttemptedFact` above ever populates `facts.attempted` on today.
 * `auditFindings.ts`'s severity downgrade gates on this set (mirroring how
 * `LEGACY_TOPIC_TYPES` gates the diversity cap) rather than on the bare
 * `facts.attempted` string key alone — a future candidate type that happens
 * to reuse that key for an unrelated fact must NOT silently start
 * downgrading severity too. */
export const ATTEMPTED_GUARD_TYPES: ReadonlySet<string> = new Set([
  "cd-hoarded",
  "death-unused-defensive",
]);

/**
 * Map never-used major cooldowns to cd-waste candidate events. Pure (no combat
 * traversal) so the mapping rule is unit-testable with hand-built cooldown
 * fixtures; the extractMajorCooldowns integration is exercised on real matches.
 *
 * Rule: emit for a cooldown that was never used AND is a pure survival wall.
 * Throughput CDs (isThroughput — e.g. Power Infusion) are excluded: a never-used
 * throughput CD is a different, weaker coaching point than a never-used defensive.
 *
 * Pressure gate (2026-07-26): if the owner's whole-round minHP >= threshold,
 * emit nothing. Empirical evidence from 12 Holy Priest rounds: low-pressure
 * rounds (minHP 70-94%) were false-positived as "never used all round" 8/8,
 * while rounds where the wall was genuinely needed had minHP 9-52%; 60% falls
 * inside the separating gap. minHpPct=null (old logs without advanced params)
 * still emits, conservatively — never silently drop coverage.
 */
export const CD_WASTE_PRESSURE_HP_PCT = 60;

export function cdWasteEvents(
  cds: (Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "neverUsed" | "isThroughput"
  > &
    /** GH #29 第 5 项(2026-08-23,DPS 视角实测):这条指控在 prompt 图例里写的是
     *  「a major **defensive** cooldown the player never pressed」,而判据用的是
     *  `!isThroughput` —— 那只等于「不是 Offensive-tagged」,于是**整个 Control
     *  集合**被当成「你整局没交的保命技能」。治疗视角看不到(0/17),换 DPS 视角
     *  立刻暴露:**58/176(33%)**引用的是 Control CD(致盲 13、龙息 7、雷鸣怒吼 6、
     *  恐惧嚎叫 4、变形术 4、焦油陷阱 4、震荡波 3…)。tag 可选,缺省退回原判据。 */
    Partial<Pick<IMajorCooldownInfo, "tag">>)[],
  healer: { id: string; name: string },
  minHpPct: number | null,
): CandidateEvent[] {
  if (minHpPct !== null && minHpPct >= CD_WASTE_PRESSURE_HP_PCT) return [];
  const out: CandidateEvent[] = [];
  for (const cd of cds) {
    // 指控说「防御」,就只能问防御 tag —— 不能拿「不是进攻」凑数。
    const isDefensive = cd.tag === undefined || DEFENSIVE_TAGS.has(cd.tag);
    // 「整局没交」对没有按键的能力不成立(`PROC_ONLY_ACTIVATION_IDS`)。
    if (isProcOnlyActivation(cd.spellId)) continue;
    if (cd.neverUsed && !cd.isThroughput && isDefensive) {
      // Cost-norm guard (#25, 2026-08-14): a never-used major defensive is
      // exactly the shape of fact that tempts the model into "you should
      // have used your X" — for a signed-off cost_norm ability (Divine
      // Shield/Ice Block: mechanically usable, but too costly to coach as a
      // routine reaction) that advice is wrong. Same precedent as the dispel
      // capability gates (candidateFindings.ts's missed-cleanse
      // ownerCanDispel): the fact carries the guard, the prompt explains it.
      const costNorm = costNormPhrase(cd.spellId);
      out.push({
        id: `cd-waste:${healer.id}:${cd.spellId}`,
        type: "cd-waste",
        t: 0, // whole-round observation, not time-specific
        unitNames: [healer.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          spell: cd.spellName,
          unit: healer.name,
          ...(costNorm ? { costNorm } : {}),
        },
      });
    }
  }
  return out;
}

/**
 * Structured, verifiable candidate events for the findings pipeline. Built on
 * the parsed combat directly (NOT a refactor of buildMatchContext). Extensible
 * by pushing more typed events.
 *
 * Current menu:
 *  - death (all units, tagged friendly/enemy so the LLM knows kill vs loss)
 *  - death-setup (all owners): causal-chain precursors to a friendly death
 *    (healer-locked / trinket-early / defensive-early), <=2 per death, each
 *    timestamped before the death
 *  - cd-waste (the owner's — default: the Friendly healer's — never-used
 *    DEFENSIVE major cooldowns)
 *  - DPS owner only: burst-into-immunity / burst-into-mitigation /
 *    off-target-in-window / juked-kick / dr-clipped-cc / unconverted-burst
 */
export function extractCandidateFindings(
  combat: any,
  ownerId?: string,
  /**
   * Intent guard (BACKLOG #26 Task 2, 意图守护): raw.txt's SPELL_CAST_FAILED
   * stream, when the caller has it available — desktop main reads raw.txt
   * lazily and passes the parsed streams through; renderer callers fetch it
   * over the existing IPC boundary (see analysisInput.ts's
   * `getRawStreamsSync`). Optional and silently degrading (Global Constraint):
   * absent, or `available:false` (raw.txt missing/unreadable), makes every
   * downstream candidate byte-identical to before this param existed.
   */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  const units = Object.values(combat?.units ?? {}) as any[];
  const start = combat?.startTime ?? 0;

  // --- player deaths, tagged friendly/enemy ---
  // Players only: every arena combatant emits COMBATANT_INFO (u.info); pets,
  // totems, and guardians do not. A pet death is noise (they die and resummon
  // constantly) and would mislead the coach if tagged as a "friendly death".
  for (const u of units) {
    if (!u.info) continue;
    for (const d of (u.deathRecords ?? []) as any[]) {
      const t = ((d.timestamp ?? 0) - start) / 1000;
      const side =
        u.reaction === CombatUnitReaction.Friendly ? "friendly" : "enemy";
      out.push({
        id: `death:${u.id}:${Math.round(t)}`,
        type: "death",
        t,
        unitNames: [u.name],
        facts: { t: fmt(t), unit: u.name, side },
      });
    }
  }

  // When ownerId is absent, fall back to the friendly healer (existing
  // behavior; the healer pipeline's menu is unchanged). The fallback MUST be
  // resolved before calling extractDeathSetups — previously the raw ownerId
  // (undefined) was forwarded straight through, so isOwner/ownerUnit were
  // always false/undefined and death-unused-defensive / external-unused could
  // never be emitted, breaking the "default to the friendly healer" API
  // contract (found in agy review, adopted). The cd-waste branch reuses this
  // same healer instead of recomputing it.
  const healer = units.find(
    (u) =>
      u.info &&
      u.reaction === CombatUnitReaction.Friendly &&
      isHealerSpec(u.spec),
  );
  const resolvedOwnerId = ownerId ?? healer?.id;

  // --- death-setup: causal chain behind a friendly death (reasoning-chain
  // evidence, emitted for every owner perspective) ---
  try {
    out.push(
      ...extractDeathSetups(combat, units, start, resolvedOwnerId, rawStreams),
    );
  } catch {
    /* no analysis throw may take down the rest of the menu */
  }

  // --- cd-waste: the owner's never-used defensive cooldowns ---
  const owner =
    (ownerId ? units.find((u) => u.info && u.id === ownerId) : undefined) ??
    healer;
  // Hoisted out of the block below (2026-08-06) so team-play events (POSITION-001 /
  // COOLDOWN-001) can reuse the same computation instead of re-fetching it.
  let ownerCds: IMajorCooldownInfo[] = [];
  if (owner) {
    try {
      ownerCds = extractMajorCooldowns(owner, combat);
    } catch {
      ownerCds = [];
    }
    out.push(...cdWasteEvents(ownerCds, owner, matchMinHpPct(owner)));
  }

  // --- DPS owner events (D2) — healer owners skip this whole branch ---
  if (owner && !isHealerSpec(owner.spec)) {
    try {
      out.push(...dpsOwnerEvents(combat, owner, units));
    } catch {
      /* no analysis throw may take down the rest of the menu */
    }
  }

  // --- team-play events (every owner perspective; coverage expansion
  // 2026-07-24) ---
  // Motivation (measured via evidenceDist): the healer-perspective menu
  // averaged 3.4 events/match, 41% of matches had <=2, and 15/17 matches only
  // covered the final third — of the existing types the four offensive ones
  // can't fire for a healer, leaving only death (naturally at the end).
  // Missed cleanse / missed purge / chain-CC'd / eating a full kick span the
  // whole match and correlate strongly with healer play.
  if (owner) {
    try {
      out.push(
        ...teamPlayEvents(combat, owner, units, ownerCds, out, rawStreams),
      );
    } catch {
      /* no analysis throw may take down the rest of the menu */
    }
  }

  return out;
}

/** Per-match cap for each team-play type (sorted by coaching value, then
 * truncated, so one type can't flood the menu).
 *
 * Per-round throttle(2026-08-06 立,BACKLOG #22;**2026-08-20 复查后确认
 * 长期保留,不再是 TEMPORARY** —— 用户裁定):当年 200 场扫描四族占全部
 * 候选 ~66%,故设硬上限。当年写的取消条件(「信号扩容后恢复到 3」)已按
 * 数字复查:扩容落地、cc-locked/wasted-trinket 退役、族缩为
 * cleanse/purge 之后,cap=2 下族占菜单 16.8%(健康),但 **无 cap 模拟
 * = 64.6%,与当年触发限流的 64% 一模一样** —— purge 原始窗口场均 12.6
 * 条,cap 依然承重;恢复到 3 会把占比推到 ~25%,无收益证据(missed-purge
 * 判别力弱正,#21 保留裁定未要求更多曝光)。数字在 issue #16/#22 相关
 * 评论。cap 只砍量不砍质 —— 每类仍按自身 severity 排序后截断,最高价值
 * 实例保留。
 *
 * These same four types are also `LEGACY_TOPIC_TYPES` below — that set is the
 * SELECTION-layer counterpart of this menu-generation throttle: a 2026-08-11
 * four-backend measurement (diversity-baseline-report.md) found the model's
 * picking step ALSO over-selects these four relative to their already-capped
 * menu share (+3.4~+7.5pt at survival), so buildFindingsPrompt's prompt text
 * and auditFindings' deterministic cap both key off that one set instead of
 * re-listing the four names a third time.
 *
 * 2026-08-26 全族 at-cap 体检(GH #34 第二批;S2 快照 200 文件 / 782 owner-回合,
 * 治疗+DPS 双视角;「产出==cap」为截断的下界代理,全表在 GH #34 评论):
 * missed-purge 在 **94% 的有产出回合打到上限**(455/485)—— 与上段「原始窗口
 * 场均 12.6 条」的复查数字互证,cap 仍是全家族最承重的一条;kick-eaten 59%
 * (136/231)、missed-cleanse 28%(34/121);cc-locked / wasted-trinket 已退役,
 * 语料产出为 0,其 cap 仅供保留的纯函数测试消费。
 */
const MISSED_CLEANSE_CAP = 2;
const MISSED_PURGE_CAP = 2;
const CC_LOCKED_CAP = 2;
const KICK_EATEN_CAP = 2;
/** 长期保留(2026-08-20 复查,见上方块注释);wasted-trinket 类型已退役,
 * 本常量仅供保留的纯函数测试消费。 */
const WASTED_TRINKET_CAP = 1;

/** Single-source predicate (CLAUDE.md shared-predicate rule): the
 * candidate-menu types this repo has repeatedly measured the SELECTION layer
 * (not just candidate generation) over-picking. `buildFindingsPrompt.ts`
 * enumerates these names into its per-type selection cap instruction, and
 * `auditFindings.ts` enforces the same cap deterministically on survivors —
 * both import this set rather than hand-listing the type strings a
 * second/third time. See the BACKLOG #22 block comment above for the
 * menu-generation-side throttle these mirror.
 *
 * 2026-08-19 (GH #14): cc-locked retired from the menu entirely, then
 * wasted-trinket followed the same day (B-group re-measurement, see both
 * retirement notes at their former emission sites) — the family shrank from
 * four to two. The selection instruction, the audit backstop, and the drift
 * tests all derive from this set and moved together. */
export const LEGACY_TOPIC_TYPES: ReadonlySet<string> = new Set([
  "missed-cleanse",
  "missed-purge",
]);
/** cc-locked: how long a single CC must last to be worth coaching (short CCs
 * are constant background noise). */
// GH #34 batch 4 (2026-08-28), 300 matches / 1,127 healer rounds / 10,366
// hard-CC instances on the owner: duration [0,1) 1,408 · [1,2) 1,979 · [2,3)
// 1,460 · [3,4) 1,962 · [4,5) 1,264 · [5,6) 1,267 · [6,8) 971 · ≥ 8 54 (p50
// 3.0 s, p90 6.0 s). Share that clears the gate: ≥ 3 s 53.2 % · **≥ 4 s
// 34.3 %** · ≥ 5 s 22.1 % — no natural break; 4 s is an editorial "worth a
// coaching line" cut that halves the volume relative to 3 s. Measured, not
// official; re-run before moving.
const CC_LOCKED_MIN_S = 4;

/**
 * Signal-expansion batch 1 thresholds/caps (2026-08-06, BACKLOG #18 second
 * batch, design: docs/superpowers/specs/2026-08-07-signal-expansion-batch1-design.md).
 * Corpus-empirical rates (200 matches / 899 sources, one predicate call per
 * signal, zero new tables — see
 * `.superpowers/sdd/2026-08-05-window-multi-finding/signal-rates-report.md`):
 *  - HEAL-001 (healing-gap): 5.3% of healer-owner rounds qualify, 54 raw
 *    events; freeCastSeconds p50=3.8s sits right at the 4s door, so the
 *    threshold roughly halves detectHealingGaps' own 117 raw gaps.
 *  - POSITION-001 (position-mistake): 10.9% of rounds with position data have
 *    >=1 mistake, 118 raw STAYED_IN-with-real-cost events (MISSED_PUSH /
 *    CD_OUT_OF_RANGE were 0/0 on this healer-heavy corpus — kept anyway, see
 *    the mapper's doc comment).
 *  - COOLDOWN-001 (cc-held): the report measured both a 60s and a 90s door;
 *    90s was chosen (259 raw windows vs 484) to keep the false-positive rate
 *    down — at 60s, 23% of ALL observed CC availableWindows already clear the
 *    bar, meaning a good chunk are just normal cast-rhythm gaps, not
 *    "sitting on it".
 */
const HEAL_GAP_FREE_MIN_S = 4;
// at-cap 体检(2026-08-26,782 owner-回合,详见上方 *_CAP 块注释):healing-gap
// 打到上限 3/29 有产出回合(10%)、position-mistake 17/98(17%)、cc-held 7/121
// (6%)—— 三条 cap 基本惰性,截断可忽略。
const HEALING_GAP_CAP = 2;
const POSITION_MISTAKE_CAP = 2;
// GH #34 batch 4 (2026-08-28), same corpus, 2,328 available windows of the
// owner's CC majors (944/1,127 rounds have one): [0,30) 1,173 · [30,60) 610 ·
// [60,90) 270 · [90,120) 112 · [120,180) 102 · [180,240) 57 · ≥ 240 4 (p50
// 29.8 s, p90 101.8 s). Share that clears the gate: ≥ 60 s 23.4 % · **≥ 90 s
// 11.8 %** · ≥ 120 s 7.0 % — 90 s sits in the decaying tail (≈ one full CC
// cooldown of idle time), an editorial cut. Measured, not official.
const CC_HELD_MIN_S = 90;
const CC_HELD_CAP = 2;

/**
 * DEFENSIVE-001 (cc-avoidable, 2026-08-07, BACKLOG #18 second batch, design:
 * docs/superpowers/specs/2026-08-07-defensive-001-design.md). Corpus-empirical
 * (200 matches / 635 healer-owner rounds, `.defensive-rates-report.md` —
 * **该报告与其复现脚本 `packages/desktop/scripts/tmp-defensive-rates.mts` 现均已不在盘上
 * (2026-08-17 核实),下列数字只以本注释的形式存在,无法复现**;
 * acceptance-rescanned against this real implementation via
 * `packages/desktop/scripts/tmp-defensive-rates.mts` — evaluated then
 * deleted): 16.5% of healer rounds (105/635) qualify at the raw judgment
 * (full-DR CC >=3s + >=1 avoidance tool evidenced+available); 64.3% of the
 * raw hit EVENTS also carry `trinketState === "available_unused"` — already
 * covered by the cc-locked / wasted-trinket candidates — so this type
 * EXCLUDES that overlap (dedupe gate, see ccAvoidableEvents) rather than
 * double-charging the same instant under a second type. Post-exclusion,
 * measured by actually running this function over the corpus (not a
 * back-of-envelope estimate): 96 raw non-overlap events, 78 after the cap
 * (2/round), 59/635 rounds hit (9.3%). Divine Shield alone drives 62% of raw
 * hits and Holy Paladin alone drives 59.2% of raw hit rounds (33.7% after the
 * dedupe gate) — a real, reported skew (see the design doc), not a bug.
 */
// 2026-08-20 接地收紧(GH #16,用户裁定):3 → 4。门前 2083 条有工具 full-DR
// CC 实测,时长 ≤4s 的 10s 内友方死亡率全平(4.2–4.5%),4–6s 跳至 8.0%、
// ≥6s 10.2% —— 膝点在 4 不在 3;旧 3s 门多放的 3–4s 段(259 条,12.4%)
// 行为与背景无异。数字在 issue #16 的三小件接地评论。
const CC_AVOIDABLE_MIN_S = 4;
// at-cap 体检(2026-08-26):8/30 有产出回合打到上限(27%)。
const CC_AVOIDABLE_CAP = 2;

/**
 * OFFENSIVE-002 (burst-into-mitigation, 2026-08-11, BACKLOG #18 second batch):
 * a burst-ledger dominant target had a major (non-immune) mitigation cooldown
 * running that blocked >= BURST_INTO_MITIGATION_MIN_PCT of the damage school,
 * AND analyzeKillWindowTargetSelection reports a softer alternative target was
 * available at the same instant (a synthetic window built from the burst's own
 * span/target — the exact kill-opportunity-tier predicate BurstLedgerCard's
 * "窗口目标纪律" section and off-target-in-window already consume, not a second
 * implementation). MITIGATION_TABLE entries marked `positional: true`
 * (currently only Darkness/196718) are excluded outright: the #17 spec's
 * decision record #4 requires a coordinate judgement before counting them
 * ("判不了就不计入"), and this candidate does not implement position checking —
 * the same choice counterfactual.ts already made for its own three shapes.
 *
 * Corpus-empirical (200 matches / 899 sources, BACKLOG #18 second batch,
 * `packages/desktop/scripts/tmp-off002-rates.mts` — evaluated then deleted):
 * this library is 898/899 healer-recorded, so under the production
 * single-owner convention (resolveOwner) DPS-owner rounds measure 0/0 — a
 * corpus fact, not a signal fact (dpsOwnerEvents only ever runs for a
 * non-healer owner). Measured through the same per-friend loop
 * deriveMistakes.ts (mistakes.ts) actually uses to surface candidates for
 * teammates — every non-healer friendly taken as owner in turn — the
 * underlying signal is real: 1794 DPS-owner-rounds, 263 qualifying windows,
 * 225/1794 rounds (12.5%) hit >=1. No single mitigation spell dominates the
 * raw hits (11 distinct spells observed; the largest, Pain Suppression, is
 * 34.4% of raw hits — not a monoculture).
 */
const BURST_INTO_MITIGATION_MIN_PCT = 30;
// at-cap 体检(2026-08-26):2/20(10%),惰性。
const BURST_INTO_MITIGATION_CAP = 2;

/**
 * DEFENSIVE-003 (slow-defensive-response, 2026-08-11): the enemy opened an
 * offensive-CD burst window (reconstructEnemyCDTimeline's alignedBurstWindows
 * — the same single-source both annotateDefensiveTimings and wasted-trinket
 * consume), real pressure followed, and the healer owner's first defensive
 * reaction came late or never. Corpus-empirical (200 matches / 898
 * healer-owner rounds, `packages/desktop/scripts/tmp-slowdef-rates.mts` —
 * evaluated then deleted):
 *  - Pressure gate is the window's own `damageRatio` (damage RATE vs the
 *    match average, computed by reconstructEnemyCDTimeline itself), NOT an
 *    absolute threshold: 95.7% of all burst windows clear 300k absolute
 *    damage over their span (p50 span 21.6s), so absolute damage has no
 *    discriminating power at window scale — while `damageRatio >= 1.5`
 *    selects 20.2% of windows. (The two fixed-width predicates this repo
 *    already has — timelineHelpers' DMG_SPIKE_THRESHOLD 300k over 10s(此前写作 15s,与 computePressureWindows 的默认窗口不符 —— 2026-08-23 更正)
 *    buckets and cooldowns' TIMING_SPIKE_THRESHOLD 50k over 3s — judge
 *    fixed-span facts and were deliberately not reused for this
 *    variable-span window fact; see BACKLOG #21.)
 *  - Reaction delay under that gate (tool available + owner not CC'd at
 *    window start): p50=6.9s, p75=12.1s, no-reaction-at-all 14.6%. The
 *    threshold is 8s (~p66) because a 3s or 5s door would flag the MEDIAN
 *    observed reaction as a mistake — the exact failure mode cc-held's
 *    rejected 60s door had (normal rhythm flooding in as findings).
 *  - Open rate at 8s-or-none: 7.6% of rounds (72 events) before the dedupe
 *    gate — between healing-gap's 5.3% and cc-avoidable's 9.3% precedents.
 *  - 70.8% of those events sit within ±10s of an existing candidate
 *    (death-setup / cc-locked / cc-avoidable / wasted-trinket / ...), above
 *    the 64.3% line that mandated cc-avoidable's dedupe gate — so this type
 *    carries the same kind of gate: windows already covered nearby by
 *    another candidate are left to that type.
 *  - A hard CC cast on an enemy counts as a reaction (the conservative
 *    direction: a healer answering the opener with CC on the attacker must
 *    not be accused of "no response"). Measured, including CC narrows
 *    no-reaction from 20.8% to 14.6%.
 */
export const SLOW_DEF_RESPONSE_MIN_RATIO = 1.5;
export const SLOW_DEF_RESPONSE_MAX_DELAY_S = 8;
// at-cap 体检(2026-08-26):1/29(3%),惰性。
const SLOW_DEF_RESPONSE_CAP = 2;
/** Dedupe slack (seconds) either side of the burst window when checking
 * whether another candidate already covers this moment — the same ±10s the
 * corpus overlap measurement used. */
export const SLOW_DEF_RESPONSE_DEDUP_SLACK_S = 10;
/** Candidate types whose nearby presence suppresses slow-defensive-response
 * (the overlap family the corpus scan measured at 70.8%). */
export const SLOW_DEF_RESPONSE_OVERLAP_TYPES: ReadonlySet<string> = new Set([
  "death-setup",
  "external-unused",
  "questionable-external",
  "cc-avoidable",
  "cc-locked",
  "wasted-trinket",
  "position-mistake",
  "kick-eaten",
  "healing-gap",
]);
/** The owner casts that count as a defensive reaction: major personal walls +
 * externals (MAJOR_DEFENSIVE_IDS), the PvP trinket, and mobility
 * (REPOSITIONING_SPELL_IDS) — all existing single-source tables, no new
 * whitelist. Hard CC on an enemy is handled separately (needs target
 * attribution, see firstDefensiveReactionToWindow). */
const SLOW_DEF_REACTION_IDS: ReadonlySet<string> = new Set([
  ...MAJOR_DEFENSIVE_IDS,
  ...trinketSpellIds,
  ...REPOSITIONING_SPELL_IDS.keys(),
]);

/** missed-cleanse mapping (pure function, unit-testable with hand-built
 * fixtures): a high-value CC sat on a teammate too long without being
 * cleansed. Only Critical/High qualify; windows where the cleanse ability was
 * on cooldown are not reported (nothing to coach).
 *
 * Owner dispel-capability gate (2026-08-05, 37/200-match audit): the timeline
 * renderer already refuses to print an [UNCLEANSED DEBUFF] line the log owner
 * couldn't have cleansed themselves (matchTimeline.ts B16, same
 * `canDefensiveCleanse` predicate), but this candidate menu had no equivalent
 * check — a Holy Paladin (no Curse removal) or Discipline Priest (no Curse
 * removal either) got handed "you should have dispelled the Curse" candidates
 * that then produced "your Cleanse"/"your Purify" hallucinations for an
 * ability the owner's class does not have. Verdict when
 * `!canDefensiveCleanse(owner, w.dispelType)`:
 *  - solo shuffle (`isShuffle`): drop the window — a 1v1v1 round has no
 *    teammate to hand the debuff off to, so "call for a dispel" has no
 *    addressee and the candidate has zero coaching value.
 *  - team format (2v2/3v3): keep the window, but tag
 *    `facts.ownerCanDispel="no"` and `facts.eligibleDispellers` (the
 *    teammates who CAN, by spec — same list-building pattern as
 *    buildMatchContext's `teamPurgers`) so the model is steered toward a
 *    "call it out" suggestion instead of blaming the owner for an ability
 *    they don't have (guard note in buildFindingsPrompt's CHAIN_LEGENDS).
 */
export function missedCleanseEvents(
  windows: Pick<
    IMissedCleanseWindow,
    | "timeSeconds"
    | "durationSeconds"
    | "targetName"
    | "spellName"
    | "spellId"
    | "priority"
    | "postCcDamage"
    | "cleanseWasOnCD"
    | "dispellersLockedOut"
    | "losReachable"
    | "drChainRisk"
    | "dispelType"
    | "lateDispelSeconds"
  >[],
  owner: any,
  friends: any[],
  isShuffle: boolean,
  // #34(b2) 2026-08-23 (user-ruled): when provided, each window gains
  // ownerCasting* facts describing what the owner was hard-casting during it,
  // so the coach can phrase "you chose Y for these N seconds" instead of the
  // false "you idly missed X". Optional so older callers/tests are untouched;
  // absent ⇒ no facts (unknown, not "idle").
  occupancy?: { enemyIds: Set<string>; matchStartMs: number },
): CandidateEvent[] {
  return windows
    .filter(
      (w) =>
        (w.priority === "Critical" || w.priority === "High") &&
        !w.cleanseWasOnCD &&
        // Feasibility gate (2026-08-02): windows where the dispellers were
        // CC'd/locked out with no reaction window, or where position data
        // exists and everyone was out of range / had no line of sight, do not
        // enter the coaching menu — there is nothing to coach. losReachable
        // === null (no position data) never flips the verdict; the tri-state
        // is an iron rule.
        !w.dispellersLockedOut &&
        w.losReachable !== false &&
        // Owner capability gate: solo shuffle has nobody to hand this off to.
        (canDefensiveCleanse(owner, w.dispelType) || !isShuffle),
    )
    .sort((a, b) => b.postCcDamage - a.postCcDamage)
    .slice(0, MISSED_CLEANSE_CAP)
    .map((w) => {
      const ownerCanDispel = canDefensiveCleanse(owner, w.dispelType);
      const occ = occupancy
        ? hardCastOccupancyWithin(
            owner,
            occupancy.enemyIds,
            occupancy.matchStartMs + w.timeSeconds * 1000,
            occupancy.matchStartMs + (w.timeSeconds + w.durationSeconds) * 1000,
          )
        : null;
      // Rendering floor anchored to the rendered value itself: attach only
      // when the one-decimal rendering is non-zero. Zero is also what a
      // window full of instants looks like (instants emit no CAST_START), so
      // zero must never be shown — it would read as "was idle".
      const occS = occ ? (occ.occupiedMs / 1000).toFixed(1) : "0.0";
      return {
        id: `missed-cleanse:${w.targetName}:${Math.round(w.timeSeconds)}`,
        type: "missed-cleanse",
        t: w.timeSeconds,
        unitNames: [w.targetName],
        spell: w.spellName,
        spellId: w.spellId,
        facts: {
          t: fmt(w.timeSeconds),
          target: w.targetName,
          cc: w.spellName,
          duration: w.durationSeconds.toFixed(1),
          priority: w.priority,
          postCcDamageK: (w.postCcDamage / 1000).toFixed(0),
          // Value gate d: DR was fully fresh and the target did get re-CC'd
          // afterwards — the coach must phrase this as a cautious suggestion,
          // not as blame for a mistake (the timeline row carries the same
          // annotation, keeping both channels consistent).
          drChainRisk: w.drChainRisk ? "yes" : "no",
          dispelType: w.dispelType,
          // #34(b2): what the owner's hands were doing during the window.
          // preCommitted "yes" = a counted cast started BEFORE the window
          // opened (couldn't have known); "no" = every counted cast started
          // after it (a priority choice — coach it as the choice it was).
          ...(occ && occS !== "0.0"
            ? {
                ownerCastingS: occS,
                ownerCastingSpells: joinSpellCounts(occ.spellNames),
                ownerCastingPreCommitted: occ.startedBeforeWindow
                  ? "yes"
                  : "no",
              }
            : {}),
          // DISPEL-002 (2026-08-06): set only on the lateCleanseWindows slice
          // (a cleanse DID land, just late) — undefined for ordinary "never
          // cleansed" windows, so this key is entirely absent from their
          // facts rather than rendering a misleading "latencyS=0".
          ...(w.lateDispelSeconds !== undefined
            ? { latencyS: String(Math.round(w.lateDispelSeconds)) }
            : {}),
          ...(ownerCanDispel
            ? {}
            : {
                ownerCanDispel: "no",
                eligibleDispellers:
                  friends
                    .filter(
                      (f) =>
                        f.id !== owner.id &&
                        canDefensiveCleanse(f, w.dispelType),
                    )
                    .map((f) => specToString(f.spec))
                    .join(", ") || "no one on your team",
              }),
        },
      };
    });
}

/** "精神控制, 精神控制, 快速治疗" → "精神控制×2, 快速治疗" */
function joinSpellCounts(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(", ");
}

/** missed-purge mapping (pure function): a high-value enemy buff ran its full
 * duration without being purged. Only Critical/High, or windows falling inside
 * one of our kill windows, are reported; windows where purge was on cooldown
 * are not. */
export function missedPurgeEvents(
  windows: Pick<
    IMissedPurgeWindow,
    | "timeSeconds"
    | "durationSeconds"
    | "enemyName"
    | "spellName"
    | "spellId"
    | "priority"
    | "purgeWasOnCD"
    | "duringKillWindow"
    | "purgersLockedOut"
    | "losReachable"
  >[],
): CandidateEvent[] {
  return windows
    .filter(
      (w) =>
        !w.purgeWasOnCD &&
        // Feasibility gate (same as on the cleanse side): CC'd/locked out, or
        // data exists and nobody could reach → keep it out of the menu
        !w.purgersLockedOut &&
        w.losReachable !== false &&
        (w.priority === "Critical" ||
          w.priority === "High" ||
          w.duringKillWindow === true),
    )
    .sort(
      (a, b) =>
        Number(b.duringKillWindow ?? false) -
          Number(a.duringKillWindow ?? false) ||
        b.durationSeconds - a.durationSeconds,
    )
    .slice(0, MISSED_PURGE_CAP)
    .map((w) => ({
      id: `missed-purge:${w.enemyName}:${Math.round(w.timeSeconds)}`,
      type: "missed-purge",
      t: w.timeSeconds,
      unitNames: [w.enemyName],
      spell: w.spellName,
      spellId: w.spellId,
      facts: {
        t: fmt(w.timeSeconds),
        enemy: w.enemyName,
        buff: w.spellName,
        duration: w.durationSeconds.toFixed(1),
        priority: w.priority,
        inKillWindow: w.duringKillWindow ? "yes" : "no",
      },
    }));
}

/** cc-locked mapping (pure function): the owner themselves ate a hard CC of
 * >=CC_LOCKED_MIN_S seconds. trinketState goes straight into facts — "sat
 * through it with the trinket in hand" and "sat through it with the trinket on
 * cooldown" are two different coaching points, and the model distinguishes
 * them by that state. */
export function ccLockedEvents(
  instances: Pick<
    ReturnType<typeof analyzePlayerCCAndTrinket>["ccInstances"][number],
    | "atSeconds"
    | "durationSeconds"
    | "spellName"
    | "spellId"
    | "sourceName"
    | "trinketState"
    | "breakRacialName"
    | "damageTakenDuring"
  >[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  return instances
    .filter((cc) => cc.durationSeconds >= CC_LOCKED_MIN_S)
    .sort((a, b) => b.damageTakenDuring - a.damageTakenDuring)
    .slice(0, CC_LOCKED_CAP)
    .map((cc) => ({
      id: `cc-locked:${owner.id}:${Math.round(cc.atSeconds)}`,
      type: "cc-locked",
      t: cc.atSeconds,
      unitNames: [owner.name, cc.sourceName],
      spell: cc.spellName,
      spellId: cc.spellId,
      facts: {
        t: fmt(cc.atSeconds),
        cc: cc.spellName,
        duration: cc.durationSeconds.toFixed(1),
        source: cc.sourceName,
        trinketState: trinketStateFact(cc),
        damageTakenK: (cc.damageTakenDuring / 1000).toFixed(0),
      },
    }));
}

/** kick-eaten mapping (pure function): the owner hard-cast into an enemy
 * interrupt (especially coachable for healers: fake-casting).
 *
 * 排序键:2026-08-20 实测 lockoutDurationSeconds 无信息(840 条全部落在
 * 3–4s),当时挂账「要新的排序谓词,另行立项」—— 2026-08-25 落地为
 * BACKLOG #36(b) 的 `postKick`(被踢后 5s 的行为):idle(整窗零施法,
 * 最该教)排最前,acted(动了但没换学派)次之,switched(换学派打穿
 * 锁定,几乎不用教)最后;同档内按时间。语料锚:切换率跟专精能力上限走
 * (戒律 76–80% vs 神骑 8%),同专精内 idle 率才是可教的那一半。 */
const POST_KICK_SEVERITY: Record<string, number> = {
  idle: 0,
  acted: 1,
  switched: 2,
};

export function kickEatenEvents(
  instances: Pick<
    ReturnType<typeof analyzePlayerCCAndTrinket>["interruptInstances"][number],
    | "atSeconds"
    | "lockoutDurationSeconds"
    | "kickSpellName"
    | "interruptedSpellName"
    | "sourceName"
    | "postKick"
    | "firstActionDelayS"
  >[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  return instances
    .sort(
      (a, b) =>
        (POST_KICK_SEVERITY[a.postKick] ?? 3) -
          (POST_KICK_SEVERITY[b.postKick] ?? 3) || a.atSeconds - b.atSeconds,
    )
    .slice(0, KICK_EATEN_CAP)
    .map((k) => ({
      id: `kick-eaten:${owner.id}:${Math.round(k.atSeconds)}`,
      type: "kick-eaten",
      t: k.atSeconds,
      unitNames: [owner.name, k.sourceName],
      spell: k.interruptedSpellName,
      facts: {
        t: fmt(k.atSeconds),
        interrupted: k.interruptedSpellName,
        kick: k.kickSpellName,
        source: k.sourceName,
        lockout: k.lockoutDurationSeconds.toFixed(1),
        // BACKLOG #36(b): the behavior fact the model can actually coach on.
        postKick:
          k.postKick === "idle"
            ? "no cast for 5s after the kick"
            : k.postKick === "switched"
              ? `kept playing through the lockout (other school, first cast ${k.firstActionDelayS?.toFixed(1) ?? "?"}s later)`
              : `waited out the lockout (first cast ${k.firstActionDelayS?.toFixed(1) ?? "?"}s later)`,
      },
    }));
}

/** Neutral-HP line for wasted-trinket (arenacoach TRINKET-001: "everyone at
 * high health"; their catalog gives no exact number, so we take 80% and
 * calibrated it against the corpus in Task 6). */
export const TRINKET_NEUTRAL_HP_PCT = 80;

/** wasted-trinket dedupe gap (seconds): dirty logs occasionally record the
 * same trinket press twice (e.g. 42.1 and 42.4, sometimes even across a second
 * boundary at 42.1/43.2). The shortest PvP trinket cooldown is far longer than
 * this value, so neighboring records must be dirty duplicates of one action
 * rather than two independent presses — drop anything less than this gap from
 * the previously kept timestamp (adopted from agy flash review: same-second
 * records used to silently overwrite each other in auditFindings' byId Map,
 * and cross-second records made the coach nag twice about one action). */
export const TRINKET_DEDUPE_GAP_S = 30;

/**
 * wasted-trinket mapping (pure function, probes injected): the owner popped
 * the PvP trinket in an obviously neutral situation (whole team at high HP,
 * healer not CC'd, no enemy offensive cooldown active) — arenacoach
 * TRINKET-001. All three probes mirror the gate's single-source predicates:
 * the caller wires friendlyHpPctAt to getUnitHpAtTimestamp +
 * HP_SAMPLE_RADIUS_MS, and healerInCCAt / enemyOffensiveActiveAt to the
 * existing output of analyzePlayerCCAndTrinket / reconstructEnemyCDTimeline;
 * see the wiring in teamPlayEvents.
 *
 * Severity field / cap (TEMPORARY, BACKLOG #22, see the constant block
 * above): this type has no damage-based severity metric — a wasted trinket is
 * a spent-resource judgment, not a damage event — so `teamMinHpPct` (the
 * team's lowest HP% at the press, already gathered for the neutral-situation
 * gate) doubles as the ordering key: the higher it is, the more unambiguously
 * neutral the moment was, i.e. the more clearly a "wasted" press rather than a
 * borderline call right at the 80% gate. Ties keep insertion (chronological)
 * order, since Array.prototype.sort is stable.
 */
export function wastedTrinketEvents(
  trinketUseTimes: number[],
  owner: { id: string; name: string },
  probes: {
    /** Lowest HP% across all friendly players at time t; if any of them can't
     * be sampled → null (conservatively emit nothing). */
    friendlyHpPctAt: (t: number) => number | null;
    healerInCCAt: (t: number) => boolean;
    enemyOffensiveActiveAt: (t: number) => boolean;
  },
): CandidateEvent[] {
  const dedupedTimes: number[] = [];
  for (const t of [...trinketUseTimes].sort((a, b) => a - b)) {
    const prev = dedupedTimes[dedupedTimes.length - 1];
    if (prev !== undefined && t - prev < TRINKET_DEDUPE_GAP_S) continue;
    dedupedTimes.push(t);
  }
  const candidates: Array<{ t: number; minHp: number }> = [];
  for (const t of dedupedTimes) {
    const minHp = probes.friendlyHpPctAt(t);
    if (minHp === null || minHp < TRINKET_NEUTRAL_HP_PCT) continue;
    if (probes.healerInCCAt(t)) continue;
    if (probes.enemyOffensiveActiveAt(t)) continue;
    candidates.push({ t, minHp });
  }
  return candidates
    .sort((a, b) => b.minHp - a.minHp)
    .slice(0, WASTED_TRINKET_CAP)
    .map(({ t, minHp }) => ({
      id: `wasted-trinket:${owner.id}:${Math.round(t)}`,
      type: "wasted-trinket",
      t,
      unitNames: [owner.name],
      facts: { t: fmt(t), unit: owner.name, teamMinHpPct: fmt(minHp) },
    }));
}

/**
 * Wiring helper for wasted-trinket: the team's lowest HP% at time t (gate
 * predicate IS the spec, see CLAUDE.md). The HP query timestamp must first be
 * snapped to the render grid (whole seconds) via `toRenderSecond(t)` before
 * sampling — using the raw fractional seconds from trinketUseTimes would
 * conflict with the whole-second [STATE] tick view (two contradictory HP
 * numbers under the same displayed second: the class-A bug from the
 * 2026-07-20 audit, see the comment on `toRenderSecond`). `hpLookup` defaults
 * to `getUnitHpAtTimestamp`; it is exported and injectable so tests can pin
 * the "query timestamp is already a render second" behavior directly instead
 * of guessing at it.
 */
export function trinketTeamMinHpPctAt(
  friends: any[],
  combat: { startTime: number },
  t: number,
  hpLookup: (
    unit: any,
    timestampMs: number,
    maxDtMs: number,
  ) => number | null = getUnitHpAtTimestamp,
): number | null {
  let min = 100;
  for (const f of friends) {
    const hp = hpLookup(
      f,
      combat.startTime + toRenderSecond(t) * 1000,
      HP_SAMPLE_RADIUS_MS, // single-source predicate: same radius as the gate
    );
    if (hp === null) return null;
    min = Math.min(min, hp);
  }
  return min;
}

/**
 * healing-gap mapping (HEAL-001, pure function): the healer owner produced no
 * heal/cast for a stretch while a teammate was under real pressure AND had
 * enough un-CC'd free time to have realistically cast (detectHealingGaps'
 * own three gates — see healingGaps.ts). This mapper adds one more door on
 * top: `freeCastSeconds >= HEAL_GAP_FREE_MIN_S` and `mostDamagedAmount > 0`
 * (a pressured teammate actually took damage, not just "someone was
 * theoretically in range"). Corpus-measured: detectHealingGaps' own gates
 * already produce a thin signal (117 raw gaps / 898 healer rounds); this
 * door roughly halves it again to 54/48 rounds (5.3%) — see the const block
 * above for the full empirical citation.
 */
export function healingGapEvents(
  gaps: Pick<
    IHealingGap,
    | "fromSeconds"
    | "toSeconds"
    | "durationSeconds"
    | "freeCastSeconds"
    | "mostDamagedName"
    | "mostDamagedSpec"
    | "mostDamagedAmount"
  >[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  return gaps
    .filter(
      (g) =>
        g.freeCastSeconds >= HEAL_GAP_FREE_MIN_S && g.mostDamagedAmount > 0,
    )
    .sort((a, b) => b.mostDamagedAmount - a.mostDamagedAmount)
    .slice(0, HEALING_GAP_CAP)
    .map((g) => {
      const t = toRenderSecond(g.fromSeconds);
      return {
        id: `healing-gap:${owner.id}:${t}`,
        type: "healing-gap",
        t,
        unitNames: [owner.name, g.mostDamagedName],
        facts: {
          t: String(t),
          durationS: String(Math.round(g.durationSeconds)),
          freeS: String(Math.round(g.freeCastSeconds)),
          pressured: g.mostDamagedName,
          pressuredSpec: g.mostDamagedSpec,
        },
      };
    });
}

/**
 * position-mistake mapping (POSITION-001, pure function): the owner's own
 * STAYED_IN / MISSED_PUSH / CD_OUT_OF_RANGE events from
 * `computeOwnerPositionEvents` — the same `POSITION_MISTAKES` allowlist and
 * `stayedInHadRealCost` gate deepDive.ts's teachable-signal filter uses
 * (single-source predicate; see predicate-index.md). Three-state discipline:
 * `computeOwnerPositionEvents` itself returns `[]` when the owner has no
 * advanced-logging position data, and this mapper adds nothing on top of
 * that — an empty `events` array here means "no position data" or "no
 * mistakes found", never a fabricated zero.
 *
 * MISSED_PUSH / CD_OUT_OF_RANGE measured 0/0 on this (healer-heavy) corpus —
 * kept in the allowlist rather than special-cased out, both because they are
 * forward-looking for non-healer owners (e.g. `fetch-pvp-logs` DPS corpora)
 * and because dropping them would be a second, redundant copy of
 * `POSITION_MISTAKES` (the CLAUDE.md predicate-index rule: consume the Set,
 * don't re-derive a narrower one).
 */
export function positionMistakeEvents(
  events: Pick<
    IPositionEvent,
    | "type"
    | "atSeconds"
    | "nearestEnemyName"
    | "ownerHpStartPct"
    | "ownerHpMinPct"
    | "spellName"
    | "startDistanceYards"
  >[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  return events
    .filter((e) => POSITION_MISTAKES.has(e.type))
    .filter(
      (e) =>
        e.type !== "STAYED_IN" ||
        stayedInHadRealCost(e.ownerHpMinPct ?? null, e.ownerHpStartPct ?? null),
    )
    .sort((a, b) => (a.ownerHpMinPct ?? 101) - (b.ownerHpMinPct ?? 101))
    .slice(0, POSITION_MISTAKE_CAP)
    .map((e) => {
      const t = toRenderSecond(e.atSeconds);
      const kind =
        e.type === "STAYED_IN"
          ? "stayed-in"
          : e.type === "MISSED_PUSH"
            ? "missed-push"
            : "cd-out-of-range";
      const facts: Record<string, string> = { t: String(t), kind };
      if (e.nearestEnemyName) facts.enemy = e.nearestEnemyName;
      if (e.ownerHpStartPct != null)
        facts.hpStart = String(Math.round(e.ownerHpStartPct));
      if (e.ownerHpMinPct != null)
        facts.hpMin = String(Math.round(e.ownerHpMinPct));
      if (e.spellName) facts.spell = e.spellName;
      if (e.startDistanceYards != null)
        facts.dist = String(Math.round(e.startDistanceYards));
      return {
        id: `position-mistake:${owner.id}:${t}:${kind}`,
        type: "position-mistake",
        t,
        unitNames: [
          owner.name,
          ...(e.nearestEnemyName ? [e.nearestEnemyName] : []),
        ],
        ...(e.spellName ? { spell: e.spellName } : {}),
        facts,
      };
    });
}

/**
 * cc-held mapping (COOLDOWN-001, pure function): the owner's own CC major
 * cooldown (`ccSpellIds` — the same set `matchTimeline.ts` uses to label
 * `[YOU] [CC]`) sat available for `>= CC_HELD_MIN_S` continuously
 * (`IMajorCooldownInfo.availableWindows`, the identical predicate `cd-waste`
 * consumes for defensives). Three-state: an owner with no CC major in their
 * tracked kit (`cds` has no id in `ccSpellIds`) naturally produces zero
 * candidates, not a fabricated "held nothing".
 */
export function ccHeldEvents(
  cds: Pick<IMajorCooldownInfo, "spellId" | "spellName" | "availableWindows">[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  const candidates: Array<{
    spellId: string;
    spellName: string;
    window: IAvailableWindow;
  }> = [];
  for (const cd of cds) {
    if (!ccSpellIds.has(cd.spellId)) continue;
    for (const w of cd.availableWindows) {
      if (w.durationSeconds >= CC_HELD_MIN_S) {
        candidates.push({
          spellId: cd.spellId,
          spellName: cd.spellName,
          window: w,
        });
      }
    }
  }
  return candidates
    .sort((a, b) => b.window.durationSeconds - a.window.durationSeconds)
    .slice(0, CC_HELD_CAP)
    .map(({ spellId, spellName, window }) => {
      const t = toRenderSecond(window.fromSeconds);
      const windowEndT = toRenderSecond(window.toSeconds);
      return {
        id: `cc-held:${owner.id}:${spellId}:${t}`,
        type: "cc-held",
        t,
        unitNames: [owner.name],
        spell: spellName,
        spellId,
        facts: {
          t: String(t),
          spell: spellName,
          heldS: String(Math.round(window.durationSeconds)),
          windowEndT: String(windowEndT),
        },
      };
    });
}

/**
 * cc-avoidable wiring helper (DEFENSIVE-001): for one full-DR CC instance the
 * owner ate, return the display names of avoidance tools that were BOTH
 * (a) in the owner's kit — cast at least once anywhere in the match (the
 * "the class doesn't even have this spell" guard the 2026-08-01 "candidate
 * gate bypass" incident taught: a spec without an ability must never be
 * blamed for not pressing it) — and (b) off cooldown at the moment the CC
 * landed. Availability reuses `cdAvailableAt`, the single-source predicate
 * cd-waste / cc-held / death-unused-defensive already consume — this
 * function only adapts an ad hoc spell's raw cast history into the
 * `{casts, cooldownSeconds, neverUsed}` shape `cdAvailableAt` expects,
 * exactly like `extractMajorCooldowns` would for a spell it tracks. A cast
 * that happens AFTER the CC still counts as kit evidence (proves the spec
 * had the button) while leaving the pre-CC availability check untouched —
 * `cdAvailableAt` itself only looks at casts at-or-before `cc.atSeconds`.
 * Iteration order of `applicableCCAvoidanceIds` (insertion order of the two
 * underlying Maps) makes the returned list deterministic.
 */
export function ccAvoidanceOptionsAt(
  owner: {
    spec?: string;
    info?: { talents?: unknown; pvpTalents?: string[] };
    spellCastEvents: Array<{
      spellId?: string;
      logLine: { event: string; timestamp: number };
    }>;
  },
  cc: { atSeconds: number; spellId: string; spellName: string },
  matchStartMs: number,
): string[] {
  // Talent-aware cooldowns (2026-08-18, user ruling 「这些数值要做成活的,根据
  // 玩家的天赋适应」). This used to read the RAW base cooldown out of
  // `spellEffectData`, while `extractMajorCooldowns` — the only other place
  // answering "is this ability off cooldown at t" — ran the same number
  // through `applyCdTalentModifiers` first. One fact, two answers: a Monk who
  // took Celerity has Roll at 3 charges / 15s, not the table's 2 / 20s, and
  // this function would still judge availability on the base numbers. Both
  // now go through the same predicate, and it adapts per player — a modifier
  // applies only when THAT player actually took THAT talent (regular, hero or
  // PvP). `spec` absent (hand-built test fixtures) degrades to base values,
  // exactly the old behaviour.
  const { talentedSpellIds, pvpTalentIds } =
    owner.spec !== undefined
      ? playerTalentIdSets(
          owner as unknown as Parameters<typeof playerTalentIdSets>[0],
        )
      : { talentedSpellIds: null, pvpTalentIds: new Set<string>() };
  const triggers = getTalentAvoidanceTriggers();
  const out: string[] = [];
  for (const id of applicableCCAvoidanceIds(cc.spellId, cc.spellName)) {
    // Proc-style immunities (Nullifying Shroud ← Verdant Embrace, Phase Shift
    // ← Fade, Psychic Shroud ← Psychic Scream, Peaceweaver ← Revival/Restoral)
    // have no cast events of their own, so BOTH the kit-evidence gate and the
    // availability check must run against the trigger ability. Everything else
    // resolves to itself.
    //
    // TALENT GATE — non-negotiable for the proc entries. `TALENT_BEHAVIORS`
    // calls these buffs "self-gating: the aura only exists when the talent is
    // taken", and that WAS true while the check keyed on the buff's own casts
    // (no talent → no buff → no casts → never credited). Resolving to the
    // trigger destroys that property, because the triggers are BASELINE
    // abilities every such spec owns — every priest casts Fade and Psychic
    // Scream whether or not they took Phase Shift / Psychic Shroud. Measured
    // on n=300 before this gate existed: of the proc tools cited by
    // cc-avoidable, 303 citations belonged to players who had NOT taken the
    // talent (Psychic Shroud alone: 287 of 361 = 79.5%). Requires CONFIRMED
    // presence in `pvpTalents` — absent COMBATANT_INFO reads as "cannot
    // confirm" and withholds the tool, since crediting a tool the player may
    // not own turns straight into an accusation.
    const proc = triggers.get(id);
    if (proc && !pvpTalentIds.has(proc.talentSpellId)) continue;
    const resolvedIds = proc?.triggerSpellIds ?? [id];
    let available = false;
    for (const rid of resolvedIds) {
      const eff = spellEffectData[rid];
      const baseCd =
        eff?.cooldownSeconds ?? eff?.charges?.chargeCooldownSeconds ?? null;
      if (baseCd === null) continue; // unknown CD, don't guess
      const { cooldownSeconds, charges } = applyCdTalentModifiers(
        rid,
        baseCd,
        eff?.charges?.charges ?? 1,
        talentedSpellIds,
        pvpTalentIds,
      );
      const castTimes = owner.spellCastEvents
        .filter(
          (e) =>
            e.spellId === rid &&
            e.logLine.event === LogEvent.SPELL_CAST_SUCCESS,
        )
        .map((e) => (e.logLine.timestamp - matchStartMs) / 1000);
      if (castTimes.length === 0) continue; // kit-evidence gate
      // Charge-aware availability through the shared `chargesAvailableAt`
      // simulation — charges recharge SEQUENTIALLY, so a sliding-window count
      // over-reports (see that function's doc comment for the case cross-AI
      // review caught). Reduces exactly to `cdAvailableAt`'s "last cast + cd
      // <= t" at one charge, so single-charge tools are unaffected; needed
      // because the talents that matter here are charge talents (Celerity +1
      // Roll, Aerial Mastery +1 Hover, Wings of Liberty +1 Verdant Embrace).
      if (
        chargesAvailableAt(castTimes, cooldownSeconds, charges, cc.atSeconds) >
        0
      ) {
        available = true;
        break;
      }
    }
    if (!available) continue;
    out.push(
      CC_AVOIDANCE_BUFF_SPELLS.get(id) ?? REPOSITIONING_SPELL_IDS.get(id) ?? id,
    );
  }
  return out;
}

/**
 * cc-avoidable mapping (DEFENSIVE-001, pure function, probe injected): the
 * owner (a healer — gated by the caller, see teamPlayEvents) ate a hard CC at
 * Full DR lasting >= CC_AVOIDABLE_MIN_S seconds, and at least one avoidance
 * tool (`avoidableWithAt`, wired to `ccAvoidanceOptionsAt` in production) was
 * evidenced-and-available before it landed.
 *
 * Dedupe gate (2026-08-07 empirical, `.defensive-rates-report.md` —— 原始报告已不在盘上,
 * 见上方 DEFENSIVE-001 块的说明): 64.3% of
 * the raw hit events also had `trinketState === "available_unused"` — a fact
 * that was then coached by cc-locked / wasted-trinket, so firing here too
 * would double-charge one instant and silently evade the per-round candidate
 * caps (BACKLOG #22's whole point).
 *
 * 2026-08-19 复测(GH #14 B 组,n=300/1178,替代上面那份不可复现的 64.3% 作为
 * 本门的现行依据):本类型机会归一化后方向正确 —— 触发 胜 29.3% vs 负 38.9%
 * (+9.6pp),转化率(真用了规避 ÷ 有工具的总机会)胜 43.9% vs 负 36.2%
 * (+7.7pp);#29 天赋自适应扩容(271→625)后构成以天赋 proc 工具为主
 * (Phase Shift 46%),天赋门有效。数字在 issue #14 关账评论。
 *
 * 2026-08-19 (GH #14): cc-locked has since been retired, so "left to cc-locked"
 * no longer applies — but the gate DELIBERATELY stays. The retirement scan
 * showed the "trinket in hand, sat through it" framing has REVERSE win/loss
 * conversion (winners hold the trinket more), so routing those instances into
 * cc-avoidable would re-open the exact accusation the data killed. The gate's
 * meaning is now "the available_unused story is unvalidated as a mistake",
 * not "another type covers it"; cc-avoidable still only fires on the
 * excuse-free "you had a DIFFERENT, non-trinket tool ready" story.
 */
/** Window before a CC application in which its cast must have started to
 * count as "you saw it coming". Covers the longest PvP CC cast (Polymorph /
 * Hex / Cyclone are all ≤ 2s after haste) plus travel/latency slack. */
export const CC_HARD_CAST_LOOKBACK_S = 4;

/** Did any enemy (or enemy pet) visibly begin casting this CC before it landed?
 * Evidence-only: a log without the cast start yields false, so the caller
 * declines to accuse rather than assuming. */
export function wasCcHardCastAt(
  enemies: ICombatUnit[],
  enemyPets: ICombatUnit[],
  cc: { atSeconds: number; spellId: string },
  matchStartMs: number,
): boolean {
  const atMs = matchStartMs + cc.atSeconds * 1000;
  for (const u of [...enemies, ...enemyPets]) {
    for (const start of u.castStartEvents ?? []) {
      if (String(start.spellId) !== String(cc.spellId)) continue;
      const dt = atMs - start.timestamp;
      if (dt >= 0 && dt <= CC_HARD_CAST_LOOKBACK_S * 1000) return true;
    }
  }
  return false;
}

export function ccAvoidableEvents(
  instances: Pick<
    ICCInstance,
    | "atSeconds"
    | "durationSeconds"
    | "spellName"
    | "spellId"
    | "trinketState"
    | "drInfo"
  >[],
  owner: { id: string; name: string },
  avoidableWithAt: (cc: {
    atSeconds: number;
    spellId: string;
    spellName: string;
  }) => string[],
  /** Did the enemy visibly START a cast of this CC before it landed? The
   * accusation is "you could have REACTED", so an instant leaves nothing to
   * react to. Absent evidence → no accusation (see the reactability note). */
  wasHardCastAt: (cc: { atSeconds: number; spellId: string }) => boolean,
): CandidateEvent[] {
  const candidates: Array<{
    cc: (typeof instances)[number];
    avoid: string[];
  }> = [];
  for (const cc of instances) {
    if (cc.durationSeconds < CC_AVOIDABLE_MIN_S) continue;
    if (cc.drInfo?.level !== "Full") continue;
    if (cc.trinketState === "available_unused") continue;
    // Reactability gate (2026-08-22, corpus adjudication): the prompt tells the
    // model to coach "reacting with one of these tools next time", and you
    // cannot react to an instant. Measured over ~390 sampled instances of the
    // 12.1 archive, ~75% of what this type accused were instants (Hammer of
    // Justice, Freezing Trap, Psychic Scream, Kidney Shot…), and the share was
    // FLAT across rating (26/30/23/28% hard-cast from 2400+ down to <1600) —
    // so this was not a high-rating artifact but a standing demand for
    // precognition. Firing only on a seen cast bar keeps the subset where
    // "react next time" is literally true; no cast-start evidence in the log
    // means no accusation, never an assumed one.
    if (!wasHardCastAt(cc)) continue;
    const avoid = avoidableWithAt(cc);
    if (avoid.length === 0) continue;
    candidates.push({ cc, avoid });
  }
  return candidates
    .sort((a, b) => b.cc.durationSeconds - a.cc.durationSeconds)
    .slice(0, CC_AVOIDABLE_CAP)
    .map(({ cc, avoid }) => {
      const t = toRenderSecond(cc.atSeconds);
      return {
        id: `cc-avoidable:${owner.id}:${cc.spellId}:${t}`,
        type: "cc-avoidable",
        t,
        unitNames: [owner.name],
        spell: cc.spellName,
        spellId: cc.spellId,
        facts: {
          t: String(t),
          spell: cc.spellName,
          durationS: String(Math.round(cc.durationSeconds)),
          avoidableWith: avoid.join("、"),
          castBarSeen: "yes",
        },
      };
    });
}

/**
 * slow-defensive-response wiring helper (DEFENSIVE-003): the owner's first
 * defensive reaction to one enemy burst window. A reaction is a
 * SPELL_CAST_SUCCESS of a SLOW_DEF_REACTION_IDS spell, OR a hard CC
 * (`ccSpellIds`) cast on an enemy — inside [fromSeconds - PRE_WALL_SECONDS,
 * toSeconds] (the identical pre-wall grace annotateDefensiveTimings applies
 * when labelling a defensive "Early"; shared via the exported constant, never
 * a second 5).
 *
 * Every comparison and the returned delay live on the RENDER GRID
 * (`toRenderSecond`, whole seconds — CLAUDE.md's "floor to the rendered grid
 * before any judgement" rule): the timeline prompt renders both the window
 * bounds and the owner's casts as floored seconds, so judging on raw
 * fractional seconds would let facts.delayS contradict what the same prompt
 * visibly shows (e.g. cast rendered at :60 inside a window rendered :40–:60,
 * yet "no reaction" claimed because raw 60.5 > raw 60.2 — agy flash review
 * finding, adopted 5/5).
 *
 * Returns null when no reaction fell in that span; `delayS: -1` when the
 * first reaction preceded the window start (a pre-wall — the owner saw it
 * coming, nothing to coach); otherwise the whole-second delay from rendered
 * window start to rendered reaction.
 */
export function firstDefensiveReactionToWindow(
  owner: {
    spellCastEvents: Array<{
      spellId?: string;
      destUnitId?: string;
      logLine: { event: string; timestamp: number };
    }>;
  },
  enemyIds: ReadonlySet<string>,
  window: { fromSeconds: number; toSeconds: number },
  matchStartMs: number,
): { delayS: number; spellName: string } | null {
  const fromR = toRenderSecond(window.fromSeconds);
  const toR = toRenderSecond(window.toSeconds);
  let best: { tR: number; spellId: string } | null = null;
  for (const e of owner.spellCastEvents ?? []) {
    if (e.logLine?.event !== LogEvent.SPELL_CAST_SUCCESS || !e.spellId)
      continue;
    const isDefensive = SLOW_DEF_REACTION_IDS.has(e.spellId);
    const isCcOnEnemy =
      ccSpellIds.has(e.spellId) &&
      e.destUnitId !== undefined &&
      enemyIds.has(e.destUnitId);
    if (!isDefensive && !isCcOnEnemy) continue;
    const tR = toRenderSecond((e.logLine.timestamp - matchStartMs) / 1000);
    if (tR < fromR - PRE_WALL_SECONDS || tR > toR) continue;
    if (!best || tR < best.tR) best = { tR, spellId: e.spellId };
  }
  if (!best) return null;
  const spellName =
    spellEffectData[best.spellId]?.name ??
    REPOSITIONING_SPELL_IDS.get(best.spellId) ??
    best.spellId;
  return {
    delayS: best.tR < fromR ? -1 : best.tR - fromR,
    spellName,
  };
}

/**
 * slow-defensive-response mapping (DEFENSIVE-003, pure function, probes
 * injected): the enemy opened a pressured burst window (damageRatio >=
 * SLOW_DEF_RESPONSE_MIN_RATIO) while the owner had a defensive tool off
 * cooldown and was not CC'd at window start, and the owner's first defensive
 * reaction came more than SLOW_DEF_RESPONSE_MAX_DELAY_S seconds in — or never
 * came at all. See the constant block above for the full corpus evidence
 * behind every door.
 *
 * Fairness gates, all in the "don't accuse" direction:
 *  - a pre-wall reaction (before the window even started) never fires;
 *  - a no-reaction verdict requires the window itself to have lasted at
 *    least the delay threshold — a player given a 6s window is not held to
 *    an 8s standard;
 *  - the dedupe gate leaves moments already covered nearby by another
 *    candidate (SLOW_DEF_RESPONSE_OVERLAP_TYPES ± SLOW_DEF_RESPONSE_DEDUP_SLACK_S)
 *    to that type, mirroring cc-avoidable's gate at the same measured
 *    overlap level.
 */
export function slowDefensiveResponseEvents(
  windows: Pick<
    IAlignedBurstWindow,
    | "fromSeconds"
    | "toSeconds"
    | "damageInWindow"
    | "damageRatio"
    | "activeCDs"
    /** GH #28 遗留项(2026-08-22 结清):这条指控是「敌方爆发起来了,你反应慢」——
     *  「你有工具」必须问的是**对承压的那个人有用的**工具。窗口里本来就带着承压
     *  对象(enemyCDs.ts 按窗口内承伤最高的友方算),此前没接进来,于是压力打在
     *  队友身上时,owner 手里的纯自保 CD 也被算成「你有答案却慢了」。 */
    | "mostPressuredTarget"
  >[],
  owner: { id: string; name: string },
  probes: {
    /** Wired to firstDefensiveReactionToWindow in production. */
    reactionTo: (window: {
      fromSeconds: number;
      toSeconds: number;
    }) => { delayS: number; spellName: string } | null;
    /** Any defensive-tagged major CD off cooldown at t (cdAvailableAt).
     *  `pressuredName`:该窗口里承压最重的友方。生产接线在它不是 owner 本人时
     *  只认 `canHelpAnotherUnit` 通过的 CD —— 自保墙救不了队友(GH #28 同一判据)。
     *  探针吞掉这个参数就等于门没生效,和 cdHoarded 的 onlyUnitName 同一形状。 */
    toolAvailableAt: (tSeconds: number, pressuredName?: string) => boolean;
    /** Owner sitting in hard CC at t (analyzePlayerCCAndTrinket instances). */
    ownerInCCAt: (tSeconds: number) => boolean;
  },
  priorEvents: Pick<CandidateEvent, "type" | "t">[],
): CandidateEvent[] {
  const candidates: Array<{
    w: (typeof windows)[number];
    reaction: { delayS: number; spellName: string } | null;
  }> = [];
  for (const w of windows) {
    if (w.damageRatio < SLOW_DEF_RESPONSE_MIN_RATIO) continue;
    if (!probes.toolAvailableAt(w.fromSeconds, w.mostPressuredTarget?.unitName))
      continue;
    if (probes.ownerInCCAt(w.fromSeconds)) continue;
    const reaction = probes.reactionTo(w);
    if (reaction) {
      if (reaction.delayS === -1) continue; // pre-wall: saw it coming
      if (reaction.delayS <= SLOW_DEF_RESPONSE_MAX_DELAY_S) continue;
    } else if (
      // Rendered span, not the raw difference: the prompt shows floored
      // endpoints, so the "owes a reaction" duration must be the one a
      // reader can recompute from them (renderedWindowSeconds — the indexed
      // predicate for exactly this fact; agy flash review, adopted).
      renderedWindowSeconds(w.fromSeconds, w.toSeconds) <
      SLOW_DEF_RESPONSE_MAX_DELAY_S
    ) {
      continue; // window too short to owe a reaction at all
    }
    // Dedupe on the render grid too: candidate `t`s are (mostly) already
    // floored, so comparing them against raw fractional window bounds would
    // drift the ±slack boundary by up to a second (agy flash review).
    const fromR = toRenderSecond(w.fromSeconds);
    const toR = toRenderSecond(w.toSeconds);
    const covered = priorEvents.some(
      (e) =>
        SLOW_DEF_RESPONSE_OVERLAP_TYPES.has(e.type) &&
        toRenderSecond(e.t) >= fromR - SLOW_DEF_RESPONSE_DEDUP_SLACK_S &&
        toRenderSecond(e.t) <= toR + SLOW_DEF_RESPONSE_DEDUP_SLACK_S,
    );
    if (covered) continue;
    candidates.push({ w, reaction });
  }
  return candidates
    .sort((a, b) => b.w.damageInWindow - a.w.damageInWindow)
    .slice(0, SLOW_DEF_RESPONSE_CAP)
    .map(({ w, reaction }) => {
      const t = toRenderSecond(w.fromSeconds);
      const windowEndT = toRenderSecond(w.toSeconds);
      const enemyCds = [...new Set(w.activeCDs.map((c) => c.spellName))].join(
        "、",
      );
      return {
        id: `slow-defensive-response:${owner.id}:${t}`,
        type: "slow-defensive-response",
        t,
        unitNames: [owner.name],
        spell: w.activeCDs[0]?.spellName,
        spellId: w.activeCDs[0]?.spellId,
        facts: {
          t: String(t),
          windowEndT: String(windowEndT),
          enemyCds,
          damageK: String(Math.round(w.damageInWindow / 1000)),
          dmgRatio: w.damageRatio.toFixed(1),
          ...(reaction
            ? {
                // Production delayS is already a whole rendered-grid second
                // (firstDefensiveReactionToWindow); Math.round only guards a
                // fractional injected test probe.
                delayS: String(Math.round(reaction.delayS)),
                reactSpell: reaction.spellName,
              }
            : { reacted: "none" }),
        },
      };
    });
}

/** Team-play event integration: missed cleanse / missed purge (whole-team
 * scope) plus the owner being CC'd / interrupted. */
function teamPlayEvents(
  combat: any,
  owner: any,
  units: any[],
  ownerCds: IMajorCooldownInfo[],
  priorEvents: Pick<CandidateEvent, "type" | "t">[],
  /** Intent guard (BACKLOG #26 Task 2): threaded down to `cdHoardedEvents`
   * (intent guard, `facts.attempted`) — absent/`available:false` degrades
   * silently. (mana-pressure 的第二个消费点已随该候选退役摘除,2026-08-21。) */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  // Hoisted from the CC-summary try block below so slow-defensive-response
  // (which runs after cc-held/healing-gap to see the full dedupe picture) can
  // reuse them instead of re-reconstructing — BACKLOG #18 already flags the
  // duplicate reconstructEnemyCDTimeline calls as a perf debt.
  let ccSummary: ReturnType<typeof analyzePlayerCCAndTrinket> | null = null;
  let enemyTlShared: ReturnType<typeof reconstructEnemyCDTimeline> | null =
    null;
  const players = units.filter((u) => u.info);
  const friends = players.filter((u) => u.reaction === owner.reaction);
  const enemies = players.filter((u) => u.reaction !== owner.reaction);
  if (friends.length === 0 || enemies.length === 0) return out;
  const friendIds = new Set(friends.map((u) => u.id));
  const enemyIds = new Set(enemies.map((u) => u.id));
  const friendlyPets = units.filter(
    (u) => u.ownerId && friendIds.has(u.ownerId),
  );
  const enemyPets = units.filter((u) => u.ownerId && enemyIds.has(u.ownerId));

  try {
    const ds = reconstructDispelSummary(
      friends,
      enemies,
      combat,
      friendlyPets,
      enemyPets,
    );
    try {
      annotateMissedPurgesWithKillWindows(
        ds.missedPurgeWindows,
        computeOffensiveWindows(enemies, friends, combat),
      );
    } catch {
      /* kill-window annotation failed → duringKillWindow absent; the priority
         filter still applies */
    }
    // Dispellability confidence gate: only report ids the corpus has actually
    // seen dispelled (measured by confidenceAudit: Paralysis / Intimidating
    // Shout / Incapacitating Roar / Blind / Blessing of Sacrifice are flagged
    // Magic in DB2 yet were never observed dispelled across 1245 matches — so
    // "you should have dispelled it" does not hold up against the corpus.
    // After cutting them, both claim types are 100% backed by real observed
    // dispels).
    out.push(
      ...missedCleanseEvents(
        // DISPEL-002 (2026-08-06): lateCleanseWindows (cleansed, but late)
        // rides the same type/cap/sort pipeline as missedCleanseWindows
        // (never cleansed) — concatenated here, distinguished downstream
        // only by the presence of the latencyS fact.
        [...ds.missedCleanseWindows, ...ds.lateCleanseWindows].filter((w) =>
          CORPUS_OBSERVED_DISPEL_IDS.has(w.spellId),
        ),
        owner,
        friends,
        // Single-source predicate: the same bracket string the segmenter
        // stamps on a shuffle round (l2/segmenter.ts) and dampening.ts's own
        // rules table compare against — not a second shuffle judgment.
        combat?.startInfo?.bracket === "Rated Solo Shuffle",
        // #34(b2): lets the windows carry ownerCasting* facts (what the owner
        // was hard-casting during the window). startTime missing ⇒ omitted
        // entirely — the facts must never appear on a guessed clock.
        typeof combat?.startTime === "number"
          ? { enemyIds, matchStartMs: combat.startTime }
          : undefined,
      ),
    );
    if (CANDIDATE_TYPE_FLAGS.missedPurge) {
      out.push(
        ...missedPurgeEvents(
          ds.missedPurgeWindows.filter((w) =>
            CORPUS_OBSERVED_DISPEL_IDS.has(w.spellId),
          ),
        ),
      );
    }
  } catch {
    /* dispel summary not computable → both types absent */
  }

  // missed-sync-window / unsynced-burst (P1 起爆-1/-2, 2026-08-15, Task 4
  // flag-gated wiring): team-wide sync-lens candidates — same scope as
  // missed-cleanse/missed-purge above (not owner-specific; the whole friendly
  // team's offensive economy against the enemy healer's hard-CC windows). See
  // enemyHealerCcWindows' doc comment for the hard-CC category decision.
  // Single source with buildFindingsPrompt.ts's legend gate: both read
  // CANDIDATE_TYPE_FLAGS directly, so a flag flip can never leave a candidate
  // in the menu with no legend (or a legend with no candidate). Both flags
  // are ON since 2026-08-15 (Task 9, user-ruled) — the current expected value
  // of every flag lives in docs/predicate-index.md's `Feature flag state`
  // table, asserted against runtime by predicateIndex.test.ts.
  // attempt-into-trinket (2026-08-18): stun-anchored kill attempts opened on
  // a trinket-up target while a PRIME target existed. Extractor + mapper live
  // in utils/killAttempts.ts; assembly here is flag-gated like every other
  // new candidate type.
  if (CANDIDATE_TYPE_FLAGS.attemptIntoTrinket) {
    try {
      out.push(
        ...attemptIntoTrinketEvents(
          extractKillAttempts(friends, enemies, combat),
          enemies,
          combat.startTime,
        ),
      );
    } catch {
      /* same degradation policy as the other team-play sources */
    }
  }

  if (
    CANDIDATE_TYPE_FLAGS.missedSyncWindow ||
    CANDIDATE_TYPE_FLAGS.unsyncedBurst
  ) {
    try {
      const ccWindows = enemyHealerCcWindows(friends, enemies, combat);
      // Gate on at least one real hard-CC window on the enemy healer: with
      // zero windows, unsynced-burst's "no hard CC overlapped this cast"
      // predicate would trivially be true for EVERY offensive cast (nothing
      // to overlap), flooding the menu with a claim sync was never even
      // possible to attempt — not the coaching point this type exists for.
      if (ccWindows.length > 0) {
        const teamOffensiveCds: Array<
          IMajorCooldownInfo & { ownerName: string }
        > = [];
        for (const f of friends) {
          try {
            for (const cd of extractMajorCooldowns(f, combat)) {
              if (!cd.isThroughput) continue;
              teamOffensiveCds.push({ ...cd, ownerName: f.name });
            }
          } catch {
            /* this friend's CD ledger not computable → their CDs absent */
          }
        }
        if (CANDIDATE_TYPE_FLAGS.missedSyncWindow) {
          out.push(
            ...missedSyncWindowEvents(ccWindows, teamOffensiveCds, {
              enemyMinHpPctAt: (from, to) =>
                enemyMinHpPctInWindow(enemies, combat, from, to),
            }),
          );
        }
        if (CANDIDATE_TYPE_FLAGS.unsyncedBurst) {
          const teamOffensiveCasts = teamOffensiveCds.flatMap((cd) =>
            cd.casts.map((c) => ({
              ownerName: cd.ownerName,
              spellId: cd.spellId,
              spellName: cd.spellName,
              castTimeSeconds: c.timeSeconds,
              cooldownSeconds: cd.cooldownSeconds,
            })),
          );
          // §29b fix (2026-08-15): name EVERY enemy healer, not just the
          // first match — enemyHealerCcWindows' hard-CC gate already spans
          // all of them (see unsyncedBurstEvents' doc comment), so a
          // dual-healer comp must not misattribute the "was free" fact to
          // an arbitrary one.
          const enemyHealerNames = enemies
            .filter((e) => isHealerSpec(e.spec))
            .map((e) => e.name as string);
          // Feasibility gate input: the team's own hard-CC ledger, built from
          // the same extractMajorCooldowns pass the offensive list uses and
          // filtered to abilities that are hard CC (`ccSpellIds` — the official
          // predicate since 2026-08-22).
          const teamCcCds: IMajorCooldownInfo[] = [];
          for (const f of friends) {
            try {
              for (const cd of extractMajorCooldowns(f, combat))
                if (ccSpellIds.has(cd.spellId)) teamCcCds.push(cd);
            } catch {
              /* this friend's ledger not computable → their CC absent */
            }
          }
          out.push(
            ...unsyncedBurstEvents(
              teamOffensiveCasts,
              ccWindows,
              enemyHealerNames,
              (tSeconds) => teamCcCds.some((cd) => cdAvailableAt(cd, tSeconds)),
            ),
          );
        }
      }
    } catch {
      /* sync-lens analysis not computable → both types absent */
    }
  }

  // cd-hoarded / cd-spent-idle (P2 起爆-1/-2, 2026-08-15, Task 4 flag-gated
  // wiring): owner-scoped, reuse the caller's already-computed `ownerCds`
  // (no re-fetch) — each builder applies its own internal filter
  // (cdHoardedEvents covers every major CD; cdSpentIdleEvents narrows to
  // `DEFENSIVE_TAGS.has(cd.tag) && !cd.isThroughput`, the identical filter
  // the slow-defensive-response wiring below uses) so the full unfiltered
  // list is passed through, same as ccHeldEvents above. Each flag gates its
  // own type independently — flipping one on does not affect the other.
  if (CANDIDATE_TYPE_FLAGS.cdHoarded) {
    try {
      out.push(
        ...cdHoardedEvents(
          ownerCds,
          owner,
          {
            // GH #28: the 3rd arg (onlyUnitName) must be threaded through —
            // cdHoardedEvents passes the owner's own name for cooldowns that
            // cannot help anybody else. A probe that swallows it silently
            // reinstates the false "你本该按绝望祷言救队友" accusations.
            crisisMomentAt: (from, to, onlyUnitName) =>
              friendlyCrisisMomentInWindow(
                friends,
                combat,
                from,
                to,
                undefined,
                onlyUnitName,
              ),
            // #29 (2026-08-17): feeds filterIntentGuardEvidence's gcd-locked
            // exclusion — the owner's own successful casts, re-based to
            // seconds the same way every other tSeconds fact is.
            ownCastSuccessSeconds: (owner.spellCastEvents ?? []).map(
              (e: any) => (e.logLine.timestamp - combat.startTime) / 1000,
            ),
          },
          undefined,
          rawStreams,
        ),
      );
    } catch {
      /* cd-hoarded not computable → type absent */
    }
  }
  if (CANDIDATE_TYPE_FLAGS.cdSpentIdle) {
    try {
      const matchThreat = matchThreatLevel(enemies, friends, combat);
      out.push(
        ...cdSpentIdleEvents(ownerCds, owner, matchThreat, {
          threatActiveAt: (t) => threatActiveAt(t, enemies, friends, combat),
        }),
      );
    } catch {
      /* cd-spent-idle not computable → type absent */
    }
  }

  // md-cyclone-window (GH #25 MD 特例, user-ruled four-gate criterion
  // 2026-08-21): priest owner only. Every input is a shared predicate —
  // cyclone landings via buildAuraIntervals, chain gap via drResetMsAt (the
  // same walk extractKillAttempts groups stun chains with), pressure via
  // extractKillAttempts(enemies, friends) + friendlyCrisisMomentInWindow,
  // strategic-immunity cooldowns via official spellEffectData. All four
  // gates (and the red-line default-to-silence) live in
  // mdCycloneWindowEvents — see its module header.
  if (
    CANDIDATE_TYPE_FLAGS.mdCycloneWindow &&
    owner.class === CombatUnitClass.Priest
  ) {
    try {
      const cycloneHits = friends.flatMap((f: any) =>
        buildAuraIntervals(f, combat)
          .filter((iv) => iv.spellId === CYCLONE_SPELL_ID)
          .map((iv) => ({ atS: iv.fromS, targetName: f.name as string })),
      );
      const enemyStrategics: IStrategicHolder[] = enemies.flatMap((e: any) => {
        const spellId =
          e.class === CombatUnitClass.Mage
            ? ICE_BLOCK_SPELL_ID
            : e.class === CombatUnitClass.Paladin
              ? DIVINE_SHIELD_SPELL_ID
              : null;
        if (spellId === null) return [];
        return [
          {
            unitName: e.name as string,
            spellId,
            castSeconds: (e.spellCastEvents ?? [])
              .filter((c: any) => c.spellId === spellId)
              .map((c: any) => (c.timestamp - combat.startTime) / 1000),
          },
        ];
      });
      // Enemy attempts on the owner's team — computed lazily, at most once
      // (the probe only runs for chains that survived gates 3–4).
      let enemyAttempts: ReturnType<typeof extractKillAttempts> | null = null;
      out.push(
        ...mdCycloneWindowEvents({
          owner,
          cycloneHits,
          ownerMdCastSeconds: (owner.spellCastEvents ?? [])
            .filter((c: any) => c.spellId === MD_SPELL_ID)
            .map((c: any) => (c.timestamp - combat.startTime) / 1000),
          enemyStrategics,
          chainGapS: drResetMsAt(combat.startTime) / 1000,
          probes: {
            crisisMomentAt: (from, to) =>
              friendlyCrisisMomentInWindow(friends, combat, from, to),
            enemyAttemptOverlapping: (from, to) => {
              enemyAttempts ??= extractKillAttempts(enemies, friends, combat);
              const a = enemyAttempts.find(
                (k) => k.fromSeconds <= to && k.toSeconds >= from,
              );
              return a
                ? `enemy kill attempt on ${a.targetName} at ${toRenderSecond(a.fromSeconds)}s`
                : null;
            },
          },
        }),
      );
    } catch {
      /* md-cyclone-window not computable → type absent */
    }
  }

  try {
    const cc = analyzePlayerCCAndTrinket(owner, enemies, combat, enemyPets);
    ccSummary = cc;
    // cc-locked 已退役(GH #14,用户裁定 2026-08-19,v28):机会归一化后转化率
    // 反向(能解时真解了:胜 23.2% vs 负 27.9%,−4.7pp;赢家更常全程不交徽章,
    // 有机会零解控回合 胜 23.4% vs 负 16.2%),出面事件 98.5% 落在两个无证据
    // 档位(available_unused 51% + on_cooldown 47%)。被控事实仍由时间线
    // [CC ON TEAM] 行完整供给模型;纯函数 ccLockedEvents 与测试保留(照
    // juked-kick #15 先例,缓存 findings 仍要能渲染)。
    out.push(...kickEatenEvents(cc.interruptInstances, owner));

    // wasted-trinket 已退役(GH #14 B 组复测,用户裁定 2026-08-19,v29):出面
    // 事件 94.9%(胜)/93.9%(负)是治疗解自己身上的控 —— healerInCCAt 对 owner
    // 恒 false 的结构性盲区让「满血时解控」本身成了罪名;按使用次数归一化后
    // 反向(胜 12.0% vs 负 10.4% 被判浪费),触发率持平(12.3/12.5)。徽章按压
    // 事实仍由时间线 [TRINKET] 行与 [CC ON TEAM] trinket 备注完整供给模型;
    // 纯函数 wastedTrinketEvents / trinketTeamMinHpPctAt 与测试保留(照
    // juked-kick #15 先例)。将来若要「徽章被钓」信号,应重新设计成看后果的
    // 版本(中立按压 + 真空期内落硬控/击杀尝试)再接地上线。
    //
    // owner/friends are passed through (2026-08-06, signal-expansion batch 1)
    // so alignedBurstWindows also carries mostPressuredTarget/healerCCed/
    // dangerScore — position-mistake below needs those (see
    // reconstructEnemyCDTimeline's own doc comment).
    const enemyTl = reconstructEnemyCDTimeline(enemies, combat, owner, friends);
    enemyTlShared = enemyTl;

    // position-mistake (POSITION-001, 2026-08-06): reuses this same try's
    // ownerCds / alignedBurstWindows / ownerCCSummary — the identical wiring
    // deepDive.ts's positioning pack uses. computeOwnerPositionEvents itself
    // enforces the three-state rule (silently [] with no advanced position
    // data), so no extra gate is needed here.
    out.push(
      ...positionMistakeEvents(
        computeOwnerPositionEvents({
          owner,
          enemies,
          combat,
          burstWindows: enemyTl.alignedBurstWindows,
          ownerCooldowns: ownerCds,
          ownerCCSummary: cc,
          isHealer: isHealerSpec(owner.spec),
          ownerIsMelee: isMeleeSpec(owner.spec),
          friends,
        }),
        owner,
      ),
    );

    // cc-avoidable (DEFENSIVE-001, 2026-08-07): healer-owner rounds only —
    // same gate healing-gap uses below; a DPS owner eating CC is normal
    // play, this candidate specifically coaches a healer's self-preservation
    // kit. Reuses this same try's `cc.ccInstances` (no re-fetch).
    if (isHealerSpec(owner.spec)) {
      out.push(
        ...ccAvoidableEvents(
          cc.ccInstances,
          owner,
          (inst) => ccAvoidanceOptionsAt(owner, inst, combat.startTime),
          (inst) => wasCcHardCastAt(enemies, enemyPets, inst, combat.startTime),
        ),
      );
    }
  } catch {
    /* owner CC summary not computable → all five types (cc-locked /
       kick-eaten / wasted-trinket / position-mistake / cc-avoidable) absent */
  }

  // cc-held (COOLDOWN-001, 2026-08-06): pure filter over ownerCds, already
  // computed once by the caller (extractCandidateFindings) — no re-fetch.
  try {
    out.push(...ccHeldEvents(ownerCds, owner));
  } catch {
    /* same as above */
  }

  // healing-gap (HEAL-001, 2026-08-06): healer-owner rounds only — mirrors
  // the "DPS owner only" gate dpsOwnerEvents uses on the other side.
  if (isHealerSpec(owner.spec)) {
    try {
      out.push(
        ...healingGapEvents(
          detectHealingGaps(owner, friends, enemies, combat),
          owner,
        ),
      );
    } catch {
      /* healing-gap analysis not computable → type absent */
    }
  }

  // crisis-no-response: same predicate as the eval behavior-prior scan
  // (crisisDecisionPoints) and same lookup as the gate, keyed by role (spec
  // §1d, GH #59). Healer and DPS owners each get their own role-tagged
  // decision points and reference lookup.
  if (isHealerSpec(owner.spec)) {
    try {
      const bracket: string = combat?.startInfo?.bracket ?? "";
      out.push(
        ...crisisNoResponseEvents(
          crisisDecisionPoints(owner, combat, "healer"),
          owner,
          bracket,
          { lookup: (dmg2s) => lookupBehaviorPrior(bracket, "healer", dmg2s) },
        ),
      );
    } catch {
      /* decision points not computable → type absent */
    }
  } else {
    // DPS side of the same signal (spec §1d): until the DPS behavior-prior
    // scan lands, behaviorPriorGenerated.json carries no `|dps|` cells, so
    // lookupBehaviorPrior always returns null here and crisisNoResponseEvents
    // emits nothing — byte-identical product output until that data exists.
    try {
      const bracket: string = combat?.startInfo?.bracket ?? "";
      out.push(
        ...crisisNoResponseEvents(
          crisisDecisionPoints(owner, combat, "dps"),
          owner,
          bracket,
          { lookup: (dmg2s) => lookupBehaviorPrior(bracket, "dps", dmg2s) },
        ),
      );
    } catch {
      /* decision points not computable → type absent */
    }
  }

  // slow-defensive-response (DEFENSIVE-003, 2026-08-11): healer-owner rounds
  // only — every threshold above is corpus-calibrated on 100% healer-owner
  // rounds (898/898); a DPS owner's defensive economy is unmeasured, so the
  // gate stays until a DPS corpus says otherwise. Runs LAST on purpose: its
  // dedupe gate must see the full candidate picture (the caller's
  // priorEvents carries death-setup and friends; `out` carries everything
  // this function emitted, cc-held/healing-gap included). Reuses the
  // CC-summary try block's enemyTl / cc instances and the caller's ownerCds
  // — zero re-fetches.
  if (isHealerSpec(owner.spec) && enemyTlShared && ccSummary) {
    try {
      const enemyIdSet = new Set<string>(enemies.map((u: any) => u.id));
      const defensiveCds = ownerCds.filter(
        (cd) => DEFENSIVE_TAGS.has(cd.tag) && !cd.isThroughput,
      );
      const ccInstances = ccSummary.ccInstances;
      out.push(
        ...slowDefensiveResponseEvents(
          enemyTlShared.alignedBurstWindows,
          owner,
          {
            reactionTo: (w) =>
              firstDefensiveReactionToWindow(
                owner,
                enemyIdSet,
                w,
                combat.startTime,
              ),
            toolAvailableAt: (t, pressuredName) =>
              defensiveCds.some(
                (cd) =>
                  cdAvailableAt(cd, t) &&
                  // 压力在自己身上 → 自保墙就是答案;压力在队友身上 → 只有够得着
                  // 队友的 CD 才算「你有工具」(GH #28 的 canHelpAnotherUnit)。
                  // 承压对象未知时不收窄(保守,维持既有行为)。
                  (pressuredName === undefined ||
                    pressuredName === owner.name ||
                    canHelpAnotherUnit(cd.spellId, cd.tag)),
              ),
            ownerInCCAt: (t) =>
              ccInstances.some(
                (c) => c.atSeconds <= t && t < c.atSeconds + c.durationSeconds,
              ),
          },
          [...priorEvents, ...out],
        ),
      );
    } catch {
      /* slow-defensive-response not computable → type absent */
    }
  }

  return out;
}

/** death-setup integration: assemble parts for each friendly death (summaries
 * are computed lazily, once per victim). */
function extractDeathSetups(
  combat: any,
  units: any[],
  start: number,
  ownerId?: string,
  /** Intent guard (BACKLOG #26 Task 2): threaded down to
   * `deathUnusedDefensiveEvents` only — absent/`available:false` degrades
   * silently there. */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return out;
  const enemyIds = new Set(enemies.map((e) => e.id));
  const enemyPets = units.filter((u) => u.ownerId && enemyIds.has(u.ownerId));
  const healer = friends.find((u) => isHealerSpec(u.spec));
  const ownerUnit = ownerId ? friends.find((f) => f.id === ownerId) : undefined;

  const ccMemo = new Map<
    string,
    ReturnType<typeof analyzePlayerCCAndTrinket>
  >();
  const ccOf = (u: any) => {
    let v = ccMemo.get(u.id);
    if (!v) {
      v = analyzePlayerCCAndTrinket(u, enemies, combat, enemyPets);
      ccMemo.set(u.id, v);
    }
    return v;
  };
  // The timing audit needs the enemy cooldown timeline (computed once per
  // match). The casts from extractMajorCooldowns carry no timingLabel of their
  // own — they must go through annotateDefensiveTimings before an Early
  // verdict exists (agy review #1: skip the annotation and defensive-early
  // never fires in production).
  let enemyTl: ReturnType<typeof reconstructEnemyCDTimeline> | null = null;
  const cdMemo = new Map<string, IMajorCooldownInfo[]>();
  const cdsOf = (u: any) => {
    let v = cdMemo.get(u.id);
    if (!v) {
      enemyTl = enemyTl ?? reconstructEnemyCDTimeline(enemies, combat);
      v = annotateDefensiveTimings(
        extractMajorCooldowns(u, combat),
        u,
        combat,
        enemyTl,
      );
      cdMemo.set(u.id, v);
    }
    return v;
  };

  for (const u of friends) {
    for (const d of (u.deathRecords ?? []) as any[]) {
      const deathT = ((d.timestamp ?? 0) - start) / 1000;
      const parts: DeathSetupParts = {
        deathT,
        victim: { id: u.id, name: u.name },
      };
      // Each summary is independently fault-tolerant: when a synthetic fixture
      // lacks startInfo or an event array, only that one part goes missing and
      // the other precursor verdicts still stand (second layer on top of the
      // menu-wide try/catch).
      try {
        parts.victimCC = ccOf(u);
      } catch {
        /* summary not computable → that precursor type is absent */
      }
      try {
        parts.victimCDs = cdsOf(u);
      } catch {
        /* same as above */
      }
      if (healer && healer.id !== u.id) {
        try {
          parts.healerCC = {
            healerName: healer.name,
            ccInstances: ccOf(healer).ccInstances,
          };
        } catch {
          /* same as above */
        }
      }
      out.push(...deathSetupEvents(parts));
      // death-unused-defensive 已退役(GH #58,用户裁定 2026-08-29,v38):
      // 它的指控「你死时减伤是好的却没按」在语料里是高手多数时候也不做的事
      // (自由态前 10% 治疗按个人减伤仅 19–36%),54% 的出面列的还是宁静/
      // 神圣赞美诗这类非个人减伤;真正有分段梯度的错误是「危机 3 秒无应对」,
      // 由 crisis-no-response(不以死亡为锚、承伤 ≥10%、结果参照)接替。
      // 死亡时哪些减伤可用的事实仍由时间线 [DEATH] 行的 (Unused: …) 供给模型;
      // 纯函数 deathUnusedDefensiveEvents 与测试保留(照 cc-locked #14 先例,
      // 缓存 findings 仍要能渲染)。
      void deathUnusedDefensiveEvents;
      void rawStreams; // was threaded only to the retired producer
      if (ownerUnit && ownerUnit.id !== u.id) {
        try {
          out.push(
            ...externalUnusedEvents({
              deathT,
              victim: { id: u.id, name: u.name },
              owner: { id: ownerUnit.id, name: ownerUnit.name },
              ownerExternals: cdsOf(ownerUnit).filter((cd) =>
                isAllyCastableDefensive(cd.spellId),
              ),
              ownerCC: ccOf(ownerUnit).ccInstances,
              ownerAliveAt: (t) =>
                !(ownerUnit.deathRecords ?? []).some(
                  (dr: any) => (dr.timestamp - start) / 1000 <= t,
                ),
            }),
          );
        } catch {
          /* owner summary not computable → this type is absent */
        }
      }
    }
  }

  // --- questionable-external (17a): an external handed out in a
  // no-pressure window (the sixth tier, "Unnecessary", from
  // annotateDefensiveTimings). Unlike the above, this is not tied to a death —
  // every friendly external cast is checked, reusing the same cdsOf (annotate
  // already ran; don't recompute).
  // nearestBurstGapS is computed by annotateDefensiveTimings and stored on the
  // cast — that code already holds enemyCDTimeline.alignedBurstWindows, so we
  // just read it here rather than re-deriving the window geometry
  // (single-source predicate).
  for (const u of friends) {
    try {
      out.push(
        ...questionableExternalEvents(cdsOf(u), { id: u.id, name: u.name }),
      );
    } catch {
      /* same as above */
    }
  }

  return out;
}

// WASTED_DR_LEVELS({"25%","Immune"})随 dr-clipped-cc 退役删除(GH #17,
// 2026-08-20,用户裁定):"25%" 档 12.0 已从游戏移除(见 drAnalysis.ts 头注),
// "Immune" 按同文件 :325 的契约「outgoing 路径永远收不到」—— 实测两轮
// (12.1 前 21+4 条 / 12.1 DPS-owner 34 条,抽样 12/12)出面事件全是带真实
// 时长的 Immune 标注,即链窗模型与服务器窗口错位的解析伪影。谓词定义域 =
// {死档位, 伪影档} → 类型无合法定义域。

function dpsOwnerEvents(
  combat: any,
  owner: any,
  units: any[],
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  const players = units.filter((u) => u.info);
  const friends = players.filter((u) => u.reaction === owner.reaction);
  const enemies = players.filter((u) => u.reaction !== owner.reaction);
  if (enemies.length === 0) return out;
  const allies = friends.filter((u) => u.id !== owner.id);

  const ledger = analyzeBurstLedger(owner, allies, enemies, combat);

  // unconverted-burst: RETIRED from the menu 2026-08-19 (user ruling: C —
  // superseded). Measured grounds (GH #16/#17): 92.1% incidence (the noisiest
  // type after off-target), discrimination +4.1pp; every offensive-CD cast
  // counted as a "burst" with NO damage floor (18.5% of accusations carried
  // <0.2M dominant-target damage — a single Soul Immolation self-buff cast
  // qualified), and the CONVERTED_HP_DROP_PT=20 line sits at the flattest
  // part of the drop→death curve (see the #16 grounding report). What this
  // type wanted to say — "you swung and it did not convert" — is exactly the
  // [KILL ATTEMPTS] block's per-attempt outcome ("FAILED: not enough damage"
  // and friends), which is team-level, tier-aware, and attribution-backed.
  // Retirement follows the off-target-in-window shape one commit earlier:
  // assembly unplugged here; `isBurstConverted`/`CONVERTED_HP_DROP_PT` stay
  // in dpsMetrics (burstConversionRate + desktop keyMoments still consume
  // them), and deepDive/findingDisplay keep their branches so pre-retirement
  // cached findings still render.

  // burst-into-immunity 退役(GH #17,用户裁定 2026-08-20,v32;照 #14 系列
  // 先例摘发射)。区间伪影修复(buildFilteredAuraIntervals 双防伪规则)后
  // 样本已干净(overlap 全部 ≤ 真实免疫时长),但按爆发归一化的机会口径
  // 判别力持平:打进免疫率 胜 7.1%(44/618) vs 负 6.8%(35/511),n=492
  // DPS-recorder 回合 —— #13 下架时的同款形状;历史盲评 4.70/5 的 rubric
  // 明确不查事实,不构成留用依据。免疫事实仍由 [KILL ATTEMPTS] 失败归因
  // (mitigationVerdicts)与减伤表路径供给;legend/findingDisplay/deepDive
  // 分支保留(缓存 findings 仍要能渲染)。

  // burst-into-mitigation (OFFENSIVE-002): the dominant target had a major
  // non-immune mitigation cooldown running AND a softer target existed at the
  // same instant — see BURST_INTO_MITIGATION_MIN_PCT's doc comment for the
  // full predicate and corpus rates.
  {
    type BurstEntry = (typeof ledger)[number];
    type DominantTarget = NonNullable<BurstEntry["dominantTarget"]>;
    const mitCandidates: Array<{
      b: BurstEntry;
      t: DominantTarget;
      mitSpell: string;
      mitPct: number;
      betterTargetName: string;
    }> = [];
    for (const b of ledger) {
      const t = b.dominantTarget;
      if (!t) continue;
      const hits = t.defensivesHit
        .filter((d) => !d.isImmunity)
        .map((d) => ({ d, entry: MITIGATION_TABLE[d.spellId] }))
        .filter(
          ({ entry }) =>
            !!entry &&
            !entry.positional &&
            entry.pct >= BURST_INTO_MITIGATION_MIN_PCT,
        )
        .sort((a, c) => c.entry!.pct - a.entry!.pct);
      const hit = hits[0];
      if (!hit) continue;
      const evals = analyzeKillWindowTargetSelection(
        [
          {
            targetUnitId: t.unitId,
            fromSeconds: b.fromSeconds,
            toSeconds: b.toSeconds,
            durationSeconds: b.toSeconds - b.fromSeconds,
          },
        ],
        enemies,
        combat,
      );
      const ev = evals[0];
      if (!ev?.betterTargetExists || !ev.betterTargetName) continue;
      mitCandidates.push({
        b,
        t,
        mitSpell: hit.d.spellName,
        mitPct: hit.entry!.pct,
        betterTargetName: ev.betterTargetName,
      });
    }
    for (const { b, t, mitSpell, mitPct, betterTargetName } of mitCandidates
      .sort((a, c) => c.t.damage - a.t.damage)
      .slice(0, BURST_INTO_MITIGATION_CAP)) {
      out.push({
        id: `burst-into-mitigation:${owner.id}:${Math.round(b.fromSeconds)}`,
        type: "burst-into-mitigation",
        t: b.fromSeconds,
        unitNames: [owner.name, t.unitName],
        spell: b.spells[0]?.spellName,
        spellId: b.spells[0]?.spellId,
        facts: {
          t: fmt(b.fromSeconds),
          spell: b.spells.map((s) => s.spellName).join(" + "),
          target: t.unitName,
          mitSpell,
          mitPct: String(mitPct),
          betterTarget: betterTargetName,
        },
      });
    }
  }

  // off-target-in-window: RETIRED from the menu 2026-08-19 (user ruling
  // 2026-08-18: 集火程度要算全队的,算一个人的没有意思). Measured grounds
  // (GH #16/#17): 88.9% incidence / 4.03 per round with NO cap — the noisiest
  // candidate in the system; per-person exclusivity over 36s-median windows
  // that overlap another enemy's 80.3% of the time (37% fully covered)
  // produced 495 mutually-contradictory accusation pairs in n=300, and the
  // 50% threshold sat at p72 of a knee-less slope. The team-level replacement
  // is the [KILL ATTEMPTS] block's per-attempt team-focus share plus the
  // attempt-into-trinket candidate. Retirement follows the momentSnapshot
  // precedent — assembly unplugged here; `auditWindowTargeting` and
  // `ON_TARGET_GOOD_PCT` stay exported (BurstLedgerCard's 窗口目标纪律 section
  // still renders the per-window rows), and deepDive/findingDisplay keep
  // their branches so pre-retirement cached findings still render.

  // juked-kick 退役(2026-08-19,GH #15,用户裁定;照 off-target-in-window
  // 先例摘发射)。检测本身经实测无罪:601 条 juke 判定的 (读条起手→打断)
  // 间隔中位 1.0s、75% 在 2s 内 —— 是真实的反应链。下架理由是概念性的:
  // 检测全对也只能产出「你被假读条骗了」,2026-07-19 盲评 2.9/5(五类唯一
  // 低于 3.5),建议不可执行。analyzeKickAudit 纯函数与 kickAudit.test 保留
  // (kick 审计统计表仍在渲染);legend/findingDisplay 分支保留(退役前的
  // 缓存 findings 仍要能渲染)。

  // dr-clipped-cc 退役(GH #17,用户裁定 2026-08-20,v31;照 juked-kick #15
  // 先例摘发射)。判据集 WASTED_DR_LEVELS = {"25%","Immune"} 无合法定义域:
  // 25% 档 12.0 已从游戏移除,Immune 档按 drAnalysis.ts:325 的契约不该出现
  // 在 outgoing 路径,实测两轮出面事件却全是带真实时长(0.1–3.4s)的
  // Immune 标注 —— 链窗模型与服务器 DR 窗口错位的解析伪影,判别力亦反向
  // (−1.6)。legend/findingDisplay/deepDive 分支保留(缓存 findings 仍要能
  // 渲染);同一伪影谓词的另一消费方(drAnalysis 的 hasWastedApplications
  // → CC Chains "hit immune" 提示)同批删除。

  return out;
}
