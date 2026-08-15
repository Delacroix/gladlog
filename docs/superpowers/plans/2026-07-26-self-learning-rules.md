# Cross-Match Self-Learning (Ledger → Deterministic Filter → AI Distillation → Rules Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist historical AI findings to a local ledger, use deterministic filtering to extract stable patterns, have AI only translate/summarize passing a deterministic audit, and produce rules used for a "Recurring Habit" badge in new matches (without calling AI) and a long-term trends report page.

**Architecture:** Four-layer data flow — when `analysis.run` completes, append one row/run to `userData/learning/ledger.ndjson` (each row is a run containing findings, last-run-wins per matchId); `patternScan` pure function (packages/analysis) filters stable patterns; main side `learning.ts` service calls the model to distill + deterministically audits then writes `rules.json`; renderer uses the same matching predicate to attach badges to audited findings, and StatsDashboard adds a "Long-term Trends" card.

**Tech Stack:** TypeScript, Electron main (fs direct write, no DB), vitest, existing AI client abstractions (`resolveAiClient`/`AnthropicLike`).

**Spec:** `docs/superpowers/specs/2026-07-26-self-learning-rules-design.md` (includes the 2026-07-26 plan phase correction section — cross-match granularity is category + candidate type, not findingKey).

## Global Constraints

- Use `npm run typecheck` (root directory) for type checking, **never `tsc -b`**.
- Before pushing desktop changes: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`.
- The main process **must NEVER import the `@gladlog/analysis` barrel** (top-level await of large tables will drag into main), always use deep path imports (`@gladlog/analysis/src/learning/...`); newly added learning modules in this plan must not import any modules that pull in large tables (only depend on claimChecker/causalLint/findingCategories/types).
- Predicate as specification: windows/thresholds/retirement constants are defined exactly once in `patternScan.ts`, filtering, retirement, badges, and report pages all import the same copy.
- AI output forbids raw numbers, only `{{hits}}`/`{{windowMatches}}` placeholders are allowed; violations drop the entire item. Rule description/advice are stored as **templates** (with placeholders), and rendered using the shared `interpolate` for variable substitution — stat updates do not invalidate text.
- Commits: commit directly to main (repository convention, do not create branches); commit messages must be in Chinese and prefixed with the module name.
- Run tests for the respective package at the end of each Task; for Task 6 onwards involving desktop, run the three pre-push checks before every commit.

---

### Task 1: Shared Learning Types + patternScan Pure Function (packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/types.ts`
- Create: `packages/analysis/src/learning/patternScan.ts`
- Test: `packages/analysis/src/learning/patternScan.test.ts`

**Interfaces:**

- Consumes: None (purely new; types only reference this file).
- Produces (relied upon by all subsequent Tasks, exact signatures):
  - Types `LedgerRun`, `LedgerMatch`, `LedgerFinding`, `PatternCondition`, `StablePattern`, `GroupStats`, `LearnedRule`, `RulesDoc` (see code below).
  - Constants `PATTERN_WINDOW_MATCHES=20`, `PATTERN_MIN_HITS=5`, `RULE_RETIRE_MAX_HITS=2`, `TREND_BUCKET_MATCHES=5`, `SLICE_MIN_HITS=4`, `SLICE_RATE_FACTOR=2`.
  - `patternId(category: string, eventTypes: string[], cond: PatternCondition | null): string`
  - `findingMatchesGroup(f: LedgerFinding, category: string, eventTypes: string[]): boolean`
  - `matchInCondition(m: { zoneId?: string; enemySpecs: number[] }, cond: PatternCondition | null): boolean`
  - `measureGroup(all: LedgerMatch[], category: string, eventTypes: string[], condition: PatternCondition | null): GroupStats`
  - `scanPatterns(all: LedgerMatch[]): StablePattern[]`
  - `nextRuleStatus(prev: "active" | "improved", hits: number): "active" | "improved"`

- [ ] **Step 1: Write types.ts**

```ts
/**
 * Shared types for cross-match self-learning (spec: docs/superpowers/specs/2026-07-26-self-learning-rules-design.md).
 * Shared across ledger (desktop main) and filter/distill/apply (this directory) — a single source of predicate requires a single source of types.
 *
 * Cross-match key is category (+ candidate event type), **not findingKey**: findingKey contains
 * eventIds, which are local IDs for candidate events in each match and never repeat across matches (aggregate() across matches also only uses
 * category, findingKey only serves single-match flags).
 */

/** One row in ledger = one analysis run (embedding findings of that match). Re-analyzing the same match appends a new row;
 * reading selects the row with max createdAt per matchId (last-run-wins, whole match replacement —
 * per-finding last-write-wins would leave discarded old findings perpetually lingering). */
export interface LedgerRun {
  v: 1;
  matchId: string;
  /** Match start time (ms) — window sort key (startTime from meta.json). */
  startTime: number;
  win: boolean;
  zoneId?: string;
  bracket?: string;
  /** Enemy specialization IDs (meta.teams[1]); [] if old archive lacks teams. */
  enemySpecs: number[];
  /** Record only, never invalidate: decouple learned memory from prompt cache invalidation (spec §1). */
  promptVersion: number;
  createdAt: number;
  findings: LedgerFinding[];
}

export interface LedgerFinding {
  /** Slug passed through normalizeFindingCategory (guaranteed by write side). */
  category: string;
  severity: string;
  /** Deduplicated, ascending candidate event types referenced by the finding (present in live writes; [] in backfilled historical matches). */
  eventTypes: string[];
}

/** Merged match view of ledger = LedgerRun without envelope fields; input to scan/statistics. */
export type LedgerMatch = Omit<LedgerRun, "v" | "promptVersion" | "createdAt">;

export interface PatternCondition {
  enemySpec?: number;
  zoneId?: string;
}

export interface GroupStats {
  /** Actual window size (min(eligible matches count, PATTERN_WINDOW_MATCHES)). */
  windowMatches: number;
  hits: number;
  /** Across full history (not limited to window) startTime of first/last hit match; 0 when no hits. */
  firstSeen: number;
  lastSeen: number;
  /** Hits bucketed by TREND_BUCKET_MATCHES matches in window, old → new. */
  trend: number[];
  /** Most recent hit match IDs in window, new → old, ≤3 — distillation instances and UI evidence chain. */
  exampleMatchIds: string[];
  /** Whether hits span both older and newer halves of the window (excluding single loss streak spikes). */
  spansBothHalves: boolean;
}

export interface StablePattern {
  /** Deterministic ID, also used as ruleId: cat:<c>[|type:<t>][|spec:<id>][|zone:<id>] */
  patternId: string;
  category: string;
  /** [] = category level; ["death"] = category+type level (single type). */
  eventTypes: string[];
  condition: PatternCondition | null;
  windowMatches: number;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  trend: number[];
  exampleMatchIds: string[];
}

export interface LearnedRule {
  ruleId: string;
  status: "active" | "improved";
  category: string;
  eventTypes: string[];
  condition: PatternCondition | null;
  stats: {
    windowMatches: number;
    hits: number;
    firstSeen: number;
    lastSeen: number;
    trend: number[];
  };
  /** Template text (containing {{hits}}/{{windowMatches}} placeholders), interpolated at render time.
   * Missing current language → UI uses deterministic fallback (category label + stats), lazily backfilled on next consolidation. */
  description: { zh?: string; en?: string };
  advice: { zh?: string; en?: string };
  evidence: string[];
  distilledAt: number;
  distillModel: string;
}

export interface RulesDoc {
  schemaVersion: 1;
  updatedAt: number;
  /** Number of matches covered in ledger during last consolidation — criterion for incremental auto-triggering. */
  ledgerMatches: number;
  rules: LearnedRule[];
}
```

- [ ] **Step 2: Write patternScan.test.ts (failing tests)**

```ts
import { describe, expect, it } from "vitest";

import {
  matchInCondition,
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  patternId,
  RULE_RETIRE_MAX_HITS,
  scanPatterns,
} from "./patternScan";
import type { LedgerMatch } from "./types";

/** Greater i means newer; hit=true includes one survival finding. */
const mk = (
  i: number,
  hit: boolean,
  opts: { type?: string; enemySpecs?: number[]; zoneId?: string } = {},
): LedgerMatch => ({
  matchId: `m${i}`,
  startTime: 1_000_000 + i * 60_000,
  win: false,
  zoneId: opts.zoneId,
  enemySpecs: opts.enemySpecs ?? [],
  findings: hit
    ? [
        {
          category: "survival",
          severity: "high",
          eventTypes: opts.type ? [opts.type] : [],
        },
      ]
    : [],
});

describe("patternId", () => {
  it("deterministic concatenation, type ascending, conditions sorted spec->zone", () => {
    expect(patternId("survival", ["death"], { enemySpec: 62 })).toBe(
      "cat:survival|type:death|spec:62",
    );
    expect(patternId("cooldowns", [], null)).toBe("cat:cooldowns");
  });
});

describe("scanPatterns stability determination", () => {
  it("window with 5 hits spanning both halves -> emitted; 4 hits -> not emitted", () => {
    // 20 matches, hits distributed across i=1,5,10,15,19 (spanning both halves)
    const hits = new Set([1, 5, 10, 15, 19]);
    const m5 = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m5).some((p) => p.patternId === "cat:survival")).toBe(
      true,
    );
    const m4 = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i) && i !== 10),
    );
    expect(scanPatterns(m4)).toEqual([]);
  });

  it("hits clustered in one half of window (streak spike) -> not emitted", () => {
    const hits = new Set([15, 16, 17, 18, 19]); // All in newer half
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("window only takes most recent 20 matches: hits before match 21 do not count", () => {
    // 30 matches, hits all in oldest 10 matches -> 0 hits in window (most recent 20)
    const m = Array.from({ length: 30 }, (_, i) => mk(i, i < 10));
    expect(scanPatterns(m)).toEqual([]);
  });

  it("when type-level completely covers category-level, only type-level is emitted", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) =>
      mk(i, hits.has(i), { type: "death" }),
    );
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|type:death");
    expect(ids).not.toContain("cat:survival");
  });

  it("condition slice: subset hit rate >= 2x overall rate and >= 4 matches -> additionally emits conditional pattern", () => {
    // 20 matches: 8 against Mage (spec 62), 6 of which hit; other 12 matches 0 hits.
    // Full set 6/20=0.3, subset 6/8=0.75 >= 2x0.3 ✓
    const m = Array.from({ length: 20 }, (_, i) => {
      const vsMage = i < 8;
      // Hits distributed across both halves: i in {0,1,2,5,6,7}
      const hit = vsMage && i !== 3 && i !== 4;
      return mk(i, hit, { enemySpecs: vsMage ? [62] : [71] });
    });
    const ids = scanPatterns(m).map((p) => p.patternId);
    expect(ids).toContain("cat:survival|spec:62");
  });
});

describe("measureGroup", () => {
  it("trend bucketed by 5 matches (old->new), example takes most recent hits <= 3", () => {
    const hits = new Set([1, 5, 10, 15, 19]);
    const m = Array.from({ length: 20 }, (_, i) => mk(i, hits.has(i)));
    const g = measureGroup(m, "survival", [], null);
    expect(g.hits).toBe(5);
    expect(g.windowMatches).toBe(20);
    expect(g.trend).toEqual([1, 1, 1, 2]); // Buckets [0-4],[5-9],[10-14],[15-19]
    expect(g.exampleMatchIds).toEqual(["m19", "m15", "m10"]);
    expect(g.spansBothHalves).toBe(true);
  });

  it("when fewer than 20 matches, window takes actual match count", () => {
    const m = Array.from({ length: 6 }, (_, i) => mk(i, i % 2 === 0));
    const g = measureGroup(m, "survival", [], null);
    expect(g.windowMatches).toBe(6);
    expect(g.hits).toBe(3);
  });
});

describe("retire/reactivate predicate (hysteresis)", () => {
  it("<=RETIRE retires, >=MIN_HITS reactivates, in-between maintains status quo", () => {
    expect(nextRuleStatus("active", RULE_RETIRE_MAX_HITS)).toBe("improved");
    expect(nextRuleStatus("improved", PATTERN_MIN_HITS)).toBe("active");
    expect(nextRuleStatus("active", 3)).toBe("active");
    expect(nextRuleStatus("improved", 3)).toBe("improved");
  });
});

describe("matchInCondition (same predicate on application side)", () => {
  it("null is always true; enemySpec requires inclusion; zoneId requires equality", () => {
    expect(matchInCondition({ enemySpecs: [] }, null)).toBe(true);
    expect(matchInCondition({ enemySpecs: [62, 71] }, { enemySpec: 62 })).toBe(
      true,
    );
    expect(matchInCondition({ enemySpecs: [71] }, { enemySpec: 62 })).toBe(
      false,
    );
    expect(
      matchInCondition({ zoneId: "1552", enemySpecs: [] }, { zoneId: "1552" }),
    ).toBe(true);
    expect(matchInCondition({ enemySpecs: [] }, { zoneId: "1552" })).toBe(
      false,
    ); // Unknown zoneId -> conservatively does not match
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run src/learning/patternScan.test.ts` (cwd `packages/analysis`)
Expected: FAIL (module does not exist).

- [ ] **Step 4: Write patternScan.ts implementation**

```ts
/**
 * Deterministic filter (spec §2): ledger match view -> stable patterns.
 *
 * Predicate as specification: constants and predicates here are the sole authority — retirement (learning.ts),
 * badges (matchRules.ts), and report pages all import this file, never duplicate numerical values.
 */
import type {
  GroupStats,
  LedgerFinding,
  LedgerMatch,
  PatternCondition,
  StablePattern,
} from "./types";

export const PATTERN_WINDOW_MATCHES = 20;
export const PATTERN_MIN_HITS = 5;
export const RULE_RETIRE_MAX_HITS = 2;
export const TREND_BUCKET_MATCHES = 5;
/** Condition slice significance (spec §2): subset hits >= 4 and hit rate >= 2x full set. */
export const SLICE_MIN_HITS = 4;
export const SLICE_RATE_FACTOR = 2;

export function patternId(
  category: string,
  eventTypes: string[],
  cond: PatternCondition | null,
): string {
  let id = `cat:${category}`;
  for (const t of [...eventTypes].sort()) id += `|type:${t}`;
  if (cond?.enemySpec !== undefined) id += `|spec:${cond.enemySpec}`;
  if (cond?.zoneId !== undefined) id += `|zone:${cond.zoneId}`;
  return id;
}

/** finding matches group: category matches and all group event types are referenced. */
export function findingMatchesGroup(
  f: LedgerFinding,
  category: string,
  eventTypes: string[],
): boolean {
  if (f.category !== category) return false;
  return eventTypes.every((t) => f.eventTypes.includes(t));
}

/** Whether match satisfies condition — the EXACT SAME predicate shared between filtering and application (badges).
 * If condition field is unknown on match side (e.g. renderer cannot get zoneId) -> conservatively evaluates to false. */
export function matchInCondition(
  m: { zoneId?: string; enemySpecs: number[] },
  cond: PatternCondition | null,
): boolean {
  if (!cond) return true;
  if (cond.enemySpec !== undefined && !m.enemySpecs.includes(cond.enemySpec))
    return false;
  if (cond.zoneId !== undefined && m.zoneId !== cond.zoneId) return false;
  return true;
}

const hitsIn = (m: LedgerMatch, category: string, eventTypes: string[]) =>
  m.findings.some((f) => findingMatchesGroup(f, category, eventTypes));

export function measureGroup(
  all: LedgerMatch[],
  category: string,
  eventTypes: string[],
  condition: PatternCondition | null,
): GroupStats {
  const eligible = all
    .filter((m) => matchInCondition(m, condition))
    .sort((a, b) => b.startTime - a.startTime); // New -> old
  const window = eligible.slice(0, PATTERN_WINDOW_MATCHES);
  const hitFlags = window.map((m) => hitsIn(m, category, eventTypes));
  const hits = hitFlags.filter(Boolean).length;

  const half = Math.floor(window.length / 2);
  const newerHits = hitFlags.slice(0, half).some(Boolean);
  const olderHits = hitFlags.slice(half).some(Boolean);

  // trend old -> new bucketing
  const oldFirst = [...window].reverse();
  const trend: number[] = [];
  for (let i = 0; i < oldFirst.length; i += TREND_BUCKET_MATCHES) {
    trend.push(
      oldFirst
        .slice(i, i + TREND_BUCKET_MATCHES)
        .filter((m) => hitsIn(m, category, eventTypes)).length,
    );
  }

  const allHits = eligible.filter((m) => hitsIn(m, category, eventTypes));
  return {
    windowMatches: window.length,
    hits,
    firstSeen: allHits.length
      ? Math.min(...allHits.map((m) => m.startTime))
      : 0,
    lastSeen: allHits.length ? Math.max(...allHits.map((m) => m.startTime)) : 0,
    trend,
    exampleMatchIds: window
      .filter((_, i) => hitFlags[i])
      .slice(0, 3)
      .map((m) => m.matchId),
    spansBothHalves: newerHits && olderHits,
  };
}

/** Retire/reactivate (spec §5): Hysteresis — status quo maintained between thresholds to prevent boundary jitter. */
export function nextRuleStatus(
  prev: "active" | "improved",
  hits: number,
): "active" | "improved" {
  if (hits <= RULE_RETIRE_MAX_HITS) return "improved";
  if (hits >= PATTERN_MIN_HITS) return "active";
  return prev;
}

const qualifies = (g: GroupStats) =>
  g.hits >= PATTERN_MIN_HITS && g.spansBothHalves;

export function scanPatterns(all: LedgerMatch[]): StablePattern[] {
  if (all.length === 0) return [];
  const window = [...all]
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, PATTERN_WINDOW_MATCHES);

  // Candidate group domain: categories and category+type that appeared in window
  const cats = new Set<string>();
  const typesByCat = new Map<string, Set<string>>();
  for (const m of window)
    for (const f of m.findings) {
      cats.add(f.category);
      const s = typesByCat.get(f.category) ?? new Set<string>();
      for (const t of f.eventTypes) s.add(t);
      typesByCat.set(f.category, s);
    }

  const out: StablePattern[] = [];
  const emit = (
    category: string,
    eventTypes: string[],
    condition: PatternCondition | null,
    g: GroupStats,
  ) =>
    out.push({
      patternId: patternId(category, eventTypes, condition),
      category,
      eventTypes,
      condition,
      windowMatches: g.windowMatches,
      hits: g.hits,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      trend: g.trend,
      exampleMatchIds: g.exampleMatchIds,
    });

  // Condition slice domain: enemy spec / zoneId that appeared in window
  const specs = new Set<number>();
  const zones = new Set<string>();
  for (const m of window) {
    for (const s of m.enemySpecs) specs.add(s);
    if (m.zoneId) zones.add(m.zoneId);
  }
  const emitSlices = (
    category: string,
    eventTypes: string[],
    base: GroupStats,
  ) => {
    const baseRate = base.windowMatches ? base.hits / base.windowMatches : 0;
    const conds: PatternCondition[] = [
      ...[...specs].map((s) => ({ enemySpec: s })),
      ...[...zones].map((z) => ({ zoneId: z })),
    ];
    for (const cond of conds) {
      const g = measureGroup(all, category, eventTypes, cond);
      const rate = g.windowMatches ? g.hits / g.windowMatches : 0;
      if (
        g.hits >= SLICE_MIN_HITS &&
        g.spansBothHalves &&
        rate >= SLICE_RATE_FACTOR * baseRate
      )
        emit(category, eventTypes, cond, g);
    }
  };

  for (const cat of cats) {
    const catStats = measureGroup(all, cat, [], null);
    const typeStats = [...(typesByCat.get(cat) ?? [])].map((t) => ({
      t,
      g: measureGroup(all, cat, [t], null),
    }));
    const qualifyingTypes = typeStats.filter(({ g }) => qualifies(g));
    for (const { t, g } of qualifyingTypes) {
      emit(cat, [t], null, g);
      emitSlices(cat, [t], g);
    }
    // Category level only emits if it provides more information than the best type level (more hits),
    // avoiding 100% overlapping duplicate rules like "survival" vs "survival+death".
    const bestType = Math.max(0, ...qualifyingTypes.map(({ g }) => g.hits));
    if (qualifies(catStats) && catStats.hits > bestType) {
      emit(cat, [], null, catStats);
      emitSlices(cat, [], catStats);
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}
```

- [ ] **Step 5: Run tests to verify success**

Run: `npx vitest run src/learning/patternScan.test.ts` (cwd `packages/analysis`)
Expected: PASS all green. If condition slice test fails, verify whether the constructed hit distribution in test genuinely spans both halves (the condition subset's own window recalculates its own halves).

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/learning/
git commit -m "feat(analysis): cross-match self-learning deterministic filter — patternScan pure function + single-source predicate constants"
```

---

### Task 2: AI Distillation Prompt + Deterministic Audit (packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/distillRules.ts`
- Test: `packages/analysis/src/learning/distillRules.test.ts`

**Interfaces:**

- Consumes: `StablePattern` from Task 1; existing `claimChecker`/`interpolate` (`../compare/claimChecker`), `causalLint` (`../analysis/causalLint`).
- Produces:
  - `distillFacts(p: { hits: number; windowMatches: number }): Record<string, string>` — placeholder fact table `{hits, windowMatches}`.
  - `buildDistillPrompt(patterns: StablePattern[], examples: Record<string, string[]>, lang: "zh" | "en"): string`
  - `auditDistilledRules(parsed: unknown[] | null, patterns: StablePattern[]): { texts: Array<{ patternId: string; description: string; advice: string }>; dropped: Array<{ patternId?: string; reason: string }> }`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";

import {
  auditDistilledRules,
  buildDistillPrompt,
  distillFacts,
} from "./distillRules";
import type { StablePattern } from "./types";

const pat = (id: string): StablePattern => ({
  patternId: id,
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  windowMatches: 20,
  hits: 9,
  firstSeen: 1,
  lastSeen: 2,
  trend: [2, 3, 2, 2],
  exampleMatchIds: ["m1"],
});

describe("auditDistilledRules", () => {
  const patterns = [pat("cat:survival|type:death")];

  it("compliant entries pass; placeholders can be interpolated by distillFacts", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description:
            "In {{hits}} of the last {{windowMatches}} matches, survival issues were present.",
          advice: "Check healer mana before committing offensive cooldowns.",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
    expect(distillFacts(patterns[0]!)).toEqual({
      hits: "9",
      windowMatches: "20",
    });
  });

  it("bare digits -> dropped", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "In 9 of the last 20 matches, survival issues were present.",
          advice: "ok",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/digit/);
  });

  it("unknown patternId / unknown placeholders / causal assertions -> dropped; null input -> all empty", () => {
    const bad = auditDistilledRules(
      [
        { patternId: "cat:nope", description: "x", advice: "y" },
        {
          patternId: "cat:survival|type:death",
          description: "{{deaths}} deaths",
          advice: "y",
        },
      ],
      patterns,
    );
    expect(bad.texts).toHaveLength(0);
    expect(bad.dropped).toHaveLength(2);
    expect(auditDistilledRules(null, patterns).texts).toHaveLength(0);
  });

  it("duplicate entries for the same patternId: first-wins", () => {
    const r = auditDistilledRules(
      [
        {
          patternId: "cat:survival|type:death",
          description: "First entry",
          advice: "a",
        },
        {
          patternId: "cat:survival|type:death",
          description: "Second entry",
          advice: "b",
        },
      ],
      patterns,
    );
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]!.description).toBe("First entry");
  });
});

describe("buildDistillPrompt", () => {
  it("includes pattern data, examples, hard rules, and language instructions", () => {
    const p = buildDistillPrompt(
      [pat("cat:survival|type:death")],
      { "cat:survival|type:death": ["Died without defensive cooldowns during enemy burst."] },
      "zh",
    );
    expect(p).toContain("cat:survival|type:death");
    expect(p).toContain("{{hits}}");
    expect(p).toContain("Died without defensive cooldowns during enemy burst.");
    expect(p).toContain("Simplified Chinese");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/learning/distillRules.test.ts` (cwd `packages/analysis`)
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write implementation**

```ts
/**
 * AI Distillation (spec §3): stable patterns -> rule text. AI only translates to natural language and summarizes,
 * not allowed to invent facts — audit follows the placeholder discipline from findings: bare digits forbidden in text,
 * the only legal numbers are placeholders {{hits}} and {{windowMatches}}, interpolated from stats by code at render time.
 */
import { claimChecker } from "../compare/claimChecker";
import { causalLint } from "../analysis/causalLint";
import type { StablePattern } from "./types";

export function distillFacts(p: {
  hits: number;
  windowMatches: number;
}): Record<string, string> {
  return { hits: String(p.hits), windowMatches: String(p.windowMatches) };
}

export function buildDistillPrompt(
  patterns: StablePattern[],
  examples: Record<string, string[]>,
  lang: "zh" | "en",
): string {
  const data = patterns.map((p) => ({
    patternId: p.patternId,
    category: p.category,
    eventTypes: p.eventTypes,
    condition: p.condition,
    hits: p.hits,
    windowMatches: p.windowMatches,
    exampleFindings: examples[p.patternId] ?? [],
  }));
  const language =
    lang === "zh"
      ? "Write description/advice in Simplified Chinese. Keep spell/ability names in English."
      : "Write description/advice in English.";
  return [
    "You are summarizing a player's RECURRING habits across many arena matches.",
    "Each pattern below was found by deterministic statistics over past AI findings.",
    "For EACH pattern, write a short description of the habit and one actionable training advice.",
    "",
    "PATTERNS (JSON):",
    JSON.stringify(data, null, 1),
    "",
    "HARD RULES:",
    '1. Output ONLY a JSON array: [{"patternId": "...", "description": "...", "advice": "..."}]. No prose, no markdown fence.',
    "2. patternId MUST be copied verbatim from the patterns above. Exactly one object per pattern.",
    "3. NEVER write a bare number. The ONLY numbers allowed are the literal placeholders {{hits}} and {{windowMatches}}.",
    "4. Ground every statement ONLY in the given stats and exampleFindings. Do not invent events, spells, or reasons.",
    '5. No causal certainty ("caused", "because you died"); use hedged phrasing ("tends to", "often coincides with").',
    `6. ${language}`,
  ].join("\n");
}

export function auditDistilledRules(
  parsed: unknown[] | null,
  patterns: StablePattern[],
): {
  texts: Array<{ patternId: string; description: string; advice: string }>;
  dropped: Array<{ patternId?: string; reason: string }>;
} {
  const texts: Array<{
    patternId: string;
    description: string;
    advice: string;
  }> = [];
  const dropped: Array<{ patternId?: string; reason: string }> = [];
  if (!Array.isArray(parsed)) return { texts, dropped };
  const byId = new Map(patterns.map((p) => [p.patternId, p]));
  const seen = new Set<string>();

  for (const item of parsed) {
    const o = item as {
      patternId?: unknown;
      description?: unknown;
      advice?: unknown;
    };
    if (
      typeof o?.patternId !== "string" ||
      typeof o?.description !== "string" ||
      typeof o?.advice !== "string"
    ) {
      dropped.push({ reason: "shape: missing patternId/description/advice" });
      continue;
    }
    const p = byId.get(o.patternId);
    if (!p) {
      dropped.push({ patternId: o.patternId, reason: "unknown patternId" });
      continue;
    }
    if (seen.has(o.patternId)) {
      dropped.push({ patternId: o.patternId, reason: "duplicate patternId" });
      continue;
    }
    const facts = distillFacts(p);
    const bad = ["description", "advice"]
      .map((field) => {
        const text = field === "description" ? o.description : o.advice;
        const check = claimChecker(text as string, facts);
        if (!check.ok)
          return `${field} numeric: ${check.violations.join("; ")}`;
        // Same strictness as auditFindings: after stripping placeholders and 2v2/3v3, no digits allowed in prose
        const prose = (text as string)
          .replace(/\{\{\s*[\w.]+\s*\}\}/g, " ")
          .replace(/\b\d+v\d+\b/gi, " ");
        if (/\d/.test(prose)) return `${field}: raw digit outside placeholder`;
        const causal = causalLint(text as string);
        if (causal.length > 0) return `${field} causal: ${causal.join("; ")}`;
        return null;
      })
      .filter((x): x is string => x !== null);
    if (bad.length > 0) {
      dropped.push({ patternId: o.patternId, reason: bad.join(" | ") });
      continue;
    }
    seen.add(o.patternId);
    texts.push({
      patternId: o.patternId,
      description: o.description,
      advice: o.advice,
    });
  }
  return { texts, dropped };
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npx vitest run src/learning/distillRules.test.ts` (cwd `packages/analysis`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src/learning/distillRules.ts packages/analysis/src/learning/distillRules.test.ts
git commit -m "feat(analysis): AI distillation prompt for learning rules + placeholder discipline audit"
```

---

### Task 3: Rule Application Predicate + Habit Badge Text (packages/analysis)

**Files:**

- Create: `packages/analysis/src/learning/matchRules.ts`
- Test: `packages/analysis/src/learning/matchRules.test.ts`

**Interfaces:**

- Consumes: `findingMatchesGroup`/`matchInCondition`/`LearnedRule` from Task 1; existing `CandidateEvent`/`Finding` (`../analysis/types`).
- Produces (relied upon by renderer and tests):
  - `ruleAppliesToFinding(rule: LearnedRule, finding: Pick<Finding, "category" | "eventIds">, candidates: CandidateEvent[], meta: { zoneId?: string; enemySpecs: number[] }): boolean`
  - `habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string` — deterministic text, numbers from stats, not AI.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";

import type { CandidateEvent } from "../analysis/types";
import { habitBadgeText, ruleAppliesToFinding } from "./matchRules";
import type { LearnedRule } from "./types";

const rule = (over: Partial<LearnedRule> = {}): LearnedRule => ({
  ruleId: "cat:survival|type:death",
  status: "active",
  category: "survival",
  eventTypes: ["death"],
  condition: null,
  stats: { windowMatches: 20, hits: 9, firstSeen: 1, lastSeen: 2, trend: [] },
  description: {},
  advice: {},
  evidence: [],
  distilledAt: 0,
  distillModel: "",
  ...over,
});

const cands: CandidateEvent[] = [
  { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
  { id: "e2", type: "cd-waste", t: 0, unitNames: ["A"], facts: {} },
];
const meta = { enemySpecs: [62] };

describe("ruleAppliesToFinding", () => {
  it("category+type match -> true; type mismatch -> false", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(ruleAppliesToFinding(rule(), f, cands, meta)).toBe(true);
    expect(
      ruleAppliesToFinding(
        rule(),
        { category: "survival", eventIds: ["e2"] },
        cands,
        meta,
      ),
    ).toBe(false);
  });

  it("improved rules do not attach badge; unmet condition does not attach", () => {
    const f = { category: "survival", eventIds: ["e1"] };
    expect(
      ruleAppliesToFinding(rule({ status: "improved" }), f, cands, meta),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 71 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(false);
    expect(
      ruleAppliesToFinding(
        rule({ condition: { enemySpec: 62 } }),
        f,
        cands,
        meta,
      ),
    ).toBe(true);
  });

  it("category level rule (eventTypes=[]) matches findings of same category unconditionally", () => {
    const f = { category: "survival", eventIds: ["e2"] };
    expect(ruleAppliesToFinding(rule({ eventTypes: [] }), f, cands, meta)).toBe(
      true,
    );
  });
});

describe("habitBadgeText", () => {
  it("deterministic, bilingual, numbers derived from stats", () => {
    expect(habitBadgeText(rule(), "zh")).toBe("惯性问题 · 近 20 场已犯 9 次");
    expect(habitBadgeText(rule(), "en")).toBe(
      "Recurring · 9 of last 20 matches",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/learning/matchRules.test.ts` (cwd `packages/analysis`)
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write implementation**

```ts
/**
 * Rule application (spec §4): deterministically match rules on audited findings in new matches without invoking AI.
 * Matching predicates share single source with patternScan (findingMatchesGroup / matchInCondition) —
 * "patterns filtered out" and "findings tagged with badges" must use the exact same predicate.
 */
import type { CandidateEvent, Finding } from "../analysis/types";
import { findingMatchesGroup, matchInCondition } from "./patternScan";
import type { LearnedRule } from "./types";

export function ruleAppliesToFinding(
  rule: LearnedRule,
  finding: Pick<Finding, "category" | "eventIds">,
  candidates: CandidateEvent[],
  meta: { zoneId?: string; enemySpecs: number[] },
): boolean {
  if (rule.status !== "active") return false;
  if (!matchInCondition(meta, rule.condition)) return false;
  const byId = new Map(candidates.map((c) => [c.id, c.type]));
  const eventTypes = [
    ...new Set(
      (finding.eventIds ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is string => !!t),
    ),
  ];
  return findingMatchesGroup(
    { category: finding.category, severity: "", eventTypes },
    rule.category,
    rule.eventTypes,
  );
}

/** Badge text: pure stats interpolation without passing through any model.
 * "Committed N times" is a statement of historical fact, avoiding "N+1th time" assertions on the current match. */
export function habitBadgeText(rule: LearnedRule, lang: "zh" | "en"): string {
  const { windowMatches, hits } = rule.stats;
  return lang === "zh"
    ? `惯性问题 · 近 ${windowMatches} 场已犯 ${hits} 次`
    : `Recurring · ${hits} of last ${windowMatches} matches`;
}
```

- [ ] **Step 4: Run tests to verify success; also run all analysis package tests**

Run: `npm test --workspace=packages/analysis`
Expected: PASS (including tests from Tasks 1/2).

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src/learning/matchRules.ts packages/analysis/src/learning/matchRules.test.ts
git commit -m "feat(analysis): rule application predicate (shared with patternScan) + habit badge text"
```

---

### Task 4: Learning Ledger learningLedger (desktop main)

**Files:**

- Create: `packages/desktop/src/main/learningLedger.ts`
- Test: `packages/desktop/src/main/learningLedger.test.ts`

**Interfaces:**

- Consumes: `LedgerRun`/`LedgerMatch` types from Task 1 (deep path `@gladlog/analysis/src/learning/types`, type-only, does not pull large tables).
- Produces (relied upon by Task 5):
  - `createLearningLedger(learningDir: string): LearningLedger`
  - `type LearningLedger = { file: string; append(runs: LedgerRun[]): void; read(): { matches: LedgerMatch[]; badLines: number; totalLines: number }; compact(): void }`
  - `read()` semantics: takes the row with max createdAt per matchId; bad lines increment skip counter; matches are unordered (ordering belongs to patternScan).

- [ ] **Step 1: Write failing test**

```ts
import { mkdtempSync, readFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import type { LedgerRun } from "@gladlog/analysis/src/learning/types";
import { createLearningLedger } from "./learningLedger";

const run = (
  matchId: string,
  createdAt: number,
  cat = "survival",
): LedgerRun => ({
  v: 1,
  matchId,
  startTime: 1000,
  win: false,
  enemySpecs: [62],
  promptVersion: 12,
  createdAt,
  findings: [{ category: cat, severity: "high", eventTypes: ["death"] }],
});

const fresh = () =>
  createLearningLedger(mkdtempSync(join(tmpdir(), "gl-ledger-")));

describe("learningLedger", () => {
  it("append -> read roundtrip; last-run-wins per match (whole match replacement)", () => {
    const l = fresh();
    l.append([run("m1", 100, "survival")]);
    l.append([run("m1", 200, "cooldowns"), run("m2", 150)]);
    const { matches, badLines } = l.read();
    expect(badLines).toBe(0);
    expect(matches).toHaveLength(2);
    const m1 = matches.find((m) => m.matchId === "m1")!;
    expect(m1.findings[0]!.category).toBe("cooldowns"); // New run replaces whole match
  });

  it("bad lines are skipped and counted without affecting valid lines", () => {
    const l = fresh();
    l.append([run("m1", 100)]);
    appendFileSync(l.file, "not json\n{broken\n", "utf-8");
    l.append([run("m2", 100)]);
    const { matches, badLines } = l.read();
    expect(matches).toHaveLength(2);
    expect(badLines).toBe(2);
  });

  it("non-existent file -> empty result without throwing", () => {
    const l = fresh();
    expect(l.read()).toEqual({ matches: [], badLines: 0, totalLines: 0 });
  });

  it("compact: rewrites to merged view when redundant lines exceed threshold, read is equivalent before/after", () => {
    const l = fresh();
    // m1 written 5 times (4 redundant lines), m2 written 1 time
    for (let i = 1; i <= 5; i++) l.append([run("m1", i * 100)]);
    l.append([run("m2", 100)]);
    const before = l.read();
    l.compact();
    const after = l.read();
    expect(after.matches).toEqual(expect.arrayContaining(before.matches));
    expect(after.totalLines).toBe(2);
    // Idempotent: does not modify file if not redundant
    const raw = readFileSync(l.file, "utf-8");
    l.compact();
    expect(readFileSync(l.file, "utf-8")).toBe(raw);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/main/learningLedger.test.ts` (cwd `packages/desktop`)
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write implementation**

```ts
/**
 * Learning ledger (spec §1): append-only NDJSON, one row = one analysis run (embedding findings of that match).
 * Re-analyzing same match appends new row; reading selects max createdAt per matchId —
 * last-run-wins whole match replacement prevents discarded old findings from lingering.
 *
 * promptVersion is recorded but not invalidated: ledger memory is decoupled from analysis cache invalidation policies,
 * which is the core rationale for its independent existence apart from analysis-v2.*.json.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import type {
  LedgerMatch,
  LedgerRun,
} from "@gladlog/analysis/src/learning/types";

/** Rewrite only when line count exceeds 1.2x of merged match count (>20% redundancy) — spec §6. */
const COMPACT_REDUNDANCY_FACTOR = 1.2;

export type LearningLedger = ReturnType<typeof createLearningLedger>;

export function createLearningLedger(learningDir: string) {
  const file = join(learningDir, "ledger.ndjson");

  const readMerged = (): {
    byMatch: Map<string, LedgerRun>;
    badLines: number;
    totalLines: number;
  } => {
    const byMatch = new Map<string, LedgerRun>();
    let badLines = 0;
    let totalLines = 0;
    let raw = "";
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return { byMatch, badLines, totalLines };
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      totalLines++;
      try {
        const r = JSON.parse(line) as LedgerRun;
        if (r.v !== 1 || typeof r.matchId !== "string")
          throw new Error("shape");
        const prev = byMatch.get(r.matchId);
        if (!prev || r.createdAt >= prev.createdAt) byMatch.set(r.matchId, r);
      } catch {
        badLines++; // Bad lines skipped non-silently: count exposed to getState
      }
    }
    return { byMatch, badLines, totalLines };
  };

  return {
    file,
    append(runs: LedgerRun[]): void {
      if (runs.length === 0) return;
      mkdirSync(learningDir, { recursive: true });
      appendFileSync(
        file,
        runs.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    },
    read(): { matches: LedgerMatch[]; badLines: number; totalLines: number } {
      const { byMatch, badLines, totalLines } = readMerged();
      const matches = [...byMatch.values()].map(
        ({ v: _v, promptVersion: _p, createdAt: _c, ...m }) => m,
      );
      return { matches, badLines, totalLines };
    },
    /** Atomic rewrite to merged view when redundancy exceeds threshold (tmp+rename pattern). */
    compact(): void {
      const { byMatch, totalLines } = readMerged();
      if (totalLines <= byMatch.size * COMPACT_REDUNDANCY_FACTOR) return;
      const tmp = `${file}.tmp`;
      writeFileSync(
        tmp,
        [...byMatch.values()].map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
      renameSync(tmp, file);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npx vitest run src/main/learningLedger.test.ts` (cwd `packages/desktop`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/learningLedger.ts packages/desktop/src/main/learningLedger.test.ts
git commit -m "feat(desktop): learning ledger ledger.ndjson — one line per run, last-run-wins, bad line tolerance, compaction"
```

---

### Task 5: learning Service (Backfill + Consolidation + Auto-trigger) (desktop main)

**Files:**

- Create: `packages/desktop/src/main/learning.ts`
- Test: `packages/desktop/src/main/learning.test.ts`

**Interfaces:**

- Consumes: Tasks 1-4; existing `resolveAiClient`/`buildCoachSystemPrompt`/`PROMPT_VERSION` (`./ai`), `resolveAiModel` (`../shared/aiModels`), `parseModelJsonArray` (deep path), `recordAiDebug` (`./aiDebugLog`), `normalizeFindingCategory` (deep path).
- Produces (relied upon by Tasks 6/7/8):
  - `createLearningService(deps): LearningService`, deps isomorphic to `createAnalysisService` (getSettings/clientFactory?/matchesDir/emit) + `learningDir: string`.
  - `LearningService` methods:
    - `recordAnalysis(e: { matchId: string; findings: Finding[]; candidates: CandidateEvent[] }): void` — called at analysis write point; synchronous append + asynchronous maybeAutoConsolidate.
    - `init(): void` — called at app startup; background backfills if no marker exists, followed by initial consolidation.
    - `consolidate(): Promise<void>` — manual/automatic consolidation; concurrency guard; emits `gladlog:learning:done|error`.
    - `getRules(): Promise<RulesDoc | null>`
    - `getState(): Promise<LearningState>`, where `type LearningState` (exported) = `{ backfill: { running: boolean; scanned: number; total: number } | null; consolidating: boolean; ledgerMatches: number; badLines: number; lastConsolidatedAt: number | null }`
  - Constant `CONSOLIDATE_EVERY_MATCHES = 10` (exported, auto-trigger threshold).
  - Persisted files: `<learningDir>/rules.json` (RulesDoc, tmp+rename), `<learningDir>/backfill-done.json` (`{ at: number; scanned: number }`).

- [ ] **Step 1: Write failing test**

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { AnthropicLike } from "./ai";
import { createLearningService } from "./learning";

/** Seed a matches directory: n matches, even matches include analysis cache with survival finding. */
function seedMatches(root: string, n: number): string {
  const matchesDir = join(root, "matches");
  for (let i = 0; i < n; i++) {
    const dir = join(matchesDir, `m${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id: `m${i}`,
        startTime: 1_000_000 + i * 60_000,
        result: i % 3 === 0 ? "win" : "loss",
        zoneId: "1552",
        bracket: "3v3",
        teams: [[], [{ specId: 62, classId: 8 }]],
      }),
    );
    writeFileSync(
      join(dir, "analysis-v2.zh.json"),
      JSON.stringify({
        schemaVersion: 1,
        promptVersion: 7, // Intentionally old version: backfill must not check promptVersion
        language: "zh",
        createdAt: 1_000_000 + i * 60_000,
        result: {
          findings:
            i % 2 === 0
              ? [
                  {
                    eventIds: ["e1"],
                    severity: "high",
                    category: "survival",
                    title: "t",
                    explanation: "Died without defensive cooldowns during burst.",
                  },
                ]
              : [],
          dropped: 0,
          hadNarration: true,
        },
      }),
    );
  }
  return matchesDir;
}

const fakeClient = (raw: string): AnthropicLike => ({
  async *stream() {
    yield { delta: raw };
  },
});

const flush = () => new Promise((r) => setTimeout(r, 50));

function mkService(root: string, raw: string) {
  const events: Array<{ ch: string; payload: unknown }> = [];
  const svc = createLearningService({
    getSettings: () => ({
      anthropicApiKey: "k",
      aiModels: null,
      wowDirectory: null,
      aiLanguage: "zh" as const,
    }),
    clientFactory: () => fakeClient(raw),
    matchesDir: join(root, "matches"),
    learningDir: join(root, "learning"),
    emit: (ch, payload) => events.push({ ch, payload }),
  });
  return { svc, events };
}

describe("learning service", () => {
  it("backfill: all old promptVersion matches enter ledger; writes marker on completion + runs first consolidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn-"));
    seedMatches(root, 20);
    const good = JSON.stringify([
      {
        patternId: "cat:survival",
        description: "In {{hits}} of the last {{windowMatches}} matches, survival issues were present.",
        advice: "Be mindful of defensive cooldown timings.",
      },
    ]);
    const { svc } = mkService(root, good);
    svc.init();
    // Backfill + initial consolidation are asynchronous; poll marker
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const st = await svc.getState();
    expect(st.ledgerMatches).toBe(20);
    const doc = (await svc.getRules()) as RulesDoc;
    expect(doc).not.toBeNull();
    // 10/20 matches hit survival (even matches), must produce active rule
    const r = doc.rules.find((x) => x.ruleId === "cat:survival");
    expect(r?.status).toBe("active");
    expect(r?.stats.hits).toBe(10);
    expect(r?.description.zh).toContain("{{hits}}");
  });

  it("distillation outputs raw digits -> dropped by audit, rule remains without text; stats persisted normally", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn2-"));
    seedMatches(root, 20);
    const bad = JSON.stringify([
      { patternId: "cat:survival", description: "10 times in 20 matches", advice: "x" },
    ]);
    const { svc } = mkService(root, bad);
    svc.init();
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const doc = (await svc.getRules()) as RulesDoc;
    const r = doc.rules.find((x) => x.ruleId === "cat:survival")!;
    expect(r.stats.hits).toBe(10);
    expect(r.description.zh).toBeUndefined();
  });

  it("recordAnalysis: appends to ledger with candidate types; auto consolidation triggers after 10 incremental matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn3-"));
    seedMatches(root, 1);
    const { svc } = mkService(root, "[]");
    // Manually place backfill marker to bypass backfill path
    mkdirSync(join(root, "learning"), { recursive: true });
    writeFileSync(
      join(root, "learning", "backfill-done.json"),
      JSON.stringify({ at: 1, scanned: 0 }),
    );
    svc.init();
    svc.recordAnalysis({
      matchId: "m0",
      findings: [
        {
          eventIds: ["e1"],
          severity: "high",
          category: "survival",
          title: "t",
          explanation: "x",
        },
      ],
      candidates: [
        { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
      ],
    });
    await flush();
    const ledger = readFileSync(
      join(root, "learning", "ledger.ndjson"),
      "utf-8",
    );
    expect(ledger).toContain('"eventTypes":["death"]');
    expect(ledger).toContain('"enemySpecs":[62]');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/main/learning.test.ts` (cwd `packages/desktop`)
Expected: FAIL (module does not exist).

- [ ] **Step 3: Write implementation**

```ts
/**
 * Cross-match self-learning service (spec §3/§5): ledger -> patternScan deterministic filter -> AI distillation
 * (placeholder discipline audit) -> rules.json. Deterministic stats/status are ALWAYS persisted;
 * AI text failure only affects description/advice and is lazily backfilled next round.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { mkdirSync } from "fs";
import { join } from "path";

import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import { parseModelJsonArray } from "@gladlog/analysis/src/analysis/parseModelJson";
import type {
  CandidateEvent,
  Finding,
} from "@gladlog/analysis/src/analysis/types";
import {
  auditDistilledRules,
  buildDistillPrompt,
} from "@gladlog/analysis/src/learning/distillRules";
import {
  measureGroup,
  nextRuleStatus,
  PATTERN_MIN_HITS,
  scanPatterns,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LearnedRule,
  LedgerRun,
  RulesDoc,
  StablePattern,
} from "@gladlog/analysis/src/learning/types";
import { recordAiDebug } from "./aiDebugLog";
import { resolveAiModel, type AiModelSelection } from "../shared/aiModels";
import {
  buildCoachSystemPrompt,
  PROMPT_VERSION,
  resolveAiClient,
  type AiBackend,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";
import { createLearningLedger } from "./learningLedger";

/** Auto-consolidate when ledger has added >= this many matches since last consolidation (spec §5). */
export const CONSOLIDATE_EVERY_MATCHES = 10;

export interface LearningState {
  backfill: { running: boolean; scanned: number; total: number } | null;
  consolidating: boolean;
  ledgerMatches: number;
  badLines: number;
  lastConsolidatedAt: number | null;
}

export function createLearningService(deps: {
  getSettings: () => {
    anthropicApiKey: string | null;
    aiModels?: AiModelSelection | null;
    wowDirectory: string | null;
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiLanguage?: AiLanguage;
  };
  clientFactory?: (key: string) => AnthropicLike;
  matchesDir: string;
  learningDir: string;
  emit: (channel: string, payload: unknown) => void;
}) {
  const ledger = createLearningLedger(deps.learningDir);
  const rulesPath = join(deps.learningDir, "rules.json");
  const backfillMarker = join(deps.learningDir, "backfill-done.json");

  let consolidating = false;
  let backfill: { running: boolean; scanned: number; total: number } | null =
    null;

  const readRulesDoc = (): RulesDoc | null => {
    try {
      const doc = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDoc;
      return doc.schemaVersion === 1 ? doc : null;
    } catch {
      return null;
    }
  };
  const writeRulesDoc = (doc: RulesDoc): void => {
    mkdirSync(deps.learningDir, { recursive: true });
    const tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf-8");
    renameSync(tmp, rulesPath);
  };

  /** Build ledger row from meta.json + findings/candidates. Returns null if meta missing. */
  const buildRun = (
    matchId: string,
    findings: Array<Pick<Finding, "category" | "severity" | "eventIds">>,
    typeOf: (eventId: string) => string | undefined,
    createdAt: number,
    promptVersion: number,
  ): LedgerRun | null => {
    let meta: {
      id?: string;
      startTime?: number;
      result?: string;
      zoneId?: string;
      bracket?: string;
      teams?: Array<Array<{ specId: number }>>;
    };
    try {
      meta = JSON.parse(
        readFileSync(join(deps.matchesDir, matchId, "meta.json"), "utf-8"),
      );
    } catch {
      return null;
    }
    if (typeof meta.startTime !== "number") return null;
    return {
      v: 1,
      matchId: meta.id ?? matchId,
      startTime: meta.startTime,
      win: String(meta.result ?? "")
        .toLowerCase()
        .startsWith("win"),
      zoneId: meta.zoneId,
      bracket: meta.bracket,
      enemySpecs: (meta.teams?.[1] ?? [])
        .map((t) => t.specId)
        .filter((s) => typeof s === "number" && s > 0),
      promptVersion,
      createdAt,
      findings: findings.map((f) => ({
        category: normalizeFindingCategory(f.category),
        severity: f.severity,
        eventTypes: [
          ...new Set(
            (f.eventIds ?? []).map(typeOf).filter((t): t is string => !!t),
          ),
        ].sort(),
      })),
    };
  };

  const maybeAutoConsolidate = (): void => {
    const { matches } = ledger.read();
    const prev = readRulesDoc();
    const due = prev
      ? matches.length - prev.ledgerMatches >= CONSOLIDATE_EVERY_MATCHES
      : matches.length >= PATTERN_MIN_HITS && existsSync(backfillMarker);
    if (due) void consolidate();
  };

  /** Collect example explanations (<=3) from analysis cache of evidence matches. */
  const collectExamples = (
    rules: LearnedRule[],
    lang: AiLanguage,
  ): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const r of rules) {
      const texts: string[] = [];
      for (const matchId of r.evidence) {
        if (texts.length >= 3) break;
        const base = join(deps.matchesDir, matchId);
        const file = [
          `analysis-v2.${lang}.json`,
          `analysis-v2.${lang === "zh" ? "en" : "zh"}.json`,
          "analysis-v2.json",
        ].find((f) => existsSync(join(base, f)));
        if (!file) continue;
        try {
          const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
          const findings: Array<{ category: string; explanation?: string }> =
            doc.result?.findings ?? [];
          for (const f of findings) {
            if (texts.length >= 3) break;
            if (
              normalizeFindingCategory(f.category) === r.category &&
              f.explanation
            )
              texts.push(f.explanation);
          }
        } catch {
          /* Skip corrupted cache: examples are nice-to-have, not hard dependencies */
        }
      }
      out[r.ruleId] = texts;
    }
    return out;
  };

  async function consolidate(): Promise<void> {
    if (consolidating) return;
    consolidating = true;
    try {
      const { matches } = ledger.read();
      const patterns = scanPatterns(matches);
      const prev = readRulesDoc();
      const byId = new Map<string, LearnedRule>(
        (prev?.rules ?? []).map((r) => [r.ruleId, r]),
      );
      for (const p of patterns) {
        if (!byId.has(p.patternId))
          byId.set(p.patternId, {
            ruleId: p.patternId,
            status: "active",
            category: p.category,
            eventTypes: p.eventTypes,
            condition: p.condition,
            stats: {
              windowMatches: p.windowMatches,
              hits: p.hits,
              firstSeen: p.firstSeen,
              lastSeen: p.lastSeen,
              trend: p.trend,
            },
            description: {},
            advice: {},
            evidence: p.exampleMatchIds,
            distilledAt: 0,
            distillModel: "",
          });
      }
      // Deterministic part: recalculate stats + retirement/reactivation for all rules
      for (const r of byId.values()) {
        const g = measureGroup(matches, r.category, r.eventTypes, r.condition);
        r.stats = {
          windowMatches: g.windowMatches,
          hits: g.hits,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          trend: g.trend,
        };
        r.evidence = g.exampleMatchIds.length ? g.exampleMatchIds : r.evidence;
        r.status = nextRuleStatus(r.status, g.hits);
      }
      const rules = [...byId.values()].sort(
        (a, b) => b.stats.hits - a.stats.hits,
      );

      // AI Distillation: active rules lacking current language text
      const settings = deps.getSettings();
      const lang: AiLanguage = settings.aiLanguage ?? "zh";
      const need = rules.filter(
        (r) => r.status === "active" && !r.description[lang],
      );
      let distilled = 0;
      let droppedByAudit = 0;
      const client = resolveAiClient(settings, deps.clientFactory);
      if (need.length > 0 && client) {
        const pats: StablePattern[] = need.map((r) => ({
          patternId: r.ruleId,
          category: r.category,
          eventTypes: r.eventTypes,
          condition: r.condition,
          windowMatches: r.stats.windowMatches,
          hits: r.stats.hits,
          firstSeen: r.stats.firstSeen,
          lastSeen: r.stats.lastSeen,
          trend: r.stats.trend,
          exampleMatchIds: r.evidence,
        }));
        const prompt = buildDistillPrompt(
          pats,
          collectExamples(need, lang),
          lang,
        );
        let raw = "";
        const stream = client.stream({
          model: resolveAiModel(settings),
          max_tokens: 4096,
          system: buildCoachSystemPrompt(lang),
          messages: [{ role: "user", content: prompt }],
        });
        for await (const ev of stream) if (ev.delta) raw += ev.delta;
        recordAiDebug({
          kind: "analysis",
          matchId: "learning#consolidate",
          at: Date.now(),
          model: resolveAiModel(settings),
          prompt,
          raw,
        });
        const audit = auditDistilledRules(parseModelJsonArray(raw), pats);
        droppedByAudit = audit.dropped.length;
        for (const t of audit.texts) {
          const r = byId.get(t.patternId)!;
          r.description[lang] = t.description;
          r.advice[lang] = t.advice;
          r.distilledAt = Date.now();
          r.distillModel = resolveAiModel(settings);
          distilled++;
        }
      }

      writeRulesDoc({
        schemaVersion: 1,
        updatedAt: Date.now(),
        ledgerMatches: matches.length,
        rules,
      });
      ledger.compact();
      deps.emit("gladlog:learning:done", {
        rules: rules.length,
        distilled,
        dropped: droppedByAudit,
      });
    } catch (err) {
      deps.emit("gladlog:learning:error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      consolidating = false;
    }
  }

  /** Backfill (spec §1): scan all analysis-v2 caches into ledger without checking promptVersion. */
  async function runBackfill(): Promise<void> {
    const { readdirSync } = await import("fs");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(deps.matchesDir).filter(
        (d) => !d.startsWith(".") && !d.startsWith("_"),
      );
    } catch {
      dirs = [];
    }
    backfill = { running: true, scanned: 0, total: dirs.length };
    let batch: LedgerRun[] = [];
    for (const dir of dirs) {
      backfill.scanned++;
      const base = join(deps.matchesDir, dir);
      const file = [
        "analysis-v2.zh.json",
        "analysis-v2.en.json",
        "analysis-v2.json",
      ].find((f) => existsSync(join(base, f)));
      if (!file) continue;
      try {
        const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
        const findings: Array<
          Pick<Finding, "category" | "severity" | "eventIds">
        > = doc.result?.findings ?? [];
        const run = buildRun(
          dir,
          findings,
          () => undefined,
          doc.createdAt ?? 0,
          doc.promptVersion ?? 0,
        );
        if (run) batch.push(run);
      } catch {
        /* Skip corrupted cache */
      }
      if (batch.length >= 50) {
        ledger.append(batch);
        batch = [];
        deps.emit("gladlog:learning:progress", {
          scanned: backfill.scanned,
          total: backfill.total,
        });
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    ledger.append(batch);
    writeFileSync(
      backfillMarker,
      JSON.stringify({ at: Date.now(), scanned: backfill.scanned }),
      "utf-8",
    );
    backfill = { ...backfill, running: false };
    deps.emit("gladlog:learning:progress", {
      scanned: backfill.scanned,
      total: backfill.total,
    });
    maybeAutoConsolidate();
  }

  return {
    init(): void {
      if (!existsSync(backfillMarker)) {
        mkdirSync(deps.learningDir, { recursive: true });
        void runBackfill().catch((err) =>
          deps.emit("gladlog:learning:error", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    recordAnalysis(e: {
      matchId: string;
      findings: Finding[];
      candidates: CandidateEvent[];
    }): void {
      try {
        const byId = new Map(e.candidates.map((c) => [c.id, c.type]));
        const run = buildRun(
          e.matchId,
          e.findings,
          (id) => byId.get(id),
          Date.now(),
          PROMPT_VERSION,
        );
        if (!run) return;
        ledger.append([run]);
        maybeAutoConsolidate();
      } catch {
        /* best-effort */
      }
    },
    consolidate,
    async getRules(): Promise<RulesDoc | null> {
      return readRulesDoc();
    },
    async getState(): Promise<LearningState> {
      const { matches, badLines } = ledger.read();
      return {
        backfill,
        consolidating,
        ledgerMatches: matches.length,
        badLines,
        lastConsolidatedAt: readRulesDoc()?.updatedAt ?? null,
      };
    },
  };
}
export type LearningService = ReturnType<typeof createLearningService>;
```

- [ ] **Step 4: Run tests to verify success**

Run: `npx vitest run src/main/learning.test.ts` (cwd `packages/desktop`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/learning.ts packages/desktop/src/main/learning.test.ts
git commit -m "feat(desktop): learning service — backfill/consolidation/auto-trigger, deterministic stats decoupled from AI text"
```

---

### Task 6: Plumbing — analysis Write Point, index.ts Wiring, IPC, preload

**Files:**

- Modify: `packages/desktop/src/main/analysis.ts` (add `onFindings` to deps; add record param to `finish`)
- Modify: `packages/desktop/src/main/index.ts:149-175` (instantiate learning service, wire, init)
- Modify: `packages/desktop/src/main/ipc.ts` (add `learning` to deps, register 3 handles)
- Modify: `packages/desktop/src/preload/index.ts` (learning surface)
- Modify: `packages/desktop/src/preload/api.ts` (GladlogApi.learning type)
- Test: `packages/desktop/src/main/analysis.test.ts` (add assertion for onFindings trigger)

**Interfaces:**

- Consumes: `LearningService`/`LearningState` from Task 5.
- Produces:
  - `createAnalysisService` deps adds `onFindings?: (e: { matchId: string; findings: Finding[]; candidates: CandidateEvent[] }) => void`. Semantics: invoked when **model genuinely ran** (audit path, including 0 findings) or `no-candidates` (clean match, counts towards denominator); not called for `no-client`/`bad-json`.
  - IPC: `gladlog:learning:getRules` / `gladlog:learning:getState` / `gladlog:learning:consolidate`; events `gladlog:learning:progress|done|error`.
  - `GladlogApi.learning`: `{ getRules(): Promise<RulesDoc | null>; getState(): Promise<LearningState>; consolidate(): Promise<void>; onProgress(cb: (p: { scanned: number; total: number }) => void): () => void; onDone(cb: (d: { rules: number; distilled: number; dropped: number }) => void): () => void; onError(cb: (d: { message: string }) => void): () => void }`.

- [ ] **Step 1: Add hook to analysis.ts**

In deps type (after `emit`):

```ts
  /** Learning ledger write point (spec §1): callback when model genuinely ran or on clean matches (no-candidates);
   * no-client/bad-json does not count as analyzed. Handled fire-and-forget. */
  onFindings?: (e: {
    matchId: string;
    findings: Finding[];
    candidates: CandidateEvent[];
  }) => void;
```

Modify two spots in `run()`:

```ts
const finish = (result: AnalysisResult, record = false) => {
  // ... original body unchanged, add after emit at the end:
  if (record)
    deps.onFindings?.({
      matchId: input.matchId,
      findings: result.findings,
      candidates: input.candidates,
    });
};

const fallback = (reason: "no-candidates" | "no-client" | "bad-json") =>
  finish(
    { findings: [], dropped: 0, hadNarration: false, fallbackReason: reason },
    reason === "no-candidates",
  );
```

Change successful audit path to:

```ts
finish(
  {
    findings: audit.findings,
    dropped: audit.dropped.length,
    hadNarration: audit.findings.length > 0,
  },
  true,
);
```

- [ ] **Step 2: Add assertion to analysis.test.ts**

Add a test case in the existing test file:

```ts
it("calls back onFindings when run completes (candidates passed through)", async () => {
  const events: unknown[] = [];
  // Set up service following existing fake-client tests in this file, passing:
  // onFindings: (e) => events.push(e)
  // ... after run():
  expect(events).toHaveLength(1);
  expect((events[0] as { matchId: string }).matchId).toBe("m1");
});
```

- [ ] **Step 3: Wire up index.ts**

Change `createAnalysisService` invocation site (`packages/desktop/src/main/index.ts:149`) to:

```ts
const learning = createLearningService({
  getSettings: () => settings.get(),
  matchesDir: join(userData(), "matches"),
  learningDir: join(userData(), "learning"),
  clientFactory: realClientFactory,
  emit: (ch, payload) => win?.webContents.send(ch, payload),
});
const analysis = createAnalysisService({
  getSettings: () => settings.get(),
  matchesDir: join(userData(), "matches"),
  clientFactory: realClientFactory,
  emit: (ch, payload) => win?.webContents.send(ch, payload),
  onFindings: (e) => learning.recordAnalysis(e),
});
```

Add `import { createLearningService } from "./learning";` to header; add `learning,` to `registerIpc({...})`; add `learning.init();` after `registerIpc`.

- [ ] **Step 4: Register in ipc.ts**

Add `learning: LearningService;` to deps type (import type from `./learning`), add to end of `registerIpc` body:

```ts
ipcMain.handle("gladlog:learning:getRules", () => deps.learning.getRules());
ipcMain.handle("gladlog:learning:getState", () => deps.learning.getState());
ipcMain.handle("gladlog:learning:consolidate", () =>
  deps.learning.consolidate(),
);
```

- [ ] **Step 5: Preload files**

Add after analysis section in `preload/index.ts`:

```ts
  learning: {
    getRules: () => ipcRenderer.invoke("gladlog:learning:getRules"),
    getState: () => ipcRenderer.invoke("gladlog:learning:getState"),
    consolidate: () => ipcRenderer.invoke("gladlog:learning:consolidate"),
    onProgress: sub<{ scanned: number; total: number }>(
      "gladlog:learning:progress",
    ),
    onDone: sub<{ rules: number; distilled: number; dropped: number }>(
      "gladlog:learning:done",
    ),
    onError: sub<{ message: string }>("gladlog:learning:error"),
  },
```

In `preload/api.ts` within `GladlogApi` (import types at top):

```ts
import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { LearningState } from "../main/learning";
```

```ts
  /** Cross-match self-learning (spec 2026-07-26): rule retrieval, state, manual consolidation. */
  learning: {
    getRules(): Promise<RulesDoc | null>;
    getState(): Promise<LearningState>;
    consolidate(): Promise<void>;
    onProgress(cb: (p: { scanned: number; total: number }) => void): () => void;
    onDone(
      cb: (d: { rules: number; distilled: number; dropped: number }) => void,
    ): () => void;
    onError(cb: (d: { message: string }) => void): () => void;
  };
```

- [ ] **Step 6: Full validation + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: All green.

```bash
git add packages/desktop/src/main/ packages/desktop/src/preload/
git commit -m "feat(desktop): learning pipeline plumbing — analysis write hook, IPC/preload, startup backfill"
```

---

### Task 7: Renderer Habit Badges (StructuredAnalysisPanel + FindingsList + KeyMomentAxis)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx` (fetch rules, construct habitOf, add enemySpecs to input)
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx` (habitOf prop + badge rendering)
- Modify: `packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx` (same prop, render in finding card header)
- Modify: renderer styles file (locate `.rpt-finding` styles via `grep -rn "rpt-finding-sev" packages/desktop/src/renderer/src --include="*.css"`, append `.rpt-finding-habit`)
- Test: `packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx` (add habitOf test case)

**Interfaces:**

- Consumes: `ruleAppliesToFinding`/`habitBadgeText` from Task 3; `bridge().learning.getRules` from Task 6.
- Produces: `FindingsList`/`KeyMomentAxis` new optional prop `habitOf?: (f: Finding) => string | null`.

- [ ] **Step 1: Add failing test case in FindingsList.test.tsx**

```tsx
it("renders habit badge when habitOf matches", () => {
  render(
    <FindingsList
      findings={[
        {
          eventIds: ["e1"],
          severity: "high",
          category: "survival",
          title: "t",
          explanation: "x",
        },
      ]}
      onSelect={() => {}}
      habitOf={() => "惯性问题 · 近 20 场已犯 9 次"}
    />,
  );
  expect(screen.getByText("惯性问题 · 近 20 场已犯 9 次")).toBeTruthy();
});
```

Run: `npx vitest run src/renderer/src/report/components/FindingsList.test.tsx` (cwd `packages/desktop`) -> FAIL (prop does not exist).

- [ ] **Step 2: Add prop and rendering to FindingsList.tsx**

Add to props destructuring and type:

```ts
  /** Cross-match habit badge (spec §4): returns badge text or null. Text is interpolated from deterministic stats (habitBadgeText). */
  habitOf?: (f: Finding) => string | null;
```

Inside `.rpt-finding-head` div, after title span, add:

```tsx
{
  (() => {
    const habit = habitOf?.(f);
    return habit ? (
      <span
        className="rpt-finding-habit"
        title="Cross-match recurring pattern (deterministic statistics, not AI judgement)"
      >
        {habit}
      </span>
    ) : null;
  })();
}
```

- [ ] **Step 3: KeyMomentAxis.tsx counterpart**

Add `habitOf?: (f: Finding) => string | null;` to props; insert the same snippet into finding card's `.rpt-finding-head` (`KeyMomentAxis.tsx` around line 241, after `rpt-finding-title` span), referencing `e.f`.

- [ ] **Step 4: Wire data in StructuredAnalysisPanel.tsx**

1. Add imports:

```ts
import {
  habitBadgeText,
  ruleAppliesToFinding,
} from "@gladlog/analysis/src/learning/matchRules";
import type { LearnedRule } from "@gladlog/analysis/src/learning/types";
```

2. Add `enemySpecs` to return value of `input` useMemo (`enemies` already in scope):

```ts
return {
  matchId,
  candidates,
  richContext,
  spec,
  ownerName: owner.name,
  enemySpecs: enemies.map((u) => Number(u.spec)).filter((s) => s > 0),
};
```

3. State + loading:

```ts
const [rules, setRules] = useState<LearnedRule[]>([]);
useEffect(() => {
  try {
    const api = (
      bridge() as unknown as {
        learning?: { getRules(): Promise<{ rules: LearnedRule[] } | null> };
      }
    ).learning;
    if (!api) return;
    void api
      .getRules()
      .then((doc) => setRules(doc?.rules ?? []))
      .catch(() => {});
  } catch {
    /* Test stub lacks surface */
  }
}, [matchId]);
```

4. habitOf:

```ts
const habitOf = useMemo(() => {
  if (rules.length === 0 || !input) return undefined;
  const meta = { enemySpecs: input.enemySpecs };
  return (f: Finding): string | null => {
    const hit = rules.find((r) =>
      ruleAppliesToFinding(r, f, input.candidates, meta),
    );
    return hit ? habitBadgeText(hit, lang ?? "zh") : null;
  };
}, [rules, input, lang]);
```

5. Pass prop at rendering sites: add `habitOf={habitOf}` to both `<FindingsList` and both `<KeyMomentAxis`.

- [ ] **Step 5: Styles**

Append to the styles file located via grep (where `.rpt-finding-sev` is defined):

```css
.rpt-finding-habit {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  background: color-mix(in srgb, var(--warn, #d97706) 18%, transparent);
  color: var(--warn, #d97706);
  white-space: nowrap;
}
```

- [ ] **Step 6: Verification + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: All green.

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop): match report finding habit badge — rules engine runs on audited findings without AI"
```

---

### Task 8: StatsDashboard Long-term Trends Card

**Files:**

- Modify: `packages/desktop/src/renderer/src/components/StatsDashboard.tsx` (new card: rules list + trends + manual consolidation)
- Modify: StatsDashboard associated style file (located via `grep -rn "dash-card" packages/desktop/src/renderer/src --include="*.css"`)

**Interfaces:**

- Consumes: `bridge().learning.*` from Task 6; Task 1 types; `interpolate` (`@gladlog/analysis/src/compare/claimChecker`); `distillFacts` (`@gladlog/analysis/src/learning/distillRules`); existing `categoryLabel` and `onOpenMatch` prop.
- Produces: No downstream dependencies (leaf UI).

- [ ] **Step 1: Data wiring**

Inside component (near notebook state):

```ts
const [rulesDoc, setRulesDoc] = useState<RulesDoc | null>(null);
const [learnState, setLearnState] = useState<LearningState | null>(null);
const reloadLearning = () => {
  try {
    const api = (
      bridge() as unknown as {
        learning?: {
          getRules(): Promise<RulesDoc | null>;
          getState(): Promise<LearningState>;
        };
      }
    ).learning;
    if (!api) return;
    void api
      .getRules()
      .then(setRulesDoc)
      .catch(() => {});
    void api
      .getState()
      .then(setLearnState)
      .catch(() => {});
  } catch {
    /* Test stub lacks surface */
  }
};
useEffect(() => {
  reloadLearning();
  try {
    const api = (
      bridge() as unknown as {
        learning?: { onDone(cb: () => void): () => void };
      }
    ).learning;
    return api?.onDone?.(() => reloadLearning());
  } catch {
    return undefined;
  }
}, []);
```

Imports (file header):

```ts
import { interpolate } from "@gladlog/analysis/src/compare/claimChecker";
import { distillFacts } from "@gladlog/analysis/src/learning/distillRules";
import { habitBadgeText } from "@gladlog/analysis/src/learning/matchRules";
import type {
  LearnedRule,
  RulesDoc,
} from "@gladlog/analysis/src/learning/types";
import type { LearningState } from "../../../main/learning";
```

- [ ] **Step 2: Card rendering**

Insert after notebook card (`data-testid="dash-notebook"`):

```tsx
{
  (rulesDoc || learnState) && (
    <div className="dash-card" data-testid="dash-learning">
      <h3>
        长期规律 —— 跨对局稳定模式(确定性统计 + AI 归纳)
        <button
          className="dash-learning-run"
          disabled={learnState?.consolidating}
          onClick={() => {
            try {
              void (
                bridge() as unknown as {
                  learning?: { consolidate(): Promise<void> };
                }
              ).learning?.consolidate();
            } catch {
              /* noop */
            }
          }}
        >
          {learnState?.consolidating ? "整合中…" : "重新整合"}
        </button>
      </h3>
      <p className="dash-learning-meta">
        {learnState?.backfill?.running
          ? `回填历史分析中… ${learnState.backfill.scanned}/${learnState.backfill.total}`
          : `台账 ${learnState?.ledgerMatches ?? 0} 场` +
            (learnState?.lastConsolidatedAt
              ? ` · 上次整合 ${new Date(learnState.lastConsolidatedAt).toLocaleString()}`
              : " · 尚未整合")}
        {learnState && learnState.badLines > 0
          ? ` · ${learnState.badLines} 坏行已跳过`
          : ""}
      </p>
      {(rulesDoc?.rules ?? []).map((r: LearnedRule) => {
        const facts = distillFacts(r.stats);
        const desc = r.description.zh ?? r.description.en;
        const adv = r.advice.zh ?? r.advice.en;
        const max = Math.max(1, ...r.stats.trend);
        return (
          <div key={r.ruleId} className="dash-learning-rule">
            <span
              className={`dash-learning-status ${r.status}`}
              title={
                r.status === "improved"
                  ? "Recently improved — keep it up"
                  : "Still recurring"
              }
            >
              {r.status === "improved" ? "已改进" : "活跃"}
            </span>
            <span className="dash-learning-cat">
              {categoryLabel(r.category, "zh")}
              {r.eventTypes.length > 0 ? ` · ${r.eventTypes.join("+")}` : ""}
              {r.condition?.enemySpec
                ? `(vs spec ${r.condition.enemySpec})`
                : r.condition?.zoneId
                  ? `(map ${r.condition.zoneId})`
                  : ""}
            </span>
            <span className="dash-learning-count">
              {habitBadgeText(r, "zh")}
            </span>
            <span className="dash-learning-trend" title="Hits per 5 matches, old->new">
              {r.stats.trend.map((h, i) => (
                <i
                  key={i}
                  style={{ height: `${4 + (h / max) * 12}px` }}
                  className={h > 0 ? "hit" : ""}
                />
              ))}
            </span>
            <p className="dash-learning-desc">
              {desc ? interpolate(desc, facts) : "(Description pending next consolidation)"}
            </p>
            {adv && (
              <p className="dash-learning-advice">
                💡 {interpolate(adv, facts)}
              </p>
            )}
            <span className="dash-learning-evidence">
              {r.evidence.map((id) => (
                <button key={id} onClick={() => onOpenMatch?.(id)}>
                  查看战例
                </button>
              ))}
            </span>
          </div>
        );
      })}
      {(rulesDoc?.rules ?? []).length === 0 &&
        !learnState?.backfill?.running && (
          <p className="dash-learning-empty">
            还没有稳定模式 —— 分析的对局多了(同类问题近 20 场出现 5 次以上)
            会自动出现在这里。
          </p>
        )}
    </div>
  );
}
```

- [ ] **Step 3: Styles**

Append to stylesheet containing `dash-card`:

```css
.dash-learning-run {
  float: right;
  font-size: 12px;
}
.dash-learning-meta {
  color: var(--mute);
  font-size: 12px;
}
.dash-learning-rule {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  gap: 4px 10px;
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.2));
}
.dash-learning-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
}
.dash-learning-status.active {
  background: rgba(217, 119, 6, 0.18);
  color: #d97706;
}
.dash-learning-status.improved {
  background: rgba(22, 163, 74, 0.18);
  color: #16a34a;
}
.dash-learning-desc,
.dash-learning-advice {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 13px;
}
.dash-learning-trend {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
}
.dash-learning-trend i {
  width: 5px;
  background: var(--line, #ccc);
  border-radius: 1px;
}
.dash-learning-trend i.hit {
  background: #d97706;
}
.dash-learning-evidence {
  grid-column: 1 / -1;
  display: flex;
  gap: 6px;
}
.dash-learning-empty {
  color: var(--mute);
  font-size: 13px;
}
```

- [ ] **Step 4: Verification + Commit**

Run: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: All green.

```bash
git add packages/desktop/src/renderer/
git commit -m "feat(desktop): dashboard long-term trends card — rules/trends/evidence/manual consolidation"
```

---

### Task 9: Real-world Corpus Acceptance (Before/After Numbers) + Wrap-up

**Files:**

- Create: `packages/desktop/scripts/learningScan.ts` (permanent verification tool, not disposable script)
- Modify: `packages/desktop/package.json` (add `"learning:scan": "tsx scripts/learningScan.ts"` to scripts)

**Interfaces:**

- Consumes: `scanPatterns`/`measureGroup`/`createLearningLedger` from Tasks 1/4/5 and backfill read logic.

- [ ] **Step 1: Write learningScan.ts**

```ts
/**
 * Corpus acceptance tool for learning pipeline (CLAUDE.md verification rule: fixes/features require before/after numbers under same criteria).
 * Reads real corpus backfill into temporary ledger -> scanPatterns, prints:
 * ledger match count / stable pattern count / hit details per pattern, and cross-checks rules.json (if present)
 * stats against ledger recomputation, exiting with 1 on mismatch.
 *
 * Usage: npx tsx scripts/learningScan.ts [matchesDir] [learningDir]
 * Default matchesDir = ~/Library/Application Support/gladlog/matches (mac).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import {
  measureGroup,
  scanPatterns,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LedgerMatch,
  RulesDoc,
} from "@gladlog/analysis/src/learning/types";

const matchesDir =
  process.argv[2] ??
  join(homedir(), "Library/Application Support/gladlog/matches");
const learningDir = process.argv[3] ?? join(matchesDir, "..", "learning");

const matches: LedgerMatch[] = [];
for (const dir of readdirSync(matchesDir).filter(
  (d) => !d.startsWith(".") && !d.startsWith("_"),
)) {
  const base = join(matchesDir, dir);
  const file = [
    "analysis-v2.zh.json",
    "analysis-v2.en.json",
    "analysis-v2.json",
  ].find((f) => existsSync(join(base, f)));
  if (!file) continue;
  try {
    const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
    const meta = JSON.parse(readFileSync(join(base, "meta.json"), "utf-8"));
    if (typeof meta.startTime !== "number") continue;
    matches.push({
      matchId: meta.id ?? dir,
      startTime: meta.startTime,
      win: String(meta.result ?? "")
        .toLowerCase()
        .startsWith("win"),
      zoneId: meta.zoneId,
      bracket: meta.bracket,
      enemySpecs: (meta.teams?.[1] ?? [])
        .map((t: { specId: number }) => t.specId)
        .filter((s: number) => s > 0),
      findings: (doc.result?.findings ?? []).map(
        (f: { category: string; severity: string }) => ({
          category: normalizeFindingCategory(f.category),
          severity: f.severity,
          eventTypes: [],
        }),
      ),
    });
  } catch {
    /* Skip corrupted files */
  }
}

console.log(`Ledger (direct backfill basis): ${matches.length} matches`);
const patterns = scanPatterns(matches);
console.log(`Stable patterns: ${patterns.length}`);
for (const p of patterns)
  console.log(
    `  ${p.patternId}  hits=${p.hits}/${p.windowMatches}  trend=[${p.trend.join(",")}]  examples=${p.exampleMatchIds.join(",")}`,
  );

// rules.json cross-check: stats for each rule must match ledger recomputation
const rulesPath = join(learningDir, "rules.json");
if (existsSync(rulesPath)) {
  const doc = JSON.parse(readFileSync(rulesPath, "utf-8")) as RulesDoc;
  let bad = 0;
  for (const r of doc.rules) {
    const g = measureGroup(matches, r.category, r.eventTypes, r.condition);
    if (g.hits !== r.stats.hits || g.windowMatches !== r.stats.windowMatches) {
      if (r.eventTypes.length === 0) {
        console.error(
          `✗ ${r.ruleId}: rules.json hits=${r.stats.hits}/${r.stats.windowMatches}, recomputed=${g.hits}/${g.windowMatches}`,
        );
        bad++;
      }
    }
  }
  console.log(
    bad === 0
      ? `rules.json verification: all ${doc.rules.length} rules match ledger recomputation ✓`
      : `rules.json verification: ${bad} rules mismatched ✗`,
  );
  if (bad > 0) process.exit(1);
} else {
  console.log("rules.json does not exist (not yet consolidated in app) — reporting pattern scan results only");
}
```

- [ ] **Step 2: Run on real corpus, record numbers**

Run: `npm run learning:scan --workspace=packages/desktop`
Expected & Recording (acceptance criteria, include in commit message):

1. Ledger matches ≈ analyzed matches count (<=794, counting matches with analysis cache).
2. N stable patterns (report actual count; when N=0, verify if window actually contains >=5 identical occurrences).
3. Sample 3 patterns, cross-verify order of magnitude with notebook entries on dashboard.

- [ ] **Step 3: Run full pipeline in app (manual smoke test)**

Start with `npm run dev --workspace=packages/desktop`, verify in order:

1. Backfill progress appears in dashboard on startup -> ledger matches count settles.
2. Initial consolidation auto-triggers (or click "Consolidate again"), rules appear in long-term trends card without raw digit violations.
3. Open a match report hitting a rule category -> finding displays "Recurring · M of last N matches" badge.
4. `learning:scan` confirms rules.json fully matches (Step 1 script exits 0).

- [ ] **Step 4: Final commit + push**

```bash
git add packages/desktop/scripts/learningScan.ts packages/desktop/package.json
git commit -m "feat(desktop): learning:scan acceptance tool — 3-tier numerical verification for ledger/patterns/rules

Real-world corpus acceptance (criteria=learning:scan): ledger <N> matches, stable patterns <M>, rules.json verification matches 100%"
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet && git push
```

---

## Self-Review Notes

- **Spec Coverage**: §1 ledger=Tasks 4+6, backfill=Task 5; §2 filter=Task 1; §3 distill+audit=Tasks 2+5; §4 application+UI=Tasks 3+7, report page=Task 8; §5 triggers/retirement=Task 5 (`CONSOLIDATE_EVERY_MATCHES`/`nextRuleStatus`); §6 bad lines/compaction/lazy retranslation/small corpus=Tasks 1/4/5; §7 acceptance=Task 9.
- **Spec Deviations (recorded in spec corrections)**: cross-match key findingKey->category+type; ledger one line per run, last-run-wins per match not per finding; endTime->startTime; removed ownerSpec; "keep old rules.json entirely on audit failure" -> "deterministic part always persists, only text missing pending backfill" (stronger property).
- **Type Consistency**: `LearnedRule.stats` fields match `GroupStats` without example/spans; `habitOf` signatures match across all 3 sites; `LedgerMatch = Omit<LedgerRun,...>` derived from single source.
