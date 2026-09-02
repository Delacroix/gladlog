import { describe, expect, it } from "vitest";

import {
  buildDpsKillWindowLines,
  killWindowAcquittal,
  killWindowFactsSuffix,
} from "./killWindowFacts";

const facts = (over: Record<string, unknown> = {}) => ({
  readyOffCds: ["Avenging Wrath"],
  reachable: true as boolean | null,
  healerLocked: false,
  accountable: true,
  ...over,
});

describe("killWindowFacts (GH #31 ①)", () => {
  it("suffix: ready list + healer state; unreachable only when positions disproved it", () => {
    expect(killWindowFactsSuffix(facts({ healerLocked: true }))).toBe(
      "team offensive CDs ready: Avenging Wrath; enemy healer hard-CC'd in window",
    );
    expect(killWindowFactsSuffix(facts({ readyOffCds: [] }))).toBe(
      "no team offensive CD ready",
    );
    // fail-open: null reachability renders NOTHING about reach
    expect(killWindowFactsSuffix(facts({ reachable: null }))).not.toContain(
      "unreachable",
    );
    expect(killWindowFactsSuffix(facts({ reachable: false }))).toContain(
      "target unreachable (positions recorded)",
    );
  });

  it("acquittal names every failed gate", () => {
    expect(
      killWindowAcquittal(facts({ readyOffCds: [], reachable: false })),
    ).toBe("no offensive CD was ready and target unreachable");
  });

  it("DPS lines: burst spans render [KILL WINDOW] facts (never gated); unpunished spans gate the accusation", () => {
    const enemies = [{ id: "e1", name: "Edk" }] as never[];
    const mk = (f: ReturnType<typeof facts>) => ({
      facts: () => f,
    });
    const win = {
      targetUnitId: "e1",
      targetName: "Edk",
      targetSpec: "Frost Death Knight",
      fromSeconds: 40,
      toSeconds: 100,
      friendlyDamageInWindow: 8_000,
      bursts: [] as Array<{
        fromSeconds: number;
        toSeconds: number;
        damage: number;
      }>,
    };
    // accountable unpunished span → accusation stands
    const accused = buildDpsKillWindowLines([win], enemies, mk(facts()));
    expect(accused[0]).toContain("[VULNERABLE]");
    expect(accused[0]).toContain("never punished");
    // gate fails → acquitted state, reason named
    const acquitted = buildDpsKillWindowLines(
      [win],
      enemies,
      mk(facts({ readyOffCds: [], accountable: false })),
    );
    expect(acquitted[0]).toContain(
      "not punished — not accountable (no offensive CD was ready)",
    );
    // burst present → [KILL WINDOW] fact line even when NOT accountable
    // (value-gate smoke 2026-09-02: killable=no bursts still killed — the
    // burst itself is the capability evidence, facts are never a gate here)
    const burstWin = {
      ...win,
      bursts: [{ fromSeconds: 50, toSeconds: 55, damage: 900_000 }],
    };
    const killLines = buildDpsKillWindowLines(
      [burstWin],
      enemies,
      mk(facts({ readyOffCds: [], accountable: false })),
    );
    expect(killLines[0]).toContain("[KILL WINDOW] 0:50–0:55");
    expect(killLines[0]).toContain("team burst 900k");
    expect(killLines[0]).toContain("no team offensive CD ready");
  });
});
