import { describe, expect, test } from "vitest";

import {
  buildTalentUniverse,
  classifyBeneficiary,
  resolvePct,
} from "../scripts/datagen/genTalentMitigation";
import { PVP_TALENT_POOL_GENERATED } from "../src/data/pvpTalentPoolGenerated";

/**
 * Both halves pinned here are halves that actually went wrong while building
 * this generator, so the tests encode the two failure modes rather than the
 * happy path:
 *
 *  1. universe assembly — a first pass used the raidbots node tree only and the
 *     positive control (473909 知识古树, a PvP talent) came back missing, which
 *     reads exactly like "DB2 has no talent mitigation" rather than "the input
 *     universe is short by one source".
 *  2. percentage resolution — keying on the talent's own aura-87 row
 *     under-recalls, because the number usually lives on a *different* spell
 *     that the tooltip points at.
 */
describe("buildTalentUniverse", () => {
  const specs = [
    {
      specId: 105,
      className: "Druid",
      specName: "Restoration",
      classNodes: [{ id: 1, name: "N1", entries: [{ spellId: 111 }] }],
      specNodes: [],
      heroNodes: [{ id: 2, name: "N2", entries: [{ spellId: 222 }] }],
    },
  ];

  test("收集 class/spec/hero 三棵树,并标出来源", () => {
    const u = buildTalentUniverse(specs, {});
    expect(u.get("111")).toEqual({ source: "class", specIds: [105] });
    expect(u.get("222")?.source).toBe("hero");
  });

  test("PvP 天赋池必须并入 —— 节点树里没有它们", () => {
    expect(buildTalentUniverse(specs, {}).has("473909")).toBe(false); // 负控
    expect(
      buildTalentUniverse(specs, { "105": { "473909": "473909" } }).get(
        "473909",
      ),
    ).toEqual({ source: "pvp", specIds: [105] });
  });

  test("同一法术出现在多个专精时合并 specIds", () => {
    const u = buildTalentUniverse(
      [
        { ...specs[0], specId: 105 },
        { ...specs[0], specId: 102 },
      ],
      {},
    );
    expect(u.get("111")?.specIds).toEqual([105, 102]);
  });

  test("真实 PvP 天赋池里确有 473909(正控的上游前提)", () => {
    const ids = new Set(
      Object.values(PVP_TALENT_POOL_GENERATED).flatMap((m) => Object.keys(m)),
    );
    expect(ids.has("473909")).toBe(true);
  });
});

describe("resolvePct", () => {
  const effects = new Map([
    ["373447", new Map([[0, { aura: "87", pts: -5 }]])],
    ["431873", new Map([[0, { aura: "4", pts: -20 }]])],
    ["974", new Map([[2, { aura: "87", pts: 0 }]])],
  ]);

  test("跟随引用到别的法术 —— 数值不在天赋自己身上(主要召回来源)", () => {
    const r = resolvePct(
      "373446",
      "渐隐术会使你受到的伤害降低$373447s1%。",
      effects,
    );
    expect(r.pct).toBe(5);
    // 光环 id 必须是被引用的那个:日志里出现的是它,不是天赋 id
    expect(r.auraSpellId).toBe("373447");
  });

  test("自身占位符 $s1,取绝对值", () => {
    const r = resolvePct(
      "431873",
      "迁跃使受到的伤害降低${$s1/-1}%，效果初始较高。",
      effects,
    );
    expect(r.pct).toBe(20);
    expect(r.auraSpellId).toBe("431873");
  });

  test("大写 $S1 也要认(烈火烙印/钙化尖刺就是这个写法)", () => {
    expect(resolvePct("431873", "使你受到的伤害降低$S1%", effects).pct).toBe(
      20,
    );
  });

  test("字面数字直接采信", () => {
    const r = resolvePct(
      "432992",
      "你从牺牲祝福中受到的伤害降低20%。",
      effects,
    );
    expect(r.pct).toBe(20);
    expect(r.via).toContain("literal");
  });

  test("引用到的效果位是 0 → 记 null 交人裁定,不猜", () => {
    const r = resolvePct("974", "使其受到的伤害降低$s3%", effects);
    expect(r.pct).toBeNull();
    expect(r.via).toContain("not a usable percent");
  });

  test("没有占位符 → null", () => {
    expect(resolvePct("1", "受到的伤害降低$<damage>%", effects).pct).toBeNull();
  });
});

describe("classifyBeneficiary", () => {
  test("宠物受益的不算敌人自身减伤", () => {
    expect(
      classifyBeneficiary("使其受到的伤害减少50%，持续8秒。误导目标为你的宠物"),
    ).toBe("pet");
  });

  test("盟友受益的归 other", () => {
    expect(
      classifyBeneficiary("命令你的宠物保护一名盟友，使其受到的伤害降低15%"),
    ).toBe("pet"); // 宠物优先:这条同时提到宠物与盟友,任一都不是「敌人自身」
    expect(classifyBeneficiary("使小队成员受到的伤害降低10%")).toBe("other");
  });

  test("其余归 self", () => {
    expect(classifyBeneficiary("使你受到的伤害降低30%，持续8秒。")).toBe(
      "self",
    );
  });
});
