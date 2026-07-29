import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  buildDeepDivePack,
  buildDeepDivePrompt,
  buildWindowAnchorFinding,
  buildWindowPack,
  type DeepDivePack,
} from "./deepDive";
import type { CandidateEvent, Finding } from "./types";

// 抄 deepDive.test.ts「死亡锚定「可用未用」事实进包」描述块(~703-758)的
// mkUnit/combat/candidates/finding 写法:锚点 100s / 比赛 105s → 窗口
// [70,105](PACK_BEFORE_S=30 / durS 夹 105),且「可用未用」判定不依赖
// finding.eventIds(直接消费 friends 的 deathRecords),用于验证 override
// 绕过空 eventIds 时仍能构包。
const mkUnit = (
  id: string,
  name: string,
  friendly: boolean,
  spec: string,
  deathAtMs?: number,
) => ({
  id,
  name,
  info: { specId: spec },
  spec,
  reaction: friendly ? CombatUnitReaction.Friendly : CombatUnitReaction.Hostile,
  advancedActions: [],
  damageOut: [],
  damageIn: [],
  healOut: [],
  healIn: [],
  absorbsOut: [],
  absorbsIn: [],
  casts: [],
  castStarts: [],
  petCasts: [],
  auraEvents: [],
  actionsOut: [],
  actionsIn: [],
  spellCastEvents: [],
  deathRecords: deathAtMs !== undefined ? [{ timestamp: deathAtMs }] : [],
});

const combat = {
  startTime: 0,
  endTime: 105_000,
  units: {
    o: mkUnit("o", "Owner-Area52", true, CombatUnitSpec.Priest_Discipline),
    w: mkUnit("w", "Warr-Area52", true, CombatUnitSpec.Warrior_Arms, 100_000),
    e: mkUnit("e", "Emage-Area52", false, CombatUnitSpec.Mage_Frost),
  },
};
const candidates = [
  {
    id: "death:w:100",
    type: "death-setup",
    t: 100,
    unitNames: ["Warr-Area52"],
    facts: { t: "100" },
  },
] as unknown as CandidateEvent[];
const finding = {
  eventIds: ["death:w:100"],
  severity: "high",
  category: "survival",
  title: "战士暴毙",
  explanation: "x",
} as Finding;

describe("windowOverride 等价性", () => {
  // 等价范围说明(全分支审查 finding):这条只证明「同一窗口边界,走 finding
  // 锚点与走 override 参数产出逐项相同的 pack」,不覆盖 focusT 派生的条目——
  // override 路径取窗口中点作 focusT 是设计使然(选段分析无死亡锚点可用),
  // 与 finding 路径的死亡时刻锚点本来就是两回事,只是本 fixture 恰好落在
  // 同一窗口 [70,105] 内才让两条路径重合。且本 fixture 无 advancedActions,
  // 不产出 hp 条目 —— fixture 充实(补 HP 采样)后 focusT 分叉会显现,
  // 到时这条测试不再是「逐项相同」的完整不变量,需要重新审视断言范围。
  it("同一窗口:finding 锚点包与 override 包逐项相同", () => {
    const viaFinding = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
    );
    // finding 锚点 100 → 窗口 [70, 105](PACK_BEFORE_S=30 / durS 夹 105)
    const viaOverride = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: 70, toS: 105 },
    );
    expect(viaOverride).not.toBeNull();
    expect(viaOverride!.items).toEqual(viaFinding!.items);
    expect(viaOverride!.facts).toEqual(viaFinding!.facts);
    expect(viaOverride!.anchorFrom).toBe(70);
    expect(viaOverride!.anchorTo).toBe(105);
  });

  it("override 时不依赖 finding.eventIds(合成空锚点也能构包)", () => {
    const synth = {
      eventIds: [],
      severity: "low",
      category: "window",
      title: "",
      explanation: "",
    } as Finding;
    const p = buildDeepDivePack(combat, synth, 0, [], "Owner-Area52", {
      fromS: 70,
      toS: 105,
    });
    expect(p).not.toBeNull(); // 旧行为:eventIds 空 → null;override 必须绕过
  });

  it("窗口越界被夹:fromS<0 → 0,toS>durS → durS", () => {
    const p = buildDeepDivePack(
      combat,
      finding,
      0,
      candidates,
      "Owner-Area52",
      { fromS: -5, toS: 999 },
    );
    expect(p!.anchorFrom).toBe(0);
    expect(p!.anchorTo).toBe(105);
  });
});

describe("buildWindowPack 信号门分级", () => {
  // 全字段正确命名的 ICombatUnit stub(不同于上面 mkUnit —— 上面那份字段名
  // 故意与真实接口错位,只够撑 HP/死亡两条通路;这里需要 analyzePlayerCCAndTrinket
  // 真正跑通,必须用它实际读取的字段名:auraEvents/spellCastEvents/damageIn 等)。
  const mkFullUnit = (
    id: string,
    name: string,
    friendly: boolean,
    spec: string,
    auraEvents: unknown[] = [],
  ) => ({
    id,
    name,
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
    auraEvents,
    actionIn: [],
    actionOut: [],
    deathRecords: [],
  });

  const auraEvent = (
    event: LogEvent,
    timestamp: number,
  ): Record<string, unknown> => ({
    logLine: { event, timestamp, parameters: [] },
    timestamp,
    spellId: "5782", // Fear — in ccSpellIds
    spellName: "Fear",
    srcUnitId: "e",
    srcUnitName: "Warr-Area52",
    destUnitId: "o",
    destUnitName: "Owner-Area52",
    effectiveAmount: 0,
    advancedActorMaxHp: 0,
    advancedActorCurrentHp: 0,
  });

  // owner 挨了一次 4s Fear(≥3s 硬控),没有饰品施放记录 → trinketState
  // 判定为 available_unused(hasCoachableSignal 的 cc 分支判据)。落在 80s,
  // 在窗口 [70,105] 内。
  const ccCombat = {
    startTime: 0,
    endTime: 105_000,
    startInfo: { zoneId: "1672" },
    units: {
      o: mkFullUnit(
        "o",
        "Owner-Area52",
        true,
        CombatUnitSpec.Priest_Discipline,
        [
          auraEvent(LogEvent.SPELL_AURA_APPLIED, 80_000),
          auraEvent(LogEvent.SPELL_AURA_REMOVED, 84_000),
        ],
      ),
      e: mkFullUnit("e", "Warr-Area52", false, CombatUnitSpec.Warrior_Arms),
    },
  };

  it("生存信号过门 → kind=survival", () => {
    const r = buildWindowPack(ccCombat, 70, 105, [], "Owner-Area52");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("survival");
  });

  it("全不过门 → null(调用方走无信号文案)", () => {
    const r = buildWindowPack(combat, 0, 10, [], "Owner-Area52"); // 空窗口
    expect(r).toBeNull();
  });

  // fix round 1(审查发现):buildWindowPack 若合成空 eventIds,HP 段的
  // `focus`(按 eventIds 反查 candidate.unitNames)与进攻段的 `cands`(按
  // eventIds 取候选专属 facts)恒空 —— kind=hp / off-target / dr-clip 三类
  // 条目永远产不出,offensive 门的 off-target/dr-clip 分支死路。修法:
  // buildWindowPack 改吃真 candidates,合成 finding 引用窗口内全部候选 id
  // (而非空数组),让 focus/cands 走既有派生逻辑 —— 零收集器内部特判。
  it("含窗口内 death 类 candidate(带 unitNames)→ 包含 kind=hp 条目", () => {
    const combatWithHp = {
      ...ccCombat,
      units: {
        ...ccCombat.units,
        o: {
          ...ccCombat.units.o,
          // 每秒一个 HP 采样(HP% = 100 - 秒数),供 focus 命中后的 HP 检查点使用。
          advancedActions: Array.from({ length: 106 }, (_, s) => ({
            logLine: { timestamp: s * 1000 },
            advancedActorId: "o",
            advancedActorCurrentHp: 100 - s,
            advancedActorMaxHp: 100,
          })),
        },
      },
    };
    const hpCandidates = [
      {
        id: "death:o:100",
        type: "death-setup",
        t: 100,
        unitNames: ["Owner-Area52"],
        facts: { t: "100" },
      },
    ] as unknown as CandidateEvent[];
    const r = buildWindowPack(
      combatWithHp,
      70,
      105,
      hpCandidates,
      "Owner-Area52",
    );
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("survival"); // 沿用 ccCombat 自带的 Fear 信号过门
    expect(r!.pack.items.some((i) => i.kind === "hp")).toBe(true);
  });

  it("含窗口内 dr-clipped-cc candidate → 进攻门过、含 kind=dr-clip、kind=offensive", () => {
    const mkOffUnit = (id: string, name: string, friendly: boolean) => ({
      id,
      name,
      info: { specId: "0" },
      spec: "0",
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
    });
    const drCombat = {
      startTime: 0,
      endTime: 105_000,
      units: {
        o: mkOffUnit("o", "Owner-Area52", true),
        e: mkOffUnit("e", "Warr-Area52", false),
      },
    };
    const drCandidates = [
      {
        id: "dr:1",
        type: "dr-clipped-cc",
        t: 80,
        unitNames: [],
        facts: {
          t: "80",
          spell: "Cheap Shot",
          target: "Warr-Area52",
          dr: "50%",
        },
      },
    ] as unknown as CandidateEvent[];
    const r = buildWindowPack(drCombat, 70, 105, drCandidates, "Owner-Area52");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("offensive");
    expect(r!.pack.items.some((i) => i.kind === "dr-clip")).toBe(true);
  });
});

describe("buildWindowAnchorFinding 中性锚点", () => {
  const somePack: DeepDivePack = {
    findingIndex: 0,
    anchorFrom: 36.7,
    anchorTo: 59.2,
    items: [
      {
        key: "p1",
        kind: "cc",
        t: 40,
        label: "Fear → Owner(4.0s)",
        unitNames: ["Owner-Area52"],
        facts: {
          t: "40",
          spell: "Fear",
          duration: "4.0",
          trinket: "available_unused",
        },
      },
    ],
    facts: {
      "p1.t": "40",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "available_unused",
    },
  };

  it("时间 floor 到渲染秒;无问题措辞;含 kind 计数摘要", () => {
    const f = buildWindowAnchorFinding(somePack, 36.7, 59.2, "survival");
    expect(f.title).toBe("用户选段 0:36–0:59");
    expect(f.explanation).not.toMatch(/问题|失误|错误|mistake|wrong/i);
    expect(f.eventIds).toEqual([]);
    expect(f.severity).toBe("low");
  });
});

describe("buildDeepDivePrompt window 模式", () => {
  // 抄 deepDive.test.ts 顶部的 pack/findings 写法(findingIndex 0,
  // anchorFrom/anchorTo 100/150),供 buildWindowAnchorFinding 与两条
  // mode 分叉测试共用。
  const pack: DeepDivePack = {
    findingIndex: 0,
    anchorFrom: 100,
    anchorTo: 150,
    items: [
      {
        key: "p1",
        kind: "cc",
        t: 128,
        label: "Fear → Healer(4.0s)",
        unitNames: ["Healer-R"],
        facts: {
          t: "128",
          spell: "Fear",
          duration: "4.0",
          trinket: "on_cooldown",
        },
      },
    ],
    facts: {
      "p1.t": "128",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "on_cooldown",
    },
  };
  const findings: Finding[] = [
    {
      eventIds: ["death:v:150"],
      severity: "high",
      category: "survival",
      title: "被秒",
      explanation: "You died at {{t}}s.",
    } as Finding,
  ];
  const windowFinding = buildWindowAnchorFinding(pack, 100, 150, "survival");

  it("含选段契约:不预设有问题 + 空数组合法", () => {
    const p = buildDeepDivePrompt(
      [pack],
      [windowFinding],
      "Holy Paladin",
      "Owner-Area52",
      "window",
    );
    expect(p).toContain("manually selected");
    expect(p).toContain("Do NOT assume something went wrong");
    expect(p).toContain("output an empty array");
    expect(p).not.toContain("deepening findings"); // 追问框架文案不得出现
    expect(p).toContain("SELECTED WINDOW"); // 段头换名
    // 硬规则与输出契约保持(审计兼容锚点)
    expect(p).toContain('"findingIndex": number');
    expect(p).toContain("Write NO digits");
  });

  it("缺省 mode 行为不变(回归锚)", () => {
    const p = buildDeepDivePrompt(
      [pack],
      findings,
      "Holy Paladin",
      "Owner-Area52",
    );
    expect(p).toContain("deepening findings");
    expect(p).toContain("FINDING 0:");
  });
});
