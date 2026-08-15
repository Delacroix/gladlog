# Pressure/Exposure Lanes (backlog #4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pressure lane at the bottom of the battle report Timeline curve area: DMG SPIKE segments (click=set time window, connects to #16) + HEALER EXPOSURE markers, using the same predicates as prompt.

**Architecture:** analysis adds two single-source exports (`DMG_SPIKE_THRESHOLD` exported via package index; `computeHealerExposureEvents` orchestrator encapsulates exposure orchestration, `buildMatchContext` passes pre-computed artifacts to consume the same entry point); desktop adds new derive `pressureLanes.ts` + bottom lane layer in `Timeline.tsx`.

**Tech Stack:** TypeScript, React SVG, vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-pressure-lanes-design.md`
**Working Directory:** Always use worktree `/Users/mingjianliu/code/gladlog-wt-qa` (main; dependencies already installed). The main checkout `/Users/mingjianliu/code/gladlog` is occupied by the user, **absolutely do not touch**.

## Global Constraints

- Commit directly to the main branch of the worktree, and eventually push (project convention); never use naked `cd` in compound commands; never add pipes to the gatekeeping chain.
- Tests must be run with workspace scope (`npm test --workspace=packages/analysis` / `--workspace=packages/desktop`); running single files directly has configuration artifacts.
- The only gatekeeping before push is `npm run presubmit`; visual baseline CI is single-source, absolutely do not run `test:visual` locally.
- Single source for predicates: spike gate = `DMG_SPIKE_THRESHOLD` (already exported in timelineHelpers, just add to package index exports, do not copy value); `computePressureWindows` is called with **default parameters** (same as buildMatchContext:235, do not explicitly pass literals); exposure only goes through one entry point `computeHealerExposureEvents`.
- If prompt has a [DMG SPIKE] segment, the lane must have it, and vice versa (structural guarantee via same gate and parameters).
- Zero changes to `buildMatchContext` behavior (exposure extraction is an equivalent refactor, existing context tests are the regression anchors).

---

### Task 1: analysis — DMG_SPIKE_THRESHOLD Surface Export + computeHealerExposureEvents Orchestrator

**Files:**

- Modify: `packages/analysis/src/utils/healerExposureAnalysis.ts` (add orchestrator at end of file)
- Modify: `packages/analysis/src/context/buildMatchContext.ts:288-303` (call orchestrator, pass precomputed items)
- Modify: `packages/analysis/src/index.ts` (export)
- Test: `packages/analysis/test/healerExposureEvents.test.ts` (new)

**Interfaces:**

- Consumes: Existing `analyzeHealerExposureAtBurst`, `analyzePlayerCCAndTrinket`, `reconstructEnemyCDTimeline(enemies, combat, owner?, friendlies?)`, `isHealerSpec`, `DMG_SPIKE_THRESHOLD` (timelineHelpers:474, value 300_000).
- Produces (consumed by Task 2, via `@gladlog/analysis`):
  - `DMG_SPIKE_THRESHOLD` (index re-export)
  - `computeHealerExposureEvents(combat, pre?): IHealerBurstExposure[]`
  - `IHealerBurstExposure` / `HealerExposureLabel` types (index re-export, verify if already exported)

- [ ] **Step 1: Write failing tests**

`packages/analysis/test/healerExposureEvents.test.ts` (fixture construction references existing synthetic combat style in `test/`; units need `advancedActions` to have coordinates, exposure should be empty when coordinates are missing):

```ts
import { describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD, computeHealerExposureEvents } from "../src";

describe("computeHealerExposureEvents", () => {
  it("no position data (no advancedActions) -> empty array, does not throw", () => {
    // Minimal synthetic combat: 1 friendly healer + 1 enemy, neither has advancedActions
    const combat = mkCombatNoAdvanced(); // Inlined builder per this file
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("no healer (all-DPS team) -> empty array", () => {
    const combat = mkCombatNoHealer();
    expect(computeHealerExposureEvents(combat)).toEqual([]);
  });

  it("pre injection path isomorphic to self-compute path (buildMatchContext equivalence smoke test)", () => {
    // Verifying self-compute path runs (shape assertion), exact equivalence guarded by existing context tests
    const combat = mkCombatNoAdvanced();
    const r = computeHealerExposureEvents(combat, undefined);
    expect(Array.isArray(r)).toBe(true);
  });
});

describe("DMG_SPIKE_THRESHOLD single-source export", () => {
  it("exported from package index with identical value to timelineHelpers", async () => {
    const helpers = await import("../src/context/timelineHelpers");
    expect(DMG_SPIKE_THRESHOLD).toBe(helpers.DMG_SPIKE_THRESHOLD);
  });
});
```

(`mkCombatNoAdvanced`/`mkCombatNoHealer` inlined by implementer following `mkUnit` style in `deepDive.test.ts`: units include `info`/`reaction`/`spec` (e.g., healer uses CombatUnitSpec.Priest_Holy), event arrays empty, `startInfo: { zoneId: "1552" }`, `startTime: 0, endTime: 90_000, playerId: "o"`.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/analysis -- healerExposureEvents`
Expected: FAIL (exports do not exist).

- [ ] **Step 3: Implementation**

End of `healerExposureAnalysis.ts`:

```ts
export interface IHealerExposurePre {
  alignedBurstWindows: IAlignedBurstWindow[];
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  healerUnit: ICombatUnit | undefined;
}

/** Single-source healer exposure orchestration (#4): buildMatchContext passes precomputed items (zero duplicate calculation),
 * renderer computes if omitted (derivation uses shared predicates: analyzePlayerCCAndTrinket /
 * reconstructEnemyCDTimeline). Both paths converge to the same
 * analyzeHealerExposureAtBurst call -- lane and prompt must never diverge. */
export function computeHealerExposureEvents(
  combat: AtomicArenaCombat,
  pre?: IHealerExposurePre,
): IHealerBurstExposure[] {
  const units = Object.values(combat.units ?? {}) as ICombatUnit[];
  const players = units.filter((u) => (u as { info?: unknown }).info);
  const friends = players.filter(
    (u) => u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = players.filter(
    (u) => u.reaction !== CombatUnitReaction.Friendly,
  );
  if (friends.length === 0 || enemies.length === 0) return [];

  const healerUnit =
    pre !== undefined
      ? pre.healerUnit
      : friends.find((p) => isHealerSpec(p.spec));
  if (!healerUnit) return [];

  let alignedBurstWindows: IAlignedBurstWindow[];
  let ccTrinketSummaries: IPlayerCCTrinketSummary[];
  if (pre) {
    ({ alignedBurstWindows, ccTrinketSummaries } = pre);
  } else {
    // owner resolution mirrors renderer/buildAnalysisInput caliber: playerId preferred, healer fallback
    const owner =
      friends.find(
        (u) => u.id === (combat as { playerId?: string }).playerId,
      ) ?? healerUnit;
    const enemyIds = new Set(enemies.map((u) => u.id));
    const enemyPets = units.filter(
      (u) =>
        (u as { ownerId?: string }).ownerId &&
        enemyIds.has((u as { ownerId?: string }).ownerId!),
    );
    ccTrinketSummaries = friends.map((p) =>
      analyzePlayerCCAndTrinket(p, enemies, combat, enemyPets),
    );
    alignedBurstWindows = reconstructEnemyCDTimeline(
      enemies,
      combat,
      owner,
      friends,
    ).alignedBurstWindows;
  }

  const healerCCSummary = ccTrinketSummaries.find(
    (s) => s.playerName === healerUnit.name,
  );
  if (!healerCCSummary) return [];

  try {
    return analyzeHealerExposureAtBurst(
      alignedBurstWindows,
      enemies,
      healerUnit,
      healerCCSummary,
      ccTrinketSummaries,
      combat.startInfo?.zoneId ?? "",
      combat.startTime,
    );
  } catch {
    return []; // Missing advanced logs/geometry -> graceful fallback
  }
}
```

(Imports need `analyzePlayerCCAndTrinket`, `reconstructEnemyCDTimeline`, `isHealerSpec`, `CombatUnitReaction`, and related types — beware of circular dependencies: safe if `enemyCDs`/`ccTrinketAnalysis` are already in this file's dependency chain; if a cycle occurs, move orchestrator to new file `utils/healerExposureEvents.ts` and document in report.)

Equivalent replacement in `buildMatchContext.ts:288-303`:

```ts
const healerUnit = friends.find((p) => isHealerSpec(p.spec)) as
  ICombatUnit | undefined;
const healerExposures = computeHealerExposureEvents(combat, {
  alignedBurstWindows: enemyCDTimeline.alignedBurstWindows,
  ccTrinketSummaries,
  healerUnit,
});
```

(Retain original `healerCCSummary` local variable definition if used elsewhere; orchestrator finds it internally.)

`index.ts`: re-export `DMG_SPIKE_THRESHOLD` (from `./context/timelineHelpers`), `computeHealerExposureEvents`, `IHealerBurstExposure`, `HealerExposureLabel` (if the latter two are covered by `export *`, skip after verification and document in report).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test --workspace=packages/analysis` (full run — context tests anchor buildMatchContext equivalent refactoring) + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(analysis): single-source healer exposure orchestration computeHealerExposureEvents + surface DMG_SPIKE_THRESHOLD (#4)"
```

---

### Task 2: desktop — derive/pressureLanes.ts

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/pressureLanes.ts`
- Test: `packages/desktop/test/pressureLanes.test.ts` (new; node environment sufficient, pure derive)

**Interfaces:**

- Consumes: `computePressureWindows`, `DMG_SPIKE_THRESHOLD`, `computeHealerExposureEvents` (Task 1), `toLegacySafe`, `CombatUnitReaction`.
- Produces (consumed by Task 3):

```ts
export interface PressureBand {
  fromS: number;
  toS: number;
  targetName: string;
  totalDamage: number;
  /** k DPS computed over rounded second window duration (>=1), matching [DMG SPIKE] row caliber. */
  dpsK: number;
}
export interface ExposureMark {
  tS: number;
  label: "Critical" | "Exposed" | "Pressured"; // Safe is omitted from lane
  /** Hover tooltip (Chinese, formatted by derive): threat count / trinket state / LoS cover distance. */
  title: string;
}
export function derivePressureLanes(source: ReportSource): {
  spikes: PressureBand[];
  exposures: ExposureMark[];
};
```

- [ ] **Step 1: Write failing tests**

`test/pressureLanes.test.ts` (real clipped fixture `test/fixtures/real-match-sample.json` — 90s real 3v3 with damageIn; death/healing arrays stripped):

```ts
import { describe, expect, it } from "vitest";
import { DMG_SPIKE_THRESHOLD } from "@gladlog/analysis";
import realMatch from "./fixtures/real-match-sample.json";
import { derivePressureLanes } from "../src/renderer/src/report/derive/pressureLanes";
import type { ReportSource } from "../src/renderer/src/report/derive/types";

const src = realMatch as unknown as ReportSource;

describe("derivePressureLanes", () => {
  it("all spikes exceed threshold gate, timestamps are relative seconds within match duration", () => {
    const { spikes } = derivePressureLanes(src);
    const durS = (src.endTime - src.startTime) / 1000;
    for (const s of spikes) {
      expect(s.totalDamage).toBeGreaterThanOrEqual(DMG_SPIKE_THRESHOLD);
      expect(s.fromS).toBeGreaterThanOrEqual(0);
      expect(s.toS).toBeLessThanOrEqual(durS + 10); // Window right edge = start + 10s, allowed near boundary
      expect(s.dpsK).toBeGreaterThan(0);
    }
  });

  it("dpsK matches [DMG SPIKE] row caliber (Math.round(total/max(1,round(to-from))/1000))", () => {
    const { spikes } = derivePressureLanes(src);
    for (const s of spikes) {
      const windowSec = Math.round(s.toS - s.fromS);
      expect(s.dpsK).toBe(
        Math.round(s.totalDamage / Math.max(1, windowSec) / 1000),
      );
    }
  });

  it("clipped fixture (with or without advancedActions) does not throw; exposures is an array", () => {
    const { exposures } = derivePressureLanes(src);
    expect(Array.isArray(exposures)).toBe(true);
    for (const e of exposures) {
      expect(["Critical", "Exposed", "Pressured"]).toContain(e.label);
      expect(e.title.length).toBeGreaterThan(0);
    }
  });

  it("empty source (empty units) -> empty arrays without throwing", () => {
    const empty = { ...src, units: {} } as unknown as ReportSource;
    expect(derivePressureLanes(empty)).toEqual({ spikes: [], exposures: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/desktop -- pressureLanes`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implementation**

```ts
import {
  DMG_SPIKE_THRESHOLD,
  computeHealerExposureEvents,
  computePressureWindows,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { toLegacySafe } from "./legacySource";
import type { ReportSource } from "./types";

// …PressureBand/ExposureMark interfaces (see Interfaces block, as-is)…

/** Pressure lanes derive (#4): spike gate/window uses same predicates as [DMG SPIKE] prompt row
 * (DMG_SPIKE_THRESHOLD + computePressureWindows default params), any segment in prompt
 * is guaranteed in lane. exposure routes through single computeHealerExposureEvents entry point,
 * missing coordinates fall back gracefully. */
export function derivePressureLanes(source: ReportSource): {
  spikes: PressureBand[];
  exposures: ExposureMark[];
} {
  try {
    const legacy = toLegacySafe(source);
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    if (friends.length === 0) return { spikes: [], exposures: [] };

    const spikes: PressureBand[] = computePressureWindows(friends, legacy)
      .filter((pw) => pw.totalDamage >= DMG_SPIKE_THRESHOLD)
      .map((pw) => {
        const windowSec = Math.round(pw.toSeconds - pw.fromSeconds);
        return {
          fromS: pw.fromSeconds,
          toS: pw.toSeconds,
          targetName: pw.targetName,
          totalDamage: pw.totalDamage,
          // Same caliber: emitDmgSpikeEntries dpsK formula (B20 guards Infinity)
          dpsK: Math.round(pw.totalDamage / Math.max(1, windowSec) / 1000),
        };
      });

    const exposures: ExposureMark[] = computeHealerExposureEvents(legacy)
      .filter((e) => e.exposureLabel !== "Safe")
      .map((e) => {
        const exposed = e.threats.filter((t) => !t.losBlocked).length;
        const trinket =
          e.trinketState === "available"
            ? "饰品在手"
            : e.trinketState === "passive"
              ? "被动饰品"
              : "饰品转 CD";
        const los =
          e.losBreak && e.losBreak.repositionYards <= 30
            ? `;LoS 掩体 ~${e.losBreak.repositionYards} 码`
            : "";
        return {
          tS: e.atSeconds,
          label: e.exposureLabel as ExposureMark["label"],
          title: `治疗暴露(${e.exposureLabel})· ${exposed} 威胁在 LoS · ${trinket}${los}`,
        };
      });

    return { spikes, exposures };
  } catch {
    return { spikes: [], exposures: [] };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/desktop/src/renderer/src/report/derive/pressureLanes.ts packages/desktop/test/pressureLanes.test.ts
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(desktop): pressureLanes derive (spike matching gate/params + exposure single entry point, #4)"
```

---

### Task 3: desktop — Timeline Lane Layer + Click to Set Window + MatchReport Wiring

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/Timeline.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx` (pass lanes)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Test: `packages/desktop/test/pressureLanes.render.test.tsx` (new, `// @vitest-environment jsdom`)

**Interfaces:**

- Consumes: Task 2 `derivePressureLanes/PressureBand/ExposureMark`; Timeline existing `onRangeSelect?: (fromS, toS) => void`, layout constants `W=800, H (see file for current value), PAD={l:34,r:8,t:18,b:18}`, x axis as absolute ms (`x(data.start + tS*1000)` conversion).
- Produces: `Timeline` new optional props `pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] }` (omitted by default, backwards compatible).

- [ ] **Step 1: Write failing tests**

`test/pressureLanes.render.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/renderer/src/report/components/Timeline";

// Minimal data: series and deaths are not required -- only start/end need to be valid
const data = { start: 0, end: 90_000, series: [], deaths: [] } as never;

describe("Timeline pressure lanes", () => {
  const pressure = {
    spikes: [
      {
        fromS: 30,
        toS: 40,
        targetName: "P2-R",
        totalDamage: 1_200_000,
        dpsK: 120,
      },
    ],
    exposures: [
      {
        tS: 35,
        label: "Critical" as const,
        title: "治疗暴露(Critical)· 2 威胁在 LoS · 饰品转 CD",
      },
    ],
  };

  it("renders spike rect and exposure marker when pressure is passed; omitted by default", () => {
    const { container, rerender } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
      />,
    );
    expect(
      container.querySelectorAll('[data-testid="pressure-spike"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="pressure-exposure"]'),
    ).toHaveLength(1);
    rerender(
      <Timeline data={data} hidden={new Set()} onSelectUnit={() => {}} />,
    );
    expect(
      container.querySelector('[data-testid="pressure-spike"]'),
    ).toBeNull();
  });

  it("clicking spike rect -> onRangeSelect(fromS, toS)", () => {
    const onRangeSelect = vi.fn();
    const { container } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
        onRangeSelect={onRangeSelect}
      />,
    );
    fireEvent.click(container.querySelector('[data-testid="pressure-spike"]')!);
    expect(onRangeSelect).toHaveBeenCalledWith(30, 40);
  });

  it("spike rect title contains pressured target and magnitude; exposure title passed through", () => {
    const { container } = render(
      <Timeline
        data={data}
        hidden={new Set()}
        onSelectUnit={() => {}}
        pressure={pressure}
      />,
    );
    expect(
      container.querySelector('[data-testid="pressure-spike"] title')
        ?.textContent,
    ).toMatch(/P2.*1\.20M.*120k/);
    expect(
      container.querySelector('[data-testid="pressure-exposure"] title')
        ?.textContent,
    ).toContain("治疗暴露");
  });
});
```

(Timeline required props follow actual signature — if `onDeathClick` etc. are needed, supply empty functions in tests; align with component file.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/desktop -- pressureLanes.render`
Expected: FAIL (no pressure prop).

- [ ] **Step 3: Implementation**

`Timeline.tsx`:

- Props adds `pressure?: { spikes: PressureBand[]; exposures: ExposureMark[] };` (type imported from derive).
- Constant `const LANE_H = 8;`, lane y range: `[H - PAD.b - LANE_H, H - PAD.b]` (drawn at bottom edge of plot area, without altering H or shrinking curves).
- Render layer placed after bands and before curve paths (semi-transparent rects can sit beneath curves):

```tsx
{
  (pressure?.spikes ?? []).map((s, i) => {
    const x1 = x(data.start + s.fromS * 1000);
    const x2 = x(data.start + s.toS * 1000);
    const dmgM = (s.totalDamage / 1_000_000).toFixed(2);
    const mm = (v: number) =>
      `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
    return (
      <rect
        key={`ps${i}`}
        data-testid="pressure-spike"
        className="rpt-pressure-spike"
        x={x1}
        width={Math.max(3, x2 - x1) /* minimum width following bands precedent */}
        y={H - PAD.b - LANE_H}
        height={LANE_H}
        onClick={
          onRangeSelect ? () => onRangeSelect(s.fromS, s.toS) : undefined
        }
        style={{ cursor: onRangeSelect ? "pointer" : undefined }}
      >
        <title>{`${mm(s.fromS)}–${mm(s.toS)} ${s.targetName.split("-")[0]} under pressure ${dmgM}M (${s.dpsK}k DPS)${onRangeSelect ? " (Click to set time window)" : ""}`}</title>
      </rect>
    );
  });
}
{
  (pressure?.exposures ?? []).map((e, i) => {
    const cx = x(data.start + e.tS * 1000);
    const cy = H - PAD.b - LANE_H / 2;
    return (
      <path
        key={`pe${i}`}
        data-testid="pressure-exposure"
        className={`rpt-pressure-exposure rpt-pressure-exposure-${e.label.toLowerCase()}`}
        d={`M ${cx} ${cy - 5} L ${cx + 4} ${cy} L ${cx} ${cy + 5} L ${cx - 4} ${cy} Z`}
      >
        <title>{e.title}</title>
      </path>
    );
  });
}
```

`MatchReport.tsx`: `const pressure = useMemo(() => derivePressureLanes(source), [source]);` passed to `<Timeline … pressure={pressure} />` (component already connects onRangeSelect to setTimeRange — clicking spike sets window directly, zero new callbacks).

`styles.css`:

```css
/* Pressure lanes (#4): thin bottom strip, layered distinct from full-height offensive bands */
.rpt-pressure-spike {
  fill: rgba(239, 83, 80, 0.45);
}
.rpt-pressure-spike:hover {
  fill: rgba(239, 83, 80, 0.7);
}
.rpt-pressure-exposure-critical {
  fill: #ef5350;
}
.rpt-pressure-exposure-exposed {
  fill: #ffa726;
}
.rpt-pressure-exposure-pressured {
  fill: #ffee58;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test --workspace=packages/desktop` + `npm run typecheck` + `npx eslint packages/desktop/src --quiet`
Expected: All green.

- [ ] **Step 5: Visual acceptance via run-ui**

dev:ui (worktree, auto-selects port if 5199 is occupied) real fixture: bottom lane displays red rectangles and diamonds; hover shows Chinese tooltips; clicking red rect sets time window to that segment and reveals "Analyze Window with AI" button (#16 closed loop verified). Archive screenshot.

- [ ] **Step 6: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add packages/desktop
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "feat(desktop): Timeline pressure lanes (spike click sets window connecting to #16 + exposure markers, #4)"
```

---

### Task 4: Gatekeeping, Push, CI, Visual Baseline, Backlog Reconciliation

**Files:**

- Modify: `docs/BACKLOG.md` (#4 title row ✅)
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png` (CI generated manual review)

- [ ] **Step 1: presubmit**

Run: `(cd /Users/mingjianliu/code/gladlog-wt-qa && npm run presubmit)`
Expected: All green; report any failures truthfully without skipping steps.

- [ ] **Step 2: Backlog reconciliation + push**

In `docs/BACKLOG.md` under `## 4. Burst-window analysis timeline (visual)` header line, add:
`✅(2026-07-29 implemented: battle report Timeline bottom pressure lanes DMG SPIKE click to set window connecting to #16 + HEALER EXPOSURE markers; TimelineStrip sync left for follow-up; spec docs/superpowers/specs/2026-07-29-pressure-lanes-design.md)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-qa add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-qa commit -m "docs: reconcile backlog #4"
git -C /Users/mingjianliu/code/gladlog-wt-qa push
```

- [ ] **Step 3: Monitor CI by headSha**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-qa rev-parse HEAD)
(cd /Users/mingjianliu/code/gladlog-wt-qa && gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
# If empty, wait 20s and recheck; once ID obtained, gh run watch <id> --exit-status
```

test job must pass; frontend-qa red due to report-battle/report-window/report-synth baseline diffs is expected → proceed to Step 4.

- [ ] **Step 4: Regenerate visual baseline (CI single-source manual review)**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-qa && gh workflow run visual-baseline.yml --ref main)
# Poll until completed, then download and compare (same recipe as #15/#16)
```

Review DIFF image by image: changes must be explainable as "Timeline bottom adds pressure lane (red rects/diamonds)", other areas untouched. After approval, overwrite with cp, commit, push, return to Step 3 to verify green.

- [ ] **Step 5: Report acceptance metrics**

On the same fixture: lane rect count = prompt [DMG SPIKE] row count (same gate/params criterion); clicking rect sets window start/end matching rect bounds; pre-change lane had 0 elements.

---

## Self-Review Notes (Run Before Finalizing)

1. **Spec coverage**: Threshold surface + orchestrator (T1), derive same gate/params + exposure single entry + defensiveness (T2), lane visuals / click window / hover / styling (T3), baseline / reconciliation / consistency criteria (T4). "Window params equivalence" satisfied via "both use default params" (buildMatchContext:235 is default invocation, no literal to share).
2. **Placeholders**: T1 fixture builder points to existing mkUnit style with complete field list; T3 test notes "required props follow actual signature" — references to existing code rather than TBDs.
3. **Type consistency**: `PressureBand/ExposureMark` defined in T2, imported in T3; `pressure` prop shape matches derive return type; `computeHealerExposureEvents(combat, pre?)` consistent across T1/T2.
