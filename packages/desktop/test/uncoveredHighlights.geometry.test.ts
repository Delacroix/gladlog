import type { PackItem } from "@gladlog/analysis";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildWindowAnalysisRequest } from "../src/renderer/src/report/derive/analysisInput";
import { deriveUncoveredHighlights } from "../src/renderer/src/report/derive/uncoveredHighlights";

// 命中/去重边界/合并/排名的精确几何用 mock 版信号门验证 —— 真实 gate 的命中
// 分布是 fixture 内容决定的既成事实,精确边界案例在真 fixture 上很难摆出
// 多组独立岛屿(90s/9 窗口太短),mock 让这些几何断言不依赖 fixture 内容具体
// 是什么(fixture 换了/gate 微调了都不该改变这些纯几何断言)。真实 gate 复用
// 见 uncoveredHighlights.test.ts 的「真实 fixture 集成」describe。
vi.mock("../src/renderer/src/report/derive/analysisInput", () => ({
  buildWindowAnalysisRequest: vi.fn(),
}));

const mockGate = buildWindowAnalysisRequest as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  mockGate.mockReset();
});

function packItem(kind: PackItem["kind"]): PackItem {
  return { key: "p1", kind, t: 0, label: "", unitNames: [], facts: {} };
}

function hitOf(n: number) {
  return (_src: unknown, fromS: number, toS: number) => ({
    pack: { items: Array.from({ length: n }, () => packItem("hp")) },
    kind: "survival" as const,
    spec: "",
    ownerName: "",
    fromS,
    toS,
  });
}

const src = { endTime: 0, startTime: 0 } as never;

describe("deriveUncoveredHighlights —— mock 信号门:几何断言", () => {
  it("命中:门过的窗口原样保留,摘要按 kind 计数中文渲染(出现顺序,不按频次重排)", () => {
    mockGate.mockImplementation(
      (_src: unknown, fromS: number, toS: number) => ({
        pack: {
          items: [packItem("hp"), packItem("hp"), packItem("defensive")],
        },
        kind: "survival",
        spec: "",
        ownerName: "",
        fromS,
        toS,
      }),
    );
    const highlights = deriveUncoveredHighlights(src, 20, []);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toEqual({
      range: { fromS: 0, toS: 20 },
      summary: "2 次承压 · 1 次防御时机",
      itemCount: 3,
    });
  });

  it("去重:锚点落在窗口 ±5s 容差内 → 命中窗被丢弃,且门从未被调用(去重先于 gate)", () => {
    mockGate.mockImplementation(hitOf(1));
    // 唯一滑窗 [0,20];锚点 t=24 在容差边界内(20+5=25 >= 24)。
    const highlights = deriveUncoveredHighlights(src, 20, [24]);
    expect(highlights).toEqual([]);
    expect(mockGate).not.toHaveBeenCalled();
  });

  it("去重容差边界:锚点恰好在 ±5s 边界外 → 不丢", () => {
    mockGate.mockImplementation(hitOf(1));
    // 窗口 [0,20],容差边界为 [-5,25];锚点 25.1 刚好在边界外。
    const highlights = deriveUncoveredHighlights(src, 20, [25.1]);
    expect(highlights).toHaveLength(1);
  });

  it("合并:相邻/重叠命中窗取并集边界(链式重叠合并成一整块,不各自独立展示)", () => {
    mockGate.mockImplementation(hitOf(1));
    // 40s 场,10s 步进 20s 窗 → 滑窗 [0,20][10,30][20,40],全命中,链式重叠。
    const highlights = deriveUncoveredHighlights(src, 40, []);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.range).toEqual({ fromS: 0, toS: 40 });
  });

  it("合并边界:命中窗间隔了两个门不过的窗口 → 两座独立孤岛(不是并成一整块)", () => {
    // 60s 场,滑窗 fromS=0,10,20,30,40。丢 10 与 20 两个窗口(门不过)——
    // 剩 [0,20] 单独一岛,[30,50]∪[40,60] 重叠合并成 {30,60} 另一岛;两岛间
    // toS=20 < fromS=30 严格不重叠(合并判定用 <=,只丢一个窗口的话 20 会
    // 与 30 相接仍判重叠,须丢两个才能验证"真正分岛")。
    mockGate.mockImplementation((_src: unknown, fromS: number, toS: number) =>
      fromS === 10 || fromS === 20 ? null : hitOf(1)(_src, fromS, toS),
    );
    const highlights = deriveUncoveredHighlights(src, 60, []);
    const ranges = highlights
      .map((h) => h.range)
      .sort((a, b) => a.fromS - b.fromS);
    expect(ranges).toEqual([
      { fromS: 0, toS: 20 },
      { fromS: 30, toS: 60 },
    ]);
  });

  it("排名 top3:4 座互不重叠的孤岛只留信号密度最高的 3 座,按 itemCount 降序", () => {
    // 120s 场,只在 fromS ∈ {0,30,60,90} 命中(间距 30s > 窗宽 20s,天然互
    // 不重叠,不需要合并即可单测纯排名/裁剪),itemCount 与 fromS 顺序故意
    // 错开,验证排序不是"先到先得"。
    const ITEM_COUNT: Record<number, number> = { 0: 4, 30: 1, 60: 3, 90: 2 };
    mockGate.mockImplementation((_src: unknown, fromS: number, toS: number) => {
      const n = ITEM_COUNT[fromS];
      return n === undefined ? null : hitOf(n)(_src, fromS, toS);
    });
    const highlights = deriveUncoveredHighlights(src, 120, []);
    expect(highlights).toHaveLength(3); // top3 裁掉 fromS=30(itemCount=1)
    expect(highlights.map((h) => h.itemCount)).toEqual([4, 3, 2]);
    expect(highlights.map((h) => h.range.fromS)).toEqual([0, 60, 90]);
  });

  it("零亮点:全场门都不过 → 空数组", () => {
    mockGate.mockReturnValue(null);
    expect(deriveUncoveredHighlights(src, 90, [])).toEqual([]);
  });
});
