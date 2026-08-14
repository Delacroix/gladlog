import {
  AtomicArenaCombat,
  CombatUnitClass,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import { extractMajorCooldowns } from "../src/utils/cooldowns";
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
