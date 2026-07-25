// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProComparisonVerified } from "./ProComparisonVerified";

const result = {
  verifiedComparison: {
    dims: [
      {
        key: "offensiveIndex",
        value: 0.31,
        p10: 0.2,
        p50: 0.49,
        p90: 0.7,
        percentile: 30,
        verdict: "bottom quartile of your cohort",
      },
    ],
    facts: {},
  },
  report: "You landed 0.31 offense.",
  droppedReason: null,
  cellMeta: {
    spec: "Discipline Priest",
    bracket: "3v3",
    archetype: "hybrid",
    buildGroup: "offensive",
    sampleN: 40,
    fellBackTo: "archetype×buildGroup",
  },
};

beforeEach(() => {
  (window as any).__gladlogFixture = {
    compare: {
      getCached: vi.fn().mockResolvedValue(result),
      run: vi.fn(),
      cancel: vi.fn(),
      onDelta: () => () => {},
      onDone: () => () => {},
      onError: () => () => {},
    },
  };
});

describe("ProComparisonVerified", () => {
  it("renders the cached verified report + per-dim comparison + cohort meta", async () => {
    render(
      <ProComparisonVerified
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    // jest-dom is not installed; getByText/findByText throw if absent, so a
    // truthy assertion on the returned element is a real presence check.
    expect(await screen.findByText(/You landed 0.31 offense/)).toBeTruthy();
    // 维度键经 metricLabels 本地化(默认 zh)
    expect(screen.getAllByText(/进攻输出指数/).length).toBeGreaterThan(0);
    expect(screen.getByText(/offensive build/i)).toBeTruthy(); // build group in meta
  });

  it("P3-1:单维不渲染最强/最弱;zh 判定话术统一;样本 N 场;spec 中文", async () => {
    render(
      <ProComparisonVerified
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    const summary = await screen.findByTestId("cohort-summary");
    expect(summary.textContent).toContain("综合评分");
    expect(summary.textContent).not.toContain("最强");
    // 词表外 verdict(bottom quartile)不再漏成英文:percentile 确定性推导
    expect(screen.getByText("第 30 百分位 · 低于本分档中位")).toBeTruthy();
    expect(screen.queryByText(/bottom quartile/)).toBeNull();
    expect(screen.getByText(/样本 40 场/)).toBeTruthy();
    expect(screen.getByText(/戒律牧师/)).toBeTruthy();
  });
});
