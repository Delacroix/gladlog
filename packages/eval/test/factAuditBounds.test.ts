import { readFileSync } from "fs";
import { join } from "path";

import {
  computeAccuracyFromFactAudit,
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
    const m = RUBRIC.match(/(?:合法长度|valid length)\s*(\d+)[–-](\d+)/);
    expect(m, "rubric no longer states legal length N–M").not.toBeNull();
    expect(Number(m![1])).toBe(FACT_AUDIT_MIN);
    expect(Number(m![2])).toBe(FACT_AUDIT_MAX);
  });

  it("the documented audit-set cap equals FACT_AUDIT_MAX", () => {
    const m = RUBRIC.match(
      /(?:\*\*上限\s*(\d+)\s*条\*\*|\*\*capped at (\d+)\*\*)/,
    );
    expect(m, "rubric no longer states cap N").not.toBeNull();
    expect(Number(m![1] ?? m![2])).toBe(FACT_AUDIT_MAX);
  });

  it("the over-cap split takes both ends and sums to the cap", () => {
    // The over-cap rule must take half from each end -- truncating to a
    // prefix makes the tail of the response a blind spot, which is exactly
    // why two planted fabrications were missed on 2026-07-21.
    const m = RUBRIC.match(
      /(?:前\s*(\d+)\s*条\s*\+\s*末\s*(\d+)\s*条|first\s*(\d+)\s*\+\s*last\s*(\d+))/i,
    );
    expect(m, "rubric no longer states first N + last M").not.toBeNull();
    const head = Number(m![1] ?? m![3]);
    const tail = Number(m![2] ?? m![4]);
    expect(head + tail).toBe(FACT_AUDIT_MAX);
    expect(head).toBe(tail);
  });

  it("accuracy 查表行与 computeAccuracyFromFactAudit 语义钉扎(子项目 A)", () => {
    // 文档侧:五条查表行必须在场
    for (const line of [
      /5:\s*(?:零错|Zero errors)/,
      /4:\s*(?:恰 1 处小错|Exactly 1 minor error)/,
      /3:\s*(?:恰 2 处小错|Exactly 2 minor errors)/,
      /2:\s*(?:3 处及以上小错|3 or more minor errors)/,
    ])
      expect(RUBRIC).toMatch(line);
    expect(RUBRIC).toMatch(/(?:任一\*\*捏造\*\*|Any \*\*fabrication\*\*)/);
    expect(RUBRIC).toContain("computeAccuracyFromFactAudit");
    expect(RUBRIC).toContain("severity");
    // 代码侧:同一语义(等值断言,CLAUDE.md 的 markdown↔代码备选路)
    const m = (n: number) =>
      computeAccuracyFromFactAudit(
        Array.from({ length: n }, () => ({
          verdict: "refuted",
          severity: "minor",
        })),
      );
    expect([m(0), m(1), m(2), m(3), m(4)]).toEqual([5, 4, 3, 2, 2]);
    expect(
      computeAccuracyFromFactAudit([
        { verdict: "refuted", severity: "fabricated" },
      ]),
    ).toBe(1);
  });
});
