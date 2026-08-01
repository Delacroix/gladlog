// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { KeyMoment } from "../derive/keyMoments";
import { KeyMomentAxis } from "./KeyMomentAxis";

// #10 T4: position kind 进 KIND_ICON/KIND_ZH(禁 emoji,用文字字形 ⇄ /「走位」),
// 点击走位 minor 节点触发 onSeek(jumpT, unitNames)。
const positionMoment: KeyMoment = {
  t: 12,
  kind: "position",
  weight: "minor",
  side: "friendly",
  title: "该压没压",
  detail: ">30yd 脱节",
  unitNames: ["PlayerB-Test"],
  jumpT: 12,
};

describe("KeyMomentAxis — position kind (#10 T4)", () => {
  it("走位事件用 ⇄ 图标渲染,点击触发 onSeek(jumpT, unitNames)", () => {
    const onSeek = vi.fn();
    render(
      <KeyMomentAxis
        moments={[positionMoment]}
        findings={[]}
        candidates={[]}
        onSeek={onSeek}
        onSelectEvidence={vi.fn()}
      />,
    );
    const node = screen.getByTestId("axis-node-minor");
    expect(node.textContent).toContain("⇄");
    expect(node.textContent).toContain("该压没压");
    node.click();
    expect(onSeek).toHaveBeenCalledWith(12, ["PlayerB-Test"]);
  });
});
