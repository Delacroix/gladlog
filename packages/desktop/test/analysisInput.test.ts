import { ensureAnalysisData } from "@gladlog/analysis";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildAnalysisInput,
  buildDeepenPacks,
} from "../src/renderer/src/report/derive/analysisInput";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

beforeAll(async () => {
  // 驱动器/panel 的前置契约:构建前表必须就绪(提示词法术名不许降级)
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
