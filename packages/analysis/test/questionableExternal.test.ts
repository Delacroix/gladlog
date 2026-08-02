import { questionableExternalEvents } from "../src/analysis/candidateFindings";
import type { IMajorCooldownInfo } from "../src/utils/cooldowns";

/**
 * 17a: the questionable-external candidate mapping (a pure function) — only
 * casts that annotateDefensiveTimings labelled "Unnecessary" (the sixth tier)
 * produce a candidate; facts must be complete (t/spell/caster/target/targetHp/
 * nearestBurstGapS), ids stable, and non-Unnecessary casts produce nothing.
 * nearestBurstGapS is read straight off cast.nearestBurstGapS (computed and
 * stored there by annotateDefensiveTimings); the window geometry is never
 * recomputed here — single-source predicate, see the comments in cooldowns.ts.
 */
describe("questionableExternalEvents", () => {
  const caster = { id: "healer-1", name: "Healy" };

  function cdWith(
    casts: IMajorCooldownInfo["casts"],
  ): Pick<IMajorCooldownInfo, "spellId" | "spellName" | "casts">[] {
    return [
      {
        spellId: "33206",
        spellName: "Pain Suppression",
        casts,
      },
    ];
  }

  it("产出 questionable-external,facts 齐全", () => {
    const cds = cdWith([
      {
        timeSeconds: 42,
        timingLabel: "Unnecessary",
        timingContext: "no pressure",
        targetName: "Ally",
        targetHpPct: 92,
        nearestBurstGapS: 12.3,
      },
    ]);
    const out = questionableExternalEvents(cds, caster);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.type).toBe("questionable-external");
    expect(ev.id).toBe(`questionable-external:${caster.id}:42`);
    expect(ev.t).toBe(42);
    expect(ev.unitNames).toEqual(["Healy", "Ally"]);
    expect(ev.spell).toBe("Pain Suppression");
    expect(ev.spellId).toBe("33206");
    expect(ev.facts).toMatchObject({
      t: expect.any(String),
      spell: "Pain Suppression",
      caster: "Healy",
      target: "Ally",
      targetHp: "92",
      nearestBurstGapS: "12.3",
    });
  });

  it("非 Unnecessary 的 cast 不产出(Optimal/Early/Late/Reactive/Unknown 均不算)", () => {
    const cds = cdWith([
      { timeSeconds: 10, timingLabel: "Optimal" },
      { timeSeconds: 20, timingLabel: "Reactive" },
      { timeSeconds: 30, timingLabel: "Unknown" },
      { timeSeconds: 40 }, // not annotated
    ]);
    expect(questionableExternalEvents(cds, caster)).toEqual([]);
  });

  it("目标名缺失时回退用 caster 自己的名字(不产出 undefined)", () => {
    const cds = cdWith([
      { timeSeconds: 5, timingLabel: "Unnecessary", targetHpPct: 88 },
    ]);
    const out = questionableExternalEvents(cds, caster);
    expect(out[0]!.unitNames).toEqual(["Healy", "Healy"]);
    expect(out[0]!.facts.target).toBe("Healy");
  });

  it("nearestBurstGapS 缺失(annotate 没算出——比如整场没有对齐爆发窗)时落 n/a,不报错", () => {
    const cds = cdWith([
      {
        timeSeconds: 100,
        timingLabel: "Unnecessary",
        targetName: "Ally",
        targetHpPct: 90,
        // no nearestBurstGapS
      },
    ]);
    const out = questionableExternalEvents(cds, caster);
    expect(out[0]!.facts.nearestBurstGapS).toBe("n/a");
  });
});
