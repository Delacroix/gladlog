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
