import { describe, expect, it } from "vitest";

import { buildFindingsPrompt } from "./buildFindingsPrompt";
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
});
