// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";

import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

describe("MatchReport externalSeek 受控跳转 prop(评审工作台驱动回放)", () => {
  it("externalSeek prop switches to replay view at the given time", async () => {
    const { MatchReport } =
      await import("../src/renderer/src/report/components/MatchReport");
    const { rerender, container } = render(
      <MatchReport source={m} matchId="t" externalSeek={null} />,
    );
    rerender(
      <MatchReport
        source={m}
        matchId="t"
        externalSeek={{ tSeconds: 42, unitNames: ["Foo"], nonce: 1 }}
      />,
    );
    await waitFor(() => {
      expect(
        container.querySelector(".rpt-view-tabs button.active")?.textContent,
      ).toContain("回放");
    });
  });

  it("不传 externalSeek(默认 null)时行为不变——仍停在 report 视图", async () => {
    const { MatchReport } =
      await import("../src/renderer/src/report/components/MatchReport");
    const { container } = render(<MatchReport source={m} matchId="t" />);
    expect(
      container.querySelector(".rpt-view-tabs button.active")?.textContent,
    ).toContain("战报");
  });
});
