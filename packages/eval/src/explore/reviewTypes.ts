/**
 * Shared type contract for the review workbench: session/card/answer shapes
 * produced by the eval-side converters (`baselineFindings.ts`, a later deep-
 * dive converter) and consumed by the desktop dev harness's review UI.
 *
 * Deliberately dependency-free (types only, no runtime imports) — the desktop
 * dev harness imports this file via a relative path, and per the same
 * zero-Node-dependency lesson `packages/desktop/src/shared/analysisSlots.ts`
 * documents (a Node-only import dragged into a browser bundle broke the
 * renderer build), this module must stay importable from anywhere without
 * pulling in `fs`/`path` or any workspace package.
 */

/** One fact-checking query plus the answer line it produced — `cmd` is the
 * exact `runQuery` argv string (e.g. `"cd --t 93"`), `line` is the rendered
 * output line it points at. */
export interface EvidenceRef {
  cmd: string;
  line: string;
}

/** Input to the (later) deep-dive-round card builder — one claim anchored to
 * a moment, with the evidence that was pulled to check it. */
export interface DeepFindingInput {
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: EvidenceRef[];
  severity: "high" | "med" | "low";
}

/** Outcome of the deterministic prescreen (a later task) for one evidence
 * line: does it support the claim, contradict it, or fail to resolve either
 * way. */
export type PrescreenVerdict = "verified" | "mismatch" | "unverifiable";

/** One reviewable claim: a finding (baseline or deep-dive) rendered as a card
 * with its prescreened evidence, ready for a human reviewer to judge. */
export interface ReviewCard {
  cardId: string;
  source: "deep" | "baseline";
  claim: string;
  anchorT: number;
  unitNames: string[];
  evidence: Array<EvidenceRef & { verdict: PrescreenVerdict }>;
  /** baseline only: candidate types named by the stored finding's own
   * `eventIds` (`candidateTypeOfId`). Present even when `evidence` is empty
   * — the bench's recomputed candidates can miss an id the app produced
   * (2026-08-30: 3 cd-hoarded cards in one session), and the alignment scan
   * must still know the type. */
  eventTypes?: string[];
}

/** A saved batch of cards for one review pass over one match/round. */
export interface ReviewSession {
  schemaVersion: 1;
  name: string;
  matchId: string;
  roundSeq?: number;
  createdAt: number;
  cards: ReviewCard[];
}

/** A human reviewer's judgment on one card. */
export interface ReviewAnswer {
  cardId: string;
  truth: "true" | "partial" | "false" | "cant-tell";
  awareness: "knew" | "vague" | "unaware";
  actionable: "concrete" | "generic" | "non-actionable";
  adopt: "yes" | "maybe" | "no";
  impact: "high" | "med" | "low" | "none";
  note: string;
  answeredAt: number;
}

/** The saved answers for one `ReviewSession` (same `name`, separate file). */
export interface ReviewAnswers {
  schemaVersion: 1;
  name: string;
  answers: ReviewAnswer[];
}
