import { describe, expect, it } from "vitest";

import talentIdMap from "../data/talentIdMap.json";
import { ensureHeroTalents, heroBuildGroupOf } from "./talents";

/**
 * BACKLOG #37 缺口二: hero-tree membership is the DEFAULT build grouping (user
 * ruling 2026-08-23: 「每个英雄天赋的玩法都是截然不同的」, explicitly for all
 * healers). One shared predicate feeds both the corpus builder
 * (combatToRecords) and the user side (renderer → CompareInput.heroGroup) —
 * two hand-copied derivations is the CLAUDE.md headline failure shape.
 *
 * Data-driven: the expected name comes from the live talentIdMap itself, so a
 * talent-data refresh cannot silently strand the test on stale ids.
 */
describe("heroBuildGroupOf", () => {
  it("resolves a real subtree entry id to its hero tree name", async () => {
    await ensureHeroTalents();
    const entry = (talentIdMap as any[])
      .flatMap((a) => a.subTreeNodes ?? [])
      .flatMap((n: any) => n.entries ?? [])
      .find((e: any) => e?.id && e?.name);
    expect(entry).toBeDefined();
    const group = heroBuildGroupOf([
      { id1: 0, id2: entry.id, count: 1 },
      { id1: 123, id2: 456, count: 1 },
    ]);
    expect(group).toBe(entry.name);
  });

  it("no hero entry / unknown ids → '*' (build-agnostic), never a guess", async () => {
    await ensureHeroTalents();
    expect(heroBuildGroupOf([{ id1: 1, id2: 2, count: 1 }])).toBe("*");
    expect(heroBuildGroupOf([])).toBe("*");
    expect(heroBuildGroupOf(undefined)).toBe("*");
  });
});
