/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The backlash exemption for UA (Unstable Affliction) must be a **predicate**;
 * it must not rely on a hole in the data.
 *
 * ── 2026-08-18 (GH #23): the predicted hazard ARRIVED, on an id this file did
 * not pin. The header used to read "316099/342938/34914 have no entry in
 * spellEffectGenerated → getDispelType returns null → the check happens not to
 * fire", and warned that a DB2 refresh filling in UA's dispelType would
 * immediately produce false "you should have dispelled UA" reports. What
 * actually happened is worse than a refresh: **UA changed id**. In Midnight
 * 12.1 it is 1259790, which already carries `dispelType: "Magic"` in shipped
 * data, while 316099/342938 have no entry and appear ZERO times in a 1178-round
 * corpus (they were TWW ids — the old comment said so out loud).
 *
 * ── 2026-08-21: the dead rows 316099/342938 (→ 196363) were DELETED from
 * DISPEL_PENALTY_SPELLS / BACKLASH_CC_SPELL_IDS on the S2 corpus scan (0
 * occurrences in 10,682 matches). This file now pins only the live id
 * 1259790 → 196364; the spellEffectData mock below simulates a refresh on
 * the live id so the exemption is still proven to be a predicate.
 *
 * So the exemption silently covered nothing: 519 UA dispels in 300 matches, 0
 * annotated. The only thing still suppressing false missed-cleanse reports is
 * UA's `Low` priority — the exact gate GH #20's layer-2 work removes.
 *
 * Corpus/official evidence for the ids pinned below: 528 UA dispels → 406
 * (76.9%) put 196364 on the DISPELLER within 3s; wowhead confirms 196364 =
 * Unstable Affliction, Shadow, `Apply Aura: Silence`, 4s, matching the 12.1
 * tooltip "damage to the dispeller and silences them for 4 sec".
 *
 * This file mocks the *category* table (to lift UA above the Critical/High
 * gate, otherwise these assertions pass vacuously) and asserts that backlash
 * debuffs never enter a missed-cleanse window, and that a dispel that DOES
 * happen is annotated with the right backlash aura.
 *
 * Note for the next person: 31117 is also named "Unstable Affliction" and is
 * corpus-observed with dispelType Magic, but never once appears as an
 * enemy-applied debuff on an ally across 1178 rounds, so it is deliberately
 * NOT exempted here — adding it would be registering an id on name-similarity
 * alone. Re-check if it ever gains exposure.
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../../src/utils/dispelAnalysis";
import { makeAuraEvent, makeUnit } from "./testHelpers";

// Simulate a DB2 refresh (re)filling the UA entry (dispelType: Magic) —
// 1259790 already ships with it, the mock just makes the hazard explicit.
vi.mock("../../src/data/spellEffectData", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellEffectData")>();
  return {
    ...mod,
    spellEffectData: {
      ...mod.spellEffectData,
      "1259790": {
        spellId: "1259790",
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
      // The live 12.1 id. Without this it stays `Low` and every assertion
      // about it would pass for the wrong reason.
      "1259790": { type: "debuffs_offensive" },
    },
  };
});

const MATCH_START = 1_000_000;

function makeCombat() {
  return { startTime: MATCH_START, endTime: MATCH_START + 120_000 };
}

describe("dispelAnalysis — dispel-penalty exemption", () => {
  it("never flags a dispel-penalty debuff (UA) as a missed cleanse, even with full game data (mocked refresh)", () => {
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
        "1259790",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "1259790",
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

  it("GH #23: the LIVE 12.1 id (1259790) is exempt too — not just the dead TWW ones", () => {
    // 1259790 already has dispelType "Magic" in shipped data: the hazard is
    // real today, mock or no mock.
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
        "1259790",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "1259790",
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

  it("GH #23: a dispel that DID happen is annotated with the backlash, and names 196364", () => {
    // The other consumer of getDispelPenalty: annotating a dispel that already
    // occurred. Measured impact of this row landing: 0 → 332 annotated UA
    // dispels over 300 matches.
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    (healer as any).actionOut = [
      {
        timestamp: MATCH_START + 15_000,
        logLine: {
          event: LogEvent.SPELL_DISPEL,
          timestamp: MATCH_START + 15_000,
          parameters: [],
        },
        spellId: "527", // Purify
        spellName: "Purify",
        extraSpellId: "1259790",
        extraSpellName: "Unstable Affliction",
        srcUnitId: "h",
        destUnitId: "t",
        destUnitName: "Target",
      },
    ];

    // The silence landing on the DISPELLER is what links the annotation to a
    // concrete aura — `backlashCcSpellId` is only set when it is actually
    // observed within 100ms, so this half of the fixture is the point.
    (healer as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "196364",
        MATCH_START + 15_050,
        "e1",
        "h",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.allyCleanse).toHaveLength(1);
    expect(res.allyCleanse[0].hasDispelPenalty).toBe(true);
    expect(res.allyCleanse[0].backlashCcSpellId).toBe("196364");
  });

  it("negative control: with the OLD backlash id (196363) on the dispeller, nothing is linked", () => {
    // Proves the assertion above is really keyed on 196364 and not passing
    // because any aura would do — 196363 is the id the (deleted 2026-08-21)
    // pre-12.1 rows carried; it never occurs in the corpus.
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    (healer as any).actionOut = [
      {
        timestamp: MATCH_START + 15_000,
        logLine: {
          event: LogEvent.SPELL_DISPEL,
          timestamp: MATCH_START + 15_000,
          parameters: [],
        },
        spellId: "527",
        spellName: "Purify",
        extraSpellId: "1259790",
        extraSpellName: "Unstable Affliction",
        srcUnitId: "h",
        destUnitId: "t",
        destUnitName: "Target",
      },
    ];
    (healer as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "196363",
        MATCH_START + 15_050,
        "e1",
        "h",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.allyCleanse[0].hasDispelPenalty).toBe(true);
    expect(res.allyCleanse[0].backlashCcSpellId).toBeUndefined();
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
