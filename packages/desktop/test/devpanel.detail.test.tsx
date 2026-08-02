// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DevPanel } from "../src/renderer/src/components/DevPanel";
import { installDevFixture } from "./support/devPanelFixture";

/** 检查器不是默认区(默认停在监控状态),测试要先切过去。 */
async function openInspector(container: HTMLElement): Promise<void> {
  await waitFor(() =>
    expect(
      container.querySelector("[data-testid=dev-nav-inspect]"),
    ).toBeTruthy(),
  );
  fireEvent.click(container.querySelector("[data-testid=dev-nav-inspect]")!);
  await waitFor(() =>
    expect(
      container.querySelector("[data-testid=dev-match-list]"),
    ).toBeTruthy(),
  );
}

/**
 * 开发者页对局检查器的性能契约(方案 5a 三点七 验收①)。
 *
 * 旧实现 `JSON.stringify(整份 doc)` 后灌 <pre>,真实库单场 match.json 均值
 * ≈62MB,渲染进程直接冻死(2026-07-26 实测 30s 无响应);当时的止血是截断到
 * 256KB。现在换成懒展开树:**没展开的节点一个字符都不进 DOM**,断言的是
 * DOM 实际文本量,不是耗时(耗时断言在 CI 上会抖)。
 */
describe("对局检查器:只渲染展开的节点", () => {
  const bigDoc = {
    kind: "match",
    units: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [
        `u${i}`,
        { name: `Name${i}`, blob: "x".repeat(1000) },
      ]),
    ),
    rounds: Array.from({ length: 300 }, (_, i) => ({ seq: i, deaths: [] })),
  };

  it("选中 2MB+ 的对局后,DOM 文本量与顶层键数同阶,不随文档体积走", async () => {
    const { container } = installDevFixture({ detail: bigDoc });
    const view = render(<DevPanel />, { container });
    await openInspector(view.container);

    await waitFor(() =>
      expect(
        view.container.querySelectorAll("[data-testid=dev-match-row]").length,
      ).toBe(1),
    );
    fireEvent.click(
      view.container.querySelector("[data-testid=dev-match-row]")!,
    );

    await waitFor(() =>
      expect(
        view.container.querySelector("[data-testid=dev-json-tree]"),
      ).toBeTruthy(),
    );

    // 全量 stringify ≈ 2MB+;只铺顶层三个键则是一两千字符量级
    expect(view.container.textContent!.length).toBeLessThan(5_000);
  });

  it("未展开的容器只显示规模摘要,不显示任何元素内容", async () => {
    const { container } = installDevFixture({ detail: bigDoc });
    const view = render(<DevPanel />, { container });
    await openInspector(view.container);
    await waitFor(() =>
      expect(
        view.container.querySelectorAll("[data-testid=dev-match-row]").length,
      ).toBe(1),
    );
    fireEvent.click(
      view.container.querySelector("[data-testid=dev-match-row]")!,
    );

    await waitFor(() => expect(view.container.textContent).toContain("{2000}"));
    expect(view.container.textContent).toContain("[300]");
    // 元素内容(单位名/巨串)不该出现
    expect(view.container.textContent).not.toContain("Name0");
    expect(view.container.textContent).not.toContain("xxxxxxxxxx");
  });

  it("展开一个容器只铺它这一层,孙子节点仍不进 DOM", async () => {
    const nested = {
      rounds: [{ deaths: [{ victim: "PlayerA-Test", spell: "Chaos Bolt" }] }],
    };
    const { container } = installDevFixture({ detail: nested });
    const view = render(<DevPanel />, { container });
    await openInspector(view.container);
    await waitFor(() =>
      expect(
        view.container.querySelectorAll("[data-testid=dev-match-row]").length,
      ).toBe(1),
    );
    fireEvent.click(
      view.container.querySelector("[data-testid=dev-match-row]")!,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-node-path=rounds]"),
      ).toBeTruthy(),
    );

    // 展开前:孙子层的叶子值不在 DOM 里
    expect(view.container.textContent).not.toContain("Chaos Bolt");

    fireEvent.click(
      view.container.querySelector("[data-node-path=rounds] .dev-node-toggle")!,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-node-path='rounds[0]']"),
      ).toBeTruthy(),
    );
    // 展开了 rounds,但 rounds[0] 仍是折叠的容器 —— 叶子值依然不进 DOM
    expect(view.container.textContent).not.toContain("Chaos Bolt");
  });
});
