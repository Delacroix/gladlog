/**
 * Unit tests for the geometry grounding scanner — a synthetic fixture of
 * stationary units (zero displacement, so mutations must be detected 100% of the
 * time and a fast-movement escape cannot be triggered). This carries the hard
 * gate on mutation detection.
 */
import { CC_MAX_PLAUSIBLE_RANGE_YARDS } from "@gladlog/analysis";
import { describe, expect, it } from "vitest";
import {
  checkGeoClaims,
  extractGeoClaims,
} from "../src/quality/positioningScan";

/** A stationary unit: fixed coordinates for the entire match. */
function staticUnit(name: string, x: number, y: number, startMs: number): any {
  const advancedActions = Array.from({ length: 61 }, (_, i) => i * 2_000).map(
    (dt) => ({
      timestamp: startMs + dt,
      advancedActorCurrentHp: 100,
      advancedActorMaxHp: 100,
      advancedActorPositionX: x,
      advancedActorPositionY: y,
      advanced: true,
      advancedActorPowers: [],
    }),
  );
  return { name, advancedActions };
}

const START = 1_000_000;
// The owner sits at the origin and the enemy caster at (10, 0) — a constant 10yd
const owner = staticUnit("Me-Realm-US", 0, 0, START);
const friendB = staticUnit("Buddy-Realm-US", 0, 5, START);
const caster = staticUnit("Bad-Realm-US", 10, 0, START);

const ctx = {
  owner,
  friends: [owner, friendB],
  enemies: [caster],
  // Nagrand — a zone with no obstacle data; G5 tests configure their own
  zoneId: "1505",
  matchStartMs: START,
  unitIdMap: new Map<number, string>([
    [1, "Me-Realm-US"],
    [2, "Buddy-Realm-US"],
    [3, "Bad-Realm-US"],
  ]),
};

const PROMPT = [
  '  <unit id="1" name="Me-Realm-US" spec="Holy Paladin" role="log owner">',
  '  <unit id="2" name="Buddy-Realm-US" spec="Arms Warrior" role="teammate">',
  '  <unit id="3" name="Bad-Realm-US" spec="Subtlety Rogue" role="enemy">',
  "0:30  [CC ON TEAM]   1(HPaladin) ← Cheap Shot (by 3(SRogue)) | 4s [DR: Stun Full] | 10.0yd from caster",
  "  0:40–0:50 you were camped by Bad-Realm-US (closest 10.0yd) — peel or reposition opportunity",
  "    0:55 [High burst] 10→10yd from Bad-Realm-US — you were the burst target",
].join("\n");

describe("extractGeoClaims", () => {
  it("extracts unit id map and all claim kinds", () => {
    const { claims, unitIdMap } = extractGeoClaims(PROMPT);
    expect(unitIdMap.get(3)).toBe("Bad-Realm-US");
    expect(claims.map((c) => c.kind)).toEqual([
      "CC_DISTANCE",
      "TRAINED",
      "STAYED_OR_KITED",
    ]);
    const cc = claims[0];
    expect(cc.targetName).toBe("1(HPaladin)");
    expect(cc.unitName).toBe("3(SRogue)");
    expect(cc.distanceYards).toBe(10);
  });
});

describe("checkGeoClaims on static fixture", () => {
  it("true claims pass with 0 violations", () => {
    const { claims } = extractGeoClaims(PROMPT);
    const r = checkGeoClaims(claims, ctx);
    expect(r.checked).toBeGreaterThan(0);
    // The TRAINED definition violation (10yd > 8yd) is one expected hit — swap
    // it out for a compliant distance to verify the rest
    const defViolations = r.violations.filter(
      (v) => v.code !== "G2_TRAINED_DEFINITION",
    );
    expect(defViolations).toEqual([]);
  });

  it("distance mutation (+15yd) is detected on every claim kind (静止单位无逃逸)", () => {
    const { claims } = extractGeoClaims(PROMPT);
    for (const c of claims) {
      const r = checkGeoClaims(
        [{ ...c, distanceYards: c.distanceYards + 15 }],
        ctx,
      );
      expect(r.checked, c.kind).toBe(1);
      expect(r.violations.length, c.kind).toBeGreaterThan(0);
    }
  });

  it("wrong-unit mutation is detected (CC caster swapped to a friend 5yd away)", () => {
    const { claims } = extractGeoClaims(PROMPT);
    const cc = claims.find((c) => c.kind === "CC_DISTANCE")!;
    // Swap the caster for the teammate at (0,5) → caster→target distance is 5yd,
    // not the claimed 10yd
    const r = checkGeoClaims([{ ...cc, unitName: "2(AWarrior)" }], ctx);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it("impossible CC distance (>50yd) flags G6", () => {
    const far = staticUnit("Far-Realm-US", 60, 0, START);
    const farCtx = {
      ...ctx,
      enemies: [far],
      unitIdMap: new Map([
        [1, "Me-Realm-US"],
        [3, "Far-Realm-US"],
      ]),
    };
    const prompt =
      "0:30  [CC ON TEAM]   1(HPaladin) ← Freezing Trap (by 3(BMHunter)) | 4s [DR: Stun Full] | 60.0yd from caster";
    const { claims } = extractGeoClaims(prompt);
    const r = checkGeoClaims(claims, farCtx);
    expect(r.violations.some((v) => v.code === "G6_IMPOSSIBLE_CC")).toBe(true);
  });

  // G6's ceiling = the producing side's suppression threshold in
  // ccTrinketAnalysis, CC_MAX_PLAUSIBLE_RANGE_YARDS. The gate used to hardcode
  // 50 privately while the producing side nulls out any distance above 45, so no
  // real claim in the (45, 50] band could ever trigger G6 — the first case below
  // lands in exactly that band and was green before the tightening.
  it("CC 距离刚过产出侧可信上限即 G6(真距离一致也不放行)", () => {
    const justOver = 1 + CC_MAX_PLAUSIBLE_RANGE_YARDS;
    const far = staticUnit("Far-Realm-US", justOver, 0, START);
    const farCtx = {
      ...ctx,
      enemies: [far],
      unitIdMap: new Map([
        [1, "Me-Realm-US"],
        [3, "Far-Realm-US"],
      ]),
    };
    const prompt = `0:30  [CC ON TEAM]   1(HPaladin) ← Freezing Trap (by 3(BMHunter)) | 4s [DR: Stun Full] | ${justOver.toFixed(1)}yd from caster`;
    const r = checkGeoClaims(extractGeoClaims(prompt).claims, farCtx);
    // The recomputed distance matches the claim → G1 must stay quiet; only G6
    // may fire.
    expect(r.violations.map((v) => v.code)).toEqual(["G6_IMPOSSIBLE_CC"]);
  });

  it("CC 距离正好等于上限时不算违规(边界含等号,与产出侧 <= 一致)", () => {
    const atCap = CC_MAX_PLAUSIBLE_RANGE_YARDS;
    const far = staticUnit("Far-Realm-US", atCap, 0, START);
    const farCtx = {
      ...ctx,
      enemies: [far],
      unitIdMap: new Map([
        [1, "Me-Realm-US"],
        [3, "Far-Realm-US"],
      ]),
    };
    const prompt = `0:30  [CC ON TEAM]   1(HPaladin) ← Freezing Trap (by 3(BMHunter)) | 4s [DR: Stun Full] | ${atCap.toFixed(1)}yd from caster`;
    const r = checkGeoClaims(extractGeoClaims(prompt).claims, farCtx);
    expect(r.violations).toEqual([]);
  });

  it("LoS-break claim on a zone without obstacle data flags G5_NO_GEOMETRY", () => {
    const prompt =
      "0:07  [HEALER EXPOSURE]   Moderate burst — trinket ready — ⚠ Exposed — LoS break ~12.3yd away (pillar-blocks Bad-Realm-US) | …";
    const { claims } = extractGeoClaims(prompt);
    expect(claims).toHaveLength(1);
    const r = checkGeoClaims(claims, { ...ctx, zoneId: "999999" });
    expect(r.violations.some((v) => v.code === "G5_NO_GEOMETRY")).toBe(true);
  });
});
