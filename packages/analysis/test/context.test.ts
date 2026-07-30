import {
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { buildMatchContext } from "../src/context/buildMatchContext";
import { loadLegacyMatchFixture } from "./helpers/legacyFixture";
import {
  makeAdvancedAction,
  makeAuraEvent,
  makeUnit,
} from "./ported/testHelpers";

describe("buildMatchContext on real fixture", () => {
  const match = loadLegacyMatchFixture();
  const units = Object.values(match.units).filter((u) => u.info);
  const friends = units.filter((u) => u.reaction === 1); // Friendly
  const enemies = units.filter((u) => u.reaction === 2); // Hostile
  it("产出完整 prompt 上下文:非空、含玩家名与关键段落", () => {
    const ctx = buildMatchContext(match, friends, enemies, {});
    expect(ctx.length).toBeGreaterThan(2000);
    const owner = Object.values(match.units).find(
      (u) => u.id === match.playerId,
    );
    expect(ctx).toContain(owner!.name);
    expect(/dampening/i.test(ctx)).toBe(true);
  });
  it("timeline 模式同样可产出", () => {
    const ctx = buildMatchContext(match, friends, enemies, {
      useTimelinePrompt: true,
    });
    expect(ctx.length).toBeGreaterThan(1000);
  });

  it("healer owner:timeline 上下文不含 <burst_ledger>(治疗 prompt 不变,D2)", () => {
    const ctx = buildMatchContext(match, friends, enemies, {
      useTimelinePrompt: true,
    });
    expect(ctx).not.toContain("<burst_ledger>");
  });

  it("DPS owner:timeline 上下文以 DPS 为视角(无 healer_offense;有账本时出 <burst_ledger>)", () => {
    const dps = friends.find((u) => u.id !== match.playerId)!;
    const ctx = buildMatchContext(match, friends, enemies, {
      useTimelinePrompt: true,
      owner: dps,
    });
    expect(ctx).toContain(`(You are the`);
    expect(ctx).not.toContain("<healer_offense>");
    expect(ctx).toContain("<burst_ledger>");
    expect(ctx).toContain("## BURST LEDGER");
  });
});

describe("counterfactualOf 按 (name, atSeconds) 精确匹配(#17b Task4 复核 critical 回归)", () => {
  // 2026-07-30 复核发现:此前 buildMatchContext 的 counterfactualOf 闭包
  // 只按 victimName 去 friendlyDeaths.find() —— 同一玩家在同一场 combat
  // 内死两次时,第二次死亡的 [DEATH] 块会被渲染成第一次死亡的挡伤/反事实
  // 数字(不是"缺数据",是"数字错了")。语料实测(795 场/2531 个 combat——
  // 每场 match + 每个 shuffle round 各算一个 combat)里 0 个 combat 出现过
  // 同一单位死两次(见 task-4-report.md 附录),但代码本身不该依赖这个巧
  // 合,构造合成场景直接验证修复。
  it("同一玩家在同一场 combat 内死两次:第二条 [DEATH] 不得沿用第一条的减伤核算行", () => {
    const matchStartMs = 0;
    const death1Ms = 20_000;
    const death2Ms = 40_000;

    const victim = makeUnit("victim-1", {
      name: "Victim",
      spec: CombatUnitSpec.Druid_Feral,
      class: CombatUnitClass.Druid,
      reaction: CombatUnitReaction.Friendly,
      info: {
        teamId: 0,
        specId: 103,
        personalRating: 1500,
        talents: [],
        pvpTalents: [],
        equipment: [],
        interestingAuras: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auraEvents: [
        // 只在死亡①窗口(14–20s)激活,死亡②窗口(30–40s)内早已移除。
        makeAuraEvent(
          LogEvent.SPELL_AURA_APPLIED,
          "22812",
          death1Ms - 6_000,
          "victim-1",
          "victim-1",
          "BUFF",
        ),
        makeAuraEvent(
          LogEvent.SPELL_AURA_REMOVED,
          "22812",
          death1Ms,
          "victim-1",
          "victim-1",
          "BUFF",
        ),
      ],
      damageIn: [
        {
          logLine: {
            event: LogEvent.SPELL_DAMAGE,
            timestamp: death1Ms - 3_000,
            parameters: [],
          },
          timestamp: death1Ms - 3_000,
          effectiveAmount: -300_000,
          amount: 300_000,
          spellSchoolId: "0x1",
          srcUnitId: "enemy-1",
          srcUnitName: "Enemy1",
          destUnitId: "victim-1",
          destUnitName: "Victim",
          spellId: "12222",
          spellName: "Test Dmg 1",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        {
          logLine: {
            event: LogEvent.SPELL_DAMAGE,
            timestamp: death2Ms - 3_000,
            parameters: [],
          },
          timestamp: death2Ms - 3_000,
          effectiveAmount: -120_000,
          amount: 120_000,
          spellSchoolId: "0x1",
          srcUnitId: "enemy-1",
          srcUnitName: "Enemy1",
          destUnitId: "victim-1",
          destUnitName: "Victim",
          spellId: "12222",
          spellName: "Test Dmg 2",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      advancedActions: [
        { ...makeAdvancedAction(death1Ms - 10_000, 0, 0, 937_500, 900_000) },
        { ...makeAdvancedAction(death1Ms, 0, 0, 937_500, 0) },
        { ...makeAdvancedAction(death2Ms - 10_000, 0, 0, 400_000, 380_000) },
        { ...makeAdvancedAction(death2Ms, 0, 0, 400_000, 0) },
      ],
      deathRecords: [
        {
          logLine: {
            event: LogEvent.UNIT_DIED,
            timestamp: death1Ms,
            parameters: [],
          },
          timestamp: death1Ms,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        {
          logLine: {
            event: LogEvent.UNIT_DIED,
            timestamp: death2Ms,
            parameters: [],
          },
          timestamp: death2Ms,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    });

    const combat = {
      startTime: matchStartMs,
      endTime: death2Ms + 5_000,
      units: { "victim-1": victim },
      playerId: "victim-1",
      playerTeamId: 0,
      winningTeamId: null,
      startInfo: { zoneId: "0", bracket: "2v2" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const ctx = buildMatchContext(combat, [victim], [], {
      useTimelinePrompt: true,
    });

    const idx1 = ctx.indexOf("[DEATH]");
    const idx2 = ctx.indexOf("[DEATH]", idx1 + 1);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);

    const block1 = ctx.slice(idx1, idx2);
    const block2 = ctx.slice(idx2);

    // 死亡①:Barkskin arith 行按死亡①窗内的 300k 伤害精确反推。
    expect(block1).toContain(
      "Mitigation audit: Barkskin blocked ~75k (≈8% max HP) over 6.0s active",
    );
    // 死亡②:Barkskin 早已在死亡①时刻移除,死亡②窗口内无白名单减伤激活
    // ——不得出现任何 Mitigation audit 行(串号的话这里会错误地重复出现
    // 死亡①的那一行)。
    expect(block2).not.toContain("Mitigation audit:");
  });
});
