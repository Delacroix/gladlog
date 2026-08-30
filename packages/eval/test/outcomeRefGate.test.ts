import { ATTEMPT_INTO_TRINKET_OUTCOME_REF } from "@gladlog/analysis/src/data/outcomeRefs";
import { describe, expect, it } from "vitest";

import {
  checkOutcomeRefConsistency,
  OUTCOME_REF_FACTS,
} from "../src/quality/promptQualityCheck";

const REF = ATTEMPT_INTO_TRINKET_OUTCOME_REF;

/** A menu line in the exact shape buildFindingsPrompt renders. */
function line(overrides: Record<string, string> = {}): string {
  const facts: Record<string, string> = {
    t: "1:12",
    target: "Enemy-Realm-US",
    stun: "肾击",
    stunsN: "2",
    focusPct: "78",
    dmgM: "1.24",
    primeAlt: "Other-Realm-US",
    failedBy: "pressure",
    refN: String(REF.n),
    refKillTrinketDown: String(REF.killPctTrinketDown),
    refKillTrinketUp: String(REF.killPctTrinketUp),
    ...overrides,
  };
  const body = Object.entries(facts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `  - id=attempt-into-trinket:1:72 type=attempt-into-trinket t=1:12s units=Enemy-Realm-US/Other-Realm-US facts={${body}}`;
}

describe("checkOutcomeRefConsistency (11th hardFailure class, 2026-08-30)", () => {
  it("the rendered reference equals the constant → no failure", () => {
    expect(checkOutcomeRefConsistency([line()])).toEqual([]);
  });

  it("planted wrong number → exactly one failure naming the fact (negative control)", () => {
    const fails = checkOutcomeRefConsistency([
      line({ refKillTrinketDown: "9.9" }),
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("refKillTrinketDown=9.9");
    expect(fails[0]).toContain(String(REF.killPctTrinketDown));
  });

  it("planted wrong n and a swapped-around percentage are both caught", () => {
    expect(
      checkOutcomeRefConsistency([
        line({
          refN: "48336",
          refKillTrinketUp: String(REF.killPctTrinketDown),
        }),
      ]),
    ).toHaveLength(2);
  });

  it("fails closed when a registered reference fact is missing entirely", () => {
    const stripped = line().replace(
      `, refKillTrinketUp=${REF.killPctTrinketUp}`,
      "",
    );
    const fails = checkOutcomeRefConsistency([stripped]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("缺少语料参照事实 refKillTrinketUp");
  });

  it("unregistered types and non-menu lines are out of scope", () => {
    expect(
      checkOutcomeRefConsistency([
        "  - id=burst-into-immunity:1:10 type=burst-into-immunity t=0:10s units=X facts={spell=A, immunity=B}",
        "0:10–0:20  [DMG SPIKE]   x: 0.50M in 10s",
      ]),
    ).toEqual([]);
  });

  it("the registry is keyed on the constant itself, not re-typed literals", () => {
    const entry = OUTCOME_REF_FACTS.find(
      (e) => e.type === "attempt-into-trinket",
    );
    expect(entry).toBeDefined();
    expect(entry!.facts).toEqual({
      refN: REF.n,
      refKillTrinketDown: REF.killPctTrinketDown,
      refKillTrinketUp: REF.killPctTrinketUp,
    });
  });
});
