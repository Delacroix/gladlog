import {
  AtomicArenaCombat,
  CombatUnitClass,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  auraOnlyActivationSeconds,
  extractMajorCooldowns,
} from "../src/utils/cooldowns";
import { makeAuraEvent, makeUnit } from "./ported/testHelpers";

/**
 * Task 7 (cd-ledger-rot): Renewing Blaze (Evoker, spellId 374348) never emits
 * a SPELL_CAST_SUCCESS log line — it's a reactive defensive proc, not a
 * button press — so its only on-log evidence is the self-applied buff aura
 * under a DIFFERENT id (374349). Before the fix, extractMajorCooldowns' cast
 * scan only reads spellCastEvents, so `casts` stayed permanently empty and
 * `neverUsed` stayed permanently true even when the aura clearly fired —
 * reproduced on real data in match 76ea5f90 (Girlbye-Tichondrius-US,
 * 03:08:19.314). This fixture reconstructs the same shape synthetically.
 */
describe("extractMajorCooldowns: aura-only activation (Renewing Blaze 374348/374349)", () => {
  it("counts a self-applied 374349 aura as a Renewing Blaze cast even with zero spellCastEvents", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Evoker,
      spec: CombatUnitSpec.Evoker_Devastation,
      spellCastEvents: [], // never logged as a cast — proc-only ability
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "374349", // Renewing Blaze's aura id — NOT 374348
          19_314, // mirrors the real match's 03:08:19.314 offset
          "player-1",
          "player-1",
          "BUFF",
        ),
      ],
    });

    const combat = {
      startTime: 0,
      endTime: 300_000,
      units: { "player-1": owner },
    } as unknown as AtomicArenaCombat;

    const cds = extractMajorCooldowns(owner, combat);
    const renewingBlaze = cds.find((cd) => cd.spellId === "374348");

    expect(renewingBlaze).toBeDefined();
    expect(renewingBlaze!.neverUsed).toBe(false);
    expect(renewingBlaze!.casts).toHaveLength(1);
    expect(renewingBlaze!.casts[0].timeSeconds).toBeCloseTo(19.314, 3);
  });

  it("still reports neverUsed when there is no cast AND no matching aura", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Evoker,
      spec: CombatUnitSpec.Evoker_Devastation,
      spellCastEvents: [],
      auraEvents: [],
    });

    const combat = {
      startTime: 0,
      endTime: 300_000,
      units: { "player-1": owner },
    } as unknown as AtomicArenaCombat;

    const cds = extractMajorCooldowns(owner, combat);
    const renewingBlaze = cds.find((cd) => cd.spellId === "374348");

    expect(renewingBlaze).toBeDefined();
    expect(renewingBlaze!.neverUsed).toBe(true);
    expect(renewingBlaze!.casts).toHaveLength(0);
  });
});

/**
 * Task A (cd-ledger-rot batch2, 2026-08-14): Avenging Wrath (Paladin,
 * spellId 31884) is normally a button press (handled by the ordinary
 * castRawCasts path), but the Herald of the Sun hero-talent build can also
 * proc-grant it off a Judgment cast — that proc-grant path applies the buff
 * aura (under either the base id 31884 or the alt id 454351) with ZERO
 * SPELL_CAST_SUCCESS for Avenging Wrath. Reproduced from the corpus:
 * match 8e45b000 (Fantasyext-Illidan-US) shows this shape twice in one
 * round, aura bursts @11.0s and @20.5s each ~3-16s after a Judgment cast,
 * neither burst paired with any Avenging Wrath cast anywhere in the round.
 */
describe("extractMajorCooldowns: aura-only activation (Avenging Wrath 31884/454351)", () => {
  it("counts a self-applied 31884 aura as an Avenging Wrath cast even with zero spellCastEvents for it", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: [],
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "31884",
          11_000,
          "player-1",
          "player-1",
          "BUFF",
        ),
      ],
    });

    const combat = {
      startTime: 0,
      endTime: 300_000,
      units: { "player-1": owner },
    } as unknown as AtomicArenaCombat;

    const cds = extractMajorCooldowns(owner, combat);
    const avengingWrath = cds.find((cd) => cd.spellId === "31884");

    expect(avengingWrath).toBeDefined();
    expect(avengingWrath!.neverUsed).toBe(false);
    expect(avengingWrath!.casts).toHaveLength(1);
    expect(avengingWrath!.casts[0].timeSeconds).toBeCloseTo(11, 3);
  });

  it("counts a self-applied 454351 (alt proc id) aura as an Avenging Wrath cast", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Paladin,
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: [],
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "454351",
          20_500,
          "player-1",
          "player-1",
          "BUFF",
        ),
      ],
    });

    const combat = {
      startTime: 0,
      endTime: 300_000,
      units: { "player-1": owner },
    } as unknown as AtomicArenaCombat;

    const cds = extractMajorCooldowns(owner, combat);
    const avengingWrath = cds.find((cd) => cd.spellId === "31884");

    expect(avengingWrath).toBeDefined();
    expect(avengingWrath!.neverUsed).toBe(false);
    expect(avengingWrath!.casts).toHaveLength(1);
    expect(avengingWrath!.casts[0].timeSeconds).toBeCloseTo(20.5, 3);
  });
});

/**
 * Task A (cd-ledger-rot batch2, 2026-08-14): Ascendance (Shaman, spellId
 * 114052, shared across all 3 specs' talent trees) is normally a button
 * press, but a Restoration-tree talent (Deeply Rooted Elements-style) can
 * also proc-grant a brief Ascendance off a Riptide cast — zero
 * SPELL_CAST_SUCCESS for Ascendance. Reproduced from the corpus: match
 * 4159c044#4 (Worstrshamn-Stormrage-US) shows this recurring 5 times in one
 * round, each aura landing on the exact same tick as a Riptide cast, none
 * paired with an Ascendance cast anywhere in the round.
 */
describe("auraOnlyActivationSeconds: aura-only activation (Ascendance 114052)", () => {
  // Ascendance only ever reaches extractMajorCooldowns' ledger via the
  // "Dynamic Discovery" talent-tree path (it has no static classSpells.ts
  // entry — the id is shared across all 3 Shaman specs' talent trees), which
  // requires real downloaded talent-tree node data (ensureAnalysisData) that
  // isn't available to a synthetic unit fixture. So this pins the shared
  // predicate itself (auraOnlyActivationSeconds — the same function
  // extractMajorCooldowns' rawCasts and deathOutcomeAnalysis's
  // isAvailableAt both consume) directly, same rationale as
  // findSelfAuraEvidence's own test-only export in cdLedgerRot.ts.
  it("returns the self-applied 114052 aura's time even with zero spellCastEvents for it", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Shaman,
      spec: CombatUnitSpec.Shaman_Restoration,
      spellCastEvents: [],
      auraEvents: [
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "114052",
          52_800,
          "player-1",
          "player-1",
          "BUFF",
        ),
      ],
    });

    const seconds = auraOnlyActivationSeconds(owner, "114052", 0);

    expect(seconds).toHaveLength(1);
    expect(seconds[0]).toBeCloseTo(52.8, 3);
  });

  it("returns nothing for a spellId with no AURA_ONLY_ACTIVATION_IDS entry", () => {
    const owner = makeUnit("player-1", {
      class: CombatUnitClass.Shaman,
      spec: CombatUnitSpec.Shaman_Restoration,
      spellCastEvents: [],
      auraEvents: [],
    });

    expect(auraOnlyActivationSeconds(owner, "12345", 0)).toEqual([]);
  });
});
