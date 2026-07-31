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

function installFixtureBridge() {
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
      // 挂起不 resolve:本文件只测「切回合后 UI 状态是否复位」,不测响应竞态
      // (响应竞态见 windowAnalysis.test.tsx 的 matchId 守卫测)。
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
  };
}

beforeEach(() => {
  installFixtureBridge();
});

/** 两轮 Solo Shuffle,内容克隆自同一真实对局(事件时间戳未平移,渲染稳定)
 * 但 id 各不相同 —— 真实场景里 shuffle 各轮的 matchId 是每轮内容哈希,决不
 * 会相同(见 ShuffleReport.tsx 注释)。旧版 loadFixture.buildSyntheticShuffle
 * 未区分 id,这里单独构造以覆盖 key={round.id} 这条防线。 */
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
  it("切换回合会重挂载 MatchReport,不残留上一轮的时间窗/选段 AI 状态", async () => {
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

    // 组件若被复用(无 key),窗口选择与选段卡会原样留在 Round 2 页面上——
    // 加 key={round.id} 后应重挂载、这两处 state 清空归零。
    expect(screen.queryByTestId("time-range-chip")).toBeNull();
    expect(screen.queryByTestId("window-ai-card")).toBeNull();
  });
});
