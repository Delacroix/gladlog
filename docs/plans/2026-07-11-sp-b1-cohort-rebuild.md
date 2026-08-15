# SP-B1 Cohort Corpus Rebuild Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline maintainer tool that uses gladlog's own parser + ported healerMetrics to recompute all cohort baselines from 2300+ public feeds on wowarenalogs.com, outputting version-stamped, de-embedded static `reference_vectors.json` for SP-B2 consumption.

**Architecture:** Metric computation (healerMetrics + crisisEvents) is ported into `@gladlog/analysis`, shared with the production pipeline; collection/aggregation logic is placed in a **newly created offline package `packages/corpus-tools`** (not included in the desktop app distribution). Cell = `spec × bracket × archetype` (reusing gladlog's existing archetype classifier) + hierarchical fallback + N_floor=30. Core aggregator and validator are pure functions with comprehensive unit tests; feed collection is the integration layer.

**Tech Stack:** TypeScript (ESM), Node, vitest, `@gladlog/parser` + `@gladlog/parser-compat` + `@gladlog/analysis`, `node-fetch` (GraphQL).

## Global Constraints

- **Compliant Extraction**: Legacy fork source files may only be extracted CLEAN by the controller in accordance with subproject 0 audit; agy/subagents must not read `/Users/mingjianliu/code/wowarenalogs`. The legacy code for each "port" step in this plan has already been pasted into the step by the controller — implementers copy + change imports, without reading the legacy repository.
- **Zero External Dependencies at Release Layer**: `packages/corpus-tools` must never be imported by the desktop App (`packages/desktop`); output is static JSON.
- **De-embedding**: Corpus contains no embedding columns (not used in the new pipeline).
- **N_floor = 30**: Cells with sample < 30 are marked `insufficient: true`; underpopulated archetype-cells fall back to `spec × bracket` parent cells, and are only marked insufficient if the parent cell is still below floor.
- **Honest Metrics**: All metrics are calculated by code, containing no model-generated numbers (prerequisite for SP-B2's claimChecker).
- **ESM + vitest**: Consistent with existing packages (`"type": "module"`, `.ts` run directly via tsx; tests `*.test.ts`, `describe/it`).
- **Check test exit code before committing**, only commit when green.

### Deviations from Spec (Requires User Confirmation)

Spec § Data Sources listed a Python talent clustering bridge (`get_spec_clusters.py` → `pythonClusterRank`). **This plan drops it per YAGNI**: The aggregator only uses `metrics + crisisEvents` (the load-bearing input for exemplars), and `pythonClusterRank` will only be used if SP-B2 requires exemplar diversification — added then if needed, without blocking B1 or introducing build-time dependencies on a separate Python repository. If the user requires B1 to include clusters, append an enrichment task (download → gladlog parse then invoke Python bridge to write clusterRank into PerMatchRecord).

---

### Task 1: Port healerMetrics into @gladlog/analysis

**Files:**

- Create: `packages/analysis/src/utils/healerMetrics.ts`
- Modify: `packages/analysis/src/index.ts` (add exports)
- Test: `packages/analysis/src/utils/healerMetrics.test.ts`

**Interfaces:**

- Consumes (all inside @gladlog/analysis): `reconstructEnemyCDTimeline`, `extractMajorCooldowns`, `annotateDefensiveTimings`, `detectOverlappedDefensives`, `IMajorCooldownInfo`, `MAJOR_DEFENSIVE_IDS` (from `./cooldowns`); `analyzePlayerCCAndTrinket` (from `./ccTrinketAnalysis`); `ccSpellIds` (from `../data/spellTags`); `CombatUnitType`, `LogEvent`, `IArenaMatch`, `IShuffleRound` (from `@gladlog/parser-compat`).
- Produces: `computeHealerMetrics(combat: IArenaMatch | IShuffleRound, playerName: string): IHealerMetrics`; `IHealerMetrics` (see below); `computeCDResponseLatency(...)`.

- [ ] **Step 1: Write failing test**

`packages/analysis/src/utils/healerMetrics.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeHealerMetrics } from "./healerMetrics";

// Minimal synthetic combat: one healer unit, no damage no healing -> offensiveIndex=0, rest within domain.
function stubCombat(): any {
  const healer = {
    name: "H-Realm-US",
    type: 1,
    reaction: 2,
    spec: "264", // Resto Shaman
    damageOut: [],
    healOut: [],
    absorbsOut: [],
    spellCastEvents: [],
    auraEvents: [],
    advancedActions: [],
    deathRecords: [],
    info: { teamId: "0" },
  };
  return {
    units: { "H-Realm-US": healer },
    startTime: 0,
    endTime: 60000,
    playerId: "H-Realm-US",
  };
}

describe("computeHealerMetrics", () => {
  it("returns all six metrics in-domain for a no-op healer", () => {
    const m = computeHealerMetrics(stubCombat(), "H-Realm-US");
    expect(m.offensiveIndex).toBe(0);
    expect(m.ccDensity).toBe(0);
    expect(m.reactionLatency).toBeNull();
    expect(m.effectiveCastRatio).toBeGreaterThanOrEqual(0);
    expect(m.ccAvoidanceRate).toBeGreaterThanOrEqual(0);
    expect(m.defensiveOverlapRatio).toBeGreaterThanOrEqual(0);
    expect(m.burstResponseCoverage).toEqual({ answered: 0, windows: 0 });
  });
  it("throws when the named healer is absent", () => {
    expect(() => computeHealerMetrics(stubCombat(), "Nobody")).toThrow(
      /not found/,
    );
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/analysis && npx vitest run src/utils/healerMetrics.test.ts`
Expected: FAIL (`Cannot find module './healerMetrics'`).

- [ ] **Step 3: Create healerMetrics.ts (controller pasted old repo CLEAN source, change imports)**

Drop the following CLEAN content from old fork `shared/utils/healerMetrics.ts` as-is into `packages/analysis/src/utils/healerMetrics.ts`, **only changing top imports**: `@wowarenalogs/parser` → `@gladlog/parser-compat`; keep `../data/spellTags`, `./ccTrinketAnalysis`, `./cooldowns`, `./enemyCDs` relative paths (located under analysis/src/utils and data). Function body unchanged:

```typescript
import {
  CombatUnitType,
  IArenaMatch,
  IShuffleRound,
  LogEvent,
} from "@gladlog/parser-compat";
import { ccSpellIds } from "../data/spellTags";
import { analyzePlayerCCAndTrinket } from "./ccTrinketAnalysis";
import {
  annotateDefensiveTimings,
  detectOverlappedDefensives,
  extractMajorCooldowns,
  IMajorCooldownInfo,
  MAJOR_DEFENSIVE_IDS,
} from "./cooldowns";
import { reconstructEnemyCDTimeline } from "./enemyCDs";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[half];
  return (sorted[half - 1] + sorted[half]) / 2.0;
}

export function computeCDResponseLatency(
  annotatedCooldowns: IMajorCooldownInfo[],
  burstWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
): { latencyMsMedian: number | null; answered: number; windows: number } {
  const answeredLatencies: Array<number | null> = burstWindows.map((w) => {
    const windowStartMs = w.fromSeconds * 1000 + matchStartMs;
    const windowEndMs = w.toSeconds * 1000 + matchStartMs;
    let best: number | null = null;
    for (const cd of annotatedCooldowns) {
      for (const cast of cd.casts) {
        if (cast.timingLabel !== "Optimal" && cast.timingLabel !== "Reactive")
          continue;
        const castMs = cast.timeSeconds * 1000 + matchStartMs;
        if (castMs >= windowStartMs && castMs <= windowEndMs + 8000) {
          const latency = castMs - windowStartMs;
          if (latency >= 0 && (best === null || latency < best)) best = latency;
        }
      }
    }
    return best;
  });
  const hit = answeredLatencies.filter((x): x is number => x !== null);
  return {
    latencyMsMedian: hit.length ? median(hit) : null,
    answered: hit.length,
    windows: burstWindows.length,
  };
}

export interface IHealerMetrics {
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number | null;
  burstResponseCoverage: { answered: number; windows: number };
  defensiveOverlapRatio: number;
  effectiveCastRatio: number;
  ccAvoidanceRate: number;
  ccAvoidedCount: number;
  ccLandedCount: number;
}

export function computeHealerMetrics(
  combat: IArenaMatch | IShuffleRound,
  playerName: string,
): IHealerMetrics {
  const allUnits = Object.values(combat.units) as any[];
  const healerUnit = allUnits.find(
    (u) => u.name === playerName && u.type === CombatUnitType.Player,
  );
  if (!healerUnit)
    throw new Error(`Healer unit ${playerName} not found in combat.`);

  const totalDamageOut = healerUnit.damageOut.reduce(
    (sum: number, a: any) => sum + Math.abs(a.effectiveAmount),
    0,
  );
  const totalHealOut =
    healerUnit.healOut.reduce((sum: number, a: any) => {
      if (
        (a.logLine.event === "SPELL_PERIODIC_HEAL" ||
          a.logLine.event === "SPELL_HEAL") &&
        typeof a.logLine.parameters[30] === "number" &&
        typeof a.logLine.parameters[32] === "number" &&
        !isNaN(a.logLine.parameters[30]) &&
        !isNaN(a.logLine.parameters[32])
      ) {
        return sum + (a.logLine.parameters[30] - a.logLine.parameters[32]);
      }
      return sum + Math.abs(a.effectiveAmount);
    }, 0) +
    healerUnit.absorbsOut.reduce(
      (sum: number, a: any) => sum + Math.abs(a.effectiveAmount),
      0,
    );
  const offensiveIndex = totalHealOut > 0 ? totalDamageOut / totalHealOut : 0;

  const ccCasts = healerUnit.spellCastEvents.filter(
    (e: any) =>
      e.logLine.event === "SPELL_CAST_SUCCESS" &&
      ccSpellIds.has(String(e.spellId)),
  );
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  const ccDensity =
    durationSeconds > 0 ? (ccCasts.length / durationSeconds) * 60 : 0;

  const friends = allUnits.filter(
    (u) =>
      u.type === CombatUnitType.Player && u.reaction === healerUnit.reaction,
  );
  const enemies = allUnits.filter(
    (u) =>
      u.type === CombatUnitType.Player && u.reaction !== healerUnit.reaction,
  );
  const enemyCDTimeline = reconstructEnemyCDTimeline(
    enemies,
    combat as any,
    healerUnit,
    friends,
  );
  const cooldowns = extractMajorCooldowns(healerUnit, combat as any);
  const annotated = annotateDefensiveTimings(
    cooldowns,
    healerUnit,
    combat as any,
    enemyCDTimeline as any,
  );
  const lat = computeCDResponseLatency(
    annotated,
    (enemyCDTimeline as any).alignedBurstWindows,
    combat.startTime,
  );
  const reactionLatency =
    lat.latencyMsMedian !== null ? lat.latencyMsMedian / 1000 : null;
  const burstResponseCoverage = {
    answered: lat.answered,
    windows: lat.windows,
  };

  const overlaps = detectOverlappedDefensives(friends, combat as any);
  const myOverlapCount = overlaps.filter(
    (o: any) =>
      o.firstCasterName === playerName || o.secondCasterName === playerName,
  ).length;
  const myTotalDefensives = healerUnit.spellCastEvents.filter(
    (e: any) =>
      e.logLine.event === LogEvent.SPELL_CAST_SUCCESS &&
      MAJOR_DEFENSIVE_IDS.has(String(e.spellId)),
  ).length;
  const defensiveOverlapRatio = myOverlapCount / (myTotalDefensives + 1);

  const ccTrinketSummary = analyzePlayerCCAndTrinket(
    healerUnit,
    enemies,
    combat as any,
  );
  const successCasts = healerUnit.spellCastEvents.filter(
    (e: any) => e.logLine.event === "SPELL_CAST_SUCCESS",
  ).length;
  const interuptsOnMe = ccTrinketSummary.interruptInstances.length;
  const effectiveCastRatio = successCasts / (successCasts + interuptsOnMe + 1);

  const avoidedCount = ccTrinketSummary.ccAvoidedInstances.length;
  const successfulCCCount = ccTrinketSummary.ccInstances.length;
  const ccAvoidanceRate = avoidedCount / (avoidedCount + successfulCCCount + 1);

  return {
    offensiveIndex,
    ccDensity,
    reactionLatency,
    burstResponseCoverage,
    defensiveOverlapRatio,
    effectiveCastRatio,
    ccAvoidanceRate,
    ccAvoidedCount: avoidedCount,
    ccLandedCount: successfulCCCount,
  };
}
```

If any dependency (e.g., `MAJOR_DEFENSIVE_IDS`) is not exported from `./cooldowns`, add `export`.

- [ ] **Step 4: Export from index**

Append to the end of `packages/analysis/src/index.ts`:

```typescript
export {
  computeHealerMetrics,
  computeCDResponseLatency,
} from "./utils/healerMetrics";
export type { IHealerMetrics } from "./utils/healerMetrics";
```

- [ ] **Step 5: Run tests + full test suite + tc**

Run: `cd packages/analysis && npx vitest run src/utils/healerMetrics.test.ts && npx vitest run && npx tsc --noEmit`
Expected: New test PASS; existing 491 tests still PASS; tc=0.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/utils/healerMetrics.ts packages/analysis/src/utils/healerMetrics.test.ts packages/analysis/src/index.ts
git commit -m "feat(analysis): port computeHealerMetrics from old fork (SP-B1 T1)"
```

---

### Task 2: Port crisisEvents / extractRotations into @gladlog/analysis

**Files:**

- Create: `packages/analysis/src/utils/crisisEvents.ts`
- Modify: `packages/analysis/src/index.ts`
- Test: `packages/analysis/src/utils/crisisEvents.test.ts`

**Interfaces:**

- Consumes: `ICombatUnit`, `AtomicArenaCombat` (from `@gladlog/parser-compat`).
- Produces: `extractRotations(player: ICombatUnit, match: AtomicArenaCombat): IExtractedRotations`; `IExtractedRotations { opener: string[]; coreSequences: string[]; crisisEvents: string[] }`.

- [ ] **Step 1: Write failing test**

`packages/analysis/src/utils/crisisEvents.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractRotations } from "./crisisEvents";

function stubUnit(): any {
  return {
    name: "H-Realm-US",
    spellCastEvents: [],
    deathRecords: [],
    damageIn: [],
  };
}
function stubMatch(): any {
  return { units: {}, startTime: 0, endTime: 60000 };
}

describe("extractRotations", () => {
  it("returns empty rotation arrays for a unit with no casts", () => {
    const r = extractRotations(stubUnit(), stubMatch());
    expect(r.opener).toEqual([]);
    expect(r.coreSequences).toEqual([]);
    expect(r.crisisEvents).toEqual([]);
  });
  it("crisisEvents entries are ASCII (English spell names)", () => {
    const r = extractRotations(stubUnit(), stubMatch());
    for (const c of r.crisisEvents) expect(c).toMatch(/^[\x00-\x7F]*$/);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/analysis && npx vitest run src/utils/crisisEvents.test.ts`
Expected: FAIL (`Cannot find module './crisisEvents'`).

- [ ] **Step 3: Create crisisEvents.ts**

From old fork `shared/utils/matchEmbeddingRecord.ts`, extract **only `extractRotations` + `IExtractedRotations`** (without embedding builder / RawMatchRecord; extractRotations itself does not use them). Change imports: old `englishSpellName` → gladlog's `getEnglishSpellName`; `PASSIVE_SPELL_BLOCKLIST` from `./cooldowns` (already in gladlog); types from `@gladlog/parser-compat`. Function body unchanged (verified `PASSIVE_SPELL_BLOCKLIST`, `advancedActorId`, `advancedActorCurrentHp/MaxHp` are all present in gladlog):

```typescript
import {
  AtomicArenaCombat,
  CombatUnitType,
  ICombatUnit,
} from "@gladlog/parser-compat";
import { PASSIVE_SPELL_BLOCKLIST } from "./cooldowns";
import { getEnglishSpellName } from "../data/spellEffectData";

export interface IExtractedRotations {
  opener: string[];
  coreSequences: string[];
  crisisEvents: string[];
}

export function extractRotations(
  player: ICombatUnit,
  match: AtomicArenaCombat,
): IExtractedRotations {
  const casts = player.spellCastEvents
    .filter(
      (e) =>
        e.spellName &&
        e.logLine?.event === "SPELL_CAST_SUCCESS" &&
        !PASSIVE_SPELL_BLOCKLIST.has(e.spellName),
    )
    .map((e) => ({
      spellId: e.spellId,
      name: e.spellName as string,
      time: (e.logLine.timestamp - match.startTime) / 1000,
    }))
    .sort((a, b) => a.time - b.time);

  const opener = casts.filter((c) => c.time <= 30).map((c) => c.name);

  const seqCounts: Record<string, number> = {};
  for (let i = 0; i < casts.length - 2; i++) {
    const chain = `${getEnglishSpellName(casts[i].spellId ?? "", casts[i].name)} -> ${getEnglishSpellName(casts[i + 1].spellId ?? "", casts[i + 1].name)} -> ${getEnglishSpellName(casts[i + 2].spellId ?? "", casts[i + 2].name)}`;
    seqCounts[chain] = (seqCounts[chain] || 0) + 1;
  }
  const coreSequences = Object.entries(seqCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([seq, count]) => `${seq} (used ${count}x)`);

  const teamUnits = (Object.values(match.units) as ICombatUnit[]).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === player.reaction,
  );
  const allTeamHpRecords = teamUnits
    .flatMap((u) =>
      (u.advancedActions || [])
        .filter(
          (a: any) =>
            a.advanced &&
            a.advancedActorId === u.id &&
            a.advancedActorMaxHp > 0,
        )
        .map((a: any) => ({
          targetName: u.name,
          time: (a.logLine.timestamp - match.startTime) / 1000,
          pct: (a.advancedActorCurrentHp / a.advancedActorMaxHp) * 100,
        })),
    )
    .sort((a, b) => a.time - b.time);

  const crisisEvents: string[] = [];
  let lastCrisisTime = -999;
  for (const record of allTeamHpRecords) {
    if (record.pct < 40 && record.time - lastCrisisTime > 15) {
      lastCrisisTime = record.time;
      const responseCasts = casts
        .filter((c) => c.time >= record.time && c.time <= record.time + 6)
        .map((c) => getEnglishSpellName(c.spellId ?? "", c.name));
      if (responseCasts.length > 0) {
        crisisEvents.push(
          `At ${record.time.toFixed(1)}s (Teammate ${record.targetName} HP: ${Math.floor(record.pct)}%): ${responseCasts.join(" -> ")}`,
        );
      }
    }
  }
  return { opener, coreSequences, crisisEvents };
}
```

> Note: crisis strings take the form `"At 14.0s (Teammate H-Realm-US HP: 32%): Nature's Swiftness -> Healing Wave"`, fully English (`getEnglishSpellName` guarantee) — satisfying validator ASCII gate. The correct source module for `getEnglishSpellName` follows existing exports in gladlog analysis (already exported in `../data/spellEffectData`).

- [ ] **Step 4: Export from index**

```typescript
export { extractRotations } from "./utils/crisisEvents";
export type { IExtractedRotations } from "./utils/crisisEvents";
```

- [ ] **Step 5: Run test + tc**

Run: `cd packages/analysis && npx vitest run src/utils/crisisEvents.test.ts && npx tsc --noEmit`
Expected: PASS; tc=0.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/utils/crisisEvents.ts packages/analysis/src/utils/crisisEvents.test.ts packages/analysis/src/index.ts
git commit -m "feat(analysis): port extractRotations/crisisEvents from old fork (SP-B1 T2)"
```

---

### Task 3: Enemy-Comp Archetype Classifier (Cohort Celling Axis)

> **Plan Revision (Execution Phase, Controller)**: The original plan was to reuse gladlog's `computeMatchArchetype` ([MATCH TYPE] tag). After auditing the actual API, it was found to be a **match dynamics** (burst tempo) classifier, taking 6 parameters (with heavy dependencies on ccTrinketSummaries / alignedBurstWindows / healerExposures), returning measurements, requiring tags to be assembled via 15-field dynamics + classifyMatchArchetype, and returning empty strings for short matches / noisy clusters. The aggregation pitfall identified in the Gemini debate is essentially **enemy team comp** dependence, not burst dynamics. Therefore, switched to a **custom enemy-comp classifier**: self-contained (only requires `isMeleeSpec`/`isHealerSpec` + enemy specs), better fits the comp-context intent, uses the same function to classify both cohort and user matches (SP-B2 uses identical lookup for cell), and is naturally non-empty (always falls into a deterministic bucket).

**Files:**

- Create: `packages/analysis/src/utils/enemyCompArchetype.ts`
- Modify: `packages/analysis/src/index.ts`
- Test: `packages/analysis/src/utils/enemyCompArchetype.test.ts`

**Interfaces:**

- Consumes: `isMeleeSpec`, `isHealerSpec` (from `./cooldowns`); `ICombatUnit` (from `@gladlog/parser-compat`).
- Produces: `enemyCompArchetype(enemies: ICombatUnit[]): string` — returns one of 4 buckets: `"melee_cleave"` / `"caster_cleave"` / `"hybrid"` / `"other"`.

- [ ] **Step 1: Write failing test (real behavior assertions)**

`packages/analysis/src/utils/enemyCompArchetype.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { enemyCompArchetype } from "./enemyCompArchetype";

// Construct enemy units using spec id; isMeleeSpec/isHealerSpec determined per gladlog's CombatUnitSpec.
// spec constants taken from CombatUnitSpec in @gladlog/parser-compat (implementers import real values):
//   melee dps eg: Warrior_Arms; ranged dps eg: Mage_Frost; healer eg: Paladin_Holy.
function u(spec: string): any {
  return { spec, type: 1 };
}

describe("enemyCompArchetype", () => {
  it("two melee dps -> melee_cleave", () => {
    // Two melee dps + one healer
    expect(enemyCompArchetype([u(MELEE), u(MELEE), u(HEALER)])).toBe(
      "melee_cleave",
    );
  });
  it("two ranged dps -> caster_cleave", () => {
    expect(enemyCompArchetype([u(RANGED), u(RANGED), u(HEALER)])).toBe(
      "caster_cleave",
    );
  });
  it("one melee + one ranged dps -> hybrid", () => {
    expect(enemyCompArchetype([u(MELEE), u(RANGED), u(HEALER)])).toBe("hybrid");
  });
  it("no dps (edge) -> other", () => {
    expect(enemyCompArchetype([u(HEALER)])).toBe("other");
  });
});
```

> Implementer: Replace `MELEE`/`RANGED`/`HEALER` with real values from `CombatUnitSpec` in `@gladlog/parser-compat` — one melee spec where `isMeleeSpec` evaluates to true (e.g. Arms Warrior), one ranged spec where `isMeleeSpec` is false and not a healer (e.g. Frost Mage), one healer spec where `isHealerSpec` is true (e.g. Holy Paladin). Can first `console.log` in implementation file or check spec sets in `cooldowns.ts` to confirm.

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/analysis && npx vitest run src/utils/enemyCompArchetype.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement enemyCompArchetype.ts**

```typescript
import type { ICombatUnit } from "@gladlog/parser-compat";
import { isHealerSpec, isMeleeSpec } from "./cooldowns";

/**
 * Enemy composition axis for cohort-celling. Coarse 4 buckets, balancing tactical context (healer metric profiles vary with enemy comp)
 * and sample volume (few buckets). Cohort and user matches use the same function for classification, ensuring consistent cell lookups in SP-B2.
 */
export function enemyCompArchetype(enemies: ICombatUnit[]): string {
  const dps = enemies.filter((e) => !isHealerSpec(e.spec));
  const melee = dps.filter((e) => isMeleeSpec(e.spec)).length;
  const ranged = dps.length - melee;
  if (melee >= 2) return "melee_cleave";
  if (ranged >= 2) return "caster_cleave";
  if (melee >= 1 && ranged >= 1) return "hybrid";
  return "other";
}
```

If `isMeleeSpec`/`isHealerSpec` are not exported from `./cooldowns`, add `export`.

- [ ] **Step 4: Export from index**

```typescript
export { enemyCompArchetype } from "./utils/enemyCompArchetype";
```

- [ ] **Step 5: Run tests + tc**

Run: `cd packages/analysis && npx vitest run src/utils/enemyCompArchetype.test.ts && npx tsc --noEmit`
Expected: 4 tests PASS; tc=0.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/utils/enemyCompArchetype.ts packages/analysis/src/utils/enemyCompArchetype.test.ts packages/analysis/src/index.ts
git commit -m "feat(analysis): enemy-comp archetype classifier for cohort celling (SP-B1 T3)"
```

---

### Task 4: Corpus Cell Aggregator (Pure Function)

**Files:**

- Create: `packages/corpus-tools/package.json`, `packages/corpus-tools/tsconfig.json`
- Create: `packages/corpus-tools/src/cellAggregator.ts`
- Test: `packages/corpus-tools/src/cellAggregator.test.ts`

**Interfaces:**

- Consumes: `IHealerMetrics` (from `@gladlog/analysis`).
- Produces: `aggregateCells(records: PerMatchRecord[], nFloor: number): Corpus`; types:

  ```typescript
  interface PerMatchRecord {
    spec: string;
    bracket: string;
    archetype: string;
    metrics: IHealerMetrics;
    crisisEvents: string[];
  }
  interface MetricDist {
    p10: number;
    p50: number;
    p90: number;
    n: number;
  }
  interface Cell {
    spec: string;
    bracket: string;
    archetype: string; // "*" = bracket-wide parent cell
    sampleN: number;
    insufficient: boolean;
    metrics: Record<string, MetricDist>;
    exemplarCrises: string[][];
  }
  interface Corpus {
    wowPatchVersion: string;
    builtAt: string;
    sourceFloor: number;
    cells: Cell[];
  }
  ```

- [ ] **Step 1: Scaffold package**

`packages/corpus-tools/package.json`:

```json
{
  "name": "@gladlog/corpus-tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@gladlog/parser": "workspace:*",
    "@gladlog/parser-compat": "workspace:*",
    "@gladlog/analysis": "workspace:*",
    "fs-extra": "^11.2.0",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "tsx": "^4.7.0"
  }
}
```

`packages/corpus-tools/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "target": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

(Align version numbers with actual vitest/tsx/typescript versions in monorepo's existing packages — implementers follow `packages/analysis/package.json`.)

- [ ] **Step 2: Write failing test**

`packages/corpus-tools/src/cellAggregator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { aggregateCells, PerMatchRecord } from "./cellAggregator";

function rec(archetype: string, offensiveIndex: number): PerMatchRecord {
  return {
    spec: "RestorationShaman",
    bracket: "3v3",
    archetype,
    metrics: {
      offensiveIndex,
      ccDensity: 1,
      reactionLatency: 2,
      burstResponseCoverage: { answered: 1, windows: 2 },
      defensiveOverlapRatio: 0.1,
      effectiveCastRatio: 0.9,
      ccAvoidanceRate: 0.5,
      ccAvoidedCount: 1,
      ccLandedCount: 1,
    },
    crisisEvents: [`[0:10] crisis ${offensiveIndex}`],
  };
}

describe("aggregateCells", () => {
  it("builds an archetype cell and a bracket-wide parent cell", () => {
    const recs = Array.from({ length: 40 }, (_, i) => rec("cc_swap_burst", i));
    const corpus = aggregateCells(recs, 30);
    const arche = corpus.cells.find((c) => c.archetype === "cc_swap_burst")!;
    const parent = corpus.cells.find((c) => c.archetype === "*")!;
    expect(arche.sampleN).toBe(40);
    expect(arche.insufficient).toBe(false);
    expect(arche.metrics.offensiveIndex.p50).toBeCloseTo(19.5, 0); // median of 0..39 ≈ 19.5
    expect(parent.sampleN).toBe(40);
  });
  it("marks an under-floor archetype cell insufficient", () => {
    const recs = Array.from({ length: 5 }, (_, i) => rec("rare_arch", i));
    const corpus = aggregateCells(recs, 30);
    const cell = corpus.cells.find((c) => c.archetype === "rare_arch")!;
    expect(cell.insufficient).toBe(true);
  });
  it("per-metric n excludes null reactionLatency", () => {
    const recs = Array.from({ length: 30 }, () => {
      const r = rec("cc_swap_burst", 5);
      (r.metrics as any).reactionLatency = null;
      return r;
    });
    const corpus = aggregateCells(recs, 30);
    const cell = corpus.cells.find((c) => c.archetype === "cc_swap_burst")!;
    expect(cell.metrics.reactionLatency.n).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to confirm failure**

Run: `cd packages/corpus-tools && npx vitest run src/cellAggregator.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 4: Implement cellAggregator.ts**

```typescript
import type { IHealerMetrics } from "@gladlog/analysis";

export interface PerMatchRecord {
  spec: string;
  bracket: string;
  archetype: string;
  metrics: IHealerMetrics;
  crisisEvents: string[];
}
export interface MetricDist {
  p10: number;
  p50: number;
  p90: number;
  n: number;
}
export interface Cell {
  spec: string;
  bracket: string;
  archetype: string;
  sampleN: number;
  insufficient: boolean;
  metrics: Record<string, MetricDist>;
  exemplarCrises: string[][];
}
export interface Corpus {
  wowPatchVersion: string;
  builtAt: string;
  sourceFloor: number;
  cells: Cell[];
}

// Metric extraction per dimension: 6 scalar dimensions; reactionLatency can be null (excluded from distribution for that dimension).
const SCALAR_METRICS: Array<keyof IHealerMetrics> = [
  "offensiveIndex",
  "ccDensity",
  "reactionLatency",
  "defensiveOverlapRatio",
  "effectiveCastRatio",
  "ccAvoidanceRate",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function distFor(
  records: PerMatchRecord[],
  metric: keyof IHealerMetrics,
): MetricDist {
  const vals = records
    .map((r) => r.metrics[metric])
    .filter((v): v is number => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  return {
    p10: percentile(vals, 0.1),
    p50: percentile(vals, 0.5),
    p90: percentile(vals, 0.9),
    n: vals.length,
  };
}

function buildCell(
  spec: string,
  bracket: string,
  archetype: string,
  records: PerMatchRecord[],
  nFloor: number,
): Cell {
  const metrics: Record<string, MetricDist> = {};
  for (const m of SCALAR_METRICS) metrics[m as string] = distFor(records, m);
  // exemplar: take crisisEvents from each record (SP-B2 will perform diversification selection), capped at 50 to prevent bloat
  const exemplarCrises = records.slice(0, 50).map((r) => r.crisisEvents);
  return {
    spec,
    bracket,
    archetype,
    sampleN: records.length,
    insufficient: records.length < nFloor,
    metrics,
    exemplarCrises,
  };
}

export function aggregateCells(
  records: PerMatchRecord[],
  nFloor: number,
  meta?: { wowPatchVersion?: string; sourceFloor?: number },
): Corpus {
  const byArche = new Map<string, PerMatchRecord[]>();
  const byParent = new Map<string, PerMatchRecord[]>();
  for (const r of records) {
    const pk = `${r.spec}|${r.bracket}|*`;
    (byParent.get(pk) ?? byParent.set(pk, []).get(pk)!).push(r);
    // "*" is the reserved key for parent cells; records whose archetype is exactly "*" only enter the parent cell (avoiding key collisions/duplication with parent cell)
    if (r.archetype !== "*") {
      const ak = `${r.spec}|${r.bracket}|${r.archetype}`;
      (byArche.get(ak) ?? byArche.set(ak, []).get(ak)!).push(r);
    }
  }
  const cells: Cell[] = [];
  for (const [k, recs] of byArche) {
    const [spec, bracket, archetype] = k.split("|");
    cells.push(buildCell(spec, bracket, archetype, recs, nFloor));
  }
  for (const [k, recs] of byParent) {
    const [spec, bracket] = k.split("|");
    cells.push(buildCell(spec, bracket, "*", recs, nFloor));
  }
  return {
    wowPatchVersion: meta?.wowPatchVersion ?? "unknown",
    builtAt: new Date().toISOString(),
    sourceFloor: meta?.sourceFloor ?? 2300,
    cells,
  };
}
```

- [ ] **Step 5: Run tests + tc**

Run: `cd packages/corpus-tools && npx vitest run src/cellAggregator.test.ts && npx tsc --noEmit`
Expected: PASS; tc=0.

- [ ] **Step 6: Commit**

```bash
git add packages/corpus-tools/
git commit -m "feat(corpus-tools): scaffold package + cell aggregator with archetype celling + N_floor (SP-B1 T4)"
```

---

### Task 5: Corpus Validator (Hard Gate, Pure Function)

**Files:**

- Create: `packages/corpus-tools/src/validateCorpus.ts`
- Test: `packages/corpus-tools/src/validateCorpus.test.ts`

**Interfaces:**

- Consumes: `Corpus`, `Cell` (from `./cellAggregator`).
- Produces: `validateCorpus(corpus: Corpus, nFloor: number): string[]` (returns list of violations; empty = pass).

- [ ] **Step 1: Write failing test**

`packages/corpus-tools/src/validateCorpus.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { validateCorpus } from "./validateCorpus";
import type { Corpus } from "./cellAggregator";

function corpusWith(cell: any): Corpus {
  return {
    wowPatchVersion: "11.0.7",
    builtAt: "now",
    sourceFloor: 2300,
    cells: [cell],
  };
}
const goodCell = {
  spec: "RestorationShaman",
  bracket: "3v3",
  archetype: "cc_swap_burst",
  sampleN: 40,
  insufficient: false,
  metrics: { reactionLatency: { p10: 1, p50: 2, p90: 3, n: 40 } },
  exemplarCrises: [["[0:10] taken Chaos Bolt"]],
};

describe("validateCorpus", () => {
  it("passes a clean corpus", () => {
    expect(validateCorpus(corpusWith(goodCell), 30)).toEqual([]);
  });
  it("flags the 1.5 latency sentinel (0-record cell carrying 1.5)", () => {
    const bad = {
      ...goodCell,
      metrics: { reactionLatency: { p10: 1.5, p50: 1.5, p90: 1.5, n: 0 } },
    };
    expect(
      validateCorpus(corpusWith(bad), 30).some((v) => /1\.5 sentinel/.test(v)),
    ).toBe(true);
  });
  it("flags non-ASCII crisis spell names", () => {
    const bad = { ...goodCell, exemplarCrises: [["[0:10] Took Chaos Bolt"]] };
    expect(
      validateCorpus(corpusWith(bad), 30).some((v) => /non-ASCII/.test(v)),
    ).toBe(true);
  });
  it("flags a cell below floor not marked insufficient", () => {
    const bad = { ...goodCell, sampleN: 5, insufficient: false };
    expect(
      validateCorpus(corpusWith(bad), 30).some((v) => /insufficient/.test(v)),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/corpus-tools && npx vitest run src/validateCorpus.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement validateCorpus.ts**

```typescript
import type { Corpus } from "./cellAggregator";

const ASCII = /^[\x00-\x7F]*$/;

export function validateCorpus(corpus: Corpus, nFloor: number): string[] {
  const v: string[] = [];
  if (!corpus.wowPatchVersion || corpus.wowPatchVersion === "unknown")
    v.push("corpus.wowPatchVersion missing/unknown");
  for (const c of corpus.cells) {
    const tag = `${c.spec}|${c.bracket}|${c.archetype}`;
    // N_floor consistency
    if (c.sampleN < nFloor && !c.insufficient)
      v.push(`${tag}: below floor (${c.sampleN}) but not insufficient`);
    if (c.sampleN >= nFloor && c.insufficient)
      v.push(`${tag}: at/above floor (${c.sampleN}) but marked insufficient`);
    // 1.5 latency sentinel: n===0 yet carries non-empty reactionLatency distribution (especially 1.5)
    const rl = c.metrics.reactionLatency;
    if (
      rl &&
      rl.n === 0 &&
      (rl.p50 === 1.5 || rl.p10 === 1.5 || rl.p90 === 1.5)
    )
      v.push(`${tag}: reactionLatency 1.5 sentinel with 0 records`);
    // crisis English/ASCII
    for (const crises of c.exemplarCrises)
      for (const line of crises)
        if (!ASCII.test(line))
          v.push(`${tag}: non-ASCII crisis line: ${line.slice(0, 40)}`);
  }
  return v;
}
```

- [ ] **Step 4: Run test + tc**

Run: `cd packages/corpus-tools && npx vitest run src/validateCorpus.test.ts && npx tsc --noEmit`
Expected: PASS; tc=0.

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/src/validateCorpus.ts packages/corpus-tools/src/validateCorpus.test.ts
git commit -m "feat(corpus-tools): corpus validator hard gate (1.5 sentinel/ASCII/N_floor) (SP-B1 T5)"
```

---

### Task 6: Feed Client + Go/No-Go Smoke

**Files:**

- Create: `packages/corpus-tools/src/feedClient.ts`
- Create: `packages/corpus-tools/scripts/smokeFeed.ts`
- Test: `packages/corpus-tools/src/feedClient.test.ts`

**Interfaces:**

- Produces: `fetchMatchStubs(opts: { bracket: string; minRating: number; specId?: number; limit: number }): Promise<MatchStub[]>`; `downloadLogText(stub: MatchStub): Promise<string>`; `MatchStub { id: string; bracket: string; rating: number; logObjectUrl: string; }`.
- feed endpoint / query shape provided by controller from old fork `printMatchPrompts.ts` (`fetchStubs`) (CLEAN); implementers do not read the old repository.

- [ ] **Step 1: Write failing test (using injectable fetch, no real network calls)**

`packages/corpus-tools/src/feedClient.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { fetchMatchStubs } from "./feedClient";

describe("fetchMatchStubs", () => {
  it("POSTs minRating as a server-side variable and maps combats to MatchStub[]", async () => {
    // Server filters by minRating, fake only returns combats >= threshold; client only maps without secondary filtering.
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          latestMatches: {
            combats: [
              { id: "a", logObjectUrl: "u1", startTime: 1, endTime: 2 },
              { id: "b", logObjectUrl: "u2", startTime: 3, endTime: 4 },
            ],
          },
        },
      }),
    });
    const stubs = await fetchMatchStubs(
      { bracket: "3v3", minRating: 2300, limit: 10 },
      fakeFetch as any,
    );
    expect(stubs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(stubs[0].logObjectUrl).toBe("u1");
    // Assert minRating is indeed passed as a GraphQL variable (server-side filtering)
    const body = JSON.parse((fakeFetch.mock.calls[0][1] as any).body);
    expect(body.variables.minRating).toBe(2300);
    expect(body.variables.bracket).toBe("3v3");
  });
  it("stops paging when the feed returns an empty page", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { latestMatches: { combats: [] } } }),
    });
    const stubs = await fetchMatchStubs(
      { bracket: "2v2", minRating: 2300, limit: 10 },
      fakeFetch as any,
    );
    expect(stubs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/corpus-tools && npx vitest run src/feedClient.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement feedClient.ts (fetch injectable)**

```typescript
export interface MatchStub {
  id: string;
  bracket: string;
  rating: number;
  logObjectUrl: string;
}

const FEED_ENDPOINT = "https://wowarenalogs.com/api/graphql";
// Real query (taken from CLEAN fetchStubs in old fork): minRating is a server-side variable; returned combats
// are already filtered by rating, so the client does not need to filter by rating again. Selection set and MatchStub field names
// follow legacy STUBS_QUERY (id / logObjectUrl / startTime / endTime etc.); bracket backfilled with query variables.
const STUBS_QUERY = `query GetLatestMatches($wowVersion: String!, $bracket: String, $offset: Int!, $count: Int!, $minRating: Float) {
  latestMatches(wowVersion: $wowVersion, bracket: $bracket, offset: $offset, count: $count, minRating: $minRating) {
    combats { id wowVersion logObjectUrl startTime endTime }
  }
}`;

type FetchLike = (
  url: string,
  init?: any,
) => Promise<{ ok: boolean; json: () => Promise<any> }>;

export async function fetchMatchStubs(
  opts: { bracket: string; minRating: number; specId?: number; limit: number },
  fetchImpl?: FetchLike,
): Promise<MatchStub[]> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const out: MatchStub[] = [];
  let offset = 0;
  const page = 50;
  while (out.length < opts.limit) {
    const res = await f(FEED_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: STUBS_QUERY,
        variables: {
          wowVersion: "retail",
          bracket: opts.bracket,
          offset,
          count: page,
          minRating: opts.minRating, // Server-side filtering
        },
      }),
    });
    if (!res.ok) throw new Error(`feed HTTP ${(res as any).status ?? "?"}`);
    const combats = (await res.json())?.data?.latestMatches?.combats ?? [];
    if (combats.length === 0) break;
    for (const c of combats) {
      // Server already filtered by minRating; client only maps.
      out.push({
        id: c.id,
        bracket: opts.bracket,
        rating: opts.minRating,
        logObjectUrl: c.logObjectUrl,
      });
      if (out.length >= opts.limit) break;
    }
    offset += page;
  }
  return out;
}

export async function downloadLogText(
  stub: MatchStub,
  fetchImpl?: FetchLike,
): Promise<string> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const res = await f(stub.logObjectUrl);
  if (!res.ok) throw new Error(`log download HTTP for ${stub.id}`);
  return await (res as any).text();
}
```

- [ ] **Step 4: Go/no-go smoke script**

`packages/corpus-tools/scripts/smokeFeed.ts`:

```typescript
import { fetchMatchStubs } from "../src/feedClient";
async function main() {
  const stubs = await fetchMatchStubs({
    bracket: "Rated Solo Shuffle",
    minRating: 2300,
    limit: 20,
  });
  console.log(`feed returned ${stubs.length} stubs >= 2300 (Solo Shuffle)`);
  if (stubs.length === 0) {
    console.error("GO/NO-GO FAIL: feed returned 0 stubs");
    process.exit(1);
  }
  console.log("GO: feed alive.");
}
main().catch((e) => {
  console.error("GO/NO-GO FAIL:", e);
  process.exit(1);
});
```

- [ ] **Step 5: Run unit tests + real smoke test (maintainer manual, go/no-go gate)**

Run (unit test): `cd packages/corpus-tools && npx vitest run src/feedClient.test.ts`
Expected: PASS.
Run (real network, maintainer): `npx tsx scripts/smokeFeed.ts`
Expected: Prints `GO: feed alive.`; if NO-GO, halt and report to controller to switch to fallback source.

- [ ] **Step 6: Commit**

```bash
git add packages/corpus-tools/src/feedClient.ts packages/corpus-tools/src/feedClient.test.ts packages/corpus-tools/scripts/smokeFeed.ts
git commit -m "feat(corpus-tools): feed client + go/no-go smoke (SP-B1 T6)"
```

---

### Task 7: Collector Orchestration (Hermetic Unit Tests + CLI)

> **Plan Revision (Execution Phase, Controller)**: The original plan was to use a self-captured log fixture for integration testing. There is no complete match fixture readily available in the repo, and committing real player logs poses privacy concerns and large file sizes. Therefore split into: pure function `combatToRecords(combat)` (single match → records, unit tested with synthetic combat, same method as T1/T3, hermetic with no network or fixtures) + thin shell `buildPerMatchRecords(logText)` (parse then flatMap). True "parsing + feed" integration is verified in T8's real build.

**Files:**

- Create: `packages/corpus-tools/src/perMatchRecord.ts` (`combatToRecords` + `buildPerMatchRecords`)
- Create: `packages/corpus-tools/scripts/buildCorpus.ts` (orchestration CLI)
- Test: `packages/corpus-tools/src/perMatchRecord.test.ts`

**Interfaces:**

- Consumes: `GladLogParser` (@gladlog/parser), `toLegacyMatch`/`toLegacyShuffle`/`CombatUnitReaction` (@gladlog/parser-compat), `computeHealerMetrics`/`extractRotations`/`enemyCompArchetype`/`isHealerSpec`/`specToString` (@gladlog/analysis), `fetchMatchStubs`/`downloadLogText` (./feedClient), `aggregateCells`/`validateCorpus` (./…).
- Produces: `combatToRecords(combat: any): PerMatchRecord[]` (single match → one record per Friendly healer); `buildPerMatchRecords(logText: string): PerMatchRecord[]` (parse + flatMap); `buildCorpus` CLI writes `packages/corpus-tools/data/reference_vectors.json`.

- [ ] **Step 1: Write failing test (synthetic combat, hermetic)**

`packages/corpus-tools/src/perMatchRecord.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { combatToRecords } from "./perMatchRecord";

// Synthesize a match: 1 Friendly healer (Resto Shaman) + 2 Hostile melee dps + 1 Hostile healer.
// Fields take minimal set actually read by computeHealerMetrics/extractRotations (same stub technique as T1).
// reaction: CombatUnitReaction.Friendly=1, Hostile=2. type: Player=1.
function unit(name: string, spec: string, reaction: number): any {
  return {
    id: name,
    name,
    spec,
    type: 1,
    reaction,
    damageOut: [],
    healOut: [],
    absorbsOut: [],
    damageIn: [],
    spellCastEvents: [],
    actionIn: [],
    auraEvents: [],
    advancedActions: [],
    deathRecords: [],
    info: { teamId: reaction === 1 ? "0" : "1" },
  };
}
// Implementer: Replace SHAMAN/WARRIOR/PALADIN with real CombatUnitSpec values from @gladlog/parser-compat —
// Resto Shaman (isHealerSpec true), Arms Warrior (isMeleeSpec true non-healer), Holy Paladin (isHealerSpec true).
function synthCombat(): any {
  const healer = unit("Me-Realm-US", SHAMAN, 1);
  const eMelee1 = unit("E1-Realm-US", WARRIOR, 2);
  const eMelee2 = unit("E2-Realm-US", WARRIOR, 2);
  const eHealer = unit("EH-Realm-US", PALADIN, 2);
  return {
    units: {
      [healer.name]: healer,
      [eMelee1.name]: eMelee1,
      [eMelee2.name]: eMelee2,
      [eHealer.name]: eHealer,
    },
    startTime: 0,
    endTime: 120000,
    playerId: "Me-Realm-US",
    startInfo: { bracket: "3v3", zoneId: 1 },
  };
}

describe("combatToRecords", () => {
  it("emits one record per Friendly healer with in-domain metrics + comp archetype", () => {
    const recs = combatToRecords(synthCombat());
    expect(recs.length).toBe(1); // Only Friendly Resto Shaman
    const r = recs[0];
    expect(r.spec).toBeTruthy();
    expect(r.bracket).toBe("3v3");
    expect(r.archetype).toBe("melee_cleave"); // 2 enemy melee dps
    expect(typeof r.metrics.offensiveIndex).toBe("number");
    for (const c of r.crisisEvents) expect(c).toMatch(/^[\x00-\x7F]*$/);
  });
  it("returns [] when no Friendly healer is present", () => {
    const c = synthCombat();
    // Change Friendly healer to melee -> no Friendly healer
    c.units["Me-Realm-US"].spec = WARRIOR;
    expect(combatToRecords(c)).toEqual([]);
  });
});
```

> Implementer: Replace `SHAMAN`/`WARRIOR`/`PALADIN` with real `CombatUnitSpec` members (check `cooldowns.ts` `isHealerSpec`/`isMeleeSpec` to confirm; Resto Shaman, Arms Warrior, Holy Paladin).

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/corpus-tools && npx vitest run src/perMatchRecord.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement perMatchRecord.ts**

```typescript
import { GladLogParser } from "@gladlog/parser";
import {
  toLegacyMatch,
  toLegacyShuffle,
  CombatUnitReaction,
} from "@gladlog/parser-compat";
import {
  computeHealerMetrics,
  extractRotations,
  enemyCompArchetype,
  isHealerSpec,
  specToString,
} from "@gladlog/analysis";
import type { PerMatchRecord } from "./cellAggregator";

/** Single combat match -> one record per Friendly healer (pure, unit testable with synthetic combat). */
export function combatToRecords(combat: any): PerMatchRecord[] {
  const players = (Object.values(combat.units) as any[]).filter((u) => u.info);
  const healers = players.filter(
    (u) => isHealerSpec(u.spec) && u.reaction === CombatUnitReaction.Friendly,
  );
  const out: PerMatchRecord[] = [];
  for (const healer of healers) {
    const enemies = players.filter((u) => u.reaction !== healer.reaction);
    let metrics;
    try {
      metrics = computeHealerMetrics(combat, healer.name);
    } catch {
      continue;
    }
    const archetype = enemyCompArchetype(enemies);
    const rotations = extractRotations(healer, combat);
    out.push({
      spec: specToString(healer.spec),
      bracket: combat.startInfo?.bracket ?? "unknown",
      archetype,
      metrics,
      crisisEvents: rotations.crisisEvents,
    });
  }
  return out;
}

/** Single log -> parse -> per-match records. Thin shell; real parse integration verified in T8 real run. */
export function buildPerMatchRecords(logText: string): PerMatchRecord[] {
  const parser = new GladLogParser();
  const combats: any[] = [];
  parser.on("match", (m: any) => combats.push(toLegacyMatch(m)));
  parser.on("shuffle", (sh: any) => {
    const legacy = toLegacyShuffle(sh);
    (legacy.rounds ?? []).forEach((r: any) => combats.push(r));
  });
  for (const line of logText.split("\n")) parser.push(line);
  parser.end();
  return combats.flatMap((c) => combatToRecords(c));
}
```

- [ ] **Step 4: Implement buildCorpus.ts orchestration CLI**

`packages/corpus-tools/scripts/buildCorpus.ts`:

```typescript
import fs from "fs-extra";
import path from "path";
import { fetchMatchStubs, downloadLogText } from "../src/feedClient";
import { buildPerMatchRecords } from "../src/perMatchRecord";
import { aggregateCells } from "../src/cellAggregator";
import { validateCorpus } from "../src/validateCorpus";

const BRACKETS = ["Rated Solo Shuffle", "2v2", "3v3"];
const MIN_RATING = Number(process.env.MIN_RATING ?? 2300);
const PER_BRACKET = Number(process.env.PER_BRACKET ?? 1200); // Sufficient for mainstream archetypes to clear N_floor
const N_FLOOR = 30;
const PATCH = process.env.WOW_PATCH ?? "unknown";
const OUT = path.join(__dirname, "../data/reference_vectors.json");

async function main() {
  const recs = [];
  for (const bracket of BRACKETS) {
    const stubs = await fetchMatchStubs({
      bracket,
      minRating: MIN_RATING,
      limit: PER_BRACKET,
    });
    console.log(`${bracket}: ${stubs.length} stubs`);
    for (const stub of stubs) {
      try {
        const text = await downloadLogText(stub);
        recs.push(...buildPerMatchRecords(text));
      } catch (e) {
        console.warn(`skip ${stub.id}: ${e}`);
      }
    }
  }
  const corpus = aggregateCells(recs, N_FLOOR, {
    wowPatchVersion: PATCH,
    sourceFloor: MIN_RATING,
  });
  const violations = validateCorpus(corpus, N_FLOOR);
  if (violations.length > 0) {
    console.error(`VALIDATION FAILED (${violations.length}):`);
    violations.slice(0, 40).forEach((v) => console.error("  " + v));
    process.exit(1);
  }
  await fs.ensureDir(path.dirname(OUT));
  await fs.writeJson(OUT, corpus, { spaces: 0 });
  const sizeMB = (fs.statSync(OUT).size / 1e6).toFixed(2);
  console.log(`wrote ${corpus.cells.length} cells (${sizeMB}MB) → ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 5: Run integration tests + tc (fixture, no network calls)**

Run: `cd packages/corpus-tools && npx vitest run && npx tsc --noEmit`
Expected: perMatchRecord 2 tests PASS (synthetic combat, no fixture/network); cellAggregator + validateCorpus + feedClient existing tests remain green; tc=0.

- [ ] **Step 6: Commit**

```bash
git add packages/corpus-tools/src/perMatchRecord.ts packages/corpus-tools/src/perMatchRecord.test.ts packages/corpus-tools/scripts/buildCorpus.ts
git commit -m "feat(corpus-tools): per-match record + buildCorpus orchestration (SP-B1 T7)"
```

---

### Task 8: Produce and Validate Real Corpus (Maintainer Run + Wrap-up)

**Files:**

- Create: `packages/corpus-tools/data/reference_vectors.json` (build artifact, committed to repo)
- Create: `packages/corpus-tools/README.md` (runbook)

**Interfaces:** No new code interfaces; this is the operational step for running T7 CLI + final review.

- [ ] **Step 1: Confirm go/no-go smoke is still green**

Run: `cd packages/corpus-tools && npx tsx scripts/smokeFeed.ts`
Expected: `GO: feed alive.`

- [ ] **Step 2: Run real build (maintainer, minutes to hours)**

Run: `cd packages/corpus-tools && WOW_PATCH=<current_version> PER_BRACKET=1500 npx tsx scripts/buildCorpus.ts`
Expected: Prints stub count per bracket, cell count, file size (< 3MB); validateCorpus 0 violations; writes `data/reference_vectors.json`. If validation fails, fix according to violations (insufficient quota → increase PER_BRACKET; non-ASCII → check getEnglishSpellName coverage).

- [ ] **Step 3: Independent corpus review (agy verify, cross-family)**

Run:

```bash
cd packages/corpus-tools && node ~/.claude/skills/agy/scripts/agy-run.mjs verify --files data/reference_vectors.json \
  "Audit this reference_vectors.json: whether each cell is in spec×bracket×archetype structure; whether any reactionLatency=1.5 and n=0 sentinel remains; whether crisis strings are pure English ASCII; whether insufficient flags are consistent with sampleN<30; whether overall file size is reasonable (<3MB, de-embedded)."
```

Expected: agy has no REFUTED; if any, fix.

- [ ] **Step 4: Write runbook README**

`packages/corpus-tools/README.md`: Explain this is an **offline maintainer tool, not included in desktop App distribution**; build commands (including MIN_RATING/PER_BRACKET/WOW_PATCH environment variables); go/no-go smoke; validator hard gate; corpus schema; re-running to refresh wowPatchVersion after season/hotfix (distribution mechanism belongs to SP-B2).

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/data/reference_vectors.json packages/corpus-tools/README.md
git commit -m "chore(corpus-tools): produce + validate gladlog-metric reference corpus (SP-B1 T8)"
```

---

## Wrap-up (End of SDD)

- Full monorepo tc + tests: `for p in parser parser-compat analysis corpus-tools; do (cd packages/$p && npx tsc --noEmit && npx vitest run); done`
- Confirm `packages/desktop` does not import `@gladlog/corpus-tools` (zero release-layer dependencies): `grep -rn "corpus-tools" packages/desktop/src || echo "clean"`
- Dispatch final comprehensive review (strongest model).
