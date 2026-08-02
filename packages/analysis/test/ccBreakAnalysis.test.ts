/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 打破控制统计(2026-08-02 用户需求)。判定 = 日志 ground truth
 * SPELL_AURA_BROKEN_SPELL(src=打破者、params[11..12]=打破技能)。
 * 语料基线:6.14 次/combat、四象限资敌 48.2%/敌方自误 46.6%。
 */
import { CombatUnitSpec, LogEvent } from "@gladlog/parser-compat";

import {
  analyzeCcBreaks,
  CC_BREAK_REPORT_MIN_REMAINING_S,
} from "../src/utils/ccBreakAnalysis";
import { makeUnit } from "./ported/testHelpers";

const MATCH_START = 1_000_000;
const S = (sec: number) => MATCH_START + sec * 1000;
const COMBAT = { startTime: MATCH_START, endTime: MATCH_START + 120_000 };

/** Polymorph:cc 类,表满时长 8s。 */
const POLY = "118";
/** Frost Nova:roots 类。 */
const NOVA = "122";

function aura(
  event: LogEvent,
  spellId: string,
  timestamp: number,
  srcUnitId: string,
  srcUnitName: string,
  extra: { breakSpellId?: string; breakSpellName?: string } = {},
): any {
  const parameters: (string | number)[] = [];
  if (event === LogEvent.SPELL_AURA_BROKEN_SPELL) {
    parameters[11] = extra.breakSpellId ?? "";
    parameters[12] = extra.breakSpellName ?? "";
  } else {
    parameters[11] = "DEBUFF";
  }
  return {
    logLine: { event, timestamp, parameters },
    timestamp,
    spellId,
    spellName: spellId,
    srcUnitId,
    srcUnitName,
    destUnitId: "holder",
    destUnitName: "Holder",
    effectiveAmount: 0,
  };
}

describe("analyzeCcBreaks — ground truth 打破事件", () => {
  it("资敌象限:己方 DoT 打破己方给敌人上的变形;剩余=表时长-已持续;归因到打破者与技能", () => {
    // 敌方 e1 被我方 h1 变形(S10),1.5s 后被我方 d1 的暗言术:痛打破
    const e1 = makeUnit("e1", {
      spec: CombatUnitSpec.Mage_Frost,
      reaction: 1 as any,
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "h1", "OurMage"),
        aura(
          LogEvent.SPELL_AURA_BROKEN_SPELL,
          POLY,
          S(11.5),
          "d1",
          "OurPriest",
          {
            breakSpellId: "589",
            breakSpellName: "Shadow Word: Pain",
          },
        ),
      ],
    });
    const h1 = makeUnit("h1", { spec: CombatUnitSpec.Mage_Frost });
    const d1 = makeUnit("d1", { spec: CombatUnitSpec.Priest_Shadow });
    const stats = analyzeCcBreaks([h1, d1], [e1], COMBAT);

    expect(stats.events).toHaveLength(1);
    const ev = stats.events[0];
    expect(ev.atSeconds).toBeCloseTo(11.5);
    expect(ev.holderName).toBe("e1");
    expect(ev.holderIsFriendly).toBe(false);
    expect(ev.breakerName).toBe("OurPriest");
    expect(ev.breakerIsFriendly).toBe(true);
    expect(ev.breakSpellId).toBe("589");
    expect(ev.heldSeconds).toBeCloseTo(1.5);
    // Polymorph 表满时长 8s,DR 全新鲜 → 剩余 6.5s
    expect(ev.remainingSeconds).toBeCloseTo(6.5);
    expect(stats.friendlySquander).toHaveLength(1);
    expect(stats.enemySquander).toHaveLength(0);
  });

  it("敌方自误象限:敌方 DoT 打破敌方给我方队友上的控(正面信号)", () => {
    const t1 = makeUnit("t1", {
      spec: CombatUnitSpec.Warrior_Arms,
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(20), "e1", "EnemyMage"),
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, POLY, S(21), "e2", "EnemyLock", {
          breakSpellId: "980",
          breakSpellName: "Agony",
        }),
      ],
    });
    const stats = analyzeCcBreaks(
      [t1],
      [makeUnit("e1"), makeUnit("e2")],
      COMBAT,
    );
    expect(stats.enemySquander).toHaveLength(1);
    expect(stats.friendlySquander).toHaveLength(0);
    expect(stats.enemySquander[0].holderIsFriendly).toBe(true);
    expect(stats.enemySquander[0].breakerIsFriendly).toBe(false);
  });

  it("DR 折半:同类第二次控被打破,剩余按半时长算", () => {
    // e1 先吃满一个 poly(S2→S8 自然消退),S12 再吃 poly(半时长 4s),
    // S13 被打破 → 剩余 = 4 - 1 = 3
    const e1 = makeUnit("e1", {
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(2), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_REMOVED, POLY, S(8), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(12), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, POLY, S(13), "d1", "OurPriest", {
          breakSpellId: "589",
          breakSpellName: "Shadow Word: Pain",
        }),
      ],
    });
    const stats = analyzeCcBreaks(
      [makeUnit("h1"), makeUnit("d1")],
      [e1],
      COMBAT,
    );
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0].remainingSeconds).toBeCloseTo(3);
  });

  it("剩余 < 阈值的资敌打破不进可教清单(尾巴上的打破无关紧要)", () => {
    // 8s poly 已持续 7s 才被打破 → 剩余 1s < 2s
    const e1 = makeUnit("e1", {
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, POLY, S(17), "d1", "OurPriest", {
          breakSpellId: "589",
          breakSpellName: "Shadow Word: Pain",
        }),
      ],
    });
    const stats = analyzeCcBreaks(
      [makeUnit("h1"), makeUnit("d1")],
      [e1],
      COMBAT,
    );
    expect(CC_BREAK_REPORT_MIN_REMAINING_S).toBe(2);
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0].remainingSeconds).toBeCloseTo(1);
    expect(stats.friendlySquander).toHaveLength(0); // 事件在,榜单不收
  });

  it("root 打破单列计数,不混进硬 CC 事件", () => {
    const e1 = makeUnit("e1", {
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, NOVA, S(30), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, NOVA, S(31), "d1", "OurPriest", {
          breakSpellId: "589",
          breakSpellName: "Shadow Word: Pain",
        }),
      ],
    });
    const stats = analyzeCcBreaks(
      [makeUnit("h1"), makeUnit("d1")],
      [e1],
      COMBAT,
    );
    expect(stats.events).toHaveLength(0);
    expect(stats.rootBreakCount).toBe(1);
  });

  it("宠物打破归主(B45 同款):阵营按宠物所属侧,展示名=主人(宠物)", () => {
    const e1 = makeUnit("e1", {
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "h1", "OurMage"),
        aura(
          LogEvent.SPELL_AURA_BROKEN_SPELL,
          POLY,
          S(11),
          "pet1",
          "Felhound",
          {
            breakSpellId: "603",
            breakSpellName: "Doom",
          },
        ),
      ],
    });
    const lock = makeUnit("lock1", { name: "OurLock" });
    const pet = makeUnit("pet1", { name: "Felhound", ownerId: "lock1" });
    const stats = analyzeCcBreaks(
      [makeUnit("h1"), lock],
      [e1],
      COMBAT,
      [pet],
      [],
    );
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0].breakerIsFriendly).toBe(true);
    expect(stats.events[0].breakerName).toBe("OurLock(宠物)");
    expect(stats.friendlySquander).toHaveLength(1);
  });

  it("自然消退(REMOVED)不算打破;纯近战 BROKEN 记为 Melee", () => {
    const e1 = makeUnit("e1", {
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_REMOVED, POLY, S(18), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(40), "h1", "OurMage"),
        aura(LogEvent.SPELL_AURA_BROKEN, POLY, S(41), "d1", "OurWarrior"),
      ],
    });
    const stats = analyzeCcBreaks(
      [makeUnit("h1"), makeUnit("d1")],
      [e1],
      COMBAT,
    );
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0].atSeconds).toBeCloseTo(41);
    expect(stats.events[0].breakSpellName).toBe("Melee");
  });
});
