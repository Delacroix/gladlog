// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StructuredAnalysisPanel } from "./StructuredAnalysisPanel";
import { slotLabel } from "../derive/slotLabel";

const result = {
  findings: [
    {
      eventIds: ["e1"],
      severity: "high",
      category: "survival",
      // 中文纯文本(不含 ASCII 单词):#15 内联图标接线后,英文占位词可能
      // 与真实法术名表(41 万条)撞车被意外包裹(如 "Death"/单字母 "s"
      // 均是真实存在的法术名)——纯中文对该匹配路径天然免疫。
      title: "死亡",
      explanation: "第30秒阵亡。",
    },
  ],
  dropped: 0,
  hadNarration: true,
};

beforeEach(() => {
  (window as any).__gladlogFixture = {
    settings: {
      get: vi.fn().mockResolvedValue({ aiLanguage: "zh" }),
      save: vi.fn().mockResolvedValue({}),
    },
    analysis: {
      // 面板重挂走 getState(缓存 + running 一次原子读出);getCached 仍保留在
      // 桩上,语言切换用例断言的是「重查缓存」这件事本身。
      // 单槽(slots.length===1):tab 条不应渲染 —— 与「多槽 tab 切换」用例对照。
      getState: vi.fn().mockResolvedValue({
        cached: result,
        running: false,
        slots: [
          { key: "anthropic:claude-sonnet-5", createdAt: 1, stale: false },
        ],
        activeKey: "anthropic:claude-sonnet-5",
      }),
      getCached: vi.fn().mockResolvedValue(result),
      run: vi.fn(),
      cancel: vi.fn(),
      onDone: () => () => {},
      onError: () => () => {},
    },
  };
});

describe("StructuredAnalysisPanel", () => {
  it("renders cached findings", async () => {
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    expect(await screen.findByText(/第30秒阵亡/)).toBeTruthy();
    // 单槽:tab 条不渲染(≥2 槽才显示)。
    expect(screen.queryByTestId("analysis-slot-tabs")).toBeNull();
  });

  it("语言切换:点 EN 持久化 aiLanguage 并重查缓存(backlog #1)", async () => {
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    const fx = (window as any).__gladlogFixture;
    const callsBefore = fx.analysis.getState.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    await screen.findByText(/第30秒阵亡/); // 重查后重新渲染
    expect(fx.settings.save).toHaveBeenCalledWith({ aiLanguage: "en" });
    expect(fx.analysis.getState.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("本场目标(D3 教练闭环)", () => {
  it("aggregate 有「还在犯」分类时渲染目标卡,按 recurring 降序取 top", async () => {
    const fx = (window as any).__gladlogFixture;
    fx.analysis.aggregate = vi.fn().mockResolvedValue([
      {
        category: "survival",
        count: 5,
        recurring: 2,
        done: 1,
        recent: [
          { matchId: "x", title: "开怕晚了", severity: "high", createdAt: 2 },
        ],
      },
      { category: "positioning", count: 3, recurring: 0, done: 3, recent: [] },
      {
        category: "cd",
        count: 4,
        recurring: 4,
        done: 0,
        recent: [
          {
            matchId: "y",
            title: "壁垒全场没按",
            severity: "med",
            createdAt: 1,
          },
        ],
      },
    ]);
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    const card = await screen.findByTestId("ai-goals");
    // category 走渲染侧词表(cd 别名归一 → 冷却使用)
    expect(card.textContent).toContain("↻4 冷却使用");
    expect(card.textContent).toContain("↻2 生存");
    expect(card.textContent).toContain("壁垒全场没按");
    // recurring=0 的分类不出现
    expect(card.textContent).not.toContain("positioning");
    expect(card.textContent).not.toContain("站位");
  });

  it("桩无 aggregate 面时不渲染、不崩(旧行为兼容)", async () => {
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    expect(screen.queryByTestId("ai-goals")).toBeNull();
  });
});

describe("getFlags 竞态守卫(周度复核 新#2)", () => {
  it("快速切场时,先发后到的旧场 flags 不会盖到当前场上", async () => {
    const { findingKey } = await import("../../../../shared/findingKey");
    const key = findingKey(result.findings[0] as never);
    const fx = (window as any).__gladlogFixture;

    // m1 的 flags 慢:解析时 m2 已经挂上了。m2 无标记。
    let releaseM1!: (v: Record<string, string>) => void;
    const m1Flags = new Promise<Record<string, string>>((r) => {
      releaseM1 = r;
    });
    fx.analysis.getFlags = vi.fn((id: string) =>
      id === "m1" ? m1Flags : Promise.resolve({}),
    );

    const { rerender } = render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    rerender(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m2"
      />,
    );
    releaseM1({ [key]: "done" }); // 旧场的响应此刻才到
    await screen.findByText(/第30秒阵亡/);

    const btn = screen.getByTitle("标记为已改进");
    expect(btn.className).not.toContain("active"); // 旧场标记没串过来
  });
});

describe("slotLabel(拆首个 冒号 + 后端/模型显示名映射)", () => {
  it("已知后端 + 已知模型 id → 中文后端名 · 模型 label", () => {
    expect(slotLabel("anthropic:claude-sonnet-5")).toBe(
      "Claude API · Claude Sonnet 5",
    );
    expect(slotLabel("agy:pro")).toBe("agy · Gemini 3.1 Pro (High)");
  });

  it("已知后端 + 未知模型 id → 模型部分回退原串", () => {
    expect(slotLabel("codex:some-future-model")).toBe(
      "Codex · some-future-model",
    );
  });

  it("无冒号(防御性)→ 原样返回整串", () => {
    expect(slotLabel("legacy")).toBe("legacy");
  });
});

describe("多模型槽 tab 切换(Task 3)", () => {
  const resultA = result; // agy:pro,activeKey,最新
  const resultB = {
    findings: [
      {
        eventIds: ["e2"],
        severity: "med",
        category: "cd",
        title: "旧模型发现",
        explanation: "旧槽的观察文本。",
      },
    ],
    dropped: 0,
    hadNarration: true,
  };

  const twoSlotSummary = {
    slots: [
      { key: "anthropic:claude-sonnet-5", createdAt: 1, stale: true },
      { key: "agy:pro", createdAt: 2, stale: false },
    ],
    activeKey: "agy:pro",
  };

  function twoSlotFixture() {
    let doneCb: ((d: { matchId: string; result: unknown }) => void) | undefined;
    // 可变「磁盘状态」:onDone 触发的重查读的是这份最新快照,模拟 main 侧
    // 先写盘再 emit done 事件的真实时序(agy flash 复核 F2 回归用)。
    let docSummary = twoSlotSummary;
    const fx = (window as any).__gladlogFixture;
    fx.analysis.getState = vi.fn(() =>
      Promise.resolve({ cached: resultA, running: false, ...docSummary }),
    );
    fx.analysis.getCached = vi.fn((_matchId: string, slotKey?: string) =>
      Promise.resolve(
        slotKey === "anthropic:claude-sonnet-5" ? resultB : resultA,
      ),
    );
    fx.analysis.onDone = (
      cb: (d: { matchId: string; result: unknown }) => void,
    ) => {
      doneCb = cb;
      return () => {};
    };
    return {
      fx,
      getDoneCb: () => doneCb,
      setDocSummary: (s: typeof twoSlotSummary) => {
        docSummary = s;
      },
    };
  }

  it("双槽:渲染 tab 条,默认显示 activeKey 槽内容,旧槽带「旧版」标", async () => {
    twoSlotFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    const tabs = await screen.findByTestId("analysis-slot-tabs");
    expect(await screen.findByText(/第30秒阵亡/)).toBeTruthy(); // activeKey=agy:pro 内容
    expect(tabs.textContent).toContain("旧版");
  });

  it("点旧槽 tab → 显示该槽 findings,不触发 run/deepen", async () => {
    const { fx } = twoSlotFixture();
    fx.analysis.deepen = vi.fn().mockResolvedValue(undefined);
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    const tabs = await screen.findByTestId("analysis-slot-tabs");
    // slots 按 createdAt 升序:index 0 = 旧的 anthropic:claude-sonnet-5 槽。
    fireEvent.click(within(tabs).getAllByRole("button")[0]);
    expect(await screen.findByText(/旧槽的观察文本/)).toBeTruthy();
    expect(fx.analysis.run).not.toHaveBeenCalled();
    expect(fx.analysis.deepen).not.toHaveBeenCalled();
  });

  it("查看旧槽后 onDone 触发 → selectedSlotKey 重置,回到新结果", async () => {
    const { getDoneCb } = twoSlotFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    const tabs = await screen.findByTestId("analysis-slot-tabs");
    fireEvent.click(within(tabs).getAllByRole("button")[0]);
    await screen.findByText(/旧槽的观察文本/);

    const freshResult = {
      findings: [
        {
          eventIds: ["e3"],
          severity: "high",
          category: "survival",
          title: "新分析",
          explanation: "刚跑完的最新结果。",
        },
      ],
      dropped: 0,
      hadNarration: true,
    };
    act(() => {
      getDoneCb()?.({ matchId: "m1", result: freshResult });
    });
    expect(await screen.findByText(/刚跑完的最新结果/)).toBeTruthy();
  });

  it("onDone 后重新拉取 getState,tab 条按最新槽摘要更新(agy flash 复核 F2)", async () => {
    const { getDoneCb, setDocSummary } = twoSlotFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    expect(
      within(screen.getByTestId("analysis-slot-tabs")).getAllByRole("button"),
    ).toHaveLength(2);

    // main 先写盘再 emit done:此刻磁盘上已经多了第三个后端的槽。
    setDocSummary({
      slots: [
        ...twoSlotSummary.slots,
        { key: "codex:gpt-5.5", createdAt: 3, stale: false },
      ],
      activeKey: "codex:gpt-5.5",
    });
    act(() => {
      getDoneCb()?.({
        matchId: "m1",
        result: { ...resultA, deepened: true },
      });
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("analysis-slot-tabs")).getAllByRole("button"),
      ).toHaveLength(3);
    });
  });
});
