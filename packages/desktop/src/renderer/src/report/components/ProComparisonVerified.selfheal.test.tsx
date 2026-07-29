// @vitest-environment jsdom
//
// Finding 1(全分支审查):`rich` 的 useMemo 只依赖 [source, lang],若求值时
// 12MB spellNames 表还没载完(englishNameIndex() === null),该场对比解说
// 永远降级为纯文本 —— 违反 ensure 契约「展示路径下次渲染自愈」。修法照抄
// StructuredAnalysisPanel 的 dataReady 三行模式。本测试用 vi.mock 控制
// analysisDataReady/ensureAnalysisData/englishNameIndex 的时序(不依赖真实
// 12MB 表加载的微任务时序,确定性复现"未载完→自愈"两段状态)。
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({
  ready: false,
  resolveEnsure: null as (() => void) | null,
}));

vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    analysisDataReady: () => mockState.ready,
    ensureAnalysisData: () =>
      new Promise<void>((resolve) => {
        mockState.resolveEnsure = () => {
          mockState.ready = true;
          resolve();
        };
      }),
    // 表未载完时真实实现返回 null(见 spellNameLookup.ts);这里直接控制
    // 而不是等真实 JSON 动态 import,时序确定。
    englishNameIndex: () =>
      mockState.ready ? new Map([["Tranquility", ["740"]]]) : null,
  };
});

// 必须在 vi.mock 之后 import,拿到打了桩的模块图。
import { ProComparisonVerified } from "./ProComparisonVerified";

const result = {
  verifiedComparison: { dims: [], facts: {} },
  report: "You should use Tranquility earlier in the fight.",
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
  mockState.ready = false;
  mockState.resolveEnsure = null;
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

describe("ProComparisonVerified rich memo 自愈(dataReady 门)", () => {
  it("表未载完时纯文本展示;载完后下次渲染自动补内联图标,不需重开组件", async () => {
    const { container } = render(
      <ProComparisonVerified
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/Tranquility/);
    // 首次求值:dataReady=false → englishNameIndex() null → 纯文本降级
    expect(container.querySelector('[title="Tranquility"]')).toBeNull();

    // 表载完:ensureAnalysisData resolve → dataReady 翻真 → memo 重算
    await act(async () => {
      mockState.resolveEnsure?.();
      await Promise.resolve();
    });

    expect(container.querySelector('[title="Tranquility"]')).not.toBeNull();
  });
});
