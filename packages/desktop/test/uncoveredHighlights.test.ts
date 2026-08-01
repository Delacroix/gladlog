import {
  ensureAnalysisData,
  extractCandidateFindings,
} from "@gladlog/analysis";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveMistakes,
  timedAnchorsFromMistakes,
} from "../src/renderer/src/report/derive/mistakes";
import { deriveUncoveredHighlights } from "../src/renderer/src/report/derive/uncoveredHighlights";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

// 复核轮修复(性能):extractCandidateFindings 是全场日志遍历(实测
// ~2.36ms/次),此前滑窗每个窗口的 buildWindowAnalysisRequest 都会重新调用
// 一次——spy 包一层真实实现(不改变任何返回值,其余测试的断言不受影响),
// 只用来验证 deriveUncoveredHighlights 在 9 窗场景下确实只调用一次(结构性
// 回归哨兵,不随窗口数变化,比 ms 阈值更稳、在任意规模的对局上都成立)。
vi.mock("@gladlog/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gladlog/analysis")>();
  return {
    ...actual,
    extractCandidateFindings: vi.fn(actual.extractCandidateFindings),
  };
});

const candidatesSpy = extractCandidateFindings as unknown as ReturnType<
  typeof vi.fn
>;

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 构包前置契约:prompt 法术名不许降级(同 analysisInput.test.ts)
  await ensureAnalysisData();
});

beforeEach(() => {
  candidatesSpy.mockClear();
});

// 真实 fixture 集成:证明真复用 #16 gate(buildWindowPack),不重新实现任何
// 判定。精确边界几何(命中/去重/合并/排名裁剪)另见
// uncoveredHighlights.geometry.test.ts(mock 掉信号门,不依赖 fixture 内容)。
describe("deriveUncoveredHighlights —— 真实 fixture 集成", () => {
  it("anchors=[]:9 个滑窗里除 20–40s(门不过)外全部命中,相邻窗全链重叠 → 合并成单一 0–90 高亮", () => {
    const durationS = (m.endTime - m.startTime) / 1000;
    expect(durationS).toBe(90);
    const highlights = deriveUncoveredHighlights(m, durationS, []);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.range).toEqual({ fromS: 0, toS: 90 });
    expect(highlights[0]!.itemCount).toBeGreaterThan(0);
    expect(highlights[0]!.summary.length).toBeGreaterThan(0);
  });

  it("去重:真实失误清单的 timed 锚点(与 MatchReport 生产接线一致)—— 唯一幸存的是 80–90s(其余窗口都被 ±5s 容差内的某条失误覆盖)", () => {
    // timedAnchorsFromMistakes 而非裸 .map(mk=>mk.tS):复核轮修复,cd-waste
    // 等"整场观察"类的哨兵 tS 不该进锚点集合(见 report.mistakes.test.tsx
    // 的红→绿用例)。这场 fixture 里过滤前后结果恰好相同(0s 的哨兵锚点被
    // 24s 那条真实锚点的容差范围本就覆盖着),但这里改用与生产一致的口径,
    // 不是巧合地绕过了修复点。
    const anchors = timedAnchorsFromMistakes(deriveMistakes(m));
    expect(anchors.length).toBeGreaterThan(0); // 前置:fixture 确实产生真实时间锚
    expect(anchors).not.toContain(0); // cd-waste 的哨兵 tS 已被过滤
    const durationS = (m.endTime - m.startTime) / 1000;
    const highlights = deriveUncoveredHighlights(m, durationS, anchors);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.range).toEqual({ fromS: 80, toS: 90 });
  });

  it("零亮点(零噪音):锚点每 10s 密布全场 → 每个滑窗 ±5s 容差内必有锚点,全丢", () => {
    const durationS = (m.endTime - m.startTime) / 1000;
    const denseAnchors = Array.from(
      { length: Math.ceil(durationS / 10) + 1 },
      (_, i) => i * 10,
    );
    expect(deriveUncoveredHighlights(m, durationS, denseAnchors)).toEqual([]);
  });

  it("durationS<=0 → 空数组,不抛(防御)", () => {
    expect(deriveUncoveredHighlights(m, 0, [])).toEqual([]);
    expect(deriveUncoveredHighlights(m, -5, [])).toEqual([]);
  });

  it("性能回归哨兵(复核轮修复,替换脆弱的 ms 阈值):extractCandidateFindings 全场只调用一次,不随滑窗窗口数变化", () => {
    const durationS = (m.endTime - m.startTime) / 1000;
    expect(durationS).toBe(90); // 90s/10s 步进 = 9 个滑窗(含合并阶段的二次
    // buildWindowPack 调用,但那一步不重新派生 candidates —— 复用同一份)
    deriveUncoveredHighlights(m, durationS, []);
    expect(candidatesSpy).toHaveBeenCalledTimes(1);
  });
});
