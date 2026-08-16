# arenacoach Rules Absorption Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the three deterministic predicates with highest value to gladlog and **requiring no new whitelist tables** from arenacoach.gg's 21 rules into the candidateFindings candidate layer: defensive off-cooldown but unpressed on death (DEATH-001), external off-cooldown but not cast when teammate dies (DEATH-003), and PvP trinket wasted in neutral state (TRINKET-001).

**Architecture:** Implement all 3 rules as pure function candidate extractors in `packages/analysis` (testable with hand-built fixtures), integrated into the existing `extractCandidateFindings` menu; downstream declaration in 3 places (prompt type guidance / renderer mistakes rule table / deepDive classification auto-routing to survival). All evaluations reuse existing shared predicates: `extractMajorCooldowns`'s `availableWindows`/`casts`, `analyzePlayerCCAndTrinket`'s CC/trinket summary, `getUnitHpAtTimestamp` (HP_SAMPLE_RADIUS_MS), `isAllyCastableDefensive`, `USABLE_WHILE_CC_SPELL_IDS`, `reconstructEnemyCDTimeline`. **Zero new spell whitelists**.

**Tech Stack:** TypeScript (analysis package pure functions + vitest hand-built fixtures), desktop renderer (mistakes rule table), eval corpus scanner.

## Global Constraints

- **Predicate single-source (CLAUDE.md iron law)**: Two consumers of the same fact import the same function/constant. Shared points in this plan: `cdAvailableAt` (new in Task 1, consumed by Task 2/3, refactors defensive-early in `deathSetupEvents` to share source), `HP_SAMPLE_RADIUS_MS` (maxDtMs passed to `getUnitHpAtTimestamp` in Task 4), `fmtFactNum` (all facts numeric rendering).
- **Facts anchor rendered values**: All timestamps/values entering facts must go through `fmtFactNum` (`fmt` in `factFormat.ts`) so gate re-computation matches.
- Type check using only `npm run typecheck` (never `tsc -b`).
- Commit style: Direct commit + push to main, no branches or PRs; one commit per Task.
- Gate chains must not include pipes (`npm run typecheck | tail` prohibited — exit codes get swallowed).
- Compound commands do not use `cd`; use `(cd … && …)` subshell when needed.
- Before push: `npm run presubmit` (full workspace, covering 5 CI steps).
- New types must be declared in renderer's `MISTAKE_RULES` or `IGNORED_CANDIDATE_TYPES` (enforced by `report.mistakes.test` manifest test).
- Copy only arenacoach's **evaluation predicates and thresholds**, copy zero descriptive copy/text (copyright).
- After landing features, follow the convention of "give before/after metrics for fixes" by providing corpus incidence rate metrics (Task 6); state clearly if unavailable.

## Evaluation Predicate Specifications (From arenacoach public catalog, thresholds tuned on 250k matches)

| New Type | Evaluation | Key Threshold |
| --- | --- | --- |
| `death-unused-defensive` | When owner dies, a major defensive ability with tag=Defensive and non-throughput is available; and owner is "free": not in CC at death timestamp, or in CC but trinket is available, or ability is castable in CC (`USABLE_WHILE_CC`); Divine Shield types under Forbearance do not count as available | ≤1 per death, facts lists ≤3 abilities |
| `external-unused` | When friendly teammate (≠owner) dies, owner is alive, has ally-castable external available, and had ≥1.5s non-CC gap in window before death | Gap window = [deathT−5s, deathT], min gap 1.5s |
| `wasted-trinket` | An owner trinket usage occurred in a "neutral state": all friendly HP ≥80% (shared sampling predicate, conservatively omitted if anyone cannot be sampled) + friendly healer not in CC + no enemy offensive CD buff active | HP threshold 80%, sampling radius HP_SAMPLE_RADIUS_MS |

---

### Task 1: Shared Availability Predicate `cdAvailableAt`

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts` (new export after `IMajorCooldownInfo` definition)
- Modify: `packages/analysis/src/analysis/candidateFindings.ts:605-615` (replace defensive-early manual `readyAt` calculation with new predicate)
- Modify: `packages/analysis/src/index.ts` (barrel export, match existing exports if cooldowns surface is already re-exported)
- Test: `packages/analysis/test/cdAvailableAt.test.ts` (create)

**Interfaces:**

- Consumes: `IMajorCooldownInfo` (existing), `lastCastBefore` (`src/context/timelineHelpers.ts`, existing)
- Produces: `export function cdAvailableAt(cd: Pick<IMajorCooldownInfo, "casts" | "cooldownSeconds" | "neverUsed">, tSeconds: number): boolean` — dependency for Task 2/3

- [ ] **Step 1: Write failing test**

```ts
// packages/analysis/test/cdAvailableAt.test.ts
import { describe, expect, it } from "vitest";
import { cdAvailableAt } from "../src/utils/cooldowns";

const cast = (timeSeconds: number) => ({ timeSeconds });

describe("cdAvailableAt (availability at death timestamp — mirror predicate of defensive-early)", () => {
  it("never used → available throughout", () => {
    expect(
      cdAvailableAt({ casts: [], cooldownSeconds: 120, neverUsed: true }, 45),
    ).toBe(true);
  });
  it("last used + CD has cooled down → available", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(10)], cooldownSeconds: 60, neverUsed: false },
        75, // readyAt = 70 ≤ 75
      ),
    ).toBe(true);
  });
  it("last used + CD has not cooled down → not available", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(30)], cooldownSeconds: 60, neverUsed: false },
        75, // readyAt = 90 > 75
      ),
    ).toBe(false);
  });
  it("multiple casts pick the latest one before t", () => {
    expect(
      cdAvailableAt(
        { casts: [cast(10), cast(80)], cooldownSeconds: 60, neverUsed: false },
        100, // last before 100 = 80, readyAt = 140 > 100
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run --root packages/analysis test/cdAvailableAt.test.ts`
Expected: FAIL — `cdAvailableAt` is not exported

- [ ] **Step 3: Minimal implementation**

Add after `IMajorCooldownInfo` definition in `cooldowns.ts` (`lastCastBefore` is in `timelineHelpers.ts`, note import direction: if cooldowns.ts importing it creates a cycle, place implementation in `timelineHelpers.ts` and re-export from cooldowns — predicate must only have a single source of truth):

```ts
/**
 * Whether this major CD is available at time t. Shares source with
 * deathSetupEvents's defensive-early (manual readyAt calculation): that one
 * evaluates "unavailable at death and used too early", while this is its
 * complementary consumer (death-unused-defensive / external-unused evaluate
 * "available at death but unpressed").
 */
export function cdAvailableAt(
  cd: Pick<IMajorCooldownInfo, "casts" | "cooldownSeconds" | "neverUsed">,
  tSeconds: number,
): boolean {
  const last = [...cd.casts].filter((c) => c.timeSeconds <= tSeconds).pop();
  if (!last) return true; // Never used before t (including neverUsed)
  return last.timeSeconds + cd.cooldownSeconds <= tSeconds;
}
```

- [ ] **Step 4: Refactor defensive-early to consume the same predicate**

In `candidateFindings.ts` deathSetupEvents, change `const readyAt = last.timeSeconds + cd.cooldownSeconds; if (readyAt <= deathT) continue;` to `if (cdAvailableAt(cd as IMajorCooldownInfo, deathT)) continue;` (semantically equivalent: available → not a "used too early" chain). Keep `lastCastBefore` getting `last` for timestamps/tags.

- [ ] **Step 5: Run new tests + existing candidateFindings tests**

Run: `npx vitest run --root packages/analysis test/cdAvailableAt.test.ts src/analysis/candidateFindings.test.ts`
Expected: All PASS (refactoring does not alter defensive-early behavior)

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(analysis): cdAvailableAt shared availability predicate — refactor defensive-early to share source, paving way for arenacoach batch"
```

---

### Task 2: `death-unused-defensive` (DEATH-001 Defensive Available but Unpressed on Death)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts` (add pure function + wire into `extractDeathSetups`)
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts` (add describe block)

**Interfaces:**

- Consumes: `cdAvailableAt` (Task 1), `DeathSetupParts` (existing, reuse victimCC/victimCDs slices), `USABLE_WHILE_CC_SPELL_IDS`, `FORBEARANCE_GATED_IDS` + `selfForbearanceActiveAt` (existing in `utils/cooldowns.ts`), `fmt` (factFormat)
- Produces: `export function deathUnusedDefensiveEvents(parts: DeathSetupParts, victim: { isOwner: boolean; unit?: any }, combat?: any): CandidateEvent[]` (signature matching actual `selfForbearanceActiveAt` parameters); candidate type string `"death-unused-defensive"`, id formatted like `death-unused-defensive:<victimId>:<round(deathT)>`, facts `{ t, unit, walls, free }` — Task 5 depends on this type and facts key names

- [ ] **Step 1: Write failing test (hand-built parts, mirroring deathSetupEvents test style)**

```ts
describe("death-unused-defensive (defensive available but unpressed on death)", () => {
  const wall = (over: Partial<IMajorCooldownInfo> = {}) => ({
    spellId: "108271", // Astral Shift
    spellName: "Astral Shift",
    tag: "Defensive",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const base = {
    deathT: 100,
    victim: { id: "p1", name: "Me-R" },
    victimCDs: [wall()],
    victimCC: { ccInstances: [], trinketUseTimes: [] },
  };

  it("available defensive + not in CC at death → emit one, facts lists ability and free=yes", () => {
    const ev = deathUnusedDefensiveEvents(base, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("death-unused-defensive");
    expect(ev[0]!.facts.walls).toContain("Astral Shift");
    expect(ev[0]!.facts.free).toBe("yes");
  });

  it("non-owner death → do not emit (critiques only target owner)", () => {
    expect(deathUnusedDefensiveEvents(base, { isOwner: false })).toEqual([]);
  });

  it("defensive on CD at death → do not emit", () => {
    const p = {
      ...base,
      victimCDs: [wall({ casts: [{ timeSeconds: 50 }], neverUsed: false })],
    }; // readyAt=140 > deathT=100
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("in CC at death and trinket on CD → not free, do not emit", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "on_cooldown",
          },
        ],
        trinketUseTimes: [40],
      },
    };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });

  it("in CC at death but trinket available → still emit (free=trinket_in_hand)", () => {
    const p = {
      ...base,
      victimCC: {
        ccInstances: [
          {
            atSeconds: 96,
            durationSeconds: 6,
            spellName: "Polymorph",
            trinketState: "available_unused",
          },
        ],
        trinketUseTimes: [],
      },
    };
    const ev = deathUnusedDefensiveEvents(p, { isOwner: true });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.facts.free).toBe("trinket_in_hand");
  });

  it("throughput type does not count as defensive wall → do not emit", () => {
    const p = { ...base, victimCDs: [wall({ isThroughput: true })] };
    expect(deathUnusedDefensiveEvents(p, { isOwner: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `deathUnusedDefensiveEvents` is not defined

- [ ] **Step 3: Minimal implementation**

```ts
/** Maximum number of available defensives listed per death in facts. */
const UNUSED_DEFENSIVE_MAX_LISTED = 3;

/**
 * death-unused-defensive: owner had defensive available on death but failed to press
 * (arenacoach DEATH-001 predicate, shared thresholds). "Free" evaluation: not in CC
 * at death timestamp, or in CC but trinket is available (available_unused/available),
 * or ability is castable in CC (USABLE_WHILE_CC_SPELL_IDS). Divine Shield types
 * under Forbearance do not count as available.
 */
export function deathUnusedDefensiveEvents(
  parts: DeathSetupParts,
  victim: { isOwner: boolean; unit?: any },
  combat?: any,
): CandidateEvent[] {
  if (!victim.isOwner) return [];
  const { deathT } = parts;
  const ccAtDeath = parts.victimCC?.ccInstances.find(
    (cc) =>
      cc.atSeconds <= deathT && cc.atSeconds + cc.durationSeconds >= deathT,
  );
  const freeState = !ccAtDeath
    ? "yes"
    : ccAtDeath.trinketState !== "on_cooldown"
      ? "trinket_in_hand"
      : null; // In CC without trinket: overall not free, only USABLE_WHILE_CC abilities exempted

  const walls = (parts.victimCDs ?? []).filter((cd) => {
    if (cd.tag !== "Defensive") return false;
    if ((cd as IMajorCooldownInfo).isThroughput) return false;
    if (!cdAvailableAt(cd as IMajorCooldownInfo, deathT)) return false;
    if (freeState === null && !USABLE_WHILE_CC_SPELL_IDS.has(cd.spellId))
      return false;
    if (
      FORBEARANCE_GATED_IDS.has(cd.spellId) &&
      victim.unit &&
      combat &&
      selfForbearanceActiveAt(victim.unit, combat, deathT) // Use actual signature
    )
      return false;
    return true;
  });
  if (walls.length === 0) return [];
  return [
    {
      id: `death-unused-defensive:${parts.victim.id}:${Math.round(deathT)}`,
      type: "death-unused-defensive",
      t: deathT,
      unitNames: [parts.victim.name],
      facts: {
        t: fmt(deathT),
        unit: parts.victim.name,
        walls: walls
          .slice(0, UNUSED_DEFENSIVE_MAX_LISTED)
          .map((w) => w.spellName)
          .join(", "),
        free: freeState ?? "usable_in_cc",
      },
    },
  ];
}
```

Wiring: Add `ownerId?: string` to `extractDeathSetups` signature (passed from existing `ownerId` at `extractCandidateFindings` callsite); in loop body after `out.push(...deathSetupEvents(parts))` append:

```ts
out.push(
  ...deathUnusedDefensiveEvents(
    parts,
    { isOwner: u.id === ownerId, unit: u },
    combat,
  ),
);
```

Read `utils/cooldowns.ts:149` first for the true signature of `selfForbearanceActiveAt` — adjust wrapper to match, **never** write a separate Forbearance evaluation.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: All PASS

- [ ] **Step 5: Smoke test on real fixture (menu does not crash + type appears in output or is legitimately absent)**

In `candidateFindings.test.ts` real match integration test (existing extractCandidateFindings integration test), assert: if output contains `death-unused-defensive`, its `facts.t` can be parsed by `Number()` and `walls` is non-empty; absence is also valid (fixture has no owner death).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(analysis): death-unused-defensive candidate — defensive available but unpressed on owner death (arenacoach DEATH-001)"
```

---

### Task 3: `external-unused` (DEATH-003 External Available but Not Given on Teammate Death)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts`
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts`

**Interfaces:**

- Consumes: `cdAvailableAt` (Task 1), `isAllyCastableDefensive` (existing in `utils/cooldowns.ts:53`), existing `ccOf`/`cdsOf` memo in `extractDeathSetups`
- Produces: Candidate type `"external-unused"`, id `external-unused:<ownerId>:<victimId>:<round(deathT)>`, facts `{ t, victim, owner, external, freeGapS }`; exported constants `EXTERNAL_FREE_WINDOW_S = 5`, `EXTERNAL_FREE_MIN_GAP_S = 1.5` — Task 5/6 dependencies

- [ ] **Step 1: Write failing test**

```ts
describe("external-unused (owner external available but not given on teammate death)", () => {
  const ext = (over = {}) => ({
    spellId: "102342", // Ironbark
    spellName: "Ironbark",
    tag: "External",
    cooldownSeconds: 90,
    casts: [],
    neverUsed: true,
    isThroughput: false,
    ...over,
  });
  const owner = { id: "h1", name: "Healer-R" };
  const victim = { id: "p2", name: "Mate-R" };

  it("external available + owner has non-CC gap in window before death → emit one", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [], // Free throughout
      ownerAliveAt: () => true,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("external-unused");
    expect(ev[0]!.facts.external).toBe("Ironbark");
  });

  it("external on CD → do not emit", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext({ casts: [{ timeSeconds: 60 }], neverUsed: false })], // readyAt=150
      ownerCC: [],
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("owner window [95,100] before death fully covered by CC → not free, do not emit", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 94, durationSeconds: 7 }], // Covers [94,101]
      ownerAliveAt: () => true,
    });
    expect(ev).toEqual([]);
  });

  it("window has ≥1.5s non-CC gap (CC only covers [95,99]) → emit", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 4 }], // Gap [99,100] is only 1s...
      ownerAliveAt: () => true,
    });
    // Window [95,100]: CC covers [95,99] → max gap 1.0s < 1.5 → do not emit
    expect(ev).toEqual([]);
    const ev2 = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [{ atSeconds: 95, durationSeconds: 3 }], // Gap [98,100] = 2s ≥ 1.5
      ownerAliveAt: () => true,
    });
    expect(ev2).toHaveLength(1);
  });

  it("owner already dead at deathT → do not emit", () => {
    const ev = externalUnusedEvents({
      deathT: 100,
      victim,
      owner,
      ownerExternals: [ext()],
      ownerCC: [],
      ownerAliveAt: () => false,
    });
    expect(ev).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `externalUnusedEvents` is not defined

- [ ] **Step 3: Minimal implementation**

```ts
/** external-unused: lookback window before death (seconds) and owner min free gap (seconds).
 * Threshold source: arenacoach DEATH-003 "you were free to cast it" (1.5s reaction
 * grace consistent across site); window 5s is near sub-window of DEATH_CC_LOOKBACK_S. */
export const EXTERNAL_FREE_WINDOW_S = 5;
export const EXTERNAL_FREE_MIN_GAP_S = 1.5;

export function externalUnusedEvents(input: {
  deathT: number;
  victim: { id: string; name: string };
  owner: { id: string; name: string };
  ownerExternals: Array<
    Pick<
      IMajorCooldownInfo,
      "spellId" | "spellName" | "cooldownSeconds" | "casts" | "neverUsed"
    >
  >;
  ownerCC: Array<{ atSeconds: number; durationSeconds: number }>;
  ownerAliveAt: (t: number) => boolean;
}): CandidateEvent[] {
  const { deathT, victim, owner } = input;
  if (!input.ownerAliveAt(deathT)) return [];

  // Owner free gap: window [deathT-5, deathT] minus CC coverage, find max continuous gap
  const from = Math.max(0, deathT - EXTERNAL_FREE_WINDOW_S);
  const covers = input.ownerCC
    .map((c) => [c.atSeconds, c.atSeconds + c.durationSeconds] as const)
    .filter(([a, b]) => b > from && a < deathT)
    .sort((a, b) => a[0] - b[0]);
  let cursor = from;
  let maxGap = 0;
  for (const [a, b] of covers) {
    maxGap = Math.max(maxGap, a - cursor);
    cursor = Math.max(cursor, b);
  }
  maxGap = Math.max(maxGap, deathT - cursor);
  if (maxGap < EXTERNAL_FREE_MIN_GAP_S) return [];

  const avail = input.ownerExternals.find((cd) => cdAvailableAt(cd, deathT));
  if (!avail) return [];
  return [
    {
      id: `external-unused:${owner.id}:${victim.id}:${Math.round(deathT)}`,
      type: "external-unused",
      t: deathT,
      unitNames: [owner.name, victim.name],
      spell: avail.spellName,
      spellId: avail.spellId,
      facts: {
        t: fmt(deathT),
        victim: victim.name,
        owner: owner.name,
        external: avail.spellName,
        freeGapS: fmt(maxGap),
      },
    },
  ];
}
```

Wiring (inside `extractDeathSetups`, ownerId known): in victim loop when `u.id !== ownerId` and owner unit exists, assemble input using existing memos:

```ts
const ownerUnit = ownerId ? friends.find((f) => f.id === ownerId) : undefined;
// …inside victim death loop, after deathUnusedDefensiveEvents:
if (ownerUnit && ownerUnit.id !== u.id) {
  try {
    out.push(
      ...externalUnusedEvents({
        deathT,
        victim: { id: u.id, name: u.name },
        owner: { id: ownerUnit.id, name: ownerUnit.name },
        ownerExternals: cdsOf(ownerUnit).filter((cd) =>
          isAllyCastableDefensive(cd.spellId),
        ),
        ownerCC: ccOf(ownerUnit).ccInstances,
        ownerAliveAt: (t) =>
          !(ownerUnit.deathRecords ?? []).some(
            (dr: any) => (dr.timestamp - start) / 1000 <= t,
          ),
      }),
    );
  } catch {
    /* Owner summary cannot be computed → omit category */
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(analysis): external-unused candidate — owner external available but not given on teammate death (arenacoach DEATH-003)"
```

---

### Task 4: `wasted-trinket` (TRINKET-001 PvP Trinket Wasted in Neutral State)

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts` (pure function + wire into `teamPlayEvents`, where `analyzePlayerCCAndTrinket(owner,…)` call already exists)
- Test: `packages/analysis/src/analysis/candidateFindings.test.ts`

**Interfaces:**

- Consumes: `analyzePlayerCCAndTrinket(...).trinketUseTimes` (existing), `getUnitHpAtTimestamp` + `HP_SAMPLE_RADIUS_MS` (existing in `utils/cooldowns.ts`), `reconstructEnemyCDTimeline(...).players[].offensiveCDs` (`castTimeSeconds`/`buffEndSeconds`, existing)
- Produces: Candidate type `"wasted-trinket"`, id `wasted-trinket:<ownerId>:<round(t)>`, facts `{ t, unit, teamMinHpPct }`; exported constant `TRINKET_NEUTRAL_HP_PCT = 80` — Task 5/6 dependencies

- [ ] **Step 1: Write failing test (pure function injecting probes without constructing full combat)**

```ts
describe("wasted-trinket (PvP trinket wasted in neutral state)", () => {
  const probes = {
    friendlyHpPctAt: (t: number) => 95, // Team lowest HP% (null = cannot sample)
    healerInCCAt: (t: number) => false,
    enemyOffensiveActiveAt: (t: number) => false,
  };
  const owner = { id: "p1", name: "Me-R" };

  it("high team HP + free healer + no enemy burst → neutral, emit one", () => {
    const ev = wastedTrinketEvents([42.4], owner, probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("wasted-trinket");
    expect(ev[0]!.facts.teamMinHpPct).toBe("95");
  });

  it("someone at low HP (<80%) → non-neutral, do not emit", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => 60,
      }),
    ).toEqual([]);
  });

  it("cannot sample HP → conservatively do not emit", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        friendlyHpPctAt: () => null,
      }),
    ).toEqual([]);
  });

  it("healer in CC → non-neutral, do not emit", () => {
    expect(
      wastedTrinketEvents([42], owner, { ...probes, healerInCCAt: () => true }),
    ).toEqual([]);
  });

  it("enemy offensive CD buff active → non-neutral, do not emit", () => {
    expect(
      wastedTrinketEvents([42], owner, {
        ...probes,
        enemyOffensiveActiveAt: () => true,
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: FAIL — `wastedTrinketEvents` is not defined

- [ ] **Step 3: Minimal implementation**

```ts
/** Neutral health percentage for wasted-trinket (arenacoach TRINKET-001: "everyone at high
 * health"; public catalog omits precise value, taking 80% and calibrated via Task 6 corpus evidence). */
export const TRINKET_NEUTRAL_HP_PCT = 80;

export function wastedTrinketEvents(
  trinketUseTimes: number[],
  owner: { id: string; name: string },
  probes: {
    /** Minimum HP% among all friendly players at time t; returns null if any unit cannot be sampled (conservatively omit). */
    friendlyHpPctAt: (t: number) => number | null;
    healerInCCAt: (t: number) => boolean;
    enemyOffensiveActiveAt: (t: number) => boolean;
  },
): CandidateEvent[] {
  const out: CandidateEvent[] = [];
  for (const t of trinketUseTimes) {
    const minHp = probes.friendlyHpPctAt(t);
    if (minHp === null || minHp < TRINKET_NEUTRAL_HP_PCT) continue;
    if (probes.healerInCCAt(t)) continue;
    if (probes.enemyOffensiveActiveAt(t)) continue;
    out.push({
      id: `wasted-trinket:${owner.id}:${Math.round(t)}`,
      type: "wasted-trinket",
      t,
      unitNames: [owner.name],
      facts: { t: fmt(t), unit: owner.name, teamMinHpPct: fmt(minHp) },
    });
  }
  return out;
}
```

Wiring (inside `teamPlayEvents`, appended to existing `try` block containing `analyzePlayerCCAndTrinket(owner,…)` call; probes assembled entirely via shared predicates):

```ts
const enemyTl = reconstructEnemyCDTimeline(enemies, combat);
const healer = friends.find((u) => isHealerSpec(u.spec));
const healerCC =
  healer && healer.id !== owner.id
    ? analyzePlayerCCAndTrinket(healer, enemies, combat, enemyPets).ccInstances
    : [];
out.push(
  ...wastedTrinketEvents(cc.trinketUseTimes, owner, {
    friendlyHpPctAt: (t) => {
      let min = 100;
      for (const f of friends) {
        const hp = getUnitHpAtTimestamp(
          f,
          combat.startTime + t * 1000,
          HP_SAMPLE_RADIUS_MS, // Single source predicate: same sample radius as evaluation gate
        );
        if (hp === null) return null;
        min = Math.min(min, hp);
      }
      return min;
    },
    healerInCCAt: (t) =>
      healerCC.some(
        (c) => c.atSeconds <= t && t <= c.atSeconds + c.durationSeconds,
      ),
    enemyOffensiveActiveAt: (t) =>
      enemyTl.players.some((p) =>
        p.offensiveCDs.some(
          (cd) => cd.castTimeSeconds <= t && t <= cd.buffEndSeconds,
        ),
      ),
  }),
);
```

Note: Confirm whether `getUnitHpAtTimestamp` returns HP% or absolute value by reading implementation first (if `advancedActorMaxHp` is involved, it may be pct); if absolute, convert to pct in probe assembly code while keeping threshold constant unchanged. When healer is owner (healer perspective), `healerInCCAt` is always false — owner using trinket in CC to break out is standard play, judged neutral via minHp/enemy burst conditions.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run --root packages/analysis src/analysis/candidateFindings.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(analysis): wasted-trinket candidate — PvP trinket wasted in neutral state (arenacoach TRINKET-001)"
```

---

### Task 5: Downstream Declarations — Prompt Type Guidance / Renderer Mistake Rule Table / PROMPT_VERSION

**Files:**

- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.ts` (3 entries in TYPE_GUIDANCE table)
- Modify: `packages/desktop/src/renderer/src/report/derive/mistakes.ts` (3 rows in MISTAKE_RULES + 3 cases in candidateDetail)
- Modify: `packages/desktop/src/shared/promptVersion.ts` (PROMPT_VERSION +1)
- Test: Existing `report.mistakes.test.tsx` manifest test (automatic coverage), `buildFindingsPrompt.test.ts` (update snapshot if type guidance count asserted)

**Interfaces:**

- Consumes: Three type strings and facts key names from Task 2/3/4 (`walls`/`free`, `victim`/`external`/`freeGapS`, `teamMinHpPct`)
- Produces: User-visible mistake list items and AI coach guidance; PROMPT_VERSION bump invalidates legacy analysis cache (batch analysis will rerun, expected behavior, noted in next changelog)

- [ ] **Step 1: Add 3 entries to TYPE_GUIDANCE (in English, matching existing style; write original instructions, do not copy arenacoach copy)**

```ts
"death-unused-defensive": `- "death-unused-defensive": the player died at facts.t while major defensive(s) facts.walls were OFF cooldown. facts.free explains why pressing was possible: "yes" = not in CC; "trinket_in_hand" = CC'd but trinket was available to break out first; "usable_in_cc" = the listed ability works while CC'd. Coach pressing defensives earlier when taking heavy damage; do not invent which damage killed them.`,
"external-unused": `- "external-unused": teammate facts.victim died at facts.t while the player (facts.owner) had external defensive facts.external off cooldown and was free of CC for facts.freeGapS seconds in the final window. Coach external usage priorities; never claim the external would certainly have saved them.`,
"wasted-trinket": `- "wasted-trinket": the player used their PvP trinket at facts.t in a neutral state (team minimum HP facts.teamMinHpPct%, healer free, no enemy offensive cooldowns active). Coach saving trinket for kill windows or breaking lethal CC.`,
```

- [ ] **Step 2: Add 3 rows to MISTAKE_RULES + candidateDetail cases**

```ts
{ type: "death-unused-defensive", label: "Defensive off CD unpressed on death", severity: "major", source: "candidate" },
{ type: "external-unused",        label: "External off CD not cast on mate death", severity: "major", source: "candidate" },
{ type: "wasted-trinket",         label: "Trinket wasted in neutral state", severity: "major", source: "candidate" },
```

Add `candidateDetail` switch cases: `death-unused-defensive` → `` `${c.facts.walls} off CD unpressed on death` ``; `external-unused` → `` `${c.facts.external} off CD when ${c.facts.victim} died` ``; `wasted-trinket` → `` `Trinket used at ${c.facts.teamMinHpPct}% team min HP` ``.

- [ ] **Step 3: Increment PROMPT_VERSION** (`packages/desktop/src/shared/promptVersion.ts`, increment current value by 1, comment noting this batch's 3 types)

- [ ] **Step 4: Run desktop-related tests**

Run: `npx vitest run --root packages/desktop test/report.mistakes.test.tsx && npx vitest run --root packages/analysis src/analysis/buildFindingsPrompt.test.ts`
Expected: All PASS (manifest test passes due to MISTAKE_RULES entries; update prompt test if guidance entry count is asserted)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: downstream wiring for arenacoach batch — prompt guidance / 3 mistake rules / PROMPT_VERSION bump"
```

---

### Task 6: Corpus Empirical Verification (Incidence Metrics + Manual Sampling)

**Files:**

- Create: `packages/eval/src/scan/newCandidateScan.ts` (reusable scanner, no one-off scripts; entrypoint/CLI matches existing scan pattern — inspect precedents via `grep -rn "rotScan\|pvpReplaceScan" packages/eval/src`)
- Test: None (scanner itself is a measurement tool; evaluation predicates are unit-tested in Tasks 2-4)

**Interfaces:**

- Consumes: `extractCandidateFindings` (updated menu), local match library (`matchesDir`, ~794 matches) or `$GLADLOG_EVAL_HOME` corpus loader
- Produces: Per-type incidence table (mandatory attachment in plan execution report): `matches-with-emit / applicable-matches`, plus 5 manual sample records per category

- [ ] **Step 1: Write scanner following scan precedent** — Load match by match → `extractCandidateFindings(legacy, ownerId)` → collect statistics for all 3 types: matches with emits, average emits per match, applicable denominator (death-unused-defensive denominator = matches where owner died; external-unused denominator = matches where teammate died and owner has external; wasted-trinket denominator = matches where owner used trinket).

- [ ] **Step 2: Run on full corpus and record numbers**. Acceptance boundaries: incidence for each category within open interval (0%, 70%) — 0% indicates predicate never fires (mirror symptom of whitelist chain rot; check upstream), ≥70% indicates overly loose criteria (compared to arenacoach full-population metrics: DEATH-001 38%, DEATH-003 43%, TRINKET-001 34%; healer-perspective corpus may deviate but should not deviate by orders of magnitude).

- [ ] **Step 3: Manually verify facts on 5 sample matches per category**: availability (cross-check against battle report cooldown ledger rendering), timestamps aligned on render grid, free evaluation matches replay. 5/5 pass is required; if errors occur, return to Tasks 2-4 to fix predicates and rerun this Task.

- [ ] **Step 4: Out-of-bounds handling**: If incidence exceeds boundaries, adjust corresponding threshold (`TRINKET_NEUTRAL_HP_PCT` / `EXTERNAL_FREE_MIN_GAP_S`) or add pressure gate (mirroring `CD_WASTE_PRESSURE_HP_PCT` precedent); rerun Step 2 after changes; **document numbers and adjustment rationale in commit message**.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore(eval): corpus scan for 3 new candidate types — incidence X%/Y%/Z% (n=794), manual sampling 15/15 passed"
```

---

### Task 7: Wrap-up — Presubmit + agy Review + Push

- [ ] **Step 1**: `npm run presubmit` (output saved to file to check exit code, no pipes)
- [ ] **Step 2**: agy flash review (following `.claude/skills/agy-review`: write diff to patch file, prompt targeting suspicion surfaces — boundary conditions of free evaluation, open/closed intervals in owner death comparisons, HP pct/absolute conversion, cache invalidation impact of PROMPT_VERSION bump)
- [ ] **Step 3**: Handle accepted/rejected items one by one, then `git push`, monitoring CI green by headSha
- [ ] **Step 4**: Update `docs/BACKLOG.md` (if related items exist) and log "Batch 2 candidates" (DEATH-002 immunity available / COOLDOWN-001 CC suppression / DEFENSIVE-001-002 / DISPEL late tiering / OFFENSIVE-001-002) as future work

## Explicitly Out of Scope (YAGNI, Revisit in Batch 2)

- DEATH-002 (Immunity available on death): Requires immunity sub-table + Hypothermia-style shared debuff ledger; Forbearance exists but is incomplete.
- COOLDOWN-001 / DEFENSIVE-001 / DEFENSIVE-002 / OFFENSIVE-001 / OFFENSIVE-002 / DISPEL late tiering: Each requires new whitelists (minor defensives table / avoidance mechanics table / frontal cone ability table) or new geometric evaluations; following whitelist discipline, these require corpus empirical validation first as standalone projects.
- New hard gates in eval rules: The 3 new fact types do not yet enter `promptQualityCheck.hardFailures` (facts are emitted by deterministic predicates and eventIds and placeholders are already validated at audit layer; create dedicated project if Task 6 manual sampling reveals rendering discrepancies).
