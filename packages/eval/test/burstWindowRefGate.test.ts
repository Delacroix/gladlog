/**
 * 14th hardFailure class (GH #60 phase 2, 2026-09-01):
 * `checkBurstWindowRefConsistency` re-parses a `slow-defensive-response` menu
 * line's corpus-reference facts and demands the SAME
 * `lookupBurstWindowPrior(bracket, leadCdId)` the producer rendered them from.
 *
 * The expected values are taken from the lookup itself, never re-typed — the
 * point of the class is that one import feeds both sides (CLAUDE.md
 * shared-predicate rule). The fixture picks a real cell out of the generated
 * table so the test moves with the data instead of pinning numbers that a
 * season refresh will invalidate.
 */
import { lookupBurstWindowPrior } from "@gladlog/analysis/src/data/burstWindowPrior";
import { describe, expect, it } from "vitest";

import { checkBurstWindowRefConsistency } from "../src/quality/promptQualityCheck";

/** Deathmark in 3v3 — the corpus' strongest-contrast lead CD; falls back to
 * the bracket cell if the season refresh ever leaves it under the n floor,
 * which is fine: the test only needs A cell. */
const BRACKET = "3v3";
const LEAD_CD_ID = "360194";
const REF = lookupBurstWindowPrior(BRACKET, LEAD_CD_ID);

function line(overrides: Record<string, string> = {}): string {
  const facts: Record<string, string> = {
    t: "112",
    leadCd: "Deathmark",
    leadCdId: LEAD_CD_ID,
    casterSpec: "Assassination Rogue",
    caster: "Rogue-Realm-US",
    pressured: "Mate-Realm-US",
    pressuredHpPct: "31",
    pressuredHpT: "115",
    diedInWindow: "no",
    refN: String(REF!.nResp + REF!.nNoResp),
    refDeathResp: String(REF!.deathRespPct),
    refDeathNoResp: String(REF!.deathNoRespPct),
    refTop: REF!.topResponses.map(([k, v]) => `${k} ${v}%`).join("; "),
    cellKey: REF!.cellKey,
    fellBack: REF!.fellBack ? "yes" : "no",
    ...overrides,
  };
  const body = Object.entries(facts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `  - id=slow-defensive-response:h1:112 type=slow-defensive-response t=112s units=Me-Realm-US facts={${body}}`;
}

describe("checkBurstWindowRefConsistency", () => {
  it("the generated table has a usable cell to check against", () => {
    expect(REF).not.toBeNull();
  });

  it("a line rendered from the table passes", () => {
    expect(checkBurstWindowRefConsistency([line()])).toEqual([]);
  });

  it("a planted death-rate mismatch fires exactly one failure naming the fact", () => {
    const planted = String(REF!.deathNoRespPct + 7);
    const fails = checkBurstWindowRefConsistency([
      line({ refDeathNoResp: planted }),
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain(`refDeathNoResp=${planted}`);
    expect(fails[0]).toContain(String(REF!.deathNoRespPct));
  });

  it("a planted n and a planted cellKey are both caught", () => {
    expect(
      checkBurstWindowRefConsistency([
        line({ refN: "999999", cellKey: "2v2|12345" }),
      ]).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when the reference facts are missing entirely", () => {
    const stripped = line().replace(
      `, refN=${REF!.nResp + REF!.nNoResp}`,
      "",
    );
    expect(checkBurstWindowRefConsistency([stripped]).length).toBeGreaterThan(
      0,
    );
  });

  it("a line with no leadCdId cannot be checked and is a failure, not a pass", () => {
    const noId = line().replace(`, leadCdId=${LEAD_CD_ID}`, "");
    const fails = checkBurstWindowRefConsistency([noId]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("leadCdId");
  });

  it("ignores every other candidate type", () => {
    expect(
      checkBurstWindowRefConsistency([
        "  - id=cd-hoarded:h1:10 type=cd-hoarded t=10s units=Me facts={t=10}",
      ]),
    ).toEqual([]);
  });
});
