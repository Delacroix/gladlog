# Death Recap HP Visualization Design (v2 —— Per-row HP Bar)

2026-07-26 v2: User rejected v1 two-column curve scheme (released with v0.1.10, removed in this version),
Changed to WoW vanilla style per-row HP bar: each row has "Skill + Number + HP Bar", the HP bar draws the HP interval
**before → after** the skill's effect, red = damage taken, green = healing received.

## Data Layer (derive/deathRecap.ts)

- **Removed** `hpSeries` field and per-second sampling from v1.
- `DeathRecapEvent` added `hpBeforePct?: number; hpAfterPct?: number` (only for dmg/heal rows).
- Source (do not reinvent parsing, consume data already parsed by the parser): The sample in the target unit's `advancedActions`
  with the **same timestamp** (logLine.timestamp is exactly equal) is the HP/maxHp
  after the event lands → `hpAfterPct`; `hpBeforePct` = after + |amount|/maxHp (dmg)
  or after − amount/maxHp (heal), clamped to [0,100].
- Cannot find sample with same timestamp (non-advanced combat log row/old log) → both fields undefined, the row does not show an HP bar.
- cc/def_used rows do not include these two fields.

## Component Layer

- **Removed** `HpSparkline.tsx`, `rpt-recap-grid` two-column layout and related styles; the card reverts to a single-column table.
- Added a new HP bar cell column to the event table (class `rpt-recap-hpbar`, after the numbers column):
  - 0–100% horizontal track (`rpt-recap-hpbar-track`);
  - Neutral base fill up to min(before, after) (`rpt-recap-hpbar-base`);
  - Difference segment [min, max]: dmg red `var(--loss)` (`rpt-recap-hpbar-delta-dmg`),
    heal green `var(--win)` (`rpt-recap-hpbar-delta-heal`);
  - cell `title="82% → 61%"` (integer percentage);
  - Row cells without before/after values are left empty.
- Retained items from v1: number coloring (`rpt-recap-amt-dmg`/`rpt-recap-amt-heal`).

## Testing

- derive: fixture injects death + injects synthetic `advancedActions` with the **same timestamp**
  as damageIn/healIn → assert specific values of hpBefore/hpAfterPct; no matching sample → undefined.
- component: class and width/position of the bar's delta segment (style assertion), title text,
  cc rows have no bar; HpSparkline/rpt-recap-grid no longer exist.
- visual baseline report-synth re-recorded (v1→v2 appearance change, manual review).

## Explicitly Not Doing (YAGNI)

Absorb shield segments, per-row mini curves, hover synchronization, absolute HP axis.
