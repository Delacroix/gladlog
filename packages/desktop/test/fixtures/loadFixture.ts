import { readFileSync } from "fs";

import type {
  StoredMatch,
  StoredShuffle,
  StoredShuffleRound,
} from "../../src/renderer/src/report/derive/types";

export function loadMatchFixture(): StoredMatch {
  const base = import.meta.url;
  return JSON.parse(
    readFileSync(new URL("report-match.json", base).pathname, "utf-8"),
  ) as StoredMatch;
}

/**
 * A real 3v3 match (Nagrand Arena, a win) — trimmed to the first 90 seconds and
 * anonymized (character names/GUIDs → generic names), with the event arrays
 * rendering does not need (actionsIn/Out, healIn, absorbsIn) and the raw params
 * removed. Used to exercise rendering (meters / timeline / unit details /
 * replay) against real positioning and ability data.
 */
export function loadRealMatchFixture(): StoredMatch {
  const base = import.meta.url;
  return JSON.parse(
    readFileSync(new URL("real-match-sample.json", base).pathname, "utf-8"),
  ) as StoredMatch;
}

/**
 * The real fixture with every absorb-shield aura removed (Power Word: Shield /
 * Ice Barrier).
 *
 * Why it exists (2026-08-13): those two shields became moderate-priority purge
 * targets, so the fixture's enemies now carry several genuinely un-purged
 * shield windows — real findings, verified in the log (a 15.5s PW:S among
 * them). Their anchors legitimately cover the whole sweep, which would silently
 * gut the tests that need an UNCOVERED window to exist at all (the
 * uncovered-highlight card would simply never render). Stripping the shields
 * restores the finding landscape those tests were written against, instead of
 * weakening their assertions or pinning "0 highlights", which would assert
 * nothing.
 */
export function loadRealMatchFixtureWithoutShields(): StoredMatch {
  const m = loadRealMatchFixture() as unknown as {
    units: Record<string, { auraEvents?: Array<{ spellId?: string }> }>;
  };
  const SHIELD_IDS = new Set(["17", "11426"]);
  for (const unit of Object.values(m.units ?? {})) {
    if (!Array.isArray(unit.auraEvents)) continue;
    unit.auraEvents = unit.auraEvents.filter(
      (a) => !SHIELD_IDS.has(String(a.spellId ?? "")),
    );
  }
  return m as unknown as StoredMatch;
}

export function buildSyntheticShuffle(base: StoredMatch): StoredShuffle {
  const rounds: StoredShuffleRound[] = [0, 1, 2].map((i) => ({
    ...base,
    kind: "shuffleRound" as const,
    sequenceNumber: i,
    // no shift: event timestamps are untouched, keeping everything consistent
    startTime: base.startTime,
    endTime: base.endTime,
    winningTeamId: i % 2,
  }));
  return {
    kind: "shuffle",
    rounds,
    startTime: rounds[0]!.startTime,
    endTime: rounds[2]!.endTime,
    result: base.result,
  };
}
