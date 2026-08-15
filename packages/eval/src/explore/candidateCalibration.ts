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
  type MatchThreatLevel,
  matchThreatLevel,
  missedSyncWindowEvents,
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
  enemyHealerName: string | null;
  legacy: LegacyRound;
}

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
 */
export function buildRoundContext(
  matchId: string,
  legacy: LegacyRound,
  roundSeq?: number,
): RoundContext | null {
  const { friends, enemies } = splitTeams(legacy);
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
  const enemyHealerName =
    enemies.find((e) => isHealerSpec(e.spec))?.name ?? null;

  return {
    matchId,
    roundSeq,
    friends,
    enemies,
    owner,
    ownerCds,
    ccWindows,
    teamOffensiveCds,
    enemyHealerName,
    legacy,
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
        ctx.enemyHealerName,
      ).length;
      unsyncedBurstRaw = unsyncedBurstEvents(
        teamOffensiveCasts,
        ctx.ccWindows,
        ctx.enemyHealerName,
        { cap: UNCAPPED },
      ).length;
    } catch {
      /* not computable -> 0/0 */
    }
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
  opts: {
    cdHoardThresholds?: CdHoardThresholds;
    threatOverrides?: IThreatLevelOverrides;
  } = {},
): RoundCandidateCounts | null {
  const ctx = buildRoundContext(matchId, legacy, roundSeq);
  if (!ctx) return null;
  return countsAtThresholds(ctx, opts);
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
  };
  threatDistributionPct: { low: number; med: number; high: number };
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
    },
    threatDistributionPct:
      n === 0
        ? { low: 0, med: 0, high: 0 }
        : {
            low: (low / n) * 100,
            med: (med / n) * 100,
            high: (high / n) * 100,
          },
  };
}
