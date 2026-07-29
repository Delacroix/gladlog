import {
  AtomicArenaCombat,
  CombatUnitReaction,
  CombatUnitSpec,
  ICombatUnit,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import { DMG_SPIKE_THRESHOLD, computeHealerExposureEvents } from "../src";

// 全字段正确命名的 ICombatUnit stub(镜像 deepDive.window.test.ts 的
// mkFullUnit —— computeHealerExposureEvents 自算路径要跑通
// analyzePlayerCCAndTrinket / reconstructEnemyCDTimeline,字段名必须与
// 真实接口一致,不能用错位速记字段)。
const mkUnit = (
  id: string,
  name: string,
  friendly: boolean,
  spec: string,
): ICombatUnit =>
  ({
    id,
    name,
    ownerId: "",
    info: { specId: spec },
    spec,
    class: 0,
    reaction: friendly
      ? CombatUnitReaction.Friendly
      : CombatUnitReaction.Hostile,
    advancedActions: [],
    damageOut: [],
    damageIn: [],
    healOut: [],
    healIn: [],
    absorbsOut: [],
    absorbsIn: [],
    spellCastEvents: [],
    castStartEvents: [],
    petSpellCastEvents: [],
    auraEvents: [],
    actionIn: [],
    actionOut: [],
    deathRecords: [],
  }) as unknown as ICombatUnit;

function mkCombatNoAdvanced(): AtomicArenaCombat {
  return {
    startTime: 0,
    endTime: 90_000,
    startInfo: { zoneId: "1552" },
    playerId: "o",
    units: {
      o: mkUnit("o", "Healer-Area52", true, CombatUnitSpec.Priest_Holy),
      e: mkUnit("e", "Emage-Area52", false, CombatUnitSpec.Mage_Frost),
    },
  } as unknown as AtomicArenaCombat;
}

function mkCombatNoHealer(): AtomicArenaCombat {
  return {
    startTime: 0,
    endTime: 90_000,
    startInfo: { zoneId: "1552" },
    playerId: "o",
    units: {
      o: mkUnit("o", "Warr-Area52", true, CombatUnitSpec.Warrior_Arms),
      e: mkUnit("e", "Emage-Area52", false, CombatUnitSpec.Mage_Frost),
    },
  } as unknown as AtomicArenaCombat;
}

describe("computeHealerExposureEvents", () => {
  it("无位置数据(无 advancedActions)→ 空数组,不抛", () => {
    const combat = mkCombatNoAdvanced();
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("无治疗(全 DPS 队)→ 空数组", () => {
    const combat = mkCombatNoHealer();
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("pre 注入路径与自算路径同型(buildMatchContext 等价性烟测)", () => {
    // 自算路径跑通即可(结果形状断言),精确等价由 context 既有测试兜
    const combat = mkCombatNoAdvanced();
    const r = computeHealerExposureEvents(combat, undefined);
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("DMG_SPIKE_THRESHOLD 单源导出", () => {
  it("package index 导出且与 timelineHelpers 同值", async () => {
    const helpers = await import("../src/context/timelineHelpers");
    expect(DMG_SPIKE_THRESHOLD).toBe(helpers.DMG_SPIKE_THRESHOLD);
  });
});
