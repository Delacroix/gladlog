/**
 * 裁定册 → missed-cleanse 接线测试(GH #20 第 2 层收官)。
 *
 * 四个门各一组用例,每组都带反向对照 —— 「门拦住了该拦的」和「门没拦不该
 * 拦的」缺一不可,否则一个恒 continue 的假门也能让一半断言变绿。
 *
 * 全部用真实数据模块(不 mock spellEffectData / spellCategories):签字的
 * 27 个 id 在官方数据里都真实可驱,mock 会把「裁定了一个驱不了的东西」这类
 * 错误藏起来。
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../src/utils/dispelAnalysis";
import {
  makeAuraEvent,
  makeDamageEvent,
  makeUnit,
} from "./ported/testHelpers";

const MATCH_START = 1_000_000;
const combat = () => ({
  startTime: MATCH_START,
  endTime: MATCH_START + 300_000,
});

/** 敌方施加 [spellId] 于 target,持续 durMs,配对完整。 */
function ccOn(
  target: string,
  spellId: string,
  fromOffsetMs: number,
  durMs: number,
) {
  return [
    makeAuraEvent(
      LogEvent.SPELL_AURA_APPLIED,
      spellId,
      MATCH_START + fromOffsetMs,
      "e1",
      target,
    ),
    makeAuraEvent(
      LogEvent.SPELL_AURA_REMOVED,
      spellId,
      MATCH_START + fromOffsetMs + durMs,
      "e1",
      target,
    ),
  ];
}

const healer = () =>
  makeUnit("h", { name: "Healer", spec: CombatUnitSpec.Paladin_Holy });
const melee = () =>
  makeUnit("m", { name: "Melee", spec: CombatUnitSpec.Warrior_Arms });
const ranged = () =>
  makeUnit("r", { name: "Ranged", spec: CombatUnitSpec.Mage_Frost });
const enemy = () => makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

function windowsFor(
  friends: unknown[],
  targetAuras: Record<string, unknown[]>,
) {
  for (const f of friends as Array<{ id: string; auraEvents: unknown[] }>) {
    if (targetAuras[f.id]) f.auraEvents = targetAuras[f.id];
  }
  return reconstructDispelSummary(
    friends as never,
    [enemy()] as never,
    combat(),
  ).missedCleanseWindows;
}

describe("裁定册接线:exitCandidate 行", () => {
  it("点燃(12654)挂满 6s 不再产生窗口;对照:同场变形术照常产生", () => {
    const w = windowsFor([healer(), melee()], {
      m: [
        ...ccOn("m", "12654", 10_000, 6_000),
        ...ccOn("m", "118", 30_000, 6_000),
      ],
    });
    expect(w.map((x) => x.spellId)).toEqual(["118"]);
  });
});

describe("裁定册接线:目标角色格", () => {
  it("冰霜新星(122)×远程 = skip → 无窗口;×近战 = worth → 有窗口", () => {
    const auras = ccOn("r", "122", 10_000, 6_000);
    const aurasM = ccOn("m", "122", 10_000, 6_000);
    expect(windowsFor([healer(), ranged()], { r: auras })).toHaveLength(0);
    expect(windowsFor([healer(), melee()], { m: aurasM })).toHaveLength(1);
  });

  it("语言诅咒(1714)×近战 = skip → 无窗口;×治疗 = worth(自驱)→ 有窗口", () => {
    // 诅咒需要队里有能驱诅咒的人:奶萨(Purify Spirit 驱魔法+诅咒)。
    const shaman = makeUnit("h2", {
      name: "RSham",
      spec: CombatUnitSpec.Shaman_Restoration,
    });
    expect(
      windowsFor([shaman, melee()], { m: ccOn("m", "1714", 10_000, 6_000) }),
    ).toHaveLength(0);
    expect(
      windowsFor([shaman, melee()], { h2: ccOn("h2", "1714", 10_000, 6_000) }),
    ).toHaveLength(1);
  });

  it("硬控×治疗自身 = self-impossible → 无窗口,即使存在第二驱散者", () => {
    // 双奶阵容:圣骑被制裁之锤(853)晕住,戒律牧完全有能力驱 —— 但按签字
    // 这一格是结构性豁免,不产生指控。
    const disc = makeUnit("h2", {
      name: "Disc",
      spec: CombatUnitSpec.Priest_Discipline,
    });
    expect(
      windowsFor([healer(), disc, melee()], {
        h: ccOn("h", "853", 10_000, 6_000),
      }),
    ).toHaveLength(0);
    // 对照:同一个晕落在近战身上 = must → 有窗口
    expect(
      windowsFor([healer(), disc, melee()], {
        m: ccOn("m", "853", 10_000, 6_000),
      }),
    ).toHaveLength(1);
  });
});

describe("裁定册接线:递减门(afterDR)", () => {
  it("变形术(afterDR: skip):链中第二发(50% DR)不产生窗口,第一发照常", () => {
    // MATCH_START 是 1970 纪元 → 12.1 前时代,DR 重置窗 16s。
    // 第一发 10s–16s(Full);第二发 20s 上身(距上一发结束 4s < 16s → 50%)。
    const w = windowsFor([healer(), melee()], {
      m: [
        ...ccOn("m", "118", 10_000, 6_000),
        ...ccOn("m", "118", 20_000, 4_000),
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0].timeSeconds).toBe(10);
  });

  it("对照:制裁之锤(afterDR: situational)链中第二发保留窗口", () => {
    const w = windowsFor([healer(), melee()], {
      m: [
        ...ccOn("m", "853", 10_000, 6_000),
        ...ccOn("m", "853", 20_000, 4_000),
      ],
    });
    expect(w).toHaveLength(2);
  });
});

describe("裁定册接线:时机门(第 3 层,规则 ③)", () => {
  // threatActiveAt 的伤害路径:±3s 窗口内我方任一单位承伤 ≥ 阈值(无
  // advanced 采样的 DPS 夹具兜底 60k)。一次 60k 命中于 13s 即可把
  // t∈[10,16] 整窗判为威胁期(|t-13|≤3)。伤害必须进 damageIn,不是
  // auraEvents —— 第一版夹具就栽在这里。
  const HIT = 60_000;

  function run(auraSpell: string, dmgAtMs: number | null, extraAuras: unknown[] = []) {
    const m = makeUnit("m", {
      name: "Melee",
      spec: CombatUnitSpec.Warrior_Arms,
      auraEvents: [...ccOn("m", auraSpell, 10_000, 6_000), ...extraAuras] as never,
      damageIn: (dmgAtMs === null
        ? []
        : [makeDamageEvent(MATCH_START + dmgAtMs, HIT, "m")]) as never,
    });
    return reconstructDispelSummary(
      [healer(), m] as never,
      [enemy()] as never,
      combat(),
    ).missedCleanseWindows;
  }

  it("situational(龙息术×近战)整窗威胁覆盖 → 无窗口;有平稳秒 → 有窗口", () => {
    expect(run("31661", 13_000)).toHaveLength(0);
    // 伤害挪到 8s:覆盖 t∈[5,11],窗口 [10,16] 的 12–16s 平稳 → 批评成立
    expect(run("31661", 8_000)).toHaveLength(1);
  });

  it("扩门(2026-08-19 二次裁定):worth(冰霜新星×近战)整窗威胁覆盖 → 无窗口;有平稳秒 → 有窗口", () => {
    expect(run("122", 13_000)).toHaveLength(0);
    expect(run("122", 8_000)).toHaveLength(1);
  });

  it("扩门:must(制裁之锤×近战,Full DR)整窗威胁覆盖 → 无窗口;有平稳秒 → 有窗口", () => {
    expect(run("853", 13_000)).toHaveLength(0);
    expect(run("853", 8_000)).toHaveLength(1);
  });

  it("未签字 id 不受时机门:暗言术:痛无裁定依据,走旧门(Low → 本就无窗口)", () => {
    // 时机豁免只对签字行成立 —— 未签字 id 没有「值不值得驱」的裁定,
    // 不能凭空豁免。这里用 Low 行验证路径不炸;真正的语义钉在 run()
    // 只对 verdict!==null 分支生效的实现上。
    expect(run("589", 13_000)).toHaveLength(0);
  });

  it("递减 → situational(制裁之锤链中第二发)整窗威胁覆盖 → 第二窗被时机门拦下", () => {
    // 第一发 10–16s(Full,must → 不受时机门);第二发 20–26s(50% DR →
    // afterDR situational)。60k 命中于 23s 只覆盖第二窗(t∈[20,26]),
    // 第一窗 10–16s 全平稳不受影响。
    const m = makeUnit("m", {
      name: "Melee",
      spec: CombatUnitSpec.Warrior_Arms,
      auraEvents: [
        ...ccOn("m", "853", 10_000, 6_000),
        ...ccOn("m", "853", 20_000, 6_000),
      ] as never,
      damageIn: [makeDamageEvent(MATCH_START + 23_000, HIT, "m")] as never,
    });
    const w = reconstructDispelSummary(
      [healer(), m] as never,
      [enemy()] as never,
      combat(),
    ).missedCleanseWindows;
    expect(w).toHaveLength(1);
    expect(w[0].timeSeconds).toBe(10);
  });
});

describe("裁定册接线:未签字 id 走旧门不变", () => {
  it("暗言术:痛(589,Low)依旧不产生窗口 —— 裁定册没有把 DoT 放进来", () => {
    expect(
      windowsFor([healer(), melee()], { m: ccOn("m", "589", 10_000, 20_000) }),
    ).toHaveLength(0);
  });
});
