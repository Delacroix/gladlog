import { describe, expect, it } from "vitest";

import { filterRealPresses } from "./castPress";

const ev = (spellId: string, t: number) => ({
  spellId,
  logLine: { timestamp: t },
});

describe("filterRealPresses — one press, one record (#36(a))", () => {
  it("drops copy ids outright (Twin Flames set proc)", () => {
    const out = filterRealPresses([
      ev("356995", 1000), // Disintegrate-ish real press
      ev("1265980", 1000), // Twin Flames — 100% same-instant proc
    ]);
    expect(out.map((e) => e.spellId)).toEqual(["356995"]);
  });

  it("collapses the same-instant double record (Power Infusion form)", () => {
    const out = filterRealPresses([ev("10060", 5000), ev("10060", 5000)]);
    expect(out).toHaveLength(1);
  });

  it("collapses tick-spaced runs of one spellId to the first event", () => {
    // 1.00s spacing = channel ticks (Sanctified-Ground-style same-id repeats)
    const out = filterRealPresses([
      ev("289655", 1000),
      ev("289655", 2000),
      ev("289655", 3000),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps real filler cadence: 1.4s apart are two presses — do not loosen", () => {
    const out = filterRealPresses([ev("2060", 1000), ev("2060", 2400)]);
    expect(out).toHaveLength(2);
  });

  it("keeps two genuine sub-second-ish presses of DIFFERENT spells", () => {
    const out = filterRealPresses([ev("774", 1000), ev("8936", 1200)]);
    expect(out).toHaveLength(2);
  });

  it("unsorted input still dedupes correctly and preserves original order", () => {
    // 0.6s apart = one press double-recorded slightly apart; the EARLIER event
    // survives regardless of input order.
    const a = ev("289655", 3000);
    const b = ev("289655", 2400);
    const out = filterRealPresses([a, b]);
    expect(out).toEqual([b]);
  });
});
