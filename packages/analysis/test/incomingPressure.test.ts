import { describe, it, expect } from "vitest";
import { CombatUnitReaction, CombatUnitSpec } from "@gladlog/parser-compat";

import {
  incomingPressureEvents,
  sumIncomingPressure,
  sumAbsorbedPressure,
} from "../src/utils/incomingPressure";
import { computePressureWindows } from "../src/utils/cooldowns";
import { makeUnit } from "./ported/testHelpers";

const dmg = (t: number, amount: number) =>
  ({
    logLine: { event: "SPELL_DAMAGE", timestamp: t, parameters: [] },
    timestamp: t,
    amount: -amount,
    effectiveAmount: -amount,
    spellId: "50622",
    spellName: "Bladestorm",
    srcUnitId: "enemy-1",
  }) as never;

const abs = (t: number, amount: number) =>
  ({
    logLine: { event: "SPELL_ABSORBED", timestamp: t, parameters: [] },
    timestamp: t,
    absorbedAmount: amount,
    spellId: "17",
    spellName: "Power Word: Shield",
    srcUnitId: "healer-1",
    attackerId: "enemy-1",
  }) as never;

describe("incomingPressure — the single predicate for incoming pressure", () => {
  it("merges damage taken and damage absorbed into one time-ordered list", () => {
    const unit = makeUnit("victim", {
      damageIn: [dmg(3000, 500), dmg(1000, 100)],
      absorbsIn: [abs(2000, 300)],
    });
    const events = incomingPressureEvents(unit);
    expect(events.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);
    expect(events.map((e) => e.amount)).toEqual([100, 300, 500]);
    expect(events.map((e) => e.isAbsorb)).toEqual([false, true, false]);
  });

  it("reports positive magnitudes, unlike damageIn's negative effectiveAmount", () => {
    const unit = makeUnit("victim", { damageIn: [dmg(1000, 100)] });
    expect(unit.damageIn[0]!.effectiveAmount).toBe(-100);
    expect(incomingPressureEvents(unit)[0]!.amount).toBe(100);
  });

  it("attributes an absorb to the attacker, not to the shield's owner", () => {
    const unit = makeUnit("victim", { absorbsIn: [abs(1000, 300)] });
    expect(incomingPressureEvents(unit)[0]!.srcUnitId).toBe("enemy-1");
  });

  it("sums respect the window bounds, inclusive", () => {
    const unit = makeUnit("victim", {
      damageIn: [dmg(1000, 100), dmg(5000, 700)],
      absorbsIn: [abs(2000, 300)],
    });
    expect(sumIncomingPressure(unit, 1000, 2000)).toBe(400);
    expect(sumAbsorbedPressure(unit, 1000, 2000)).toBe(300);
    expect(sumIncomingPressure(unit, 0, 10_000)).toBe(1100);
  });

  it("drops NaN and non-positive absorbs rather than poisoning the sum", () => {
    const unit = makeUnit("victim", {
      damageIn: [dmg(1000, NaN), dmg(2000, 100)],
      absorbsIn: [abs(3000, 0)],
    });
    expect(incomingPressureEvents(unit)).toHaveLength(1);
    expect(sumIncomingPressure(unit, 0, 10_000)).toBe(100);
  });

  it("computePressureWindows counts absorbs — a fully shielded burst is pressure", () => {
    // Nothing but absorbs: damageIn is empty, so the old damageIn-only
    // predicate produced no window at all.
    const shielded = makeUnit("victim", {
      name: "Victim",
      spec: CombatUnitSpec.Priest_Discipline,
      reaction: CombatUnitReaction.Friendly,
      absorbsIn: [abs(1000, 400_000), abs(2000, 400_000)],
    });
    const windows = computePressureWindows([shielded], {
      startTime: 0,
    } as never);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.totalDamage).toBe(800_000);
    expect(windows[0]!.targetName).toBe("Victim");
  });
});
