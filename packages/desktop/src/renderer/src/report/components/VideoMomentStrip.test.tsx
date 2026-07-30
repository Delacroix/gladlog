// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StripMark } from "./VideoMomentStrip";
import { VideoMomentStrip } from "./VideoMomentStrip";
import type { VideoMoment } from "../derive/videoMoments";

const mm = (kind: VideoMoment["kind"], weight: VideoMoment["weight"]) =>
  ({ tS: 0, kind, weight, label: "x", unitNames: [] }) as VideoMoment;

describe("VideoMomentStrip", () => {
  it("major 点标 + 爆发金带渲染;minor 不进条;点击回调视频秒", () => {
    const onSeek = vi.fn();
    const marks: StripMark[] = [
      { videoS: 10, moment: mm("death", "major") },
      { videoS: 20, moment: mm("mistake", "major") },
      { videoS: 30, moment: mm("dispel", "minor") }, // 不进条
      { videoS: 40, toVideoS: 55, moment: mm("burst-band", "major") },
    ];
    const { container } = render(
      <VideoMomentStrip marks={marks} durationS={100} onSeek={onSeek} />,
    );
    expect(container.querySelectorAll(".rpt-video-strip-mark")).toHaveLength(2);
    expect(container.querySelectorAll(".rpt-video-strip-band")).toHaveLength(1);
    fireEvent.click(container.querySelector(".rpt-video-strip-death")!);
    expect(onSeek).toHaveBeenCalledWith(10);
  });

  it("duration 未知(0/NaN)→ 不渲染", () => {
    const { container } = render(
      <VideoMomentStrip marks={[]} durationS={0} onSeek={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
