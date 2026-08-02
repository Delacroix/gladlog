// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";

import { DevPanel } from "../src/renderer/src/components/DevPanel";
import { installDevFixture } from "./support/devPanelFixture";

/** The inspector is not the default zone (the panel opens on watch status),
 *  so the test has to switch to it first. */
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
 * Performance contract for the dev page's match inspector (plan 5a, section
 * 3.7, acceptance ①).
 *
 * The old implementation ran `JSON.stringify(the whole doc)` and dumped it
 * into a <pre>. In the real library a single match.json averages ≈62MB, which
 * froze the renderer process outright (measured 2026-07-26: 30s unresponsive);
 * the stopgap back then was truncating to 256KB. It is now a lazily expanded
 * tree: **not one character of an unexpanded node reaches the DOM**. The
 * assertion is on actual DOM text volume, not on elapsed time (timing
 * assertions are flaky in CI).
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

    // A full stringify is ≈2MB+; laying out just the three top-level keys is
    // on the order of one or two thousand characters
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
    // Element contents (unit names / huge strings) must not show up
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

    // Before expanding: grandchild-level leaf values are not in the DOM
    expect(view.container.textContent).not.toContain("Chaos Bolt");

    fireEvent.click(
      view.container.querySelector("[data-node-path=rounds] .dev-node-toggle")!,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector("[data-node-path='rounds[0]']"),
      ).toBeTruthy(),
    );
    // rounds is expanded, but rounds[0] is still a collapsed container — leaf
    // values still stay out of the DOM
    expect(view.container.textContent).not.toContain("Chaos Bolt");
  });
});
