// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VideoDock } from "./VideoDock";

const T0 = 1_750_000_000_000;

function stubBridge(
  rec: { url: string; startedAt: number; stoppedAt: number } | null,
) {
  (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
    recorder: { getForMatch: async () => rec },
  };
}

describe("VideoDock", () => {
  it("无关联录像 → 不渲染", async () => {
    stubBridge(null);
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("有录像 → 渲染 video,src 用 vod url,currentTime 对齐锚点", async () => {
    stubBridge({
      url: "vod://v/dG9rZW4",
      startedAt: T0 - 10_000,
      stoppedAt: T0 + 60_000,
    });
    render(<VideoDock matchId="m1" t={T0} playing={false} speed={1} />);
    const video = (await screen.findByTestId(
      "video-dock-el",
    )) as HTMLVideoElement;
    expect(video.src).toContain("vod://");
    // (T0 - (T0-10s))/1000 = 10
    await waitFor(() => expect(video.currentTime).toBeCloseTo(10, 1));
  });

  it("bridge 桩缺 recorder 面 → 静默不渲染(不抛)", async () => {
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {};
    const { container } = render(
      <VideoDock matchId="m1" t={T0} playing={false} speed={1} />,
    );
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
