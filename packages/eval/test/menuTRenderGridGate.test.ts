import { describe, expect, it } from "vitest";

import {
  checkMenuTRenderGrid,
  scanMenuTRenderGrid,
} from "../src/quality/promptQualityCheck";

// Planted defect, the exact shape measured on the 2026-08-30 A/B corpus
// (20/209 kick-eaten lines): a raw atSeconds of 9.96 rendered `t=10.0s`
// (fmtFactNum's toFixed(1) rounds UP into the next second) while the
// matching [KICK] timeline marker -- rendered via fmtTime, which floors --
// still shows `0:09` (the second still in progress).
const KICK_LINE_ROUNDED =
  "  - id=kick-eaten:P1:10 type=kick-eaten t=10.0s units=Me/Rogue facts={t=10.0, interrupted=Heal, kick=Kick, source=Rogue, lockout=3.0}";
const KICK_MARKER_0_09 =
  "0:09  [KICK]   1(Rogue) interrupted 2(Priest)'s Heal (Kick)";

// A correctly-floored fact: fmtFactTime(9.96) truncates to "9.9", whose
// floor (9) agrees with the marker's floor (also 9).
const KICK_LINE_FLOORED =
  "  - id=kick-eaten:P1:9 type=kick-eaten t=9.9s units=Me/Rogue facts={t=9.9, interrupted=Heal, kick=Kick, source=Rogue, lockout=3.0}";

describe("checkMenuTRenderGrid (11th hardFailure class, kick-eaten render-grid fix)", () => {
  it("planted t=10.0 vs [KICK] at 0:09 -> flags the render-grid rounding-up bug", () => {
    const fails = checkMenuTRenderGrid([KICK_LINE_ROUNDED, KICK_MARKER_0_09]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain("t=10");
    expect(fails[0]).toContain("0:10");
    expect(fails[0]).toContain("0:09");
  });

  it("t already floored to agree with its [KICK] marker -> passes", () => {
    expect(checkMenuTRenderGrid([KICK_LINE_FLOORED, KICK_MARKER_0_09])).toEqual(
      [],
    );
  });

  it("a kick-eaten line with no [KICK] marker anywhere is a different failure shape (no-marker), not this gate's concern", () => {
    // scanMenuTRenderGrid can see the distinction; the gate itself only
    // fires on the specific rounding-up fingerprint (marker at floor(t)-1).
    const results = scanMenuTRenderGrid([KICK_LINE_ROUNDED]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("no-marker");
    expect(checkMenuTRenderGrid([KICK_LINE_ROUNDED])).toEqual([]);
  });

  it("non-kick-eaten types are out of this gate's scope even with the same rounding shape", () => {
    // death shares the identical bug pattern (verified separately on the
    // corpus and fixed the same way), but checkMenuTRenderGrid's hardFailure
    // text is kick-eaten-only per the fix's scope -- scanMenuTRenderGrid
    // still sees it (used by menuTRenderGridScan.ts's audit).
    const deathLine =
      "  - id=death:P2:230 type=death t=230.0s units=Ally facts={t=230.0, unit=Ally, side=friendly}";
    const deathMarker =
      "3:49  [DEATH]  2(RPaladin) (Retribution Paladin — friendly)";
    expect(checkMenuTRenderGrid([deathLine, deathMarker])).toEqual([]);
    const results = scanMenuTRenderGrid([deathLine, deathMarker]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("off-by-one");
  });
});
