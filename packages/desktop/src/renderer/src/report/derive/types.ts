import type { GladMatch, GladShuffle, GladShuffleRound } from "@gladlog/parser";

export type StoredMatch = Omit<GladMatch, "rawLines">;
export type StoredShuffleRound = Omit<GladShuffleRound, "rawLines">;
export type StoredShuffle = Omit<GladShuffle, "rawLines" | "rounds"> & {
  rounds: StoredShuffleRound[];
};
/** Input for a single match report: a regular match or one shuffle round
 *  (isomorphic) */
export type ReportSource = StoredMatch | StoredShuffleRound;
