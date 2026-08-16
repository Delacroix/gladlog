# BACKLOG #13 Wrap-up: Uncovered Highlights Auto-Sweep Design

2026-08-01 · Approved by user. The remainder of #13 = automation: deep dives currently only open windows on existing finding anchors, leaving coachable signals in periods without findings invisible; #16 has proven that the "arbitrary window + signal gate" mechanism is viable but relies on manual clicking.

## Mechanism

1. **Deterministic sliding window** (zero model cost): 20s windows across the whole match with a 10s step, running #16's existing signal gate for each window (`buildWindowPack` returning non-null indicates coachable signals exist — same predicate, no duplication);
2. **Deduplication**: If a window overlaps with existing anchors (time anchors of initial findings + deterministic mistake checklist `tS`, with ±5s tolerance), it is discarded — keeping only timeframes "untouched by existing analysis";
3. **Rank and take top 3**: Descending order by item count in window pack (signal density); merge adjacent hit windows (merge on overlap, taking union bounds);
4. **Surface presentation**: A small "Uncovered Highlights" card below the findings section in AI Analysis view: each entry = time window + signal summary (counts of pack item kinds, e.g. "2 pressure events + 1 defensive opportunity") + one-click [AI Analyze Window] — directly reuses #16's `runWindowAi` (triggers after setting `timeRange`, enjoying caching/force semantics);
5. **Cost discipline**: Sliding window is entirely deterministic; model calls only occur when the user clicks (v1 will not auto-burn even if the auto-analyze toggle is on).

## Boundaries (Out of Scope)

- Automatically upgrading highlights to findings (only provides the entry point, not auto-generation); feeding full-match sliding windows into batch analysis; surfacing in non-AI views; configurable window size/step.

## Tests and Baselines

- Sweep derive unit tests: hit / deduplication / merge / ranking (red → green); card does not render when there are 0 highlights (zero noise);
- Click pipeline component test (sets window + triggers, reusing #16 test harness);
- Visual baseline: report-ai scenario fixture will change if it produces highlights — zero baseline impact if fixture has no highlights (verified at wrap-up).
