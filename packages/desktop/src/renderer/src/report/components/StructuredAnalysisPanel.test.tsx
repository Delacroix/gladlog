// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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
import { buildAnalysisInput } from "../derive/analysisInput";

// split 按钮测试(Task 4)需要点选后真的调得到 handleAnalyze/runAnalyze,
// 而这必须先过 `input !== null` 的门;本文件其余用例统一用的最小 source
// (`{units:{}, startInfo:{}}`)在真实 buildAnalysisInput 下找不到 owner,
// 恒为 null(Task 3 报告已记录:本仓库无现成的轻量 GladMatch fixture,
// 现造一份的性价比超出单个 Task 的范围)。这里把 buildAnalysisInput 包成
// vi.fn(委托给真实实现) —— 默认行为与未 mock 时逐字一致(其余全部用例
// 拿到的仍是 null,零回归),只在 split 描述块里临时 mockReturnValue 一份
// 假 input,不影响 buildDeepenPacks 等其余导出。
vi.mock("../derive/analysisInput", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../derive/analysisInput")>();
  return { ...actual, buildAnalysisInput: vi.fn(actual.buildAnalysisInput) };
});

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
    let doneCb:
      | ((d: { matchId: string; result: unknown; slotKey?: string }) => void)
      | undefined;
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
      cb: (d: { matchId: string; result: unknown; slotKey?: string }) => void,
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

  // 最终评审 I-2:selectedSlotKey 在点击那一刻就翻了(高亮跟手),但
  // getCached resolve 为 null 时原实现什么都不做——面板停在"上一个槽的
  // findings + 新槽的高亮"这种撕裂态,像是点了没反应。改前会失败在第一个
  // 断言(占位文案不出现,`第30秒阵亡` 仍然显示着);改后转绿。
  it("点旧槽 tab 但 getCached 返回 null(槽已因 prompt 升级失效)→ 占位提示、findings 消失,点回激活槽秒恢复(复核 I-2)", async () => {
    const { fx } = twoSlotFixture();
    fx.analysis.getCached = vi.fn((_matchId: string, slotKey?: string) =>
      Promise.resolve(slotKey === "anthropic:claude-sonnet-5" ? null : resultA),
    );
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/); // 初始展示 activeKey=agy:pro
    const tabs = await screen.findByTestId("analysis-slot-tabs");
    // index 0 = 旧的 anthropic:claude-sonnet-5 槽,这次它的 getCached → null。
    fireEvent.click(within(tabs).getAllByRole("button")[0]);

    expect(
      await screen.findByText(/该槽为旧版本分析.*重新分析后可查看/),
    ).toBeTruthy();
    // 两边的 findings 都不该显示——既不是误留旧内容,也不是假装是新槽的结果。
    expect(screen.queryByText(/第30秒阵亡/)).toBeNull();
    expect(screen.queryByText(/旧槽的观察文本/)).toBeNull();
    // 高亮诚实停在这个(空)槽上,不是静默弹回之前那个 tab。
    const staleTab = within(tabs)
      .getAllByRole("button")
      .find((b) => b.className.includes("active"));
    expect(staleTab?.textContent).toContain("旧版");

    // 点回激活槽(index 1,getCached 仍返回 resultA)→ 恢复展示,占位消失。
    fireEvent.click(within(tabs).getAllByRole("button")[1]);
    expect(await screen.findByText(/第30秒阵亡/)).toBeTruthy();
    expect(screen.queryByTestId("slot-stale-note")).toBeNull();
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

  it("override 分析完成(done payload 带 slotKey)→ 展示新槽结果且 tab 计入新槽(Task 4 onDone 不变式)", async () => {
    const { getDoneCb, setDocSummary } = twoSlotFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);

    const overrideResult = {
      findings: [
        {
          eventIds: ["e4"],
          severity: "high",
          category: "survival",
          title: "deepseek新发现",
          explanation: "deepseek 槽的结果。",
        },
      ],
      dropped: 0,
      hadNarration: true,
    };
    // main 先写盘再 emit done:磁盘上此刻已多了 override 跑出来的第三个槽,
    // 且它就是新的 lastSlotKey(finish() 的 upsertSlot 语义)。
    setDocSummary({
      slots: [
        ...twoSlotSummary.slots,
        { key: "deepseek:deepseek-chat", createdAt: 3, stale: false },
      ],
      activeKey: "deepseek:deepseek-chat",
    });
    act(() => {
      getDoneCb()?.({
        matchId: "m1",
        result: overrideResult,
        slotKey: "deepseek:deepseek-chat",
      });
    });
    expect(await screen.findByText(/deepseek 槽的结果/)).toBeTruthy();
    await waitFor(() => {
      const tabs = within(
        screen.getByTestId("analysis-slot-tabs"),
      ).getAllByRole("button");
      expect(tabs).toHaveLength(3);
      const activeTab = tabs.find((b) => b.className.includes("active"));
      expect(activeTab?.textContent).toContain("DeepSeek");
    });
  });

  it("done payload 的 slotKey 与刷新后 activeKey 不一致(违反不变式)时只 warn,仍按 activeKey 展示", async () => {
    const { getDoneCb, setDocSummary } = twoSlotFixture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);

    // 刷新后的 activeKey 仍是 agy:pro,但 payload 却报了另一个 slotKey ——
    // 理论上不该发生,只用来验证防御分支不会让展示错位。
    setDocSummary(twoSlotSummary);
    act(() => {
      getDoneCb()?.({
        matchId: "m1",
        result: resultA,
        slotKey: "codex:gpt-5.5",
      });
    });
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(screen.getByText(/第30秒阵亡/)).toBeTruthy();
    warnSpy.mockRestore();
  });
});

describe("split 箭头:选用其他模型分析(Task 4)", () => {
  const fakeInput = {
    matchId: "m1",
    candidates: [],
    richContext: "ctx",
    spec: "spec",
    ownerName: "Healer",
    enemySpecs: [],
  };

  beforeEach(() => {
    (buildAnalysisInput as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeInput,
    );
  });
  afterEach(() => {
    (buildAnalysisInput as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  function pickerFixture(overrides?: {
    detectCli?: (backend: string) => Promise<{ path: string | null }>;
    settings?: Record<string, unknown>;
  }) {
    const fx = (window as any).__gladlogFixture;
    fx.settings.get = vi.fn().mockResolvedValue({
      aiLanguage: "zh",
      aiBackend: "anthropic",
      aiModels: {},
      anthropicApiKey: "sk-set",
      deepseekApiKey: null,
      ...overrides?.settings,
    });
    fx.ai = {
      detectCli:
        overrides?.detectCli ??
        vi.fn((backend: string) =>
          Promise.resolve({
            path: backend === "agy" ? "/usr/bin/agy" : null,
          }),
        ),
    };
    return fx;
  }

  it("菜单分组列出可用后端×模型 + 当前全局默认标记,不可用后端不出现", async () => {
    pickerFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    fireEvent.click(screen.getByRole("button", { name: "选用其他模型分析" }));
    const menu = await screen.findByTestId("analysis-model-menu");

    // 全局默认 = settings.aiBackend("anthropic") + 该后端默认模型
    // (aiModels 未配 → AI_DEFAULT_MODEL.anthropic = claude-sonnet-5)。
    expect(
      within(menu).getByText("Claude API · Claude Sonnet 5 (默认)"),
    ).toBeTruthy();
    // 同后端其他模型出现但不带默认标
    expect(within(menu).getByText("Claude API · Claude Opus 4.8")).toBeTruthy();
    // agy 检测到 CLI 路径 → 全部模型出现,非默认后端不带标
    expect(within(menu).getByText(slotLabel("agy:flash"))).toBeTruthy();
    // 不可用后端不出现:claudeCli/codex 未检测到、deepseek 无 key
    expect(within(menu).queryByText(/Claude CLI/)).toBeNull();
    expect(within(menu).queryByText(/^Codex/)).toBeNull();
    expect(within(menu).queryByText(/DeepSeek/)).toBeNull();
  });

  it("菜单开着时点主按钮跑默认分析 → 菜单同步关闭,不留可点的旧菜单项(agy flash 复核)", async () => {
    const fx = pickerFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    fireEvent.click(screen.getByRole("button", { name: "选用其他模型分析" }));
    await screen.findByTestId("analysis-model-menu");

    fireEvent.click(screen.getByRole("button", { name: "重新分析" }));

    // 菜单必须已经关闭——否则用户能在默认分析已经 running 之后又点一个
    // 菜单项,main 侧 nextGen 会腰斩刚发出去的第一次请求(白烧一次 token)。
    expect(screen.queryByTestId("analysis-model-menu")).toBeNull();
    expect(fx.analysis.run).toHaveBeenCalledTimes(1);
    expect(
      (fx.analysis.run.mock.calls[0][0] as { backendOverride?: unknown })
        .backendOverride,
    ).toBeUndefined();
  });

  it("选中菜单项 → run 收到 backendOverride,不写 settings,菜单关闭", async () => {
    const fx = pickerFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    fireEvent.click(screen.getByRole("button", { name: "选用其他模型分析" }));
    const menu = await screen.findByTestId("analysis-model-menu");
    fireEvent.click(within(menu).getByText(slotLabel("agy:flash")));

    expect(fx.analysis.run).toHaveBeenCalledWith(
      expect.objectContaining({
        backendOverride: { backend: "agy", model: "flash" },
      }),
    );
    expect(fx.settings.save).not.toHaveBeenCalled();
    expect(screen.queryByTestId("analysis-model-menu")).toBeNull();
  });

  it("Esc 关闭菜单", async () => {
    pickerFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    fireEvent.click(screen.getByRole("button", { name: "选用其他模型分析" }));
    await screen.findByTestId("analysis-model-menu");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("analysis-model-menu")).toBeNull(),
    );
  });

  it("点击菜单外部关闭菜单", async () => {
    pickerFixture();
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    await screen.findByText(/第30秒阵亡/);
    fireEvent.click(screen.getByRole("button", { name: "选用其他模型分析" }));
    await screen.findByTestId("analysis-model-menu");
    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId("analysis-model-menu")).toBeNull(),
    );
  });

  it("分析进行中时箭头禁用", async () => {
    const fx = pickerFixture();
    // 桩最小 source 下 buildAnalysisInput 恒为 null(Task 3 报告已记录的
    // 既有测试限制),点主按钮不会真的进入 running——改用 getState 直接
    // 让面板重挂时读到"仍在跑",与既有「重挂时若首轮还在跑」用例同款手法。
    fx.analysis.getState = vi.fn().mockResolvedValue({
      cached: null,
      running: true,
      slots: [],
      activeKey: null,
    });
    render(
      <StructuredAnalysisPanel
        source={{ units: {}, startInfo: {} } as any}
        matchId="m1"
      />,
    );
    const arrow = await screen.findByRole("button", {
      name: "选用其他模型分析",
    });
    expect((arrow as HTMLButtonElement).disabled).toBe(true);
  });
});
