import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { DEATH_CC_LOOKBACK_S } from "../context/criticalMoments";
import { lastCastBefore } from "../context/timelineHelpers";
import {
  analyzeBurstLedger,
  auditWindowTargeting,
  ON_TARGET_GOOD_PCT,
} from "../utils/burstLedger";
import {
  analyzePlayerCCAndTrinket,
  applicableCCAvoidanceIds,
  CC_AVOIDANCE_BUFF_SPELLS,
  REPOSITIONING_SPELL_IDS,
  type ICCInstance,
} from "../utils/ccTrinketAnalysis";
import { spellEffectData } from "../data/spellEffectData";
import {
  annotateDefensiveTimings,
  cdAvailableAt,
  extractMajorCooldowns,
  FORBEARANCE_GATED_IDS,
  getUnitHpAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  type IAvailableWindow,
  type IMajorCooldownInfo,
  isAllyCastableDefensive,
  isHealerSpec,
  isMeleeSpec,
  selfForbearanceActiveAt,
  specToString,
  toRenderSecond,
  USABLE_WHILE_CC_SPELL_IDS,
} from "../utils/cooldowns";
import { ccSpellIds } from "../data/spellTags";
import { CORPUS_OBSERVED_DISPEL_IDS } from "../data/dispelObservedGenerated";
import {
  annotateMissedPurgesWithKillWindows,
  canDefensiveCleanse,
  reconstructDispelSummary,
  type IMissedCleanseWindow,
  type IMissedPurgeWindow,
} from "../utils/dispelAnalysis";
import { reconstructEnemyCDTimeline } from "../utils/enemyCDs";
import { isBurstConverted } from "../utils/dpsMetrics";
import { analyzeOutgoingCCChains } from "../utils/drAnalysis";
import { detectHealingGaps, type IHealingGap } from "../utils/healingGaps";
import { analyzeKickAudit } from "../utils/kickAudit";
import { matchMinHpPct } from "../utils/killWindowTargetSelection";
import { computeOffensiveWindows } from "../utils/offensiveWindows";
import {
  computeOwnerPositionEvents,
  type IPositionEvent,
  POSITION_MISTAKES,
  stayedInHadRealCost,
} from "../utils/positionAnalysis";
import { fmtFactNum as fmt } from "./factFormat";
import type { CandidateEvent } from "./types";

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
      out.push({
        id: `cd-waste:${healer.id}:${cd.spellId}`,
        type: "cd-waste",
        t: 0, // whole-round observation, not time-specific
        unitNames: [healer.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: { spell: cd.spellName, unit: healer.name },
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
 *  - DPS owner only: burst-into-immunity / off-target-in-window /
 *    juked-kick / dr-clipped-cc / unconverted-burst
 */
export function extractCandidateFindings(
  combat: any,
  ownerId?: string,
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
    out.push(...extractDeathSetups(combat, units, start, resolvedOwnerId));
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
      out.push(...teamPlayEvents(combat, owner, units, ownerCds));
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
 */
const MISSED_CLEANSE_CAP = 2;
const MISSED_PURGE_CAP = 2;
const CC_LOCKED_CAP = 2;
const KICK_EATEN_CAP = 2;
/** TEMPORARY, see block comment above (BACKLOG #22). */
const WASTED_TRINKET_CAP = 1;
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
 * (200 matches / 635 healer-owner rounds, `.defensive-rates-report.md`;
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
        trinketState: cc.trinketState,
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
    spellCastEvents: Array<{
      spellId?: string;
      logLine: { event: string; timestamp: number };
    }>;
  },
  cc: { atSeconds: number; spellId: string; spellName: string },
  matchStartMs: number,
): string[] {
  const out: string[] = [];
  for (const id of applicableCCAvoidanceIds(cc.spellId, cc.spellName)) {
    const eff = spellEffectData[id];
    const cooldownSeconds =
      eff?.cooldownSeconds ?? eff?.charges?.chargeCooldownSeconds ?? null;
    if (cooldownSeconds === null) continue; // unknown CD, don't guess
    const casts = owner.spellCastEvents
      .filter(
        (e) =>
          e.spellId === id && e.logLine.event === LogEvent.SPELL_CAST_SUCCESS,
      )
      .map((e) => ({
        timeSeconds: (e.logLine.timestamp - matchStartMs) / 1000,
      }));
    if (casts.length === 0) continue; // kit-evidence gate
    if (
      !cdAvailableAt({ casts, cooldownSeconds, neverUsed: false }, cc.atSeconds)
    )
      continue;
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
 * Dedupe gate (2026-08-07 empirical, `.defensive-rates-report.md`): 64.3% of
 * the raw hit events also had `trinketState === "available_unused"` — the
 * exact fact cc-locked / wasted-trinket already coach ("the trinket was in
 * hand and you sat through it anyway"). Reporting the SAME instant a second
 * time under a different type would double-charge one mistake and silently
 * evade the per-round candidate caps (BACKLOG #22's whole point) — so
 * instances with the trinket sitting available are left to those two
 * existing types, and cc-avoidable only fires when the excuse-free "you had
 * a DIFFERENT, non-trinket tool ready" story is the one being told.
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

/** Team-play event integration: missed cleanse / missed purge (whole-team
 * scope) plus the owner being CC'd / interrupted. */
function teamPlayEvents(
  combat: any,
  owner: any,
  units: any[],
  ownerCds: IMajorCooldownInfo[],
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
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

  try {
    const cc = analyzePlayerCCAndTrinket(owner, enemies, combat, enemyPets);
    out.push(...ccLockedEvents(cc.ccInstances, owner));
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

  return out;
}

/** death-setup integration: assemble parts for each friendly death (summaries
 * are computed lazily, once per victim). */
function extractDeathSetups(
  combat: any,
  units: any[],
  start: number,
  ownerId?: string,
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

/** death-setup: maximum lookback (seconds) from a death to a precursor event —
 * resource spends earlier than this are too causally weak for that death. */
export const DEATH_SETUP_LOOKBACK_S = 90;
/** death-setup: minimum healer CC duration (seconds) — a short incapacitate
 * does not make the kill window unhealable. */
const HEALER_LOCK_MIN_S = 3;
/** Max precursor events attached to one death (priority: healer-locked >
 * trinket-early > defensive-early). */
const SETUPS_PER_DEATH = 2;

export interface DeathSetupParts {
  deathT: number;
  victim: { id: string; name: string };
  /** The victim's CC/trinket summary (the relevant slice of
   * analyzePlayerCCAndTrinket). */
  victimCC?: {
    ccInstances: Array<{
      atSeconds: number;
      durationSeconds: number;
      spellName: string;
      trinketState: string;
    }>;
    trinketUseTimes: number[];
  };
  /** The victim's major cooldowns (extractMajorCooldowns). */
  victimCDs?: Array<
    Pick<
      IMajorCooldownInfo,
      | "spellId"
      | "spellName"
      | "tag"
      | "cooldownSeconds"
      | "casts"
      | "neverUsed"
    >
  >;
  /** CC summary for the friendly healer (when the healer is not the victim). */
  healerCC?: {
    healerName: string;
    ccInstances: Array<{
      atSeconds: number;
      durationSeconds: number;
      /** Optional: real callers pass an ICCInstance that carries the id; test
       * fixtures may omit it (it only feeds the icon). */
      spellId?: string;
      spellName: string;
      sourceName: string;
    }>;
  };
}

/**
 * death-setup candidates (reasoning chain): trace a friendly death back to an
 * earlier precursor moment, giving the model a citable "other end of the
 * chain". Pure function (unit-testable with hand-built fixtures); every
 * verdict mirrors the existing predicates of buildDeathRootCauseTrace:
 *  - healer-locked: healer CC covers the DEATH_CC_LOOKBACK_S window before the
 *    death (same window constant);
 *  - trinket-early: the victim was CC'd inside the death window with
 *    trinketState=on_cooldown (the trace's CC row); the precursor moment is
 *    the earlier trinket press;
 *  - defensive-early: a victim's major defensive was ON COOLDOWN at death and
 *    its last use was labeled Early by the timing audit (the trace's
 *    [last use: EARLY] row); the precursor moment is that cast.
 */
export function deathSetupEvents(parts: DeathSetupParts): CandidateEvent[] {
  const { deathT, victim } = parts;
  const out: CandidateEvent[] = [];
  const inWindow = (cc: { atSeconds: number; durationSeconds: number }) =>
    cc.atSeconds <= deathT &&
    cc.atSeconds + cc.durationSeconds >= deathT - DEATH_CC_LOOKBACK_S;

  // healer-locked: healer was CC'd for >=3s inside the kill window, starting
  // before the moment of death
  const lock = parts.healerCC?.ccInstances.find(
    (cc) =>
      inWindow(cc) &&
      cc.durationSeconds >= HEALER_LOCK_MIN_S &&
      cc.atSeconds < deathT,
  );
  if (lock) {
    out.push({
      id: `death-setup:${victim.id}:${Math.round(deathT)}:healer-locked`,
      type: "death-setup",
      t: lock.atSeconds,
      unitNames: [parts.healerCC!.healerName, victim.name],
      spell: lock.spellName,
      spellId: lock.spellId,
      facts: {
        t: fmt(lock.atSeconds),
        kind: "healer-locked",
        deathT: fmt(deathT),
        victim: victim.name,
        healer: parts.healerCC!.healerName,
        cc: lock.spellName,
        duration: lock.durationSeconds.toFixed(1),
      },
    });
  }

  // trinket-early: CC'd inside the death window with the trinket on cooldown;
  // the precursor is that earlier trinket press
  const deadInCC = parts.victimCC?.ccInstances.find(
    (cc) => inWindow(cc) && cc.trinketState === "on_cooldown",
  );
  if (deadInCC) {
    const trinketT = [...(parts.victimCC?.trinketUseTimes ?? [])]
      .filter(
        (t) => t < deadInCC.atSeconds && t >= deathT - DEATH_SETUP_LOOKBACK_S,
      )
      .pop();
    if (trinketT !== undefined) {
      out.push({
        id: `death-setup:${victim.id}:${Math.round(deathT)}:trinket-early`,
        type: "death-setup",
        t: trinketT,
        unitNames: [victim.name],
        facts: {
          t: fmt(trinketT),
          kind: "trinket-early",
          deathT: fmt(deathT),
          victim: victim.name,
          ccAtDeath: deadInCC.spellName,
          gapS: fmt(deathT - trinketT),
        },
      });
    }
  }

  // defensive-early: ON COOLDOWN at death and its last use was labeled Early
  // by the timing audit
  for (const cd of parts.victimCDs ?? []) {
    if (cd.tag !== "Defensive" || cd.neverUsed) continue;
    const last = lastCastBefore(cd as IMajorCooldownInfo, deathT);
    if (!last) continue;
    // available at death → this is not a "spent it too early" chain
    if (cdAvailableAt(cd as IMajorCooldownInfo, deathT)) continue;
    if (last.timingLabel !== "Early") continue;
    if (last.timeSeconds < deathT - DEATH_SETUP_LOOKBACK_S) continue;
    out.push({
      id: `death-setup:${victim.id}:${Math.round(deathT)}:defensive-early`,
      type: "death-setup",
      t: last.timeSeconds,
      unitNames: [victim.name],
      spell: cd.spellName,
      spellId: cd.spellId,
      facts: {
        t: fmt(last.timeSeconds),
        kind: "defensive-early",
        deathT: fmt(deathT),
        victim: victim.name,
        spell: cd.spellName,
        gapS: fmt(deathT - last.timeSeconds),
      },
    });
    // at most one defensive-early per death (take the first matching wall)
    break;
  }

  return out.slice(0, SETUPS_PER_DEATH);
}

/** Max number of available survival abilities listed in a death's facts. */
const UNUSED_DEFENSIVE_MAX_LISTED = 3;

/**
 * death-unused-defensive: the owner died with a survival ability available and
 * never pressed it (arenacoach DEATH-001 predicate, same thresholds). "Free"
 * verdict: not in CC at the moment of death, or in CC but with the trinket
 * usable (available_unused/available), or the ability is castable while CC'd
 * (USABLE_WHILE_CC_SPELL_IDS). Divine Shield-class abilities do not count as
 * available during Forbearance.
 */
export function deathUnusedDefensiveEvents(
  parts: DeathSetupParts,
  victim: { isOwner: boolean; unit?: any },
  combat?: any,
): CandidateEvent[] {
  if (!victim.isOwner) return [];
  // When victimCC is absent (summary not computable) we must NOT default to
  // "not in CC" — that would wrongly land freeState on "yes" and falsely blame
  // a death that may well have happened under CC. Better to emit nothing than
  // to blame falsely.
  if (!parts.victimCC) return [];
  const { deathT } = parts;
  const ccAtDeath = parts.victimCC.ccInstances.find(
    (cc) =>
      cc.atSeconds <= deathT && cc.atSeconds + cc.durationSeconds >= deathT,
  );
  const freeState = !ccAtDeath
    ? "yes"
    : ccAtDeath.trinketState === "available_unused"
      ? "trinket_in_hand"
      : null; // in CC and the trinket is not actively usable
  // (passive_trinket/used/on_cooldown): not free overall, and only
  // USABLE_WHILE_CC abilities are exempt

  // selfForbearanceActiveAt needs the whole-match unit list and matchStartMs —
  // derived from the same source as units/start in extractCandidateFindings
  // (see the top of that function).
  const allUnits: any[] = combat ? Object.values(combat.units ?? {}) : [];
  const matchStartMs: number = combat?.startTime ?? 0;

  const walls = (parts.victimCDs ?? []).filter((cd) => {
    if (cd.tag !== "Defensive") return false;
    if ((cd as IMajorCooldownInfo).isThroughput) return false;
    if (!cdAvailableAt(cd as IMajorCooldownInfo, deathT)) return false;
    if (freeState === null && !USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId))
      return false;
    if (
      FORBEARANCE_GATED_IDS.has(cd.spellId) &&
      victim.unit &&
      combat &&
      selfForbearanceActiveAt(victim.unit, allUnits, deathT, matchStartMs)
    )
      return false;
    return true;
  });
  if (walls.length === 0) return [];
  return [
    {
      id: `death-unused-defensive:${parts.victim.id}:${Math.round(deathT)}`,
      type: "death-unused-defensive",
      t: deathT,
      unitNames: [parts.victim.name],
      facts: {
        t: fmt(deathT),
        unit: parts.victim.name,
        walls: walls
          .slice(0, UNUSED_DEFENSIVE_MAX_LISTED)
          .map((w) => w.spellName)
          .join(", "),
        free: freeState ?? "usable_in_cc",
      },
    },
  ];
}

/** external-unused: lookback window before the death (seconds) and the owner's
 * minimum free gap (seconds). Threshold provenance: arenacoach DEATH-003's
 * "you were free to cast it" (the 1.5s reaction allowance matches theirs
 * site-wide); the 5s window is the near-end sub-window of
 * DEATH_CC_LOOKBACK_S. */
export const EXTERNAL_FREE_WINDOW_S = 5;
export const EXTERNAL_FREE_MIN_GAP_S = 1.5;

/**
 * external-unused: a teammate died while the owner (usually the healer) had an
 * external damage reduction available (the isAllyCastableDefensive whitelist)
 * and never gave it (arenacoach DEATH-003). "Owner was free" verdict: within
 * the EXTERNAL_FREE_WINDOW_S seconds before the death, after subtracting CC
 * coverage there was still a contiguous gap of >=EXTERNAL_FREE_MIN_GAP_S
 * seconds — purely a reaction-time allowance; the owner is not expected to
 * press exactly at the moment of death. If the owner was already dead at that
 * point (e.g. a double death), nothing is reported.
 */
export function externalUnusedEvents(input: {
  deathT: number;
  victim: { id: string; name: string };
  owner: { id: string; name: string };
  ownerExternals: Array<
    Pick<
      IMajorCooldownInfo,
      "spellId" | "spellName" | "cooldownSeconds" | "casts" | "neverUsed"
    >
  >;
  ownerCC: Array<{ atSeconds: number; durationSeconds: number }>;
  ownerAliveAt: (t: number) => boolean;
}): CandidateEvent[] {
  const { deathT, victim, owner } = input;
  if (!input.ownerAliveAt(deathT)) return [];

  // Owner's free gap: the largest contiguous gap left in the window
  // [deathT-5, deathT] after subtracting CC coverage
  const from = Math.max(0, deathT - EXTERNAL_FREE_WINDOW_S);
  const covers = input.ownerCC
    .map((c) => [c.atSeconds, c.atSeconds + c.durationSeconds] as const)
    .filter(([a, b]) => b > from && a < deathT)
    .sort((a, b) => a[0] - b[0]);
  let cursor = from;
  let maxGap = 0;
  for (const [a, b] of covers) {
    maxGap = Math.max(maxGap, a - cursor);
    cursor = Math.max(cursor, b);
  }
  maxGap = Math.max(maxGap, deathT - cursor);
  if (maxGap < EXTERNAL_FREE_MIN_GAP_S) return [];

  const avail = input.ownerExternals.find((cd) => cdAvailableAt(cd, deathT));
  if (!avail) return [];
  return [
    {
      id: `external-unused:${owner.id}:${victim.id}:${Math.round(deathT)}`,
      type: "external-unused",
      t: deathT,
      unitNames: [owner.name, victim.name],
      spell: avail.spellName,
      spellId: avail.spellId,
      facts: {
        t: fmt(deathT),
        victim: victim.name,
        owner: owner.name,
        external: avail.spellName,
        freeGapS: fmt(maxGap),
      },
    },
  ];
}

/**
 * questionable-external (17a): the consumer of annotateDefensiveTimings' sixth
 * tier ("Unnecessary") — an external (EXTERNAL_DEFENSIVE_IDS /
 * isAllyCastableDefensive whitelist) handed out in a no-pressure window
 * (target at high HP + no damage spike + no burst alignment; all three
 * conditions are already decided inside annotate, so here we only filter on
 * timingLabel). For the corpus-measured occurrence rate see the task-3 report
 * (the pre-gate numbers).
 * Filed under category "cooldowns"; NOT in OFFENSIVE_CANDIDATE_TYPES
 * (deepDive.ts), so it routes to survival by default — "spending what you
 * should have saved" is a survival-discipline issue, not an offensive one.
 *
 * nearestBurstGapS is read straight off cast.nearestBurstGapS —
 * annotateDefensiveTimings already computed it while deciding Unnecessary,
 * holding enemyCDTimeline.alignedBurstWindows; we do not re-derive the window
 * geometry here (single-source predicate).
 */
export function questionableExternalEvents(
  cds: Pick<IMajorCooldownInfo, "spellId" | "spellName" | "casts">[],
  caster: { id: string; name: string },
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  for (const cd of cds) {
    for (const cast of cd.casts) {
      if (cast.timingLabel !== "Unnecessary") continue;
      const t = cast.timeSeconds;
      out.push({
        id: `questionable-external:${caster.id}:${Math.round(t)}`,
        type: "questionable-external",
        t,
        unitNames: [caster.name, cast.targetName ?? caster.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: fmt(t),
          spell: cd.spellName,
          caster: caster.name,
          target: cast.targetName ?? caster.name,
          targetHp:
            cast.targetHpPct !== undefined ? fmt(cast.targetHpPct) : "n/a",
          nearestBurstGapS:
            cast.nearestBurstGapS !== undefined
              ? fmt(cast.nearestBurstGapS)
              : "n/a",
        },
      });
    }
  }
  return out;
}

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

  // unconverted-burst: a burst window that did not convert (target survived,
  // net HP loss insufficient) — user feedback was that findings were all
  // deaths/kill windows, leaving the burst ledger's information with no
  // evidence id to cite. The conversion predicate is single-source with
  // dpsMetrics.burstConversionRate (isBurstConverted). Immunity cases belong
  // to burst-into-immunity and are not duplicated here; take the top 2 by
  // damage so small bursts don't flood the menu.
  const unconverted = ledger
    .filter((b) => {
      const t = b.dominantTarget;
      return (
        t !== null &&
        !isBurstConverted(t) &&
        !t.defensivesHit.some((d) => d.isImmunity)
      );
    })
    .sort(
      (a, b) =>
        (b.dominantTarget?.damage ?? 0) - (a.dominantTarget?.damage ?? 0),
    )
    .slice(0, 2);
  for (const b of unconverted) {
    const t = b.dominantTarget!;
    const def = t.defensivesHit[0];
    out.push({
      id: `unconverted-burst:${owner.id}:${Math.round(b.fromSeconds)}`,
      type: "unconverted-burst",
      t: b.fromSeconds,
      unitNames: [owner.name, t.unitName],
      spell: b.spells[0]?.spellName,
      spellId: b.spells[0]?.spellId,
      facts: {
        t: fmt(b.fromSeconds),
        spell: b.spells.map((s) => s.spellName).join(" + "),
        target: t.unitName,
        damageM: (t.damage / 1_000_000).toFixed(2),
        ...(t.hpStartPct !== null && t.hpEndPct !== null
          ? {
              hpStart: String(t.hpStartPct),
              hpEnd: String(t.hpEndPct),
            }
          : {}),
        ...(def ? { defensive: def.spellName } : {}),
        allyAligned: b.allyCDsOverlapping.length > 0 ? "yes" : "no",
      },
    });
  }

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

  // off-target-in-window: too small a share of damage landed on the window's
  // target during a kill window
  const windows = computeOffensiveWindows(enemies, friends, combat);
  for (const w of auditWindowTargeting(owner, windows, enemies, combat)) {
    if (w.onTargetPct >= ON_TARGET_GOOD_PCT) continue;
    out.push({
      id: `off-target:${owner.id}:${Math.round(w.windowFromSeconds)}`,
      type: "off-target-in-window",
      t: w.windowFromSeconds,
      unitNames: [owner.name, w.windowTargetName],
      facts: {
        t: fmt(w.windowFromSeconds),
        target: w.windowTargetName,
        onTargetPct: String(w.onTargetPct),
        ...(w.topOffTarget ? { offTarget: w.topOffTarget.unitName } : {}),
      },
    });
  }

  // juked-kick: an interrupt baited out by a fake cast
  for (const k of analyzeKickAudit(owner, enemies, combat)) {
    if (k.result !== "juked") continue;
    out.push({
      id: `juked-kick:${owner.id}:${Math.round(k.atSeconds)}`,
      type: "juked-kick",
      t: k.atSeconds,
      unitNames: [owner.name, ...(k.targetName ? [k.targetName] : [])],
      spell: k.kickSpellName,
      spellId: k.kickSpellId,
      facts: {
        t: fmt(k.atSeconds),
        kick: k.kickSpellName,
        fake: k.jukedBySpellName ?? "",
      },
    });
  }

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
