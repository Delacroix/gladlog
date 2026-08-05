// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { ensureAnalysisData } from "@gladlog/analysis";

import * as analysisInputModule from "../src/renderer/src/report/derive/analysisInput";
import { StructuredAnalysisPanel } from "../src/renderer/src/report/components/StructuredAnalysisPanel";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

// buildDeepenPacks itself is unmocked (Task 4's analysisInput.test.ts already
// covers its opts.snapshot pass-through into the pack builders) — here we
// only need to observe what StructuredAnalysisPanel's automatic deepen effect
// passes as the 5th argument, wired to the deepDiveSnapshot setting (Task 6).
vi.mock(
  "../src/renderer/src/report/derive/analysisInput",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/renderer/src/report/derive/analysisInput")
      >();
    return { ...actual, buildDeepenPacks: vi.fn(actual.buildDeepenPacks) };
  },
);

beforeAll(async () => {
  // Precondition contract for building the pack: prompt spell names must
  // never degrade (same as analysisInput.test.ts).
  await ensureAnalysisData();
});

beforeEach(() => {
  (
    analysisInputModule.buildDeepenPacks as ReturnType<typeof vi.fn>
  ).mockClear();
});

function installFixtureBridge(deepDiveSnapshot: boolean | undefined) {
  const deepen = vi.fn().mockResolvedValue(undefined);
  (window as any).__gladlogFixture = {
    settings: {
      get: vi.fn().mockResolvedValue({ aiLanguage: "zh", deepDiveSnapshot }),
      save: vi.fn().mockResolvedValue({}),
    },
    analysis: {
      // A fresh object literal per call (not mockResolvedValue's single shared
      // reference): the panel's [matchId, lang] reset effect re-fetches once
      // more after the async settings.get() resolves lang from null -> "zh",
      // and React bails out of re-rendering a setState call whose value is
      // reference-identical to the current state — with a shared reference
      // that second resolve would silently no-op, leaving resultForRef's
      // synchronous reset-to-null (top of that same effect) as the last write
      // the deepen effect ever observes. Real IPC always deserializes a new
      // object, so this only matters for the mock.
      getState: vi.fn(async () => ({
        cached: {
          findings: [
            {
              eventIds: [],
              severity: "high",
              category: "window",
              title: "示例发现",
              explanation: "示例说明",
            },
          ],
          dropped: 0,
          hadNarration: true,
          deepened: false,
        },
        running: false,
        slots: [{ key: "k1", createdAt: Date.now(), stale: false }],
        activeKey: "k1",
      })),
      getCached: vi.fn().mockResolvedValue(null),
      run: vi.fn(),
      cancel: vi.fn(),
      onDone: () => () => {},
      onError: () => () => {},
      deepen,
    },
  };
  return deepen;
}

describe("StructuredAnalysisPanel 自动深挖轮 deepDiveSnapshot 设置传参(SDD 2026-08-05 Task 6)", () => {
  it("settings.deepDiveSnapshot=true → buildDeepenPacks 收到第五参 {snapshot:true}", async () => {
    installFixtureBridge(true);
    render(<StructuredAnalysisPanel source={m} matchId="deep-snap-on" />);
    await waitFor(() =>
      expect(analysisInputModule.buildDeepenPacks).toHaveBeenCalled(),
    );
    const call = (
      analysisInputModule.buildDeepenPacks as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(call[4]).toEqual({ snapshot: true });
  });

  it("settings.deepDiveSnapshot=false → buildDeepenPacks 收到第五参 {snapshot:false}", async () => {
    installFixtureBridge(false);
    render(<StructuredAnalysisPanel source={m} matchId="deep-snap-off" />);
    await waitFor(() =>
      expect(analysisInputModule.buildDeepenPacks).toHaveBeenCalled(),
    );
    const call = (
      analysisInputModule.buildDeepenPacks as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(call[4]).toEqual({ snapshot: false });
  });

  it("settings.deepDiveSnapshot 缺省(旧 stub/未加载)→ 视为 false,不因严格 undefined 判断而漏挡", async () => {
    installFixtureBridge(undefined);
    render(<StructuredAnalysisPanel source={m} matchId="deep-snap-unset" />);
    await waitFor(() =>
      expect(analysisInputModule.buildDeepenPacks).toHaveBeenCalled(),
    );
    const call = (
      analysisInputModule.buildDeepenPacks as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(call[4]).toEqual({ snapshot: false });
  });
});
