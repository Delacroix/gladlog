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
import type { RawStreams } from "@gladlog/analysis";
import type { ICombatUnit } from "@gladlog/parser-compat";
import { CombatUnitReaction } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  buildRoundContext,
  countsAtThresholds,
  manaPressureCandidatesAtThresholds,
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

  // Task 6 (P1/P2 owner-phantom lesson applied prospectively): `owner` above
  // always resolves via `?? friends[0]`, but `ownerResolvable` mirrors
  // production's real `resolveOwner` gate (`splitTeams`'s own `owner`, which
  // CAN be undefined) — the two must diverge on exactly this fixture shape.
  it("ownerResolvable is false when neither playerId nor a healer spec resolves (mirrors resolveOwner's own undefined case)", () => {
    const friend = unit({
      id: "f1",
      spec: "0" as never, // not a healer spec
      reaction: CombatUnitReaction.Friendly,
    });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const legacy = {
      units: { f1: friend, e1: enemy },
      playerId: "no-such-id",
      startTime: START,
      endTime: START + 300_000,
    } as unknown as LegacyRound;
    const ctx = buildRoundContext("m1", legacy);
    // owner (unconditional fallback) still resolves...
    expect(ctx?.owner.id).toBe("f1");
    // ...but ownerResolvable correctly reports production would show nothing.
    expect(ctx?.ownerResolvable).toBe(false);
  });

  it("ownerResolvable is true when a friendly healer exists even without a playerId match", () => {
    const friend = unit({
      id: "f1",
      spec: "257" as never, // Priest_Holy
      reaction: CombatUnitReaction.Friendly,
    });
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const legacy = {
      units: { f1: friend, e1: enemy },
      playerId: "no-such-id",
      startTime: START,
      endTime: START + 300_000,
    } as unknown as LegacyRound;
    const ctx = buildRoundContext("m1", legacy);
    expect(ctx?.ownerResolvable).toBe(true);
  });
});

/**
 * Parity vs `resolveOwner`'s own truth table (Task 6 review round 1,
 * 2026-08-15, task-6-review.md Important #2). `ownerResolvable`
 * (`splitTeams(legacy).owner !== undefined`, `storeAccess.ts`) is a
 * hand-written mirror of production's `resolveOwner`
 * (`packages/desktop/src/renderer/src/report/derive/analysisInput.ts:31-45`)
 * — NOT an import (`packages/eval` cannot depend on that file: it pulls in
 * an Electron-renderer `window.gladlog` bridge that has no place in a Node
 * vitest run). CLAUDE.md's shared-predicate fallback for a genuinely
 * unshareable export is a pinned equality table; this is the SAME five-case
 * table as `packages/desktop/test/analysisInput.test.ts`'s
 * `describe("resolveOwner")` block (cases ①-⑤ below correspond 1:1 to that
 * file's ①-⑤) — both files must be updated together if either function's
 * branch structure ever changes. Registered in `docs/predicate-index.md`'s
 * "Not yet unified" section.
 *
 * Each case here adds one harmless enemy unit beyond what
 * `resolveOwner`'s own table needs (`buildRoundContext` returns `null` for
 * any round with zero enemies — a gate unrelated to owner resolution
 * itself, see its own doc comment), and asserts on `ownerResolvable`
 * (undefined-or-not) rather than a resolved unit id, since that is the only
 * thing `RoundContext` exposes — `owner` itself is deliberately the
 * DIFFERENT, always-resolving predicate (see the tests above).
 */
describe("ownerResolvable parity vs resolveOwner's own truth table", () => {
  function legacyOfWithPlayerId(
    units: ICombatUnit[],
    playerId: string,
  ): LegacyRound {
    const byId: Record<string, ICombatUnit> = {};
    for (const u of units) byId[u.id] = u;
    return {
      units: byId,
      playerId,
      startTime: START,
      endTime: START + 300_000,
    } as unknown as LegacyRound;
  }

  it("① playerId 命中一个友方玩家 → resolvable(不看是不是治疗)", () => {
    const p1 = unit({ id: "p1", reaction: CombatUnitReaction.Friendly });
    const e1 = unit({
      id: "e1",
      reaction: CombatUnitReaction.Hostile,
      spec: "257" as never,
    });
    const ctx = buildRoundContext("m1", legacyOfWithPlayerId([p1, e1], "p1"));
    expect(ctx?.ownerResolvable).toBe(true);
  });

  it("② playerId 不命中任何人,但存在友方治疗 → resolvable(回退到治疗)", () => {
    const p1 = unit({ id: "p1", reaction: CombatUnitReaction.Friendly });
    const heal = unit({
      id: "heal",
      reaction: CombatUnitReaction.Friendly,
      spec: "257" as never, // Priest_Holy
    });
    const e1 = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = buildRoundContext(
      "m1",
      legacyOfWithPlayerId([p1, heal, e1], "no-such-id"),
    );
    expect(ctx?.ownerResolvable).toBe(true);
  });

  it("③ playerId 命中的是敌方单位(id 巧合)→ 不算数,回退到友方治疗 → resolvable", () => {
    const p1 = unit({ id: "p1", reaction: CombatUnitReaction.Hostile });
    const heal = unit({
      id: "heal",
      reaction: CombatUnitReaction.Friendly,
      spec: "257" as never,
    });
    const ctx = buildRoundContext("m1", legacyOfWithPlayerId([p1, heal], "p1"));
    expect(ctx?.ownerResolvable).toBe(true);
  });

  it("④ playerId 命中的友方单位没有 info(非玩家,如宠物)→ 不算数,回退到友方治疗 → resolvable", () => {
    const pet = unit({
      id: "pet",
      reaction: CombatUnitReaction.Friendly,
      info: undefined as never,
    });
    const heal = unit({
      id: "heal",
      reaction: CombatUnitReaction.Friendly,
      spec: "257" as never,
    });
    const e1 = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = buildRoundContext(
      "m1",
      legacyOfWithPlayerId([pet, heal, e1], "pet"),
    );
    expect(ctx?.ownerResolvable).toBe(true);
  });

  it("⑤ playerId 不命中,且没有任何友方治疗 → NOT resolvable", () => {
    const p1 = unit({
      id: "p1",
      reaction: CombatUnitReaction.Friendly,
      spec: "0" as never,
    });
    const e1 = unit({
      id: "e1",
      reaction: CombatUnitReaction.Hostile,
      spec: "257" as never,
    });
    const ctx = buildRoundContext(
      "m1",
      legacyOfWithPlayerId([p1, e1], "no-such-id"),
    );
    expect(ctx?.ownerResolvable).toBe(false);
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
    enemyHealerNames: [],
    legacy: legacyOf([friend, enemy]),
    rawStreams: { available: false, manaSamples: [], castFailed: [] },
    ownerResolvable: true,
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

// Task 6 (raw-streams calibration) additions. Fixture shapes mirror
// candidateFindings.test.ts's own mana-pressure/mana-efficiency fixtures
// (real anchor spellIds 20473/82326 for efficiency, same window/reject
// magnitudes for pressure) — this file's job is only the calibration-module
// glue (rawStreams threading, overrides threading, rawAvailable), not
// re-verifying the builders' own filtering rules.
function manaRawStreams(): RawStreams {
  return {
    available: true,
    manaSamples: [
      { tSeconds: 10, unitGuid: "h", mana: 15000, manaMax: 273000 },
      { tSeconds: 15, unitGuid: "h", mana: 8000, manaMax: 273000 },
      { tSeconds: 20, unitGuid: "h", mana: 545, manaMax: 273000 },
    ],
    castFailed: [
      {
        tSeconds: 12,
        unitGuid: "h",
        spellId: 20473,
        spellName: "Holy Shock",
        reason: "法力值不足",
      },
      {
        tSeconds: 16,
        unitGuid: "h",
        spellId: 20473,
        spellName: "Holy Shock",
        reason: "法力值不足",
      },
      {
        tSeconds: 19,
        unitGuid: "h",
        spellId: 20473,
        spellName: "Holy Shock",
        reason: "法力值不足",
      },
    ],
  };
}

function healerUnit(overrides: Partial<ICombatUnit> = {}): ICombatUnit {
  return unit({
    id: "h",
    name: "Healer-R",
    spec: "257" as never, // Priest_Holy
    reaction: CombatUnitReaction.Friendly,
    ...overrides,
  });
}

describe("buildRoundContext — rawStreams threading (Task 6)", () => {
  it("threads a passed rawStreams through onto the returned context unchanged", () => {
    const friend = healerUnit();
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const raw = manaRawStreams();
    const ctx = buildRoundContext(
      "m1",
      legacyOf([friend, enemy]),
      undefined,
      raw,
    );
    expect(ctx?.rawStreams).toBe(raw);
  });

  it("no 4th arg -> rawStreams defaults to available:false (byte-identical to every pre-Task-6 call site)", () => {
    const friend = healerUnit();
    const enemy = unit({ id: "e1", reaction: CombatUnitReaction.Hostile });
    const ctx = buildRoundContext("m1", legacyOf([friend, enemy]));
    expect(ctx?.rawStreams).toEqual({
      available: false,
      manaSamples: [],
      castFailed: [],
    });
  });
});

describe("countsAtThresholds — mana-pressure threshold threading (Task 6)", () => {
  it("production defaults (no overrides): OOM window + 3 rejected casts -> 1 candidate, raw===capped", () => {
    const ctx = makeCtx({
      friends: [healerUnit()],
      rawStreams: manaRawStreams(),
    });
    const counts = countsAtThresholds(ctx);
    expect(counts.manaPressureCapped).toBe(1);
    expect(counts.manaPressureRaw).toBe(1);
  });

  it("minWindowS override stricter than the window's own 10s duration -> 0", () => {
    const ctx = makeCtx({
      friends: [healerUnit()],
      rawStreams: manaRawStreams(),
    });
    const counts = countsAtThresholds(ctx, {
      manaPressureThresholds: { minWindowS: 20 },
    });
    expect(counts.manaPressureCapped).toBe(0);
  });

  it("minFailed override looser than the actual 3 rejects still fires; stricter than 3 zeroes it", () => {
    const ctx = makeCtx({
      friends: [healerUnit()],
      rawStreams: manaRawStreams(),
    });
    expect(
      countsAtThresholds(ctx, {
        manaPressureThresholds: { minFailed: 2 },
      }).manaPressureCapped,
    ).toBe(1);
    expect(
      countsAtThresholds(ctx, {
        manaPressureThresholds: { minFailed: 4 },
      }).manaPressureCapped,
    ).toBe(0);
  });

  it("no friendly healer in the round -> 0/0, not a crash", () => {
    const nonHealer = unit({
      id: "f1",
      spec: "0" as never,
      reaction: CombatUnitReaction.Friendly,
    });
    const ctx = makeCtx({ friends: [nonHealer], rawStreams: manaRawStreams() });
    const counts = countsAtThresholds(ctx);
    expect(counts.manaPressureCapped).toBe(0);
    expect(counts.manaPressureRaw).toBe(0);
  });

  it("raw unavailable (available:false) -> 0/0, mirrors production's silent degrade", () => {
    const ctx = makeCtx({ friends: [healerUnit()] }); // makeCtx's own rawStreams default
    const counts = countsAtThresholds(ctx);
    expect(counts.manaPressureCapped).toBe(0);
    expect(counts.rawAvailable).toBe(false);
  });
});

describe("manaPressureCandidatesAtThresholds (Task 6)", () => {
  it("returns the real builder's candidate events (facts, not just a count) for the report's threat/reason-mix breakdown", () => {
    const ctx = makeCtx({
      friends: [healerUnit()],
      rawStreams: manaRawStreams(),
    });
    const evts = manaPressureCandidatesAtThresholds(ctx);
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe("mana-pressure");
    expect(evts[0]!.facts.rejectedCount).toBe("3");
  });
});

describe("countsAtThresholds — mana-efficiency threshold threading (Task 6)", () => {
  function castSuccess(spellId: string, spellName: string, tMs: number) {
    return {
      spellId,
      spellName,
      logLine: { event: "SPELL_CAST_SUCCESS", timestamp: tMs },
    };
  }

  // Same worked shape as candidateFindings.test.ts's own ① case: Holy Shock
  // (20473, unconditional 2%/cast) heavily overused relative to its healing
  // share against Holy Light (82326, unconditional 7%/cast) — ratio(A)≈0.275,
  // well under the production default floor (0.5).
  function efficiencyHealer(): ICombatUnit {
    const spellCastEvents = [
      ...Array.from({ length: 20 }, (_, i) =>
        castSuccess("20473", "Holy Shock", 1000 + i * 1000),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        castSuccess("82326", "Holy Light", 30000 + i * 1000),
      ),
    ];
    const healOut = [
      { spellId: "20473", effectiveAmount: 1000 },
      { spellId: "82326", effectiveAmount: 9000 },
    ];
    return healerUnit({
      spellCastEvents: spellCastEvents as never,
      healOut: healOut as never,
      absorbsOut: [] as never,
    } as Partial<ICombatUnit>);
  }

  it("production defaults: 1 candidate (ratio under the 0.5 floor, both spells over the 10-cast sample gate)", () => {
    const ctx = makeCtx({ friends: [efficiencyHealer()] });
    expect(countsAtThresholds(ctx).manaEfficiencyCount).toBe(1);
  });

  it("floor override at 0 (nothing can score below it) -> 0", () => {
    const ctx = makeCtx({ friends: [efficiencyHealer()] });
    expect(
      countsAtThresholds(ctx, {
        manaEfficiencyThresholds: { floor: 0 },
      }).manaEfficiencyCount,
    ).toBe(0);
  });

  it("minCasts override above the 20/10-cast sample sizes -> 0 (sample-size gate)", () => {
    const ctx = makeCtx({ friends: [efficiencyHealer()] });
    expect(
      countsAtThresholds(ctx, {
        manaEfficiencyThresholds: { minCasts: 25 },
      }).manaEfficiencyCount,
    ).toBe(0);
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
      manaPressureRaw: 0,
      manaPressureCapped: 0,
      manaEfficiencyCount: 0,
      rawAvailable: false,
      ownerResolvable: true,
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
    expect(s.rawAvailableRatePct).toBe(0);
  });

  it("Task 6: manaPressure/manaEfficiency per-type stats + rawAvailableRatePct", () => {
    const rows = [
      row({
        manaPressureCapped: 1,
        manaPressureRaw: 2,
        manaEfficiencyCount: 1,
        rawAvailable: true,
      }),
      row({
        manaPressureCapped: 0,
        manaPressureRaw: 0,
        manaEfficiencyCount: 0,
        rawAvailable: true,
      }),
      row({
        manaPressureCapped: 0,
        manaPressureRaw: 0,
        manaEfficiencyCount: 0,
        rawAvailable: false,
      }),
    ];
    const s = summarize(rows);
    expect(s.perType.manaPressure.occurrenceRatePct).toBeCloseTo(33.33, 1);
    expect(s.perType.manaPressure.meanCappedPerRound).toBeCloseTo(1 / 3);
    expect(s.perType.manaPressure.meanRawPerRound).toBeCloseTo(2 / 3);
    // mana-efficiency has no raw/capped distinction — both keys read the same
    // single count (see RoundCandidateCounts.manaEfficiencyCount's own doc
    // comment).
    expect(s.perType.manaEfficiency.meanCappedPerRound).toBe(
      s.perType.manaEfficiency.meanRawPerRound,
    );
    expect(s.perType.manaEfficiency.meanCappedPerRound).toBeCloseTo(1 / 3);
    expect(s.rawAvailableRatePct).toBeCloseTo(66.67, 1);
  });

  it("Task 6: productionGated only counts ownerResolvable rows, naive perType counts all", () => {
    const rows = [
      row({
        manaPressureCapped: 1,
        manaPressureRaw: 1,
        ownerResolvable: true,
      }),
      row({
        manaPressureCapped: 1,
        manaPressureRaw: 1,
        ownerResolvable: false,
      }),
    ];
    const s = summarize(rows);
    expect(s.productionGated.roundsOwnerResolvable).toBe(1);
    expect(s.productionGated.manaPressure.occurrenceRatePct).toBe(100);
    // naive perType denominator is still all rows (2), unaffected —
    // productionGated is reported ALONGSIDE it, never replaces it.
    expect(s.perType.manaPressure.occurrenceRatePct).toBe(100);
    expect(s.roundsScanned).toBe(2);
  });
});
