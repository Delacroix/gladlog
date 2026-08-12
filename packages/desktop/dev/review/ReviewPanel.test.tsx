// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
import type {
  ReviewAnswer,
  ReviewCard,
  ReviewSession,
} from "../../../eval/src/explore/reviewTypes";

// session 复用 summary.test 的构造思路:2 卡(deep, baseline),evidence 各 1 条
// verdict: "verified" — the verdict/source must never surface until every
// card in the session is answered (the blind-review invariant under test).
const card = (cardId: string, source: "deep" | "baseline"): ReviewCard => ({
  cardId,
  source,
  claim: `claim for ${cardId}`,
  anchorT: 10,
  unitNames: [],
  evidence: [
    { cmd: "cd --t 10", line: `evidence line ${cardId}`, verdict: "verified" },
  ],
});

const twoCardSession: ReviewSession = {
  schemaVersion: 1,
  name: "s",
  matchId: "m",
  createdAt: 1,
  cards: [card("c0", "deep"), card("c1", "baseline")],
};

const ans = (
  cardId: string,
  over: Partial<ReviewAnswer> = {},
): ReviewAnswer => ({
  cardId,
  truth: "true",
  awareness: "knew",
  actionable: "concrete",
  adopt: "yes",
  impact: "low",
  note: "",
  answeredAt: 1,
  ...over,
});

const fullAnswersForBoth: ReviewAnswer[] = [ans("c0"), ans("c1")];

describe("ReviewPanel", () => {
  it("gates 下一张 on all five answers and reports the answer", () => {
    const onSave = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={onSave}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy();
    const next = screen.getByRole("button", { name: "下一张" });
    expect(next).toHaveProperty("disabled", true);
    for (const label of ["属实", "知道", "有具体动作", "会", "中"])
      fireEvent.click(screen.getByRole("button", { name: label }));
    expect(next).toHaveProperty("disabled", false);
    fireEvent.click(next);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0].cardId).toBe(
      twoCardSession.cards[0].cardId,
    );
  });

  it("seeks on anchor chip click and hides source until finished", () => {
    const onSeek = vi.fn();
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={[]}
        onSave={() => {}}
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByText("0:10")); // fmtTime(anchorT)
    expect(onSeek.mock.calls[0][0].cardId).toBe(twoCardSession.cards[0].cardId);
    expect(screen.queryByText(/深挖|baseline|deep/)).toBeNull(); // 盲评期间无来源徽章
  });

  it("shows reveal summary with source badges after all cards answered", () => {
    render(
      <ReviewPanel
        session={twoCardSession}
        answers={fullAnswersForBoth}
        onSave={() => {}}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/验真新发现/)).toBeTruthy();
    expect(screen.getAllByText(/深挖|现有管线/).length).toBeGreaterThan(0);
  });
});
