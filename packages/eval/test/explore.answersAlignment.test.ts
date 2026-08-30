// packages/eval/test/explore.answersAlignment.test.ts
import type { CandidateEvent } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";

import {
  joinAnswers,
  renderAlignmentReport,
  summarizeAlignment,
} from "../src/explore/answersAlignment";
import {
  candidateEvidence,
  parseCandidateEvidenceLine,
} from "../src/explore/baselineFindings";
import type {
  ReviewAnswer,
  ReviewAnswers,
  ReviewCard,
  ReviewSession,
} from "../src/explore/reviewTypes";

// ---------------------------------------------------------------------------
// parseCandidateEvidenceLine — pinned as the inverse of candidateEvidence
// ---------------------------------------------------------------------------

describe("parseCandidateEvidenceLine", () => {
  it("round-trips candidateEvidence's rendered line", () => {
    const c = {
      id: "e1",
      type: "position-mistake",
      t: 377.4,
      unitNames: ["Minilay-Illidan-US", "Conquer-BleedingHollow-US"],
      facts: { t: "377", kind: "stayed-in", dist: "3" },
    } as unknown as CandidateEvent;
    const { line } = candidateEvidence(c);
    expect(parseCandidateEvidenceLine(line)).toEqual({
      type: "position-mistake",
      unitNames: ["Minilay-Illidan-US", "Conquer-BleedingHollow-US"],
      facts: { t: "377", kind: "stayed-in", dist: "3" },
    });
  });

  it("round-trips a factless single-unit line", () => {
    const c = {
      id: "e2",
      type: "death",
      t: 488,
      unitNames: ["Minilay-Illidan-US"],
      facts: {},
    } as unknown as CandidateEvent;
    const { line } = candidateEvidence(c);
    expect(parseCandidateEvidenceLine(line)).toEqual({
      type: "death",
      unitNames: ["Minilay-Illidan-US"],
      facts: {},
    });
  });

  it("rejects non-candidate lines (deep cards carry raw query output)", () => {
    expect(parseCandidateEvidenceLine("cd Minilay ready=93 {")).toBeNull();
    expect(parseCandidateEvidenceLine("Ready at 93s: 圣盾术")).toBeNull();
    expect(parseCandidateEvidenceLine("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// joinAnswers / summarizeAlignment
// ---------------------------------------------------------------------------

function card(
  cardId: string,
  source: "deep" | "baseline",
  lines: string[],
): ReviewCard {
  return {
    cardId,
    source,
    claim: "claim",
    anchorT: 10,
    unitNames: [],
    evidence: lines.map((line) => ({
      cmd: "flow --from 5 --to 15",
      line,
      verdict: "verified" as const,
    })),
  };
}

function answer(
  cardId: string,
  over: Partial<ReviewAnswer> = {},
): ReviewAnswer {
  return {
    cardId,
    truth: "true",
    awareness: "knew",
    actionable: "concrete",
    adopt: "maybe",
    impact: "low",
    note: "",
    answeredAt: 1,
    ...over,
  };
}

const session: ReviewSession = {
  schemaVersion: 1,
  name: "s1",
  matchId: "m1",
  createdAt: 1,
  cards: [
    card("c0", "baseline", ["cc-avoidable A {t=10}", "cc-locked A {t=11}"]),
    card("c1", "deep", ["Ready at 93s: 圣盾术"]),
    card("c2", "baseline", ["cc-avoidable B {t=20}"]),
    card("c3", "baseline", ["healing-gap A {t=30}"]),
  ],
};

const answers: ReviewAnswers = {
  schemaVersion: 1,
  name: "s1",
  answers: [
    answer("c0", { adopt: "no", actionable: "non-actionable" }),
    answer("c1", { truth: "partial" }),
    answer("c2", { adopt: "no" }),
    // c3 deliberately unanswered
    answer("c9"), // stale answer with no card — must be dropped
  ],
};

describe("joinAnswers", () => {
  it("joins by cardId, extracts types for baseline cards only, tracks unanswered", () => {
    const { rows, unanswered } = joinAnswers(session, answers);
    expect(unanswered).toEqual(["c3"]);
    expect(rows.map((r) => r.cardId)).toEqual(["c0", "c1", "c2"]);
    expect(rows[0].types).toEqual(["cc-avoidable", "cc-locked"]);
    expect(rows[1].types).toEqual([]); // deep — raw query line never parsed
    expect(rows[2].types).toEqual(["cc-avoidable"]);
  });
});

describe("joinAnswers — evidence-less baseline card falls back to eventTypes (GH #18, 2026-08-30)", () => {
  it("uses the finding's own eventIds types when the bench reproduced no candidate", () => {
    const s: ReviewSession = {
      ...session,
      cards: [
        { ...card("c0", "baseline", []), eventTypes: ["cd-hoarded"] },
        {
          ...card("c1", "baseline", ["cc-avoidable A {t=10}"]),
          eventTypes: ["cc-avoidable", "cc-locked"],
        },
      ],
    };
    const a: ReviewAnswers = {
      schemaVersion: 1,
      name: "s1",
      answers: [answer("c0"), answer("c1")],
    };
    const { rows } = joinAnswers(s, a);
    expect(rows.find((r) => r.cardId === "c0")?.types).toEqual(["cd-hoarded"]);
    // evidence wins when present — eventTypes is only the fallback
    expect(rows.find((r) => r.cardId === "c1")?.types).toEqual([
      "cc-avoidable",
    ]);
  });
});

describe("summarizeAlignment + renderAlignmentReport", () => {
  it("aggregates per source and per type (multi-type card counted under each)", () => {
    const { rows } = joinAnswers(session, answers);
    const summary = summarizeAlignment(rows);
    expect(summary.bySource.baseline.n).toBe(2);
    expect(summary.bySource.deep.n).toBe(1);
    expect(summary.bySource.deep.truth).toEqual({ partial: 1 });
    expect(summary.byType["cc-avoidable"].n).toBe(2);
    expect(summary.byType["cc-avoidable"].adopt).toEqual({ no: 2 });
    expect(summary.byType["cc-locked"].n).toBe(1);

    const report = renderAlignmentReport(summary).join("\n");
    expect(report).toContain("answered cards: 3");
    expect(report).toContain("### cc-avoidable (n=2)");
    expect(report).toContain("adopt: no=2");
  });
});
