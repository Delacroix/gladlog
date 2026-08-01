// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRealMatchFixture } from "../../../../../test/fixtures/loadFixture";
import type { ReportSource } from "../derive/types";
import { VideoTab } from "./VideoTab";

const source = loadRealMatchFixture() as unknown as ReportSource;
// startedAt = source.startTime → offsetS = 0,endS = (endTime-startTime)/1000 = 90
const startedAt = source.startTime;
const endS = (source.endTime - startedAt) / 1000;

let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;

beforeAll(() => {
  // jsdom 不实现媒体回放,<video>.play()/.pause() 默认抛 "not implemented"。
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

beforeEach(() => {
  playSpy = HTMLMediaElement.prototype.play as unknown as ReturnType<
    typeof vi.fn
  >;
  pauseSpy = HTMLMediaElement.prototype.pause as unknown as ReturnType<
    typeof vi.fn
  >;
  playSpy.mockClear();
  pauseSpy.mockClear();
  (window as any).__gladlogFixture = {
    analysis: {
      getCached: vi.fn().mockResolvedValue(null),
      onDone: () => () => {},
    },
  };
});

/** loadedmetadata 触发一次 seek(offsetS) + duration 采样(见 VideoTab 的
 * seek 效果)——jsdom 不会自动派发,测试手动补一次。 */
function fireLoadedMetadata(video: HTMLVideoElement, durationS: number) {
  Object.defineProperty(video, "duration", {
    configurable: true,
    value: durationS,
  });
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: 1,
  });
  fireEvent.loadedMetadata(video);
}

describe("VideoTab 自定义控制条(按轮 clamp)", () => {
  it("不再是原生 controls;渲染播放/静音按钮 + 进度 range(min/max = 本轮范围)", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(".rpt-video-tab video")!;
    expect(video).toBeTruthy();
    expect(video.hasAttribute("controls")).toBe(false);

    fireLoadedMetadata(video as HTMLVideoElement, 200); // 录像比本轮长
    const range = container.querySelector(
      ".rpt-video-ctrl-range",
    ) as HTMLInputElement;
    expect(range).toBeTruthy();
    expect(Number(range.min)).toBeCloseTo(0);
    expect(Number(range.max)).toBeCloseTo(endS);
  });

  it("endS 额外夹到已知的视频 duration(录像比本轮结束得早)", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 30); // 比 endS(90s)短
    const range = container.querySelector(
      ".rpt-video-ctrl-range",
    ) as HTMLInputElement;
    expect(Number(range.max)).toBeCloseTo(30);
  });

  it("timeupdate 越过终点:暂停 + 吸附回 endS", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: endS + 5,
    });
    fireEvent.timeUpdate(video);
    expect(pauseSpy).toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(endS);
  });

  it("timeupdate 早于起点(容差外):吸附回 startS", () => {
    const { container } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: -5,
    });
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(0);
  });

  it("播放/暂停按钮驱动 video.play/pause,label 随 play/pause 事件翻转", () => {
    const { container, getByLabelText } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    const btn = getByLabelText("播放");
    fireEvent.click(btn);
    expect(playSpy).toHaveBeenCalled();
    fireEvent.play(video);
    expect(getByLabelText("暂停")).toBeTruthy();
    fireEvent.click(getByLabelText("暂停"));
    expect(pauseSpy).toHaveBeenCalled();
    fireEvent.pause(video);
    expect(getByLabelText("播放")).toBeTruthy();
  });

  it("静音按钮切换 video.muted + label", () => {
    const { container, getByLabelText } = render(
      <VideoTab url="vod://x" startedAt={startedAt} source={source} />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    const btn = getByLabelText("静音");
    fireEvent.click(btn);
    expect(video.muted).toBe(true);
    expect(getByLabelText("取消静音")).toBeTruthy();
  });
});
