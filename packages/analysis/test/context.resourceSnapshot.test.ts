import { describe, it, expect } from "vitest";
import {
  countActiveAtonements,
  buildPlayerLoadout,
  chargesReadyCount,
  computeReadyNames,
  computeOnCDDisplayNames,
  buildResourceSnapshot,
  buildJsonSituationSnapshot,
} from "../src/context/resourceSnapshot";
import {
  LogEvent,
  CombatUnitSpec,
  CombatUnitReaction,
} from "@gladlog/parser-compat";
import {
  makeUnit,
  makeAuraEvent,
} from "./ported/testHelpers";
import { loadLegacyMatchFixture } from "./helpers/legacyFixture";
import { specToString, isHealerSpec, extractMajorCooldowns, IMajorCooldownInfo } from "../src/utils/cooldowns";
import { analyzePlayerCCAndTrinket } from "../src/utils/ccTrinketAnalysis";
import { reconstructEnemyCDTimeline, IEnemyCDTimeline } from "../src/utils/enemyCDs";

describe("context.resourceSnapshot unit tests", () => {
  // ── 1. countActiveAtonements ────────────────────────────────────────────────
  describe("countActiveAtonements", () => {
    it("0个/空态: 无友方或无Aura事件 -> 计数为0", () => {
      const friends = [
        makeUnit("player-1"),
        undefined,
        makeUnit("player-2", { auraEvents: [] }),
      ];
      expect(countActiveAtonements(friends, 1000)).toBe(0);
    });

    it("典型态: 精确计数处于激活的Atonement(194384)", () => {
      const p1 = makeUnit("player-1", {
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, "194384", 1000, "player-1", "player-1", "BUFF"),
          makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, "194384", 5000, "player-1", "player-1", "BUFF"),
        ],
      });
      const p2 = makeUnit("player-2", {
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, "194384", 2000, "player-1", "player-2", "BUFF"),
        ],
      });
      // 在t=3000时刻, p1的Atonement在[1000, 5000]激活, p2的在[2000, inf]激活
      expect(countActiveAtonements([p1, p2], 3000)).toBe(2);
      // 在t=6000时刻, p1的已于5000移除, p2的仍激活
      expect(countActiveAtonements([p1, p2], 6000)).toBe(1);
    });

    it("边界态: Aura恰好在查询时刻过期(SPELL_AURA_REMOVED的timestamp等于查询时刻)", () => {
      const p1 = makeUnit("player-1", {
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, "194384", 1000, "player-1", "player-1", "BUFF"),
          makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, "194384", 5000, "player-1", "player-1", "BUFF"),
        ],
      });
      const p2 = makeUnit("player-2", {
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, "194384", 1000, "player-1", "player-2", "BUFF"),
          makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, "194384", 5001, "player-1", "player-2", "BUFF"),
        ],
      });
      // 恰好在5000时刻:
      // p1的移除事件在5000发生, timestamp <= 5000 被处理, 状态转为inactive
      // p2的移除事件在5001发生, timestamp > 5000 未被处理, 状态保持active
      expect(countActiveAtonements([p1, p2], 5000)).toBe(1);
    });
  });

  // ── 2. chargesReadyCount ────────────────────────────────────────────────────
  describe("chargesReadyCount", () => {
    it("0个/空态: 充能CD无释放记录 -> 返回最大充能数", () => {
      const cd = {
        spellId: "102342",
        spellName: "Ironbark",
        tag: "Defensive",
        cooldownSeconds: 60,
        maxChargesDetected: 2,
        casts: [],
        availableWindows: [],
        neverUsed: true,
      } as unknown as IMajorCooldownInfo;
      expect(chargesReadyCount(cd, 10)).toBe(2);
    });

    it("典型态: 部分释放, 部分充能完毕/正在充能", () => {
      const cd = {
        spellId: "102342",
        spellName: "Ironbark",
        tag: "Defensive",
        cooldownSeconds: 60,
        maxChargesDetected: 2,
        casts: [
          { timeSeconds: 10 },
          { timeSeconds: 15 },
        ],
        availableWindows: [],
        neverUsed: false,
      } as unknown as IMajorCooldownInfo;
      // 查询t=20: 两次释放都还在充能(10+60=70 > 20+0.5, 15+60=75 > 20+0.5)
      expect(chargesReadyCount(cd, 20)).toBe(0);
      // 查询t=71: 第一次释放已充能完毕(10+60=70 <= 71+0.5), 第二次仍在充能(15+60=75 > 71+0.5)
      expect(chargesReadyCount(cd, 71)).toBe(1);
    });

    it("边界态: 恰好在充能转好/消耗的边界 (timeSeconds + 0.5)", () => {
      const cd = {
        spellId: "102342",
        spellName: "Ironbark",
        tag: "Defensive",
        cooldownSeconds: 60,
        maxChargesDetected: 1,
        casts: [
          { timeSeconds: 10 },
        ],
        availableWindows: [],
        neverUsed: false,
      } as unknown as IMajorCooldownInfo;
      // 边界1: 消耗判定 <= timeSeconds + 0.5
      // 查询t=9.49 -> 10 <= 9.99 (false), 还没有被视为消耗
      expect(chargesReadyCount(cd, 9.49)).toBe(1);
      // 查询t=9.50 -> 10 <= 10.00 (true), 视为在相同渲染秒消耗
      expect(chargesReadyCount(cd, 9.50)).toBe(0);

      // 边界2: 充能好判定 earliestSlotReady <= timeSeconds + 0.5
      // 释放于10s, cooldown=60s -> ready于70s
      // 查询t=69.49 -> earliestSlotReady(70) <= 69.99 (false), 仍在CD中
      expect(chargesReadyCount(cd, 69.49)).toBe(0);
      // 查询t=69.50 -> earliestSlotReady(70) <= 70.00 (true), CD转好
      expect(chargesReadyCount(cd, 69.50)).toBe(1);
    });
  });

  // ── 3. computeReadyNames ────────────────────────────────────────────────────
  describe("computeReadyNames", () => {
    it("空态: 无任何CD配置 -> 返回空数组", () => {
      expect(computeReadyNames(10, [], [])).toEqual([]);
    });

    it("典型态: 提取就绪的CD display name(队友带 playerLabel 前缀)", () => {
      const ownerCDs = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 10 }],
        } as unknown as IMajorCooldownInfo,
      ];
      const teammateCDs = [
        {
          cds: [
            {
              spellId: "1022",
              spellName: "Sacrifice",
              cooldownSeconds: 120,
              maxChargesDetected: 1,
              casts: [{ timeSeconds: 15 }],
            } as unknown as IMajorCooldownInfo,
          ],
          playerLabel: "2",
        },
      ];
      // 查询t=80:
      // Ironbark: 10 + 60 = 70 <= 80 + 0.5 (ready)
      // Sacrifice: 15 + 120 = 135 > 80 + 0.5 (on CD)
      expect(computeReadyNames(80, ownerCDs, teammateCDs)).toEqual(["Ironbark"]);
    });

    it("边界态: timeSeconds <= 5 规则与充能恰好转好的判断边界", () => {
      const ownerCDs = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [],
        } as unknown as IMajorCooldownInfo,
      ];
      // 规则: 如果 timeSeconds <= 5 且 priorCasts.length === 0, 不加入就绪列表
      expect(computeReadyNames(5.0, ownerCDs, [])).toEqual([]);
      expect(computeReadyNames(5.01, ownerCDs, [])).toEqual(["Ironbark"]);

      // 充能恰好转好的边界 (10s 释放, 60s CD)
      const ownerCasts = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 10 }],
        } as unknown as IMajorCooldownInfo,
      ];
      expect(computeReadyNames(69.49, ownerCasts, [])).toEqual([]);
      expect(computeReadyNames(69.50, ownerCasts, [])).toEqual(["Ironbark"]);
    });
  });

  // ── 4. computeOnCDDisplayNames ──────────────────────────────────────────────
  describe("computeOnCDDisplayNames", () => {
    it("空态: 无 any CD配置 -> 返回空数组", () => {
      expect(computeOnCDDisplayNames(10, [], [])).toEqual([]);
    });

    it("典型态: 提取在冷却中的CD(队友带 playerLabel 前缀)", () => {
      const ownerCDs = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 10 }],
        } as unknown as IMajorCooldownInfo,
      ];
      const teammateCDs = [
        {
          cds: [
            {
              spellId: "1022",
              spellName: "Sacrifice",
              cooldownSeconds: 120,
              maxChargesDetected: 1,
              casts: [{ timeSeconds: 15 }],
            } as unknown as IMajorCooldownInfo,
          ],
          playerLabel: "2",
        },
      ];
      // 查询t=80: Ironbark转好(不属于cd), Sacrifice仍在CD (2:Sacrifice)
      expect(computeOnCDDisplayNames(80, ownerCDs, teammateCDs)).toEqual(["2:Sacrifice"]);
    });

    it("边界态: 冷却恰好转好边界", () => {
      const ownerCDs = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          casts: [{ timeSeconds: 10 }],
        } as unknown as IMajorCooldownInfo,
      ];
      // 10s 释放, 60s CD -> 70s转好
      // t=69.49: earliestSlotReady(70) > 69.99 (true) -> 仍在冷却
      expect(computeOnCDDisplayNames(69.49, ownerCDs, [])).toEqual(["Ironbark"]);
      // t=69.50: earliestSlotReady(70) > 70.00 (false) -> 冷却完毕
      expect(computeOnCDDisplayNames(69.50, ownerCDs, [])).toEqual([]);
    });
  });

  // ── 5. buildPlayerLoadout ───────────────────────────────────────────────────
  describe("buildPlayerLoadout", () => {
    it("空info/极简配置下优雅降级", () => {
      const owner = makeUnit("player-1", { name: "Player1" });
      const enemyCDTimeline = { players: [], alignedBurstWindows: [] } as unknown as IEnemyCDTimeline;
      const res = buildPlayerLoadout(owner, "Restoration Druid", [], [], enemyCDTimeline);

      expect(res.text).toContain("<player_loadout>");
      expect(res.text).toContain('<unit id="1" name="Player1" spec="Restoration Druid" role="log owner">');
      expect(res.text).toContain("<cooldowns>none tracked</cooldowns>");
      expect(res.text).toContain("</player_loadout>");
      expect(res.friendlyIdMap.get("Player1")).toBe(1);
    });

    it("典型态: 携带天赋/PVP技能、未使用CD标签、队友CD、敌方CD时间轴与技能组", () => {
      // 1246126 Call of Ohn'ahra (Restoration Druid PvP Talent), 对应 abilitySpellId: 33786
      const owner = makeUnit("player-1", {
        name: "Player1",
        info: { pvpTalents: ["1246126"] },
        spellCastEvents: [], // 未释放 33786 -> 应该带有 [UNUSED]
      });

      const ownerCDs = [
        {
          spellId: "102342",
          spellName: "Ironbark",
          cooldownSeconds: 60,
          maxChargesDetected: 1,
          neverUsed: true,
        } as unknown as IMajorCooldownInfo,
      ];

      const teammateCDs = [
        {
          player: makeUnit("player-2", { name: "Teammate1" }),
          spec: "Holy Paladin",
          cds: [
            {
              spellId: "1022",
              spellName: "Sacrifice",
              cooldownSeconds: 120,
              maxChargesDetected: 2,
              neverUsed: false,
            } as unknown as IMajorCooldownInfo,
          ],
        },
      ];

      const enemyCDTimeline = {
        players: [
          {
            playerName: "Enemy1",
            specName: "Frost Mage",
            offensiveCDs: [
              {
                spellId: "31884",
                spellName: "Combustion",
                cooldownSeconds: 120,
                castTimeSeconds: 10,
                buffEndSeconds: 20,
                availableAgainAtSeconds: 130,
              },
            ],
          },
        ],
        alignedBurstWindows: [],
      } as unknown as IEnemyCDTimeline;

      const enemies = [makeUnit("enemy-1", { name: "Enemy1", spec: CombatUnitSpec.Mage_Frost })];
      const enemyCooldowns = [
        {
          player: enemies[0],
          cds: [
            {
              spellId: "45438",
              spellName: "Ice Block",
              cooldownSeconds: 240,
              maxChargesDetected: 1,
              neverUsed: true,
            } as unknown as IMajorCooldownInfo,
          ],
        },
      ];

      const res = buildPlayerLoadout(
        owner,
        "Restoration Druid",
        ownerCDs,
        teammateCDs,
        enemyCDTimeline,
        enemies,
        enemyCooldowns
      );

      // 断言友方ID分配
      expect(res.friendlyIdMap.get("Player1")).toBe(1);
      expect(res.friendlyIdMap.get("Teammate1")).toBe(2);
      expect(res.enemyIdMap.get("Enemy1")).toBe(3);

      // 断言内容字段
      expect(res.text).toContain('<unit id="1" name="Player1" spec="Restoration Druid" role="log owner">');
      expect(res.text).toContain("<cooldowns>Ironbark [60s] [UNUSED]</cooldowns>");
      expect(res.text).toContain("<pvp_toolkit>Call of Ohn'ahra (Nature's Swiftness → instant Cyclone) [UNUSED]</pvp_toolkit>");

      expect(res.text).toContain('<unit id="2" name="Teammate1" spec="Holy Paladin" role="teammate">');
      expect(res.text).toContain("<cooldowns>Sacrifice [120s, 2 Charges]</cooldowns>");

      expect(res.text).toContain('<unit id="3" name="Enemy1" spec="Frost Mage" role="enemy">');
      // 包含 enemyCDTimeline 与 enemyCooldowns 技能组并集
      expect(res.text).toContain("Ice Block [240s] [UNUSED]");
      expect(res.text).toContain("Combustion [120s]");
    });
  });

  // ── 6. buildResourceSnapshot & buildJsonSituationSnapshot ───────────────
  describe("buildResourceSnapshot & buildJsonSituationSnapshot with real fixture", () => {
    it("使用真实 units 驱动 buildResourceSnapshot: 验证 Discipline Priest 及 Atonements/focus/enemy/cc 等输出结构与资源字段", () => {
      const match = loadLegacyMatchFixture();
      const units = Object.values(match.units).filter((u) => u.name && u.spec);

      // 从真实 match.units 提取信息
      const friends = units.filter((u) => u.reaction === CombatUnitReaction.Hostile); // 将 Hostile 作为 friends 以使 Priest 为 owner
      const enemies = units.filter((u) => u.reaction === CombatUnitReaction.Friendly);

      const owner = friends.find((p) => specToString(p.spec) === "Discipline Priest")!;
      const ownerSpec = specToString(owner.spec);
      const isOwnerHealer = isHealerSpec(owner.spec);

      const ownerCDs = extractMajorCooldowns(owner, match);
      const teammateCDs = friends
        .filter((p) => p.id !== owner.id)
        .map((p) => ({
          player: p,
          spec: specToString(p.spec),
          cds: extractMajorCooldowns(p, match),
        }));

      const ccTrinketSummaries = friends.map((p) =>
        analyzePlayerCCAndTrinket(p, enemies, match, [])
      );

      const enemyCDTimeline = reconstructEnemyCDTimeline(
        enemies,
        match,
        owner,
        friends
      );

      const playerIdMap = new Map<string, number>([
        [owner.name, 1],
        [teammateCDs[0].player.name, 2],
      ]);

      const resText = buildResourceSnapshot({
        timeSeconds: 10,
        ownerCDs,
        ownerName: owner.name,
        ownerSpec,
        isOwnerHealer,
        teammateCDs,
        ccTrinketSummaries,
        enemyCDTimeline,
        playerIdMap,
        matchStartMs: match.startTime,
        ownerUnit: owner,
      });

      // 验证 Discipline Priest 的 Atonements 资源输出
      expect(resText).toContain("Atonements: 0");
      // 验证 focus 字段与映射的 ID
      expect(resText).toContain("focus:2");
      // 验证敌方 CD 信息
      expect(resText).toContain("enemy:Combustion/Fire Mage");
      // 验证 CC 控制信息
      expect(resText).toContain("cc:1/Counterspell-1s[kick]");
      expect(resText).toContain("2/Rake-1s[stun]");
    });

    it("使用真实 units 驱动 buildJsonSituationSnapshot: 验证 Restoration Druid 输出结构", () => {
      const match = loadLegacyMatchFixture();
      const units = Object.values(match.units).filter((u) => u.name && u.spec);

      const friends = units.filter((u) => u.reaction === CombatUnitReaction.Friendly);
      const enemies = units.filter((u) => u.reaction === CombatUnitReaction.Hostile);

      const owner = friends.find((p) => specToString(p.spec) === "Restoration Druid")!;
      const ownerSpec = specToString(owner.spec);
      const isOwnerHealer = isHealerSpec(owner.spec);

      const ownerCDs = extractMajorCooldowns(owner, match);
      const teammateCDs = friends
        .filter((p) => p.id !== owner.id)
        .map((p) => ({
          player: p,
          spec: specToString(p.spec),
          cds: extractMajorCooldowns(p, match),
        }));

      const ccTrinketSummaries = friends.map((p) =>
        analyzePlayerCCAndTrinket(p, enemies, match, [])
      );

      const enemyCDTimeline = reconstructEnemyCDTimeline(
        enemies,
        match,
        owner,
        friends
      );

      const playerIdMap = new Map<string, number>([
        [owner.name, 1],
        [teammateCDs[0].player.name, 2],
      ]);

      const sitText = buildJsonSituationSnapshot({
        timeSeconds: 10,
        ownerCDs,
        ownerName: owner.name,
        ownerSpec,
        isOwnerHealer,
        teammateCDs,
        ccTrinketSummaries,
        enemyCDTimeline,
        playerIdMap,
      });

      expect(sitText).toContain("[SIT] ");
      const sitData = JSON.parse(sitText.replace(/^\s*\[SIT\]\s*/, ""));
      expect(sitData).toHaveProperty("rdy");
      expect(sitData).toHaveProperty("cd");
      expect(sitData).toHaveProperty("enemy_burst_active");
      expect(sitData).toHaveProperty("healer_free");

      // rdy 里应包含 ready 的技能
      expect(sitData.rdy).toContain("Ironbark");
      // cd 里包含正在冷却的技能
      expect(sitData.cd[0].name).toBe("Combustion");
    });

    it("用例证明: 采样时刻必须与渲染网格一致，证明小数秒输入与 floor 后整数秒输入产出相同快照", () => {
      const match = loadLegacyMatchFixture();
      const units = Object.values(match.units).filter((u) => u.name && u.spec);

      const friends = units.filter((u) => u.reaction === CombatUnitReaction.Hostile);
      const enemies = units.filter((u) => u.reaction === CombatUnitReaction.Friendly);

      const owner = friends.find((p) => specToString(p.spec) === "Discipline Priest")!;
      const ownerSpec = specToString(owner.spec);
      const isOwnerHealer = isHealerSpec(owner.spec);

      const ownerCDs = extractMajorCooldowns(owner, match);
      const teammateCDs = friends
        .filter((p) => p.id !== owner.id)
        .map((p) => ({
          player: p,
          spec: specToString(p.spec),
          cds: extractMajorCooldowns(p, match),
        }));

      const ccTrinketSummaries = friends.map((p) =>
        analyzePlayerCCAndTrinket(p, enemies, match, [])
      );

      const enemyCDTimeline = reconstructEnemyCDTimeline(
        enemies,
        match,
        owner,
        friends
      );

      const playerIdMap = new Map<string, number>([
        [owner.name, 1],
        [teammateCDs[0].player.name, 2],
      ]);

      const params10_0 = {
        timeSeconds: 10.0,
        ownerCDs,
        ownerName: owner.name,
        ownerSpec,
        isOwnerHealer,
        teammateCDs,
        ccTrinketSummaries,
        enemyCDTimeline,
        playerIdMap,
        matchStartMs: match.startTime,
        ownerUnit: owner,
      };

      const params10_2 = {
        ...params10_0,
        timeSeconds: 10.2, // 小数秒输入，应产生和10.0整数秒相同的快照
      };

      const snapshot10_0 = buildResourceSnapshot(params10_0);
      const snapshot10_2 = buildResourceSnapshot(params10_2);

      // 验证两者内容在渲染精度范围内完全一致
      expect(snapshot10_2).toBe(snapshot10_0);

      const sitSnapshot10_0 = buildJsonSituationSnapshot(params10_0);
      const sitSnapshot10_2 = buildJsonSituationSnapshot(params10_2);

      expect(sitSnapshot10_2).toBe(sitSnapshot10_0);
    });
  });
});
