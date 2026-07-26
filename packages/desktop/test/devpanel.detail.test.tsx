// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DevPanel } from "../src/renderer/src/components/DevPanel";

const noopUnsub = () => () => {};

/** 真实库单场 match.json 已到 25MB:详情预览必须封顶,否则渲染进程冻死
 *  (2026-07-26 实测 30s 无响应)。 */
describe("DevPanel 详情预览封顶", () => {
  it("大文档只渲染截断预览(≤256KB)并标注完整体积", async () => {
    // ~2MB 的文档:stringify 后远超预览上限
    const bigDoc = {
      units: Array.from({ length: 2000 }, (_, i) => ({
        id: `u${i}`,
        blob: "x".repeat(1000),
      })),
    };
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      logs: {
        getStatus: async () => null,
        onStatusChanged: noopUnsub,
        onMatchStored: noopUnsub,
        onDiagnostic: noopUnsub,
      },
      settings: {
        get: async () => ({ wowDirectory: null, aiBackend: "anthropic" }),
      },
      matches: {
        list: async () => [
          {
            id: "big1",
            kind: "match",
            bracket: "3v3",
            zoneId: "1505",
            startTime: 1,
            endTime: 2,
            result: "win",
            storedAt: 1,
          },
        ],
        get: async () => bigDoc,
      },
      debug: { aiCalls: async () => [] },
    };

    const { container } = render(<DevPanel />);
    await waitFor(() =>
      expect(container.querySelectorAll(".matches li").length).toBe(1),
    );
    fireEvent.click(container.querySelector(".matches li")!);

    await waitFor(() => {
      const pre = container.querySelector(".detail pre");
      expect(pre).toBeTruthy();
      expect(pre!.textContent!.length).toBeGreaterThan(100);
    });
    const pre = container.querySelector(".detail pre")!;
    // 预览封顶:渲染文本必须远小于全量(全量 stringify ≈ 2MB+)
    expect(pre.textContent!.length).toBeLessThanOrEqual(256 * 1024 + 200);
    // 截断提示要说明全量体积,让人知道这不是完整数据
    expect(screen.getByTestId("detail-truncated").textContent).toMatch(
      /截断|完整/,
    );
  });
});
