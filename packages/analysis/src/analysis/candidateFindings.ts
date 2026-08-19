import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { CANDIDATE_TYPE_FLAGS } from "../data/candidateTypeFlags";
import {
  attemptIntoTrinketEvents,
  extractKillAttempts,
} from "../utils/killAttempts";
import { costNormPhrase } from "../data/curatedAbilityFacts";
import { CORPUS_OBSERVED_DISPEL_IDS } from "../data/dispelObservedGenerated";
import { MITIGATION_TABLE } from "../data/mitigationData";
import { spellEffectData } from "../data/spellEffectData";
import { ccSpellIds, trinketSpellIds } from "../data/spellTags";
import { analyzeBurstLedger } from "../utils/burstLedger";
import {
  analyzePlayerCCAndTrinket,
  applicableCCAvoidanceIds,
  CC_AVOIDANCE_BUFF_SPELLS,
  type ICCInstance,
  REPOSITIONING_SPELL_IDS,
  trinketStateFact,
} from "../utils/ccTrinketAnalysis";
import { getTalentAvoidanceTriggers } from "../utils/talentBehaviors";
import {
  annotateDefensiveTimings,
  applyCdTalentModifiers,
  cdAvailableAt,
  chargesAvailableAt,
  DEFENSIVE_TAGS,
  extractMajorCooldowns,
  getUnitHpAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  playerTalentIdSets,
  type IAvailableWindow,
  type IMajorCooldownInfo,
  isAllyCastableDefensive,
  isHealerSpec,
  isMeleeSpec,
  MAJOR_DEFENSIVE_IDS,
  PRE_WALL_SECONDS,
  specToString,
} from "../utils/cooldowns";
import { renderedWindowSeconds, toRenderSecond } from "../utils/renderGrid";
import {
  annotateMissedPurgesWithKillWindows,
  canDefensiveCleanse,
  type IMissedCleanseWindow,
  type IMissedPurgeWindow,
  reconstructDispelSummary,
} from "../utils/dispelAnalysis";
import { analyzeOutgoingCCChains } from "../utils/drAnalysis";
import {
  type IAlignedBurstWindow,
  reconstructEnemyCDTimeline,
} from "../utils/enemyCDs";
import { detectHealingGaps, type IHealingGap } from "../utils/healingGaps";
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
import { matchThreatLevel, threatActiveAt } from "../utils/threatAssessment";
import { fmtFactNum as fmt } from "./factFormat";
import type { CandidateEvent } from "./types";
import { manaEfficiencyEvents, manaPressureEvents } from "./candidates/mana";
import {
  deathSetupEvents,
  deathUnusedDefensiveEvents,
  externalUnusedEvents,
  questionableExternalEvents,
  type DeathSetupParts,
} from "./candidates/death";
import {
  cdHoardedEvents,
  cdSpentIdleEvents,
  enemyHealerCcWindows,
  enemyMinHpPctInWindow,
  friendlyCrisisMomentInWindow,
  missedSyncWindowEvents,
  unsyncedBurstEvents,
} from "./candidates/cooldownTiming";

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
  missedSyncWindowEvents,
  unsyncedBurstEvents,
  type ICrisisMoment,
  type IEnemyHealerCcWindow,
} from "./candidates/cooldownTiming";

// Death-anchored producers moved to `candidates/death.ts` in the 2026-08-16
// theme split; re-exported so importers keep their paths.
export {
  DEATH_SETUP_LOOKBACK_S,
  deathSetupEvents,
  deathUnusedDefensiveEvents,
  EXTERNAL_FREE_MIN_GAP_S,
  EXTERNAL_FREE_WINDOW_S,
  externalUnusedEvents,
  questionableExternalEvents,
  type DeathSetupParts,
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
  cds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "neverUsed" | "isThroughput"
  >[],
  healer: { id: string; name: string },
  minHpPct: number | null,
): CandidateEvent[] {
  if (minHpPct !== null && minHpPct >= CD_WASTE_PRESSURE_HP_PCT) return [];
  const out: CandidateEvent[] = [];
  for (const cd of cds) {
    if (cd.neverUsed && !cd.isThroughput) {
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
 * TEMPORARY per-round throttle (2026-08-06, BACKLOG #22): a 200-match
 * candidate-menu scan (healer-perspective default owner) found cc-locked +
 * missed-purge + missed-cleanse + wasted-trinket together made up ~66% of all
 * emitted candidate events (1629+1062+598+91 instances), drowning out every
 * other coaching topic in the healer-perspective report. The four caps below
 * (MISSED_CLEANSE_CAP / MISSED_PURGE_CAP / CC_LOCKED_CAP / WASTED_TRINKET_CAP)
 * are lowered purely to throttle volume, not as a quality judgment — each type
 * still sorts by its own severity field before truncating (see each mapping
 * function below), so the highest-value instances survive the cut.
 * Cancellation condition: remove this note and restore MISSED_CLEANSE_CAP /
 * MISSED_PURGE_CAP / CC_LOCKED_CAP to 3 and drop WASTED_TRINKET_CAP once the
 * signal-expansion batch (healer downtime / positioning / CC pressure /
 * dispel-tiering candidates — BACKLOG #18 second batch) lands and gives the
 * menu enough other topics that these four no longer need a hard ceiling.
 *
 * These same four types are also `LEGACY_TOPIC_TYPES` below — that set is the
 * SELECTION-layer counterpart of this menu-generation throttle: a 2026-08-11
 * four-backend measurement (diversity-baseline-report.md) found the model's
 * picking step ALSO over-selects these four relative to their already-capped
 * menu share (+3.4~+7.5pt at survival), so buildFindingsPrompt's prompt text
 * and auditFindings' deterministic cap both key off that one set instead of
 * re-listing the four names a third time.
 */
const MISSED_CLEANSE_CAP = 2;
const MISSED_PURGE_CAP = 2;
const CC_LOCKED_CAP = 2;
const KICK_EATEN_CAP = 2;
/** TEMPORARY, see block comment above (BACKLOG #22). */
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
 * 2026-08-19 (GH #14): cc-locked retired from the menu entirely (see the
 * retirement note at its former emission site), so the family shrank from
 * four to three — the selection instruction, the audit backstop, and the
 * drift tests all derive from this set and moved together. */
export const LEGACY_TOPIC_TYPES: ReadonlySet<string> = new Set([
  "missed-cleanse",
  "missed-purge",
  "wasted-trinket",
]);
/** cc-locked: how long a single CC must last to be worth coaching (short CCs
 * are constant background noise). */
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
const HEALING_GAP_CAP = 2;
const POSITION_MISTAKE_CAP = 2;
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
const CC_AVOIDABLE_MIN_S = 3;
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
 *    already has — timelineHelpers' DMG_SPIKE_THRESHOLD 300k over 15s
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
 * interrupt (especially coachable for healers: fake-casting). */
export function kickEatenEvents(
  instances: Pick<
    ReturnType<typeof analyzePlayerCCAndTrinket>["interruptInstances"][number],
    | "atSeconds"
    | "lockoutDurationSeconds"
    | "kickSpellName"
    | "interruptedSpellName"
    | "sourceName"
  >[],
  owner: { id: string; name: string },
): CandidateEvent[] {
  return instances
    .sort((a, b) => b.lockoutDurationSeconds - a.lockoutDurationSeconds)
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
 * 见上方 DEFENSIVE-001 块的说明;这个 64.3% 是本门的唯一依据,重标定需先重建扫描): 64.3% of
 * the raw hit events also had `trinketState === "available_unused"` — a fact
 * that was then coached by cc-locked / wasted-trinket, so firing here too
 * would double-charge one instant and silently evade the per-round candidate
 * caps (BACKLOG #22's whole point).
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
): CandidateEvent[] {
  const candidates: Array<{
    cc: (typeof instances)[number];
    avoid: string[];
  }> = [];
  for (const cc of instances) {
    if (cc.durationSeconds < CC_AVOIDABLE_MIN_S) continue;
    if (cc.drInfo?.level !== "Full") continue;
    if (cc.trinketState === "available_unused") continue;
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
    "fromSeconds" | "toSeconds" | "damageInWindow" | "damageRatio" | "activeCDs"
  >[],
  owner: { id: string; name: string },
  probes: {
    /** Wired to firstDefensiveReactionToWindow in production. */
    reactionTo: (window: {
      fromSeconds: number;
      toSeconds: number;
    }) => { delayS: number; spellName: string } | null;
    /** Any defensive-tagged major CD off cooldown at t (cdAvailableAt). */
    toolAvailableAt: (tSeconds: number) => boolean;
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
    if (!probes.toolAvailableAt(w.fromSeconds)) continue;
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
  /** Intent guard (BACKLOG #26 Task 2) + mana-pressure (BACKLOG #26 Task 3,
   * review round 1 doc fix — was stale, listed only `cdHoardedEvents`):
   * threaded down to `cdHoardedEvents` (intent guard, `facts.attempted`) and
   * `manaPressureEvents` (OOM-window tail-extension bridge and window
   * gating) — absent/`available:false` degrades silently in both. */
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
      ),
    );
    out.push(
      ...missedPurgeEvents(
        ds.missedPurgeWindows.filter((w) =>
          CORPUS_OBSERVED_DISPEL_IDS.has(w.spellId),
        ),
      ),
    );
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
          out.push(
            ...unsyncedBurstEvents(
              teamOffensiveCasts,
              ccWindows,
              enemyHealerNames,
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
            crisisMomentAt: (from, to) =>
              friendlyCrisisMomentInWindow(friends, combat, from, to),
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

  // mana-pressure (BACKLOG #26 Task 3, 2026-08-15, feature-flagged off by
  // default): team-scoped like missed-cleanse/missed-purge above (the
  // FRIENDLY healer's OOM window, not owner-scoped — see manaPressureEvents'
  // own doc comment for why). Single source with buildFindingsPrompt.ts's
  // legend gate, same pattern as the missed-sync-window/unsynced-burst block
  // above: both read CANDIDATE_TYPE_FLAGS.manaPressure directly.
  if (CANDIDATE_TYPE_FLAGS.manaPressure) {
    try {
      const teamHealer = friends.find((u) => isHealerSpec(u.spec));
      if (teamHealer) {
        out.push(
          ...manaPressureEvents(rawStreams, teamHealer, {
            threatActiveAt: (t) => threatActiveAt(t, enemies, friends, combat),
          }),
        );
      }
    } catch {
      /* mana-pressure not computable → type absent */
    }
  }

  // mana-efficiency (BACKLOG #26 Task 4, 2026-08-15, feature-flagged off by
  // default): team-scoped like mana-pressure above — the FRIENDLY healer's
  // own per-match spell-mix aggregate, not owner-scoped. No rawStreams
  // dependency (see manaEfficiencyEvents' own doc comment for why); only
  // combat.startTime (matchStartMs) is threaded through.
  if (CANDIDATE_TYPE_FLAGS.manaEfficiency) {
    try {
      const teamHealer = friends.find((u) => isHealerSpec(u.spec));
      if (teamHealer) {
        out.push(
          ...manaEfficiencyEvents(teamHealer, teamHealer, combat.startTime),
        );
      }
    } catch {
      /* mana-efficiency not computable → type absent */
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

    // wasted-trinket: all three probes are wired to the shared predicates —
    // friendlyHpPctAt uses the gate's own HP_SAMPLE_RADIUS_MS sample radius,
    // and healerInCCAt / enemyOffensiveActiveAt reuse the existing CC summary
    // and enemy cooldown timeline rather than rebuilding them. When the owner
    // IS the healer, healerCC is an empty array → healerInCCAt is always false
    // (the owner trinketing out of their own CC is normal play; the minHp and
    // enemy-burst conditions still backstop that case).
    // owner/friends are now passed through (2026-08-06, signal-expansion
    // batch 1) so alignedBurstWindows also carries mostPressuredTarget/
    // healerCCed/dangerScore — position-mistake below needs those, and the
    // players[] array wasted-trinket reads is unaffected by the extra args
    // (see reconstructEnemyCDTimeline's own doc comment).
    const enemyTl = reconstructEnemyCDTimeline(enemies, combat, owner, friends);
    enemyTlShared = enemyTl;
    const healer = friends.find((u) => isHealerSpec(u.spec));
    const healerCC =
      healer && healer.id !== owner.id
        ? analyzePlayerCCAndTrinket(healer, enemies, combat, enemyPets)
            .ccInstances
        : [];
    out.push(
      ...wastedTrinketEvents(cc.trinketUseTimes, owner, {
        friendlyHpPctAt: (t) => trinketTeamMinHpPctAt(friends, combat, t),
        healerInCCAt: (t) =>
          healerCC.some(
            (c) => c.atSeconds <= t && t <= c.atSeconds + c.durationSeconds,
          ),
        enemyOffensiveActiveAt: (t) =>
          enemyTl.players.some((p) =>
            p.offensiveCDs.some(
              (cd) => cd.castTimeSeconds <= t && t <= cd.buffEndSeconds,
            ),
          ),
      }),
    );

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
        ...ccAvoidableEvents(cc.ccInstances, owner, (inst) =>
          ccAvoidanceOptionsAt(owner, inst, combat.startTime),
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
            toolAvailableAt: (t) =>
              defensiveCds.some((cd) => cdAvailableAt(cd, t)),
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
      out.push(
        ...deathUnusedDefensiveEvents(
          parts,
          { isOwner: u.id === ownerId, unit: u },
          combat,
          rawStreams,
        ),
      );
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

/** 25%/Immune = wasted (mirrors the definition of
 * IOutgoingCCChain.hasWastedApplications). */
const WASTED_DR_LEVELS = new Set(["25%", "Immune"]);

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

  // burst-into-immunity: the dominant target had an immunity up during the
  // burst (plain damage reduction is not reported; the prompt block narrates
  // that instead)
  for (const b of ledger) {
    const t = b.dominantTarget;
    if (!t) continue;
    const imm = t.defensivesHit.find((d) => d.isImmunity);
    if (!imm) continue;
    out.push({
      id: `burst-immune:${owner.id}:${Math.round(b.fromSeconds)}`,
      type: "burst-into-immunity",
      t: b.fromSeconds,
      unitNames: [owner.name, t.unitName],
      spell: b.spells[0]?.spellName,
      spellId: b.spells[0]?.spellId,
      facts: {
        t: fmt(b.fromSeconds),
        spell: b.spells.map((s) => s.spellName).join(" + "),
        target: t.unitName,
        immunity: imm.spellName,
        overlap: imm.overlapSeconds.toFixed(1),
      },
    });
  }

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

  // dr-clipped-cc: the owner's CC landed on 25%/Immune DR (stepping on a
  // teammate's chain)
  for (const chain of analyzeOutgoingCCChains(friends, enemies, combat)) {
    for (const app of chain.applications) {
      if (app.casterName !== owner.name) continue;
      if (!WASTED_DR_LEVELS.has(app.drInfo.level)) continue;
      out.push({
        id: `dr-clipped:${owner.id}:${Math.round(app.atSeconds)}`,
        type: "dr-clipped-cc",
        t: app.atSeconds,
        unitNames: [owner.name, chain.targetName],
        spell: app.spellName,
        spellId: app.spellId,
        facts: {
          t: fmt(app.atSeconds),
          spell: app.spellName,
          target: chain.targetName,
          dr: app.drInfo.level,
          duration: app.durationSeconds.toFixed(1),
        },
      });
    }
  }

  return out;
}
