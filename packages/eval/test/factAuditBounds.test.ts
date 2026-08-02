import { readFileSync } from "fs";
import { join } from "path";

import {
  FACT_AUDIT_MAX,
  FACT_AUDIT_MIN,
} from "../src/provenance/checkScoreProvenance";

/**
 * The gate's predicate is the spec. The PASS 1 audit-set bounds live in two
 * places:
 *   - `docs/commands/eval-baseline.md` -- the spec the judge reads
 *   - `checkScoreProvenance.ts` -- the gate that checks the judge complied
 * When the two disagree, compliant scores get rejected and out-of-bounds
 * scores get through. A markdown constant cannot be imported, so we take the
 * fallback prescribed by CLAUDE.md: write a unit test asserting equality
 * rather than relying on a comment.
 *
 * Cost on 2026-07-20: the PASS 1 audit-set size was changed without updating
 * the length convention, and a 30-item re-judging produced counts anywhere
 * from 3 to 12.
 */
const RUBRIC = readFileSync(
  join(__dirname, "../../../docs/commands/eval-baseline.md"),
  "utf8",
);

describe("factAudit bounds stay in sync with the rubric doc", () => {
  it("the documented legal length equals the validator's bounds", () => {
    const m = RUBRIC.match(/合法长度\s*(\d+)[–-](\d+)/);
    expect(m, "rubric no longer states 合法长度 N–M").not.toBeNull();
    expect(Number(m![1])).toBe(FACT_AUDIT_MIN);
    expect(Number(m![2])).toBe(FACT_AUDIT_MAX);
  });

  it("the documented audit-set cap equals FACT_AUDIT_MAX", () => {
    const m = RUBRIC.match(/\*\*上限\s*(\d+)\s*条\*\*/);
    expect(m, "rubric no longer states **上限 N 条**").not.toBeNull();
    expect(Number(m![1])).toBe(FACT_AUDIT_MAX);
  });

  it("the over-cap split takes both ends and sums to the cap", () => {
    // The over-cap rule must take half from each end -- truncating to a
    // prefix makes the tail of the response a blind spot, which is exactly
    // why two planted fabrications were missed on 2026-07-21.
    const m = RUBRIC.match(/前\s*(\d+)\s*条\s*\+\s*末\s*(\d+)\s*条/);
    expect(m, "rubric no longer states 前 N 条 + 末 M 条").not.toBeNull();
    const head = Number(m![1]);
    const tail = Number(m![2]);
    expect(head + tail).toBe(FACT_AUDIT_MAX);
    expect(head).toBe(tail);
  });
});
