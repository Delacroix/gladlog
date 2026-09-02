/**
 * ccFullDurationForCaster — talent-conditional CC duration (GH #44 tail,
 * 2026-09-02). The ccLifetimeScan FLAG on Intimidating Shout (7 s peak vs
 * DB2 6 s) resolved to Resonant Voice 1243660: DB2 aura 108 +20 % on the
 * Warrior shout mask, and 79 % of casters whose shout lived ~7 s held the
 * talent vs 0 % of those at ~6 s. The wrapper lengthens the base ONLY when
 * `talentOwnershipOf` answers "yes" — "unknown" (no talent data) stays at the
 * base, because a longer-CC claim must rest on evidence the player has it.
 */
import { CombatUnitSpec } from "@gladlog/parser-compat";

import { CC_DURATION_TALENT_MODIFIERS } from "../src/data/spellEffectData";
import { ccFullDurationForCaster } from "../src/utils/ccDuration";
import { talentOwnershipOf } from "../src/utils/talentOwnership";
import { makeUnit } from "./ported/testHelpers";

const INTIMIDATING_SHOUT = "5246";
const RESONANT_VOICE = "1243660";
// Warrior class-tree node 108685 / entry 134225 (talentIdMap.json, all three specs)
const RESONANT_VOICE_TALENT = { id1: 108685, id2: 134225, count: 1 };

describe("ccFullDurationForCaster — 天赋条件时长", () => {
  it("登记表:威吓怒吼 ← Resonant Voice +20%", () => {
    expect(CC_DURATION_TALENT_MODIFIERS[INTIMIDATING_SHOUT]).toEqual([
      expect.objectContaining({ talentSpellId: RESONANT_VOICE, pct: 20 }),
    ]);
  });

  it("持有 Resonant Voice 的战士:6s × 1.2 = 7.2s", () => {
    const warrior = makeUnit("w1", {
      spec: CombatUnitSpec.Warrior_Arms,
      info: { talents: [RESONANT_VOICE_TALENT], pvpTalents: [] },
    });
    // sanity: the ownership predicate itself reads the real talent tree
    expect(talentOwnershipOf(warrior, RESONANT_VOICE)).toBe("yes");
    expect(ccFullDurationForCaster(INTIMIDATING_SHOUT, warrior)).toBeCloseTo(
      7.2,
    );
  });

  it("无天赋数据(unknown)或无施法者 → 保持官方 6s;不相关技能不受影响", () => {
    const unknown = makeUnit("w2", { spec: CombatUnitSpec.Warrior_Arms });
    expect(talentOwnershipOf(unknown, RESONANT_VOICE)).toBe("unknown");
    expect(ccFullDurationForCaster(INTIMIDATING_SHOUT, unknown)).toBe(6);
    expect(ccFullDurationForCaster(INTIMIDATING_SHOUT, undefined)).toBe(6);
    const talented = makeUnit("w3", {
      spec: CombatUnitSpec.Warrior_Arms,
      info: { talents: [RESONANT_VOICE_TALENT], pvpTalents: [] },
    });
    expect(ccFullDurationForCaster("118", talented)).toBe(6); // Polymorph: no modifier
  });
});
