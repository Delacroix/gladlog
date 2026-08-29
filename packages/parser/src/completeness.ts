import type {
  GladMatch,
  GladMatchBase,
  GladShuffle,
  GladShuffleRound,
} from "./l3/model";

/**
 * Structural completeness of a parsed combat (measure-then-lock, like
 * invariants.ts). `checkParserInvariants` asks whether the *data* is physically
 * sane (monotonic timestamps, HP in range, every event resolves to a line); it
 * would happily pass a Solo Shuffle with five rounds, a 3v3 whose roster has
 * five combatants, or a round in which no kill ever landed in the log. Those
 * are the shapes that reach the AI report looking like a complete match while
 * the coach reasons about a game that was never fully observed.
 *
 * The three checks are the ones arenacoach-desktop's MatchLifecycleService
 * applies before it accepts a match (technique only -- that repo is GPL and
 * nothing is copied): round count, every round has a winner (their
 * "wins + losses must equal rounds"), roster size per bracket. Failing a check
 * marks the combat, it never drops it: the data is still real, the report just
 * has to know it is looking at a partial game.
 */

export type CompletenessCode =
  /** Solo Shuffle did not produce exactly SHUFFLE_ROUND_COUNT rounds. */
  | "shuffle-round-count"
  /** A shuffle round closed without a decisive player death (winner null). */
  | "round-no-winner"
  /** A whole match (2v2/3v3) ended with no winner (no/255 ARENA_MATCH_END). */
  | "match-no-result"
  /** COMBATANT_INFO roster does not match the bracket's team sizes. */
  | "roster-size";

export interface CompletenessIssue {
  code: CompletenessCode;
  /** Shuffle round sequenceNumber the issue belongs to (absent = whole doc). */
  roundSeq?: number;
  detail: string;
}

export const SHUFFLE_ROUND_COUNT = 6;

/** Player count the COMBATANT_INFO roster must have for a bracket; null when
 * the bracket is not one we make a claim about (skirmish/brawl/unknown). Keys
 * are the literal ARENA_MATCH_START bracket strings. */
export const EXPECTED_ROSTER_SIZE: Readonly<Record<string, number>> = {
  "2v2": 4,
  "3v3": 6,
  "Rated Solo Shuffle": 6,
};

export function expectedRosterSize(bracket: string): number | null {
  return EXPECTED_ROSTER_SIZE[bracket] ?? null;
}

/** Roster = Player-kind units that carried a COMBATANT_INFO line. */
export function rosterSize(m: GladMatchBase): number {
  let n = 0;
  // `?? {}`: trimmed fixtures / lazily-loaded docs may carry no units map.
  for (const u of Object.values(m.units ?? {})) {
    if (u.kind === "Player" && u.info) n++;
  }
  return n;
}

function checkRoster(
  m: GladMatchBase,
  roundSeq: number | undefined,
  out: CompletenessIssue[],
): void {
  const expected = expectedRosterSize(m.bracket);
  if (expected === null) return;
  const actual = rosterSize(m);
  if (actual !== expected) {
    out.push({
      code: "roster-size",
      roundSeq,
      detail: `${m.bracket} roster ${actual} ≠ ${expected}`,
    });
  }
}

export function checkStructuralCompleteness(
  doc: GladMatch | GladShuffle,
): CompletenessIssue[] {
  const out: CompletenessIssue[] = [];
  if (doc.kind === "shuffle") {
    const rounds: GladShuffleRound[] = [...doc.rounds].sort(
      (a, b) => a.sequenceNumber - b.sequenceNumber,
    );
    if (rounds.length !== SHUFFLE_ROUND_COUNT) {
      out.push({
        code: "shuffle-round-count",
        detail: `rounds ${rounds.length} ≠ ${SHUFFLE_ROUND_COUNT}`,
      });
    }
    for (const r of rounds) {
      if (r.winningTeamId === null) {
        out.push({
          code: "round-no-winner",
          roundSeq: r.sequenceNumber,
          detail: `round ${r.sequenceNumber} closed without a decisive death`,
        });
      }
      checkRoster(r, r.sequenceNumber, out);
    }
    return out;
  }
  if (doc.result === "Unknown") {
    out.push({
      code: "match-no-result",
      detail: `winningTeamId=${doc.winningTeamId} playerTeamId=${doc.playerTeamId}`,
    });
  }
  checkRoster(doc, undefined, out);
  return out;
}
