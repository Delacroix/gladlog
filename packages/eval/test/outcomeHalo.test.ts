import { describe, expect, it } from "vitest";

import { redactOutcomeLabels } from "../src/halo/redactOutcome.js";

// 头行格式锚定 buildMatchContext.ts:802 的渲染模板(共享谓词:eval 重新解析
// analysis 渲染文本;模板改了这里必须跟着红)。
const header = (result: string) =>
  [
    "ARENA MATCH — DECISION ANALYSIS REQUEST",
    "",
    "MATCH SUMMARY",
    `  Spec: Holy Paladin (Healer)  |  Bracket: 3v3  |  Result: ${result}  |  Duration: 2:19  |  Map: Ruins of Lordaeron`,
    "  My team: Holy Paladin, Assassination Rogue, Arms Warrior",
    "  Deaths: Holy Paladin (my team, 1:55)",
    "",
  ].join("\n");

describe("redactOutcomeLabels", () => {
  it("Win → Unknown,仅该 token 变化,其余字节不变", () => {
    const input = header("Win") + "SUPPORTING DATA\n  0:12 something\n";
    const out = redactOutcomeLabels(input);
    expect(out.result).toBe("Win");
    expect(out.text).toBe(
      header("Unknown") + "SUPPORTING DATA\n  0:12 something\n",
    );
  });

  it("Loss → Unknown", () => {
    const out = redactOutcomeLabels(header("Loss"));
    expect(out.result).toBe("Loss");
    expect(out.text).toBe(header("Unknown"));
  });

  it("零个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels("no label here\n")).toThrow(/exactly 1/);
  });

  it("多个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels(header("Win") + header("Loss"))).toThrow(
      /exactly 1/,
    );
  });

  it("Result: Unknown(已无果,无从涂抹)→ throw", () => {
    expect(() => redactOutcomeLabels(header("Unknown"))).toThrow(/unusable/);
  });

  it("正文含其他显式赛果措辞 → throw(最小干预失效守卫)", () => {
    expect(() =>
      redactOutcomeLabels(header("Win") + "a well-earned victory\n"),
    ).toThrow(/outcome wording/);
  });
});
