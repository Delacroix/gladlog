// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { ensureAnalysisData } from "@gladlog/analysis";

import { MatchReport } from "../src/renderer/src/report/components/MatchReport";
import { buildWindowAnalysisRequest } from "../src/renderer/src/report/derive/analysisInput";
import { WindowAnalysisCard } from "../src/renderer/src/report/components/WindowAnalysisCard";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 构包前置契约:prompt 法术名不许降级(同 analysisInput.test.ts)。
  await ensureAnalysisData();
});

function installFixtureBridge(analyzeWindow = vi.fn()) {
  (window as any).__gladlogFixture = {
    settings: {
      get: vi.fn().mockResolvedValue({ aiLanguage: "zh" }),
      save: vi.fn().mockResolvedValue({}),
    },
    analysis: {
      getState: vi.fn().mockResolvedValue({ cached: null, running: false }),
      getCached: vi.fn().mockResolvedValue(null),
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

// 20–35s:实测门不过的干净窗口(生存/进攻两门皆空)——90s 裁剪 fixture 无玩家
// 死亡,但仍有可教 CC/防御信号(如 47–58s 附近的硬控饰品未交),不是任意窗口
// 都为 null;20–35s 是其中一段确定性验证过的空窗(见 task-4 实现记录)。
const NO_SIGNAL_RANGE = { fromS: 20, toS: 35 };

describe("buildWindowAnalysisRequest(#16 选段分析)", () => {
  it("真实 fixture 干净窗口(20–35s)→ null(门不过),不抛", () => {
    expect(() =>
      buildWindowAnalysisRequest(m, NO_SIGNAL_RANGE.fromS, NO_SIGNAL_RANGE.toS),
    ).not.toThrow();
    expect(
      buildWindowAnalysisRequest(m, NO_SIGNAL_RANGE.fromS, NO_SIGNAL_RANGE.toS),
    ).toBeNull();
  });
});

describe("MatchReport【AI 分析此段】按钮", () => {
  it("无 timeRange → 无按钮;有 initialTimeRange → 按钮出现", () => {
    const noRange = render(<MatchReport source={m} matchId="m1" />);
    expect(noRange.queryByTestId("window-ai-btn")).toBeNull();

    const withRange = render(
      <MatchReport
        source={m}
        matchId="m2"
        initialTimeRange={{ fromS: 36, toS: 59 }}
      />,
    );
    expect(withRange.queryByTestId("window-ai-btn")).toBeTruthy();
  });

  it("点击按钮(fixture 门不过)→ 出「未检出可教信号」卡,不调用 analyzeWindow", async () => {
    const analyzeWindow = installFixtureBridge();
    const { getByTestId, findByTestId } = render(
      <MatchReport
        source={m}
        matchId="m3"
        initialTimeRange={NO_SIGNAL_RANGE}
      />,
    );
    fireEvent.click(getByTestId("window-ai-btn"));
    const card = await findByTestId("window-ai-card");
    expect(card.textContent).toContain("未检出可教信号");
    expect(analyzeWindow).not.toHaveBeenCalled();
  });

  it("窗口 onChange(TimeRangeBar 清除)→ 卡收起", async () => {
    const { getByTestId, findByTestId, queryByTestId, getByRole } = render(
      <MatchReport
        source={m}
        matchId="m4"
        initialTimeRange={NO_SIGNAL_RANGE}
      />,
    );
    fireEvent.click(getByTestId("window-ai-btn"));
    await findByTestId("window-ai-card");
    fireEvent.click(getByRole("button", { name: "清除" }));
    expect(queryByTestId("window-ai-card")).toBeNull();
  });
});

describe("WindowAnalysisCard 单测", () => {
  it("result 态:text 经 rich 注入渲染,chips 点击调 onJumpT", () => {
    const onJumpT = vi.fn();
    const rich = (t?: string | null) => (t ? `RICH(${t})` : null);
    const { getByText, getByTitle } = render(
      <WindowAnalysisCard
        state={{
          phase: "result",
          text: "示例正文",
          chips: [
            {
              t: 12,
              label: "冰霜新星",
              unitNames: ["法师-测试"],
              spellId: "122",
            },
          ],
          fromCache: true,
        }}
        range={{ fromS: 0, toS: 20 }}
        rich={rich}
        onJumpT={onJumpT}
        onRetry={() => {}}
      />,
    );
    expect(getByText("RICH(示例正文)")).toBeTruthy();
    fireEvent.click(getByTitle("冰霜新星"));
    expect(onJumpT).toHaveBeenCalledWith(12, ["法师-测试"]);
  });

  it("audit-empty 态:重试按钮调 onRetry", () => {
    const onRetry = vi.fn();
    const { getByRole } = render(
      <WindowAnalysisCard
        state={{ phase: "audit-empty" }}
        range={{ fromS: 0, toS: 20 }}
        rich={(t) => t ?? null}
        onJumpT={() => {}}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
