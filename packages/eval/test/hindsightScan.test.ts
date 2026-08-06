/**
 * Unit tests for the hindsight-predicate corpus tool's pure core:
 * synthesizePlanted/synthesizeLegit/sampleSynthesis/checkLine. All fs/corpus
 * IO (runSynthesize/runCheck) is deliberately untested here — these tests
 * exercise the same predicate real callers use (hindsightViolations), so a
 * regression in either side shows up as a red test, not a silently-diverged
 * fixture.
 */
import { type CandidateEvent,hindsightViolations } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import {
  checkLine,
  sampleSynthesis,
  synthesizeLegit,
  synthesizePlanted,
} from "../src/quality/hindsightScan";

const mk = (id: string, type: string, t?: number): CandidateEvent => ({
  id,
  type,
  t: t ?? 0,
  unitNames: [],
  facts: t === undefined ? {} : { t: String(t) },
});

// A menu rich enough to exercise every synthesis branch: cross-type far pairs
// (planted), same-type pairs (legit pattern exemption), cross-type near pairs
// (legit cluster), and a whole-round event (no facts.t — legit single ref).
const menu: CandidateEvent[] = [
  mk("a", "kick-eaten", 10),
  mk("b", "cc-locked", 12),
  mk("c", "death", 200),
  mk("d", "wasted-trinket", 45),
  mk("e", "kick-eaten", 300),
  mk("w", "cd-waste"),
];

function byIdFor(events: CandidateEvent[]): Map<string, CandidateEvent> {
  return new Map(events.map((e) => [e.id, e]));
}

describe("synthesizePlanted", () => {
  it("returns at least one planted pair for a rich menu", () => {
    expect(synthesizePlanted(menu).length).toBeGreaterThan(0);
  });

  it("every planted finding trips hindsightViolations", () => {
    const byId = byIdFor(menu);
    for (const item of synthesizePlanted(menu)) {
      expect(hindsightViolations(item.eventIds, byId).length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("synthesizeLegit", () => {
  it("returns at least one legit reference for a rich menu", () => {
    expect(synthesizeLegit(menu).length).toBeGreaterThan(0);
  });

  it("every legit finding passes hindsightViolations clean", () => {
    const byId = byIdFor(menu);
    for (const item of synthesizeLegit(menu)) {
      expect(hindsightViolations(item.eventIds, byId)).toEqual([]);
    }
  });
});

describe("sampleSynthesis", () => {
  it("caps each bucket at the limit and folds matchId/ordinal across menus", () => {
    const menus = [
      { matchId: "m1", ordinal: 1, candidates: menu },
      { matchId: "m2", ordinal: 2, candidates: menu },
    ];
    const { planted, legit } = sampleSynthesis(menus, 3);
    expect(planted.length).toBeLessThanOrEqual(3);
    expect(legit.length).toBeLessThanOrEqual(3);
    expect(planted.length).toBeGreaterThan(0);
    for (const item of [...planted, ...legit]) {
      expect(["m1", "m2"]).toContain(item.matchId);
    }
  });

  it("reports the honest (smaller) count when the corpus can't fill the limit", () => {
    const sparse = [mk("x", "death", 5), mk("y", "cc-locked", 200)];
    const menus = [{ matchId: "m1", ordinal: 1, candidates: sparse }];
    const { planted } = sampleSynthesis(menus, 20);
    // exactly one cross-type far pair is available — no over- or under-count
    expect(planted).toHaveLength(1);
  });
});

describe("checkLine", () => {
  it("runs the predicate against a self-contained {eventIds, candidates} line", () => {
    const line = {
      eventIds: ["a", "c"],
      candidates: [mk("a", "kick-eaten", 10), mk("c", "death", 200)],
    };
    expect(checkLine(line).length).toBeGreaterThan(0);
  });

  it("passes clean for a same-type line", () => {
    const line = {
      eventIds: ["a", "e"],
      candidates: [mk("a", "kick-eaten", 10), mk("e", "kick-eaten", 300)],
    };
    expect(checkLine(line)).toEqual([]);
  });
});
