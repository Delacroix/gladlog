/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * UA(痛苦无常)反噬豁免必须是**谓词**,不能靠数据缺口兜底。
 *
 * 现状:316099/342938/34914 在 spellEffectGenerated 里没有条目 → getDispelType
 * 返回 null → 漏解判定碰巧不报。一旦 DB2 数据刷新补上 UA 的 dispelType: "Magic",
 * 「你该驱散 UA」的误报会立刻出现 —— 驱散 UA 会沉默+反伤驱散者,不驱散不是失误。
 *
 * 本文件用 mock 模拟「数据补齐后」的世界,断言反噬类 debuff 仍不进漏解窗口。
 */
import {
  CombatUnitReaction,
  CombatUnitSpec,
  LogEvent,
} from "@gladlog/parser-compat";

import { reconstructDispelSummary } from "../../src/utils/dispelAnalysis";
import { makeAuraEvent, makeUnit } from "./testHelpers";

// 模拟 DB2 数据刷新补齐 UA 条目(dispelType: Magic)
vi.mock("../../src/data/spellEffectData", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellEffectData")>();
  return {
    ...mod,
    spellEffectData: {
      ...mod.spellEffectData,
      "316099": {
        spellId: "316099",
        name: "Unstable Affliction",
        dispelType: "Magic",
      },
    },
  };
});

// 模拟 UA 进入分类表(debuffs_offensive → High 优先级,足以进漏解判定)
vi.mock("../../src/data/spellCategories", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/data/spellCategories")>();
  return {
    ...mod,
    SPELL_CATEGORIES: {
      ...mod.SPELL_CATEGORIES,
      "316099": { type: "debuffs_offensive" },
    },
  };
});

const MATCH_START = 1_000_000;

function makeCombat() {
  return { startTime: MATCH_START, endTime: MATCH_START + 120_000 };
}

describe("dispelAnalysis — dispel-penalty exemption", () => {
  it("never flags a dispel-penalty debuff (UA) as a missed cleanse, even with full game data", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    // UA sits on the target for 10s, expires undispelled — correct play, not a miss
    (target as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "316099",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "316099",
        MATCH_START + 20_000,
        "e1",
        "t",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.missedCleanseWindows).toHaveLength(0);
  });

  it("control: a non-penalty Magic debuff under the same mocks still produces a missed cleanse window", () => {
    const healer = makeUnit("h", {
      name: "Healer",
      spec: CombatUnitSpec.Priest_Holy,
    });
    const target = makeUnit("t", {
      name: "Target",
      spec: CombatUnitSpec.Warrior_Arms,
    });
    const enemy = makeUnit("e1", { reaction: CombatUnitReaction.Hostile });

    (target as any).auraEvents = [
      makeAuraEvent(
        LogEvent.SPELL_AURA_APPLIED,
        "118",
        MATCH_START + 10_000,
        "e1",
        "t",
      ),
      makeAuraEvent(
        LogEvent.SPELL_AURA_REMOVED,
        "118",
        MATCH_START + 20_000,
        "e1",
        "t",
      ),
    ];

    const res = reconstructDispelSummary(
      [healer, target] as any,
      [enemy] as any,
      makeCombat(),
    );
    expect(res.missedCleanseWindows).toHaveLength(1);
  });
});
