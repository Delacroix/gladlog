import { describe, expect, it } from "vitest";

import { buildFindingsPrompt } from "./buildFindingsPrompt";
import { LEGACY_TOPIC_TYPES } from "./candidateFindings";
import { FINDING_CATEGORIES } from "./findingCategories";
import type { CandidateEvent } from "./types";

const candidates: CandidateEvent[] = [
  {
    id: "death:a:30",
    type: "death",
    t: 30,
    unitNames: ["Me-R"],
    facts: { t: "30", unit: "Me-R" },
  },
];

describe("buildFindingsPrompt", () => {
  it("lists the event menu with IDs, forbids invented events + causal claims, and demands JSON", () => {
    const p = buildFindingsPrompt(
      candidates,
      "RICH CONTEXT HERE",
      "Discipline Priest",
    );
    expect(p).toMatch(/death:a:30/); // the event id is offered
    expect(p).toMatch(/RICH CONTEXT HERE/); // holistic context included
    expect(p).toMatch(/JSON/i);
    expect(p).toMatch(/placeholder|\{\{/); // numbers via placeholders
    expect(p).toMatch(/because|causal|caused/i); // the no-causal rule is stated
    expect(p).toMatch(/Discipline Priest/);
    expect(p).toMatch(/no digits|words|discarded/i); // strict no-raw-digit guidance
  });

  it("category 收敛为枚举(与 FINDING_CATEGORIES 单源渲染)", () => {
    const p = buildFindingsPrompt(candidates, "", "Discipline Priest");
    for (const c of FINDING_CATEGORIES) expect(p).toContain(`"${c}"`);
    // No longer a free-form string; and the "independent of the reply language"
    // discipline is stated explicitly
    expect(p).not.toMatch(/"category": string/);
    expect(p).toMatch(/regardless of the reply language/);
  });

  it("missed-cleanse:owner 派系能力门守护注出现在 legend(2026-08-05,37/200 场审计)", () => {
    const withMissedCleanse: CandidateEvent[] = [
      ...candidates,
      {
        id: "missed-cleanse:Ally:30",
        type: "missed-cleanse",
        t: 30,
        unitNames: ["Ally"],
        facts: {
          t: "30",
          target: "Ally",
          cc: "Curse of Tongues",
          duration: "5.0",
          priority: "Critical",
          postCcDamageK: "50",
          drChainRisk: "no",
          dispelType: "Curse",
          ownerCanDispel: "no",
          eligibleDispellers: "Arcane Mage",
        },
      },
    ];
    const p = buildFindingsPrompt(withMissedCleanse, "", "Holy Paladin");
    // The guard note is legend-level text (present whenever the menu has a
    // missed-cleanse event), steering the model toward a call-out suggestion
    // instead of "you should have dispelled it" for a debuff type the
    // owner's own class cannot remove.
    expect(p).toMatch(/ownerCanDispel/);
    expect(p).toMatch(/eligibleDispellers/);
    expect(p).toMatch(/CANNOT remove this debuff type/);
    expect(p).toMatch(/call-out|call for a dispel/);
  });

  describe("挑选层多样性指令(2026-08-11,旧四族合计上限 2)", () => {
    it("prompt 含合计最多 2 条的指令行,并逐一列出 LEGACY_TOPIC_TYPES 的四个类型名", () => {
      const p = buildFindingsPrompt(candidates, "", "Discipline Priest");
      // The instruction sentence itself (wording, not just the type names).
      expect(p).toMatch(/at most 2 findings TOTAL/);
      expect(p).toMatch(/Prioritize covering DIFFERENT event types/);
      // Every legacy type name must be enumerated -- sourced from the shared
      // set, not a hand-copied second list (CLAUDE.md shared-predicate rule).
      for (const t of LEGACY_TOPIC_TYPES) {
        expect(p).toContain(`"${t}"`);
      }
    });

    it("防漂移:LEGACY_TOPIC_TYPES 恰好是四个类型,不多不少", () => {
      // If a fifth type were folded in (or one dropped) without updating this
      // test, the prompt sentence and the audit-layer cap would silently
      // drift apart from what this suite actually exercises.
      expect([...LEGACY_TOPIC_TYPES].sort()).toEqual(
        [
          "cc-locked",
          "missed-cleanse",
          "missed-purge",
          "wasted-trinket",
        ].sort(),
      );
    });
  });

  describe("信号扩容批 1 图例(2026-08-06,healing-gap/position-mistake/cc-held)", () => {
    it("三个新类型的图例仅在菜单出现对应类型时才渲染(D2 惯例:无该类型时 prompt 字节不变)", () => {
      const withoutNewTypes = buildFindingsPrompt(
        candidates,
        "",
        "Holy Paladin",
      );
      expect(withoutNewTypes).not.toMatch(/healing-gap/);
      expect(withoutNewTypes).not.toMatch(/position-mistake/);
      expect(withoutNewTypes).not.toMatch(/cc-held/);
    });

    it("healing-gap 图例覆盖 facts 字段", () => {
      const p = buildFindingsPrompt(
        [
          ...candidates,
          {
            id: "healing-gap:h:30",
            type: "healing-gap",
            t: 30,
            unitNames: ["Me-R", "Ally"],
            facts: {
              t: "30",
              durationS: "9",
              freeS: "4",
              pressured: "Ally",
              pressuredSpec: "Warrior_Arms",
            },
          },
        ],
        "",
        "Holy Paladin",
      );
      expect(p).toMatch(/"healing-gap"/);
      expect(p).toMatch(/facts\.durationS/);
      expect(p).toMatch(/facts\.freeS/);
      expect(p).toMatch(/facts\.pressured\b/);
    });

    it("position-mistake 图例解释三种 kind,且不越界断言因果", () => {
      const p = buildFindingsPrompt(
        [
          ...candidates,
          {
            id: "position-mistake:p1:10:stayed-in",
            type: "position-mistake",
            t: 10,
            unitNames: ["Me"],
            facts: { t: "10", kind: "stayed-in", hpStart: "90", hpMin: "40" },
          },
        ],
        "",
        "Holy Paladin",
      );
      expect(p).toMatch(/"position-mistake"/);
      expect(p).toMatch(/stayed-in/);
      expect(p).toMatch(/missed-push/);
      expect(p).toMatch(/cd-out-of-range/);
    });

    it("cc-held 图例把「长期可用未使用」表述为事实层,明确禁止因果断言", () => {
      const p = buildFindingsPrompt(
        [
          ...candidates,
          {
            id: "cc-held:p1:118:10",
            type: "cc-held",
            t: 10,
            unitNames: ["Me"],
            spell: "Polymorph",
            facts: {
              t: "10",
              spell: "Polymorph",
              heldS: "96",
              windowEndT: "105",
            },
          },
        ],
        "",
        "Holy Paladin",
      );
      expect(p).toMatch(/"cc-held"/);
      expect(p).toMatch(/AVAILABLE/);
      // No-causation guard, in the spec's own words: uptime is a fact, "cost
      // the game" is the banned inference.
      expect(p).toMatch(
        /not a claim that pressing it would have changed the outcome/,
      );
      expect(p).toMatch(/never assert it "cost" anything/);
    });
  });
});
