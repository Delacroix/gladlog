# Pressure / Exposure Swimlanes (Backlog #4) — Design

2026-07-29 · The combat report Timeline (HP curves) already features full-height colored bands for "friendly kill attempts / enemy vulnerability" (vulnBands); this design adds the **inverse**: visual representations of friendly pressure (DMG SPIKE) and healer exposure (HEALER EXPOSURE), closing the loop with the #16 window selection analysis.

## Goals and Criteria

Add a new thin swimlane (~8px) to the bottom of the combat report Timeline curve area:

1. **DMG SPIKE Pressure Bands**: Red-tinted translucent blocks, native hover tooltip: "0:36–0:46 Player2 under pressure 1.2M (120k DPS)";
2. **HEALER EXPOSURE Marks**: Vertical lines / diamonds on the same swimlane, hover tooltip: "Healer exposed: Pulled N yards away / LoS broken"; gracefully omitted when advanced log coordinates are absent (spikes do not depend on coordinates and remain always available);
3. **Clicking a Pressure Band = Sets Time Window** (`setTimeRange({fromS, toS})`) — forms a smooth workflow with the #16 [AI Analyze This Window] button: see pressure band → click to select window → deep dive on demand.

Criterion consistency: A window with [DMG SPIKE] in the prompt must appear on the swimlane and vice versa (same `DMG_SPIKE_THRESHOLD` gate, single-source predicate).

## Decision Record (Brainstorm Approved)

1. **Placement**: Combat report Timeline as primary; TimelineStrip sync left as a follow-up item, out of scope for this cycle.
2. **Scope**: Implement both DMG SPIKE + HEALER EXPOSURE; [OFFENSIVE WINDOW] duplicates existing offensive bands, excluded.
3. **Approach**: Option A — renderer pure derive + analysis exports two single-source entry points. Rejected: Bubbling structured events to top-level (theme of #10, touches prompt/audit chain); inline computation in Timeline (violates single-source predicate).
4. **Swimlane Format**: Bottom thin swimlane rather than full-height background — layering with offensive bands would cause color muddling, distinct layering separates offense (background) and defense (bottom strip) at a glance.

## Architecture

### Analysis Layer (`packages/analysis`)

- **Promote `DMG_SPIKE_THRESHOLD` to Shared Export**: Currently only imported and consumed internally in `matchTimelineSections`; move/re-export to a single-source location (alongside `computePressureWindows` in `utils/cooldowns.ts` or its constant source), `matchTimelineSections` and the new derive both import the same constant. Same for window parameters (`windowSeconds=10, topN=5`) — whatever parameters `emitDmgSpikeEntries` uses to call `computePressureWindows`, derive must use identically (promoted to shared constants, imported on both sides).
- **New Orchestrator `computeHealerExposureEvents(combat, ownerName?)`**: Encapsulates all orchestration of `analyzeHealerExposureAtBurst` (burstWindows / enemies / healer / CC summaries / zoneId, mirroring the call site in `buildMatchContext`, extracted rather than duplicated — `buildMatchContext` refactored to consume the same orchestrator for single-source predicates). Outputs display fields with relative second timestamps, exposure type (pulled away / broken LoS), distance, etc.

### Renderer Layer (`packages/desktop` renderer)

- `report/derive/pressureLanes.ts`:
  `derivePressureLanes(source) → { spikes: PressureBand[]; exposures: ExposureMark[] }`
  - Entry via `toLegacySafe`; spike = `computePressureWindows(...)` passed through `DMG_SPIKE_THRESHOLD` gate; exposure = `computeHealerExposureEvents(...)`;
  - All **relative seconds**; try/catch fallback to empty array (trimmed fixtures won't throw).
- `Timeline.tsx`: Adds swimlane layer at the bottom of the curve SVG; spike blocks clickable (onClick → `onRangeSelect(fromS, toS)`, reuses existing drag-select callback, zero new props in `MatchReport`); exposure marks non-clickable (informational only). Styles in `styles.css`.

## Scope Boundaries (Deliberately Out of Scope)

- TimelineStrip (AI view) synchronization — independent follow-up item, prioritized based on results of this cycle.
- [OFFENSIVE WINDOW] swimlane (duplicates vulnBands).
- Cross-match aggregation, pressure leaderboards.
- Swimlane legend / toggle (initially always visible; add if cluttered).

## Testing

- derive unit tests: threshold gate (windows below gate omitted), empty exposure without position data while spikes remain, relative second conversions, trimmed fixtures don't throw.
- Single-source predicate drift prevention: asserts derive and `emitDmgSpikeEntries` consume the same `DMG_SPIKE_THRESHOLD` and window parameters (importing the same symbol guarantees structural consistency; if parameters appear as literals, add equality assertion tests).
- Timeline component tests: swimlane rendering (spikes render blocks), clicking a block calls `onRangeSelect` with correct start/end parameters, exposure marks appear.
- Visual baselines: `report-battle`/`report-window` (and possibly `report-synth`) will change — CI recipes for human review.
- Run `npm run presubmit` before push.

## Risks

| Risk | Mitigation |
| --- | --- |
| Pressure bands visually clash with offensive background bands | Layering (background vs bottom strip) + color separation (gold/gray-red vs red) |
| Exposure orchestration extraction breaks buildMatchContext | Extract-style refactor (`buildMatchContext` consumes same orchestrator) + regression anchors in existing context tests |
| Bottom swimlane compresses curve height | Swimlane added within reserved strip inside SVG height (does not shrink curves); if container height needs expansion during implementation, gate with visual baseline human review |
| Short windows (<1s) too narrow to click | Minimum width 0.4% (matching bands precedent) |
