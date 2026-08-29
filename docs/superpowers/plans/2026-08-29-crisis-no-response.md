# crisis-no-response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a healer-only candidate `crisis-no-response` — "your HP crossed ≤40%, you were free to act, and you did nothing for 3 s" — rendered with a corpus-derived reference ("top-10% healers in this bracket/state respond X%: self-heal a%, wall b%, control c%"), with the decision-point predicate shared between analysis and the eval scan, and a prompt-quality gate that re-checks every rendered reference number against the table.

**Architecture:** One pure predicate module (`crisisDecisionPoints.ts`) produces decision points with responses + feasibility gates; the eval scan (`behaviorPriorScan.ts`) consumes it to build `behaviorPriorGenerated.json` (top-10% response distribution per bracket × dmg bin, n≥50 fallback); the producer (`candidates/crisisNoResponse.ts`) emits ≤2 events/round from the same decision points and looks the reference up via `lookupBehaviorPrior`; the gate imports the same lookup and re-parses the prompt.

**Tech Stack:** TypeScript (ESM), vitest, `@gladlog/parser-compat` legacy unit shape, tsx scripts. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-crisis-no-response-design.md`

## Global Constraints

- Shared-predicate rule (CLAUDE.md): analysis and eval consume `crisisDecisionPoints` and `lookupBehaviorPrior` from `packages/analysis`; the eval side never re-implements either. `CRISIS_HP_PCT` / `CRISIS_WINDOW_GAP_MS` move to analysis; eval imports them.
- Verification rule: every "done" claim carries before/after numbers under the same criterion (candidate counts per type over the same manifest; prompt hashes).
- Value gate (CLAUDE.md §Value-Gate #1): after Task 7 the FIRST thing shown to the user is three complete real-match prompts + model outputs. No calibration or A/B before approval.
- `type: "crisis-no-response"`; id pattern `` `crisis-no-response:${owner.id}:${Math.round(tSec)}` ``; `CRISIS_NO_RESPONSE_CAP = 2` per round; ordering `enemyBurst desc, attackers2s desc, dmg2s desc` — never by outcome.
- Reference population = percentile ≥ 90 within (bracket, ISO week); table cell key `` `${bracket}|healer|${dmgBin}` `` with `dmgBin ∈ {"<10%","10-20%",">=20%","*"}`; fallback to `"*"` when `n < 50` (`BEHAVIOR_PRIOR_N_FLOOR = 50`).
- Facts are strings; numbers formatted with `fmtFactNum` (`factFormat.ts`) for seconds, plain integers for percentages (`"88"` not `"0.88"`).
- Typecheck: `npm run typecheck` (never `tsc -b`). Lint from repo root: `npx eslint .`. Before push: `npm run presubmit`.
- Bilingual docs: `packages/analysis/README.md` + `.zh-CN.md`, `docs/predicate-index.md` + `.zh-CN.md` change together.
- Commit directly to `main` (user workflow), one commit per task; commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01341LMJHyU7sEzDzBJCmMhA`.
- Machine hygiene: corpus scans run with `nice -n 10`, ≤3 shards, never more.

---

## File map

| File                                                                                 | Responsibility                                                                                 |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `packages/analysis/src/analysis/crisisDecisionPoints.ts` (new)                       | Constants + `crisisDecisionPoints(owner, combat)` + response labels + feasibility gates. Pure. |
| `packages/analysis/src/analysis/crisisDecisionPoints.test.ts` (new)                  | Synthetic-unit tests for crossings, gates, responses.                                          |
| `packages/analysis/src/data/behaviorPriorGenerated.json` (new, generated)            | Reference table.                                                                               |
| `packages/analysis/src/data/behaviorPrior.ts` (new)                                  | `lookupBehaviorPrior`, `BEHAVIOR_PRIOR_N_FLOOR`, `dmgBinOf`, types.                            |
| `packages/analysis/src/data/behaviorPrior.test.ts` (new)                             | Lookup + fallback + table-health test.                                                         |
| `packages/analysis/src/analysis/candidates/crisisNoResponse.ts` (new)                | Producer `crisisNoResponseEvents`.                                                             |
| `packages/analysis/src/analysis/candidates/crisisNoResponse.test.ts` (new)           | Producer tests.                                                                                |
| `packages/analysis/src/analysis/candidateFindings.ts`                                | Re-export, wiring in `teamPlayEvents`, `precededBy` marking.                                   |
| `packages/analysis/src/analysis/buildFindingsPrompt.ts`                              | Legend.                                                                                        |
| `packages/eval/src/explore/behaviorPriorTable.ts` (new)                              | `buildBehaviorPriorTable(rows)` pure aggregation.                                              |
| `packages/eval/test/behaviorPriorTable.test.ts` (new)                                | Aggregation tests.                                                                             |
| `packages/eval/scripts/behaviorPriorScan.ts`                                         | Consume shared predicate; `--emit-table`.                                                      |
| `packages/eval/src/explore/signalSkillGradient.ts`                                   | Import constants from analysis; new denominator.                                               |
| `packages/eval/src/quality/promptQualityCheck.ts`                                    | `checkBehaviorPriorConsistency`.                                                               |
| `packages/eval/test/promptQuality.test.ts`                                           | Gate tests.                                                                                    |
| `packages/desktop/src/renderer/src/report/derive/mistakes.ts`, `findingDisplay.ts`   | Rule + label + detail.                                                                         |
| `packages/desktop/src/shared/promptVersion.ts`                                       | `PROMPT_VERSION` 36 → 37.                                                                      |
| `docs/predicate-index.md` + `.zh-CN.md`, `packages/eval/test/predicateIndex.test.ts` | Two rows + import pins.                                                                        |
| `packages/analysis/README.md` + `.zh-CN.md`                                          | Type list 16 → 17.                                                                             |
| `docs/commands/update-wow-data.md`                                                   | Step 6b-pre-2: regenerate the table.                                                           |

---

### Task 1: Shared decision-point predicate

**Files:**

- Create: `packages/analysis/src/analysis/crisisDecisionPoints.ts`
- Create: `packages/analysis/src/analysis/crisisDecisionPoints.test.ts`
- Modify: `packages/eval/src/explore/signalSkillGradient.ts:129-132` (constants become re-exports)

**Interfaces:**

- Produces:

  ```ts
  export const CRISIS_HP_PCT = 0.4;
  export const CRISIS_WINDOW_GAP_MS = 5000;
  export const RESPONSE_WINDOW_MS = 3000;
  export const RESPONSE_PRE_MS = 1500;
  export const DMG_WINDOW_MS = 2000;
  export const ENEMY_BURST_LOOKBACK_MS = 8000;
  export const LOCKOUT_LOOKBACK_MS = 1500;
  export const SELF_HEAL_BIG = 0.15;
  export const KITE_GAIN_YARDS = 8;
  export interface DecisionPoint {
    tMs: number;
    tSec: number;
    hpPct: number;
    dmg2s: number;
    attackers2s: number;
    enemyBurst: boolean;
    inCC: boolean;
    lockedOut: boolean;
    diedInWindow: boolean;
    responses: {
      selfHeal: boolean;
      wall: boolean;
      external: boolean;
      control: boolean;
      peel: boolean;
      kite: boolean;
    };
    responded: boolean;
    selfHealPct: number;
    /** all four feasibility gates pass */ feasible: boolean;
  }
  export function crisisDecisionPoints(
    owner: any,
    combat: any,
  ): DecisionPoint[];
  ```

- [ ] **Step 1: Write the failing tests**

`packages/analysis/src/analysis/crisisDecisionPoints.test.ts`:

```ts
import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";
import { describe, expect, it } from "vitest";

import {
  CRISIS_HP_PCT,
  crisisDecisionPoints,
  RESPONSE_WINDOW_MS,
} from "./crisisDecisionPoints";

const T0 = 1_000_000;
const hp = (t: number, cur: number, max = 100, x = 0, y = 0) => ({
  timestamp: T0 + t,
  advancedActorCurrentHp: cur,
  advancedActorMaxHp: max,
  advancedActorPositionX: x,
  advancedActorPositionY: y,
});
function unit(over: Record<string, unknown> = {}) {
  return {
    id: "H",
    name: "Heals-R",
    reaction: CombatUnitReaction.Friendly,
    info: { teamId: "0" },
    advancedActions: [hp(0, 100), hp(1000, 70), hp(2000, 38), hp(3000, 35)],
    damageIn: [
      {
        timestamp: T0 + 1500,
        srcUnitId: "E1",
        amount: -30,
        effectiveAmount: -30,
      },
    ],
    healIn: [],
    healOut: [],
    spellCastEvents: [],
    auraEvents: [],
    actionIn: [],
    deathRecords: [],
    ...over,
  };
}
function combat(owner: any, others: any[] = []) {
  const units: Record<string, any> = { [owner.id]: owner };
  for (const u of others) units[u.id] = u;
  return {
    startTime: T0,
    endTime: T0 + 60_000,
    units,
    startInfo: { bracket: "3v3" },
  };
}
const enemy = (id = "E1", extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  reaction: CombatUnitReaction.Hostile,
  info: { teamId: "1" },
  spellCastEvents: [],
  advancedActions: [],
  ...extra,
});

describe("crisisDecisionPoints", () => {
  it("emits one point at the downward crossing of CRISIS_HP_PCT with dmg2s and attackers", () => {
    const o = unit();
    const pts = crisisDecisionPoints(o, combat(o, [enemy()]));
    expect(pts).toHaveLength(1);
    expect(pts[0]!.hpPct).toBe(38);
    expect(pts[0]!.tSec).toBe(2);
    expect(pts[0]!.dmg2s).toBe(0.3);
    expect(pts[0]!.attackers2s).toBe(1);
    expect(CRISIS_HP_PCT).toBe(0.4);
  });

  it("merges a second crossing inside CRISIS_WINDOW_GAP_MS, keeps one after it", () => {
    const o = unit({
      advancedActions: [
        hp(0, 100),
        hp(1000, 38),
        hp(2000, 45),
        hp(3000, 39),
        hp(9000, 60),
        hp(10000, 30),
      ],
    });
    expect(crisisDecisionPoints(o, combat(o))).toHaveLength(2);
  });

  it("selfHeal response: owner heals self ≥15% maxHP inside the window", () => {
    const o = unit({
      healIn: [
        {
          timestamp: T0 + 2500,
          srcUnitId: "H",
          amount: 20,
          effectiveAmount: 20,
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.responses.selfHeal).toBe(true);
    expect(p.selfHealPct).toBe(20);
    expect(p.responded).toBe(true);
  });

  it("wall response counts only bigDefensiveSpellIds (Desperate Prayer yes, Divine Hymn no)", () => {
    const yes = unit({
      spellCastEvents: [{ timestamp: T0 + 2500, spellId: "19236" }],
    });
    const no = unit({
      spellCastEvents: [{ timestamp: T0 + 2500, spellId: "64843" }],
    });
    expect(crisisDecisionPoints(yes, combat(yes))[0]!.responses.wall).toBe(
      true,
    );
    expect(crisisDecisionPoints(no, combat(no))[0]!.responses.wall).toBe(false);
  });

  it("control response: owner casts a CC / root / interrupt on an enemy", () => {
    const o = unit({
      spellCastEvents: [
        { timestamp: T0 + 2800, spellId: "8122", destUnitId: "E1" },
      ],
    }); // Psychic Scream
    expect(
      crisisDecisionPoints(o, combat(o, [enemy()]))[0]!.responses.control,
    ).toBe(true);
  });

  it("peel: a teammate casts CC on the owner's attacker (does not count as responded)", () => {
    const mate = {
      ...enemy("M1"),
      reaction: CombatUnitReaction.Friendly,
      info: { teamId: "0" },
      spellCastEvents: [
        { timestamp: T0 + 2600, spellId: "8122", destUnitId: "E1" },
      ],
    };
    const o = unit();
    const p = crisisDecisionPoints(o, combat(o, [enemy(), mate]))[0]!;
    expect(p.responses.peel).toBe(true);
    expect(p.responded).toBe(false);
  });

  it("kite: distance to nearest attacker grows ≥ 8 yd over the window", () => {
    const o = unit({
      advancedActions: [
        hp(0, 100, 100, 0, 0),
        hp(1000, 70, 100, 0, 0),
        hp(2000, 38, 100, 0, 0),
        hp(5000, 35, 100, 12, 0),
      ],
    });
    const e = enemy("E1", {
      advancedActions: [hp(2000, 100, 100, 1, 0), hp(5000, 100, 100, 1, 0)],
    });
    expect(crisisDecisionPoints(o, combat(o, [e]))[0]!.responses.kite).toBe(
      true,
    );
  });

  it("gate 1: crossing inside enemy hard CC → inCC=true, feasible=false", () => {
    const o = unit({
      auraEvents: [
        {
          timestamp: T0 + 1200,
          spellId: "408",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_APPLIED" },
        },
        {
          timestamp: T0 + 6000,
          spellId: "408",
          srcUnitId: "E1",
          destUnitId: "H",
          auraType: "DEBUFF",
          logLine: { event: "SPELL_AURA_REMOVED" },
        },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.inCC).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("gate 2: SPELL_INTERRUPT on the owner ≤1.5s before the crossing → lockedOut", () => {
    const o = unit({
      actionIn: [
        { timestamp: T0 + 1000, logLine: { event: LogEvent.SPELL_INTERRUPT } },
      ],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.lockedOut).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("gate 4: owner dies before t+3s → diedInWindow, feasible=false", () => {
    const o = unit({
      deathRecords: [{ timestamp: T0 + 2000 + RESPONSE_WINDOW_MS - 1 }],
    });
    const p = crisisDecisionPoints(o, combat(o))[0]!;
    expect(p.diedInWindow).toBe(true);
    expect(p.feasible).toBe(false);
  });

  it("enemyBurst: an enemy offensive major CD cast within 8s before the crossing", () => {
    const e = enemy("E1", {
      spellCastEvents: [{ timestamp: T0 + 500, spellId: "31884" }],
    }); // Avenging Wrath
    const o = unit();
    expect(crisisDecisionPoints(o, combat(o, [e]))[0]!.enemyBurst).toBe(true);
  });

  it("no advanced HP samples → no points", () => {
    const o = unit({ advancedActions: [] });
    expect(crisisDecisionPoints(o, combat(o))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run packages/analysis/src/analysis/crisisDecisionPoints.test.ts`
Expected: FAIL — `Cannot find module './crisisDecisionPoints'`.

- [ ] **Step 3: Implement the module**

`packages/analysis/src/analysis/crisisDecisionPoints.ts`:

```ts
/**
 * Crisis decision points — the ONE predicate behind `crisis-no-response`
 * (candidates/crisisNoResponse.ts) and the behavior-prior corpus scan
 * (packages/eval/scripts/behaviorPriorScan.ts). Both sides must consume this
 * module: the product says "you did not respond", the table says "top-10%
 * players respond X% here" — same crossing, same window, same response
 * taxonomy, or the two numbers are not comparable (CLAUDE.md shared-predicate
 * rule). Changing anything in here REQUIRES regenerating
 * data/behaviorPriorGenerated.json (spec §2 red line).
 *
 * Design: docs/superpowers/specs/2026-08-29-crisis-no-response-design.md.
 * Evidence: eval-private/reports/behavior-prior-2026-08-28/ (18,134 matches).
 */
import { CombatUnitReaction, LogEvent } from "@gladlog/parser-compat";

import { classMetadata } from "../data/classSpells";
import spellIdLists from "../data/spellIdLists";
import {
  ccSpellIds,
  rootSpellIds,
  spells as spellMeta,
} from "../data/spellTags";
import { SpellTag } from "../data/spellTypes";

/** A friendly at or below this HP fraction opens a "crisis" (moved here from
 * packages/eval/src/explore/signalSkillGradient.ts, which now re-exports). */
export const CRISIS_HP_PCT = 0.4;
/** Two crossings closer than this belong to the same crisis. */
export const CRISIS_WINDOW_GAP_MS = 5000;
/** The response window after the crossing — user-ruled 3 s (2026-08-29). */
export const RESPONSE_WINDOW_MS = 3000;
/** A response landed just before the sampled crossing still counts. */
export const RESPONSE_PRE_MS = 1500;
export const DMG_WINDOW_MS = 2000;
export const ENEMY_BURST_LOOKBACK_MS = 8000;
/** Gate 2: an interrupt landing on the owner this close before the crossing
 * means the school is locked — handed to `kick-eaten`, never double-charged. */
export const LOCKOUT_LOOKBACK_MS = 1500;
export const SELF_HEAL_BIG = 0.15;
export const KITE_GAIN_YARDS = 8;
const POS_TOLERANCE_MS = 1500;
const ATTACKER_POS_TOLERANCE_MS = 2500;

export interface DecisionPointResponses {
  selfHeal: boolean;
  wall: boolean;
  external: boolean;
  control: boolean;
  peel: boolean;
  kite: boolean;
}
export interface DecisionPoint {
  tMs: number;
  tSec: number;
  hpPct: number;
  dmg2s: number;
  attackers2s: number;
  enemyBurst: boolean;
  inCC: boolean;
  lockedOut: boolean;
  diedInWindow: boolean;
  responses: DecisionPointResponses;
  /** owner's own active answer: selfHeal ∨ wall ∨ external ∨ control ∨ kite
   * (peel is a teammate's action — rendered, never credited to the owner) */
  responded: boolean;
  selfHealPct: number;
  /** gates 1, 2 and 4 all pass (gate 3, "has a tool", is trivially true for a
   * healer — v1 is healer-only, spec §2) */
  feasible: boolean;
}

const PERSONAL_WALL_IDS = new Set<string>(
  spellIdLists.bigDefensiveSpellIds.map(String),
);
const EXTERNAL_IDS = new Set<string>(
  spellIdLists.externalDefensiveSpellIds.map(String),
);
const OFFENSIVE_CD_IDS = new Set<string>(
  classMetadata.flatMap((c: any) =>
    (c.abilities ?? [])
      .filter((a: any) => (a.tags ?? []).includes(SpellTag.Offensive))
      .map((a: any) => String(a.spellId)),
  ),
);
/** "stop the damage" tools the owner can point at an enemy */
const CONTROL_IDS = new Set<string>([
  ...ccSpellIds,
  ...rootSpellIds,
  ...Object.entries(spellMeta)
    .filter(([, m]) => m.type === "interrupts")
    .map(([id]) => id),
]);
/** silence-type auras also lock the school (typed `interrupts` in spellTags) */
const SILENCE_IDS = new Set<string>(
  Object.entries(spellMeta)
    .filter(([, m]) => m.type === "interrupts")
    .map(([id]) => id),
);

interface Sample {
  t: number;
  hp: number;
  max: number;
  x: number | null;
  y: number | null;
}

function samplesOf(u: any): Sample[] {
  return ((u?.advancedActions ?? []) as any[])
    .filter((a) => (a.advancedActorMaxHp ?? 0) > 0)
    .map((a) => ({
      t: a.timestamp,
      hp: a.advancedActorCurrentHp / a.advancedActorMaxHp,
      max: a.advancedActorMaxHp,
      x: a.advancedActorPositionX ?? null,
      y: a.advancedActorPositionY ?? null,
    }))
    .sort((a, b) => a.t - b.t);
}

function nearestSample(
  samples: Sample[],
  t: number,
  tol: number,
): Sample | null {
  let best: Sample | null = null;
  for (const s of samples) {
    const d = Math.abs(s.t - t);
    if (d <= tol && (!best || d < Math.abs(best.t - t))) best = s;
  }
  return best;
}

export function crisisDecisionPoints(owner: any, combat: any): DecisionPoint[] {
  const start: number = combat?.startTime ?? 0;
  const samples = samplesOf(owner);
  if (samples.length < 2) return [];

  const crossings: Sample[] = [];
  let last = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!,
      c = samples[i]!;
    if (p.hp > CRISIS_HP_PCT && c.hp <= CRISIS_HP_PCT && c.hp > 0) {
      if (c.t - last > CRISIS_WINDOW_GAP_MS) crossings.push(c);
      last = c.t;
    }
  }
  if (!crossings.length) return [];

  const units: any[] = Object.values(combat?.units ?? {});
  const players = units.filter((u) => u.info);
  const friendIds = new Set(
    players.filter((u) => u.reaction === owner.reaction).map((u) => u.id),
  );
  const unitById = new Map(units.map((u) => [u.id, u]));
  const enemySamples = new Map<string, Sample[]>();

  const dmgIn = ((owner.damageIn ?? []) as any[]).map((d) => ({
    t: d.timestamp,
    src: d.srcUnitId,
    a: Math.abs(d.effectiveAmount ?? d.amount ?? 0),
  }));
  const healIn = ((owner.healIn ?? []) as any[]).map((h) => ({
    t: h.timestamp,
    src: h.srcUnitId,
    a: Math.abs(h.effectiveAmount ?? h.amount ?? 0),
  }));
  const ownerCasts = ((owner.spellCastEvents ?? []) as any[]).map((c) => ({
    t: c.timestamp,
    id: String(c.spellId ?? ""),
    dest: c.destUnitId,
  }));
  const deaths = ((owner.deathRecords ?? []) as any[]).map(
    (d) => d.timestamp as number,
  );
  const interruptsOnOwner = ((owner.actionIn ?? []) as any[])
    .filter((a) => a.logLine?.event === LogEvent.SPELL_INTERRUPT)
    .map((a) => a.timestamp as number);

  // enemy hard-CC and silence intervals on the owner
  const cc: { from: number; to: number }[] = [];
  const silence: { from: number; to: number }[] = [];
  const open = new Map<string, number>();
  const auras = ((owner.auraEvents ?? []) as any[])
    .filter(
      (e) =>
        e.destUnitId === owner.id &&
        (ccSpellIds.has(String(e.spellId)) ||
          SILENCE_IDS.has(String(e.spellId))),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const e of auras) {
    const sid = String(e.spellId);
    const key = `${e.srcUnitId}:${sid}`;
    const ev = e.logLine?.event;
    if (ev === "SPELL_AURA_APPLIED") open.set(key, e.timestamp);
    else if (ev === "SPELL_AURA_REMOVED" && open.has(key)) {
      (ccSpellIds.has(sid) ? cc : silence).push({
        from: open.get(key)!,
        to: e.timestamp,
      });
      open.delete(key);
    }
  }
  for (const [key, from] of open) {
    const sid = key.split(":")[1]!;
    (ccSpellIds.has(sid) ? cc : silence).push({ from, to: from + 8000 });
  }

  const enemyBurstCasts: number[] = [];
  const friendControlCasts: { t: number; dest: string }[] = [];
  for (const u of players) {
    for (const c of (u.spellCastEvents ?? []) as any[]) {
      const sid = String(c.spellId ?? "");
      if (!friendIds.has(u.id) && OFFENSIVE_CD_IDS.has(sid))
        enemyBurstCasts.push(c.timestamp);
      if (friendIds.has(u.id) && u.id !== owner.id && CONTROL_IDS.has(sid))
        friendControlCasts.push({ t: c.timestamp, dest: c.destUnitId });
    }
  }

  const out: DecisionPoint[] = [];
  for (const x of crossings) {
    const t = x.t;
    const w0 = t - RESPONSE_PRE_MS,
      w1 = t + RESPONSE_WINDOW_MS;
    const inWin = (tt: number) => tt >= w0 && tt <= w1;
    const recent = dmgIn.filter((d) => d.t > t - DMG_WINDOW_MS && d.t <= t);
    const attackers = new Set(recent.map((d) => d.src));
    const dmg2s = recent.reduce((n, d) => n + d.a, 0) / x.max;
    const castsIn = ownerCasts.filter((c) => inWin(c.t));
    const selfHeal =
      healIn
        .filter((h) => h.t > t && h.t <= w1 && h.src === owner.id)
        .reduce((n, h) => n + h.a, 0) / x.max;

    let kite = false;
    const p0 = nearestSample(samples, t, POS_TOLERANCE_MS),
      p1 = nearestSample(samples, w1, POS_TOLERANCE_MS);
    if (p0?.x != null && p1?.x != null && attackers.size) {
      const near = (p: Sample, tt: number) => {
        let m = Infinity;
        for (const id of attackers) {
          const u = unitById.get(id);
          if (!u) continue;
          if (!enemySamples.has(id)) enemySamples.set(id, samplesOf(u));
          const q = nearestSample(
            enemySamples.get(id)!,
            tt,
            ATTACKER_POS_TOLERANCE_MS,
          );
          if (q?.x != null)
            m = Math.min(m, Math.hypot(p.x! - q.x, p.y! - q.y!));
        }
        return m;
      };
      const d0 = near(p0, t),
        d1 = near(p1, w1);
      kite = isFinite(d0) && isFinite(d1) && d1 - d0 >= KITE_GAIN_YARDS;
    }

    const responses: DecisionPointResponses = {
      selfHeal: selfHeal >= SELF_HEAL_BIG,
      wall: castsIn.some((c) => PERSONAL_WALL_IDS.has(c.id)),
      external: castsIn.some((c) => EXTERNAL_IDS.has(c.id)),
      control: castsIn.some(
        (c) => CONTROL_IDS.has(c.id) && c.dest && !friendIds.has(c.dest),
      ),
      peel: friendControlCasts.some((c) => inWin(c.t) && attackers.has(c.dest)),
      kite,
    };
    const inCC = cc.some((i) => i.from <= t && i.to >= t);
    const lockedOut =
      interruptsOnOwner.some(
        (it) => it >= t - LOCKOUT_LOOKBACK_MS && it <= t,
      ) || silence.some((i) => i.from <= t && i.to >= t);
    const diedInWindow = deaths.some((d) => d >= t && d < w1);
    const responded =
      responses.selfHeal ||
      responses.wall ||
      responses.external ||
      responses.control ||
      responses.kite;
    out.push({
      tMs: t,
      tSec: (t - start) / 1000,
      hpPct: Math.round(x.hp * 100),
      dmg2s: Math.round(dmg2s * 100) / 100,
      attackers2s: attackers.size,
      enemyBurst: enemyBurstCasts.some(
        (b) => b > t - ENEMY_BURST_LOOKBACK_MS && b <= t,
      ),
      inCC,
      lockedOut,
      diedInWindow,
      responses,
      responded,
      selfHealPct: Math.round(selfHeal * 100),
      feasible: !inCC && !lockedOut && !diedInWindow,
    });
  }
  return out;
}
```

Both data imports resolve: `classMetadata` is exported from `data/classSpells.ts`; `spellIdLists` is the default export of `data/spellIdLists.ts`.

- [ ] **Step 4: Make eval re-export the constants**

In `packages/eval/src/explore/signalSkillGradient.ts` replace lines 129–132:

```ts
/** Single-source (spec 2026-08-29): the crisis threshold and merge gap live
 * with the decision-point predicate in analysis; re-exported so existing
 * importers (signalSkillGradientScan.ts, behaviorPriorScan.ts) keep working. */
export {
  CRISIS_HP_PCT,
  CRISIS_WINDOW_GAP_MS,
} from "@gladlog/analysis/src/analysis/crisisDecisionPoints";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run packages/analysis/src/analysis/crisisDecisionPoints.test.ts packages/eval/test/signalSkillGradient.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/src/analysis/crisisDecisionPoints.ts packages/analysis/src/analysis/crisisDecisionPoints.test.ts packages/eval/src/explore/signalSkillGradient.ts
git commit -m "feat(analysis): crisisDecisionPoints — shared crisis decision-point predicate (healer v1)"
```

---

### Task 2: Table aggregation (eval) + `--emit-table`

**Files:**

- Create: `packages/eval/src/explore/behaviorPriorTable.ts`
- Create: `packages/eval/test/behaviorPriorTable.test.ts`
- Modify: `packages/eval/scripts/behaviorPriorScan.ts` (replace `oppsOf` internals with `crisisDecisionPoints`; add `emit-table` command)

**Interfaces:**

- Consumes: `crisisDecisionPoints`, `DecisionPoint` (Task 1).
- Produces:

  ```ts
  export interface BehaviorPriorRow {
    bracket: string;
    pct: number | null;
    point: DecisionPoint;
  }
  export interface BehaviorPriorCell {
    n: number;
    respondRate: number;
    top: [string, number][];
    selfHealMedianPct: number;
  }
  export interface BehaviorPriorTable {
    meta: {
      generatedAt: string;
      corpus: string;
      weeks: string[];
      command: string;
      predicateVersion: number;
      topPercentile: number;
    };
    cells: Record<string, BehaviorPriorCell>;
  }
  export function dmgBinOf(dmg2s: number): "<10%" | "10-20%" | ">=20%";
  export function buildBehaviorPriorTable(
    rows: BehaviorPriorRow[],
    meta: BehaviorPriorTable["meta"],
  ): BehaviorPriorTable;
  ```

  Cell key: `` `${bracket}|healer|${dmgBin}` `` plus `` `${bracket}|healer|*` ``. Only rows with `pct >= 90 && point.feasible` enter. `respondRate` = share with `responded`. `top` = the three most frequent of `selfHeal|wall|external|control|kite` (share of cell, descending), rounded to 2 dp. `selfHealMedianPct` = median `selfHealPct` among selfHeal responders (0 if none).

- [ ] **Step 1: Write the failing test**

`packages/eval/test/behaviorPriorTable.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/eval/test/behaviorPriorTable.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`packages/eval/src/explore/behaviorPriorTable.ts`:

```ts
import type { DecisionPoint } from "@gladlog/analysis/src/analysis/crisisDecisionPoints";

export interface BehaviorPriorRow {
  bracket: string;
  pct: number | null;
  point: DecisionPoint;
}
export interface BehaviorPriorCell {
  n: number;
  respondRate: number;
  top: [string, number][];
  selfHealMedianPct: number;
}
export interface BehaviorPriorTable {
  meta: {
    generatedAt: string;
    corpus: string;
    weeks: string[];
    command: string;
    predicateVersion: number;
    topPercentile: number;
  };
  cells: Record<string, BehaviorPriorCell>;
}
export const TOP_PERCENTILE = 90;
const RESPONSE_KEYS = [
  "selfHeal",
  "wall",
  "external",
  "control",
  "kite",
] as const;

export function dmgBinOf(dmg2s: number): "<10%" | "10-20%" | ">=20%" {
  return dmg2s < 0.1 ? "<10%" : dmg2s < 0.2 ? "10-20%" : ">=20%";
}
const r2 = (x: number) => Math.round(x * 100) / 100;
function cellOf(points: DecisionPoint[]): BehaviorPriorCell {
  const n = points.length;
  const counts = RESPONSE_KEYS.map(
    (k) => [k, points.filter((p) => p.responses[k]).length] as const,
  )
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, c]) => [k, r2(c / n)] as [string, number]);
  const sh = points
    .filter((p) => p.responses.selfHeal)
    .map((p) => p.selfHealPct)
    .sort((a, b) => a - b);
  return {
    n,
    respondRate: r2(points.filter((p) => p.responded).length / n),
    top: counts,
    selfHealMedianPct: sh.length ? sh[Math.floor(sh.length / 2)]! : 0,
  };
}
export function buildBehaviorPriorTable(
  rows: BehaviorPriorRow[],
  meta: BehaviorPriorTable["meta"],
): BehaviorPriorTable {
  const groups = new Map<string, DecisionPoint[]>();
  for (const r of rows) {
    if (r.pct == null || r.pct < TOP_PERCENTILE || !r.point.feasible) continue;
    for (const key of [
      `${r.bracket}|healer|${dmgBinOf(r.point.dmg2s)}`,
      `${r.bracket}|healer|*`,
    ])
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r.point);
  }
  const cells: Record<string, BehaviorPriorCell> = {};
  for (const [k, v] of [...groups].sort()) cells[k] = cellOf(v);
  return { meta: { ...meta, topPercentile: TOP_PERCENTILE }, cells };
}
```

- [ ] **Step 4: Rewire `behaviorPriorScan.ts`**

In `packages/eval/scripts/behaviorPriorScan.ts`:

1. Import `crisisDecisionPoints` and the constants from `@gladlog/analysis/src/analysis/crisisDecisionPoints`; delete the local `oppsOf` body's crossing/response computation and the local `RESPONSE_WINDOW_MS/ACTION_*/DMG_WINDOW_MS/ENEMY_BURST_LOOKBACK_MS/KITE_GAIN_YARDS/SELF_HEAL_BIG/PERSONAL_WALL_IDS/EXTERNAL_IDS/CONTROL_IDS/OFFENSIVE_CD_IDS` constants. Keep `rankLedger`, `isoWeek`, ledger loading, sharding, and the `report` command.
2. Each scanned row becomes `{ matchId, seq, bracket, week, rating, pct, spec, point: DecisionPoint, gateFiredThisRound }` (`point` is the object from Task 1 — write it whole; the `report` command reads `row.point.*` instead of the old flat fields; update its filters accordingly: `pressed → point.responses.wall`, `inCC → point.inCC`, `diedIn10s` is dropped — replace the two hindsight tables with one "feasible vs gated" count table).
3. Add command `emit-table`:

```ts
async function emitTable(): Promise<void> {
  const inPath = flag("--in");
  if (!inPath) {
    console.error("usage: emit-table --in <file.jsonl> [--corpus <label>]");
    process.exit(1);
  }
  const rows: BehaviorPriorRow[] = [];
  const weeks = new Set<string>();
  let matches = new Set<string>();
  for (const l of readFileSync(inPath, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      matches.add(r.matchId);
      if (r.empty) continue;
      weeks.add(r.week);
      rows.push({ bracket: r.bracket, pct: r.pct, point: r.point });
    } catch {
      /* torn */
    }
  }
  const table = buildBehaviorPriorTable(rows, {
    generatedAt: new Date().toISOString().slice(0, 10),
    corpus: flag("--corpus") ?? `${matches.size} archived matches`,
    weeks: [...weeks].sort(),
    command: `npx tsx packages/eval/scripts/behaviorPriorScan.ts emit-table --in <scan.jsonl>`,
    predicateVersion: 1,
    topPercentile: 90,
  });
  process.stdout.write(JSON.stringify(table, null, 2) + "\n");
}
// dispatch: add `else if (cmd === "emit-table") await emitTable();`
```

- [ ] **Step 5: Run tests, typecheck, and a 30-match smoke of the rewired scan**

```bash
npx vitest run packages/eval/test/behaviorPriorTable.test.ts && npm run typecheck
cd packages/eval && E=$HOME/code/gladlog-eval-private && npx tsx scripts/behaviorPriorScan.ts scan \
  --manifest $E/corpus/manifest-archive-2026-08-28-newseason.txt --ledger $E/archive/ledger \
  --out /tmp/bp-smoke.jsonl --offset 3000 --limit 30 && grep -c '"point"' /tmp/bp-smoke.jsonl
```

Expected: tests PASS; smoke prints a positive count.

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/explore/behaviorPriorTable.ts packages/eval/test/behaviorPriorTable.test.ts packages/eval/scripts/behaviorPriorScan.ts
git commit -m "feat(eval): behaviorPriorScan consumes the shared crisis predicate; emit-table builds the top-10% reference"
```

---

### Task 3: Generate the table + analysis-side lookup

**Files:**

- Create: `packages/analysis/src/data/behaviorPriorGenerated.json` (generated)
- Create: `packages/analysis/src/data/behaviorPrior.ts`
- Create: `packages/analysis/src/data/behaviorPrior.test.ts`
- Modify: `packages/analysis/scripts/datagen/writeManifest.ts:200-211` (register the corpus-derived artifact)

**Interfaces:**

- Produces:

  ```ts
  export const BEHAVIOR_PRIOR_N_FLOOR = 50;
  export type DmgBin = "<10%" | "10-20%" | ">=20%";
  export function dmgBinOf(dmg2s: number): DmgBin; // moved here from eval (Task 2 re-exports it)
  export interface BehaviorPriorRef {
    cellKey: string;
    n: number;
    respondPct: number;
    top: [string, number][];
    selfHealMedianPct: number;
    fellBack: boolean;
  }
  export function lookupBehaviorPrior(
    bracket: string,
    role: "healer",
    dmg2s: number,
  ): BehaviorPriorRef | null;
  ```

  `respondPct` and `top[*][1]` are **integers 0–100** (rounded from the table's fractions) — the same integers the prompt renders.

- [ ] **Step 1: Generate the JSON from the archive (≈1 h, 3 shards, nice)**

```bash
E=$HOME/code/gladlog-eval-private; R=$E/reports/behavior-prior-2026-08-28; cd packages/eval
for i in 0 1 2; do nice -n 10 npx tsx scripts/behaviorPriorScan.ts scan \
  --manifest $E/corpus/manifest-archive-2026-08-28-newseason.txt --ledger $E/archive/ledger \
  --out $R/v5-shard$i.jsonl --offset $((i*6045)) --limit 6045 > $R/v5-shard$i.log 2>&1 & done; wait
cat $R/v5-shard*.jsonl > $R/opportunities-v5.jsonl
npx tsx scripts/behaviorPriorScan.ts emit-table --in $R/opportunities-v5.jsonl \
  --corpus "wowarenalogs archive 2026-08 new season, 18,134 matches" \
  > ../analysis/src/data/behaviorPriorGenerated.json
python3 -c "import json;t=json.load(open('../analysis/src/data/behaviorPriorGenerated.json'));print({k:v['n'] for k,v in t['cells'].items()})"
```

Expected: every `<bracket>|healer|*` cell has n ≥ 50 (2026-08-29 measurement predicts ≈ 285 / 350 / 105 — larger, since the product predicate no longer requires a wall to be ready).

- [ ] **Step 2: Write the failing lookup test**

`packages/analysis/src/data/behaviorPrior.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import raw from "./behaviorPriorGenerated.json";
import {
  BEHAVIOR_PRIOR_N_FLOOR,
  dmgBinOf,
  lookupBehaviorPrior,
} from "./behaviorPrior";

describe("behaviorPrior lookup", () => {
  it("every bracket has a star cell with n ≥ floor (table health — regenerate when red)", () => {
    for (const b of ["Rated Solo Shuffle", "2v2", "3v3"]) {
      const c = (raw as any).cells[`${b}|healer|*`];
      expect(c, b).toBeDefined();
      expect(c.n).toBeGreaterThanOrEqual(BEHAVIOR_PRIOR_N_FLOOR);
    }
  });
  it("returns the fine cell when n ≥ floor, integer percentages", () => {
    const ref = lookupBehaviorPrior("Rated Solo Shuffle", "healer", 0.3)!;
    expect(ref.cellKey).toBe("Rated Solo Shuffle|healer|>=20%");
    expect(Number.isInteger(ref.respondPct)).toBe(true);
    expect(ref.top.every(([, p]) => Number.isInteger(p))).toBe(true);
  });
  it("falls back to the star cell when the fine cell is thin, and says so", () => {
    const fine = (raw as any).cells["3v3|healer|<10%"];
    const ref = lookupBehaviorPrior("3v3", "healer", 0.05)!;
    if (fine && fine.n >= BEHAVIOR_PRIOR_N_FLOOR)
      expect(ref.fellBack).toBe(false);
    else {
      expect(ref.fellBack).toBe(true);
      expect(ref.cellKey).toBe("3v3|healer|*");
    }
  });
  it("unknown bracket → null", () => {
    expect(lookupBehaviorPrior("Skirmish", "healer", 0.3)).toBeNull();
  });
  it("dmgBinOf boundaries", () => {
    expect(dmgBinOf(0.099)).toBe("<10%");
    expect(dmgBinOf(0.1)).toBe("10-20%");
    expect(dmgBinOf(0.2)).toBe(">=20%");
  });
});
```

- [ ] **Step 3: Run to see it fail** — `npx vitest run packages/analysis/src/data/behaviorPrior.test.ts` → module not found.

- [ ] **Step 4: Implement `behaviorPrior.ts`**

```ts
/**
 * Behavior-prior reference (corpus-derived, GENERATED json): what top-10%
 * healers actually do at a crisis decision point, per bracket × damage bin.
 * Consumed by candidates/crisisNoResponse.ts (the rendered reference) AND by
 * packages/eval promptQualityCheck's checkBehaviorPriorConsistency (the gate
 * that re-parses the rendered numbers) — one lookup, both sides.
 *
 * Regenerate (spec §3; REQUIRED after any change to crisisDecisionPoints.ts):
 *   npx tsx packages/eval/scripts/behaviorPriorScan.ts scan … && emit-table …
 *   > packages/analysis/src/data/behaviorPriorGenerated.json
 * Runbook: docs/commands/update-wow-data.md step 6b-pre-2.
 */
import raw from "./behaviorPriorGenerated.json";

export const BEHAVIOR_PRIOR_N_FLOOR = 50;
export type DmgBin = "<10%" | "10-20%" | ">=20%";
export function dmgBinOf(dmg2s: number): DmgBin {
  return dmg2s < 0.1 ? "<10%" : dmg2s < 0.2 ? "10-20%" : ">=20%";
}
interface Cell {
  n: number;
  respondRate: number;
  top: [string, number][];
  selfHealMedianPct: number;
}
const CELLS = (raw as { cells: Record<string, Cell> }).cells;
export const BEHAVIOR_PRIOR_META = (raw as { meta: Record<string, unknown> })
  .meta;

export interface BehaviorPriorRef {
  cellKey: string;
  n: number;
  respondPct: number;
  top: [string, number][];
  selfHealMedianPct: number;
  fellBack: boolean;
}
const pct = (f: number) => Math.round(f * 100);

export function lookupBehaviorPrior(
  bracket: string,
  role: "healer",
  dmg2s: number,
): BehaviorPriorRef | null {
  const fineKey = `${bracket}|${role}|${dmgBinOf(dmg2s)}`;
  const starKey = `${bracket}|${role}|*`;
  const fine = CELLS[fineKey];
  const cell = fine && fine.n >= BEHAVIOR_PRIOR_N_FLOOR ? fine : CELLS[starKey];
  if (!cell) return null;
  const fellBack = cell !== fine;
  return {
    cellKey: fellBack ? starKey : fineKey,
    n: cell.n,
    respondPct: pct(cell.respondRate),
    top: cell.top.map(([k, f]) => [k, pct(f)] as [string, number]),
    selfHealMedianPct: cell.selfHealMedianPct,
    fellBack,
  };
}
```

Then make Task 2's `dmgBinOf` in `packages/eval/src/explore/behaviorPriorTable.ts` a re-export: `export { dmgBinOf } from "@gladlog/analysis/src/data/behaviorPrior";` (one binning, both sides).

- [ ] **Step 5: Register in `writeManifest.ts`** after the `observedSpellIdsGenerated.json` entry:

```ts
      "behaviorPriorGenerated.json": {
        entries: Object.keys(readJson("behaviorPriorGenerated.json").cells).length,
        producer: "packages/eval/scripts/behaviorPriorScan.ts emit-table",
      },
```

- [ ] **Step 6: Tests + typecheck** — `npx vitest run packages/analysis/src/data/behaviorPrior.test.ts packages/eval/test/behaviorPriorTable.test.ts && npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/analysis/src/data/behaviorPriorGenerated.json packages/analysis/src/data/behaviorPrior.ts packages/analysis/src/data/behaviorPrior.test.ts packages/analysis/scripts/datagen/writeManifest.ts packages/eval/src/explore/behaviorPriorTable.ts
git commit -m "feat(data): behaviorPriorGenerated.json (top-10% healer crisis responses, 18,134 matches) + lookupBehaviorPrior with n≥50 fallback"
```

---

### Task 4: Producer `crisisNoResponseEvents`

**Files:**

- Create: `packages/analysis/src/analysis/candidates/crisisNoResponse.ts`
- Create: `packages/analysis/src/analysis/candidates/crisisNoResponse.test.ts`

**Interfaces:**

- Consumes: `DecisionPoint` (Task 1), `lookupBehaviorPrior`/`BehaviorPriorRef` (Task 3), `fmtFactNum` from `../factFormat`, `CandidateEvent`.
- Produces:

  ```ts
  export const CRISIS_NO_RESPONSE_CAP = 2;
  export function crisisNoResponseEvents(
    points: DecisionPoint[],
    owner: { id: string; name: string },
    bracket: string,
    probes: { lookup: (dmg2s: number) => BehaviorPriorRef | null },
    overrides?: { cap?: number },
  ): CandidateEvent[];
  ```

  facts: `t` (fmtFactNum seconds), `unit`, `hpPct`, `dmg2sPct` (integer % of max HP), `attackers`, `burst` ("yes"/"no"), `refN`, `refRespond` (integer), `refTop` (`"selfHeal 76%, wall 36%, control 16%"`), `refSelfHealMedian` (integer %), `cellKey`, `fellBack` ("yes"/"no").

- [ ] **Step 1: Failing tests**

`crisisNoResponse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DecisionPoint } from "../crisisDecisionPoints";
import {
  CRISIS_NO_RESPONSE_CAP,
  crisisNoResponseEvents,
} from "./crisisNoResponse";

const pt = (over: Partial<DecisionPoint> = {}): DecisionPoint => ({
  tMs: 0,
  tSec: 72.4,
  hpPct: 38,
  dmg2s: 0.25,
  attackers2s: 2,
  enemyBurst: true,
  inCC: false,
  lockedOut: false,
  diedInWindow: false,
  responses: {
    selfHeal: false,
    wall: false,
    external: false,
    control: false,
    peel: false,
    kite: false,
  },
  responded: false,
  selfHealPct: 0,
  feasible: true,
  ...over,
});
const ref = {
  cellKey: "3v3|healer|>=20%",
  n: 81,
  respondPct: 88,
  top: [
    ["selfHeal", 76],
    ["wall", 36],
    ["control", 16],
  ] as [string, number][],
  selfHealMedianPct: 37,
  fellBack: false,
};
const probes = { lookup: () => ref };
const owner = { id: "H", name: "Heals-R" };

describe("crisis-no-response", () => {
  it("fires for a feasible, unanswered crossing with the reference facts", () => {
    const ev = crisisNoResponseEvents([pt()], owner, "3v3", probes);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe("crisis-no-response");
    expect(ev[0]!.id).toBe("crisis-no-response:H:72");
    expect(ev[0]!.facts).toEqual({
      t: "72.4",
      unit: "Heals-R",
      hpPct: "38",
      dmg2sPct: "25",
      attackers: "2",
      burst: "yes",
      refN: "81",
      refRespond: "88",
      refTop: "selfHeal 76%; wall 36%; control 16%",
      refSelfHealMedian: "37",
      cellKey: "3v3|healer|>=20%",
      fellBack: "no",
    });
  });
  it("silent when the owner responded", () => {
    expect(
      crisisNoResponseEvents([pt({ responded: true })], owner, "3v3", probes),
    ).toEqual([]);
  });
  it("silent when any feasibility gate failed", () => {
    expect(
      crisisNoResponseEvents([pt({ feasible: false })], owner, "3v3", probes),
    ).toEqual([]);
  });
  it("silent when no reference exists for the bracket (never accuse without a baseline)", () => {
    expect(
      crisisNoResponseEvents([pt()], owner, "Skirmish", { lookup: () => null }),
    ).toEqual([]);
  });
  it("caps at 2 per round ordered by danger, never by outcome", () => {
    const pts = [
      pt({ tSec: 10, enemyBurst: false, attackers2s: 1, dmg2s: 0.05 }),
      pt({ tSec: 20, enemyBurst: true, attackers2s: 1, dmg2s: 0.1 }),
      pt({ tSec: 30, enemyBurst: false, attackers2s: 3, dmg2s: 0.4 }),
      pt({ tSec: 40, enemyBurst: true, attackers2s: 2, dmg2s: 0.3 }),
    ];
    const ev = crisisNoResponseEvents(pts, owner, "3v3", probes);
    expect(ev.map((e) => e.facts.t)).toEqual(["40", "20"]);
    expect(CRISIS_NO_RESPONSE_CAP).toBe(2);
  });
  it("emitted events are returned in time order", () => {
    const ev = crisisNoResponseEvents(
      [
        pt({ tSec: 50, enemyBurst: true }),
        pt({ tSec: 5, enemyBurst: true, attackers2s: 3 }),
      ],
      owner,
      "3v3",
      probes,
    );
    expect(ev.map((e) => e.t)).toEqual([5, 50]);
  });
});
```

- [ ] **Step 2: Run to see it fail** — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * crisis-no-response — "your HP crossed ≤40%, you were free to act, and you
 * did nothing for 3 s". Replaces the hindsight framing of
 * death-unused-defensive ("the wall was ready") with the one behaviour that
 * actually separates rank brackets in the corpus: acting at all
 * (3v3 free state: <30% rank 32% idle → top10 12%; walls themselves 11→36%
 * only in 3v3, flat in Solo/2v2). Reference numbers come from
 * data/behaviorPrior.ts — the model may cite them, never prescribe from them.
 * Spec: docs/superpowers/specs/2026-08-29-crisis-no-response-design.md.
 */
import type { BehaviorPriorRef } from "../../data/behaviorPrior";
import type { DecisionPoint } from "../crisisDecisionPoints";
import { fmtFactNum as fmt } from "../factFormat";
import type { CandidateEvent } from "../types";

export const CRISIS_NO_RESPONSE_CAP = 2;

export function crisisNoResponseEvents(
  points: DecisionPoint[],
  owner: { id: string; name: string },
  bracket: string,
  probes: { lookup: (dmg2s: number) => BehaviorPriorRef | null },
  overrides?: { cap?: number },
): CandidateEvent[] {
  const cap = overrides?.cap ?? CRISIS_NO_RESPONSE_CAP;
  const eligible = points.filter((p) => p.feasible && !p.responded);
  // danger order — enemyBurst, then attackers, then damage; NEVER outcome
  const ranked = [...eligible].sort(
    (a, b) =>
      Number(b.enemyBurst) - Number(a.enemyBurst) ||
      b.attackers2s - a.attackers2s ||
      b.dmg2s - a.dmg2s,
  );
  const out: CandidateEvent[] = [];
  for (const p of ranked.slice(0, cap)) {
    const ref = probes.lookup(p.dmg2s);
    if (!ref) continue; // no baseline → no accusation
    out.push({
      id: `crisis-no-response:${owner.id}:${Math.round(p.tSec)}`,
      type: "crisis-no-response",
      t: p.tSec,
      unitNames: [owner.name],
      facts: {
        t: fmt(p.tSec),
        unit: owner.name,
        hpPct: String(p.hpPct),
        dmg2sPct: String(Math.round(p.dmg2s * 100)),
        attackers: String(p.attackers2s),
        burst: p.enemyBurst ? "yes" : "no",
        refN: String(ref.n),
        refRespond: String(ref.respondPct),
        refTop: ref.top.map(([k, v]) => `${k} ${v}%`).join("; "), // "; " — ", " is the facts separator the gate splits on
        refSelfHealMedian: String(ref.selfHealMedianPct),
        cellKey: ref.cellKey,
        fellBack: ref.fellBack ? "yes" : "no",
      },
    });
  }
  return out.sort((a, b) => a.t - b.t);
}
```

Note `bracket` is accepted for the id/facts contract only in v1 (the lookup closure already carries it); keep the parameter so the wiring reads naturally and DPS can add `role` later.

- [ ] **Step 4: Run tests** — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src/analysis/candidates/crisisNoResponse.ts packages/analysis/src/analysis/candidates/crisisNoResponse.test.ts
git commit -m "feat(analysis): crisisNoResponseEvents producer (cap 2, danger-ordered, reference-backed)"
```

---

### Task 5: Wire into the menu, legend, `precededBy`, PROMPT_VERSION

**Files:**

- Modify: `packages/analysis/src/analysis/candidateFindings.ts` (re-export block :124–149; `teamPlayEvents` healer branch after healing-gap ≈ :1999)
- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.ts` (`CHAIN_LEGENDS` :52–100)
- Modify: `packages/analysis/src/analysis/candidateFindings.test.ts` (new describe)
- Modify: `packages/analysis/src/analysis/buildFindingsPrompt.test.ts` (legend presence test)
- Modify: `packages/desktop/src/shared/promptVersion.ts:161`

- [ ] **Step 1: Failing integration test** (append to `candidateFindings.test.ts`, reusing that file's existing legacy-fixture helpers — look at how the `death-unused-defensive` describe at :622 builds a combat; if there is a fixture loader like `loadLegacyMatchFixture` in `packages/eval/test/helpers/legacyFixture.ts`, prefer a synthetic combat built like Task 1's `unit()`/`combat()` helpers copied into this test):

```ts
describe("crisis-no-response wiring", () => {
  it("healer owner: an unanswered feasible crossing appears in the menu with reference facts", () => {
    // build: healer owner "H" (Restoration Druid spec id 105) with advancedActions 100→70→38→35 at 0/1/2/3 s,
    // one enemy "E1" hitting for 30 at 1.5 s, no casts, no CC, no death; combat.startInfo.bracket = "3v3"
    const ev = extractCandidateFindings(combat, "H").filter(
      (c) => c.type === "crisis-no-response",
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.facts.refRespond).toMatch(/^\d+$/);
    expect(ev[0]!.facts.cellKey.startsWith("3v3|healer|")).toBe(true);
  });
  it("a death-unused-defensive within 10 s after it is marked precededBy", () => {
    // same fixture + deathRecords at 9 s and a ready Barkskin (22812) in the kit via a SPELL_CAST_SUCCESS at 0 s outside? — simplest: owner dies at 9 s, has no casts at all (cd-waste and death-unused-defensive both read extractMajorCooldowns; a never-cast Barkskin is "available")
    const all = extractCandidateFindings(combat, "H");
    const dud = all.find((c) => c.type === "death-unused-defensive");
    expect(dud?.facts.precededBy).toBe("crisis-no-response");
  });
  it("DPS owner: never emitted (v1 healer-only)", () => {
    const ev = extractCandidateFindings(combat, "E1").filter(
      (c) => c.type === "crisis-no-response",
    );
    expect(ev).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see it fail** — no `crisis-no-response` in the menu.

- [ ] **Step 3: Wire the producer** — in `candidateFindings.ts`:

Re-export block: add

```ts
export {
  CRISIS_NO_RESPONSE_CAP,
  crisisNoResponseEvents,
} from "./candidates/crisisNoResponse";
```

Imports at top:

```ts
import { lookupBehaviorPrior } from "../data/behaviorPrior";
import { crisisDecisionPoints } from "./crisisDecisionPoints";
import { crisisNoResponseEvents } from "./candidates/crisisNoResponse";
```

In `teamPlayEvents`, immediately after the healing-gap block (before the `slow-defensive-response` comment):

```ts
// crisis-no-response (spec 2026-08-29): healer-owner rounds only — the DPS
// "no response" rate is flat across rank brackets (5,613-match partial),
// so there is no baseline to accuse against. Same predicate as the eval
// behavior-prior scan (crisisDecisionPoints) and same lookup as the gate.
if (isHealerSpec(owner.spec)) {
  try {
    const bracket: string = combat?.startInfo?.bracket ?? "";
    out.push(
      ...crisisNoResponseEvents(
        crisisDecisionPoints(owner, combat),
        owner,
        bracket,
        { lookup: (dmg2s) => lookupBehaviorPrior(bracket, "healer", dmg2s) },
      ),
    );
  } catch {
    /* decision points not computable → type absent */
  }
}
```

In `extractCandidateFindings`, after the `teamPlayEvents(...)` push (≈ :346) add the precededBy pass:

```ts
// spec §4: keep death-unused-defensive, but mark it when a crisis-no-response
// fired ≤10 s before the death so the two can be compared side by side (GH #58).
const crises = out.filter((c) => c.type === "crisis-no-response");
for (const d of out) {
  if (d.type !== "death-unused-defensive") continue;
  if (crises.some((c) => c.t <= d.t && d.t - c.t <= 10))
    d.facts.precededBy = "crisis-no-response";
}
```

(If `teamPlayEvents` is only called for a healer owner in some code paths, confirm the call at :346 runs for the healer owner — it does: `out.push(...teamPlayEvents(combat, owner, units, ownerCds, out, rawStreams))`.)

- [ ] **Step 4: Legend** — in `CHAIN_LEGENDS` add:

```ts
  "crisis-no-response": `- "crisis-no-response": at facts.t the player's own HP fell to facts.hpPct% (took facts.dmg2sPct% of max HP in the prior 2 s from facts.attackers attacker(s); enemy burst cooldown active: facts.burst) and for the next 3 seconds did NOTHING to answer it — no self-heal ≥15%, no personal wall, no external, no CC/root/interrupt on an enemy, no kiting. The player was free (not CC'd, not locked out, alive through the window). Reference: among top-10% healers in this bracket at the same damage level (n=facts.refN, cell facts.cellKey; fellBack=yes means a coarser bracket-wide cell), facts.refRespond% act within 3 s; their most common answers are facts.refTop (median self-heal among self-healers facts.refSelfHealMedian% of max HP). CITE these numbers as what strong players do; do NOT turn them into "you should have pressed <ability>" — the reference is a distribution, not a prescription, and the wall specifically is NOT what separates ranks.`,
```

Add to `buildFindingsPrompt.test.ts` a presence test: with a candidate of this type the prompt contains `"crisis-no-response":` and the phrase `not a prescription`; without it, it does not.

- [ ] **Step 5: Bump `PROMPT_VERSION`** to 37 with the changelog line:

```ts
// v37 (2026-08-29): crisis-no-response 候选上线(治疗视角,行为先验参照表
// behaviorPriorGenerated.json,spec 2026-08-29);death-unused-defensive 加
// facts.precededBy。菜单变 → prompt 变 → 旧缓存作废。
export const PROMPT_VERSION = 37;
```

- [ ] **Step 6: Run** `npx vitest run packages/analysis packages/desktop/test/report.mistakes.test.tsx` — expect the analysis tests to PASS and `report.mistakes.test.tsx` to FAIL with "candidateFindings 新增了类型,请在 MISTAKE_RULES 或 IGNORED_CANDIDATE_TYPES 表态" (that is Task 7's job — confirm the inventory test catches it).

- [ ] **Step 7: Commit**

```bash
git add packages/analysis/src/analysis/candidateFindings.ts packages/analysis/src/analysis/candidateFindings.test.ts packages/analysis/src/analysis/buildFindingsPrompt.ts packages/analysis/src/analysis/buildFindingsPrompt.test.ts packages/desktop/src/shared/promptVersion.ts
git commit -m "feat(analysis): wire crisis-no-response into the healer menu + legend; precededBy on death-unused-defensive; PROMPT_VERSION 37"
```

---

### Task 6: Gate `checkBehaviorPriorConsistency`

**Files:**

- Modify: `packages/eval/src/quality/promptQualityCheck.ts` (new check + push into `hardFailures` after `checkHealedThroughConsistency`)
- Modify: `packages/eval/test/promptQuality.test.ts`

**Interfaces:**

- Consumes: `lookupBehaviorPrior` (Task 3).
- Produces: `export function checkBehaviorPriorConsistency(lines: string[]): string[]`.

- [ ] **Step 1: Failing test**

```ts
describe("checkBehaviorPriorConsistency", () => {
  const line = (over: Partial<Record<string, string>> = {}) => {
    const ref = lookupBehaviorPrior("3v3", "healer", 0.25)!;
    const f = {
      t: "72.4",
      unit: "H",
      hpPct: "38",
      dmg2sPct: "25",
      attackers: "2",
      burst: "yes",
      refN: String(ref.n),
      refRespond: String(ref.respondPct),
      refTop: ref.top.map(([k, v]) => `${k} ${v}%`).join("; "),
      refSelfHealMedian: String(ref.selfHealMedianPct),
      cellKey: ref.cellKey,
      fellBack: ref.fellBack ? "yes" : "no",
      ...over,
    };
    return `  - id=crisis-no-response:H:72 type=crisis-no-response t=72.4s units=H facts={${Object.entries(
      f,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}}`;
  };
  it("accepts a line whose reference numbers match the table", () => {
    expect(checkBehaviorPriorConsistency([line()])).toEqual([]);
  });
  it("rejects a planted wrong refRespond", () => {
    const out = checkBehaviorPriorConsistency([line({ refRespond: "12" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/refRespond/);
  });
  it("rejects a refTop that is not the table's", () => {
    expect(
      checkBehaviorPriorConsistency([line({ refTop: "wall 99%" })]),
    ).toHaveLength(1);
  });
  it("rejects a cellKey the lookup would not have chosen for dmg2sPct", () => {
    expect(
      checkBehaviorPriorConsistency([line({ dmg2sPct: "5" })]),
    ).toHaveLength(1);
  });
});
```

(import `lookupBehaviorPrior` from `@gladlog/analysis/src/data/behaviorPrior` and the check from `../src/quality/promptQualityCheck`.)

- [ ] **Step 2: Run to see it fail** — export missing.

- [ ] **Step 3: Implement** in `promptQualityCheck.ts`:

```ts
import { lookupBehaviorPrior } from "@gladlog/analysis/src/data/behaviorPrior";

/** crisis-no-response: every rendered reference number must be exactly what
 * lookupBehaviorPrior returns for the line's own bracket/dmg2s (spec §5) —
 * the analysis side and this gate share the lookup, so any drift is a bug in
 * the producer's formatting, not a judgement call. */
export function checkBehaviorPriorConsistency(lines: string[]): string[] {
  const failures: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("type=crisis-no-response")) continue;
    const m = line.match(/facts=\{(.*)\}\s*$/);
    if (!m) {
      failures.push(`line ${i + 1}: crisis-no-response 行无 facts`);
      continue;
    }
    const f: Record<string, string> = {};
    for (const kv of m[1]!.split(", ")) {
      const j = kv.indexOf("=");
      if (j > 0) f[kv.slice(0, j)] = kv.slice(j + 1);
    }
    const bracket = (f.cellKey ?? "").split("|")[0] ?? "";
    const ref = lookupBehaviorPrior(
      bracket,
      "healer",
      Number(f.dmg2sPct) / 100,
    );
    if (!ref) {
      failures.push(
        `line ${i + 1}: crisis-no-response 引用了表里不存在的赛制 ${bracket}`,
      );
      continue;
    }
    const expect: Record<string, string> = {
      cellKey: ref.cellKey,
      refN: String(ref.n),
      refRespond: String(ref.respondPct),
      refTop: ref.top.map(([k, v]) => `${k} ${v}%`).join("; "),
      refSelfHealMedian: String(ref.selfHealMedianPct),
      fellBack: ref.fellBack ? "yes" : "no",
    };
    for (const [k, v] of Object.entries(expect))
      if (f[k] !== v)
        failures.push(
          `line ${i + 1}: crisis-no-response ${k}=${f[k]} 与参照表 ${v} 不一致(${ref.cellKey})`,
        );
  }
  return failures;
}
```

and in `checkMatch` add `hardFailures.push(...checkBehaviorPriorConsistency(lines));` after the healed-through line. Update the CLAUDE.md sentence listing the hardFailure classes ("currently nine classes" → ten, append `behavior-prior reference consistency \`checkBehaviorPriorConsistency\``) — both CLAUDE.md is single-language, no zh twin.

Note: `refTop` is joined with "; " in the producer (Task 4) precisely because ", " is the facts separator this parser splits on — keep `expect.refTop` here joined with "; " too.

- [ ] **Step 4: Run** `npx vitest run packages/eval/test/promptQuality.test.ts packages/analysis/src/analysis/candidates/crisisNoResponse.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/quality/promptQualityCheck.ts packages/eval/test/promptQuality.test.ts packages/analysis/src/analysis/candidates/crisisNoResponse.ts packages/analysis/src/analysis/candidates/crisisNoResponse.test.ts CLAUDE.md
git commit -m "feat(eval): checkBehaviorPriorConsistency hard-failure — rendered reference numbers must equal lookupBehaviorPrior"
```

---

### Task 7: Desktop registry + label + detail

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/derive/mistakes.ts` (`MISTAKE_RULES` after the `death-unused-defensive` entry ≈ :91; `candidateDetail` switch ≈ :306)
- Modify: `packages/desktop/src/renderer/src/report/derive/findingDisplay.ts` (`TYPE_LABEL` ≈ :66)
- Test: `packages/desktop/test/report.mistakes.test.tsx` (inventory test already exists; add a detail-string test)

- [ ] **Step 1: Failing test** — append to `report.mistakes.test.tsx`:

```ts
it("crisis-no-response has a rule and a detail string", () => {
  expect(
    MISTAKE_RULES.find((r) => r.type === "crisis-no-response"),
  ).toMatchObject({ severity: "major", source: "candidate" });
  expect(
    candidateDetail({
      type: "crisis-no-response",
      facts: {
        hpPct: "38",
        refRespond: "88",
        refTop: "selfHeal 76%; wall 36%",
      },
    } as any),
  ).toBe(
    "血量 38% 后 3 秒无应对(同赛制前 10% 治疗此处 88% 会出手:selfHeal 76%; wall 36%)",
  );
});
```

(check `candidateDetail`'s real signature at :300 and adapt the argument shape.)

- [ ] **Step 2: Run** `npx vitest run packages/desktop/test/report.mistakes.test.tsx` → FAIL (inventory + new test).

- [ ] **Step 3: Implement**

`MISTAKE_RULES` entry:

```ts
  {
    type: "crisis-no-response",
    label: "危机 3 秒无应对",
    severity: "major",
    source: "candidate",
  },
```

`candidateDetail` case:

```ts
    case "crisis-no-response":
      return `血量 ${f.hpPct ?? "?"}% 后 3 秒无应对(同赛制前 10% 治疗此处 ${f.refRespond ?? "?"}% 会出手:${f.refTop ?? ""})`;
```

`TYPE_LABEL`: `"crisis-no-response": "危机无应对",`.
Do **not** add a `MISTAKE_DISCRIMINATION_PP` entry (no A/B discrimination number exists yet — the map is measured, not guessed).

- [ ] **Step 4: Run** desktop tests → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/derive/mistakes.ts packages/desktop/src/renderer/src/report/derive/findingDisplay.ts packages/desktop/test/report.mistakes.test.tsx
git commit -m "feat(desktop): crisis-no-response mistake rule, label and detail"
```

---

### Task 8: Docs, predicate index, gradient denominator, runbook

**Files:**

- Modify: `docs/predicate-index.md` (section "### Thresholds" or "### Classification and name tables" — add two rows), `docs/predicate-index.zh-CN.md` (same two rows), `packages/eval/test/predicateIndex.test.ts` (import pins)
- Modify: `packages/analysis/README.md:98`, `packages/analysis/README.zh-CN.md:98`
- Modify: `docs/commands/update-wow-data.md` (after 6b-pre) and `.claude/commands/update-wow-data.md` (mirror)
- Modify: `packages/eval/src/explore/signalSkillGradient.ts` (`DENOMINATOR_OF`, `RoundExposure`), `packages/eval/scripts/signalSkillGradientScan.ts` (`exposureOf`)

- [ ] **Step 1: predicate-index rows** (English; mirror in Chinese with the same two symbols):

```
| Where a healer's crisis decision point is and whether they answered it | `packages/analysis/src/analysis/crisisDecisionPoints.ts` → `crisisDecisionPoints` | `candidates/crisisNoResponse.ts` (product), `packages/eval/scripts/behaviorPriorScan.ts` (reference table) | 2026-08-29 spec: the table's "top-10% respond X%" and the product's "you did not respond" must be the same crossing/window/taxonomy or they are not comparable; changing this file requires regenerating `behaviorPriorGenerated.json`. |
| What top-10% healers do at that decision point (reference numbers rendered into the prompt) | `packages/analysis/src/data/behaviorPrior.ts` → `lookupBehaviorPrior` (`BEHAVIOR_PRIOR_N_FLOOR`, `dmgBinOf`) | `candidates/crisisNoResponse.ts` (render), `promptQualityCheck.ts` → `checkBehaviorPriorConsistency` (gate re-parses and compares), `eval/src/explore/behaviorPriorTable.ts` (re-exports `dmgBinOf`) | Corpus-derived, regenerated per season (update-wow-data 6b-pre-2). n<50 cells fall back to the bracket-wide cell and say so (`fellBack`). |
```

In `predicateIndex.test.ts` add the imports `import * as crisisDecisionPoints from "@gladlog/analysis/src/analysis/crisisDecisionPoints"; import * as behaviorPrior from "@gladlog/analysis/src/data/behaviorPrior";` and pin the four exports the way the file pins the others (follow its existing list structure — find where `cellLookup.REFERENCE_CELL_N_FLOOR` is asserted and add `crisisDecisionPoints.crisisDecisionPoints`, `crisisDecisionPoints.CRISIS_HP_PCT`, `behaviorPrior.lookupBehaviorPrior`, `behaviorPrior.BEHAVIOR_PRIOR_N_FLOOR`). Also add the inverse-relation end-to-end check: build one `crisis-no-response` menu line from a real `lookupBehaviorPrior("3v3","healer",0.25)` and assert `checkBehaviorPriorConsistency` returns `[]`, then mutate `refRespond` and assert one failure (negative control).

- [ ] **Step 2: README type lists** — in both files change "16 `type` values" → "17" (zh: "16 个 `type` 值" → "17 个") and append `` `crisis-no-response` `` to the parenthesised list before `dr-clipped-cc`'s closing paren.

- [ ] **Step 3: Runbook step** (both copies) after 6b-pre:

```
# 6b-pre-2. Behavior-prior reference table (top-10% healer crisis responses; corpus-driven, NOT DB2).
#   Regenerate at season start and whenever packages/analysis/src/analysis/crisisDecisionPoints.ts changes.
#   ~1 h over the archive; run ≤3 shards with nice. Health test: packages/analysis/src/data/behaviorPrior.test.ts
#   ("every bracket star cell n ≥ 50") goes red when the season is too young — wait for more archive, do not lower the floor.
E=$GLADLOG_EVAL_HOME; R=$E/reports/behavior-prior-$(date +%F); mkdir -p $R
find $E/corpus/archive-gz -name '*.txt.gz' | sort > $R/manifest.txt
for i in 0 1 2; do nice -n 10 npx tsx packages/eval/scripts/behaviorPriorScan.ts scan \
  --manifest $R/manifest.txt --ledger $E/archive/ledger --out $R/shard$i.jsonl \
  --offset $((i*7000)) --limit 7000 > $R/shard$i.log 2>&1 & done; wait
cat $R/shard*.jsonl > $R/opportunities.jsonl
npx tsx packages/eval/scripts/behaviorPriorScan.ts emit-table --in $R/opportunities.jsonl \
  --corpus "wowarenalogs archive $(date +%F)" > packages/analysis/src/data/behaviorPriorGenerated.json
```

(the scan itself already filters to `startTime ≥ PATCH_121_GOLIVE_EPOCH_MS`; when the next season ships, update that epoch first — it is the season gate.)

- [ ] **Step 4: Gradient denominator** — `RoundExposure` gains `crisisDecisionPoints: number` (count of `feasible` points for the healer owner, computed in `exposureOf` via `crisisDecisionPoints(owner, legacy).filter((p) => p.feasible).length`), and `DENOMINATOR_OF["crisis-no-response"] = "crisisDecisionPoints"`. Add the field to the synthetic fixture in `packages/eval/test/signalSkillGradient.test.ts` if the type there is exhaustive.

- [ ] **Step 5: Run** `npx vitest run packages/eval/test/predicateIndex.test.ts packages/eval/test/signalSkillGradient.test.ts && npm run typecheck && npx eslint .` → PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts packages/analysis/README.md packages/analysis/README.zh-CN.md docs/commands/update-wow-data.md .claude/commands/update-wow-data.md packages/eval/src/explore/signalSkillGradient.ts packages/eval/scripts/signalSkillGradientScan.ts packages/eval/test/signalSkillGradient.test.ts
git commit -m "docs+eval: crisis-no-response predicate-index rows, README type list, runbook 6b-pre-2, gradient denominator"
```

---

### Task 9: Value gate + deterministic verification + presubmit

**Files:** none new in-repo; outputs go to `$GLADLOG_EVAL_HOME/reports/crisis-no-response-2026-08-29/`.

- [ ] **Step 1: Value gate (CLAUDE.md #1) — three real prompts + model outputs.** Pick 3 healer rounds from the local library where the new type fires (find them with a 100-match `extractCandidateFindings` sweep over `~/Library/Application Support/gladlog/matches/*/` using the existing `packages/eval/scripts/candidateDiagnostics.ts` if it accepts a type filter, otherwise a 20-line tsx in the scratchpad), build the full prompt with the production builder, run the product's default CLI backend from a **neutral cwd** (not the repo — the CLI eats CLAUDE.md as context), save prompt + output for each. **STOP and show the user the three outputs before any of the steps below.** Do not proceed until approved.

- [ ] **Step 2: Deterministic before/after** (Verification rule): on `$GLADLOG_EVAL_HOME/corpus/manifest-verify.txt`, run per-type candidate counts at the commit before Task 5 and at HEAD; report `crisis-no-response` count, per-round distribution (0/1/2), the number of `death-unused-defensive` rows now carrying `precededBy`, and confirm every other type's count is byte-identical (the wiring must not perturb neighbours).

- [ ] **Step 3: Gate proof** — run `promptQualityCheck` over the same 50 prompts: `checkBehaviorPriorConsistency` failures = 0; plant one wrong `refRespond` in one prompt file and confirm exactly 1 failure.

- [ ] **Step 4: Gradient** — `npx tsx packages/eval/scripts/signalSkillGradientScan.ts scan …` on the new-season manifest (3 shards, nice) then `report`; expect `crisis-no-response` stratified conversion to fall with rank in 3v3 (≈ 40% → 14% per the v4 measurement), flat-ish in Solo. Record the table in the report dir.

- [ ] **Step 5: `npm run presubmit`** from the repo root — must be green. Push.

- [ ] **Step 6: Write the report** `$GLADLOG_EVAL_HOME/reports/crisis-no-response-2026-08-29/README.md` with Steps 1–4's numbers, and append a one-paragraph status to GH #58 (counts of co-occurring `death-unused-defensive` with `precededBy`). Update the memory file `gladlog-behavior-prior-experiment.md` with the landing commit and the numbers.

- [ ] **Step 7: Commit report (eval-private) and push.**

---

## Self-review

- **Spec coverage:** §1 sentence → Task 4 facts + Task 5 legend; §2 predicate + gates 1/2/4 → Task 1 (gate 3 trivially true, documented in the type); §2 red line → Task 3 header + Task 8 runbook; §3 table shape/top10/bins/fallback/refresh/health test → Tasks 2, 3, 8; §4 producer/cap/order/precededBy → Tasks 4, 5; §5 legend + gate + index → Tasks 5, 6, 8; §6 wiring list → Tasks 5, 7, 8 (`curatedIdRegistry` dropped with DPS per the amended spec); §7 verification order → Task 9; §8 not-doing respected (no DPS, no model, no spec dimension).
- **Placeholders:** none; Task 5 Step 1's fixture comments describe the exact data to build; Task 6 fixes the `refTop` separator collision in both producer and gate.
- **Type consistency:** `DecisionPoint` fields used in Tasks 2/4/8 match Task 1; `BehaviorPriorRef` fields used in Tasks 4/6 match Task 3; `dmgBinOf` lives in analysis (Task 3) and is re-exported by eval (Task 2 amended); `refTop` uses "; " in Tasks 4, 6 and 7.
