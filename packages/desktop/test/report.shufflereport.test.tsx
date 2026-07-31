// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ensureAnalysisData } from "@gladlog/analysis";

import { ShuffleReport } from "../src/renderer/src/report/components/ShuffleReport";
import type { StoredShuffle } from "../src/renderer/src/report/derive/types";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 构包前置契约:prompt 法术名不许降级(同 windowAnalysis.test.tsx)。
  await ensureAnalysisData();
});

function installFixtureBridge(recorder?: {
  getForMatch: ReturnType<typeof vi.fn>;
}) {
  (window as any).__gladlogFixture = {
    settings: {
      get: vi.fn().mockResolvedValue({ aiLanguage: "zh" }),
      save: vi.fn().mockResolvedValue({}),
    },
    analysis: {
      getState: vi.fn().mockResolvedValue({ cached: null, running: false }),
      getCached: vi.fn().mockResolvedValue(null),
      run: vi.fn(),
      cancel: vi.fn(),
      onDone: () => () => {},
      onError: () => () => {},
      // 挂起不 resolve:本文件只测「切回合后 UI 状态是否复位/保留」,不测
      // 响应竞态(响应竞态见 windowAnalysis.test.tsx 的 matchId 守卫测)。
      analyzeWindow: vi.fn(() => new Promise(() => {})),
    },
    compare: {
      getCached: vi.fn().mockResolvedValue(null),
      run: vi.fn(),
      cancel: vi.fn(),
      onDelta: () => () => {},
      onDone: () => () => {},
      onError: () => () => {},
    },
    recorder,
  };
}

beforeEach(() => {
  installFixtureBridge();
});

/** 两轮 Solo Shuffle,内容克隆自同一真实对局(事件时间戳未平移,渲染稳定)
 * 但 id 各不相同 —— 真实场景里 shuffle 各轮的 matchId 是每轮内容哈希,决不
 * 会相同(见 ShuffleReport.tsx 注释)。旧版 loadFixture.buildSyntheticShuffle
 * 未区分 id,这里单独构造以覆盖「换局重置」这条防线。 */
function buildTwoRoundShuffle(): StoredShuffle {
  const round0 = {
    ...m,
    kind: "shuffleRound" as const,
    id: `${m.id}-r0`,
    sequenceNumber: 0,
    winningTeamId: 0,
  };
  const round1 = {
    ...m,
    kind: "shuffleRound" as const,
    id: `${m.id}-r1`,
    sequenceNumber: 1,
    winningTeamId: 1,
  };
  return {
    kind: "shuffle",
    rounds: [round0, round1],
    startTime: m.startTime,
    endTime: m.endTime,
    result: m.result,
  };
}

describe("ShuffleReport 换回合(fix:审计 Critical——round-switch 渲染混窗)", () => {
  it("切换回合会清掉上一轮的时间窗/选段 AI 状态(不靠整组件重挂载)", async () => {
    const shuffle = buildTwoRoundShuffle();
    render(<ShuffleReport shuffle={shuffle} />);

    // Round 1:phase 下拉选一个窗口,再点「AI 分析此段」→ loading 卡出现。
    const select = screen
      .getByTestId("time-range-bar")
      .querySelector("select")!;
    fireEvent.change(select, { target: { value: "0" } });
    expect(screen.getByTestId("time-range-chip")).toBeTruthy();
    fireEvent.click(screen.getByTestId("window-ai-btn"));
    expect(await screen.findByTestId("window-ai-card")).toBeTruthy();

    // 切到 Round 2(第二个 tab)。
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(2);
    fireEvent.click(tabs[1]!);

    // MatchReport 内部按 matchId 变化单独清了 timeRange/winAi——这两处不该
    // 残留到 Round 2 页面上。（revert 该清理 effect 后本断言会失败。）
    expect(screen.queryByTestId("time-range-chip")).toBeNull();
    expect(screen.queryByTestId("window-ai-card")).toBeNull();
  });

  it("切换回合不重挂载 MatchReport:当前视图 tab 与共享录像 <video> 原样保留", async () => {
    const shuffle = buildTwoRoundShuffle();
    const getForMatch = vi.fn().mockResolvedValue({
      url: "vod://shared-lobby-recording",
      startedAt: m.startTime,
      stoppedAt: m.endTime,
    });
    installFixtureBridge({ getForMatch });

    render(<ShuffleReport shuffle={shuffle} videoMatchId="lobby-id" />);

    // 6 轮共享同一段 lobby 录像:两轮都应查同一个 videoMatchId,不是各自的
    // round.id —— 这是既有约定,顺带确认没被本次改动破坏。
    await screen.findByText("录像");
    expect(getForMatch).toHaveBeenCalledWith("lobby-id");

    fireEvent.click(screen.getByText("录像"));
    // .rpt-video-tab video 选择器同 MatchReport.initialView.test.tsx 先例。
    await vi.waitFor(() =>
      expect(document.querySelector(".rpt-video-tab video")).toBeTruthy(),
    );
    const videoEl = document.querySelector(".rpt-video-tab video");

    // 切到 Round 2。
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]!);

    // (a) 视图没有跳回默认「战报」——「录像」tab 仍是 active。
    const videoTabBtn = screen.getByText("录像").closest("button")!;
    expect(videoTabBtn.className).toContain("active");

    // (b) <video> 是同一个 DOM 节点(引用相等)——组件没有被卸载重挂载,
    // 只是 videoMatchId 不变、内部按已有的 offsetS 效果重新 seek,不该整段
    // 重新加载/闪烁。若 ShuffleReport 又加回 key={round.id},这里会因为
    // querySelector 拿到全新节点而 !== 失败。
    const videoElAfter = document.querySelector(".rpt-video-tab video");
    expect(videoElAfter).toBe(videoEl);
  });
});
