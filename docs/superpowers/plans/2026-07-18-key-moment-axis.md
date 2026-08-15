# AI Analysis Page "Key Moment Axis" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the AI analysis page to a "vertical key moment axis" single-column narrative layout: system key events and AI finding cards are hung on the central spine interleaved by time, cohort comparison pushed down full width.

**Architecture:** New pure function `derive/keyMoments.ts` (toLegacySafe → analysis predicates, five types of events, single type failure does not bring down the whole) + new component `KeyMomentAxis.tsx` (merge/interleave/ellipsis/point skip); `StructuredAnalysisPanel` replaces horizontal TimelineStrip with the axis, `MatchReport` removes right column.

**Tech Stack:** React + TS (Electron renderer), vitest + @testing-library/react, predicates all from `@gladlog/analysis` existing exports.

## Global Constraints

- Single source of predicates: do not write any new analysis logic, only compose `@gladlog/analysis` exports (spec table caliber).
- renderer can only type-only import from `src/main/*` (v0.0.4 build incident iron rule).
- Each type of event source has independent try/catch (candidateFindings precedent); clipping fixture missing event array must not throw (must go through `toLegacySafe`).
- Time unit: derive output = relative seconds; `onSeekEvent(tSeconds, unitNames)` contract unchanged.
- Push gate: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet` (run in repo root).

---

### Task 1: `derive/keyMoments.ts` (Derivation of Five Types of Key Events)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/keyMoments.ts`
- Test: `packages/desktop/test/report.keymoments.test.ts`

**Interfaces:**

- Consumes: `toLegacySafe` (`./legacySource`); `analyzeBurstLedger, isBurstConverted, reconstructEnemyCDTimeline, extractMajorCooldowns, analyzePlayerCCAndTrinket, reconstructDispelSummary, isHealerSpec, trinketSpellIds` from `@gladlog/analysis`; `CombatUnitReaction` from `@gladlog/parser-compat`.
- Produces (Task 2/3 dependency, verbatim signatures):

```ts
export type KeyMomentKind =
  "death" | "burst-band" | "defensive" | "dispel" | "cc";
export interface KeyMoment {
  t: number; // relative seconds
  toT?: number; // burst-band only
  kind: KeyMomentKind;
  side: "friendly" | "enemy";
  title: string;
  detail?: string;
  unitNames: string[];
  jumpT: number;
}
export function deriveKeyMoments(
  source: ReportSource,
  ownerId?: string,
): KeyMoment[];
```

- [ ] **Step 1: Write failing tests**

```ts
// packages/desktop/test/report.keymoments.test.ts
import { describe, expect, it } from "vitest";
import realMatch from "./fixtures/real-match-sample.json";
import { deriveKeyMoments } from "../src/renderer/src/report/derive/keyMoments";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

const src = realMatch as unknown as ReportSource;

describe("deriveKeyMoments", () => {
  it("clipped fixture does not throw, output sorted ascending by t", () => {
    const ms = deriveKeyMoments(src);
    expect(Array.isArray(ms)).toBe(true);
    for (let i = 1; i < ms.length; i++)
      expect(ms[i].t).toBeGreaterThanOrEqual(ms[i - 1].t);
  });

  it("injected death -> produces death node (side=friendly)", () => {
    const clone = structuredClone(src) as any;
    const friendly = Object.values(clone.units).find(
      (u: any) => u.info && u.reaction === 1,
    ) as any;
    friendly.deathRecords = [
      {
        timestamp: clone.startTime + 42_000,
        logLine: {
          event: "UNIT_DIED",
          timestamp: clone.startTime + 42_000,
          parameters: [],
        },
      },
    ];
    const ms = deriveKeyMoments(clone as ReportSource);
    const death = ms.find((m) => m.kind === "death" && m.side === "friendly");
    expect(death).toBeTruthy();
    expect(Math.round(death!.t)).toBe(42);
    expect(death!.unitNames[0]).toBe(friendly.name);
  });

  it("injected trinket cast -> produces defensive node", () => {
    const clone = structuredClone(src) as any;
    const friendly = Object.values(clone.units).find(
      (u: any) => u.info && u.reaction === 1,
    ) as any;
    friendly.spellCastEvents = [
      ...(friendly.spellCastEvents ?? []),
      {
        spellId: "336126",
        spellName: "Gladiator's Medallion",
        timestamp: clone.startTime + 30_000,
        srcUnitId: friendly.id,
        destUnitId: friendly.id,
        destUnitName: friendly.name,
        logLine: {
          event: "SPELL_CAST_SUCCESS",
          timestamp: clone.startTime + 30_000,
          parameters: [],
        },
      },
    ];
    const ms = deriveKeyMoments(clone as ReportSource);
    expect(
      ms.some((m) => m.kind === "defensive" && m.title.includes("Trinket")),
    ).toBe(true);
  });
});
```

Note: If `reaction === 1` does not match the actual fixture enum value, import and compare with `CombatUnitReaction.Friendly` (same as implementation file); deathRecords injection follows the existing field shapes in `report.deathrecap.test`, fine-tune based on existing tests.

- [ ] **Step 2: Run tests to verify failure**

Run (repo root): `npx vitest run test/report.keymoments.test.ts --root packages/desktop`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement deriveKeyMoments**

```ts
// packages/desktop/src/renderer/src/report/derive/keyMoments.ts
import {
  analyzeBurstLedger,
  analyzePlayerCCAndTrinket,
  extractMajorCooldowns,
  isBurstConverted,
  isHealerSpec,
  reconstructDispelSummary,
  reconstructEnemyCDTimeline,
  trinketSpellIds,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

export type KeyMomentKind =
  "death" | "burst-band" | "defensive" | "dispel" | "cc";

export interface KeyMoment {
  t: number;
  toT?: number;
  kind: KeyMomentKind;
  side: "friendly" | "enemy";
  title: string;
  detail?: string;
  unitNames: string[];
  jumpT: number;
}

const TRINKETS = new Set<string>(trinketSpellIds);
const CC_MIN_S = 3;

/**
 * Key moment axis data (spec: 2026-07-18-ai-analysis-key-moment-axis-design).
 * Five event types, predicates fully reuse analysis; each type has independent try/catch, single-type failure won't fail the whole.
 */
export function deriveKeyMoments(
  source: ReportSource,
  ownerId?: string,
): KeyMoment[] {
  const out: KeyMoment[] = [];
  let legacy: ReturnType<typeof toLegacySafe>;
  try {
    legacy = toLegacySafe(source);
  } catch {
    return out;
  }
  const start = legacy.startTime;
  const rel = (ms: number) => (ms - start) / 1000;
  const units = Object.values(legacy.units);
  const players = units.filter((u) => u.info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  const petsOf = (side: typeof friends) => {
    const ids = new Set(side.map((u) => u.id));
    return units.filter((u) => u.ownerId && ids.has(u.ownerId));
  };
  const friendlyPets = petsOf(friends);
  const enemyPets = petsOf(enemies);
  const owner =
    (ownerId && players.find((u) => u.id === ownerId)) ||
    players.find((u) => u.id === legacy.playerId) ||
    friends[0];

  // death
  try {
    for (const u of players) {
      for (const d of u.deathRecords ?? []) {
        const side =
          u.reaction === CombatUnitReaction.Friendly ? "friendly" : "enemy";
        out.push({
          t: rel(d.timestamp),
          kind: "death",
          side,
          title: side === "friendly" ? "Died" : "Kill",
          unitNames: [u.name],
          jumpT: rel(d.timestamp),
        });
      }
    }
  } catch {
    /* Single-type failure won't fail the whole */
  }

  // burst-band: friendly = owner burst ledger; enemy = aligned burst windows
  try {
    if (owner && !isHealerSpec(owner.spec)) {
      const allies = friends.filter((u) => u.id !== owner.id);
      for (const b of analyzeBurstLedger(owner, allies, enemies, legacy)) {
        const t = b.dominantTarget;
        const converted = t !== null && isBurstConverted(t);
        out.push({
          t: b.fromSeconds,
          toT: b.toSeconds,
          kind: "burst-band",
          side: "friendly",
          title: converted ? "Burst (Converted)" : "Burst (Unconverted)",
          detail: t
            ? `${(t.damage / 1_000_000).toFixed(2)}M on ${t.unitName.split("-")[0]}`
            : undefined,
          unitNames: [owner.name, ...(t ? [t.unitName] : [])],
          jumpT: b.fromSeconds,
        });
      }
    }
  } catch {
    /* Same as above */
  }
  try {
    const tl = reconstructEnemyCDTimeline(enemies, legacy, owner, friends);
    for (const w of tl.alignedBurstWindows) {
      out.push({
        t: w.fromSeconds,
        toT: w.toSeconds,
        kind: "burst-band",
        side: "enemy",
        title: "Enemy Burst",
        detail: w.activeCDs.map((c) => c.spellName).join(" + "),
        unitNames: [...new Set(w.activeCDs.map((c) => c.playerName))],
        jumpT: w.fromSeconds,
      });
    }
  } catch {
    /* Same as above */
  }

  // defensive: friendly major defensive CD casts (non-throughput) + trinket
  try {
    for (const u of friends) {
      for (const cd of extractMajorCooldowns(u, legacy)) {
        if (cd.isThroughput) continue;
        for (const cast of cd.casts) {
          out.push({
            t: cast.timeSeconds,
            kind: "defensive",
            side: "friendly",
            title: cd.spellName,
            detail: cast.timingLabel,
            unitNames: [u.name],
            jumpT: cast.timeSeconds,
          });
        }
      }
      for (const c of u.spellCastEvents ?? []) {
        if (!c.spellId || !TRINKETS.has(c.spellId)) continue;
        out.push({
          t: rel(c.timestamp),
          kind: "defensive",
          side: "friendly",
          title: "Trinket",
          unitNames: [u.name],
          jumpT: rel(c.timestamp),
        });
      }
    }
  } catch {
    /* Same as above */
  }

  // dispel: Critical/High (same source as F163)
  try {
    const ds = reconstructDispelSummary(
      friends,
      enemies,
      legacy,
      friendlyPets,
      enemyPets,
    );
    for (const e of [...ds.allyCleanse, ...ds.ourPurges]) {
      if (e.priority !== "Critical" && e.priority !== "High") continue;
      out.push({
        t: e.timeSeconds,
        kind: "dispel",
        side: "friendly",
        title: `${e.dispelSpellName}(${e.priority})`,
        detail: `Dispelled ${e.removedSpellName}`,
        unitNames: [e.sourceName, e.targetName],
        jumpT: e.timeSeconds,
      });
    }
  } catch {
    /* Same as above */
  }

  // cc: friendly CCed (>=3s or trinket used); CC success (>=3s or target is healer)
  try {
    for (const u of friends) {
      const s = analyzePlayerCCAndTrinket(u, enemies, legacy, enemyPets);
      for (const cc of s.ccInstances) {
        if (cc.durationSeconds < CC_MIN_S && cc.trinketState !== "used")
          continue;
        out.push({
          t: cc.atSeconds,
          kind: "cc",
          side: "enemy",
          title: `CCed: ${cc.spellName}`,
          detail: `${cc.durationSeconds.toFixed(0)}s${cc.trinketState === "used" ? " · Trinket used" : ""}`,
          unitNames: [u.name],
          jumpT: cc.atSeconds,
        });
      }
    }
    for (const e of enemies) {
      const s = analyzePlayerCCAndTrinket(e, friends, legacy, friendlyPets);
      for (const cc of s.ccInstances) {
        if (cc.durationSeconds < CC_MIN_S && !isHealerSpec(e.spec)) continue;
        out.push({
          t: cc.atSeconds,
          kind: "cc",
          side: "friendly",
          title: `CC Success: ${cc.spellName}`,
          detail: `${cc.durationSeconds.toFixed(0)}s → ${e.name.split("-")[0]}`,
          unitNames: [cc.sourceName, e.name],
          jumpT: cc.atSeconds,
        });
      }
    }
  } catch {
    /* Same as above */
  }

  return out.sort((a, b) => a.t - b.t);
}
```

During implementation, fix field names based on tsc errors (e.g., `ICooldownCast.timeSeconds`, `ccInstances` fields); it is **strictly forbidden** to bypass analysis predicates and write custom logic due to type mismatches.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/report.keymoments.test.ts --root packages/desktop`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/derive/keyMoments.ts packages/desktop/test/report.keymoments.test.ts
git commit -m "feat(desktop): deriveKeyMoments -- derivation of 5 key moment event types (predicates fully reused from analysis)"
```

---

### Task 2: `KeyMomentAxis.tsx` (Spine Component) + CSS

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css` (append to end of file)
- Test: `packages/desktop/test/report.keymomentaxis.test.tsx`

**Interfaces:**

- Consumes: Task 1 `KeyMoment`; `Finding`/`CandidateEvent` (`@gladlog/analysis`); FindingsList existing card className (`rpt-finding rpt-finding-{severity}`).
- Produces:

```tsx
export function KeyMomentAxis(props: {
  moments: KeyMoment[];
  findings: Finding[];
  candidates: CandidateEvent[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  /** Pass-through for finding card evidence/follow-up actions (same as FindingsList) */
  onSelectEvidence: (eventIds: string[]) => void;
  flags?: Record<string, string>;
  onFlag?: (key: string, flag: "done" | "recurring" | null) => void;
}): JSX.Element;
```

Merge rules (test-anchored): finding takes the earliest finite t among its eventIds in candidates; findings with unresolvable t are **not rendered** (parent component handles "Match-wide Observations"); nodes + cards are merged in ascending order by t; interleaving = after sorting, even index goes left and odd index goes right (except burst-band, which is rendered on the spine body itself); when delta t of adjacent entries > 30s, insert a `⏱ {Math.round(dt)}s` gap indicator (`data-testid="axis-gap"`).

- [ ] **Step 1: Write failing tests**

```tsx
// packages/desktop/test/report.keymomentaxis.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyMomentAxis } from "../src/renderer/src/report/components/KeyMomentAxis";
import type { KeyMoment } from "../src/renderer/src/report/derive/keyMoments";

const moments: KeyMoment[] = [
  {
    t: 10,
    kind: "defensive",
    side: "friendly",
    title: "Trinket",
    unitNames: ["A"],
    jumpT: 10,
  },
  {
    t: 90,
    kind: "death",
    side: "friendly",
    title: "Died",
    unitNames: ["B"],
    jumpT: 90,
  },
];
const candidates = [
  { id: "e1", type: "death", t: 41, unitNames: ["B"], facts: {} },
] as never[];
const findings = [
  {
    eventIds: ["e1"],
    severity: "high",
    category: "survival",
    title: "Burst Down",
    explanation: "x",
  },
  {
    eventIds: ["nope"],
    severity: "low",
    category: "cooldowns",
    title: "Unused all match",
    explanation: "y",
  },
] as never[];

describe("KeyMomentAxis", () => {
  it("merges and sorts by t, findings attached to resolved timestamp; findings without t are not rendered", () => {
    render(
      <KeyMomentAxis
        moments={moments}
        findings={findings}
        candidates={candidates}
        onSelectEvidence={() => {}}
      />,
    );
    const nodes = screen.getAllByTestId("axis-node");
    // 10s trinket -> 41s finding -> 90s death
    expect(nodes.length).toBe(3);
    expect(nodes[1].textContent).toContain("Burst Down");
    expect(screen.queryByText("Unused all match")).toBeNull();
  });

  it("inserts gap indicator when adjacent > 30s; clicking node triggers onSeek callback", () => {
    const onSeek = vi.fn();
    render(
      <KeyMomentAxis
        moments={moments}
        findings={[]}
        candidates={[]}
        onSeek={onSeek}
        onSelectEvidence={() => {}}
      />,
    );
    expect(screen.getAllByTestId("axis-gap").length).toBe(1); // 10->90 = 80s
    fireEvent.click(screen.getAllByTestId("axis-node")[0]);
    expect(onSeek).toHaveBeenCalledWith(10, ["A"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run test/report.keymomentaxis.test.tsx --root packages/desktop`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement component**

```tsx
// packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx
import type { CandidateEvent, Finding } from "@gladlog/analysis";

import { findingKey } from "../../../../shared/findingKey";
import type { KeyMoment } from "../derive/keyMoments";

const GAP_S = 30;
const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;

const KIND_ICON: Record<KeyMoment["kind"], string> = {
  death: "✕",
  "burst-band": "▮",
  defensive: "🛡",
  dispel: "♱",
  cc: "◎",
};

type Entry =
  | { at: number; kind: "moment"; m: KeyMoment }
  | { at: number; kind: "finding"; f: Finding };

/** Key moment axis: static narrative spine, system events and finding cards interleaved by time, clickable to jump and replay. */
export function KeyMomentAxis({
  moments,
  findings,
  candidates,
  onSeek,
  onSelectEvidence,
  flags,
  onFlag,
}: {
  moments: KeyMoment[];
  findings: Finding[];
  candidates: CandidateEvent[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  onSelectEvidence: (eventIds: string[]) => void;
  flags?: Record<string, string>;
  onFlag?: (key: string, flag: "done" | "recurring" | null) => void;
}) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const entries: Entry[] = [
    ...moments.map((m): Entry => ({ at: m.t, kind: "moment", m })),
    ...findings.flatMap((f): Entry[] => {
      const ts = (f.eventIds ?? [])
        .map((id) => byId.get(id)?.t)
        .filter((t): t is number => Number.isFinite(t));
      return ts.length ? [{ at: Math.min(...ts), kind: "finding", f }] : [];
    }),
  ].sort((a, b) => a.at - b.at);

  let flip = 0;
  let prevAt: number | null = null;
  return (
    <div className="rpt-axis" data-testid="key-moment-axis">
      {entries.map((e, i) => {
        const gap =
          prevAt !== null && e.at - prevAt > GAP_S ? e.at - prevAt : null;
        prevAt = e.at;
        // burst-band rendered on the spine body, does not participate in left/right alternation
        const band = e.kind === "moment" && e.m.kind === "burst-band";
        const side = band ? "band" : flip++ % 2 === 0 ? "left" : "right";
        return (
          <div key={i} className={`rpt-axis-row ${side}`}>
            {gap !== null && (
              <div className="rpt-axis-gap" data-testid="axis-gap">
                ⏱ {Math.round(gap)}s without key events
              </div>
            )}
            {e.kind === "moment" ? (
              <button
                className={`rpt-axis-node k-${e.m.kind} s-${e.m.side}`}
                data-testid="axis-node"
                onClick={
                  onSeek ? () => onSeek(e.m.jumpT, e.m.unitNames) : undefined
                }
              >
                <span className="rpt-axis-time">{mmss(e.at)}</span>
                <span className="rpt-axis-icon">{KIND_ICON[e.m.kind]}</span>
                <span className="rpt-axis-title">{e.m.title}</span>
                {e.m.detail && (
                  <span className="rpt-axis-detail">{e.m.detail}</span>
                )}
                {band && e.m.toT != null && (
                  <span className="rpt-axis-detail">
                    {mmss(e.at)}–{mmss(e.m.toT)}
                  </span>
                )}
              </button>
            ) : (
              <div
                className={`rpt-finding rpt-finding-${e.f.severity} rpt-axis-finding`}
                data-testid="axis-node"
              >
                <span className="rpt-axis-time">{mmss(e.at)}</span>
                <div className="rpt-finding-head">
                  <span className="rpt-finding-sev">
                    {e.f.severity} · {e.f.category}
                  </span>
                  <span className="rpt-finding-title">{e.f.title}</span>
                </div>
                <p className="rpt-finding-body">{e.f.explanation}</p>
                <div className="rpt-finding-ev">
                  <button onClick={() => onSelectEvidence(e.f.eventIds)}>
                    Evidence
                  </button>
                  {onSeek && (
                    <button
                      className="rpt-finding-jump"
                      onClick={() => {
                        const ev = byId.get(e.f.eventIds[0]);
                        onSeek(e.at, ev?.unitNames ?? []);
                      }}
                    >
                      ▶ Replay Moment
                    </button>
                  )}
                  {onFlag &&
                    (() => {
                      const key = findingKey(e.f);
                      const cur = flags?.[key];
                      return (
                        <span className="rpt-finding-flags">
                          <button
                            className={cur === "done" ? "active" : ""}
                            onClick={() =>
                              onFlag(key, cur === "done" ? null : "done")
                            }
                          >
                            ✓ Done
                          </button>
                          <button
                            className={cur === "recurring" ? "active rec" : ""}
                            onClick={() =>
                              onFlag(
                                key,
                                cur === "recurring" ? null : "recurring",
                              )
                            }
                          >
                            ↻ Recurring
                          </button>
                        </span>
                      );
                    })()}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: CSS (append to end of styles.css)**

```css
/* ── Key Moment Axis (AI Analysis Page Spine) ── */
.rpt-axis {
  position: relative;
  margin: 14px 0;
  padding: 4px 0;
}
.rpt-axis::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--hairline);
}
.rpt-axis-row {
  position: relative;
  display: flex;
  margin: 6px 0;
}
.rpt-axis-row.left {
  justify-content: flex-start;
  padding-right: calc(50% + 14px);
}
.rpt-axis-row.right {
  justify-content: flex-end;
  padding-left: calc(50% + 14px);
}
.rpt-axis-row.band {
  justify-content: center;
}
.rpt-axis-row.left > * {
  margin-left: auto;
}
.rpt-axis-row.right > * {
  margin-right: auto;
}
.rpt-axis-gap {
  position: absolute;
  left: 50%;
  top: -4px;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--mute);
  background: var(--bg);
  padding: 0 6px;
  white-space: nowrap;
}
.rpt-axis-node {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--surface);
  padding: 4px 10px;
  font-size: 12px;
  color: var(--ink);
  text-align: left;
}
.rpt-axis-node:hover {
  border-color: var(--gold-dim);
}
.rpt-axis-time {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
  color: var(--mute);
  font-size: 11px;
}
.rpt-axis-node.k-death.s-friendly {
  border-left: 3px solid var(--loss);
}
.rpt-axis-node.k-death.s-enemy {
  border-left: 3px solid var(--win);
}
.rpt-axis-node.k-cc.s-enemy {
  border-left: 3px solid var(--loss);
}
.rpt-axis-node.k-cc.s-friendly {
  border-left: 3px solid var(--win);
}
.rpt-axis-node.k-burst-band.s-friendly {
  background: color-mix(in srgb, var(--win) 10%, var(--surface));
}
.rpt-axis-node.k-burst-band.s-enemy {
  background: color-mix(in srgb, var(--loss) 10%, var(--surface));
}
.rpt-axis-detail {
  color: var(--ink-2);
  font-size: 11px;
}
.rpt-axis-finding {
  max-width: 46%;
}
.rpt-axis-finding .rpt-axis-time {
  display: block;
  margin-bottom: 2px;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run test/report.keymomentaxis.test.tsx --root packages/desktop`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx packages/desktop/src/renderer/src/styles.css packages/desktop/test/report.keymomentaxis.test.tsx
git commit -m "feat(desktop): KeyMomentAxis component -- alternating spine/gap indicator/point jump"
```

---

### Task 3: Wiring (StructuredAnalysisPanel axis swap, MatchReport single column, match-wide observations)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (AI view `rpt-ai-full` area)
- Modify: `packages/desktop/src/renderer/src/styles.css` (`.rpt-ai-full` changed to single column)
- Test: Update affected assertions (`StructuredAnalysisPanel.test.tsx`, etc., fix whichever fails)

**Interfaces:**

- Consumes: Task 1 `deriveKeyMoments(source, ownerId?)`, Task 2 `KeyMomentAxis`.
- Produces: No new exports; page structure = goals/MatchHero → KeyMomentAxis → Match-wide Observations (findings without t rendered with existing FindingsList) → full width cohort.

- [ ] **Step 1: StructuredAnalysisPanel axis swap**

Inside the component (result rendering branch):

```tsx
// Imports additions
import { KeyMomentAxis } from "./KeyMomentAxis";
import { deriveKeyMoments } from "../derive/keyMoments";
// Delete TimelineStrip import

// Inside component body (after input useMemo)
const keyMoments = useMemo(() => deriveKeyMoments(source), [source]);

// Rendering: remove <TimelineStrip .../> block, replace in-place with:
const withT = new Set(
  (input?.candidates ?? [])
    .filter((c) => Number.isFinite(c.t) && c.t > 0)
    .map((c) => c.id),
);
const timedFindings = result.findings.filter((f) =>
  f.eventIds?.some((id) => withT.has(id)),
);
const wholeRound = result.findings.filter((f) => !timedFindings.includes(f));
// ...
<KeyMomentAxis
  moments={keyMoments}
  findings={timedFindings}
  candidates={input?.candidates ?? []}
  onSeek={onSeekEvent}
  onSelectEvidence={setActiveEventIds}
  flags={flags}
  onFlag={handleFlag}
/>;
{
  wholeRound.length > 0 && (
    <>
      <h4 className="rpt-card-label" style={{ marginTop: 12 }}>
        Match-wide Observations
      </h4>
      <FindingsList
        findings={wholeRound}
        onSelect={setActiveEventIds}
        candidates={input?.candidates ?? []}
        flags={flags}
        onFlag={handleFlag}
      />
    </>
  );
}
```

Note: If `activeEventIds` related TimelineStrip highlight logic only served the strip, remove it along with the strip; `handleJump` is retained for reuse by "Match-wide Observations" and in-axis onSeek. Findings with t no longer go through FindingsList (to prevent duplicate rendering).

- [ ] **Step 2: MatchReport single column + cohort sink**

`MatchReport.tsx` AI view area:

```tsx
// Before:
// <div className="rpt-ai-full">
//   <div className="rpt-ai-main"><StructuredAnalysisPanel ... /></div>
//   <aside className="rpt-ai-side"><ProComparisonVerified ... /></aside>
// </div>
// Change to:
<div className="rpt-ai-full">
  <div className="rpt-ai-main">
    <StructuredAnalysisPanel ... /* Keep original props unchanged */ />
    <ProComparisonVerified source={source} matchId={resolvedMatchId} />
  </div>
</div>
```

styles.css:

```css
.rpt-ai-full {
  margin-top: 14px;
  display: block;
}
/* Delete .rpt-ai-side related rules or leave as empty stub (delete after grep confirms no other references) */
```

- [ ] **Step 3: Run full gate, fix affected tests**

Run (repo root): `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`
Expected: Only tests asserting the old layout/TimelineStrip should fail — update assertions to match the new structure (axis exists, cohort inside main column); do not regress layout just to pass tests.

- [ ] **Step 4: Headless smoke + stress fixtures**

Run: `npx tsx packages/desktop/scripts/smokeStressFixtures.ts`
Expected: All 4 stress test samples pass (deriveKeyMoments is not in smoke, but component mount path is covered via component tests).

- [ ] **Step 5: Commit + push + CI**

```bash
git add -A
git commit -m "feat(desktop): AI analysis page key moment axis layout -- axis replaces horizontal strip, cohort full width underneath"
git push
RUN=$(gh run list --workflow test.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch --exit-status $RUN
```

Expected: CI success.

---

## Self-Review Notes

- Spec coverage: Five event types (T1), spine/interleaving/gap indicator/point jump (T2), layout and match-wide observations (T3), test checklist mapped item-by-item ✓; "Retain TimelineStrip component file" = T3 only removes AI page references ✓.
- Placeholder scan: All code blocks are complete; note on aligning field names with tsc is a **corrective instruction** rather than a placeholder ✓.
- Type consistency: KeyMoment / deriveKeyMoments / KeyMomentAxis signatures are verbatim consistent across all three places ✓.
