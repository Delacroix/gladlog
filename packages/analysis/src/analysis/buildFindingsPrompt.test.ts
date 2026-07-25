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
    // 不再是自由 string;并明确「与回复语言无关」纪律
    expect(p).not.toMatch(/"category": string/);
    expect(p).toMatch(/regardless of the reply language/);
  });
});
