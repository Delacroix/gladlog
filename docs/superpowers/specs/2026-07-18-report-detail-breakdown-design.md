# Combat Report Detail Breakdown (backlog #11) — Design

Date: 2026-07-18 · Status: User approved ("let's do it"), interaction model and column scope selected via AskUserQuestion

## Problem

Combat report meters only show a single total value per player, providing less information than the legacy wowarenalogs detail view.
A detailed breakdown by spell/source is needed for each player.

## Decision Record (User Selected)

1. **Interaction Model = Inline Expansion**: Clicking a meter row (bar/value area) expands that player's breakdown table for the current mode; the name button retains its original role of "toggle unit visibility"; only one player can be expanded at a time.
2. **Column Scope = Core Columns + Crit Rate**: Total / Share% / Hits / Max Hit (+ Overheal% for healing) + Crit%. Excluded: Healing taken by source, interrupt/dispel/CC list.

## Data Layer: `report/derive/detailBreakdown.ts` (Pure Function)

```ts
export interface BreakdownRow {
  key: string; // Aggregation key (spellId or src:spellId)
  label: string; // Spell name; pet row "PetName:Spell"; taken row "Source:Spell"
  spellId: string; // For SpellIcon
  total: number; // Sum of effectiveAmount
  sharePct: number; // total / sum of all rows × 100
  hits: number; // Event count (including dot ticks)
  maxHit: number; // Maximum effectiveAmount among single events
  critPct: number | null; // Percentage of critical events; null if params absent
  overhealPct?: number; // healing mode only: (amount - effective) / amount × 100
  isAbsorb?: boolean; // Absorb shield row in healing mode
}
export function deriveDetailBreakdown(
  source: ReportSource,
  unitId: string,
  mode: "damage" | "healing" | "taken",
): { rows: BreakdownRow[]; critAvailable: boolean };
```

- **damage**: Aggregates `damageOut` by spellId for the player + pets (`ownerId === unitId`). Shares the same event source and sum semantics (`effectiveAmount`) with `damageDone` in `derive/summary.ts` — unit tests assert `sum(rows.total) === meterValue(total)`.
- **healing**: Aggregates `healOut` (player + pets) by spellId + `absorbsOut` (player + pets) aggregated by shield spellId (`isAbsorb`, no overheal, no crit); reconciled against `healingDone + absorbsDone` (= meterValue healing scope).
- **taken**: Aggregates `damageIn` by `srcName:spellId`; reconciled against `damageTaken`.
- rows sorted by `total` descending; `critAvailable` = at least one row has a non-null `critPct`.
- Directly consumes the native `ReportSource` event array (`GladHpEvent` comes with `amount`/`effectiveAmount`), no `toLegacy` conversion required.

## Parser Side: Single Source of Truth for Crit Decoding

New export in `packages/parser/src/l1/decoders.ts`:

```ts
/** Extracts damage/heal tail params from full params and decodes; returns null for non-hp events or insufficient params */
export function decodeHpTail(
  eventName: string,
  params: string[],
): { critical: boolean; amount: number; effectiveAmount: number } | null;
```

- Internally reuses existing `decodeDamage`/`decodeHeal` and `parseLine` tail param slicing rules (`SWING/_DAMAGE` findXIdx `slice(-11/-10)`, `_HEAL` `slice(-5)`); **refactors three call sites in `parseLine` to invoke this same helper**, making slicing logic single-sourced.
- Exported from the `@gladlog/parser` package index, used by the renderer to compute `critPct`.
- Pure new export + internal equivalent refactoring, parser output unchanged (oracle parity unaffected).
- Trimmed fixtures / legacy doc events without params → null → critPct null → column hidden.

## Component Layer

- `Meters.tsx`: Row body (bar/value area) `onClick` toggles `expandedUnitId` (local state, single open); renders `BreakdownTable` below the expanded row. `stats` mode remains unchanged. `ShuffleReport` automatically inherits this by reusing `Meters`.
- `BreakdownTable.tsx` (New): Columns = icon (`SpellIcon`) + label + total (formatted with commas) + sharePct + hits + critPct (column only rendered when `critAvailable`) + maxHit; healing mode appends overheal%; **top 8 rows + collapsed "Remaining N (Total)" row** (cannot be expanded further, YAGNI). Empty rows → single "No data" row.
- Styling: `.rpt-breakdown` table, reusing the visual look of the `rpt-stats` table.

## Testing

- parser: `decodeHpTail` synthetic params in three shapes (`SPELL_DAMAGE` with/without advanced, `SPELL_HEAL`, `SPELL_PERIODIC_DAMAGE`) + non-hp events return null + short params return null; existing parser tests all pass after `parseLine` refactor.
- desktop: fixture damage/healing/taken aggregation is correct + three modes reconcile totals against `meterValue`; fixture without params → `critAvailable=false`; injecting synthetic events with params → correct `critPct`; `Meters` expansion interaction (clicking row shows table / clicking again collapses / clicking name button only hides without expanding).

## Out of Scope (YAGNI)

- Healing taken by source, detailed interrupt/dispel/CC lists, secondary breakdown by target, time range filtering, expandable collapsed rows.
