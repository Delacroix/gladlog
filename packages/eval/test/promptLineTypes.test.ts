/**
 * prompt 逐行探针的地基单测 —— 分类、消融、解析、比较四个纯函数。
 *
 * 这些函数是 2026-08-23 逐行效果探针(promptAblationProbe / promptPlantProbe)的
 * 判据本体。探针当天踩了八个坑,其中两个正是这里要钉死的形状:
 *   · 按方括号 grep 把无括号的 `KILL ATTEMPTS —` 段误判成「0% 出现」(实际 100%);
 *   · maxTokens 截断让 JSON 解析失败,空集合把 Jaccard 搅乱。
 */
import { describe, expect, it } from "vitest";

import {
  ABLATABLE,
  ablateLineType,
  citedMoments,
  classifyPromptLine,
  findingKeys,
  jaccard,
  parseFindings,
} from "../src/explore/promptLineTypes";

describe("classifyPromptLine", () => {
  it("方括号标签按标签分", () => {
    expect(
      classifyPromptLine(
        "0:47–0:57  [DMG SPIKE]   2(AWarrior) (Arms Warrior): 0.80M in 10s",
      ),
    ).toBe("[DMG SPIKE]");
    expect(classifyPromptLine("1:01  [STATE] …")).toBe("[STATE]");
  });

  it("无括号的段落标题(KILL ATTEMPTS 的真实形态)归 section-header,不是散文", () => {
    // 2026-08-23:按方括号 grep 曾把这一段误判成「0% 的回合出现」,实际 100%。
    expect(
      classifyPromptLine(
        "KILL ATTEMPTS — team kill attempts (a stun chain, or an offensive-cooldown burst, with real team damage behind it):",
      ),
    ).toBe("(section-header)");
  });

  it("XML / 空行 / 带时间戳无标签 / 散文各归各类", () => {
    expect(
      classifyPromptLine("  <cooldowns>Obsidian Scales [90s]</cooldowns>"),
    ).toBe("(xml)");
    expect(classifyPromptLine("   ")).toBe("(blank)");
    expect(classifyPromptLine("0:15  Riptide → 3(AMage)")).toBe(
      "(timestamped-untagged)",
    );
    expect(classifyPromptLine("You won this match.")).toBe("(prose)");
  });
});

describe("ablateLineType / ABLATABLE", () => {
  const prompt = [
    "PLAYER LOADOUT:",
    "0:47–0:57  [DMG SPIKE]   2(AWarrior): 0.80M in 10s",
    "0:48  [STATE] 2(AWarrior) 63%",
    "1:44–1:54  [DMG SPIKE]   3(AMage): 0.75M in 10s",
    "prose line",
  ].join("\n");

  it("只删指定类型,其余行原样保留(含顺序)", () => {
    const out = ablateLineType(prompt, "[DMG SPIKE]");
    expect(out).toBe(
      ["PLAYER LOADOUT:", "0:48  [STATE] 2(AWarrior) 63%", "prose line"].join(
        "\n",
      ),
    );
  });

  it("结构类不可消融 —— 删掉它们测出的差异无法归因", () => {
    expect(ABLATABLE("[DMG SPIKE]")).toBe(true);
    expect(ABLATABLE("(timestamped-untagged)")).toBe(true);
    for (const k of ["(prose)", "(xml)", "(section-header)", "(blank)"])
      expect(ABLATABLE(k), k).toBe(false);
  });
});

describe("parseFindings", () => {
  const good = `分析正文……
\`\`\`json
{"findings":[{"t":"2:13","topic":"defensive-timing","verdict":"good","claim":"Astral Shift timed well"},{"t":"0:25","topic":"cc-usage","verdict":"bad","claim":"Hex on full-HP target"}]}
\`\`\``;

  it("从围栏 JSON 里抽出结论", () => {
    const fs = parseFindings(good);
    expect(fs).toHaveLength(2);
    expect(fs[0].topic).toBe("defensive-timing");
  });

  it("被 maxTokens 截断的 JSON 返回空数组而不是抛错", () => {
    // 2026-08-23 实测:maxTokens 3072 时 10% 的样本 JSON 被切在半路。
    const truncated = good.slice(0, good.length - 40);
    expect(parseFindings(truncated)).toEqual([]);
  });

  it("正文里出现别的花括号对象时,取的是含 findings 的那个", () => {
    const noisy = `前文提到 {"foo": 1} 这样的配置。\n${good}`;
    expect(parseFindings(noisy)).toHaveLength(2);
  });

  it("没有 JSON 时返回空数组", () => {
    expect(parseFindings("纯散文,没有结构化块")).toEqual([]);
  });
});

describe("findingKeys / jaccard / citedMoments", () => {
  it("键只含 topic,不含极性 —— 同主题极性翻转不算结论变了", () => {
    const keys = findingKeys([
      { t: "1:00", topic: "dispel", verdict: "good", claim: "" },
      { t: "2:00", topic: "dispel", verdict: "bad", claim: "" },
    ]);
    expect([...keys]).toEqual(["dispel"]);
  });

  it("jaccard:双空 = 1(都没结论不算差异),半空 = 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(
      1 / 3,
    );
  });

  it("citedMoments 抽 M:SS,去重,不吞 10 分钟以上", () => {
    const s = citedMoments("在 0:47 和 2:13,以及再次 0:47;终局 12:05。");
    expect(s).toEqual(new Set(["0:47", "2:13", "12:05"]));
  });
});
