import { describe, expect, it } from "vitest";

import type { DecisionPoint } from "../crisisDecisionPoints";
import {
  CRISIS_NO_RESPONSE_CAP,
  crisisNoResponseEvents,
} from "./crisisNoResponse";

const pt = (over: Partial<DecisionPoint> = {}): DecisionPoint => ({
  tMs: 0,
  tSec: 72.4,
  hpPct: 38,
  dmg2s: 0.25,
  attackers2s: 2,
  enemyBurst: true,
  inCC: false,
  lockedOut: false,
  diedInWindow: false,
  responses: {
    selfHeal: false,
    wall: false,
    external: false,
    control: false,
    peel: false,
    kite: false,
  },
  responded: false,
  selfHealPct: 0,
  feasible: true,
  ...over,
});
const ref = {
  cellKey: "3v3|healer|>=20%",
  n: 81,
  respondPct: 88,
  top: [
    ["selfHeal", 76],
    ["wall", 36],
    ["control", 16],
  ] as [string, number][],
  selfHealMedianPct: 37,
  fellBack: false,
};
const probes = { lookup: () => ref };
const owner = { id: "H", name: "Heals-R" };

describe("crisis-no-response", () => {
  it("fires for a feasible, unanswered crossing with the reference facts", () => {
    const ev = crisisNoResponseEvents([pt()], owner, "3v3", probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("crisis-no-response");
    expect(ev[0]!.id).toBe("crisis-no-response:H:72");
    expect(ev[0]!.facts).toEqual({
      t: "72.4",
      unit: "Heals-R",
      hpPct: "38",
      dmg2sPct: "25",
      attackers: "2",
      burst: "yes",
      refN: "81",
      refRespond: "88",
      refTop: "selfHeal 76%; wall 36%; control 16%",
      refSelfHealMedian: "37",
      cellKey: "3v3|healer|>=20%",
      fellBack: "no",
    });
  });
  it("silent when the owner responded", () => {
    expect(
      crisisNoResponseEvents([pt({ responded: true })], owner, "3v3", probes),
    ).toEqual([]);
  });
  it("silent when any feasibility gate failed", () => {
    expect(
      crisisNoResponseEvents([pt({ feasible: false })], owner, "3v3", probes),
    ).toEqual([]);
  });
  it("silent when no reference exists for the bracket (never accuse without a baseline)", () => {
    expect(
      crisisNoResponseEvents([pt()], owner, "Skirmish", { lookup: () => null }),
    ).toEqual([]);
  });
  it("caps at 2 per round selected by danger (never by outcome), emitted in time order", () => {
    const pts = [
      pt({ tSec: 10, enemyBurst: false, attackers2s: 1, dmg2s: 0.05 }),
      pt({ tSec: 20, enemyBurst: true, attackers2s: 1, dmg2s: 0.1 }),
      pt({ tSec: 30, enemyBurst: false, attackers2s: 3, dmg2s: 0.4 }),
      pt({ tSec: 40, enemyBurst: true, attackers2s: 2, dmg2s: 0.3 }),
    ];
    const ev = crisisNoResponseEvents(pts, owner, "3v3", probes);
    expect(ev.map((e) => e.facts.t)).toEqual(["20", "40"]);
    expect(CRISIS_NO_RESPONSE_CAP).toBe(2);
  });
  it("emitted events are returned in time order", () => {
    const ev = crisisNoResponseEvents(
      [
        pt({ tSec: 50, enemyBurst: true }),
        pt({ tSec: 5, enemyBurst: true, attackers2s: 3 }),
      ],
      owner,
      "3v3",
      probes,
    );
    expect(ev.map((e) => e.t)).toEqual([5, 50]);
  });
});
