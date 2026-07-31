// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

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
// 45–60s:实测门过的窗口(生存类信号,见 task-4 扫描记录)——竞态/busy 测试要
// analyzeWindow 真被调用,不能用 NO_SIGNAL_RANGE(门不过时函数在发 IPC 前就
// 返回了,永远不会调用 analyzeWindow)。
const SIGNAL_RANGE = { fromS: 45, toS: 60 };

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

  it("stale 响应不复活已收起的卡(fix round 1):在飞请求结果落地前用户清了窗口", async () => {
    let resolveAnalyze!: (r: {
      status: "ok";
      text: string;
      chips: never[];
      fromCache: boolean;
    }) => void;
    const analyzeWindow = installFixtureBridge(
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveAnalyze = resolve;
          }),
      ),
    );
    const { getByTestId, queryByTestId, getByRole } = render(
      <MatchReport source={m} matchId="m5" initialTimeRange={SIGNAL_RANGE} />,
    );

    fireEvent.click(getByTestId("window-ai-btn"));
    // 等到 analyzeWindow 真被调用(证明门过了,进入"在飞"阶段)才制造竞态——
    // 这是 stale 响应能出现的唯一时机。
    await waitFor(() => expect(analyzeWindow).toHaveBeenCalledTimes(1));
    expect(queryByTestId("window-ai-card")).toBeTruthy(); // loading 卡还在

    // 用户在结果落地前清窗口:TimeRangeBar 清除按钮 → 收卡 effect 生效。
    fireEvent.click(getByRole("button", { name: "清除" }));
    expect(queryByTestId("window-ai-card")).toBeNull();

    // 先前那次调用现在才 resolve —— 不该把已收起的卡复活。
    await act(async () => {
      resolveAnalyze({
        status: "ok",
        text: "过期结果(不应显示)",
        chips: [],
        fromCache: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByTestId("window-ai-card")).toBeNull();
  });

  it("ok→result(全分支审查补测):有信号窗口,analyzeWindow resolve ok → 结果卡出现、文本渲染、缓存徽标在", async () => {
    const analyzeWindow = installFixtureBridge(
      vi.fn().mockResolvedValue({
        status: "ok",
        text: "这段的可教信号是……",
        chips: [],
        fromCache: true,
      }),
    );
    const { getByTestId, findByTestId } = render(
      <MatchReport source={m} matchId="m7" initialTimeRange={SIGNAL_RANGE} />,
    );
    fireEvent.click(getByTestId("window-ai-btn"));
    await waitFor(() => expect(analyzeWindow).toHaveBeenCalledTimes(1));
    const card = await findByTestId("window-ai-card");
    expect(card.textContent).toContain("这段的可教信号是……");
    expect(card.textContent).toContain("(缓存)");
  });

  it("matchId 变化后到达的响应被丢弃(fix:审计 Critical——ShuffleReport 若无 key 复用同一实例换局,飞行响应只比 fromS/toS 会把上一局结果落到新局页面;此测直接压 isCurrent() 守卫,不依赖 ShuffleReport 是否加了 key)", async () => {
    let resolveAnalyze!: (r: {
      status: "ok";
      text: string;
      chips: never[];
      fromCache: boolean;
    }) => void;
    const analyzeWindow = installFixtureBridge(
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveAnalyze = resolve;
          }),
      ),
    );
    const { getByTestId, queryByTestId, findByTestId, rerender } = render(
      <MatchReport
        source={m}
        matchId="round-A"
        initialTimeRange={SIGNAL_RANGE}
      />,
    );

    fireEvent.click(getByTestId("window-ai-btn"));
    await waitFor(() => expect(analyzeWindow).toHaveBeenCalledTimes(1));
    await findByTestId("window-ai-card"); // loading 卡已出现

    // 同一组件实例被切到另一局(matchId 变了,fromS/toS 未变)——模拟无 key
    // 调用方的场景。
    rerender(
      <MatchReport
        source={m}
        matchId="round-B"
        initialTimeRange={SIGNAL_RANGE}
      />,
    );

    // round-A 的请求这时才 resolve —— 不该把结果落到 round-B 的页面上。
    await act(async () => {
      resolveAnalyze({
        status: "ok",
        text: "round-A 的结果不该出现在 round-B",
        chips: [],
        fromCache: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = queryByTestId("window-ai-card");
    expect(card?.textContent ?? "").not.toContain(
      "round-A 的结果不该出现在 round-B",
    );
  });

  it("busy 终态(fix round 1):可重试,不再原地空转 loading", async () => {
    const analyzeWindow = installFixtureBridge(
      vi.fn().mockResolvedValue({ status: "busy" }),
    );
    const { getByTestId, findByTestId } = render(
      <MatchReport source={m} matchId="m6" initialTimeRange={SIGNAL_RANGE} />,
    );
    fireEvent.click(getByTestId("window-ai-btn"));
    await waitFor(() => expect(analyzeWindow).toHaveBeenCalledTimes(1));
    const card = await findByTestId("window-ai-card");
    expect(card.textContent).toContain("仍在进行中");
    expect(card.querySelector("button")).toBeTruthy(); // 重试
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

  it("busy 态(fix round 1):文案可重试,重试按钮调 onRetry", () => {
    const onRetry = vi.fn();
    const { getByText, getByRole } = render(
      <WindowAnalysisCard
        state={{ phase: "busy" }}
        range={{ fromS: 0, toS: 20 }}
        rich={(t) => t ?? null}
        onJumpT={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(getByText(/仍在进行中/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
