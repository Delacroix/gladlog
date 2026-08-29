import { describe, expect, it } from "vitest";

import {
  buildBehaviorPriorTable,
  dmgBinOf,
} from "../src/explore/behaviorPriorTable";

const point = (over: Record<string, unknown> = {}) => ({
  tMs: 0,
  tSec: 0,
  hpPct: 38,
  dmg2s: 0.25,
  attackers2s: 2,
  enemyBurst: false,
  inCC: false,
  lockedOut: false,
  diedInWindow: false,
  responses: {
    selfHeal: true,
    wall: false,
    external: false,
    control: false,
    peel: false,
    kite: false,
  },
  responded: true,
  selfHealPct: 30,
  feasible: true,
  ...over,
});
const meta = {
  generatedAt: "t",
  corpus: "c",
  weeks: ["2026-W33"],
  command: "x",
  predicateVersion: 1,
  topPercentile: 90,
};

describe("buildBehaviorPriorTable", () => {
  it("bins dmg2s", () => {
    expect(dmgBinOf(0.05)).toBe("<10%");
    expect(dmgBinOf(0.1)).toBe("10-20%");
    expect(dmgBinOf(0.2)).toBe(">=20%");
  });
  it("only top-10% feasible rows enter; cell and star cell both written", () => {
    const rows = [
      { bracket: "3v3", pct: 95, point: point() },
      {
        bracket: "3v3",
        pct: 95,
        point: point({
          responded: false,
          responses: {
            selfHeal: false,
            wall: false,
            external: false,
            control: false,
            peel: false,
            kite: false,
          },
        }),
      },
      { bracket: "3v3", pct: 50, point: point() }, // not top10
      { bracket: "3v3", pct: 95, point: point({ feasible: false }) }, // gated
      { bracket: "3v3", pct: null, point: point() }, // unranked
    ];
    const t = buildBehaviorPriorTable(rows, meta);
    expect(t.cells["3v3|healer|>=20%"]).toEqual({
      n: 2,
      respondRate: 0.5,
      top: [["selfHeal", 0.5]],
      selfHealMedianPct: 30,
    });
    expect(t.cells["3v3|healer|*"]!.n).toBe(2);
    expect(t.meta.topPercentile).toBe(90);
  });
  it("top lists at most three responses, descending", () => {
    const rows = [
      {
        bracket: "2v2",
        pct: 99,
        point: point({
          responses: {
            selfHeal: true,
            wall: true,
            external: false,
            control: true,
            peel: false,
            kite: true,
          },
        }),
      },
      {
        bracket: "2v2",
        pct: 99,
        point: point({
          responses: {
            selfHeal: true,
            wall: true,
            external: false,
            control: false,
            peel: false,
            kite: false,
          },
        }),
      },
      {
        bracket: "2v2",
        pct: 99,
        point: point({
          responses: {
            selfHeal: true,
            wall: false,
            external: false,
            control: false,
            peel: false,
            kite: false,
          },
        }),
      },
    ];
    const t = buildBehaviorPriorTable(rows, meta);
    expect(t.cells["2v2|healer|>=20%"]!.top).toEqual([
      ["selfHeal", 1],
      ["wall", 0.67],
      ["control", 0.33],
    ]);
  });
});
