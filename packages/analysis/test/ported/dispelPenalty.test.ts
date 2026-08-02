/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The backlash exemption for UA (Unstable Affliction) must be a **predicate**;
 * it must not rely on a hole in the data.
 *
 * Today: 316099/342938/34914 have no entry in spellEffectGenerated →
 * getDispelType returns null → the missed-cleanse check happens not to fire.
 * The moment a DB2 refresh fills in UA's dispelType: "Magic", false
 * "you should have dispelled UA" reports appear immediately — dispelling UA
 * silences and damages the dispeller, so not dispelling is not a mistake.
 *
 * This file mocks the world "after the data is filled in" and asserts that
 * backlash debuffs still never enter a missed-cleanse window.
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../../src/utils/dispelAnalysis";
import { makeAuraEvent, makeUnit } from "./testHelpers";

// Simulate a DB2 refresh filling in the UA entry (dispelType: Magic)
vi.mock("../../src/data/spellEffectData", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellEffectData")>();
  return {
    ...mod,
    spellEffectData: {
      ...mod.spellEffectData,
      "316099": {
        spellId: "316099",
        name: "Unstable Affliction",
        dispelType: "Magic",
      },
    },
  };
});

// Simulate UA entering the category table (debuffs_offensive → High priority,
// enough to reach the missed-cleanse check)
vi.mock("../../src/data/spellCategories", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellCategories")>();
  return {
    ...mod,
    SPELL_CATEGORIES: {
      ...mod.SPELL_CATEGORIES,
      "316099": { type: "debuffs_offensive" },
    },
  };
});

const MATCH_START = 1_000_000;

function makeCombat() {
  return { startTime: MATCH_START, endTime: MATCH_START + 120_000 };
}

describe("dispelAnalysis — dispel-penalty exemption", () => {
  it("never flags a dispel-penalty debuff (UA) as a missed cleanse, even with full game data", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    // UA sits on the target for 10s, expires undispelled — correct play, not a miss
    (target as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "316099",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "316099",
        MATCH_START + 20_000,
        "e1",
        "t",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.missedCleanseWindows).toHaveLength(0);
  });

  it("control: a non-penalty Magic debuff under the same mocks still produces a missed cleanse window", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    (target as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "118",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "118",
        MATCH_START + 20_000,
        "e1",
        "t",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.missedCleanseWindows).toHaveLength(1);
  });
});
