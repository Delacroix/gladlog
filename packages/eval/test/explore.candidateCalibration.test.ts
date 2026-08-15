/**
 * Task 5 (P1/P2 distillation) fixture tests for
 * `../src/explore/candidateCalibration.ts` — the corpus calibration scan for
 * the four new candidate builders + threatAssessment's predicates. Per
 * CLAUDE.md ("don't leave a one-shot script"), this scanner is meant to run
 * again for future calibration passes, so its wiring/aggregation logic gets
 * real unit coverage rather than only being exercised by the (unrepeated)
 * corpus scan CLI run.
 *
 * Deliberately does NOT re-verify each builder's own filtering rules (those
 * are candidateFindings.test.ts's / threatAssessment.test.ts's job) — only
 * this module's own glue: context building, raw-vs-capped counting via the
 * `overrides` threading, the missed-sync/unsynced-burst zero-ccWindows short
 * circuit, and `summarize`'s arithmetic.
 */
import type { ICombatUnit } from "@gladlog/parser-compat";
import { CombatUnitReaction } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  buildRoundContext,
  countsAtThresholds,
  type RoundCandidateCounts,
  type RoundContext,
  summarize,
} from "../src/explore/candidateCalibration";
import type { LegacyRound } from "../src/explore/storeAccess";

const START = 1_000_000;

function unit(overrides: Partial<ICombatUnit> = {}): ICombatUnit {
  return {
    id: overrides.id ?? "u1",
    name: overrides.name ?? "Unit-Realm",
    reaction: overrides.reaction ?? CombatUnitReaction.Friendly,
    info: overrides.info ?? ({} as never),
    class: overrides.class ?? ("Priest" as never),
    spec: overrides.spec ?? (undefined as never),
    advancedActions: overrides.advancedActions ?? [],
    damageIn: overrides.damageIn ?? [],
    auraEvents: overrides.auraEvents ?? [],
    spellCastEvents: overrides.spellCastEvents ?? [],
    deathRecords: overrides.deathRecords ?? [],
    ...overrides,
  } as unknown as ICombatUnit;
}

function legacyOf(units: ICombatUnit[]): LegacyRound {
  const byId: Record<string, ICombatUnit> = {};
  for (const u of units) byId[u.id] = u;
  return {
    units: byId,
    playerId: units[0]?.id,
    startTime: START,
    endTime: START + 300_000,
  } as unknown as LegacyRound;
}

describe("buildRoundContext", () => {
  it("returns null when there is no friendly player (mirrors teamPlayEvents' own early return)", () => {
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    expect(buildRoundContext("m1", legacyOf([enemy]))).toBeNull();
  });

  it("returns null when there is no enemy player", () => {
    const friend = unit({ id: "f1", reaction: CombatUnitReaction.Friendly });
    expect(buildRoundContext("m1", legacyOf([friend]))).toBeNull();
  });

  it("owner falls back to the first friendly player when none is a healer spec", () => {
    const friend = unit({ id: "f1", reaction: CombatUnitReaction.Friendly });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = buildRoundContext("m1", legacyOf([friend, enemy]));
    expect(ctx?.owner.id).toBe("f1");
  });

  it("carries matchId/roundSeq through unchanged", () => {
    const friend = unit({ id: "f1", reaction: CombatUnitReaction.Friendly });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = buildRoundContext("m-abc", legacyOf([friend, enemy]), 2);
    expect(ctx?.matchId).toBe("m-abc");
    expect(ctx?.roundSeq).toBe(2);
  });
});

/** Hand-built context (bypassing buildRoundContext/splitTeams) so the
 * threshold-override-threading tests below don't depend on
 * extractMajorCooldowns/enemyHealerCcWindows succeeding on a synthetic unit —
 * only countsAtThresholds' own wiring is under test here. */
function makeCtx(overrides: Partial<RoundContext> = {}): RoundContext {
  const friend = unit({ id: "f1", reaction: CombatUnitReaction.Friendly });
  const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
  return {
    matchId: "m1",
    roundSeq: undefined,
    friends: [friend],
    enemies: [enemy],
    owner: friend,
    ownerCds: [],
    ccWindows: [],
    teamOffensiveCds: [],
    enemyHealerName: null,
    legacy: legacyOf([friend, enemy]),
    ...overrides,
  };
}

describe("countsAtThresholds — cd-hoarded threshold threading", () => {
  const cd = {
    spellId: "1",
    spellName: "Wall",
    tag: "Defensive",
    cooldownSeconds: 300,
    maxChargesDetected: 1,
    casts: [],
    availableWindows: [{ fromSeconds: 0, toSeconds: 25, durationSeconds: 25 }],
    neverUsed: true,
  };
  // A synthetic ctx with a 25s-idle window; friendlyCrisisMomentInWindow is
  // the REAL predicate (not mocked) — no advancedActions on the fixture
  // friend means it will return null (no HP data), so this specific fixture
  // alone can't exercise the crisis gate. That gate is candidateFindings.
  // test.ts's job; here we only need the minLateS gate to differ, which
  // requires a crisis to exist at all — so give the friend a real HP dip.
  function advancedAction(
    timestamp: number,
    currentHp: number,
    maxHp = 100_000,
  ) {
    return {
      logLine: { timestamp },
      advancedActorId: "f1",
      advancedActorMaxHp: maxHp,
      advancedActorCurrentHp: currentHp,
    } as never;
  }

  function ctxWithDip(troughPct: number): RoundContext {
    const friend = unit({
      id: "f1",
      reaction: CombatUnitReaction.Friendly,
      advancedActions: [
        advancedAction(START, 100_000),
        advancedAction(START + 10_000, (troughPct / 100) * 100_000),
      ],
    });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    return makeCtx({
      friends: [friend],
      owner: friend,
      ownerCds: [cd],
      legacy: legacyOf([friend, enemy]),
    });
  }

  it("minLateS gate: a 25s window counts at minLateS=10 but not at minLateS=30", () => {
    const ctx = ctxWithDip(30);
    const loose = countsAtThresholds(ctx, {
      cdHoardThresholds: { minLateS: 10, crisisHpPct: 45 },
    });
    const strict = countsAtThresholds(ctx, {
      cdHoardThresholds: { minLateS: 30, crisisHpPct: 45 },
    });
    expect(loose.cdHoardedCapped).toBe(1);
    expect(strict.cdHoardedCapped).toBe(0);
  });

  it("crisisHpPct gate: a 30% trough counts against a 45% bar but not a 20% bar", () => {
    const ctx = ctxWithDip(30);
    const permissive = countsAtThresholds(ctx, {
      cdHoardThresholds: { minLateS: 10, crisisHpPct: 45 },
    });
    const strict = countsAtThresholds(ctx, {
      cdHoardThresholds: { minLateS: 10, crisisHpPct: 20 },
    });
    expect(permissive.cdHoardedCapped).toBe(1);
    expect(strict.cdHoardedCapped).toBe(0);
  });

  it("raw count is read through the same builder with an uncapped override, never a second rule", () => {
    const twoWindowCd = {
      ...cd,
      availableWindows: [
        { fromSeconds: 0, toSeconds: 25, durationSeconds: 25 },
        { fromSeconds: 30, toSeconds: 60, durationSeconds: 30 },
      ],
    };
    // A crisis dip inside EACH window (t=10 for the first, t=40 for the
    // second) so both windows independently qualify.
    const friend = unit({
      id: "f1",
      reaction: CombatUnitReaction.Friendly,
      advancedActions: [
        advancedAction(START, 100_000),
        advancedAction(START + 10_000, 10_000),
        advancedAction(START + 20_000, 100_000),
        advancedAction(START + 40_000, 10_000),
      ],
    });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = makeCtx({
      friends: [friend],
      owner: friend,
      ownerCds: [twoWindowCd],
      legacy: legacyOf([friend, enemy]),
    });
    const counts = countsAtThresholds(ctx, {
      cdHoardThresholds: { minLateS: 10, crisisHpPct: 45 },
    });
    // Both windows qualify (raw=2); production's own default cap (2) doesn't
    // truncate here, so capped also reads 2 — the assertion that matters is
    // raw>=capped and both come from the real builder, not a hand count.
    expect(counts.cdHoardedRaw).toBeGreaterThanOrEqual(counts.cdHoardedCapped);
    expect(counts.cdHoardedRaw).toBe(2);
  });
});

describe("countsAtThresholds — missed-sync-window/unsynced-burst zero-ccWindows short circuit", () => {
  it("both read 0/0 without any ccWindows, mirroring teamPlayEvents' own gate", () => {
    const ctx = makeCtx({ ccWindows: [] });
    const counts = countsAtThresholds(ctx);
    expect(counts.missedSyncWindowCapped).toBe(0);
    expect(counts.missedSyncWindowRaw).toBe(0);
    expect(counts.unsyncedBurstCapped).toBe(0);
    expect(counts.unsyncedBurstRaw).toBe(0);
  });
});

describe("countsAtThresholds — cd-spent-idle honors the threat-level red line (B6)", () => {
  it("threatOverrides that force a 'low' match threat still gate cd-spent-idle to []", () => {
    // No advancedActions anywhere → hasAnyHpData is false → matchThreatLevel
    // is unconditionally "low" regardless of overrides (the documented
    // conservative fallback) — exercises the real gate, not a mock.
    const cd = {
      spellId: "2",
      spellName: "Barrier",
      tag: "Defensive",
      cooldownSeconds: 180,
      maxChargesDetected: 1,
      casts: [{ timeSeconds: 50 }],
      availableWindows: [],
      neverUsed: false,
      isThroughput: false,
    };
    const ctx = makeCtx({ ownerCds: [cd] });
    const counts = countsAtThresholds(ctx);
    expect(counts.threatLevel).toBe("low");
    expect(counts.cdSpentIdleCapped).toBe(0);
  });
});

describe("summarize", () => {
  function row(overrides: Partial<RoundCandidateCounts>): RoundCandidateCounts {
    return {
      matchId: "m",
      cdHoardedRaw: 0,
      cdHoardedCapped: 0,
      cdSpentIdleRaw: 0,
      cdSpentIdleCapped: 0,
      missedSyncWindowRaw: 0,
      missedSyncWindowCapped: 0,
      unsyncedBurstRaw: 0,
      unsyncedBurstCapped: 0,
      threatLevel: "low",
      ...overrides,
    };
  }

  it("computes occurrence rate / mean-per-round for one type across 4 rounds", () => {
    const rows = [
      row({ cdHoardedCapped: 2, cdHoardedRaw: 3 }),
      row({ cdHoardedCapped: 0, cdHoardedRaw: 0 }),
      row({ cdHoardedCapped: 1, cdHoardedRaw: 1 }),
      row({ cdHoardedCapped: 0, cdHoardedRaw: 0 }),
    ];
    const s = summarize(rows);
    expect(s.roundsScanned).toBe(4);
    expect(s.perType.cdHoarded.occurrenceRatePct).toBe(50); // 2/4 rounds have >=1
    expect(s.perType.cdHoarded.meanCappedPerRound).toBeCloseTo(0.75); // (2+0+1+0)/4
    expect(s.perType.cdHoarded.meanRawPerRound).toBeCloseTo(1.0); // (3+0+1+0)/4
  });

  it("threat distribution sums to 100% across low/med/high", () => {
    const rows = [
      row({ threatLevel: "low" }),
      row({ threatLevel: "low" }),
      row({ threatLevel: "med" }),
      row({ threatLevel: "high" }),
    ];
    const s = summarize(rows);
    expect(s.threatDistributionPct.low).toBe(50);
    expect(s.threatDistributionPct.med).toBe(25);
    expect(s.threatDistributionPct.high).toBe(25);
  });

  it("empty input never divides by zero", () => {
    const s = summarize([]);
    expect(s.roundsScanned).toBe(0);
    expect(s.perType.cdHoarded.occurrenceRatePct).toBe(0);
    expect(s.threatDistributionPct).toEqual({ low: 0, med: 0, high: 0 });
  });
});
