import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { DEATH_CC_LOOKBACK_S } from "../context/criticalMoments";
import { lastCastBefore } from "../context/timelineHelpers";
import { CANDIDATE_TYPE_FLAGS } from "../data/candidateTypeFlags";
import { costNormPhrase } from "../data/curatedAbilityFacts";
import { CORPUS_OBSERVED_DISPEL_IDS } from "../data/dispelObservedGenerated";
import { MITIGATION_TABLE } from "../data/mitigationData";
import { spellEffectData } from "../data/spellEffectData";
import { SPELL_MANA_COST_TABLE } from "../data/spellManaCost";
import { ccSpellIds, trinketSpellIds } from "../data/spellTags";
import {
  analyzeBurstLedger,
  auditWindowTargeting,
  burstCastSpan,
  ON_TARGET_GOOD_PCT,
} from "../utils/burstLedger";
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
  cdAvailableAt,
  DEFENSIVE_TAGS,
  extractMajorCooldowns,
  FORBEARANCE_GATED_IDS,
  getUnitHpAtTimestamp,
  HP_SAMPLE_RADIUS_MS,
  type IAvailableWindow,
  type IMajorCooldownInfo,
  isAllyCastableDefensive,
  isHealerSpec,
  isMeleeSpec,
  MAJOR_DEFENSIVE_IDS,
  PRE_WALL_SECONDS,
  renderedWindowSeconds,
  SELF_CAST_NOOP_EXTERNAL_IDS,
  selfForbearanceActiveAt,
  specToString,
  toRenderSecond,
  USABLE_WHILE_CC_SPELL_IDS,
} from "../utils/cooldowns";
import {
  annotateMissedPurgesWithKillWindows,
  canDefensiveCleanse,
  type IMissedCleanseWindow,
  type IMissedPurgeWindow,
  reconstructDispelSummary,
} from "../utils/dispelAnalysis";
import { isBurstConverted } from "../utils/dpsMetrics";
import {
  analyzeOutgoingCCChains,
  DR_CATEGORY_MAP,
  isStunCcInstance,
} from "../utils/drAnalysis";
import {
  type IAlignedBurstWindow,
  reconstructEnemyCDTimeline,
} from "../utils/enemyCDs";
import { detectHealingGaps, type IHealingGap } from "../utils/healingGaps";
import { analyzeKickAudit } from "../utils/kickAudit";
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
import {
  type CastFailedEvent,
  castFailedInWindow,
  manaAt,
  oomWindows,
  type RawStreams,
} from "../utils/rawStreams";
import {
  type MatchThreatLevel,
  matchThreatLevel,
  threatActiveAt,
} from "../utils/threatAssessment";
import { fmtFactNum as fmt } from "./factFormat";
import type { CandidateEvent } from "./types";

/**
 * Intent guard (BACKLOG #26 Task 2, 意图守护 — "pressed but rejected ≠ never
 * pressed"): formats the `CastFailedEvent`s `castFailedInWindow` returns into
 * the `attempted` fact both `cdHoardedEvents` and `deathUnusedDefensiveEvents`
 * attach when the player actually pressed the button and the game rejected
 * the cast (stun/silence/oom/GCD/etc). Aggregated by the localized `reason`
 * string kept verbatim (rawStreams.ts's own rule — never translated or
 * normalized), most-frequent reason first; ties keep first-seen order (`Map`
 * preserves insertion order and `Array.prototype.sort` is stable, so no
 * separate tie-break is needed). `undefined` for zero hits so call sites can
 * spread `...(attempted ? { attempted } : {})` without a second presence
 * check — matches this file's existing `costNorm` optional-fact idiom.
 */
/** The reason-aggregation convention itself (Task 2): group `CastFailedEvent`s
 * by their verbatim `reason` string, most-frequent first (ties keep
 * first-seen order — `Map` preserves insertion order and `Array.prototype.sort`
 * is stable). Factored out of `formatAttemptedFact` so mana-pressure (Task 3)
 * can reuse the exact same aggregation instead of a second copy — the two
 * differ only in wrapper text (Task 2's is a negation-guard sentence, Task
 * 3's is a bare fact), never in HOW reasons get counted/ordered. `undefined`
 * for zero hits, matching this file's existing optional-fact idiom.
 */
function aggregateReasonCounts(events: CastFailedEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}×${n}`)
    .join("、");
}

function formatAttemptedFact(events: CastFailedEvent[]): string | undefined {
  const agg = aggregateReasonCounts(events);
  return agg === undefined ? undefined : `曾尝试施放被拒(${agg})`;
}

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

/** Single-source predicate (CLAUDE.md shared-predicate rule): the four
 * candidate-menu types this repo has repeatedly measured the SELECTION layer
 * (not just candidate generation) over-picking. `buildFindingsPrompt.ts`
 * enumerates these names into its per-type selection cap instruction, and
 * `auditFindings.ts` enforces the same cap deterministically on survivors —
 * both import this set rather than hand-listing the four type strings a
 * second/third time. See the BACKLOG #22 block comment above for the
 * menu-generation-side throttle these mirror. */
export const LEGACY_TOPIC_TYPES: ReadonlySet<string> = new Set([
  "missed-cleanse",
  "missed-purge",
  "cc-locked",
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

/**
 * OFFENSIVE-002 (burst-into-mitigation, 2026-08-11, BACKLOG #18 second batch):
 * a burst-ledger dominant target had a major (non-immune) mitigation cooldown
 * running that blocked >= BURST_INTO_MITIGATION_MIN_PCT of the damage school,
 * AND analyzeKillWindowTargetSelection reports a softer alternative target was
 * available at the same instant (a synthetic window built from the burst's own
 * span/target — the exact softness-comparison predicate BurstLedgerCard's
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

/**
 * HARD_CC_CATEGORIES (P1 sync-lens, 2026-08-15, `missedSyncWindowEvents` /
 * `unsyncedBurstEvents`): the DR categories that count as "the enemy healer
 * is locked out of casting" — mirrors `DR_CATEGORY_MAP`'s full PvP-relevant
 * label set (drAnalysis.ts's `SCM_CATEGORY_LABELS` already excludes
 * 'taunt'/'root' at the source, "not relevant for PvP CC analysis") minus
 * "Root" defensively (currently a no-op — no spell maps to it — kept in case
 * a future DR-category addition ever does). Two existing precedents back this
 * exact split, not a fresh invention:
 *  - `ccBreakAnalysis.ts`'s `rootBreakCount` bucket: "kept in its own bucket,
 *    never mixed into hard CC (a broken root is often a tactically correct
 *    trade, not a mistake to coach)".
 *  - `matchArchetype.ts`'s `classifiedFriendlyCCEvents`: CC events whose
 *    spell IS in the DR category map are already this file's established
 *    "hard CC" measurement; the remainder ("roots, minor incapacitates, or
 *    unmapped spells") is explicitly documented as "not hard CC".
 * Every application `analyzeOutgoingCCChains` returns is already restricted
 * to `ccSpellIds` (spellCategories' `type === "cc"`, the same set
 * `isCastBlockingAuraType` treats as cast-blocking) — this filter narrows
 * that further to the subset with recognized DR bookkeeping, matching the
 * matchArchetype.ts precedent rather than re-deriving a parallel "hard CC"
 * notion from spellCategories directly.
 */
export const HARD_CC_CATEGORIES: ReadonlySet<string> = new Set(
  Object.values(DR_CATEGORY_MAP).filter((category) => category !== "Root"),
);

export interface IEnemyHealerCcWindow {
  fromSeconds: number;
  toSeconds: number;
  spellName: string;
  spellId: string;
  healerName: string;
}

/**
 * Shared "敌治疗硬控窗" extraction (CLAUDE.md shared-predicate rule): both
 * `missedSyncWindowEvents` and `unsyncedBurstEvents` consume the exact same
 * windows so a "the healer was locked" fact can never disagree between the
 * two candidate types. Built on `analyzeOutgoingCCChains` — the same
 * outgoing-CC data source `dr-clipped-cc` already reads — filtered to
 * targets `isHealerSpec` classifies as the enemy healer, then narrowed to
 * `HARD_CC_CATEGORIES` (see its doc comment for the category decision).
 * `friends`/`enemies` decide caster/target sides exactly as every other
 * `teamPlayEvents` caller passes them; matching a chain to "the enemy healer"
 * is by `targetName` because `IOutgoingCCChain` does not carry a target unit
 * id (analyzeOutgoingCCChains' own return shape).
 *
 * Exported (review fix round 1, 2026-08-15): originally file-private, but
 * `missedSyncWindowEvents`/`unsyncedBurstEvents` are deliberately NOT wired
 * into `teamPlayEvents` yet (see that function's doc comment — Task 4 owns
 * the flag-gated wiring), which would otherwise leave this unused inside the
 * file. Exporting lets tests call it directly instead of re-deriving its
 * logic, and lets Task 4 import it unchanged when the real wiring lands.
 */
export function enemyHealerCcWindows(
  friends: any[],
  enemies: any[],
  combat: any,
): IEnemyHealerCcWindow[] {
  const healerNames = new Set(
    enemies.filter((e) => isHealerSpec(e.spec)).map((e) => e.name as string),
  );
  if (healerNames.size === 0) return [];
  const out: IEnemyHealerCcWindow[] = [];
  for (const chain of analyzeOutgoingCCChains(friends, enemies, combat)) {
    if (!healerNames.has(chain.targetName)) continue;
    for (const app of chain.applications) {
      if (!HARD_CC_CATEGORIES.has(app.drInfo.category)) continue;
      out.push({
        fromSeconds: app.atSeconds,
        toSeconds: app.atSeconds + app.durationSeconds,
        spellName: app.spellName,
        spellId: app.spellId,
        healerName: chain.targetName,
      });
    }
  }
  return out.sort((a, b) => a.fromSeconds - b.fromSeconds);
}

/** Lowest HP% across all enemy players sampled at every rendered second inside
 * [fromSeconds, toSeconds] (inclusive) — the ACCELERATOR-only fact
 * `missed-sync-window` attaches (B8: never a gate). Render-grid discipline
 * (CLAUDE.md): the query instants are `toRenderSecond`-floored before
 * sampling, same as `trinketTeamMinHpPctAt`, so this cannot contradict the
 * whole-second [STATE] HP the prompt timeline separately renders. Returns
 * null only when NO sample succeeded anywhere in the window (no advanced
 * logging) — the caller must treat null as "omit the fact", never as "0%".
 */
export function enemyMinHpPctInWindow(
  enemies: any[],
  combat: { startTime: number },
  fromSeconds: number,
  toSeconds: number,
  hpLookup: (
    unit: any,
    timestampMs: number,
    maxDtMs: number,
  ) => number | null = getUnitHpAtTimestamp,
): number | null {
  const fromR = toRenderSecond(fromSeconds);
  const toR = toRenderSecond(toSeconds);
  let min: number | null = null;
  for (let t = fromR; t <= toR; t++) {
    for (const e of enemies) {
      const hp = hpLookup(e, combat.startTime + t * 1000, HP_SAMPLE_RADIUS_MS);
      if (hp === null) continue;
      if (min === null || hp < min) min = hp;
    }
  }
  return min;
}

/** Per-match cap for missed-sync-window. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — full-corpus scan (1028
 * matches/3441 rounds, at B8's fixed no-HP-gate definition, which Task 5 has
 * no threshold lever over) measured 场均条数(capped) 1.37 (raw pre-cap 3.20),
 * comfortably inside the 0.5–2 target band; the cap is doing real
 * truncation work (raw > capped), not sitting idle. 发生率 76.4% sits above
 * every OTHER type's precedent (max 63.6%) — but that is a property of B8's
 * user-ruled "no HP gate" design already locked before Task 5, not a
 * threshold this constant can move; a lower cap would only shrink how many
 * of an already-firing round's windows get reported, not how often the type
 * fires at all. 双向误差注: a lower cap would drop real, distinct missed
 * windows from an already-high-occurrence round (each window is an
 * independent "we had the lock and didn't press it" fact); a higher cap
 * would let a single grindy round dominate the menu even more than the
 * 3.20 raw average already implies it wants to. */
const MISSED_SYNC_WINDOW_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * missed-sync-window (P1 起爆-1, 2026-08-15, user-ruled definition): a window
 * where the enemy healer sat in hard CC (`enemyHealerCcWindows`) while >=1
 * friendly offensive major cooldown was ready (`cdAvailableAt`, checked at
 * the window's start — the instant the opportunity opened) AND no friendly
 * offensive major was cast anywhere inside the window (the team had the lock
 * and the tool, and did not press it).
 *
 * B8 red line (user-ruled, non-negotiable, CI-pinned by a dedicated test):
 * NO HP gate. Enemy HP is carried in facts as an accelerator only — the B1
 * finale evidence was 93% HP burned dead in 4s once the sync actually
 * happened, so gating on a blood threshold would have suppressed the exact
 * case the whole P1 finding exists to catch. `minHp === null` (no advanced
 * logging) still emits; the fact is simply omitted, never treated as a
 * reason to withhold the candidate.
 *
 * Fact/suggestion split (CLAUDE.md decision-point-card discipline): facts
 * carry only what happened (the window existed, the CC, the ready list, the
 * observed HP) — "you should have burst" lives in buildFindingsPrompt's
 * legend text, never phrased into a fact value here.
 *
 * Severity/cap: sorted by rendered window length (CC_LOCKED-style — a longer
 * lock is a bigger missed opportunity, the same "how much time was on the
 * table" logic `cc-held` already sorts by), then capped (see the constant's
 * doc comment for the TEMPORARY-until-calibration cap value).
 */
export function missedSyncWindowEvents(
  ccWindows: Pick<
    IEnemyHealerCcWindow,
    "fromSeconds" | "toSeconds" | "spellName" | "spellId" | "healerName"
  >[],
  offensiveCds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "casts" | "cooldownSeconds" | "neverUsed"
  >[],
  probes: {
    /** Wired to enemyMinHpPctInWindow in production. Accelerator-only, see
     * the B8 doc comment above — must NEVER gate the candidate. */
    enemyMinHpPctAt: (fromSeconds: number, toSeconds: number) => number | null;
  },
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  const cap = overrides?.cap ?? MISSED_SYNC_WINDOW_CAP;
  const candidates: Array<{
    w: (typeof ccWindows)[number];
    ready: string[];
    minHp: number | null;
  }> = [];
  for (const w of ccWindows) {
    const ready = offensiveCds
      .filter((cd) => cdAvailableAt(cd, w.fromSeconds))
      .map((cd) => cd.spellName);
    if (ready.length === 0) continue;
    const castDuring = offensiveCds.some((cd) =>
      cd.casts.some(
        (c) => c.timeSeconds >= w.fromSeconds && c.timeSeconds <= w.toSeconds,
      ),
    );
    if (castDuring) continue;
    candidates.push({
      w,
      ready,
      // B8: this value only ever feeds `facts` below — it is read AFTER the
      // ready/castDuring gates above have already decided emission.
      minHp: probes.enemyMinHpPctAt(w.fromSeconds, w.toSeconds),
    });
  }
  return candidates
    .sort(
      (a, b) =>
        renderedWindowSeconds(b.w.fromSeconds, b.w.toSeconds) -
        renderedWindowSeconds(a.w.fromSeconds, a.w.toSeconds),
    )
    .slice(0, cap)
    .map(({ w, ready, minHp }) => {
      const t = toRenderSecond(w.fromSeconds);
      const windowEndT = toRenderSecond(w.toSeconds);
      return {
        // spellId disambiguates two CC windows on the same healer that floor
        // to the same rendered second (review fix round 2, 2026-08-15) — the
        // other three new candidate types (unsynced-burst/cd-hoarded/
        // cd-spent-idle) all include a spellId in their id already; this was
        // the one exception. The menu id is the eventIds reference key, so a
        // collision here corrupts adoption attribution, not just cosmetics.
        id: `missed-sync-window:${w.healerName}:${w.spellId}:${t}`,
        type: "missed-sync-window",
        t,
        unitNames: [w.healerName],
        spell: w.spellName,
        spellId: w.spellId,
        facts: {
          t: String(t),
          windowEndT: String(windowEndT),
          healer: w.healerName,
          cc: w.spellName,
          // Render-grid anchoring (CLAUDE.md 门规谓词即规范, task-2 review fix
          // round 1): must be derived from the ALREADY-floored t/windowEndT,
          // not from the raw fractional w.fromSeconds/w.toSeconds — otherwise
          // durationS can silently disagree with windowEndT - t by up to ~1s
          // whenever the CC application's real timestamps aren't whole
          // seconds (the common case on real matches).
          durationS: String(windowEndT - t),
          readyCds: ready.join("、"),
          ...(minHp !== null ? { enemyMinHpPct: fmt(minHp) } : {}),
        },
      };
    });
}

/** Per-match cap for unsynced-burst. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — same full-corpus scan as
 * `MISSED_SYNC_WINDOW_CAP` above, this type's own definition equally fixed
 * before Task 5 (no HP gate, complements `unconverted-burst` deliberately).
 * 场均条数(capped) 1.17 (raw pre-cap 1.98), inside the 0.5–2 band; 发生率
 * 69.5%, same "already-locked definition, not a Task 5 lever" caveat as
 * MISSED_SYNC_WINDOW_CAP's doc comment. 双向误差注: same shape as that
 * constant's — a lower cap drops real independent unsynced presses from an
 * already-firing round; a higher cap lets one round's raw ~2 average
 * dominate the menu further. */
const UNSYNCED_BURST_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * unsynced-burst (P1 起爆-2, 2026-08-15, user-ruled definition): a friendly
 * offensive major cooldown was cast whose effect window contained ZERO hard
 * CC on the enemy healer — the burst went out with the enemy healer free to
 * answer it. Complements the existing `unconverted-burst` (an OUTCOME fact:
 * the target didn't die) — this type is CAUSE-level (no sync happened at
 * all) and is deliberately NOT deduped against it: the same cast can produce
 * both candidates (their `id`s/eventIds are independent) because "didn't
 * convert" and "wasn't synced" are two different coaching facts about the
 * same button press.
 *
 * Effect window: `burstCastSpan` — the exact predicate the burst ledger
 * already uses for "how long is this CD's effect active", built from
 * `spellEffectData[spellId].durationSeconds` with a documented fallback
 * (`MIN_BURST_SPAN_S` = `BURST_CLUSTER_SECONDS`, enemyCDs.ts/burstLedger.ts's
 * own established default for a CD whose buff duration is unknown/instant) —
 * reused here rather than inventing a second duration-with-fallback rule.
 *
 * Severity/cap: sorted by the cooldown's own length (`cooldownSeconds`
 * descending) — the biggest-cooldown CDs are the highest-value presses to
 * burn unsynced (a 30s CD misfiring is routine; a 3-minute CD misfiring is
 * not), ties broken chronologically (stable sort). Capped per the constant's
 * doc comment above.
 *
 * `healerNames` (§29b fix, 2026-08-15): the "no hard CC overlapped this
 * cast" gate below reads `ccWindows`, which `enemyHealerCcWindows` already
 * pools across EVERY enemy healer (its `Pick<..., "fromSeconds" |
 * "toSeconds">` signature drops which healer each window belongs to on
 * purpose — this function only ever asks "was ANY enemy healer locked
 * during this span"). A pass (no window overlaps) therefore proves ALL
 * enemy healers were free, not just one — so the fact must name the full
 * set, not `enemies.find(...)`'s first match. Before this fix the wiring
 * call site passed only the first enemy healer's name, which in a
 * dual-healer comp could point at a healer who was never the one actually
 * free to answer (or omit a second healer who also was) — see BACKLOG
 * §29(b). `healerNames.length === 0` (no enemy healer on the roster) still
 * returns [] — same "no object to talk sync about" rationale the previous
 * single-name null check had.
 */
export function unsyncedBurstEvents(
  casts: Array<{
    ownerName: string;
    spellId: string;
    spellName: string;
    castTimeSeconds: number;
    cooldownSeconds: number;
  }>,
  ccWindows: Pick<IEnemyHealerCcWindow, "fromSeconds" | "toSeconds">[],
  healerNames: string[],
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  if (healerNames.length === 0) return [];
  const cap = overrides?.cap ?? UNSYNCED_BURST_CAP;
  const candidates: Array<{
    cast: (typeof casts)[number];
    windowEndT: number;
  }> = [];
  for (const cast of casts) {
    const span = burstCastSpan({
      spellId: cast.spellId,
      spellName: cast.spellName,
      castTimeSeconds: cast.castTimeSeconds,
      cooldownSeconds: cast.cooldownSeconds,
      availableAgainAtSeconds: cast.castTimeSeconds + cast.cooldownSeconds,
      buffEndSeconds:
        cast.castTimeSeconds +
        (spellEffectData[cast.spellId]?.durationSeconds ?? 0),
    });
    const hasHardCc = ccWindows.some(
      (w) => w.fromSeconds < span.to && w.toSeconds > span.from,
    );
    if (hasHardCc) continue;
    candidates.push({ cast, windowEndT: toRenderSecond(span.to) });
  }
  return candidates
    .sort(
      (a, b) =>
        b.cast.cooldownSeconds - a.cast.cooldownSeconds ||
        a.cast.castTimeSeconds - b.cast.castTimeSeconds,
    )
    .slice(0, cap)
    .map(({ cast, windowEndT }) => {
      const t = toRenderSecond(cast.castTimeSeconds);
      return {
        id: `unsynced-burst:${cast.ownerName}:${cast.spellId}:${t}`,
        type: "unsynced-burst",
        t,
        unitNames: [cast.ownerName, ...healerNames],
        spell: cast.spellName,
        spellId: cast.spellId,
        facts: {
          t: String(t),
          windowEndT: String(windowEndT),
          owner: cast.ownerName,
          spell: cast.spellName,
          // §29b fix: the gate proves ALL enemy healers were free (see the
          // function doc comment), so the fact names the full set — same
          // "、"-joined convention missedSyncWindowEvents' readyCds uses,
          // not an arbitrary first match.
          healer: healerNames.join("、"),
        },
      };
    });
}

/** cd-hoarded (P2 起爆-1, 2026-08-15): minimum idle-then-late gap before a "CD
 * sat ready" claim is worth surfacing — a CD used a few seconds after
 * readiness is normal button-press latency, not hoarding. <标定定稿
 * 2026-08-15,报告 p1p2-calibration.md>: raised from the 20s placeholder to
 * 45s. Sensitivity grid (H∈{10,20,30,45}s × crisis HP∈{35,45}%, 210
 * matches/400 rounds swept) found EVERY cell in-band on 场均条数 (1.19–1.71,
 * comfortably inside the 0.5–2 target) but every cell's 发生率 (67.0–89.5%)
 * sat above this repo's highest prior candidate-type precedent (63.6%,
 * arenacoach batch-1's COOLDOWN class) — the grid's own strictest corner
 * (H45/C35, 67.0%) was the only one close to that ceiling, so it was picked
 * rather than a middle cell. 双向误差注: a shorter H (the 20s placeholder,
 * 88.5% at its paired C45) risks flooding the menu the way this file's own
 * MISSED_CLEANSE/MISSED_PURGE/CC_LOCKED/WASTED_TRINKET throttling block
 * (above) already documents as a real failure mode; a longer H than tested
 * would start excluding genuine hoards resolved just past the 45s mark,
 * understating the pattern. */
export const CD_HOARD_MIN_LATE_S = 45; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** cd-hoarded: the own-team HP floor a hoarded window's worst moment must
 * have crossed to count as a "crisis" happened during the hoard, not just
 * "someone took a scratch". Deliberately a separate number/constant from
 * `CD_WASTE_PRESSURE_HP_PCT` — that gate asks "was the WHOLE ROUND
 * pressured", this one asks "was THIS SPECIFIC hoarded window a crisis" —
 * same shape as the cd-waste/cd-hoarded split documented on
 * `THREAT_LEVEL_LOW_MIN_HP_PCT` in threatAssessment.ts. <标定定稿 2026-08-15,
 * 报告 p1p2-calibration.md>: lowered from the 45% placeholder to 35%,
 * paired with `CD_HOARD_MIN_LATE_S`'s own strictest-tested-corner choice
 * above (same sensitivity grid, see that constant's doc comment for the
 * full occurrence-rate citation). 双向误差注: a higher bar (45%, the
 * placeholder) admits moderate-pressure dips that are not really a
 * "crisis" as a hoarding crisis, pushing 发生率 up toward 88.5%; a bar
 * below 35% (untested) would start excluding real near-death windows that
 * bottomed out in the high-20s/low-30s rather than under 35, understating
 * the pattern the same direction as too-large an H. */
export const CD_HOARD_CRISIS_HP_PCT = 35; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** Per-match cap for cd-hoarded. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed adequate at its 2-per-round placeholder —
 * raw (pre-cap) counts routinely exceed 2 even at the tightened H45/C35
 * thresholds above, so the cap is doing real truncation work, not sitting
 * unused; kept at 2 to match every other per-round-capped type in this file
 * rather than inventing a type-specific number with no comparative
 * justification. */
const CD_HOARD_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/** A single citable "crisis moment" inside a window: the worst HP% any
 * friendly reached, which friendly it was, and the rendered second it
 * happened on — cd-hoarded's fact needs a point to cite ("ally at 34% at
 * 6:30"), not just a floor value. */
export interface ICrisisMoment {
  t: number;
  unitName: string;
  hpPct: number;
}

/**
 * Worst HP% any friendly reached inside [fromSeconds, toSeconds], render-grid
 * sampled at every rendered second — same scan shape as `enemyMinHpPctInWindow`
 * (Task 2), mirrored onto the owner's own team and extended to carry back
 * WHICH unit and WHICH render second produced the worst reading (cd-hoarded's
 * crisis fact needs a citable moment, not just a number). Render-grid
 * discipline (CLAUDE.md): the caller must pass already-`toRenderSecond`-floored
 * `fromSeconds`/`toSeconds` (cd-hoarded's own `readyT`/`castT`) so the scanned
 * range can never disagree with the window shown in facts; this function
 * floors again defensively but that must be a no-op on an already-floored
 * input, never load-bearing. Returns null only when NO sample anywhere in the
 * window succeeded (no advanced logging) — the caller must treat null as
 * "cannot confirm a crisis happened", never as "0%".
 */
export function friendlyCrisisMomentInWindow(
  friends: any[],
  combat: { startTime: number },
  fromSeconds: number,
  toSeconds: number,
  hpLookup: (
    unit: any,
    timestampMs: number,
    maxDtMs: number,
  ) => number | null = getUnitHpAtTimestamp,
): ICrisisMoment | null {
  const fromR = toRenderSecond(fromSeconds);
  const toR = toRenderSecond(toSeconds);
  let worst: ICrisisMoment | null = null;
  for (let t = fromR; t <= toR; t++) {
    for (const f of friends) {
      const hp = hpLookup(f, combat.startTime + t * 1000, HP_SAMPLE_RADIUS_MS);
      if (hp === null) continue;
      if (worst === null || hp < worst.hpPct) {
        worst = { t, unitName: f.name, hpPct: hp };
      }
    }
  }
  return worst;
}

/**
 * cd-hoarded (P2 起爆-1, 2026-08-15, deep-dive-derived definition): a major
 * cooldown sat available (`IMajorCooldownInfo.availableWindows` — the
 * existing talent-corrected ledger, not recomputed here) for at least
 * `CD_HOARD_MIN_LATE_S` before it was actually pressed, AND a friendly
 * crossed below `CD_HOARD_CRISIS_HP_PCT` sometime during that same hoarded
 * window (60ab-AW shape: Avenging Wrath ready 6:20, an ally at 34% at 6:30,
 * not cast until 6:54 — the button sat on a crisis instead of answering it).
 *
 * Covers EVERY `availableWindows` entry, not just ones closed by a
 * subsequent cast (fix round 1, 2026-08-15 review — the spec text, 「大 CD
 * 转好后 ≥H 秒未按,且期间出现危机窗...→ 候选」, names no requirement of a
 * later cast). The original implementation only fired on windows closed by
 * an actual cast (`cd.casts` containing an entry at exactly `w.toSeconds`)
 * and excluded the trailing window that runs to match end with no further
 * cast, on the rationale that shape is `cd-waste`'s territory — that
 * rationale does not hold: `cd-waste` only gates on `cd.neverUsed`
 * (`casts.length === 0`, cooldowns.ts), so a CD cast once early and then
 * hoarded through a crisis to match end (`casts.length >= 1`, so
 * `neverUsed === false`) fell through BOTH types uncaught. Both shapes now
 * emit, distinguished in facts by `closedByCast`:
 *  - closed window: `castT` is the render second of the actual closing
 *    cast (still an exact-value match against `cd.casts`, not a tolerance
 *    comparison — `w.toSeconds` IS that cast's `timeSeconds`, no
 *    arithmetic in between).
 *  - trailing/unresolved window (`w.toSeconds === matchDurationSeconds`,
 *    no matching cast): `unresolved` carries the fact-not-prescription
 *    string "未再施放直至战斗结束" instead of `castT` — the button sat
 *    through the crisis and was never pressed again this match at all,
 *    arguably the worst form of the pattern this type names.
 * `lateS` means "how long the button sat idle" in both shapes — elapsed
 * ready-time to the closing cast, or elapsed ready-time to match end.
 *
 * cd-hoarded can fire on ANY major CD (offensive or defensive) — unlike
 * `cd-waste`/`cd-spent-idle`, hoarding a throughput CD like Avenging Wrath
 * during a crisis is exactly the shape this type exists to catch.
 *
 * Render-grid anchoring (CLAUDE.md): `readyT`/`endT` are floored via
 * `toRenderSecond` FIRST; `lateS` is derived from those floored endpoints
 * (never from the raw fractional `w.fromSeconds`/`w.toSeconds`), and the
 * floored endpoints — not the raw window — are what gets passed to
 * `probes.crisisMomentAt`, so the crisis this candidate cites can never fall
 * outside the window the facts display. This also means a CD that comes
 * ready in the match's final stretch, with less than `CD_HOARD_MIN_LATE_S`
 * left before `matchDurationSeconds`, is excluded by the SAME `lateS` gate
 * that governs closed windows — no separate "too close to the end" check is
 * needed, the floored-endpoint math already produces a small `lateS` for
 * that shape.
 *
 * `probes.crisisMomentAt` is wired to `friendlyCrisisMomentInWindow` in
 * production (kept as an injectable probe, same "no raw combat traversal
 * inside the pure mapper" shape every other builder in this file uses, e.g.
 * `missedSyncWindowEvents`'s `enemyMinHpPctAt`) — unlike that B8 accelerator,
 * this probe genuinely GATES the candidate (no confirmed crisis → no
 * candidate), so it must run before emission, not just annotate facts after.
 *
 * Cost-norm guard (#25 precedent, same as `cdWasteEvents`/
 * `deathUnusedDefensiveEvents`): a cost_norm ability (Divine Shield/Ice
 * Block) sitting ready through a crisis is not "you should have used it
 * sooner" — it's a last-resort tool being correctly saved. The fact still
 * carries `costNorm`; the prompt explains it.
 *
 * Severity/cap: sorted by `lateS` descending (the longer the button sat idle
 * through the crisis, the bigger the miss — unresolved windows count toward
 * the same cap as closed ones), capped at `CD_HOARD_CAP` (see that
 * constant's own doc comment for the 2026-08-15 corpus calibration).
 */
export function cdHoardedEvents(
  cds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "casts" | "availableWindows"
  >[],
  owner: { id: string; name: string },
  probes: {
    /** Wired to friendlyCrisisMomentInWindow in production. A real gate, not
     * an accelerator — see the doc comment above. */
    crisisMomentAt: (
      fromSeconds: number,
      toSeconds: number,
    ) => ICrisisMoment | null;
  },
  // Calibration-only override (Task 5, packages/eval/src/explore/
  // candidateCalibration.ts): every field defaults to its module constant, so
  // every production call site (which passes no 4th arg) is byte-identical to
  // before this was added. Exists so the corpus threshold-sensitivity sweep
  // calls this REAL builder at swept values instead of a second,
  // drift-prone reimplementation (CLAUDE.md shared-predicate rule).
  overrides?: { minLateS?: number; crisisHpPct?: number; cap?: number },
  /**
   * Intent guard (BACKLOG #26 Task 2): optional, absent/`available:false` →
   * byte-identical to before this param existed (Global Constraint: raw
   * degradation is always silent). When present, each candidate's own
   * [readyT, endT] window — the SAME already-`toRenderSecond`-floored
   * instants used for `crisisMomentAt` and written into `facts.t`/`castT` —
   * is queried for `CAST_FAILED` hits on this exact `cd.spellId`; a hit means
   * the player did try to press it, so "hoarded" is downgraded from a clean
   * negligence claim to an attempted-but-rejected one (see `facts.attempted`
   * and auditFindings.ts's matching severity downgrade).
   */
  rawStreams?: RawStreams,
): CandidateEvent[] {
  const minLateS = overrides?.minLateS ?? CD_HOARD_MIN_LATE_S;
  const crisisHpPct = overrides?.crisisHpPct ?? CD_HOARD_CRISIS_HP_PCT;
  const cap = overrides?.cap ?? CD_HOARD_CAP;
  const candidates: Array<{
    cd: (typeof cds)[number];
    readyT: number;
    endT: number;
    lateS: number;
    crisis: ICrisisMoment;
    closedByCast: boolean;
  }> = [];
  for (const cd of cds) {
    for (const w of cd.availableWindows) {
      const readyT = toRenderSecond(w.fromSeconds);
      const endT = toRenderSecond(w.toSeconds);
      const lateS = endT - readyT;
      if (lateS < minLateS) continue;
      const crisis = probes.crisisMomentAt(readyT, endT);
      if (!crisis || crisis.hpPct >= crisisHpPct) continue;
      const closedByCast = cd.casts.some((c) => c.timeSeconds === w.toSeconds);
      candidates.push({ cd, readyT, endT, lateS, crisis, closedByCast });
    }
  }
  return candidates
    .sort((a, b) => b.lateS - a.lateS)
    .slice(0, cap)
    .map(({ cd, readyT, endT, lateS, crisis, closedByCast }) => {
      const costNorm = costNormPhrase(cd.spellId);
      const failedHits = rawStreams
        ? castFailedInWindow(
            rawStreams,
            owner.id,
            readyT,
            endT,
            Number(cd.spellId),
          )
        : [];
      const attempted = formatAttemptedFact(failedHits);
      return {
        id: `cd-hoarded:${owner.id}:${cd.spellId}:${readyT}`,
        type: "cd-hoarded",
        t: readyT,
        unitNames: [owner.name, crisis.unitName],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: String(readyT),
          lateS: String(lateS),
          spell: cd.spellName,
          unit: owner.name,
          crisisT: String(crisis.t),
          crisisUnit: crisis.unitName,
          crisisHpPct: fmt(crisis.hpPct),
          ...(closedByCast
            ? { castT: String(endT) }
            : { unresolved: "未再施放直至战斗结束" }),
          ...(costNorm ? { costNorm } : {}),
          ...(attempted ? { attempted } : {}),
        },
      };
    });
}

/** Per-match cap for cd-spent-idle. <标定定稿 2026-08-15,报告
 * p1p2-calibration.md>: confirmed at 2, unchanged — full-corpus scan
 * measured 场均条数(capped) only 0.14 (raw 0.15, essentially uncapped —
 * B6's red line already does almost all the limiting: 35.1% of rounds are
 * "low" threat and return `[]` before any cast is even probed), 发生率 just
 * 11.9%, the lowest of the four new types and well under every precedent.
 * 双向误差注: a lower cap has essentially no effect (raw already sits at
 * 0.15, nowhere near 2); a higher cap likewise has no effect for the same
 * reason — this type's volume is governed by the B6 threat gate, not by
 * this cap, so there is no evidence for moving it off the shared
 * per-round-cap default. */
const CD_SPENT_IDLE_CAP = 2; // <标定定稿 2026-08-15,报告 p1p2-calibration.md>

/**
 * cd-spent-idle (P2 起爆-2, 2026-08-15, deep-dive-derived definition): a
 * defensive/survival major cooldown was cast at a moment with no active
 * enemy threat (圣佑/Blessing-of-Sanctuary blind-cast shape: pressing a
 * survival tool into dead air instead of holding it for the next real
 * window).
 *
 * "Defensive/survival CD" identification follows the exact filter this
 * file's own `slowDefensiveResponseEvents` wiring already uses in
 * `teamPlayEvents` (`DEFENSIVE_TAGS.has(cd.tag) && !cd.isThroughput` —
 * `DEFENSIVE_TAGS` = Defensive ∪ External spell tags, cooldowns.ts) rather
 * than inventing a second definition of "defensive".
 *
 * Threat gate is `threatAssessment.ts`'s single-source predicates, consumed
 * (never re-implemented) via injected probes:
 *  - per-cast gate: `probes.threatActiveAt(t)` false at the (render-floored)
 *    cast instant → candidate; true → no candidate.
 *  - **Red line B6** (non-negotiable, user-ruled): if `matchThreat` — the
 *    caller's already-computed `matchThreatLevel(...)` for the whole match —
 *    is `"low"`, this function returns `[]` before even looking at any cast,
 *    and `probes.threatActiveAt` is never invoked (pinned by a dedicated
 *    spy test: in a low-threat match, using CDs on cooldown is correct play,
 *    not a coaching point).
 *
 * Render-grid anchoring (CLAUDE.md): the cast instant is floored via
 * `toRenderSecond` BEFORE it is used for the threat gate or written into
 * facts — the same instant must decide both, or the fact could disagree
 * with the gate that produced it.
 *
 * Cost-norm guard (#25 precedent, same as `cdHoardedEvents` above): a
 * cost_norm ability spent into a lull still carries `costNorm` in facts so
 * the prompt can explain the "last resort only" caveat rather than reading
 * as a routine "you cast into nothing" callout.
 *
 * Severity/cap: sorted chronologically (earliest idle spend first — no
 * damage-value data is wired in here, mirroring `unsyncedBurstEvents`'
 * documented no-new-CD-logic constraint), capped at `CD_SPENT_IDLE_CAP`
 * (see that constant's own doc comment for the 2026-08-15 corpus
 * calibration).
 */
export function cdSpentIdleEvents(
  cds: Pick<
    IMajorCooldownInfo,
    "spellId" | "spellName" | "tag" | "isThroughput" | "casts"
  >[],
  owner: { id: string; name: string },
  matchThreat: MatchThreatLevel,
  probes: {
    /** Wired to threatAssessment.ts's threatActiveAt in production. */
    threatActiveAt: (tSeconds: number) => boolean;
  },
  // Calibration-only override, same rationale as cdHoardedEvents' — defaults
  // to the module constant, production call sites unaffected.
  overrides?: { cap?: number },
): CandidateEvent[] {
  if (matchThreat === "low") return []; // B6 red line — never even probes.
  const cap = overrides?.cap ?? CD_SPENT_IDLE_CAP;
  const defensiveCds = cds.filter(
    (cd) => DEFENSIVE_TAGS.has(cd.tag) && !cd.isThroughput,
  );
  const candidates: Array<{ cd: (typeof cds)[number]; t: number }> = [];
  for (const cd of defensiveCds) {
    for (const cast of cd.casts) {
      const t = toRenderSecond(cast.timeSeconds);
      if (probes.threatActiveAt(t)) continue;
      candidates.push({ cd, t });
    }
  }
  return candidates
    .sort((a, b) => a.t - b.t)
    .slice(0, cap)
    .map(({ cd, t }) => {
      const costNorm = costNormPhrase(cd.spellId);
      return {
        id: `cd-spent-idle:${owner.id}:${cd.spellId}:${t}`,
        type: "cd-spent-idle",
        t,
        unitNames: [owner.name],
        spell: cd.spellName,
        spellId: cd.spellId,
        facts: {
          t: String(t),
          spell: cd.spellName,
          unit: owner.name,
          ...(costNorm ? { costNorm } : {}),
        },
      };
    });
}

/** mana-pressure (BACKLOG #26 Task 3, 2026-08-15, feature-flagged off by
 * default): the friendly healer's mana% floor a contiguous run of
 * `oomWindows` samples must stay below to count as an OOM window at all —
 * the same predicate/shape `CD_HOARD_CRISIS_HP_PCT` etc. use, just against
 * `manaAt`'s manaMax-relative percent instead of HP%. <标定定稿
 * 2026-08-15,报告 raw-streams-calibration.md>: loosened 10%→15% — full-corpus
 * (n=1028 matches/3434 rounds) sweep found mana-pressure structurally rare
 * even at the loosest grid corner tested (LOW_PCT∈{5,10,15}); 15% is that
 * loosest corner and is the corpus-supported ceiling, not an arbitrary push
 * past the tested grid. Tightening-vs-loosening: LOOSENED (more permissive)
 * — trades a small amount of "how low is low" specificity for occurrence,
 * with no corpus evidence it hurt precision (the 60ab1e8f anchor's own
 * bottom, 0.2%, is unaffected either way). */
export const MANA_PRESSURE_LOW_PCT = 15; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>

/** mana-pressure: minimum window duration (render-grid seconds, post
 * tail-extension — see `extendOomTailWithFailedCasts` below) for a low-mana
 * run to be worth surfacing as a resource crisis rather than a brief dip
 * that self-resolved. <标定定稿 2026-08-15,报告 raw-streams-calibration.md>:
 * loosened 8s→5s, same "loosest tested grid corner, still below the 0.5-2/
 * round target band" finding as `MANA_PRESSURE_LOW_PCT` above (grid:
 * MIN_WINDOW_S∈{5,8,12}). Tightening-vs-loosening: LOOSENED. */
export const MANA_PRESSURE_MIN_WINDOW_S = 5; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>

/** mana-pressure: minimum rejected-cast count inside the (tail-extended)
 * window for the crisis to have actually cost the healer real casts, not
 * just idled at low mana without ever being blocked. <标定定稿
 * 2026-08-15,报告 raw-streams-calibration.md>: KEPT at the placeholder value
 * — swept {2,3,5} at the chosen LOW_PCT/MIN_WINDOW_S center on both a 200-
 * match subsample and (spot-checked) the full corpus and found it NON-
 * BINDING (identical mean occurrence at all three tiers): once a window
 * clears the length/depth gates above, it already has well over 5 rejected
 * casts in every observed instance, so this constant currently costs nothing
 * in occurrence. Left at 3 (a defensible "not just one unlucky cast" floor)
 * rather than raised — the corpus doesn't distinguish 2 vs 3 vs 5 either
 * way, so there is no data-driven reason to move it. Tightening-vs-loosening:
 * NEITHER (unchanged; would-be tightening has zero measured cost). See the
 * report's reason-mix finding below on what this gate actually counts. */
export const MANA_PRESSURE_MIN_FAILED = 3; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>

/** mana-pressure: max gap (seconds) between consecutive trailing
 * still-low-mana `CastFailedEvent`s that `extendOomTailWithFailedCasts` will
 * bridge when extending a window's `toS` past the last below-threshold mana
 * SAMPLE. Not one of the plan's three named grid constants (out of this
 * task's swept grid scope) — sanity-checked qualitatively instead via the
 * 60ab1e8f anchor (bridged window duration grew from 22s→32s under the new
 * LOW_PCT/MIN_WINDOW_S above, a proportionate extension, not a runaway one).
 * <标定定稿 2026-08-15,报告 raw-streams-calibration.md>: KEPT at the
 * placeholder value — not swept, no corpus evidence either way.
 * Tightening-vs-loosening: NEITHER (unchanged, unswept). */
export const MANA_PRESSURE_TAIL_MAX_GAP_S = 10; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>

/** Per-healer cap for mana-pressure. <标定定稿 2026-08-15,报告
 * raw-streams-calibration.md>: KEPT at 2 (this task's brief's own
 * instruction — "per-owner cap 2") — occurrence is structurally below the
 * cap almost everywhere (场均 0.257/round at final constants), so the cap
 * essentially never binds; not swept. Tightening-vs-loosening: NEITHER. */
const MANA_PRESSURE_CAP = 2; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>

/**
 * REVIEW PRESCRIPTION (Task 1 review round 0, binding — task-3-brief.md item
 * 2 / progress.md), fixed round 1 (Task 3 review, Important finding —
 * locale-string ruling): `oomWindows`' `toS` truncates at the last
 * BELOW-threshold mana SAMPLE, but samples come only from successful casts
 * (`SPELL_CAST_SUCCESS`'s advanced block) — during severe/terminal OOM those
 * go sparse while `SPELL_CAST_FAILED` keeps firing, so the sample-based
 * `toS` systematically undershoots the true end of the OOM period. Verified
 * on 60ab1e8f: `oomWindows` gives `toS=504.806` but death (the true end of
 * the crisis) is at `508.687` — a ~3.9s tail the sample-based window misses
 * entirely.
 *
 * This walks the window's own trailing `CastFailedEvent` timestamps forward
 * from `sampleToS`, extending `toS` to the last one reachable through a
 * chain of gaps each <= `MANA_PRESSURE_TAIL_MAX_GAP_S` — the same "keep the
 * window open while there is still *something* happening, close it on real
 * silence" shape `oomWindows` itself already uses for its own mana-sample
 * stream (see that function's doc comment), just applied to the failure
 * stream instead. Never shrinks `toS` — a unit with no qualifying trailing
 * failures returns `sampleToS` unchanged, byte-identical to not having this
 * extension at all.
 *
 * **Locale-independent gate (round 1 fix).** The original implementation
 * only bridged `CastFailedEvent`s whose `reason` field string-matched the
 * literal Chinese text `"法力值不足"` — `reason` is WoW's client-localized
 * combat-log text (rawStreams.ts's own module comment), so that check
 * silently never matched on any non-Chinese-client log (an English client
 * emits a different string entirely), making the whole tail-extension a
 * silent no-op for those logs with no signal that it had degraded. Fixed by
 * dropping reason-text matching entirely: a trailing `CastFailedEvent`
 * bridges the window (regardless of its `reason`) iff `manaAt(s, unitGuid,
 * c.tSeconds)` — the SAME single-source mana-lookup predicate `oomWindows`
 * itself is built on — shows the healer's mana still below `lowPct`% at
 * that failure's own instant. `manaAt` is nearest-sample-<=t, so across the
 * sparse-sample stretch this function exists to bridge it naturally holds
 * the last known (low) reading — exactly the "was the crisis still ongoing
 * when this cast was rejected" semantics wanted here, with no separate
 * hold-last-value logic needed. No sample yet at/before a failure (`manaAt`
 * returns `null`) cannot confirm the crisis was still active, so it does NOT
 * bridge (conservative: never extends on missing data). A failure whose
 * mana had already recovered above `lowPct`% (e.g. a Line-of-Sight
 * rejection moments after mana topped back up) also does not bridge — and
 * per this same reasoning, if the crisis had truly recovered, `oomWindows`
 * itself would already have closed the window at that recovery's own
 * SAMPLE (see that function's contiguous-run rule), so a genuinely-recovered
 * instant reachable from this walk can only arise from a stale hold-over —
 * i.e. this check is a correctness backstop for an edge shape, not a
 * load-bearing gate on the common path.
 *
 * Deliberately does NOT reach for `_HEAL`/`_DAMAGE` advanced-block sample
 * densification (flagged as an option in the Task 1 review, explicitly ruled
 * out of scope for this task by the review's own OOM-sparsity ruling) —
 * `castFailedInWindow`'s existing timestamps are already sufficient signal
 * for this window-boundary purpose without adding a second sample source.
 */
function extendOomTailWithFailedCasts(
  s: RawStreams,
  unitGuid: string,
  sampleToS: number,
  tailGapS: number,
  lowPct: number,
): number {
  const trailing = s.castFailed
    .filter((c) => c.unitGuid === unitGuid && c.tSeconds > sampleToS)
    .sort((a, b) => a.tSeconds - b.tSeconds);
  let extendedToS = sampleToS;
  for (const c of trailing) {
    if (c.tSeconds - extendedToS > tailGapS) break;
    const mana = manaAt(s, unitGuid, c.tSeconds);
    if (mana === null) break; // no sample yet — cannot confirm still-low, no bridge
    // Same manaMax<=0 fallback convention as oomWindows itself (rawStreams.ts).
    const pct = mana.manaMax > 0 ? (mana.mana / mana.manaMax) * 100 : 0;
    if (pct >= lowPct) break; // mana no longer below threshold — crisis ended, stop bridging
    extendedToS = c.tSeconds;
  }
  return extendedToS;
}

/**
 * mana-pressure (BACKLOG #26 Task 3, 2026-08-15, deep-dive-derived
 * definition, feature-flagged OFF by default): the FRIENDLY healer's own
 * team, not owner-scoped — a healer OOM window is the player's team's
 * resource crisis regardless of whose perspective the report is written
 * from, same "team-play" scope `missedCleanseEvents`/`missedPurgeEvents`
 * above use. Fires when `oomWindows` (tail-extended per
 * `extendOomTailWithFailedCasts` above, THEN render-grid floored) finds a
 * below-`MANA_PRESSURE_LOW_PCT`% run at least `MANA_PRESSURE_MIN_WINDOW_S`
 * seconds long, AND at least `MANA_PRESSURE_MIN_FAILED` of the healer's own
 * casts were rejected somewhere inside that same window — the OOM sample
 * alone is not enough; the crisis has to have actually cost real, blocked
 * cast attempts (60ab1e8f anchor shape: healer mana bottoms at 545/273000,
 * Holy Shock rejected 15× on "法力值不足" in the final ~10s before death).
 *
 * Render-grid anchoring (CLAUDE.md): `oomWindows`' raw fractional
 * `fromS`/(tail-extended)`toS` are floored via `toRenderSecond` FIRST;
 * `durationS` and every window-bounded query below (the rejected-cast scan,
 * the threat-contact sample) all run on those SAME floored endpoints — never
 * on the raw fractional window — so the window shown in facts can never
 * disagree with what gated or populated it.
 *
 * Facts are state-what-happened only (CLAUDE.md fact/suggestion split): the
 * OOM window's start/end/duration, the lowest mana reading in the window
 * (`facts.mana`, e.g. "545/273000"), the rejected-cast count aggregated by
 * reason (`facts.rejectedCount`/`facts.rejected` — reuses
 * `aggregateReasonCounts`, the exact aggregation convention Task 2's
 * `formatAttemptedFact` established, not a second copy of it), and whether
 * there was active enemy threat/contact anywhere in the window
 * (`facts.threat`, sampled every rendered second via the injected
 * `threatActiveAt` probe — `threatAssessment.ts`'s single-source predicate,
 * not re-derived here). This candidate carries no severity judgment either
 * way about the threat context — it is context for the prompt to reason
 * with, not a second gate (a healer can go OOM from pure attrition with no
 * single "threat" instant, and that is still a real resource crisis worth
 * surfacing).
 *
 * Severity/cap: sorted by rejected-cast count descending (the more casts the
 * crisis actually blocked, the bigger the miss), capped at
 * `MANA_PRESSURE_CAP` per healer.
 */
export function manaPressureEvents(
  rawStreams: RawStreams | undefined,
  healer: { id: string; name: string },
  probes: {
    /** Wired to threatAssessment.ts's threatActiveAt in production. */
    threatActiveAt: (tSeconds: number) => boolean;
  },
  // Calibration-only override (Task 6, packages/eval/src/explore/
  // candidateCalibration.ts): every field defaults to its module constant, so
  // every production call site (which passes no 4th arg) is byte-identical to
  // before this was added — same rationale as cdHoardedEvents'/
  // cdSpentIdleEvents' own override params.
  overrides?: {
    lowPct?: number;
    minWindowS?: number;
    minFailed?: number;
    tailGapS?: number;
    cap?: number;
  },
): CandidateEvent[] {
  // Global Constraint: raw absence degrades silently, never throws. `oomWindows`
  // itself already returns [] for `available:false`, but `rawStreams` being
  // fully `undefined` (the caller has no raw.txt at all) would crash accessing
  // `.available` inside it — guarded here before any rawStreams field access.
  if (!rawStreams) return [];
  const lowPct = overrides?.lowPct ?? MANA_PRESSURE_LOW_PCT;
  const minWindowS = overrides?.minWindowS ?? MANA_PRESSURE_MIN_WINDOW_S;
  const minFailed = overrides?.minFailed ?? MANA_PRESSURE_MIN_FAILED;
  const tailGapS = overrides?.tailGapS ?? MANA_PRESSURE_TAIL_MAX_GAP_S;
  const cap = overrides?.cap ?? MANA_PRESSURE_CAP;

  const windows = oomWindows(rawStreams, healer.id, lowPct);
  const candidates: Array<{
    fromR: number;
    toR: number;
    durationS: number;
    minMana: number;
    manaMax: number | null;
    rejected: CastFailedEvent[];
    threat: boolean;
  }> = [];
  for (const w of windows) {
    const extendedToS = extendOomTailWithFailedCasts(
      rawStreams,
      healer.id,
      w.toS,
      tailGapS,
      lowPct,
    );
    const fromR = toRenderSecond(w.fromS);
    const toR = toRenderSecond(extendedToS);
    const durationS = toR - fromR;
    if (durationS < minWindowS) continue;
    const rejected = castFailedInWindow(rawStreams, healer.id, fromR, toR);
    if (rejected.length < minFailed) continue;
    let threat = false;
    for (let t = fromR; t <= toR; t++) {
      if (probes.threatActiveAt(t)) {
        threat = true;
        break;
      }
    }
    candidates.push({
      fromR,
      toR,
      durationS,
      minMana: w.minMana,
      manaMax: manaAt(rawStreams, healer.id, fromR)?.manaMax ?? null,
      rejected,
      threat,
    });
  }
  return candidates
    .sort((a, b) => b.rejected.length - a.rejected.length)
    .slice(0, cap)
    .map(({ fromR, toR, durationS, minMana, manaMax, rejected, threat }) => ({
      id: `mana-pressure:${healer.name}:${fromR}`,
      type: "mana-pressure",
      t: fromR,
      unitNames: [healer.name],
      facts: {
        t: String(fromR),
        toT: String(toR),
        durationS: fmt(durationS),
        mana:
          manaMax === null ? fmt(minMana) : `${fmt(minMana)}/${fmt(manaMax)}`,
        rejectedCount: String(rejected.length),
        rejected: aggregateReasonCounts(rejected) ?? "",
        threat: threat ? "yes" : "no",
      },
    }));
}

/** mana-efficiency: ratio (effective-healing share ÷ mana-spent share) below
 * which the match's worst-scoring healing spell counts as inefficient enough
 * to surface. <标定定稿 2026-08-15,报告 raw-streams-calibration.md>: KEPT at
 * the brief's own placeholder (0.5) — swept {0.4,0.5,0.6}×MIN_CASTS on a
 * 200-match subsample; 0.5 already lands the full-corpus (n=1028/3434
 * rounds) 场均条数 in the 0.5-2 target band once `MANA_EFF_MIN_CASTS` (below)
 * is loosened, so no floor change was needed. A spell at exactly the floor
 * (ratio===floor) is NOT flagged (`>=` gate below), matching this file's
 * other floor/threshold conventions (e.g. `MANA_PRESSURE_LOW_PCT`'s `pct <
 * thresholdPct`) of treating the boundary value as "not yet a crisis".
 * Tightening-vs-loosening: NEITHER (unchanged). */
export const MANA_EFF_FLOOR = 0.5; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>
/** mana-efficiency: minimum successful casts of a spell before its
 * mana/healing ratio is trusted — a spell cast twice can show an arbitrarily
 * bad or good ratio from pure sample noise (an emergency single Flash Heal
 * that gets fully overhealed by a simultaneous ally cast, say). <标定定稿
 * 2026-08-15,报告 raw-streams-calibration.md>: loosened 10→8 — at 10, the
 * FULL-corpus (n=1028/3434 rounds) 场均条数 was 0.476, just under the 0.5-2
 * target band's floor (the 200-match subsample used for the initial grid
 * had suggested 0.5/10 was already in-band at 0.608, which did not hold at
 * full-corpus scale — see the report's explicit note on this discrepancy);
 * at 8 (still inside the swept {8,10,15} grid, not a value invented outside
 * it) the full-corpus mean is 0.588, in-band. Tightening-vs-loosening:
 * LOOSENED — trades a small amount of small-sample-noise protection (a
 * spell cast only 8-9 times has a less-trusted ratio than one cast 10+
 * times) for landing in the target band; no corpus evidence of a precision
 * cost, but this trade is real and worth naming. */
export const MANA_EFF_MIN_CASTS = 8; // <标定定稿 2026-08-15,报告 raw-streams-calibration.md>
/** Fact-table row cap for the per-spell breakdown — a display cap, not a
 * calibrated threshold (unlike the two constants above). */
const MANA_EFF_TABLE_TOP_N = 5;

interface IManaEfficiencySpellAgg {
  spellId: string;
  spellName: string;
  casts: number;
  /** Sum, across this spell's successful casts, of each cast's cost as a %
   * of the healer's max mana (`SPELL_MANA_COST_TABLE`'s `pct` field IS
   * already "% of max mana per cast" — summing it directly across casts
   * needs no `manaMax`/rawStreams lookup at all, see `manaEfficiencyEvents`'
   * own doc comment for why this type does not consume rawStreams). */
  manaPctSpent: number;
  /** Effective healing this spell bought: `healOut.effectiveAmount` (already
   * overheal-subtracted by parser-compat — CLAUDE.md 门规谓词即规范: reused,
   * not recomputed) plus `absorbsOut.absorbedAmount`, resolved back to this
   * spell via `resolveAgg` (exact spellId match first, `idByName` fallback
   * for the cast-id/heal-tick-id drift documented on `manaEfficiencyEvents`
   * itself), so a shield-heavy kit (e.g. Power Word: Shield) is not
   * misjudged as "0% effective healing" for its own mana spend. */
  effectiveHealing: number;
  /** Earliest render-second this spell was cast at — used as the worst
   * spell's `t` if it becomes the finding's anchor. */
  firstT: number;
}

/**
 * mana-efficiency (BACKLOG #26 Task 4, 2026-08-15, feature-flagged OFF by
 * default): a per-MATCH aggregate (not per-window like mana-pressure above)
 * — for every healing spell the healer successfully cast at least
 * `MANA_EFF_MIN_CASTS` times, compares that spell's SHARE of the healer's
 * total mana spend against its SHARE of the healer's total effective
 * healing. A spell whose healing-share is less than `MANA_EFF_FLOOR` times
 * its mana-share (e.g. the brief's own worked example: 29% of mana spent
 * buying only 11% of effective healing, ratio 0.379 < 0.5) is a real
 * resource-operations problem — the healer is systematically over-relying on
 * a spell that converts mana into healing worse than their kit as a whole
 * does. At most ONE candidate per match per healer (the worst-ratio spell
 * only) — this is a single aggregate verdict about the healer's spell
 * choices, not a per-cast or per-window event, so there is nothing to cap
 * beyond "one".
 *
 * **Deliberately does NOT consume `rawStreams`** (unlike mana-pressure
 * above): `SPELL_MANA_COST_TABLE`'s `pct` field is already "% of max mana
 * per cast", so summing it across a spell's casts directly gives that
 * spell's share of total mana spend — no absolute `manaMax` value, and
 * therefore no raw.txt mana-sample stream, is ever needed. This also means
 * the degradation shape for this type is NOT "raw unavailable → 0" (there is
 * no raw dependency to degrade); it is "a cast's spellId has no resolvable
 * entry in `SPELL_MANA_COST_TABLE` (unknown spell, or a spec-conditional
 * spell cast by a spec the generated table has no row for) → that cast
 * contributes to neither mana-share nor healing-share, silently, same as any
 * other missing-data skip in this file — never throws, never guesses a
 * cost" (see the generator's own module header for why guessing would be
 * worse than skipping).
 *
 * Facts are state-what-happened only (CLAUDE.md fact/suggestion split): the
 * worst spell's name/mana-share/healing-share/cast-count
 * (`facts.worstSpell`/`worstManaPct`/`worstHealPct`/`worstCasts`), its ratio
 * (`facts.worstRatio`), and a per-spell breakdown table
 * (`facts.table`, top `MANA_EFF_TABLE_TOP_N` spells by mana-share
 * descending) so the prompt can see the worst spell in the context of the
 * healer's whole kit rather than an isolated number. No severity judgment
 * about WHY the ratio is low is made here (a legitimate emergency-heal spell
 * used sparingly under pressure can still look inefficient in isolation) —
 * that reasoning is left to the prompt.
 */
export function manaEfficiencyEvents(
  healer: { id: string; name: string; spec: string },
  healerUnit: {
    spellCastEvents: Array<{
      spellId?: string;
      spellName?: string;
      logLine: { event: string; timestamp: number };
    }>;
    healOut: Array<{
      spellId?: string;
      spellName?: string;
      effectiveAmount: number;
    }>;
    absorbsOut: Array<{
      spellId?: string;
      spellName?: string;
      absorbedAmount: number;
    }>;
  },
  matchStartMs: number,
  // Calibration-only override (Task 6), same rationale as this file's other
  // builders' override params — every production call site passes no 5th
  // arg, so production is byte-identical to before this was added.
  overrides?: { floor?: number; minCasts?: number },
): CandidateEvent[] {
  const floor = overrides?.floor ?? MANA_EFF_FLOOR;
  const minCasts = overrides?.minCasts ?? MANA_EFF_MIN_CASTS;

  const bySpell = new Map<string, IManaEfficiencySpellAgg>();
  // Cast-id → heal-tick-id drift (found via this builder's OWN Task 4
  // real-match sanity check, match 60ab1e8f): a spell's SPELL_CAST_SUCCESS
  // and the SPELL_HEAL/SPELL_ABSORBED events it produces do not always share
  // one spellId — Holy Shock casts as `20473` but its heal ticks log under
  // `25914` (195 heal events / 4,002,189 effective healing in that one
  // match, ALL of it silently dropped before this fix); Prayer of Mending
  // casts as `33076` but heals as `33110`. Both pairs share the EXACT same
  // `spellName` on both the cast and the heal event (verified against real
  // data, not assumed) — `idByName` below lets `healOut`/`absorbsOut`
  // resolve to the correct aggregate by name when the id doesn't match
  // directly. Within one player's own cast list a name collision across two
  // DIFFERENT abilities is not a realistic risk (a modern-retail character
  // has exactly one castable ability per display name in their own kit), so
  // first-seen-wins is an acceptable, simple resolution — see
  // task-4-report.md for the full before/after numbers this fix produced.
  const idByName = new Map<string, string>();
  for (const e of healerUnit.spellCastEvents) {
    if (e.logLine.event !== "SPELL_CAST_SUCCESS") continue;
    const spellId = e.spellId;
    if (!spellId) continue;
    const row = SPELL_MANA_COST_TABLE[spellId];
    const raw =
      row?.bySpec?.[healer.spec] ??
      (row && row.pct !== undefined ? row : undefined);
    // Unknown spell, a flat-cost row (no healing-relevant spell in the
    // generated table uses `flat` — see genSpellManaCost.ts's module header;
    // `pct === undefined` here in practice only reaches a `bySpec`-only
    // entry whose spec didn't match), or a spec-conditional spell with no
    // row for this healer's own spec — skipped, never guessed.
    if (!raw || raw.pct === undefined) continue;
    const t = toRenderSecond((e.logLine.timestamp - matchStartMs) / 1000);
    const agg = bySpell.get(spellId) ?? {
      spellId,
      spellName: e.spellName ?? spellId,
      casts: 0,
      manaPctSpent: 0,
      effectiveHealing: 0,
      firstT: t,
    };
    agg.casts += 1;
    agg.manaPctSpent += raw.pct;
    agg.firstT = Math.min(agg.firstT, t);
    bySpell.set(spellId, agg);
    if (e.spellName && !idByName.has(e.spellName)) {
      idByName.set(e.spellName, spellId);
    }
  }
  if (bySpell.size === 0) return [];

  const resolveAgg = (
    spellId: string | undefined,
    spellName: string | undefined,
  ): IManaEfficiencySpellAgg | undefined => {
    if (spellId) {
      const byId = bySpell.get(spellId);
      if (byId) return byId;
    }
    if (spellName) {
      const canonicalId = idByName.get(spellName);
      if (canonicalId) return bySpell.get(canonicalId);
    }
    return undefined;
  };

  const healingCapable = new Set<string>();
  for (const h of healerUnit.healOut) {
    const agg = resolveAgg(h.spellId, h.spellName);
    if (agg) {
      agg.effectiveHealing += Math.abs(h.effectiveAmount);
      healingCapable.add(agg.spellId);
    }
  }
  for (const a of healerUnit.absorbsOut) {
    const agg = resolveAgg(a.spellId, a.spellName);
    if (agg) {
      agg.effectiveHealing += Math.abs(a.absorbedAmount);
      healingCapable.add(agg.spellId);
    }
  }
  // Scope to healing-capable spells only (real-match sanity finding, match
  // 60ab1e8f, task-4-report.md): a spell that never once produced a
  // healOut/absorbsOut event for this unit — PRESENCE, not amount, is the
  // signal — is not a healing spell at all, just something that happens to
  // cost mana (a dispel like Purify, a filler like Judgment). The brief's
  // own scope ("healing-SPELL mana spent") excludes these; without this
  // filter, both this builder's own real-match anchors (60ab1e8f) picked a
  // non-healing utility spell as "worst" ahead of any actual healing spell,
  // which is not an actionable mana-efficiency finding. A genuinely healing
  // spell that gets 100%-overhealed on EVERY cast still emits healOut events
  // (effectiveAmount=0 each) and stays eligible — that "spammed a heal that
  // never lands" shape is this candidate type's headline case, not something
  // this filter should catch.
  for (const spellId of [...bySpell.keys()]) {
    if (!healingCapable.has(spellId)) bySpell.delete(spellId);
  }
  if (bySpell.size === 0) return [];

  const totalManaPct = [...bySpell.values()].reduce(
    (s, a) => s + a.manaPctSpent,
    0,
  );
  const totalEffectiveHealing = [...bySpell.values()].reduce(
    (s, a) => s + a.effectiveHealing,
    0,
  );
  // No mana spent (shouldn't happen — bySpell is non-empty only via costed
  // casts) or no effective healing at all (a healer who cast healing spells
  // that ALL fully overhealed/were absorbed-away — a real but degenerate
  // case with no meaningful per-spell ratio to compare) — nothing to score.
  if (totalManaPct <= 0 || totalEffectiveHealing <= 0) return [];

  const scored = [...bySpell.values()].map((agg) => {
    const manaShare = agg.manaPctSpent / totalManaPct;
    const healShare = agg.effectiveHealing / totalEffectiveHealing;
    // manaShare > 0 always holds here: every bySpell entry accumulated at
    // least one cast with raw.pct > 0 (costEntry in the generator only ever
    // sets `pct` when it is > 0), so no divide-by-zero guard is needed.
    return { agg, manaShare, healShare, ratio: healShare / manaShare };
  });

  const eligible = scored.filter((s) => s.agg.casts >= minCasts);
  if (eligible.length === 0) return [];
  const worst = eligible.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  if (worst.ratio >= floor) return [];

  const tableRows = [...scored]
    .sort((a, b) => b.manaShare - a.manaShare)
    .slice(0, MANA_EFF_TABLE_TOP_N);

  const t = worst.agg.firstT;
  return [
    {
      id: `mana-efficiency:${healer.name}:${t}`,
      type: "mana-efficiency",
      t,
      unitNames: [healer.name],
      spell: worst.agg.spellName,
      spellId: worst.agg.spellId,
      facts: {
        t: String(t),
        worstSpell: worst.agg.spellName,
        worstManaPct: fmt(worst.manaShare * 100),
        worstHealPct: fmt(worst.healShare * 100),
        worstCasts: String(worst.agg.casts),
        worstRatio: fmt(worst.ratio),
        table: tableRows
          .map(
            (r) =>
              `${r.agg.spellName} 蓝耗${fmt(r.manaShare * 100)}%/有效治疗${fmt(r.healShare * 100)}%(${r.agg.casts}次)`,
          )
          .join("; "),
      },
    },
  ];
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
  // default false → this block is a no-op and production output is
  // byte-identical to before this wiring landed.
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
      /** DR category of this CC instance (e.g. "Stun"/"Incapacitate"/
       * "Disorient"/…), when known — same field as ICCInstance.drInfo.category
       * (DR_CATEGORIES_GENERATED, shared-predicate rule). Used by
       * deathUnusedDefensiveEvents to gate the USABLE_WHILE_CC_SPELL_IDS check
       * (finding #1, 2026-08-14 final review): that table is stunned-only —
       * a non-stun CC active at death must exempt unconditionally rather than
       * being checked against it. Optional/nullable so hand-built test
       * fixtures without DR data still type-check (absence reads as "not
       * stun", the conservative direction). */
      drInfo?: { category: string } | null;
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
  /**
   * Intent guard (BACKLOG #26 Task 2): optional, absent/`available:false` →
   * byte-identical to before this param existed. For each listed wall, the
   * window queried is [the wall's own most-recent-cast-before-death +
   * cooldownSeconds (or 0 if never cast), deathT] — the same "available
   * since" instant the `walls` filter above already established via
   * `cdAvailableAt`, so the query window can never disagree with why the
   * wall was already counted as available.
   */
  rawStreams?: RawStreams,
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
  // USABLE_WHILE_CC abilities are exempt, and only when the CC active at
  // death is itself Stun-category (finding #1, 2026-08-14 final review):
  // USABLE_WHILE_CC_SPELL_IDS is a stunned-only table (DB2's "usable while
  // stunned" attribute), so a Fear/Disorient/Incapacitate at death must
  // exempt unconditionally rather than being checked against it — see
  // wasLockedOutByStunOnly (deathOutcomeAnalysis.ts) for the fuller story
  // behind the same fix applied there for the windowed lockout case.
  const ccAtDeathIsStunOnly = !!ccAtDeath && isStunCcInstance(ccAtDeath);

  // selfForbearanceActiveAt needs the whole-match unit list and matchStartMs —
  // derived from the same source as units/start in extractCandidateFindings
  // (see the top of that function).
  const allUnits: any[] = combat ? Object.values(combat.units ?? {}) : [];
  const matchStartMs: number = combat?.startTime ?? 0;

  const walls = (parts.victimCDs ?? []).filter((cd) => {
    if (cd.tag !== "Defensive") return false;
    if ((cd as IMajorCooldownInfo).isThroughput) return false;
    if (!cdAvailableAt(cd as IMajorCooldownInfo, deathT)) return false;
    if (freeState === null) {
      if (!ccAtDeathIsStunOnly) return false;
      if (!USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId)) return false;
    }
    if (
      FORBEARANCE_GATED_IDS.has(cd.spellId) &&
      victim.unit &&
      combat &&
      selfForbearanceActiveAt(victim.unit, allUnits, deathT, matchStartMs)
    )
      return false;
    // A damage-redirect external self-cast is a mechanical no-op (Blessing of
    // Sacrifice transfers damage TO the caster), so it is not a wall this
    // player could have pressed to survive. Shares the set with the prompt's
    // death line and with cooldowns.ts's "cheaper available" guard.
    if (SELF_CAST_NOOP_EXTERNAL_IDS.has(cd.spellId)) return false;
    return true;
  });
  if (walls.length === 0) return [];
  const listedWalls = walls.slice(0, UNUSED_DEFENSIVE_MAX_LISTED);
  // Cost-norm guard (#25, 2026-08-14): the first listed wall that is a
  // signed-off cost_norm ability (Divine Shield/Ice Block) supplies the
  // caveat — "off cooldown and unused" reads exactly like "you should have
  // pressed it" bait for an ability whose real cost rule is "last resort
  // only". Same precedent as missed-cleanse's ownerCanDispel gate: the fact
  // carries the guard, buildFindingsPrompt explains the field.
  const costNorm = listedWalls
    .map((w) => costNormPhrase(w.spellId))
    .find((phrase): phrase is string => phrase !== null);
  // Intent guard (BACKLOG #26 Task 2): per listed wall, "available since" is
  // its own most-recent cast before death + its cooldown (0 if never cast) —
  // the same instant that made `cdAvailableAt` accept it into `walls` above,
  // so this can never disagree with why the wall counts as available. Hits
  // across all listed walls are pooled into one `attempted` fact (the
  // candidate is one-per-death, not one-per-wall).
  const failedHits = rawStreams
    ? listedWalls.flatMap((w) => {
        const lastCast = [...w.casts]
          .filter((c) => c.timeSeconds <= deathT)
          .pop();
        const fromS = Math.max(
          0,
          lastCast ? lastCast.timeSeconds + w.cooldownSeconds : 0,
        );
        return castFailedInWindow(
          rawStreams,
          parts.victim.id,
          fromS,
          deathT,
          Number(w.spellId),
        );
      })
    : [];
  const attempted = formatAttemptedFact(failedHits);
  return [
    {
      id: `death-unused-defensive:${parts.victim.id}:${Math.round(deathT)}`,
      type: "death-unused-defensive",
      t: deathT,
      unitNames: [parts.victim.name],
      facts: {
        t: fmt(deathT),
        unit: parts.victim.name,
        walls: listedWalls.map((w) => w.spellName).join(", "),
        free: freeState ?? "usable_in_cc",
        ...(costNorm ? { costNorm } : {}),
        ...(attempted ? { attempted } : {}),
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
