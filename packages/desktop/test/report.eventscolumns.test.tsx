// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EventsPanel } from "../src/renderer/src/report/components/EventsPanel";
import { deriveEventRows } from "../src/renderer/src/report/derive/eventsView";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

const panel = (props: Partial<Parameters<typeof EventsPanel>[0]> = {}) =>
  render(<EventsPanel source={m} bands={[]} globalRange={null} {...props} />);

const bodyRows = (c: HTMLElement): HTMLElement[] =>
  Array.from(c.querySelectorAll<HTMLElement>(".rpt-events-table tbody tr"));
/** Text of one body column (spacer rows carry a single empty td). */
const colText = (c: HTMLElement, idx: number): string[] =>
  bodyRows(c)
    .map((tr) => tr.querySelectorAll("td")[idx]?.textContent?.trim() ?? "")
    .filter((t) => t !== "");
/**
 * How many rows matched. NOT the DOM row count: the table is virtualized and
 * jsdom reports clientHeight 0, so the rendered window is a constant ~69 rows
 * no matter how hard you filter. The panel prints "N / M 条" — that N is the
 * only honest count, and it is scoped to the toolbar because `.rpt-stats-dim`
 * is also the class on every amount cell.
 */
const matchedCount = (c: HTMLElement): number =>
  Number(
    /^(\d+)\s*\//.exec(
      c.querySelector(".rpt-events-filters .rpt-stats-dim")?.textContent ?? "",
    )?.[1] ?? "-1",
  );
/** Parsed 详情 amounts among the rendered rows ("12.4k" → 12400); rows whose
 * detail is text (施放 / 光环 / 死亡) drop out. */
const amountsShown = (c: HTMLElement): number[] =>
  colText(c, 5)
    .map((t) => {
      const m = /^([\d.]+)(k?)$/.exec(t);
      return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
    })
    .filter((n): n is number => n != null);

describe("事件表:表头筛选行", () => {
  it("六列各有一个过滤控件", () => {
    panel();
    for (const id of [
      "events-f-time",
      "events-kind-filter",
      "events-f-src",
      "events-f-dest",
      "events-f-spell",
      "events-f-amount",
    ])
      expect(screen.getByTestId(id), id).toBeTruthy();
  });

  it("来源下拉:选中后来源列只剩该单位,且选项来自实际行", () => {
    const { container } = panel();
    const rows = deriveEventRows(m);
    const src = rows.find((r) => r.srcName)!.srcName;
    const sel = screen.getByTestId("events-f-src") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toContain(src);
    fireEvent.change(sel, { target: { value: src } });
    const names = new Set(colText(container, 2));
    expect(names.size).toBe(1);
    expect([...names][0]).toBe(src);
  });

  it("来源 + 目标同时选 = 只看 A 打 B(是与不是或)", () => {
    const { container } = panel();
    const rows = deriveEventRows(m);
    const pair = rows.find(
      (r) => r.srcName && r.destName && r.srcName !== r.destName,
    )!;
    fireEvent.change(screen.getByTestId("events-f-src"), {
      target: { value: pair.srcName },
    });
    fireEvent.change(screen.getByTestId("events-f-dest"), {
      target: { value: pair.destName },
    });
    expect(new Set(colText(container, 2))).toEqual(new Set([pair.srcName]));
    expect(new Set(colText(container, 3))).toEqual(new Set([pair.destName]));
  });

  it("类型过滤在弹层里,多选保留、带计数", () => {
    panel();
    expect(screen.queryByTestId("events-kind-pop")).toBeNull();
    fireEvent.click(screen.getByTestId("events-kind-filter"));
    const pop = screen.getByTestId("events-kind-pop");
    // Counts survived the move into the popover
    expect(within(pop).getByRole("button", { name: /^伤害\d/ })).toBeTruthy();
    fireEvent.click(within(pop).getByRole("button", { name: /^伤害/ }));
    fireEvent.click(within(pop).getByRole("button", { name: /^治疗/ }));
    // Multi-select is still multi-select: the trigger shows "first+N"
    expect(screen.getByTestId("events-kind-filter").textContent).toMatch(
      /伤害\+1/,
    );
  });

  it("时间输入框与窗口下拉是同一个窗口(输入 → 下拉变自定义)", () => {
    panel();
    const input = screen.getByTestId("events-f-time") as HTMLInputElement;
    const anchor = screen.getByTestId("events-anchor") as HTMLSelectElement;
    expect(anchor.value).toBe("all");
    fireEvent.change(input, { target: { value: "0:10-0:20" } });
    expect(anchor.value).toBe("custom");
    // Half-typed input must not blank the window out from under the user
    fireEvent.change(input, { target: { value: "0:10-" } });
    expect(anchor.value).toBe("custom");
    expect(input.className).toContain("bad");
    // Emptying it clears the window
    fireEvent.change(input, { target: { value: "" } });
    expect(anchor.value).toBe("all");
  });

  // agy review finding 1: the sync used to be a "skip the next effect" flag,
  // which got stranded whenever a keystroke parsed to the window that was
  // already active — after that the box stopped following the anchor dropdown.
  it("输入无效值再清空后,窗口下拉仍能把输入框带回来(不会卡住)", () => {
    panel({ globalRange: { fromS: 5, toS: 25 } });
    const input = screen.getByTestId("events-f-time") as HTMLInputElement;
    const anchor = screen.getByTestId("events-anchor") as HTMLSelectElement;
    // Start on 全场 so that clearing the box parses to the window already active
    fireEvent.change(anchor, { target: { value: "all" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(anchor.value).toBe("all");
    // The dropdown must still drive the box
    fireEvent.change(anchor, { target: { value: "global" } });
    expect(input.value).toBe("0:05-0:25");
  });

  it("已经表示当前窗口的输入不会被重新格式化(裸秒写法保留)", () => {
    panel();
    const input = screen.getByTestId("events-f-time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30-70" } });
    // Same window, different spelling — must not be rewritten to 0:30-1:10
    expect(input.value).toBe("30-70");
  });

  it("数值下限过滤掉没有数值的行(施放/光环/死亡)", () => {
    const { container } = panel();
    const before = matchedCount(container);
    expect(before).toBeGreaterThan(0);
    fireEvent.change(screen.getByTestId("events-f-amount"), {
      target: { value: "5000" },
    });
    expect(matchedCount(container)).toBeLessThan(before);
    const kinds = new Set(colText(container, 1));
    expect(kinds.has("施放")).toBe(false);
    expect(kinds.has("死亡")).toBe(false);
    for (const a of amountsShown(container))
      expect(a).toBeGreaterThanOrEqual(5000);
  });
});

describe("事件表:列排序", () => {
  it("点列名排序,再点翻向;aria-sort 跟着变", () => {
    const { container } = panel();
    const th = () =>
      container.querySelector(".rpt-events-hrow th:nth-child(6)")!;
    expect(th().getAttribute("aria-sort")).toBe("none");
    // 数值列第一次点击给降序(最大的先看)
    fireEvent.click(screen.getByTestId("events-sort-amount"));
    expect(th().getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(screen.getByTestId("events-sort-amount"));
    expect(th().getAttribute("aria-sort")).toBe("ascending");
    // 时间列默认升序
    fireEvent.click(screen.getByTestId("events-sort-time"));
    expect(
      container
        .querySelector(".rpt-events-hrow th:nth-child(1)")!
        .getAttribute("aria-sort"),
    ).toBe("ascending");
  });

  it("按数值降序:渲染出来的数值单调不增,首行是全场最大", () => {
    const { container } = panel();
    const byTime = amountsShown(container);
    fireEvent.click(screen.getByTestId("events-sort-amount"));
    const desc = amountsShown(container);
    expect(desc.length).toBeGreaterThan(3);
    for (let i = 1; i < desc.length; i++)
      expect(desc[i]!).toBeLessThanOrEqual(desc[i - 1]!);
    // HAS TEETH: it really did reorder — the top row beats everything the
    // time-ordered first screen had
    expect(desc[0]!).toBeGreaterThan(Math.max(...byTime));
  });

  it("排序不吃行:换排序键后匹配数不变", () => {
    const { container } = panel();
    const n = matchedCount(container);
    for (const key of ["kind", "src", "dest", "spell", "amount"]) {
      fireEvent.click(screen.getByTestId(`events-sort-${key}`));
      expect(matchedCount(container), key).toBe(n);
    }
  });
});

describe("事件表:清除筛选", () => {
  it("有筛选才出现,点了全清、行数复原;排序不受影响", () => {
    const { container } = panel();
    const before = matchedCount(container);
    expect(screen.queryByTestId("events-clear-filters")).toBeNull();
    fireEvent.click(screen.getByTestId("events-sort-amount"));
    // Sorting alone is not a filter — the button must still be absent
    expect(screen.queryByTestId("events-clear-filters")).toBeNull();
    fireEvent.change(screen.getByTestId("events-f-amount"), {
      target: { value: "5000" },
    });
    expect(matchedCount(container)).toBeLessThan(before);
    fireEvent.click(screen.getByTestId("events-clear-filters"));
    expect(matchedCount(container)).toBe(before);
    // The sort survives a filter clear
    expect(
      container
        .querySelector(".rpt-events-hrow th:nth-child(6)")!
        .getAttribute("aria-sort"),
    ).toBe("descending");
  });
});
