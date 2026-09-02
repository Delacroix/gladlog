// @vitest-environment jsdom
/**
 * GH #26 root cause, pinned deterministically (2026-09-02).
 *
 * The flaky ledger's devpanel record ("expanding one container … grandchildren
 * stay out of the DOM", `expected null to be truthy`, only under CI load) died
 * on a DOM snapshot where the `rounds` toggle read `aria-expanded="false"`
 * AFTER the test had clicked it. The click was not slow — it was undone:
 * JsonTree reset its expansion set in a `useEffect([root])`, which also runs
 * on mount as a *passive* effect. When the click lands in the window between
 * the commit that put the tree in the DOM and the scheduler task that flushes
 * passive effects, React flushes the pending effects before rendering the
 * click's update — so the hook's update queue reads [toggle → {rounds}, reset
 * → {}] and the node ends up collapsed. testing-library's `waitFor` opens
 * exactly that window: it observes the DOM through a MutationObserver
 * (microtask) and drains with `setTimeout(0)`, while React's passive flush
 * rides `setImmediate` — the two race, and under load the timer wins.
 *
 * This test reproduces the window on purpose: render outside act (passive
 * effects stay scheduled), wait for the node with a MutationObserver, click
 * inside that microtask.
 */
import { fireEvent } from "@testing-library/react";
import { createRoot } from "react-dom/client";

import { JsonTree } from "../src/renderer/src/components/dev/JsonTree";
import { untilDom } from "./support/untilDom";

describe("JsonTree:点击展开落在被动 effect 刷新之前也必须生效(GH #26 根因)", () => {
  it("挂载后立刻(passive effect 尚未刷新)点展开 → 子节点进 DOM,aria-expanded=true", async () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
    // Outside act: the mount commit is a normal-priority scheduler task and its
    // passive effects are a *separate* scheduler task — the real app's timing.
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      root.render(
        <JsonTree
          root={{ rounds: [{ deaths: [{ spell: "Chaos Bolt" }] }] }}
          selectedPath=""
          onSelect={() => {}}
        />,
      );
      const node = await untilDom(container, "[data-node-path=rounds]");
      // Still inside the microtask that followed the commit: click now.
      fireEvent.click(node.querySelector(".dev-node-toggle")!);
      await untilDom(container, "[data-node-path='rounds[0]']", 1500);
      expect(
        node.querySelector(".dev-node-toggle")!.getAttribute("aria-expanded"),
      ).toBe("true");
      // Only one level opened — the grandchild leaf stays out of the DOM.
      expect(container.textContent).not.toContain("Chaos Bolt");
    } finally {
      root.unmount();
      container.remove();
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});
