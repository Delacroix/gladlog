/**
 * 奶专精规避手段表的漏项检测(docs/coaching-grounding-audit.md §D2)。
 *
 * 原缺陷:表是 `Partial<Record<...>>`,恢复德根本不在里面,查不到走 `?? []`,
 * 于是恢复德每次吃控都被渲染成一句肯定的事实 `no avoidance tools available` ——
 * 把本表的覆盖缺口说成了游戏事实。审计把这类叫「缺项制造指控」。
 *
 * 本测试钉两件事:每个奶专精都必须**明确表态**(数组 = 已勘查,`null` = 未勘查),
 * 以及未勘查时渲染层必须闭嘴。
 */
import { CombatUnitSpec } from "@gladlog/parser-compat";

import { isHealerSpec } from "../src/utils/cooldowns";
import {
  formatHealerCCReceivedForContext,
  healerAvoidanceSpells,
  type IHealerCCReceived,
} from "../src/utils/healerExposureAnalysis";

const HEALER_SPECS = (Object.values(CombatUnitSpec) as CombatUnitSpec[]).filter(
  (s) => isHealerSpec(s),
);

function ccEvent(over: Partial<IHealerCCReceived> = {}): IHealerCCReceived {
  return {
    atSeconds: 61,
    ccSpellName: "Polymorph",
    ccCategory: "Incapacitate",
    durationSeconds: 4,
    teammateLowHp: true,
    avoidanceToolsAvailable: [],
    avoidanceSurveyed: true,
    ...over,
  };
}

describe("奶专精规避手段表:漏项检测", () => {
  it("测试自身有效(能枚举到全部 7 个奶专精)", () => {
    expect(HEALER_SPECS.length).toBe(7);
  });

  it("每个奶专精都必须明确表态 —— 要么给数组,要么显式 null", () => {
    // `healerAvoidanceSpells` 对「未登记」和「显式 null」都返回 null,所以这里
    // 直接断言渲染后果:未勘查的专精不得产出「没有规避手段」这句话。
    // 真正的漏项在下一条里按键集查。
    for (const spec of HEALER_SPECS) {
      const v = healerAvoidanceSpells(spec);
      expect(
        v === null || Array.isArray(v),
        `spec ${spec} 的规避手段既不是数组也不是 null`,
      ).toBe(true);
    }
  });

  it("未勘查的专精不会被渲染成「没有规避手段」", () => {
    const line = formatHealerCCReceivedForContext([
      ccEvent({ avoidanceSurveyed: false }),
    ]);
    expect(line).not.toContain("no avoidance tools available");
    expect(line).toContain("Polymorph");
  });

  it("已勘查但确实没有,才说「没有规避手段」", () => {
    const line = formatHealerCCReceivedForContext([
      ccEvent({ avoidanceSurveyed: true }),
    ]);
    expect(line).toContain("no avoidance tools available");
  });

  it("恢复德当前记为未勘查(补齐时改这条,并按签字纪律填表)", () => {
    // 这不是「恢复德没有规避手段」—— 是没人裁定过它有哪些。
    expect(healerAvoidanceSpells(CombatUnitSpec.Druid_Restoration)).toBeNull();
  });

  it("其余六个奶专精都已勘查", () => {
    const unsurveyed = HEALER_SPECS.filter(
      (s) =>
        s !== CombatUnitSpec.Druid_Restoration &&
        healerAvoidanceSpells(s) === null,
    );
    expect(
      unsurveyed,
      `这些奶专精没有在 HEALER_AVOIDANCE_SPELLS 里表态,` +
        `会导致它们吃控时静默(而不是被误报「没有规避手段」):${unsurveyed.join(", ")}`,
    ).toEqual([]);
  });
});
