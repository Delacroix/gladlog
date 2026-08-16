# AI Analysis Page "Key Moment Axis" Rearrangement — Design

Date: 2026-07-18 · Status: Verbal approval from user obtained, pending spec review

## Problem

The AI analysis page currently has two columns (left: goals + horizontal TimelineStrip + findings; right: 460px fixed
cohort). User feedback: structured analysis area is too empty, findings area is too small to fit everything; they want a
narrative structure with key moments as the skeleton.

## Decision Record (User selected case by case)

1. **Positioning of the Axis**: Static narrative axis, nodes are clickable → switch to replay view and locate (reuse existing
   `onSeekEvent(tSeconds, unitNames)` evidence chain jump); AI analysis page does not embed a playback clock.
2. **Content on the Axis**: Death + burst cycle bands, defensive investments (trinkets/major defensives/externals),
   key dispels + successful CC/being CC'd. Interrupts do not go on the axis (still visible when cited by finding).
3. **Layout**: Axis as the spine, finding cards and system annotations alternate left and right by time; cohort sinks from the right column
   to a full-width bottom area; right fixed column is canceled.
4. **Scale**: Events are compactly arranged, time serves only as node labels; if adjacent node time difference >30s, insert
   "⏱ Ns no key events" ellipsis. Do not make a true proportional scale.

## Page Structure (Top to Bottom)

```
[Match goals + MatchHero]           ← Unchanged
[KeyMomentAxis Key Moment Axis]     ← New, full width, replaces horizontal TimelineStrip in AI page
[Whole Match Observations]          ← finding without t (cd-waste etc.) pinned under the axis
[ProComparisonVerified cohort]      ← Full width bottom
```

## Data Layer: `derive/keyMoments.ts` (Pure Function)

```ts
export type KeyMomentKind =
  "death" | "burst-band" | "defensive" | "dispel" | "cc";
export interface KeyMoment {
  t: number; // Relative seconds
  toT?: number; // For burst-band only (band type)
  kind: KeyMomentKind;
  side: "friendly" | "enemy";
  title: string; // e.g. "Trinket used", "Ice Block", "Purify(Critical)"
  detail?: string; // e.g. "Unconverted · 0.52M on Priest", "DR: Stun Full"
  unitNames: string[];
  jumpT: number; // Jump seconds (= t)
}
export function deriveKeyMoments(
  source: ReportSource,
  ownerId?: string,
): KeyMoment[];
```

Sources all reuse existing analysis predicates (`toLegacySafe` direct call, predicate single source iron rule):

| kind | Predicate Source | Density Caliber |
| ---- | ---------------- | --------------- |
| death | unit.deathRecords (only players with COMBATANT_INFO) | Include all |
| burst-band | `analyzeBurstLedger` (bidirectional for owner and enemy) | Include all; `isBurstConverted` marks conversion |
| defensive | `extractMajorCooldowns` casts + trinket (trinketSpellIds cast) + EXTERNAL_DEFENSIVE_IDS | Include all (inherently low volume) |
| dispel | `reconstructDispelSummary` allyCleanse/ourPurges | Only Critical/High (F163 homologous) |
| cc | `analyzePlayerCCAndTrinket` ccInstances (bidirectional) | Enemy CC'd: duration ≥3s or target is healer; Friendly CC'd: duration ≥3s or triggered trinket |

Failure resilience: Independent try/catch for each source category, failure in a single category does not drag down the whole axis (candidateFindings precedent).

## Component Layer: `KeyMomentAxis.tsx`

- Input: `moments: KeyMoment[]`, `findings: Finding[]`, `candidates` (to parse
  finding time), `onSeek`.
- Merge: findings take the earliest t of their respective eventIds, merge with moments and sort ascending by t; finding
  without t goes into "Whole Match Observations" rendered by parent component.
- Alternate: nodes are numbered sequentially, even left / odd right; burst-band is drawn on the spine itself (color band),
  does not participate in alternation.
- Node rendering: m:ss + kind icon + title (+detail second line); finding card reuses existing
  card style (time chip/follow-up marker retained), colored border indicates severity (high red/med gold/low gray),
  no longer sorted by severity.
- Gap ellipsis: When adjacent t difference >30s, draw thin "⏱ Ns" on the spine.
- Click any node/card → `onSeek(jumpT, unitNames)`.

## Layout Changes

- `MatchReport`: AI view removes `<aside class="rpt-ai-side">`, cohort moved to the end of the main
  column; `.rpt-ai-full` changed to single column.
- `StructuredAnalysisPanel`: TimelineStrip removed from AI page (its activeEventIds
  highlighting responsibility taken over by axis node selected state); goals/MatchHero/streaming preview unchanged.
- TimelineStrip component retained (do not delete file if other views/tests are still using it).

## Testing

- `keyMoments.test.ts`: Real fixture + clone injection (death/trinket/dispel) case-by-case assertion;
  trimmed fixture lacking event array does not throw (toLegacySafe already guarantees this, add assertion).
- `KeyMomentAxis.test.tsx`: Merge sort, left/right alternate, gap ellipsis, click callback,
  finding without t does not enter axis.
- Existing faithfulness/cohort tests unaffected (tables untouched).

## Not Doing (YAGNI)

- Playback clock synchronization, true proportional / mixed segmented scale, interrupt type nodes, filter on axis.
