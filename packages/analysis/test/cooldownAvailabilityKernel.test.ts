/**
 * BACKLOG #21 item2 (drift prevention for "the gate predicate is the spec"):
 * this package has two cooldown-availability predicates -- `cdAvailableAt`
 * (cooldowns.ts, reading the already-resolved IMajorCooldownInfo.casts ledger)
 * and `isAvailableAt` (deathOutcomeAnalysis.ts, reading raw
 * unit.spellCastEvents plus an extra resetSpellIds reset expansion). Their data
 * sources differ and they are deliberately not fully unified (see the comments
 * in each file), but the core algorithm -- "available if there is no usage
 * record; otherwise check whether last use + cooldown has reached t" -- is
 * factored into the shared `isCooldownAvailableFromLastUse` that both call.
 *
 * This test guards on two levels:
 * 1. It tests the shared algorithmic kernel's boundary behavior directly.
 * 2. Assert-equal: for exactly corresponding synthetic inputs (no reset spells,
 *    identical cast history), cdAvailableAt and isAvailableAt must reach the
 *    same boolean conclusion -- if either side ever reverts the core criterion
 *    to a locally hand-written formula, this fails the moment it diverges from
 *    the shared kernel's semantics.
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
    // Follow-up round fix (2026-07-31): isAvailableAt used to take Math.max
    // over every cast of the spellId in the whole match without truncating at
    // atSeconds -- so if the unit cast it again after the query time (450s vs a
    // query at 400s), that future cast was mistaken for the "last use" and a
    // moment that should have been available (one use at 0s, 300s cooldown, so
    // long since ready at 400s) was reported unavailable. Before the fix this
    // scenario failed (viaIsAvailableAt=false, viaCdAvailableAt=true).
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
