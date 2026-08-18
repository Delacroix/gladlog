import { describe, expect, test } from "vitest";

import { buildTalentUniverse } from "../scripts/datagen/genTalentMitigation";
import { PVP_TALENT_POOL_GENERATED } from "../src/data/pvpTalentPoolGenerated";

/**
 * The universe assembly is the part that actually went wrong during
 * development, so it is the part pinned here: a first pass built the universe
 * from the raidbots node tree only and the positive control (473909 Ancient of
 * Lore, a PvP talent carrying aura 87 = -30) came back missing — which reads
 * exactly like "DB2 has no talent mitigation" rather than "the input universe
 * is short by one source". These tests make that failure mode loud.
 */
describe("buildTalentUniverse", () => {
  const NAMES = {
    "111": "Node Spell",
    "222": "Hero Spell",
    "473909": "Ancient of Lore",
  };

  const specs = [
    {
      specId: 105,
      className: "Druid",
      specName: "Restoration",
      classNodes: [
        { id: 1, name: "N1", entries: [{ spellId: 111, name: "Node Spell" }] },
      ],
      specNodes: [],
      heroNodes: [
        { id: 2, name: "N2", entries: [{ spellId: 222, name: "Hero Spell" }] },
      ],
    },
  ];

  test("收集 class/spec/hero 三棵树的节点法术,并带来源标记", () => {
    const u = buildTalentUniverse(specs, {}, NAMES);
    expect(u.get("111")).toEqual({
      name: "Node Spell",
      source: "class",
      specIds: [105],
    });
    expect(u.get("222")?.source).toBe("hero");
  });

  test("PvP 天赋池必须并入 —— 节点树里没有它们", () => {
    const nodeOnly = buildTalentUniverse(specs, {}, NAMES);
    expect(nodeOnly.has("473909")).toBe(false); // 负控:只用节点树会漏掉

    const withPvp = buildTalentUniverse(
      specs,
      { "105": { "473909": "473909" } },
      NAMES,
    );
    expect(withPvp.get("473909")).toEqual({
      name: "Ancient of Lore",
      source: "pvp",
      specIds: [105],
    });
  });

  test("同一法术出现在多个专精时合并 specIds,不重复", () => {
    const twoSpecs = [
      { ...specs[0], specId: 105 },
      { ...specs[0], specId: 102 },
    ];
    const u = buildTalentUniverse(twoSpecs, {}, NAMES);
    expect(u.get("111")?.specIds).toEqual([105, 102]);
  });

  test("真实 PvP 天赋池里确有 473909(正控的上游前提)", () => {
    const ids = new Set(
      Object.values(PVP_TALENT_POOL_GENERATED).flatMap((m) => Object.keys(m)),
    );
    expect(ids.has("473909")).toBe(true);
  });
});
