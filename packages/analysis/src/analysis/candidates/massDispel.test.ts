import { CombatUnitClass } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import type { ICrisisMoment } from "./cooldownTiming";
import {
  type ICycloneHit,
  type IStrategicHolder,
  MD_FOLLOWUP_GRACE_S,
  mdCycloneWindowEvents,
} from "./massDispel";

/**
 * md-cyclone-window (GH #25, user-ruled four-gate criterion 2026-08-21):
 * every gate gets a passing case and a negative control, so no gate can
 * silently no-op. The domain red line under test: DEFAULT IS SILENCE — a
 * single missing gate must produce zero candidates.
 */

const PRIEST = { id: "p1", name: "Priest", class: CombatUnitClass.Priest };
const CHAIN_GAP_S = 16; // pre-12.1 drResetMsAt / 1000

const crisisAt = (moment: ICrisisMoment | null) => (): ICrisisMoment | null =>
  moment;
const noAttempt = (): string | null => null;

function fire(over: {
  owner?: typeof PRIEST;
  hits?: ICycloneHit[];
  mdCasts?: number[];
  strategics?: IStrategicHolder[];
  crisis?: ICrisisMoment | null;
  attempt?: (fromS: number, toS: number) => string | null;
}) {
  return mdCycloneWindowEvents({
    owner: over.owner ?? PRIEST,
    cycloneHits: over.hits ?? [
      { atS: 100, targetName: "AllyA" },
      { atS: 106, targetName: "AllyB" },
    ],
    ownerMdCastSeconds: over.mdCasts ?? [],
    enemyStrategics: over.strategics ?? [],
    chainGapS: CHAIN_GAP_S,
    probes: {
      crisisMomentAt: crisisAt(
        over.crisis === undefined
          ? { t: 104, unitName: "AllyA", hpPct: 28 }
          : over.crisis,
      ),
      enemyAttemptOverlapping: over.attempt ?? noAttempt,
    },
  });
}

describe("mdCycloneWindowEvents — happy path", () => {
  it("2-hit chain + crisis pressure + empty strategic list + MD ready → one candidate with citable facts", () => {
    const events = fire({});
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe("md-cyclone-window");
    expect(e.t).toBe(106); // second landing = the moment the chain became a chain
    expect(e.facts.windowFromT).toBe("100");
    expect(e.facts.windowToT).toBe("111"); // last landing 106 + official 5s
    expect(e.facts.cycloneHits).toBe("2");
    expect(e.facts.targets).toBe("AllyA, AllyB");
    expect(e.facts.pressure).toContain("28%");
    expect(e.facts.strategicImmunities).toBe("none in enemy comp");
    expect(e.unitNames[0]).toBe("Priest");
  });

  it("kill-attempt pressure qualifies without any crisis", () => {
    const events = fire({
      crisis: null,
      attempt: (from, to) =>
        from <= 106 && to >= 106 ? "kill attempt on AllyB at 106s" : null,
    });
    expect(events).toHaveLength(1);
    expect(events[0].facts.pressure).toBe("kill attempt on AllyB at 106s");
  });
});

describe("gate 1 — chain", () => {
  it("a single hit never fires", () => {
    expect(fire({ hits: [{ atS: 100, targetName: "AllyA" }] })).toEqual([]);
  });
  it("two hits farther apart than the DR-chain gap are two 1-hit chains → silent", () => {
    expect(
      fire({
        hits: [
          { atS: 100, targetName: "AllyA" },
          { atS: 100 + CHAIN_GAP_S + 1, targetName: "AllyB" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("gate 2 — pressure", () => {
  it("no attempt and crisis above CD_HOARD_CRISIS_HP_PCT → silent", () => {
    expect(fire({ crisis: { t: 104, unitName: "AllyA", hpPct: 40 } })).toEqual(
      [],
    );
  });
  it("no attempt and no crisis sample at all → silent", () => {
    expect(fire({ crisis: null })).toEqual([]);
  });
});

describe("gate 3 — strategic reserve (the red line)", () => {
  const mageNeverBlocked: IStrategicHolder = {
    unitName: "EnemyMage",
    spellId: "45438",
    castSeconds: [],
  };
  it("an enemy mage who never cast Ice Block → silent (they may be holding it)", () => {
    expect(fire({ strategics: [mageNeverBlocked] })).toEqual([]);
  });
  it("Ice Block spent before the window and down through it → fires", () => {
    const events = fire({
      strategics: [
        { unitName: "EnemyMage", spellId: "45438", castSeconds: [50] },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].facts.strategicImmunities).toContain(
      "EnemyMage's Ice Block spent at 50s",
    );
  });
  it("Ice Block cast so long ago it is back up mid-window → silent", () => {
    // charge cooldown 240s: cast at 50 covers windows ending before 290;
    // a chain at 300s is outside that cover.
    expect(
      fire({
        hits: [
          { atS: 300, targetName: "AllyA" },
          { atS: 306, targetName: "AllyB" },
        ],
        crisis: { t: 304, unitName: "AllyA", hpPct: 28 },
        strategics: [
          { unitName: "EnemyMage", spellId: "45438", castSeconds: [50] },
        ],
      }),
    ).toEqual([]);
  });
  it("one of two strategics unspent → silent (ALL must be moot)", () => {
    expect(
      fire({
        strategics: [
          { unitName: "EnemyMage", spellId: "45438", castSeconds: [50] },
          { unitName: "EnemyPala", spellId: "642", castSeconds: [] },
        ],
      }),
    ).toEqual([]);
  });
});

describe("gate 4 — available", () => {
  it("MD cast 60s before the window (inside the official 120s CD) → silent", () => {
    expect(fire({ mdCasts: [40] })).toEqual([]);
  });
  it("MD cast 130s before the window (off cooldown again) → fires", () => {
    expect(fire({ mdCasts: [-30] })).toHaveLength(1);
  });
  it("MD pressed during the window → silent (they did the thing)", () => {
    expect(fire({ mdCasts: [108] })).toEqual([]);
  });
  it("MD pressed within the follow-up grace after the window → silent (saved for an imminent use)", () => {
    expect(fire({ mdCasts: [111 + MD_FOLLOWUP_GRACE_S - 1] })).toEqual([]);
  });
  it("MD pressed after the grace elapses → fires", () => {
    expect(fire({ mdCasts: [111 + MD_FOLLOWUP_GRACE_S + 1] })).toHaveLength(1);
  });
  it("a chain entirely on the owner themself → silent (no dispellable teammate; S2 scan regression)", () => {
    // 106.5 lands AFTER the floored chain moment (106), so the owner is not
    // "currently cycloned" at tS — this pins the teammate-hit gate itself,
    // not the self-cycloned exclusion above it.
    expect(
      fire({
        hits: [
          { atS: 100, targetName: "Priest" },
          { atS: 106.5, targetName: "Priest" },
        ],
      }),
    ).toEqual([]);
  });
  it("the owner themselves cycloned at the chain moment → silent (cannot press)", () => {
    expect(
      fire({
        hits: [
          { atS: 100, targetName: "AllyA" },
          { atS: 106, targetName: "Priest" },
        ],
      }),
    ).toEqual([]);
  });
  it("a non-priest owner never fires", () => {
    expect(
      fire({
        owner: { id: "p1", name: "Pala", class: CombatUnitClass.Paladin },
      }),
    ).toEqual([]);
  });
});

describe("cap", () => {
  it("two qualifying chains → only the strongest (more landings) survives", () => {
    const events = fire({
      hits: [
        { atS: 100, targetName: "AllyA" },
        { atS: 106, targetName: "AllyB" },
        // second chain, 3 landings, well past the gap
        { atS: 200, targetName: "AllyA" },
        { atS: 206, targetName: "AllyB" },
        { atS: 212, targetName: "AllyA" },
      ],
      crisis: { t: 104, unitName: "AllyA", hpPct: 28 },
      attempt: () => "kill attempt on AllyA",
    });
    expect(events).toHaveLength(1);
    expect(events[0].facts.cycloneHits).toBe("3");
  });
});
