import {
  identifyCriticalMoments,
  buildDeathRootCauseTrace,
  getEnemyStateAtTime,
  getOwnerCDsAvailable,
  findContributingDeath,
  buildKillMomentFields,
  DEATH_CC_LOOKBACK_S,
} from "../src/context/criticalMoments";
import { CombatUnitSpec } from "@gladlog/parser-compat";
import { IMajorCooldownInfo } from "../src/utils/cooldowns";
import { IPlayerCCTrinketSummary } from "../src/utils/ccTrinketAnalysis";
import { makeUnit } from "./ported/testHelpers";
import { loadLegacyMatchFixture } from "./helpers/legacyFixture";

describe("criticalMoments unit tests", () => {
  describe("identifyCriticalMoments", () => {
    it("全空输入 -> moments为空数组、constrainedTrade === false", () => {
      const result = identifyCriticalMoments(
        false,
        [],
        { players: [], alignedBurstWindows: [] },
        [],
        [],
        [],
        [],
        [],
        0,
        60,
        [],
        0,
      );
      expect(result.moments).toEqual([]);
      expect(result.constrainedTrade).toBe(false);
    });

    it("合成 1 条 friendlyDeath -> 产出对应 death moment, 断言其字段(时间、名字、role)为具体值", () => {
      const death = {
        spec: "Restoration Druid",
        name: "Player1",
        atSeconds: 15,
      };
      const friends = [
        makeUnit("Player1", {
          name: "Player1",
          spec: CombatUnitSpec.Druid_Restoration,
        }),
      ];
      const result = identifyCriticalMoments(
        false,
        [],
        { players: [], alignedBurstWindows: [] },
        [death],
        [],
        [],
        [],
        [],
        0,
        60,
        friends,
        0,
      );
      expect(result.moments.length).toBe(1);
      const m = result.moments[0];
      expect(m.timeSeconds).toBe(15);
      expect(m.title).toBe("Restoration Druid death");
      expect(m.roleLabel).toBe("Kill");
      expect(m.isDeath).toBe(true);
    });

    it("死亡 + 时间上匹配的 healingGap / panicDefensive -> 断言归因字段具体值", () => {
      // 1. Matched healing gap
      const death = {
        spec: "Restoration Druid",
        name: "Player1",
        atSeconds: 15,
      };
      const gap = {
        fromSeconds: 10,
        toSeconds: 15,
        durationSeconds: 5.0,
        freeCastSeconds: 4.0,
        mostDamagedName: "Player1",
        mostDamagedSpec: "Restoration Druid",
        mostDamagedAmount: 100000,
      };

      const resultWithGap = identifyCriticalMoments(
        true, // isHealer
        [],
        { players: [], alignedBurstWindows: [] },
        [death],
        [gap],
        [],
        [],
        [],
        0,
        60,
        [
          makeUnit("Player1", {
            name: "Player1",
            spec: CombatUnitSpec.Druid_Restoration,
          }),
        ],
        0,
      );

      expect(resultWithGap.moments.length).toBe(1);
      expect(resultWithGap.moments[0].whatHappened).toContain(
        "A 5.0s healing gap (4.0s free-cast) was active from 0:10",
      );

      // 2. Matched panic defensive (contributing death setup)
      const panic = {
        timeSeconds: 5,
        casterSpec: "Paladin Holy",
        casterName: "Player2",
        spellName: "Divine Shield",
        spellId: "642",
        targetName: "Player2",
        targetSpec: "Paladin Holy",
      };

      const resultWithPanic = identifyCriticalMoments(
        false,
        [],
        { players: [], alignedBurstWindows: [] },
        [death],
        [],
        [panic],
        [],
        [],
        0,
        60,
        [
          makeUnit("Player1", {
            name: "Player1",
            spec: CombatUnitSpec.Druid_Restoration,
          }),
          makeUnit("Player2", {
            name: "Player2",
            spec: CombatUnitSpec.Paladin_Holy,
          }),
        ],
        0,
      );

      expect(resultWithPanic.moments.length).toBe(2);
      const panicMoment = resultWithPanic.moments.find(
        (m) => m.roleLabel === "Setup",
      );
      expect(panicMoment).toBeDefined();
      expect(panicMoment?.contributingDeathSpec).toBe("Restoration Druid");
      expect(panicMoment?.contributingDeathAtSeconds).toBe(15);
    });

    it("ConstrainedTrade 门: 构造 burst score >= 5 + owner 防御 CD trade + 局长 < 该 CD 冷却 + 后随死亡 -> constrainedTrade === true; 再构造反例 -> false", () => {
      const firstBurst = {
        fromSeconds: 2,
        toSeconds: 8,
        activeCDs: [
          {
            playerName: "Enemy1",
            spellName: "Combustion",
            spellId: "31884",
            castSeconds: 2,
          },
        ],
        threatScore: 5.0,
        threatLabel: "High" as const,
        dangerScore: 5.0,
        dangerLabel: "High" as const,
        dampeningPct: 0.1,
        damageInWindow: 100000,
        damageRatio: 0.5,
        healerCCed: false,
      };

      const enemyCDTimeline = {
        players: [],
        alignedBurstWindows: [firstBurst],
      };

      const friendlyDeaths = [
        { spec: "Restoration Druid", name: "Player1", atSeconds: 15 },
      ];

      const cooldowns = [
        {
          spellId: "22812",
          spellName: "Barkskin",
          tag: "Defensive",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 3 }],
          availableWindows: [],
          neverUsed: false,
        },
      ];

      const friends = [
        makeUnit("Player1", {
          name: "Player1",
          spec: CombatUnitSpec.Druid_Restoration,
        }),
      ];

      // 1. Success case
      const resSuccess = identifyCriticalMoments(
        false,
        cooldowns,
        enemyCDTimeline,
        friendlyDeaths,
        [],
        [],
        [],
        [],
        5000,
        45, // durationSeconds (45) < cooldownSeconds (60)
        friends,
        0,
      );
      expect(resSuccess.constrainedTrade).toBe(true);

      // 2. Counter-example A: burst score < 5
      const lowBurst = { ...firstBurst, dangerScore: 4.9 };
      const resLowBurst = identifyCriticalMoments(
        false,
        cooldowns,
        { ...enemyCDTimeline, alignedBurstWindows: [lowBurst] },
        friendlyDeaths,
        [],
        [],
        [],
        [],
        5000,
        45,
        friends,
        0,
      );
      expect(resLowBurst.constrainedTrade).toBe(false);

      // 3. Counter-example B: durationSeconds >= minCooldown
      const resLongMatch = identifyCriticalMoments(
        false,
        cooldowns,
        enemyCDTimeline,
        friendlyDeaths,
        [],
        [],
        [],
        [],
        5000,
        70, // 70 >= 60
        friends,
        0,
      );
      expect(resLongMatch.constrainedTrade).toBe(false);

      // 4. Counter-example C: No defensive CD cast in window
      const farCDs = [
        {
          ...cooldowns[0],
          casts: [{ timeSeconds: 20 }], // Outside burst window [2-5, 8+5] = [-3, 13]
        },
      ];
      const resNoCD = identifyCriticalMoments(
        false,
        farCDs,
        enemyCDTimeline,
        friendlyDeaths,
        [],
        [],
        [],
        [],
        5000,
        45,
        friends,
        0,
      );
      expect(resNoCD.constrainedTrade).toBe(false);

      // 5. Counter-example D: No friendly death
      const resNoDeath = identifyCriticalMoments(
        false,
        cooldowns,
        enemyCDTimeline,
        [], // No deaths
        [],
        [],
        [],
        [],
        5000,
        45,
        friends,
        0,
      );
      expect(resNoDeath.constrainedTrade).toBe(false);
    });
  });

  describe("buildDeathRootCauseTrace", () => {
    it("回溯窗口内/外(DEATH_CC_LOOKBACK_S 边界)事件是否进 trace", () => {
      const deathTimeSeconds = 30;
      const matchStartMs = 0;
      const ownerCooldowns: IMajorCooldownInfo[] = [];
      const dyingUnit = undefined;

      const ccInside = {
        atSeconds: 15,
        durationSeconds: 3, // Ends at 18 (exactly on boundary)
        spellId: "118",
        spellName: "Polymorph",
        sourceName: "EnemyMage",
        sourceSpec: "Frost Mage",
        damageTakenDuring: 0,
        trinketState: "available_unused" as const,
        drInfo: null,
        distanceYards: null,
        losBlocked: null,
      };

      const ccOutside = {
        atSeconds: 15,
        durationSeconds: 2, // Ends at 17 (outside boundary)
        spellId: "118",
        spellName: "Polymorph",
        sourceName: "EnemyMage",
        sourceSpec: "Frost Mage",
        damageTakenDuring: 0,
        trinketState: "available_unused" as const,
        drInfo: null,
        distanceYards: null,
        losBlocked: null,
      };

      const ccAfterDeath = {
        atSeconds: 31,
        durationSeconds: 5,
        spellId: "118",
        spellName: "Polymorph",
        sourceName: "EnemyMage",
        sourceSpec: "Frost Mage",
        damageTakenDuring: 0,
        trinketState: "available_unused" as const,
        drInfo: null,
        distanceYards: null,
        losBlocked: null,
      };

      const ccSummary: IPlayerCCTrinketSummary = {
        playerName: "Player1",
        playerSpec: "Restoration Druid",
        trinketType: "Gladiator",
        trinketCooldownSeconds: 120,
        ccInstances: [ccInside, ccOutside, ccAfterDeath],
        trinketUseTimes: [],
        missedTrinketWindows: [],
        rootInstances: [],
        disarmInstances: [],
        interruptInstances: [],
        ccAvoidedInstances: [],
      };

      const trace = buildDeathRootCauseTrace(
        deathTimeSeconds,
        ownerCooldowns,
        ccSummary,
        dyingUnit,
        matchStartMs,
        true,
        [],
      );

      const ccTraces = trace.filter((t) => t.includes("CC on dying player:"));
      expect(ccTraces.length).toBe(1);
      expect(ccTraces[0]).toContain("Polymorph");
      expect(ccTraces[0]).toContain("0:15–0:18");
    });
  });

  describe("getEnemyStateAtTime", () => {
    it("无数据时刻 -> 返回空态不抛", () => {
      const state = getEnemyStateAtTime(10, {
        players: [],
        alignedBurstWindows: [],
      });
      expect(state).toBe("No coordinated burst detected in this window");

      const stateWithPressure = getEnemyStateAtTime(
        10,
        { players: [], alignedBurstWindows: [] },
        50000,
      );
      expect(stateWithPressure).toBe(
        "No coordinated burst detected — sustained/DoT or single-target pressure (peak: 50k in 5s)",
      );
    });

    it("典型态", () => {
      const burst = {
        fromSeconds: 5,
        toSeconds: 15,
        activeCDs: [
          {
            playerName: "Enemy1",
            spellName: "Combustion",
            spellId: "31884",
            castSeconds: 5,
          },
        ],
        threatScore: 6.0,
        threatLabel: "Critical" as const,
        dangerScore: 6.0,
        dangerLabel: "Critical" as const,
        dampeningPct: 0.1,
        damageInWindow: 100000,
        damageRatio: 0.5,
        healerCCed: false,
      };
      const timeline = {
        players: [],
        alignedBurstWindows: [burst],
      };
      const state = getEnemyStateAtTime(10, timeline);
      expect(state).toContain("Aligned burst");
      expect(state).toContain("Enemy1: Combustion");
    });
  });

  describe("getOwnerCDsAvailable", () => {
    it("空态", () => {
      const state = getOwnerCDsAvailable(10, []);
      expect(state).toBe("No major CD data for log owner");
    });

    it("典型态", () => {
      const cooldowns = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          tag: "Defensive",
          cooldownSeconds: 90,
          maxChargesDetected: 1,
          casts: [],
          availableWindows: [],
          neverUsed: true,
        },
        {
          spellId: "22812",
          spellName: "Barkskin",
          tag: "Defensive",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 5 }],
          availableWindows: [],
          neverUsed: false,
        },
        {
          spellId: "740",
          spellName: "Tranquility",
          tag: "Defensive",
          cooldownSeconds: 180,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 50 }],
          availableWindows: [],
          neverUsed: false,
        },
      ];

      const state = getOwnerCDsAvailable(100, cooldowns);
      expect(state).toContain(
        "Available: Ironbark (never used — available since match start), Barkskin (ready since 1:05)",
      );
      expect(state).toContain("On cooldown: Tranquility (on CD until ~3:50)");
    });
  });

  describe("findContributingDeath", () => {
    it("空态", () => {
      const res = findContributingDeath(10, []);
      expect(res).toBeUndefined();
    });

    it("典型态 - 在45秒回溯窗口内/外", () => {
      const deaths = [
        { spec: "Restoration Druid", name: "Player1", atSeconds: 30 },
        { spec: "Frost Mage", name: "Player2", atSeconds: 60 },
      ];
      const res1 = findContributingDeath(10, deaths);
      expect(res1).toEqual({
        spec: "Restoration Druid",
        name: "Player1",
        atSeconds: 30,
      });

      const res2 = findContributingDeath(50, deaths);
      expect(res2).toEqual({
        spec: "Frost Mage",
        name: "Player2",
        atSeconds: 60,
      });

      const res3 = findContributingDeath(10, [
        { spec: "Restoration Druid", name: "Player1", atSeconds: 60 },
      ]);
      expect(res3).toBeUndefined();
    });
  });

  describe("buildKillMomentFields", () => {
    it("空态", () => {
      const res = buildKillMomentFields(30, [], undefined, false, null);
      expect(res.mechanicalAvailability).toEqual([
        "Trinket: on cooldown or already spent",
      ]);
      expect(res.interpretation).toEqual([]);
      expect(res.tieredOptions).toEqual({
        realistic: [],
        limited: [],
        unavailable: [],
      });
      expect(res.finalAssessment).toBeUndefined();
    });

    it("典型态", () => {
      const cooldowns = [
        {
          spellId: "22812",
          spellName: "Barkskin",
          tag: "Defensive",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [],
          availableWindows: [],
          neverUsed: true,
        },
      ];

      const ccInstance = {
        atSeconds: 25,
        durationSeconds: 5,
        spellId: "118",
        spellName: "Polymorph",
        sourceName: "EnemyMage",
        sourceSpec: "Frost Mage",
        damageTakenDuring: 0,
        trinketState: "available_unused" as const,
        drInfo: null,
        distanceYards: 5,
        losBlocked: false,
      };

      const ccSummary: IPlayerCCTrinketSummary = {
        playerName: "Player1",
        playerSpec: "Restoration Druid",
        trinketType: "Gladiator",
        trinketCooldownSeconds: 120,
        ccInstances: [ccInstance],
        trinketUseTimes: [],
        missedTrinketWindows: [],
        rootInstances: [],
        disarmInstances: [],
        interruptInstances: [],
        ccAvoidedInstances: [],
      };

      const res = buildKillMomentFields(30, cooldowns, ccSummary, true, 30);

      expect(res.mechanicalAvailability).toContain(
        "Barkskin: never used — available",
      );
      expect(res.mechanicalAvailability).toContain(
        "Trinket available at 0:25 during Polymorph — not used",
      );

      expect(res.interpretation).toContain(
        "No direct defensive response possible at death — resource exhausted by opening burst trade",
      );
      expect(res.interpretation).toContain(
        "Trinket during Polymorph at 0:25 could have created a short survival window",
      );
      expect(res.interpretation).toContain(
        "Melee-range CC (Polymorph at 5yd) may indicate positioning contributed to exposure (uncertain)",
      );

      expect(res.tieredOptions.realistic).toContain(
        "Trinket during Polymorph at 0:25 — only immediate actionable response",
      );
      expect(res.tieredOptions.limited).toContain(
        "Minor positioning adjustments to avoid melee-range CC (uncertain feasibility)",
      );
      expect(res.tieredOptions.unavailable).toContain(
        "No major defensive CDs available (all committed earlier in the match)",
      );

      expect(res.finalAssessment).toBeDefined();
      expect(res.finalAssessment?.macroOutcome).toBe(
        "All major defensive CDs committed in opening trade with no recovery window before this death (player was at 30% HP 5s before death)",
      );
      expect(res.finalAssessment?.microMistakes).toContain(
        "Trinket not used at 0:25 (minor survival extension possible)",
      );
      expect(res.finalAssessment?.microMistakes).toContain(
        "Positioning allowed melee-range Polymorph (uncertain impact)",
      );
    });
  });

  describe("DEATH_CC_LOOKBACK_S", () => {
    it("is exported and equals 12", () => {
      expect(DEATH_CC_LOOKBACK_S).toBe(12);
    });
  });

  describe("using real fixture via loadLegacyMatchFixture", () => {
    it("loads fixture and identifies critical moments with synthetic death", () => {
      const match = loadLegacyMatchFixture();
      const units = Object.values(match.units).filter((u) => u.info);
      const friends = units.filter((u) => u.reaction === 1);

      const targetFriend = friends[0];
      const death = {
        spec: targetFriend.spec ? "Restoration Druid" : "Unknown",
        name: targetFriend.name,
        atSeconds: 15,
      };

      const result = identifyCriticalMoments(
        false,
        [],
        { players: [], alignedBurstWindows: [] },
        [death],
        [],
        [],
        [],
        [],
        0,
        60,
        friends,
        match.startTime,
        targetFriend,
      );

      expect(result.moments.length).toBeGreaterThanOrEqual(1);
      const deathMoment = result.moments.find((m) => m.isDeath);
      expect(deathMoment).toBeDefined();
      expect(deathMoment?.timeSeconds).toBe(15);
      expect(deathMoment?.title).toContain("death");
    });
  });
});
