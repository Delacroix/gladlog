/**
 * candidateCalibration.ts — Task 5 (P1/P2 distillation) corpus calibration for
 * the four new candidate-menu builders (missedSyncWindowEvents /
 * unsyncedBurstEvents / cdHoardedEvents / cdSpentIdleEvents, all currently
 * held off by `CANDIDATE_TYPE_FLAGS`, see `data/candidateTypeFlags.ts`) and
 * the shared threat predicates they/other callers consume
 * (`matchThreatLevel`/`threatActiveAt`, `utils/threatAssessment.ts`).
 *
 * Direct-calls the REAL production builders — never a re-derived detection
 * rule (CLAUDE.md shared-predicate rule). Two consequences of that:
 *  - `buildRoundContext` replicates ONLY the wiring glue `teamPlayEvents`
 *    (candidateFindings.ts) already does to hand each builder its probes —
 *    friends/enemies split, the default-healer owner convention, the shared
 *    `enemyHealerCcWindows`/team-offensive-CD lists — not any filtering
 *    logic. If that wiring ever drifts from `teamPlayEvents`, the fixture
 *    test in `candidateCalibration.test.ts` (constant thresholds, full
 *    pipeline via `buildRoundContext` + `countsAtThresholds`) pins the parity.
 *  - Threshold *sensitivity* (the H/crisis-HP grid, the threat window tiers)
 *    calls the SAME builders with the `overrides` parameter each one gained
 *    in this same Task 5 pass (see `cdHoardedEvents` in candidateFindings.ts
 *    and `matchThreatLevel`/`threatActiveAt` in threatAssessment.ts) — a
 *    sweep is not a second implementation, it is the real function called at
 *    different constants. Omitting overrides entirely reproduces today's
 *    production behavior.
 *
 * `buildRoundContext` does the one-time, I/O-adjacent work per round
 * (`extractMajorCooldowns` per friendly, `enemyHealerCcWindows`) so a
 * sensitivity sweep over N grid cells does not re-parse/re-derive anything —
 * only `countsAtThresholds` (pure, cheap) runs per cell.
 */
import {
  type CandidateEvent,
  cdHoardedEvents,
  cdSpentIdleEvents,
  enemyHealerCcWindows,
  enemyMinHpPctInWindow,
  extractMajorCooldowns,
  friendlyCrisisMomentInWindow,
  type IEnemyHealerCcWindow,
  type IMajorCooldownInfo,
  isHealerSpec,
  type IThreatLevelOverrides,
  manaEfficiencyEvents,
  manaPressureEvents,
  type MatchThreatLevel,
  matchThreatLevel,
  missedSyncWindowEvents,
  type RawStreams,
  threatActiveAt,
  unsyncedBurstEvents,
} from "@gladlog/analysis";
import type { ICombatUnit } from "@gladlog/parser-compat";

import { type LegacyRound, splitTeams } from "./storeAccess.js";

/** Effectively-unbounded cap override so a builder's RAW (pre-truncation)
 * candidate count can be measured through the same code path as its capped
 * (real, shippable) count — never a second counting rule. */
const UNCAPPED = 1_000_000;

export interface CdHoardThresholds {
  minLateS: number;
  crisisHpPct: number;
}

/** One round's precomputed wiring context — everything `teamPlayEvents`
 * derives once and reuses across builders, held here so a sensitivity sweep
 * can call `countsAtThresholds` repeatedly without re-deriving any of it. */
export interface RoundContext {
  matchId: string;
  roundSeq?: number;
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  owner: ICombatUnit;
  ownerCds: IMajorCooldownInfo[];
  ccWindows: IEnemyHealerCcWindow[];
  teamOffensiveCds: Array<IMajorCooldownInfo & { ownerName: string }>;
  /** §29b fix (2026-08-15, mirrors production's candidateFindings.ts wiring
   * unchanged): every enemy healer, not just the first match — the gate
   * `unsyncedBurstEvents` reads (`ccWindows`) already pools hard-CC across
   * all of them, so the fact must too. */
  enemyHealerNames: string[];
  legacy: LegacyRound;
  /** Whether `splitTeams(legacy).owner` (production's OWN `resolveOwner`
   * predicate, mirrored — see `buildRoundContext`'s doc comment) resolved —
   * `false` means production would show NO candidates for this round at all.
   * Task 6's corpus report uses this to give mana-pressure/mana-efficiency a
   * production-gated denominator ALONGSIDE the naive one every other type in
   * this module already reports, per the P1/P2 owner-phantom lesson. */
  ownerResolvable: boolean;
  /** Task 6 (raw-streams calibration) addition: `parseRawStreams(readRawText(
   * store, matchId), legacy.startTime)` — same time base (`legacy.startTime`)
   * production wires as `combat.startTime` in candidateFindings.ts's
   * `extractCandidateFindings` caller. Callers that never pass a 4th arg to
   * `buildRoundContext` get `{available:false, manaSamples:[], castFailed:[]}`
   * here (mana-pressure/mana-efficiency read through this exactly like
   * production reads `available:false` — silently zero, never throws), so
   * every pre-Task-6 call site (the cd-hoarded/cd-spent-idle/missed-sync/
   * unsynced-burst scan this module already supported) is byte-identical to
   * before this field existed. */
  rawStreams: RawStreams;
}

/** `buildRoundContext` callers that don't have raw.txt on hand (or don't care
 * about the two mana-* types) pass no 4th arg and get this — identical shape
 * to `parseRawStreams(null, ...)`'s own `available:false` result, so
 * `manaPressureEvents`/`manaEfficiencyEvents` degrade exactly like production
 * does when raw.txt is missing (Global Constraint). */
const UNAVAILABLE_RAW_STREAMS: RawStreams = {
  available: false,
  manaSamples: [],
  castFailed: [],
};

/**
 * Builds one round's wiring context. Returns `null` when the round has no
 * player on both sides (mirrors `teamPlayEvents`' own early return) — the
 * caller must skip, not fabricate zero counts for, a round this returns null
 * for.
 *
 * Owner resolution mirrors production's default single-owner convention
 * (`resolveOwner` falling back to the friendly healer, documented at several
 * call sites in candidateFindings.ts, e.g. `BURST_INTO_MITIGATION_MIN_PCT`'s
 * doc comment) — first the friendly healer, else the first friendly player.
 * This is a corpus-representativeness choice, not a detection rule: it
 * matches what the shipped default-owner report actually computes.
 *
 * `RoundContext.ownerResolvable` (Task 6 addition, the P1/P2 distillation
 * owner-phantom lesson applied PROSPECTIVELY instead of retroactively —
 * `p1p2-calibration.md`'s "owner-resolution selection-bias" correction found
 * this scan's own `owner` above ALWAYS resolves (`?? friends[0]` never
 * fails), while production's real gate (`analysisInput.ts`'s `resolveOwner`)
 * returns `undefined` when neither the log's own `playerId` nor any friendly
 * healer is found — a round `resolveOwner` misses is a round production shows
 * NO candidates for at all, of ANY type, not just an owner-scoped one.
 * `splitTeams(legacy).owner` (this same file's own import, `storeAccess.ts`)
 * already computes that exact resolvable-or-undefined predicate — it is
 * simply not what `owner` above is set to, by design (see this comment's
 * first paragraph). Reading it here, in ADDITION to (never replacing) the
 * existing unconditional `owner`, closes the gap for `mana-pressure`/
 * `mana-efficiency` prospectively without touching the already-calibrated,
 * already-shipped four P1/P2 types' historical methodology or byte-for-byte
 * `RoundCandidateCounts` shape for them. */
export function buildRoundContext(
  matchId: string,
  legacy: LegacyRound,
  roundSeq?: number,
  rawStreams?: RawStreams,
): RoundContext | null {
  const { friends, enemies, owner: productionOwner } = splitTeams(legacy);
  if (friends.length === 0 || enemies.length === 0) return null;
  const owner = friends.find((u) => isHealerSpec(u.spec)) ?? friends[0];

  let ownerCds: IMajorCooldownInfo[] = [];
  try {
    ownerCds = extractMajorCooldowns(owner, legacy);
  } catch {
    ownerCds = [];
  }

  const ccWindows = enemyHealerCcWindows(friends, enemies, legacy);
  const teamOffensiveCds: Array<IMajorCooldownInfo & { ownerName: string }> =
    [];
  for (const f of friends) {
    try {
      for (const cd of extractMajorCooldowns(f, legacy)) {
        if (!cd.isThroughput) continue;
        teamOffensiveCds.push({ ...cd, ownerName: f.name });
      }
    } catch {
      /* this friend's CD ledger not computable -> their CDs absent */
    }
  }
  const enemyHealerNames = enemies
    .filter((e) => isHealerSpec(e.spec))
    .map((e) => e.name as string);

  return {
    matchId,
    roundSeq,
    friends,
    enemies,
    owner,
    ownerCds,
    ccWindows,
    teamOffensiveCds,
    enemyHealerNames,
    legacy,
    ownerResolvable: productionOwner !== undefined,
    rawStreams: rawStreams ?? UNAVAILABLE_RAW_STREAMS,
  };
}

export interface RoundCandidateCounts {
  matchId: string;
  roundSeq?: number;
  cdHoardedRaw: number;
  cdHoardedCapped: number;
  cdSpentIdleRaw: number;
  cdSpentIdleCapped: number;
  missedSyncWindowRaw: number;
  missedSyncWindowCapped: number;
  unsyncedBurstRaw: number;
  unsyncedBurstCapped: number;
  threatLevel: MatchThreatLevel;
  /** Task 6 additions. mana-efficiency has no `cap` param at all (at most one
   * candidate per healer per round by construction — see
   * `manaEfficiencyEvents`' own doc comment), so there is no raw/capped
   * distinction to make; `manaEfficiencyCount` is the single 0-or-1 count,
   * read through both `typeSummary`'s raw/capped keys identically (see
   * `summarize` below) rather than inventing a meaningless second field. */
  manaPressureRaw: number;
  manaPressureCapped: number;
  manaEfficiencyCount: number;
  /** `ctx.rawStreams.available` carried through so a corpus scan can report
   * what fraction of rounds had no raw.txt (or an unparseable one) — the
   * denominator both mana-* types silently zero out against without any
   * other signal in this row. */
  rawAvailable: boolean;
  /** `ctx.ownerResolvable` carried through — see `RoundContext`'s own doc
   * comment (P1/P2 owner-phantom lesson). */
  ownerResolvable: boolean;
}

/**
 * Pure, cheap: counts every builder's raw (uncapped) and capped (shipped)
 * candidate count for one already-built round context, at the given
 * threshold overrides. No I/O, no re-derivation — every count comes from
 * calling the real exported builder. `cdHoardThresholds`/`threatOverrides`
 * omitted reproduces production's default thresholds exactly (each builder's
 * own default-param fallback to its module constant).
 *
 * missed-sync-window / unsynced-burst mirror `teamPlayEvents`' own gate: with
 * zero `ccWindows` (no hard CC ever landed on the enemy healer), both are
 * structurally zero — not computed, since "no window existed to test" is a
 * different fact from "windows existed and none qualified".
 */
export function countsAtThresholds(
  ctx: RoundContext,
  opts: {
    cdHoardThresholds?: CdHoardThresholds;
    threatOverrides?: IThreatLevelOverrides;
    /** Task 6: every field defaults to its module constant in
     * `manaPressureEvents` itself — omitting this entirely reproduces
     * production's default thresholds exactly, same convention as
     * `cdHoardThresholds` above. */
    manaPressureThresholds?: {
      lowPct?: number;
      minWindowS?: number;
      minFailed?: number;
      tailGapS?: number;
    };
    manaEfficiencyThresholds?: { floor?: number; minCasts?: number };
  } = {},
): RoundCandidateCounts {
  const { friends, enemies, owner, ownerCds, legacy } = ctx;

  let threatLevel: MatchThreatLevel = "low";
  try {
    threatLevel = matchThreatLevel(
      enemies,
      friends,
      legacy,
      opts.threatOverrides,
    );
  } catch {
    threatLevel = "low";
  }

  let cdHoardedRaw = 0;
  let cdHoardedCapped = 0;
  try {
    const crisisMomentAt = (from: number, to: number) =>
      friendlyCrisisMomentInWindow(friends, legacy, from, to);
    cdHoardedCapped = cdHoardedEvents(
      ownerCds,
      owner,
      { crisisMomentAt },
      opts.cdHoardThresholds,
    ).length;
    cdHoardedRaw = cdHoardedEvents(
      ownerCds,
      owner,
      { crisisMomentAt },
      { ...opts.cdHoardThresholds, cap: UNCAPPED },
    ).length;
  } catch {
    /* not computable -> 0/0 */
  }

  let cdSpentIdleRaw = 0;
  let cdSpentIdleCapped = 0;
  try {
    const probes = {
      threatActiveAt: (t: number) =>
        threatActiveAt(t, enemies, friends, legacy, {
          damageWindowMs: opts.threatOverrides?.damageWindowMs,
        }),
    };
    cdSpentIdleCapped = cdSpentIdleEvents(
      ownerCds,
      owner,
      threatLevel,
      probes,
    ).length;
    cdSpentIdleRaw = cdSpentIdleEvents(ownerCds, owner, threatLevel, probes, {
      cap: UNCAPPED,
    }).length;
  } catch {
    /* not computable -> 0/0 */
  }

  let missedSyncWindowRaw = 0;
  let missedSyncWindowCapped = 0;
  let unsyncedBurstRaw = 0;
  let unsyncedBurstCapped = 0;
  if (ctx.ccWindows.length > 0) {
    try {
      const syncProbes = {
        enemyMinHpPctAt: (from: number, to: number) =>
          enemyMinHpPctInWindow(enemies, legacy, from, to),
      };
      missedSyncWindowCapped = missedSyncWindowEvents(
        ctx.ccWindows,
        ctx.teamOffensiveCds,
        syncProbes,
      ).length;
      missedSyncWindowRaw = missedSyncWindowEvents(
        ctx.ccWindows,
        ctx.teamOffensiveCds,
        syncProbes,
        { cap: UNCAPPED },
      ).length;
    } catch {
      /* not computable -> 0/0 */
    }
    try {
      const teamOffensiveCasts = ctx.teamOffensiveCds.flatMap((cd) =>
        cd.casts.map((c) => ({
          ownerName: cd.ownerName,
          spellId: cd.spellId,
          spellName: cd.spellName,
          castTimeSeconds: c.timeSeconds,
          cooldownSeconds: cd.cooldownSeconds,
        })),
      );
      unsyncedBurstCapped = unsyncedBurstEvents(
        teamOffensiveCasts,
        ctx.ccWindows,
        ctx.enemyHealerNames,
      ).length;
      unsyncedBurstRaw = unsyncedBurstEvents(
        teamOffensiveCasts,
        ctx.ccWindows,
        ctx.enemyHealerNames,
        { cap: UNCAPPED },
      ).length;
    } catch {
      /* not computable -> 0/0 */
    }
  }

  // mana-pressure/mana-efficiency (Task 6): both are team-scoped off the
  // friendly healer, same `friends.find(isHealerSpec)` resolution production
  // wires in candidateFindings.ts's `extractCandidateFindings` — a round with
  // no friendly healer skips both, same as production's own `if (teamHealer)`
  // guard, not a fabricated 0 from a missing lookup. Wrapped per-type in its
  // own try/catch (this module's own convention, every block above) so one
  // type's failure never zeroes the other's count.
  let manaPressureRaw = 0;
  let manaPressureCapped = 0;
  try {
    const teamHealer = friends.find((u) => isHealerSpec(u.spec));
    if (teamHealer) {
      const probes = {
        threatActiveAt: (t: number) =>
          threatActiveAt(t, enemies, friends, legacy, {
            damageWindowMs: opts.threatOverrides?.damageWindowMs,
          }),
      };
      manaPressureCapped = manaPressureEvents(
        ctx.rawStreams,
        teamHealer,
        probes,
        opts.manaPressureThresholds,
      ).length;
      manaPressureRaw = manaPressureEvents(ctx.rawStreams, teamHealer, probes, {
        ...opts.manaPressureThresholds,
        cap: UNCAPPED,
      }).length;
    }
  } catch {
    /* not computable -> 0/0 */
  }

  let manaEfficiencyCount = 0;
  try {
    const teamHealer = friends.find((u) => isHealerSpec(u.spec));
    if (teamHealer) {
      manaEfficiencyCount = manaEfficiencyEvents(
        teamHealer,
        teamHealer,
        legacy.startTime,
        opts.manaEfficiencyThresholds,
      ).length;
    }
  } catch {
    /* not computable -> 0 */
  }

  return {
    matchId: ctx.matchId,
    roundSeq: ctx.roundSeq,
    cdHoardedRaw,
    cdHoardedCapped,
    cdSpentIdleRaw,
    cdSpentIdleCapped,
    missedSyncWindowRaw,
    missedSyncWindowCapped,
    unsyncedBurstRaw,
    unsyncedBurstCapped,
    threatLevel,
    manaPressureRaw,
    manaPressureCapped,
    manaEfficiencyCount,
    rawAvailable: ctx.rawStreams.available,
    ownerResolvable: ctx.ownerResolvable,
  };
}

/** One-shot convenience: build the context and count at the given
 * thresholds. What the CLI's main (n>=500, final-constants) scan calls per
 * round; the sensitivity sweep instead calls `buildRoundContext` once and
 * `countsAtThresholds` many times (see the module header). */
export function scanRound(
  matchId: string,
  legacy: LegacyRound,
  roundSeq: number | undefined,
  opts: Parameters<typeof countsAtThresholds>[1] = {},
  // Task 6: trailing optional param (not folded into `opts`) so every
  // pre-Task-6 call site (positional `opts` as the 4th arg) keeps compiling
  // and behaving byte-identically — `rawStreams` omitted degrades to
  // `UNAVAILABLE_RAW_STREAMS` via `buildRoundContext`'s own default.
  rawStreams?: RawStreams,
): RoundCandidateCounts | null {
  const ctx = buildRoundContext(matchId, legacy, roundSeq, rawStreams);
  if (!ctx) return null;
  return countsAtThresholds(ctx, opts);
}

/** Task 6 thin wrapper: the actual `mana-pressure` candidate EVENTS (not just
 * counts) for one already-built round context, at the given threshold
 * overrides — direct-calls the real `manaPressureEvents` builder, never a
 * re-derived rule (same CLAUDE.md shared-predicate discipline as
 * `countsAtThresholds`). Exists because the corpus report needs more than a
 * count for fired candidates: threat-context share and rejected-cast
 * reason-mix (both plan Task 6 deliverables) can only be read off the
 * builder's own `facts`, not reconstructed from an integer. Cheap to call
 * only for rounds `countsAtThresholds` already reported `manaPressureCapped >
 * 0` for — never the full corpus. */
export function manaPressureCandidatesAtThresholds(
  ctx: RoundContext,
  overrides?: {
    lowPct?: number;
    minWindowS?: number;
    minFailed?: number;
    tailGapS?: number;
    cap?: number;
  },
): CandidateEvent[] {
  const teamHealer = ctx.friends.find((u) => isHealerSpec(u.spec));
  if (!teamHealer) return [];
  const probes = {
    threatActiveAt: (t: number) =>
      threatActiveAt(t, ctx.enemies, ctx.friends, ctx.legacy),
  };
  return manaPressureEvents(ctx.rawStreams, teamHealer, probes, overrides);
}

export interface TypeSummary {
  occurrenceRatePct: number;
  meanCappedPerRound: number;
  meanRawPerRound: number;
}

export interface CalibrationSummary {
  roundsScanned: number;
  perType: {
    cdHoarded: TypeSummary;
    cdSpentIdle: TypeSummary;
    missedSyncWindow: TypeSummary;
    unsyncedBurst: TypeSummary;
    manaPressure: TypeSummary;
    /** mana-efficiency has no raw/capped distinction (see
     * `RoundCandidateCounts.manaEfficiencyCount`'s own doc comment) —
     * `meanRawPerRound`/`meanCappedPerRound` are identical here by
     * construction, not a bug in `typeSummary`. */
    manaEfficiency: TypeSummary;
  };
  threatDistributionPct: { low: number; med: number; high: number };
  /** Task 6: % of scanned rounds where `ctx.rawStreams.available` was true —
   * the denominator both mana-* types silently zero out against otherwise
   * (plan Task 6 deliverable "raw.txt availability rate"). */
  rawAvailableRatePct: number;
  /** Task 6 (P1/P2 owner-phantom lesson, applied prospectively): the SAME two
   * `TypeSummary`s as `perType.manaPressure`/`manaEfficiency` above, but
   * computed over ONLY the rows where `ownerResolvable` is true — the subset
   * production would actually generate ANY candidates for. Report BOTH (this
   * field and `perType` above) rather than picking one, per the plan's own
   * "报告 BOTH per-round and per-match denominators explicitly" instruction
   * extended to this second denominator split. */
  productionGated: {
    roundsOwnerResolvable: number;
    manaPressure: TypeSummary;
    manaEfficiency: TypeSummary;
  };
}

function typeSummary(
  rows: RoundCandidateCounts[],
  rawKey: keyof RoundCandidateCounts,
  cappedKey: keyof RoundCandidateCounts,
): TypeSummary {
  const n = rows.length;
  if (n === 0)
    return { occurrenceRatePct: 0, meanCappedPerRound: 0, meanRawPerRound: 0 };
  const capped = rows.map((r) => r[cappedKey] as number);
  const raw = rows.map((r) => r[rawKey] as number);
  const occurrence = capped.filter((c) => c > 0).length;
  return {
    occurrenceRatePct: (occurrence / n) * 100,
    meanCappedPerRound: capped.reduce((a, b) => a + b, 0) / n,
    meanRawPerRound: raw.reduce((a, b) => a + b, 0) / n,
  };
}

/** Aggregates a corpus scan's per-round rows into the report-shaped summary:
 * per-type 发生率 (% rounds with >=1 capped candidate) + 场均条数 (mean capped
 * count/round, plus mean raw for cap-truncation visibility) + threat-level
 * distribution. */
export function summarize(rows: RoundCandidateCounts[]): CalibrationSummary {
  const n = rows.length;
  const low = rows.filter((r) => r.threatLevel === "low").length;
  const med = rows.filter((r) => r.threatLevel === "med").length;
  const high = rows.filter((r) => r.threatLevel === "high").length;
  const rawAvailable = rows.filter((r) => r.rawAvailable).length;
  return {
    roundsScanned: n,
    perType: {
      cdHoarded: typeSummary(rows, "cdHoardedRaw", "cdHoardedCapped"),
      cdSpentIdle: typeSummary(rows, "cdSpentIdleRaw", "cdSpentIdleCapped"),
      missedSyncWindow: typeSummary(
        rows,
        "missedSyncWindowRaw",
        "missedSyncWindowCapped",
      ),
      unsyncedBurst: typeSummary(
        rows,
        "unsyncedBurstRaw",
        "unsyncedBurstCapped",
      ),
      manaPressure: typeSummary(rows, "manaPressureRaw", "manaPressureCapped"),
      manaEfficiency: typeSummary(
        rows,
        "manaEfficiencyCount",
        "manaEfficiencyCount",
      ),
    },
    threatDistributionPct:
      n === 0
        ? { low: 0, med: 0, high: 0 }
        : {
            low: (low / n) * 100,
            med: (med / n) * 100,
            high: (high / n) * 100,
          },
    rawAvailableRatePct: n === 0 ? 0 : (rawAvailable / n) * 100,
    productionGated: (() => {
      const gated = rows.filter((r) => r.ownerResolvable);
      return {
        roundsOwnerResolvable: gated.length,
        manaPressure: typeSummary(
          gated,
          "manaPressureRaw",
          "manaPressureCapped",
        ),
        manaEfficiency: typeSummary(
          gated,
          "manaEfficiencyCount",
          "manaEfficiencyCount",
        ),
      };
    })(),
  };
}
