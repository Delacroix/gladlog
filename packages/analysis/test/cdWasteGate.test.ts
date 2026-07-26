import {
  CD_WASTE_PRESSURE_HP_PCT,
  cdWasteEvents,
} from "../src/analysis/candidateFindings";
import { matchMinHpPct } from "../src/utils/killWindowTargetSelection";
import { makeUnit } from "./ported/testHelpers";

const DP = {
  spellId: "19236",
  spellName: "Desperate Prayer",
  neverUsed: true,
  isThroughput: false,
};
const me = { id: "p1", name: "Me" };

/** 承压门(2026-07-26 神牧 12 轮实证):低承压轮 minHP 70–94% 全被误报
 * 「整场未用」,真按保命的轮 minHP 9–52%——60% 落在分离间隙内。 */
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
