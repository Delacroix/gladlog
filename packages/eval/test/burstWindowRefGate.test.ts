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
import {
  BURST_REF_MIN_CONTRAST_PP,
  BURST_WINDOW_PRIOR_N_FLOOR,
  burstRefContrastPp,
  lookupBurstWindowPrior,
} from "@gladlog/analysis/src/data/burstWindowPrior";
import PRIOR_RAW from "@gladlog/analysis/src/data/burstWindowPriorGenerated.json";
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

  // ── minimum-contrast door (2026-09-01) ──────────────────────────────────
  //
  // The producer refuses to emit a line whose reference cell contrast is
  // under `BURST_REF_MIN_CONTRAST_PP`; this side must catch one that appears
  // anyway (a stale cached round, a model-edited prompt, a producer that
  // regressed). Both halves call `burstRefClearsMinContrast`.

  /** A real (bracket, leadCdId) whose OWN cell clears the n floor but has a
   * flat/reversed contrast — found in the generated table rather than pinned,
   * so a season refresh moves the fixture instead of breaking it. */
  const subDoor = (() => {
    const cells = (
      PRIOR_RAW as unknown as {
        cells: Record<
          string,
          { nNoResp: number; deathResp: number; deathNoResp: number }
        >;
      }
    ).cells;
    for (const [k, c] of Object.entries(cells)) {
      const [bracket, spellId] = k.split("|");
      if (!bracket || !spellId || spellId === "*" || bracket === "*") continue;
      if (c.nNoResp < BURST_WINDOW_PRIOR_N_FLOOR) continue;
      const ref = lookupBurstWindowPrior(bracket, spellId);
      if (!ref || ref.fellBack) continue;
      if (burstRefContrastPp(ref) < BURST_REF_MIN_CONTRAST_PP)
        return { bracket, spellId, ref };
    }
    return null;
  })();

  it("the table still contains a flat/reversed cell to test the door with", () => {
    // If this ever goes null the corpus itself changed shape; the door tests
    // below would silently stop testing anything, so it fails loudly instead.
    expect(subDoor).not.toBeNull();
  });

  it("a line quoting a sub-door contrast is a hardFailure even though every number matches the table", () => {
    const { spellId, ref } = subDoor!;
    const fails = checkBurstWindowRefConsistency([
      line({
        leadCdId: spellId,
        refN: String(ref.nResp + ref.nNoResp),
        refDeathResp: String(ref.deathRespPct),
        refDeathNoResp: String(ref.deathNoRespPct),
        refTop: ref.topResponses.map(([k, v]) => `${k} ${v}%`).join("; "),
        cellKey: ref.cellKey,
        fellBack: ref.fellBack ? "yes" : "no",
      }),
    ]);
    // every table fact agrees — the ONLY complaint is the door
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain(`${BURST_REF_MIN_CONTRAST_PP} pp`);
    expect(fails[0]).toContain(String(burstRefContrastPp(ref)));
  });

  it("a planted equal-rate pair fires the door on top of the table mismatch", () => {
    const fails = checkBurstWindowRefConsistency([
      line({ refDeathNoResp: String(REF!.deathRespPct) }),
    ]);
    expect(fails.length).toBeGreaterThanOrEqual(2);
    expect(fails.some((f) => f.includes(`${BURST_REF_MIN_CONTRAST_PP} pp`))).toBe(
      true,
    );
  });

  it("a non-numeric contrast pair fails closed rather than passing the door", () => {
    const fails = checkBurstWindowRefConsistency([
      line({ refDeathNoResp: "n/a" }),
    ]);
    expect(fails.some((f) => f.includes("最小对比度门槛"))).toBe(true);
  });

  it("ignores every other candidate type", () => {
    expect(
      checkBurstWindowRefConsistency([
        "  - id=cd-hoarded:h1:10 type=cd-hoarded t=10s units=Me facts={t=10}",
      ]),
    ).toEqual([]);
  });
});
