/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";

import { LogEvent } from "@gladlog/parser-compat";

import { extractKillAttempts } from "../src/utils/killAttempts";

/**
 * 钉的是四条会静默出错的边界,不是 happy path:
 *  1. DR 链分组:间隔恰在重置窗内/外的两个晕,归并与拆分要与 getDRLevel 的
 *     链走法一致(共享 drResetMsAt —— 12.1 后 20s)。
 *  2. 伤害地板:控住了但没打(< KW_BURST_MIN_DAMAGE=30k)不算尝试。
 *  3. 击杀记账:死亡落在 span+KILL_CREDIT_SLACK_S(5s)内才算转化。
 *  4. 归因优先级:徽章 > 免疫 > 减伤 > 外置 > 被奶,全 false 时落 pressure。
 */

// 12.1 之后的时代(PATCH_121_GOLIVE 之后)→ DR 重置窗 20s
const MATCH_START = Date.UTC(2026, 7, 15);
const ms = (s: number): number => MATCH_START + s * 1000;

function unit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id,
    name: id,
    type: 1, // CombatUnitType.Player —— analyzeOutgoingCCChains 的目标过滤要求
    spec: "265", // Affliction Warlock(具体值不重要,specToString 能吃)
    reaction: 2,
    info: {},
    spellCastEvents: [],
    auraEvents: [],
    damageOut: [],
    damageIn: [],
    healIn: [],
    deathRecords: [],
    advancedActions: [],
    ...over,
  };
}

/** 敌方 e1 身上被 f1 晕住的光环事件对(analyzeOutgoingCCChains 的输入形状)。 */
function stunAuras(
  targetId: string,
  spellId: string,
  fromS: number,
  durS: number,
): any[] {
  return [
    {
      spellId,
      spellName: `Stun${spellId}`,
      srcUnitId: "f1",
      srcUnitName: "f1",
      destUnitId: targetId,
      destUnitName: targetId,
      timestamp: ms(fromS),
      logLine: {
        event: LogEvent.SPELL_AURA_APPLIED,
        timestamp: ms(fromS),
        parameters: [],
      },
      auraType: "DEBUFF",
    },
    {
      spellId,
      spellName: `Stun${spellId}`,
      srcUnitId: "f1",
      srcUnitName: "f1",
      destUnitId: targetId,
      destUnitName: targetId,
      timestamp: ms(fromS + durS),
      logLine: {
        event: LogEvent.SPELL_AURA_REMOVED,
        timestamp: ms(fromS + durS),
        parameters: [],
      },
      auraType: "DEBUFF",
    },
  ];
}

function dmg(
  srcNotUsed: string,
  destId: string,
  atS: number,
  amount: number,
): any {
  return {
    destUnitId: destId,
    effectiveAmount: amount,
    logLine: {
      event: LogEvent.SPELL_DAMAGE,
      timestamp: ms(atS),
      parameters: [],
    },
  };
}

// Kidney Shot 408 是 DR 表里的 Stun 类
const KIDNEY = "408";

function makeCombat(f1: any, e1: any, extraEnemies: any[] = []): any {
  return {
    startTime: MATCH_START,
    endTime: MATCH_START + 300_000,
    units: {
      f1,
      e1,
      ...Object.fromEntries(extraEnemies.map((e) => [e.id, e])),
    },
  };
}

describe("extractKillAttempts", () => {
  it("同一 DR 链的两个晕并成一次尝试;超出重置窗(20s)的拆成两次", () => {
    const e1 = unit("e1", {
      auraEvents: [
        ...stunAuras("e1", KIDNEY, 10, 5), // 10–15s
        ...stunAuras("e1", KIDNEY, 20, 3), // 间隔 5s < 20s → 同链
        ...stunAuras("e1", KIDNEY, 60, 5), // 距上一段结束 37s > 20s → 新链
      ],
    });
    const f1 = unit("f1", {
      reaction: 1,
      damageOut: [dmg("f1", "e1", 12, 40_000), dmg("f1", "e1", 62, 40_000)],
    });
    const attempts = extractKillAttempts([f1], [e1], makeCombat(f1, e1));
    expect(attempts).toHaveLength(2);
    expect(attempts[0].stuns).toHaveLength(2);
    expect(attempts[0].fromSeconds).toBe(10);
    expect(attempts[0].toSeconds).toBe(23);
    expect(attempts[1].stuns).toHaveLength(1);
  });

  it("伤害地板:控住了但团队伤害 < 30k → 不算尝试(那是 peel/铺垫)", () => {
    const e1 = unit("e1", { auraEvents: stunAuras("e1", KIDNEY, 10, 5) });
    const f1 = unit("f1", {
      reaction: 1,
      damageOut: [dmg("f1", "e1", 12, 10_000)],
    });
    expect(extractKillAttempts([f1], [e1], makeCombat(f1, e1))).toHaveLength(0);
  });

  it("击杀记账用 KILL_CREDIT_SLACK_S:span 结束后 5s 内死算转化,之后不算", () => {
    const mk = (deathAtS: number) => {
      const e1 = unit("e1", {
        auraEvents: stunAuras("e1", KIDNEY, 10, 5),
        deathRecords: [{ timestamp: ms(deathAtS) }],
      });
      const f1 = unit("f1", {
        reaction: 1,
        damageOut: [dmg("f1", "e1", 12, 50_000)],
      });
      return extractKillAttempts([f1], [e1], makeCombat(f1, e1))[0];
    };
    expect(mk(19).killed).toBe(true); // 15 + 5 = 20 边界内
    expect(mk(26).killed).toBe(false); // 边界外 → 有归因
    expect(mk(26).attribution?.primary).toBe("pressure");
  });

  it("teamOnTargetPct 按全队、含 slack 窗口:打了 e1 60k / e2 40k → 60%", () => {
    const e1 = unit("e1", { auraEvents: stunAuras("e1", KIDNEY, 10, 5) });
    const e2 = unit("e2");
    const f1 = unit("f1", {
      reaction: 1,
      damageOut: [dmg("f1", "e1", 12, 60_000), dmg("f1", "e2", 13, 40_000)],
    });
    const a = extractKillAttempts([f1], [e1, e2], makeCombat(f1, e1, [e2]))[0];
    expect(a.teamOnTargetPct).toBe(60);
  });

  it("归因优先级:span 内交徽章 → trinketed 压过其余全部", () => {
    const e1 = unit("e1", {
      auraEvents: stunAuras("e1", KIDNEY, 10, 5),
      spellCastEvents: [
        {
          spellId: "336126",
          logLine: {
            event: LogEvent.SPELL_CAST_SUCCESS,
            timestamp: ms(12),
            parameters: [],
          },
        },
      ],
      healIn: [
        {
          effectiveAmount: 999_999,
          logLine: {
            event: LogEvent.SPELL_HEAL,
            timestamp: ms(13),
            parameters: [],
          },
        },
      ],
    });
    const f1 = unit("f1", {
      reaction: 1,
      damageOut: [dmg("f1", "e1", 12, 50_000)],
    });
    const a = extractKillAttempts([f1], [e1], makeCombat(f1, e1))[0];
    expect(a.killed).toBe(false);
    expect(a.attribution?.trinketed).toBe(true);
    expect(a.attribution?.outhealed).toBe(true);
    expect(a.attribution?.primary).toBe("trinketed");
  });

  it("被奶回来:span 内治疗 > 伤害且无其他救场 → outhealed", () => {
    const e1 = unit("e1", {
      auraEvents: stunAuras("e1", KIDNEY, 10, 5),
      damageIn: [
        {
          effectiveAmount: 50_000,
          logLine: {
            event: LogEvent.SPELL_DAMAGE,
            timestamp: ms(12),
            parameters: [],
          },
        },
      ],
      healIn: [
        {
          effectiveAmount: 80_000,
          logLine: {
            event: LogEvent.SPELL_HEAL,
            timestamp: ms(13),
            parameters: [],
          },
        },
      ],
    });
    const f1 = unit("f1", {
      reaction: 1,
      damageOut: [dmg("f1", "e1", 12, 50_000)],
    });
    const a = extractKillAttempts([f1], [e1], makeCombat(f1, e1))[0];
    expect(a.attribution?.primary).toBe("outhealed");
  });
});
