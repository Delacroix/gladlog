# Death Recap HP Curve Implementation Plan

> Specification: docs/specs/2026-07-25-death-recap-hp-curve.md. Execution mode: agy exec implement → Claude review (diff + gate + assertion quality) → commit.

**Goal:** DeathRecapCard dual-column layout: left event table (numbers red/green) + right HpSparkline HP curve.

## Global Constraints

- HP sampling only allowed to call `@gladlog/analysis`'s `getHpPercentAtTime` + `toRenderSecond` (public export verified), rendering layer forbidden to reinvent sampling logic.
- Class names prefixed with `rpt-`; no new dependencies; no file-level eslint-disable; tsc with test files must pass; lint whole repo `--quiet` must pass.
- Finishing gates: `npm run presubmit` (includes verify:vision and electron-vite build).

### Task A: derive layer hpSeries

**Files:** Modify `packages/desktop/src/renderer/src/report/derive/deathRecap.ts`; Modify `packages/desktop/test/report.deathrecap.test.tsx` (append describe).

- [ ] `DeathRecap` add `hpSeries` field, sample according to spec (per-second toRenderSecond grid, null skipped, non-empty supplemented with `{deathS, 0}` endpoint).
- [ ] Test: inject death + synthesize advancedActions (HP known sequence) → assert hpSeries specific values; strip advanced data → `[]`.
- [ ] Gate + commit: `feat(desktop): Death Recap hpSeries —— analysis predicate per-second sampling`

### Task B: HpSparkline component + Card dual-column

**Files:** Create `packages/desktop/src/renderer/src/report/components/HpSparkline.tsx`; Modify `DeathRecapCard.tsx`, `styles.css`; Create/Modify component test (append to report.deathrecap.test.tsx).

- [ ] HpSparkline: SVG segment color down/up/flat, cc/def vertical tick (title=skill name), ☠ endpoint, class names according to spec.
- [ ] DeathRecapCard: `rpt-recap-grid` dual-column; `hpSeries` empty → right column absent; left table numbers red/green.
- [ ] Test: segment class count and order, tick count, empty sequence single column.
- [ ] presubmit + commit: `feat(desktop): Death Recap dual-column —— HpSparkline HP curve (red damage/green heal) + number coloring`
