// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";

import { ReplayView } from "../src/renderer/src/report/components/ReplayView";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

describe("回放缩放(用户反馈:人堆看不清)", () => {
  it("滚轮放大改 viewBox,复位按钮出现并可还原;双击也复位", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const before = svg.getAttribute("viewBox")!;
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    const after = svg.getAttribute("viewBox")!;
    expect(after).not.toBe(before);
    expect(svg.getAttribute("class")).toContain("zoomed");
    // Reset button
    const reset = container.querySelector(".rpt-replay-zoom-reset")!;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    expect(svg.getAttribute("viewBox")).toBe(before);
    // Zoom in again, then double-click to reset
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    expect(svg.getAttribute("viewBox")).not.toBe(before);
    fireEvent.dblClick(svg);
    expect(svg.getAttribute("viewBox")).toBe(before);
  });

  it("缩小到全景即退出缩放态(viewBox 回满幅,无复位按钮)", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const before = svg.getAttribute("viewBox")!;
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    fireEvent.wheel(svg, {
      deltaY: 100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    fireEvent.wheel(svg, {
      deltaY: 100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    expect(svg.getAttribute("viewBox")).toBe(before);
    expect(container.querySelector(".rpt-replay-zoom-reset")).toBeNull();
  });
});

describe("滚轮判定表(Windows 鼠标也要能用)", () => {
  it("全景态裸滚轮不拦截,交给页面滚动", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const before = svg.getAttribute("viewBox")!;
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      svg.dispatchEvent(ev);
    });
    // Both must hold: no zoom happened, AND the event was not swallowed — the
    // latter is what keeps the map from becoming a scroll black hole
    expect(svg.getAttribute("viewBox")).toBe(before);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("已缩放态裸滚轮接管缩放", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const panorama = svg.getAttribute("viewBox")!;
    // First enter the zoomed state with ⌘
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      metaKey: true,
    });
    const zoomed = svg.getAttribute("viewBox")!;
    expect(zoomed).not.toBe(panorama);
    // Then a bare wheel should keep zooming and swallow the event
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      svg.dispatchEvent(ev);
    });
    expect(svg.getAttribute("viewBox")).not.toBe(zoomed);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("热区覆盖 SVG 两侧留白(wrapper 上的滚轮也生效)", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const cell = container.querySelector(".rpt-replay-map-cell")!;
    const before = svg.getAttribute("viewBox")!;
    fireEvent.wheel(cell, {
      deltaY: -100,
      clientX: 10,
      clientY: 10,
      metaKey: true,
    });
    expect(svg.getAttribute("viewBox")).not.toBe(before);
  });
});

describe("缩放语义:地图放大,标记恒定屏幕尺寸(用户反馈:整幅等比缩放让图标跟着变大)", () => {
  it("放大后单位标记半径按 k=view.w/VW 缩小,全景态(k=1)与改动前一致", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const marker = container.querySelector("[data-testid=rpt-unit-marker]")!;
    // Panorama state: k=1, so the radius must be the original constant 13 —
    // direct evidence that the pixel-for-pixel baseline is unchanged
    const panoramaViewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    const VW = panoramaViewBox[2]!;
    expect(Number(marker.getAttribute("r"))).toBeCloseTo(13, 6);

    // ⌘/Ctrl + wheel zooms in (factor 0.8 → view.w narrows → k<1)
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
    });
    const zoomedViewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    const k = zoomedViewBox[2]! / VW;
    expect(k).toBeLessThan(1);
    // The marker radius must shrink inversely with k (constant on-screen size),
    // not stay unchanged
    expect(Number(marker.getAttribute("r"))).toBeCloseTo(13 * k, 6);
  });
});

describe("缩放按钮(+/-)", () => {
  it("点击+按钮放大,点击-按钮缩小到全景并隐藏复位按钮", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const panorama = svg.getAttribute("viewBox")!;

    // Click the + button to zoom in
    const zoomButtons = container.querySelectorAll(".rpt-replay-zoom-btn");
    const zoomInBtn = zoomButtons[0];
    fireEvent.click(zoomInBtn);
    const zoomed = svg.getAttribute("viewBox")!;
    expect(zoomed).not.toBe(panorama);

    // The reset button should appear
    const resetBtn = container.querySelector(".rpt-replay-zoom-reset");
    expect(resetBtn).toBeTruthy();

    // Click the - button to zoom back out to panorama
    const zoomOutBtn = zoomButtons[1];
    fireEvent.click(zoomOutBtn);
    expect(svg.getAttribute("viewBox")).toBe(panorama);

    // The reset button should disappear
    expect(container.querySelector(".rpt-replay-zoom-reset")).toBeNull();
  });
});
