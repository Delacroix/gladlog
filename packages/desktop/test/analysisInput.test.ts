import { ensureAnalysisData, SNAPSHOT_KINDS } from "@gladlog/analysis";
import { beforeAll, describe, expect, it } from "vitest";

import {
  type AnalysisRunInput,
  buildAnalysisInput,
  buildDeepenPacks,
} from "../src/renderer/src/report/derive/analysisInput";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // Precondition contract for the driver/panel: the tables must be ready
  // before building (spell names in the prompt may never degrade)
  await ensureAnalysisData();
});

describe("buildAnalysisInput(panel 与批量共享的输入构建)", () => {
  it("真 fixture 构建成功:owner 解析、candidates、richContext、spec 齐全", () => {
    const input = buildAnalysisInput(m, "fix-1");
    expect(input).not.toBeNull();
    expect(input!.matchId).toBe("fix-1");
    expect(Array.isArray(input!.candidates)).toBe(true);
    expect(input!.richContext.length).toBeGreaterThan(0);
    expect(input!.spec.length).toBeGreaterThan(0);
    expect(input!.ownerName.length).toBeGreaterThan(0);
    expect(input!.enemySpecs.length).toBeGreaterThan(0);
  });

  it("坏 source 不抛,返回 null(批量循环据此计 failed 不中断)", () => {
    expect(
      buildAnalysisInput({ units: null } as unknown as typeof m, "bad"),
    ).toBeNull();
  });

  it("buildDeepenPacks 对空 findings 返回空数组且不抛", () => {
    const input = buildAnalysisInput(m, "fix-1")!;
    expect(buildDeepenPacks(m, [], input.candidates, input.ownerName)).toEqual(
      [],
    );
  });
});

// Task 4 (moment 深挖 renderer 接线): buildDeepenPacks 透传 opts.snapshot 给
// buildDeepDivePack/buildOffensiveDeepDivePack(Task 2 已接好 opts,这里只测
// renderer 侧透传没有漏)。45–60s 是 windowAnalysis.test.tsx 已核实的
// survival 类信号窗(SIGNAL_RANGE)——同一 fixture、同一判据,借用避免重新扫描。
describe("buildDeepenPacks opts.snapshot 透传(Task 4)", () => {
  const SIGNAL_FROM_S = 45;
  const SIGNAL_TO_S = 60;

  function buildSignalFinding(candidates: AnalysisRunInput["candidates"]) {
    const eventIds = candidates
      .filter((c) => c.t >= SIGNAL_FROM_S && c.t <= SIGNAL_TO_S)
      .map((c) => c.id);
    return {
      eventIds,
      severity: "high" as const,
      category: "window",
      title: "",
      explanation: "",
    };
  }

  it("snapshot:true → 生成的 pack.items 含快照 kind(SNAPSHOT_KINDS);不传 opts 与显式 {snapshot:false} deep-equal(现状不变)", () => {
    const input = buildAnalysisInput(m, "fix-1")!;
    const finding = buildSignalFinding(input.candidates);
    expect(finding.eventIds.length).toBeGreaterThan(0);

    const snapPacks = buildDeepenPacks(
      m,
      [finding],
      input.candidates,
      input.ownerName,
      { snapshot: true },
    );
    expect(snapPacks.length).toBeGreaterThan(0);
    const hasSnapshotKind = snapPacks.some((p) =>
      p.items.some((it) => SNAPSHOT_KINDS.has(it.kind)),
    );
    expect(hasSnapshotKind).toBe(true);

    const noOpts = buildDeepenPacks(
      m,
      [finding],
      input.candidates,
      input.ownerName,
    );
    const explicitFalse = buildDeepenPacks(
      m,
      [finding],
      input.candidates,
      input.ownerName,
      { snapshot: false },
    );
    expect(noOpts).toEqual(explicitFalse);
    // Non-snapshot behaviour must stay free of snapshot-kind items (otherwise
    // the "unchanged when no opts" claim would be vacuous).
    const noOptsHasSnapshotKind = noOpts.some((p) =>
      p.items.some((it) => SNAPSHOT_KINDS.has(it.kind)),
    );
    expect(noOptsHasSnapshotKind).toBe(false);
  });
});
