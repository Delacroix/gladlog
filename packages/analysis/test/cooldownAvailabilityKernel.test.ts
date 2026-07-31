/**
 * BACKLOG #21 item2(门规谓词即规范 drift-prevention):本包有两个冷却可用性谓词——
 * `cdAvailableAt`(cooldowns.ts,读已解析的 IMajorCooldownInfo.casts 台账)与
 * `isAvailableAt`(deathOutcomeAnalysis.ts,读 raw unit.spellCastEvents,多一层
 * resetSpellIds 重置扩展)。两者数据源不同、故意不完全统一(见各自文件内注释),
 * 但核心算法——"无使用记录则可用;否则看上次使用+冷却是否已到 t"——被抽成共享的
 * `isCooldownAvailableFromLastUse` 并被两者调用。
 *
 * 本测试双重把关:
 * 1. 直接测共享算法核本身的边界行为。
 * 2. 断言相等:对完全对应的合成输入(无 reset 技能、相同的施放历史),
 *    cdAvailableAt 与 isAvailableAt 必须给出一致的布尔结论——任何一处未来把核心
 *    判据改回本地手算公式,只要与共享算法核语义分叉,这里就会挂。
 */
import { describe, expect, it } from "vitest";

import { CombatUnitSpec } from "@gladlog/parser-compat";

import {
  cdAvailableAt,
  IMajorCooldownInfo,
  isCooldownAvailableFromLastUse,
} from "../src/utils/cooldowns";
import { isAvailableAt } from "../src/utils/deathOutcomeAnalysis";
import { makeSpellCastEvent, makeUnit } from "./ported/testHelpers";

describe("isCooldownAvailableFromLastUse(共享算法核)", () => {
  it("从未使用(null)→ 全程可用", () => {
    expect(isCooldownAvailableFromLastUse(null, 60, 0)).toBe(true);
    expect(isCooldownAvailableFromLastUse(null, 60, 9999)).toBe(true);
  });

  it("t 恰好等于 上次使用+冷却 → 可用(闭区间)", () => {
    expect(isCooldownAvailableFromLastUse(10, 60, 70)).toBe(true);
  });

  it("t 早于 上次使用+冷却 → 不可用", () => {
    expect(isCooldownAvailableFromLastUse(10, 60, 69)).toBe(false);
  });

  it("t 晚于 上次使用+冷却 → 可用", () => {
    expect(isCooldownAvailableFromLastUse(10, 60, 71)).toBe(true);
  });
});

describe("cdAvailableAt 与 isAvailableAt 在重叠语义上必须同判(断言相等)", () => {
  const SPELL_ID = "642"; // Divine Shield
  const COOLDOWN_SECONDS = 300;
  const MATCH_START = 1_000_000;

  function cdWith(casts: number[]): IMajorCooldownInfo {
    return {
      spellId: SPELL_ID,
      spellName: "Divine Shield",
      tag: "Defensive",
      cooldownSeconds: COOLDOWN_SECONDS,
      maxChargesDetected: 1,
      casts: casts.map((timeSeconds) => ({ timeSeconds })),
      availableWindows: [],
      neverUsed: casts.length === 0,
    };
  }

  function unitWith(casts: number[]) {
    return makeUnit("p1", {
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: casts.map((atSeconds) =>
        makeSpellCastEvent(SPELL_ID, MATCH_START + atSeconds * 1000, "p1"),
      ),
    });
  }

  const scenarios: { name: string; casts: number[]; atSeconds: number }[] = [
    { name: "从未使用", casts: [], atSeconds: 45 },
    { name: "刚用过,CD 未转好", casts: [10], atSeconds: 40 },
    { name: "CD 恰好转好(闭区间边界)", casts: [10], atSeconds: 310 },
    { name: "CD 早已转好", casts: [10], atSeconds: 400 },
    { name: "多次施放取最近一次(仍未转好)", casts: [10, 350], atSeconds: 400 },
    // 追加轮修复(2026-07-31):isAvailableAt 曾用 Math.max 取全场同 spellId 施放
    // 时刻,不按 atSeconds 截断——若单位在查询时刻(400s)之后又释放过一次
    // (450s),会把这次未来施放误判成"上次使用",导致查询时刻本应可用
    // (0s 用过一次,300s 冷却,400s 早已转好)被误报为不可用。此场景在修复前
    // 会 fail(viaIsAvailableAt=false, viaCdAvailableAt=true)。
    {
      name: "查询时刻之后还有一次重新施放 → 不应倒果为因判定过去不可用",
      casts: [0, 450],
      atSeconds: 400,
    },
  ];

  for (const { name, casts, atSeconds } of scenarios) {
    it(`${name}(casts=${JSON.stringify(casts)}, t=${atSeconds}s)`, () => {
      const viaCdAvailableAt = cdAvailableAt(cdWith(casts), atSeconds);
      const viaIsAvailableAt = isAvailableAt(
        unitWith(casts),
        SPELL_ID,
        COOLDOWN_SECONDS,
        atSeconds,
        MATCH_START,
      );
      expect(viaIsAvailableAt).toBe(viaCdAvailableAt);
    });
  }
});
