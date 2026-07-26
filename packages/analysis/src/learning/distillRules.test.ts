import { describe, expect, it } from "vitest";

import {
  auditDistilledRules,
  buildDistillPrompt,
  distillFacts,
} from "./distillRules";
import type { StablePattern } from "./types";

const pat = (id: string): StablePattern => ({
  patternId: id,
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  windowMatches: 20,
  hits: 9,
  firstSeen: 1,
  lastSeen: 2,
  trend: [2, 3, 2, 2],
  exampleMatchIds: ["m1"],
});

describe("auditDistilledRules", () => {
  const patterns = [pat("cat:survival|type:death")];

  it("合规条目通过;占位符能被 distillFacts 插值", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description:
            "近 {{windowMatches}} 场里有 {{hits}} 场存在阵亡类问题。",
          advice: "开大前先看治疗蓝量。",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
    expect(distillFacts(patterns[0]!)).toEqual({
      hits: "9",
      windowMatches: "20",
    });
  });

  it("裸数字 → 丢弃", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "近 20 场里有 9 场存在阵亡类问题。",
          advice: "ok",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/digit/);
  });

  it("未知 patternId / 未知占位符 / 因果断言 → 丢弃;null 输入 → 全空", () => {
    const bad = auditDistilledRules(
      [
        { patternId: "cat:nope", description: "x", advice: "y" },
        {
          patternId: "cat:survival|type:death",
          description: "{{deaths}} 次阵亡",
          advice: "y",
        },
      ],
      patterns,
    );
    expect(bad.texts).toHaveLength(0);
    expect(bad.dropped).toHaveLength(2);
    expect(auditDistilledRules(null, patterns).texts).toHaveLength(0);
  });

  it("同 patternId 重复条目:first-wins", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "第一条",
          advice: "a",
        },
        {
          patternId: "cat:survival|type:death",
          description: "第二条",
          advice: "b",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]!.description).toBe("第一条");
  });

  it("advice 侧裸数字 → 整条丢弃", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "近 {{windowMatches}} 场存在问题。",
          advice: "多开 5 次大招能改善。",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/digit/);
  });

  it("advice 侧因果断言 → 整条丢弃", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "近 {{windowMatches}} 场存在阵亡问题。",
          advice: "you died because you overextended too much.",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/causal/);
  });
});

describe("buildDistillPrompt", () => {
  it("包含 pattern 数据、实例、硬规则与语言指令", () => {
    const p = buildDistillPrompt(
      [pat("cat:survival|type:death")],
      { "cat:survival|type:death": ["死于集火时没开减伤。"] },
      "zh",
    );
    expect(p).toContain("cat:survival|type:death");
    expect(p).toContain("{{hits}}");
    expect(p).toContain("死于集火时没开减伤。");
    expect(p).toContain("Simplified Chinese");
  });
});
