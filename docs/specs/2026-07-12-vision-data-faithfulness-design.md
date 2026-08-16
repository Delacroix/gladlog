# C1 — VISION Data Faithfulness (UI Doesn't Lie) Design

Date: 2026-07-12
Status: Pending User Review

## Background and Goals

Verifiability Roadmap (`docs/verifiability-roadmap.md`) Pillar C, first subproject. Bring the grounding discipline from the PROMPT layer to the UI: **every rendered number / bar width / timeline mark must be demonstrably faithful to the data provided to the component**, with no fabrication, mismatch, or incorrect scaling. At the same time (for the dual audience of the roadmap), every check must be **headlessly invocable by agents + produce machine-readable diffs**, serving the produce→verify→feedback cross-agent loop, not just acting as a CI traffic light.

Scope: **Meters + cohort panel (ProComparisonVerified) + timeline (TimelineStrip)**. The harmonizer is extensible.

## agy debate conclusions (ritual, conversation `44605150`, OPPOSE→Adopted)

Original "hybrid source cross-validation" was rejected:

- **METER source recalculation = brittle + out of bounds**: `deriveSummary` (summary.ts:27-29) includes **pet** damage `sum(u.damageOut)+pets.reduce(...)`; naive recalculation missing pets → false positives on correctly rendered Hunters/Warlocks/DKs. And recalculation = duplicating deriveSummary = mixing **aggregation correctness** (LOG layer responsibility) into UI faithfulness.
- **COHORT percentile recalculation = circular**: Using the same piecewise linear formula (verifiedComparison.ts:23-38) to recalculate from the same p10/p50/p90 = f(x)==f(x), proves nothing about rendering faithfulness.

**Adopted steelman: Isolate the view layer.** C1 only verifies "rendered == values given to component" + non-recalculating **structural invariants**. The **correctness** of aggregation/percentiles/parsing is left to their respective unit tests and the LOG/PROMPT pillars.

## Component 1: Selectors = Single Source of Truth (`report/derive/`)

Extract inline render-math from components into pure functions, degrading components to dumb renderers:

- `meterRows(rows: UnitTotals[], mode): MeterRow[]` —— `{ unitId, name, classId, value, widthPct, label }`, includes sorting, `max`, `(v/max)*100`, rounding + thousand separator formatting. Moved out of `Meters.tsx`.
- `timelineMarks(candidates: CandidateEvent[], start, end): Mark[]` —— `{ id, t, leftPct, type }` (only point events with `facts.t`; `leftPct = t/maxT*100`). Moved out of `TimelineStrip.tsx`.
- `cohortDims(result): CohortDimRow[]` —— `{ key, value, percentile, verdict, p10, p50, p90 }`, passes through formatted compare results.

No more arithmetic inside component JSX. Selectors have their own unit tests (known fixtures, manual verification of expectations).

## Component 2: Faithfulness Harmonizer (`report/derive/faithfulness.ts`)

`checkFaithful(kind, renderedRoot, selectorOutput): Divergence[]`

- Traverse the rendered DOM (RTL container), extracting each rendered value by kind (bar width inline style, number text, mark left%).
- Execute two types of checks for each rendered value, collecting `Divergence` (empty = faithful):

**(A) View Faithfulness (rendered == given):** Rendered value == corresponding field in selector output. Bar width/number text for Meters, value/percentile text for cohort, left% for timeline.

**(B) Structural Invariants (non-circular, no recalculation of aggregation):**

- Meters: Each bar's `widthPct ∈ [0,100]`; `widthPct` and `value` are **monotonically co-ordered**; the bar with max value == 100%; **format round-trip**: parsing the rendered text `"1,234"` back to a number == `Math.round(value)` (catches formatting/locale/misalignment bugs).
- Cohort: **Order consistency** of `percentile` and value relative to p10/p50/p90 (`value ≥ p90 ⟹ pct ≥ 90`; `value ≤ p10 ⟹ pct ≤ 10`; p10<value<p90 ⟹ 10<pct<90). Catches mismatches like "low value but displays high percentile", **without recalculating** the exact percentile.
- Timeline: Each mark's `t ∈ [start,end]`; `leftPct == t/maxT` (tolerance 1e-6); `id` maps to a real event in candidates.

## Component 3: Cross-Agent Output

`Divergence = { component, element, rendered, expected, invariant, sourceRef }` (JSON-ified).

- **CI/Unit tests**: One vitest per component, rendered with existing report fixtures, asserting `checkFaithful(...) === []`.
- **Agent runnable**: `npm run verify:vision` (desktop script) runs all checkFaithfuls against fixtures, printing structural diffs; exits non-zero if divergences exist —— allows repair agents to get precise locations and review agents to reproduce.

## Data Flow

fixture match → selector calculates display values → component renders → harmonizer extracts DOM → (A)rendered==selector + (B)structural invariants → Divergence[] (empty=pass).

## Error Handling

- DOM extraction failure (missing element/empty text) → record `Divergence{invariant:"missing"}`, do not pass silently.
- `max=0` (all 0 meter) → selector `widthPct=0`, invariant passes (0∈[0,100], monotonicity holds trivially).
- cohort `value=null` (N/A dimension) → skip order consistency check for that dimension (no value to compare).

## Testing Strategy (vitest)

- Selector unit tests: `meterRows`/`timelineMarks`/`cohortDims` output manually verified against known fixtures (sorting, widthPct, formatting, leftPct).
- Harmonizer unit tests: Render each component with report fixture → `checkFaithful` returns `[]`.
- **Proof with teeth (Critical)**: Inject an **intentionally lying** render (e.g., multiply a bar's widthPct by 2, swap cohort percentile with another dimension), assert `checkFaithful` **must** catch it and output the corresponding `Divergence`. Proves the check is not a no-op.
- Existing desktop suite does not regress (components changed to read from selectors, behavior is equivalent).

## Out of Scope

- **Correctness** of aggregation/percentiles/parsing (deriveSummary summation, verifiedComparison percentiles, parser) —— covered by respective unit tests + LOG/PROMPT pillars, not C1.
- Visual regression (screenshots, C2), export faithfulness (C3) —— later.
- Components outside Meters/cohort/timeline (harmonizer is extensible, later).

## Unresolved Issues

None (Strength = view faithfulness + structural invariants; Scope = Meters + cohort + timeline; Confirmed).
