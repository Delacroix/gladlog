// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
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

describe("VideoTab AI 结果进 feed/strip", () => {
  // 真实 fixture 的候选事件(见 test/fixtures/real-match-sample.json 派生):
  // buildAnalysisInput 用它构建 candidates,facts.t 都存在(timed)。
  const TIMED_EVENT_ID = "missed-cleanse:Player6-Test:61";
  const TIMED_T = 60.703;

  it("时间轴 finding(与 splitFindings 同一谓词)映射为 chip,连同 deepDive chips 一起画进标记条", async () => {
    const getCached = vi.fn().mockResolvedValue({
      findings: [
        {
          eventIds: [TIMED_EVENT_ID],
          severity: "med",
          category: "dispel",
          title: "未清除持续伤害",
          explanation: "……",
        },
        {
          // eventIds 命中不到任何候选:resolveJumpTarget 返回 null,静默丢弃
          eventIds: ["no-such-id"],
          severity: "low",
          category: "x",
          title: "不该出现",
          explanation: "……",
        },
      ],
    });
    (window as any).__gladlogFixture = {
      analysis: { getCached, onDone: () => () => {} },
    };
    const { container } = render(
      <VideoTab
        url="vod://x"
        startedAt={startedAt}
        source={source}
        matchId="m1"
      />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    await vi.waitFor(() => {
      const el = container.querySelector(".rpt-video-strip-ai");
      expect(el).toBeTruthy();
    });
    expect(container.querySelectorAll(".rpt-video-strip-ai")).toHaveLength(1);
    // 换算到视频秒(offsetS=0 场景下等于原始秒);标记条按本轮窗口
    // [offsetS, endS](=[0, 90])收窄横轴,不是整段录像 duration(200)。
    const mark = container.querySelector(".rpt-video-strip-ai") as HTMLElement;
    expect(Number.parseFloat(mark.style.left)).toBeCloseTo(
      (TIMED_T / endS) * 100,
      1,
    );
  });

  it("analysis.onDone(matchId 匹配)触发重新拉取,新结果补进标记条", async () => {
    const getCached = vi.fn().mockResolvedValue(null);
    let doneCb: ((d: { matchId: string; result: unknown }) => void) | null =
      null;
    (window as any).__gladlogFixture = {
      analysis: {
        getCached,
        onDone: (cb: typeof doneCb) => {
          doneCb = cb;
          return () => {
            doneCb = null;
          };
        },
      },
    };
    const { container } = render(
      <VideoTab
        url="vod://x"
        startedAt={startedAt}
        source={source}
        matchId="m1"
      />,
    );
    const video = container.querySelector(
      ".rpt-video-tab video",
    ) as HTMLVideoElement;
    fireLoadedMetadata(video, 200);
    await vi.waitFor(() => expect(getCached).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".rpt-video-strip-ai")).toBeNull();

    getCached.mockResolvedValue({
      findings: [
        {
          eventIds: [TIMED_EVENT_ID],
          severity: "med",
          category: "dispel",
          title: "未清除持续伤害",
          explanation: "……",
        },
      ],
    });
    await act(async () => {
      doneCb!({ matchId: "m1", result: {} });
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".rpt-video-strip-ai")).toBeTruthy();
    });

    // 不是当前场次的 onDone 不该触发刷新(matchId 守卫)。
    getCached.mockClear();
    await act(async () => {
      doneCb!({ matchId: "other-match", result: {} });
    });
    expect(getCached).not.toHaveBeenCalled();
  });
});
