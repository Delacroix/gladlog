import { describe, expect, it } from "vitest";

import { causalLint } from "./causalLint";

describe("causalLint (enforces the no-strong-causal-claim policy)", () => {
  it("flags strong causal attribution", () => {
    expect(
      causalLint("You died because you wasted your defensive.").length,
    ).toBeGreaterThan(0);
    expect(causalLint("Holding CDs cost you the game.").length).toBeGreaterThan(
      0,
    );
    expect(causalLint("That's why you lost the round.").length).toBeGreaterThan(
      0,
    );
    expect(causalLint("This led to the loss.").length).toBeGreaterThan(0);
  });
  it("flags the strengthened patterns (got-killed, which-is-why, present-tense, cost-the-round)", () => {
    expect(
      causalLint("Poor positioning got you killed.").length,
    ).toBeGreaterThan(0);
    expect(
      causalLint("Which is why you lost that round.").length,
    ).toBeGreaterThan(0);
    expect(
      causalLint("You die because you overextend.").length,
    ).toBeGreaterThan(0);
    expect(causalLint("That greed cost the round.").length).toBeGreaterThan(0);
    expect(
      causalLint("Overextending cost us the game.").length,
    ).toBeGreaterThan(0);
  });
  it("allows observational + suggestive coaching (no strong causal connective)", () => {
    expect(
      causalLint(
        "At 1:00 you used Pain Suppression; the kill came at 2:00 during their cooldowns.",
      ),
    ).toEqual([]);
    expect(
      causalLint("Consider saving the trinket for the first swap."),
    ).toEqual([]);
  });
  it("does not false-drop resource-cost observations or positive reinforcement (narrowed patterns)", () => {
    expect(causalLint("It cost you nothing to try the early swap.")).toEqual(
      [],
    );
    expect(
      causalLint("Great peel — which is why you survived the go."),
    ).toEqual([]);
  });
});

// 2026-07-31: 300-match agy production simulation (production default
// aiLanguage=zh) found 8 real Chinese causal-certainty overclaims across 6
// response files that the English-only gate above cannot see. Quotes below
// are verbatim from
// $HOME/code/gladlog-eval-private/agy-sim-2026-07-31/deep-read.md Part 4.
//
// Red→green: a minimal replica of the pre-2026-07-31 (English-only)
// PATTERNS list must fail to flag all 8 — proving this is genuinely new
// coverage, not a pre-existing capability nobody exercised.
const OLD_ENGLISH_ONLY_OUTCOME =
  "(died|death|dies|die|lost|loss|lose|loses|wiped|wipe|killed|defeat)";
const OLD_ENGLISH_ONLY_PATTERNS: RegExp[] = [
  new RegExp(`\\b${OLD_ENGLISH_ONLY_OUTCOME}\\b[^.]*\\bbecause\\b`, "i"),
  new RegExp(`\\bbecause\\b[^.]*\\b${OLD_ENGLISH_ONLY_OUTCOME}\\b`, "i"),
  /\bcost (you |us |him |her |them |the team )?(the )?(game|round|match|series)\b/i,
  /\bgot (you|him|her|them|the team) killed\b/i,
  new RegExp(
    `\\b(that'?s|this is|which is) why\\b[^.]*\\b${OLD_ENGLISH_ONLY_OUTCOME}\\b`,
    "i",
  ),
  new RegExp(
    `\\b(led to|resulted in|caused)\\b[^.]*\\b${OLD_ENGLISH_ONLY_OUTCOME}\\b`,
    "i",
  ),
];
function oldGateWouldFlag(text: string): boolean {
  return OLD_ENGLISH_ONLY_PATTERNS.some((rx) => rx.test(text));
}

const ZH_LABELED_VIOLATIONS = [
  // 002bcc0b.0 — on the audited decisive Blessing of Protection counterfactual.
  "如果在你血量跌破 30% 时他能给你一个 Blessing of Protection（可完全免疫猎人宠物的物理伤害），这波你绝对死不了。",
  // 7c0b2197.0 — unaudited Pain Suppression counterfactual, adjacent paragraph.
  "如果你没被控，或者预判到了控制并提前给出了你的减伤，他也不会死。",
  // d49b55cc.0 (1st) — on the audited decisive Aspect of the Turtle counterfactual.
  "如果他早交两秒，绝对可以存活。",
  // d49b55cc.0 (2nd) — unaudited Blessing of Spellwarding counterfactual, same file.
  "如果他在 Warrior 斩杀你时给出技能，你完全可以活下来。",
  // 889c99db.0 — 因为没开X才死 pattern tied to CD-stacking.
  "你在这场比赛中的减伤循环是直接导致你最终死亡的原因。",
  // 43065b44.0 — no-retreat/no-mitigation decision tied to death with certainty.
  "你不撤退的结果就是10秒内硬吃了740k的爆发伤害，直接猝死。",
  // d9bc7413.0 — header over a "无视 Ironbark" section.
  "这是导致输掉比赛的直接原因。",
  // efc88dcb.0 — unused defensive cooldowns tied to the match outcome.
  "没有交出任何保命技能，这是直接导致输掉比赛的原因。",
];

describe("causalLint zh causal-certainty patterns (agy-sim-2026-07-31, 8 labeled violations)", () => {
  it.each(ZH_LABELED_VIOLATIONS)("flags labeled violation: %s", (quote) => {
    expect(oldGateWouldFlag(quote)).toBe(false); // red: old English-only gate is blind
    expect(causalLint(quote).length).toBeGreaterThan(0); // green: new gate catches it
  });

  it("does not flag legal-possibility framing (可能/或许/大概率/有机会 + 活)", () => {
    expect(causalLint("如果队友早两秒摆脱控制，可能就活下来了。")).toEqual([]);
    expect(causalLint("他或许能撑到治疗跟上，大概率能活下来。")).toEqual([]);
    expect(causalLint("这波至少有机会活下来，具体要看对面收人速度。")).toEqual(
      [],
    );
    expect(causalLint("就算他及时使用了防御技能，也未必能活下来。")).toEqual(
      [],
    );
  });

  it("does not flag the product's own decisive-line hedge phrasing (假设式, 无确定性断言)", () => {
    expect(causalLint("若同窗叠加圣盾术，该段伤害约降至致死线下。")).toEqual(
      [],
    );
    expect(
      causalLint(
        "反事实(算术,单因素):若换上 Ice Block,该段窗口伤害将降至致死线以下(裕量 >15% 最大生命值)。",
      ),
    ).toEqual([]);
  });

  it("does not flag mere factual descriptions of damage/death (no causal-certainty language)", () => {
    expect(
      causalLint("你死于三人集火，治疗当时正在处理另一侧的爆发。"),
    ).toEqual([]);
    expect(causalLint("本局你被击杀两次，分别在 1:23 和 2:45。")).toEqual([]);
  });

  it("flags the report.md example (因为...而死亡, generic zh outcome-because)", () => {
    expect(causalLint("你的治疗因为你没有拆火而死亡。").length).toBeGreaterThan(
      0,
    );
  });

  it("keeps a bounded gap so a match does not silently span an unrelated sentence (zh sentence terminators)", () => {
    // "因为" in one sentence, an unrelated "死亡" two sentences later — must
    // NOT be treated as one connective span (this is the segmentation bug
    // constraint 6 asks to guard against: 。！？ must bound the gap like "."
    // does for English).
    expect(
      causalLint(
        "因为对面开了控制链，你的走位其实没有问题。团队整体发挥不错。这局最后阵亡是三号目标猝死带走的另一个人，和你无关。",
      ),
    ).toEqual([]);
  });
});
