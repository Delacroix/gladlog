import {
  CD_WASTE_PRESSURE_HP_PCT,
  cdWasteEvents,
} from "../src/analysis/candidateFindings";
import { lowPressureUnusedDefensiveNote } from "../src/context/matchTimelineSections";
import { matchMinHpPct } from "../src/utils/killWindowTargetSelection";
import { makeUnit } from "./ported/testHelpers";

const DP = {
  spellId: "19236",
  spellName: "Desperate Prayer",
  neverUsed: true,
  isThroughput: false,
};
const me = { id: "p1", name: "Me" };

/** Pressure gate (measured across 12 Holy Priest rounds, 2026-07-26):
 * low-pressure rounds with minHP 70-94% were all false-positived as "never
 * used all round", while rounds where the wall was genuinely needed had minHP
 * 9-52% — 60% falls inside the separating gap. */
describe("cd-waste 承压门", () => {
  it("低承压(minHP 82%)→ 不发 cd-waste:没被打就不该念经", () => {
    expect(cdWasteEvents([DP], me, 82)).toEqual([]);
  });

  it("承压(minHP 40%)→ 照发", () => {
    const out = cdWasteEvents([DP], me, 40);
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("cd-waste");
    expect(out[0].spellId).toBe("19236");
  });

  it("恰在阈值(=60%)→ 不发;略低(59.9%)→ 发", () => {
    expect(cdWasteEvents([DP], me, CD_WASTE_PRESSURE_HP_PCT)).toEqual([]);
    expect(cdWasteEvents([DP], me, 59.9).length).toBe(1);
  });

  it("承压未知(null,旧档无 advanced)→ 保守照发,行为与门前一致", () => {
    expect(cdWasteEvents([DP], me, null).length).toBe(1);
  });
});

/** Low-pressure guard note (2026-08-01): supplementary wording for the
 * [UNUSED] tag on the prompt side. It shares its predicate with the cd-waste
 * candidate gate, and at the threshold the two must be exactly
 * complementary. */
describe("lowPressureUnusedDefensiveNote", () => {
  it("低承压 + 有未用减伤墙 → 出注(含 floor 后的 minHP)", () => {
    const note = lowPressureUnusedDefensiveNote([DP], 82.7);
    expect(note).toContain("82%");
    expect(note).toContain("do NOT coach pressing defensives");
  });

  it("真承压 / 承压未知 / 无未用墙 / 只有吞吐 CD → 不出注", () => {
    expect(lowPressureUnusedDefensiveNote([DP], 40)).toBeNull();
    expect(lowPressureUnusedDefensiveNote([DP], null)).toBeNull();
    expect(lowPressureUnusedDefensiveNote([], 82)).toBeNull();
    expect(
      lowPressureUnusedDefensiveNote([{ ...DP, neverUsed: false }], 82),
    ).toBeNull();
    expect(
      lowPressureUnusedDefensiveNote([{ ...DP, isThroughput: true }], 82),
    ).toBeNull();
  });

  it("与 cd-waste 门在阈值处精确互补:同一 minHP 下恰好一边出面", () => {
    for (const minHp of [CD_WASTE_PRESSURE_HP_PCT, 59.9, 82, 40, 100]) {
      const cdWasteFires = cdWasteEvents([DP], me, minHp).length > 0;
      const noteFires = lowPressureUnusedDefensiveNote([DP], minHp) !== null;
      expect(cdWasteFires).toBe(!noteFires);
    }
  });
});

describe("matchMinHpPct", () => {
  it("取 advanced 样本逐点最低;无有效样本 → null", () => {
    const u = makeUnit("p1", {
      advancedActions: [
        {
          logLine: { timestamp: 1000 },
          advancedActorCurrentHp: 900,
          advancedActorMaxHp: 1000,
        },
        {
          logLine: { timestamp: 2000 },
          advancedActorCurrentHp: 350,
          advancedActorMaxHp: 1000,
        },
        {
          logLine: { timestamp: 3000 },
          advancedActorCurrentHp: 700,
          advancedActorMaxHp: 1000,
        },
      ] as never[],
    });
    expect(matchMinHpPct(u)).toBe(35);
    expect(matchMinHpPct(makeUnit("p2"))).toBeNull();
  });
});
