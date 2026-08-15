import { describe, expect, it } from "vitest";

import { CANDIDATE_TYPE_FLAGS } from "../data/candidateTypeFlags";
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

  describe("cost_norm 守护注(#25,2026-08-14):facts.costNorm 字段说明", () => {
    it("cd-waste 图例(始终渲染)已解释 costNorm 语义", () => {
      const p = buildFindingsPrompt(candidates, "", "Holy Paladin");
      expect(p).toMatch(/facts\.costNorm/);
      expect(p).toMatch(/last-resort|emergency/);
    });

    it("death-unused-defensive 携带 costNorm 事实时,图例出现同一解释(单源文案,与 cd-waste 一致)", () => {
      const withCostNorm: CandidateEvent[] = [
        ...candidates,
        {
          id: "death-unused-defensive:p1:100",
          type: "death-unused-defensive",
          t: 100,
          unitNames: ["Me-R"],
          facts: {
            t: "100",
            unit: "Me-R",
            walls: "Divine Shield",
            free: "yes",
            costNorm:
              "大技能:机制可用,但代价过高,不得推荐为常规挡控手段,仅致死威胁下的最后手段",
          },
        },
      ];
      const p = buildFindingsPrompt(withCostNorm, "", "Holy Paladin");
      expect(p).toMatch(/facts\.costNorm/);
      expect(p).toMatch(/never as "you should press this to block\/mitigate"/);
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

describe("P1/P2 起爆候选图例(Task 4,2026-08-15,特性开关接线)", () => {
  const missedSyncWindowEvent: CandidateEvent = {
    id: "missed-sync-window:Enemy-Healer:439",
    type: "missed-sync-window",
    t: 439,
    unitNames: ["Enemy-Healer"],
    facts: {
      t: "439",
      windowEndT: "447",
      healer: "Enemy-Healer",
      cc: "Polymorph",
      durationS: "8",
      readyCds: "Avenging Wrath",
    },
  };
  const cdHoardedEvent: CandidateEvent = {
    id: "cd-hoarded:h:62618:180",
    type: "cd-hoarded",
    t: 180,
    unitNames: ["Healer-R", "Healer-R"],
    spell: "Power Word: Barrier",
    facts: {
      t: "180",
      lateS: "70",
      spell: "Power Word: Barrier",
      unit: "Healer-R",
      crisisT: "200",
      crisisUnit: "Healer-R",
      crisisHpPct: "30",
      castT: "250",
    },
  };

  it("四开关全关(默认态)→ 即便菜单里已经有对应类型的事件,四条新图例一条都不出现,现有图例不受影响", () => {
    const p = buildFindingsPrompt(
      [...candidates, missedSyncWindowEvent, cdHoardedEvent],
      "",
      "Discipline Priest",
    );
    expect(p).not.toMatch(/"missed-sync-window"/);
    expect(p).not.toMatch(/"unsynced-burst"/);
    expect(p).not.toMatch(/"cd-hoarded"/);
    expect(p).not.toMatch(/"cd-spent-idle"/);
    // 现有(已上线)图例不受这四个新开关影响。
    expect(p).toMatch(/"death"/);
  });

  it("单开 missedSyncWindow → 只有 missed-sync-window 的图例出现,同同步是门/血线是加速器不要求低血", () => {
    CANDIDATE_TYPE_FLAGS.missedSyncWindow = true;
    try {
      const p = buildFindingsPrompt(
        [...candidates, missedSyncWindowEvent, cdHoardedEvent],
        "",
        "Discipline Priest",
      );
      expect(p).toMatch(/"missed-sync-window"/);
      expect(p).toMatch(/Syncing with the lock is the trigger/);
      expect(p).toMatch(/do NOT require low enemy HP/);
      expect(p).not.toMatch(/"cd-hoarded"/);
      expect(p).not.toMatch(/"unsynced-burst"/);
      expect(p).not.toMatch(/"cd-spent-idle"/);
    } finally {
      CANDIDATE_TYPE_FLAGS.missedSyncWindow = false;
    }
  });

  it("单开 cdHoarded → 只有 cd-hoarded 的图例出现,且带 costNorm 联动措辞", () => {
    CANDIDATE_TYPE_FLAGS.cdHoarded = true;
    try {
      const p = buildFindingsPrompt(
        [...candidates, missedSyncWindowEvent, cdHoardedEvent],
        "",
        "Discipline Priest",
      );
      expect(p).toMatch(/"cd-hoarded"/);
      expect(p).toMatch(/facts\.costNorm is present/);
      expect(p).not.toMatch(/"missed-sync-window"/);
      expect(p).not.toMatch(/"unsynced-burst"/);
      expect(p).not.toMatch(/"cd-spent-idle"/);
    } finally {
      CANDIDATE_TYPE_FLAGS.cdHoarded = false;
    }
  });

  it("cdSpentIdle 图例说明它只在中/高威胁对局里出现", () => {
    CANDIDATE_TYPE_FLAGS.cdSpentIdle = true;
    try {
      const p = buildFindingsPrompt(
        [
          ...candidates,
          {
            id: "cd-spent-idle:h:33206:400",
            type: "cd-spent-idle",
            t: 400,
            unitNames: ["Healer-R"],
            spell: "Pain Suppression",
            facts: { t: "400", spell: "Pain Suppression", unit: "Healer-R" },
          },
        ],
        "",
        "Discipline Priest",
      );
      expect(p).toMatch(/"cd-spent-idle"/);
      expect(p).toMatch(/at least medium overall threat/);
    } finally {
      CANDIDATE_TYPE_FLAGS.cdSpentIdle = false;
    }
  });

  it("开关开但菜单里没有该类型的事件 → 图例仍不出现(presence 依旧把关,与既有类型同规则,避免白占 prompt 字节)", () => {
    CANDIDATE_TYPE_FLAGS.missedSyncWindow = true;
    try {
      const p = buildFindingsPrompt(candidates, "", "Discipline Priest");
      expect(p).not.toMatch(/"missed-sync-window"/);
    } finally {
      CANDIDATE_TYPE_FLAGS.missedSyncWindow = false;
    }
  });
});
