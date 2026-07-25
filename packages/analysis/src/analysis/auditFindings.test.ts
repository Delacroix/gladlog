import { describe, expect, it } from "vitest";

import { auditFindings } from "./auditFindings";
import type { CandidateEvent, RawFinding } from "./types";

const candidates: CandidateEvent[] = [
  {
    id: "death:a:30",
    type: "death",
    t: 30,
    unitNames: ["Me-R"],
    facts: { t: "30", unit: "Me-R" },
  },
];
const base: RawFinding = {
  eventIds: ["death:a:30"],
  severity: "high",
  category: "survival",
  title: "Death",
  explanation: "You died at {{t}}s.",
};

describe("auditFindings", () => {
  it("keeps a grounded, numerically-clean, non-causal finding and interpolates it", () => {
    const r = auditFindings([base], candidates);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].explanation).toBe("You died at 30s.");
  });
  it("drops a finding with a fabricated bare INTEGER outside a placeholder", () => {
    // The real death is at t=30; "47s" is fabricated. Integers are the analysis
    // fabrication surface, so a raw digit outside a placeholder must be dropped.
    const r = auditFindings(
      [{ ...base, explanation: "You died at 47s." }],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/raw digit|numeric/i);
  });
  it("drops an unanchored finding with empty eventIds (grounding)", () => {
    const r = auditFindings(
      [{ ...base, eventIds: [], explanation: "Play more defensively." }],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/ground|unanchored/i);
  });
  it("drops a multi-event finding whose referenced events collide on a fact key with differing values", () => {
    const two: CandidateEvent[] = [
      candidates[0],
      {
        id: "death:b:40",
        type: "death",
        t: 40,
        unitNames: ["Ally"],
        facts: { t: "40", unit: "Ally" },
      },
    ];
    const r = auditFindings(
      [
        {
          ...base,
          eventIds: ["death:a:30", "death:b:40"],
          explanation: "Two deaths, both around {{t}}s.",
        },
      ],
      two,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/ambiguous|collid/i);
  });
  it("keeps a finding referencing a bracket/format term (2v2) — not a fabricated digit", () => {
    const r = auditFindings(
      [
        {
          ...base,
          explanation: "In the 2v2 you went down at {{t}}s; play safer.",
        },
      ],
      candidates,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].explanation).toBe(
      "In the 2v2 you went down at 30s; play safer.",
    );
  });
  it("drops a finding citing a non-existent event (grounding)", () => {
    const r = auditFindings(
      [{ ...base, eventIds: ["death:zzz:99"] }],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/ground/i);
  });
  it("drops a finding with a raw stat-digit outside a placeholder (numeric)", () => {
    const r = auditFindings(
      [{ ...base, explanation: "Your uptime was 0.85 there." }],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/numeric|claim/i);
  });
  it("drops a finding with strong causal attribution (causal lint)", () => {
    const r = auditFindings(
      [{ ...base, explanation: "You died because you greeded." }],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0].reason).toMatch(/causal/i);
  });
  it("sorts survivors by severity (high → low)", () => {
    const low: RawFinding = { ...base, severity: "low", title: "Low" };
    const r = auditFindings([low, base], candidates);
    expect(r.findings.map((f) => f.severity)).toEqual(["high", "low"]);
  });
});

describe("跨事件 facts 键冲突(2026-07-24 精化:只丢实际使用了冲突键的)", () => {
  const two: CandidateEvent[] = [
    {
      id: "missed-cleanse:X:20",
      type: "missed-cleanse",
      t: 20,
      unitNames: ["X"],
      facts: { t: "20.0", cc: "Fear", duration: "5.0" },
    },
    {
      id: "missed-cleanse:X:80",
      type: "missed-cleanse",
      t: 80,
      unitNames: ["X"],
      facts: { t: "80.0", cc: "Sheep", duration: "6.0" },
    },
  ];
  const multi: RawFinding = {
    eventIds: ["missed-cleanse:X:20", "missed-cleanse:X:80"],
    severity: "med",
    category: "dispel",
    title: "Cleanses missed twice",
    explanation: "High-value CC sat on your ally twice without a dispel.",
  };

  it("引用冲突事件但解释未用冲突键 → 保留(旧规则会误杀)", () => {
    const r = auditFindings([multi], two);
    expect(r.findings).toHaveLength(1);
  });

  it("HAS TEETH:解释用了冲突键 {{t}} → 丢,理由点名该键", () => {
    const r = auditFindings(
      [{ ...multi, explanation: "At {{t}}s the CC sat without a dispel." }],
      two,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/placeholder.*t.*collide/);
  });

  it("用的是非冲突键(仅一事件含 deathT 类独有键)→ 保留并插值", () => {
    const withUnique: CandidateEvent[] = [
      two[0]!,
      {
        ...two[1]!,
        id: "death-setup:X:90",
        facts: { t: "80.0", deathT: "90.0", kind: "healer-locked" },
      },
    ];
    const r = auditFindings(
      [
        {
          ...multi,
          eventIds: ["missed-cleanse:X:20", "death-setup:X:90"],
          explanation:
            "The setup happened earlier; the death followed at {{deathT}}s.",
        },
      ],
      withUnique,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.explanation).toContain("90.0s");
  });
});

describe("冲突键带序号变体(2026-07-25:多事件 finding 的合法时刻引用)", () => {
  const two: CandidateEvent[] = [
    {
      id: "cc-locked:P:20",
      type: "cc-locked",
      t: 20,
      unitNames: ["Me"],
      facts: { t: "19.9", cc: "Hammer of Justice", duration: "5.0" },
    },
    {
      id: "cc-locked:P:85",
      type: "cc-locked",
      t: 85,
      unitNames: ["Me"],
      facts: { t: "85.4", cc: "Hammer of Justice", duration: "5.0" },
    },
  ];

  it("{{t1}}/{{t2}} 按 eventIds 顺序解析并插值", () => {
    const r = auditFindings(
      [
        {
          eventIds: ["cc-locked:P:20", "cc-locked:P:85"],
          severity: "med",
          category: "cc",
          title: "两次被控",
          explanation: "第一次在 {{t1}}s,第二次在 {{t2}}s,同一套控制链。",
        },
      ],
      two,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.explanation).toContain("19.9s");
    expect(r.findings[0]!.explanation).toContain("85.4s");
  });

  it("HAS TEETH:裸 {{t}} 仍然丢(歧义不猜)", () => {
    const r = auditFindings(
      [
        {
          eventIds: ["cc-locked:P:20", "cc-locked:P:85"],
          severity: "med",
          category: "cc",
          title: "两次被控",
          explanation: "在 {{t}}s 被控。",
        },
      ],
      two,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/collide/);
  });

  it("值相同的共享键不算冲突,不生成序号变体也不丢", () => {
    const r = auditFindings(
      [
        {
          eventIds: ["cc-locked:P:20", "cc-locked:P:85"],
          severity: "low",
          category: "cc",
          title: "同法术",
          explanation: "两次都是 {{cc}},时长都到 {{duration}}s。",
        },
      ],
      two,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.explanation).toContain("Hammer of Justice");
  });
});

describe("序号变体覆盖全部键(2026-07-25 二修:模型看不见冲突集)", () => {
  it("非冲突键的 {{duration1}} 与单事件的 {{deathT1}} 也能解析", () => {
    const evts: CandidateEvent[] = [
      {
        id: "cc-locked:P:20",
        type: "cc-locked",
        t: 20,
        unitNames: ["Me"],
        facts: { t: "19.9", duration: "5.0" },
      },
      {
        id: "cc-locked:P:85",
        type: "cc-locked",
        t: 85,
        unitNames: ["Me"],
        facts: { t: "85.4", duration: "5.0" }, // duration 同值 → 非冲突
      },
    ];
    const r = auditFindings(
      [
        {
          eventIds: ["cc-locked:P:20", "cc-locked:P:85"],
          severity: "med",
          category: "cc",
          title: "链控",
          explanation: "第一次 {{t1}}s 吃满 {{duration1}}s,第二次 {{t2}}s。",
        },
      ],
      evts,
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.explanation).toBe(
      "第一次 19.9s 吃满 5.0s,第二次 85.4s。",
    );

    const single: CandidateEvent[] = [
      {
        id: "death-setup:X:90",
        type: "death-setup",
        t: 80,
        unitNames: ["X"],
        facts: { t: "80.0", deathT: "90.0" },
      },
    ];
    const r2 = auditFindings(
      [
        {
          eventIds: ["death-setup:X:90"],
          severity: "high",
          category: "chain",
          title: "链",
          explanation: "铺垫在 {{t1}}s,死亡在 {{deathT1}}s。",
        },
      ],
      single,
    );
    expect(r2.findings).toHaveLength(1);
    expect(r2.findings[0]!.explanation).toBe("铺垫在 80.0s,死亡在 90.0s。");
  });
});

describe("agy 复核采纳(2026-07-25)", () => {
  it("F3:非法占位符 {{t-1}} 不再漏过 —— 按裸数字丢弃,不会原样渲染", () => {
    const r = auditFindings(
      [
        {
          eventIds: ["death:a:30"],
          severity: "med",
          category: "x",
          title: "t",
          explanation: "被控发生在 {{t-1}}s。",
        },
      ],
      candidates,
    );
    expect(r.findings).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/raw digit|numeric/);
  });

  it("F2 契约:候选 facts 键不得以数字结尾(序号变体命名空间保留)", async () => {
    // 真实提取路径全量扫:synth 对局的所有候选、所有 facts 键
    const { GladLogParser } = await import("@gladlog/parser");
    const { synthArenaLog } = await import(
      "../../../parser/src/testing/synthLog"
    );
    const { toLegacyMatch } = await import("@gladlog/parser-compat");
    const { extractCandidateFindings } = await import("./candidateFindings");
    const parser = new GladLogParser();
    let match: unknown = null;
    parser.on("match", (m) => (match = m));
    for (const line of synthArenaLog().split("\n")) parser.push(line);
    parser.end();
    const legacy = toLegacyMatch(match as never);
    for (const c of extractCandidateFindings(legacy)) {
      for (const k of Object.keys(c.facts)) {
        expect(k, `候选 ${c.type} 的 facts 键 ${k} 以数字结尾`).not.toMatch(
          /\d$/,
        );
      }
    }
  });
});
