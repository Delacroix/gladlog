import { ensureAnalysisData } from "@gladlog/analysis";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveMistakes } from "../src/renderer/src/report/derive/mistakes";
import { deriveUncoveredHighlights } from "../src/renderer/src/report/derive/uncoveredHighlights";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 构包前置契约:prompt 法术名不许降级(同 analysisInput.test.ts)
  await ensureAnalysisData();
});

// 真实 fixture 集成:证明真复用 #16 gate(buildWindowAnalysisRequest),不重
// 新实现任何判定。精确边界几何(命中/去重/合并/排名裁剪)另见
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

  it("去重:真实失误清单(deriveMistakes)tS 当锚点 —— 唯一幸存的是 80–90s(其余窗口都被 ±5s 容差内的某条失误覆盖)", () => {
    const anchors = deriveMistakes(m).map((mk) => mk.tS);
    expect(anchors.length).toBeGreaterThan(0); // 前置:fixture 确实产生失误锚点
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

  it("性能(判断依据,非硬门槛):90s/9 窗滑窗 <200ms(真实场,含法术名表已就绪)", () => {
    const durationS = (m.endTime - m.startTime) / 1000;
    const t0 = performance.now();
    deriveUncoveredHighlights(m, durationS, []);
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console -- 报告用,不是断言失败路径的诊断
    console.log(
      `[uncoveredHighlights perf] 90s/9 windows: ${elapsed.toFixed(1)}ms`,
    );
    expect(elapsed).toBeLessThan(200);
  });
});
