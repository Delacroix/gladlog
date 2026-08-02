/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BROKEN/BROKEN_SPELL 事件的 srcUnitId 是**打破者**不是施法者(raw 层实证,
 * 2026-08-02 破控挖掘顺带发现):按 `${spellId}:${src}` 匹配 removal 会 key
 * 失配,被打破的 CC(占硬 CC 窗口 17.5%)pending 挂到 match end → 时长虚增,
 * DR 链(lastExpiredAt)与饰品窗口跟着被污染。修法 = removal 匹配放宽为
 * 同 spellId 最早 pending;apply/refresh 才按施法者过滤。
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  LogEvent,
} from "@gladlog/parser-compat";

import { analyzeOutgoingCCChains } from "../src/utils/drAnalysis";
import { analyzePlayerCCAndTrinket } from "../src/utils/ccTrinketAnalysis";
import { makeUnit } from "./ported/testHelpers";

const MATCH_START = 1_000_000;
const S = (sec: number) => MATCH_START + sec * 1000;
/** endTime 远大于打破时刻:虚增会一眼看出。 */
const COMBAT = {
  startTime: MATCH_START,
  endTime: MATCH_START + 300_000,
  startInfo: { zoneId: "0" },
} as any;

const POLY = "118";

function aura(
  event: LogEvent,
  spellId: string,
  timestamp: number,
  srcUnitId: string,
  srcUnitName: string,
): any {
  const parameters: (string | number)[] = [];
  if (event === LogEvent.SPELL_AURA_BROKEN_SPELL) {
    parameters[11] = "589";
    parameters[12] = "Shadow Word: Pain";
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

describe("BROKEN removal 配对(打破者≠施法者)", () => {
  it("analyzeOutgoingCCChains:被友方 DoT 打破的出手 CC 时长=实际 2s,不虚增到 match end", () => {
    const e1 = makeUnit("e1", {
      spec: CombatUnitSpec.Mage_Frost,
      reaction: CombatUnitReaction.Hostile,
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "h1", "OurMage"),
        // 打破者是 d1(友方 DoT),src ≠ 施法者 h1
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, POLY, S(12), "d1", "OurPriest"),
      ],
    });
    (e1 as any).type = CombatUnitType.Player;
    const chains = analyzeOutgoingCCChains(
      [makeUnit("h1"), makeUnit("d1")] as any,
      [e1] as any,
      COMBAT,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0].applications).toHaveLength(1);
    expect(chains[0].applications[0].durationSeconds).toBeCloseTo(2);
  });

  it("analyzePlayerCCAndTrinket:被敌方 DoT 打破的身上 CC 时长=实际 2s,不虚增", () => {
    const player = makeUnit("t1", {
      spec: CombatUnitSpec.Warrior_Arms,
      auraEvents: [
        aura(LogEvent.SPELL_AURA_APPLIED, POLY, S(10), "e1", "EnemyMage"),
        // 打破者是 e2(敌方 DoT),src ≠ 施法者 e1
        aura(LogEvent.SPELL_AURA_BROKEN_SPELL, POLY, S(12), "e2", "EnemyLock"),
      ],
    });
    const summary = analyzePlayerCCAndTrinket(
      player as any,
      [makeUnit("e1"), makeUnit("e2")] as any,
      COMBAT,
    );
    expect(summary.ccInstances).toHaveLength(1);
    expect(summary.ccInstances[0].durationSeconds).toBeCloseTo(2);
  });
});
