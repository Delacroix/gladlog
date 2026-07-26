import { describe, expect, it } from "vitest";

import type { CandidateEvent } from "../analysis/types";
import { habitBadgeText, ruleAppliesToFinding } from "./matchRules";
import type { LearnedRule } from "./types";

const rule = (over: Partial<LearnedRule> = {}): LearnedRule => ({
  ruleId: "cat:survival|type:death",
  status: "active",
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  stats: { windowMatches: 20, hits: 9, firstSeen: 1, lastSeen: 2, trend: [] },
  description: {},
  advice: {},
  evidence: [],
  distilledAt: 0,
  distillModel: "",
  ...over,
});

const cands: CandidateEvent[] = [
  { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
  { id: "e2", type: "cd-waste", t: 0, unitNames: ["A"], facts: {} },
];
const meta = { enemySpecs: [62] };

describe("ruleAppliesToFinding", () => {
  it("category+type 命中 → true;type 不匹配 → false", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(ruleAppliesToFinding(rule(), f, cands, meta)).toBe(true);
    expect(
      ruleAppliesToFinding(
        rule(),
        { category: "survival", eventIds: ["e2"] },
        cands,
        meta,
      ),
    ).toBe(false);
  });

  it("improved 规则不打徽章;条件不满足不打", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(
      ruleAppliesToFinding(rule({ status: "improved" }), f, cands, meta),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 71 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 62 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(true);
  });

  it("category 级规则(eventTypes=[])对同类 finding 恒命中", () => {
    const f = { category: "survival", eventIds: ["e2"] };
    expect(ruleAppliesToFinding(rule({ eventTypes: [] }), f, cands, meta)).toBe(
      true,
    );
  });
});

describe("habitBadgeText", () => {
  it("确定性、双语、数字来自 stats", () => {
    expect(habitBadgeText(rule(), "zh")).toBe("惯性问题 · 近 20 场已犯 9 次");
    expect(habitBadgeText(rule(), "en")).toBe(
      "Recurring · 9 of last 20 matches",
    );
  });
});
