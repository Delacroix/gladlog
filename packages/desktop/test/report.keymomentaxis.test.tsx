// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KeyMomentAxis } from "../src/renderer/src/report/components/KeyMomentAxis";
import type { KeyMoment } from "../src/renderer/src/report/derive/keyMoments";

const moments: KeyMoment[] = [
  {
    t: 10,
    kind: "defensive",
    weight: "minor",
    side: "friendly",
    title: "交饰品",
    unitNames: ["A"],
    jumpT: 10,
  },
  {
    t: 90,
    kind: "death",
    weight: "major",
    side: "friendly",
    title: "阵亡",
    unitNames: ["B"],
    jumpT: 90,
  },
];
const candidates = [
  { id: "e1", type: "death", t: 41, unitNames: ["B"], facts: {} },
] as never[];
const findings = [
  {
    eventIds: ["e1"],
    severity: "high",
    category: "survival",
    title: "被秒",
    explanation: "x",
  },
  {
    eventIds: ["nope"],
    severity: "low",
    category: "cooldowns",
    title: "整场未用",
    explanation: "y",
  },
] as never[];

const minorAt = (t: number, title: string, kind: KeyMoment["kind"] = "cc") =>
  ({
    t,
    kind,
    weight: "minor",
    side: "friendly",
    title,
    unitNames: ["A"],
    jumpT: t,
  }) satisfies KeyMoment;

describe("KeyMomentAxis", () => {
  it("按 t 归并排序,finding 挂在解析出的时刻;minor 时刻降为小字行", () => {
    render(
      <KeyMomentAxis
        moments={moments}
        findings={findings}
        candidates={candidates}
        onSelectEvidence={() => {}}
      />,
    );
    // major nodes: the 41s finding + the 90s death; the 10s trinket is a
    // minor small-text row
    const nodes = screen.getAllByTestId("axis-node");
    expect(nodes.length).toBe(2);
    expect(nodes[0]!.textContent).toContain("被秒");
    expect(screen.getAllByTestId("axis-node-minor").length).toBe(1);
    expect(screen.queryByText("整场未用")).toBeNull();
    // severity is mapped on the render side (zh by default); category is
    // passed through unchanged
    expect(screen.getByText(/高 · 生存/)).toBeTruthy();
  });

  it("相邻 >30s 插省略标;点击节点回调 onSeek(minor 同契约)", () => {
    const onSeek = vi.fn();
    render(
      <KeyMomentAxis
        moments={moments}
        findings={[]}
        candidates={[]}
        onSeek={onSeek}
        onSelectEvidence={() => {}}
      />,
    );
    expect(screen.getAllByTestId("axis-gap").length).toBe(1); // 10→90 = 80s
    fireEvent.click(screen.getAllByTestId("axis-node-minor")[0]!);
    expect(onSeek).toHaveBeenCalledWith(10, ["A"]);
  });

  it("同类 minor 连发(间隔 ≤5s)折叠为一条,点击跳第一条", () => {
    const onSeek = vi.fn();
    render(
      <KeyMomentAxis
        moments={[
          minorAt(10, "被控:变形术"),
          minorAt(13, "被控:寒冰陷阱"),
          minorAt(15, "被控:恐惧"),
          minorAt(40, "被控:独立一条"), // gap >5s, not merged in
        ]}
        findings={[]}
        candidates={[]}
        onSeek={onSeek}
        onSelectEvidence={() => {}}
      />,
    );
    const minors = screen.getAllByTestId("axis-node-minor");
    expect(minors.length).toBe(2);
    expect(minors[0]!.textContent).toContain("控制 ×3");
    expect(minors[0]!.getAttribute("title")).toContain("恐惧");
    fireEvent.click(minors[0]!);
    expect(onSeek).toHaveBeenCalledWith(10, ["A"]);
  });

  it("长局阀门:条目 >40 时 minor 段收成「+N 次要时刻」,点击展开", () => {
    // 60 non-clustering minors (alternating kind, 6s apart) + 1 major
    const many: KeyMoment[] = Array.from({ length: 60 }, (_, i) =>
      minorAt(i * 6, `t${i}`, i % 2 ? "cc" : "defensive"),
    );
    many.push({
      t: 400,
      kind: "death",
      weight: "major",
      side: "friendly",
      title: "阵亡",
      unitNames: ["B"],
      jumpT: 400,
    });
    render(
      <KeyMomentAxis
        moments={many}
        findings={[]}
        candidates={[]}
        onSelectEvidence={() => {}}
      />,
    );
    const more = screen.getAllByTestId("axis-more");
    expect(more.length).toBe(1);
    expect(more[0]!.textContent).toContain("+60 次要时刻");
    expect(screen.queryAllByTestId("axis-node-minor").length).toBe(0);
    fireEvent.click(more[0]!);
    expect(screen.getAllByTestId("axis-node-minor").length).toBe(60);

    // Once expanded it must be collapsible again (this used to be a one-way
    // door: open it and you could never go back)
    const collapse = screen.getByTestId("axis-collapse");
    fireEvent.click(collapse);
    expect(screen.queryAllByTestId("axis-node-minor").length).toBe(0);
    expect(screen.getAllByTestId("axis-more")[0]!.textContent).toContain(
      "+60 次要时刻",
    );
  });

  it("heal-gap 作为 minor 节点渲染(#10 T3;KIND_ICON/KIND_ZH 已补齐)", () => {
    const onSeek = vi.fn();
    render(
      <KeyMomentAxis
        moments={[minorAt(10, "治疗空窗 5.0s", "heal-gap")]}
        findings={[]}
        candidates={[]}
        onSeek={onSeek}
        onSelectEvidence={() => {}}
      />,
    );
    const minor = screen.getByTestId("axis-node-minor");
    expect(minor.textContent).toContain("治疗空窗 5.0s");
    expect(minor.className).toContain("k-heal-gap");
    fireEvent.click(minor);
    expect(onSeek).toHaveBeenCalledWith(10, ["A"]);
  });

  it("22s 短局(条目 ≤40)不触发阀门", () => {
    render(
      <KeyMomentAxis
        moments={[minorAt(1, "a"), minorAt(10, "b", "defensive")]}
        findings={[]}
        candidates={[]}
        onSelectEvidence={() => {}}
      />,
    );
    expect(screen.queryAllByTestId("axis-more").length).toBe(0);
  });
});
