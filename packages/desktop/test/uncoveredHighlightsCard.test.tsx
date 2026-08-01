// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { ensureAnalysisData } from "@gladlog/analysis";

import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import { UncoveredHighlightsCard } from "../src/renderer/src/report/components/UncoveredHighlightsCard";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 构包前置契约:prompt 法术名不许降级(同 windowAnalysis.test.tsx)
  await ensureAnalysisData();
});

function installFixtureBridge(analyzeWindow = vi.fn()) {
  (window as any).__gladlogFixture = {
    settings: {
      get: vi.fn().mockResolvedValue({ aiLanguage: "zh" }),
      save: vi.fn().mockResolvedValue({}),
    },
    analysis: {
      // cached:null 且 running:false → StructuredAnalysisPanel 停在空闲态,
      // 不产生 findings —— 未覆盖亮点的去重锚点只来自 mistakesAll(全局
      // derive,不依赖网络/模型),这样点击链路测试是确定性的。
      getState: vi.fn().mockResolvedValue({ cached: null, running: false }),
      getCached: vi.fn().mockResolvedValue(null),
      getFlags: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue([]),
      run: vi.fn(),
      cancel: vi.fn(),
      onDone: () => () => {},
      onError: () => () => {},
      analyzeWindow,
    },
    compare: {
      getCached: vi.fn().mockResolvedValue(null),
      run: vi.fn(),
      cancel: vi.fn(),
      onDelta: () => () => {},
      onDone: () => () => {},
      onError: () => () => {},
    },
  };
  return analyzeWindow;
}

beforeEach(() => {
  installFixtureBridge();
});

describe("UncoveredHighlightsCard 点击链路(BACKLOG #13)", () => {
  it("AI 视图挂载即出现未覆盖亮点卡(真实 fixture:80–90s 是唯一未被 mistakesAll 覆盖的滑窗)", async () => {
    const { findByTestId } = render(
      <MatchReport source={m} matchId="uh-1" initialView="ai" />,
    );
    const btn = await findByTestId("uncovered-highlight-btn-0");
    expect(btn.textContent).toContain("AI 分析此段");
  });

  it("点击【AI 分析此段】=设窗 + 触发 #16 runWindowAi:analyzeWindow 收到该亮点的 fromS/toS,就地出结果卡(不用切战报 tab)", async () => {
    const analyzeWindow = installFixtureBridge(
      vi.fn().mockResolvedValue({
        status: "ok",
        text: "这段的可教信号是……",
        chips: [],
        fromCache: false,
      }),
    );
    const { findByTestId } = render(
      <MatchReport source={m} matchId="uh-2" initialView="ai" />,
    );
    const btn = await findByTestId("uncovered-highlight-btn-0");
    fireEvent.click(btn);

    await waitFor(() => expect(analyzeWindow).toHaveBeenCalledTimes(1));
    const call = analyzeWindow.mock.calls[0]![0];
    expect(call.fromS).toBe(80);
    expect(call.toS).toBe(90);
    expect(call.matchId).toBe("uh-2");

    // 结果卡就地出现在 AI 视图(不依赖切换到「战报」tab)。
    const card = await findByTestId("window-ai-card");
    expect(card.textContent).toContain("这段的可教信号是……");
  });

  it("零亮点(零噪音):UncoveredHighlightsCard 收到空数组时不渲染任何 DOM(干净局/已被充分覆盖的局不该看到空卡)", () => {
    const { container } = render(
      <UncoveredHighlightsCard highlights={[]} onAnalyze={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
