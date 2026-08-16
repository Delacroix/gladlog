# Parser M2: L2 Match Segmenter — Implementation Plan

> **For agentic workers:** Implementer preference: agy exec (fallback to haiku subagent if quota exhausted); test contract = written by controller; strictly forbidden from reading legacy wowarenalogs parser source code. Behavioral contract derived from 2026-07-10 probe empirical findings (see spec L2 section, updated).

**Goal:** `Segmenter`: `ParsedLine` stream → `Segment` (arena match segment / shuffle round segment sequence + match close), covering behavioral contracts for four dirty-log scenarios.

## Global Constraints

- Same as M1 (repo, TS strict, zero dependencies, no reading legacy source, commit rules).
- Behavioral contract (probe empirical facts, no deviations allowed): non-shuffle double START = drop previous segment + `DOUBLE_START` diagnostic; shuffle consecutive START = round boundary; END closes overall match; `winningTeamId=255` = no winner; `COMBAT_LOG_VERSION` / `ZONE_CHANGE` do not terminate segment; unclosed segment at EOF discarded + `UNCLOSED_SEGMENT`.
- Acceptance fixtures (Blizzard logs, directly usable): `one_solo_shuffle.txt` (6 rounds), `double_start.txt` (2v2 restart), `one_match_synthetic_no_end.txt` (EOF discarded), `shuffle_reloads.txt` (6 rounds with UI reload), `shuffle_early_leaver.txt` (2 rounds + 255), `two_matches.txt` (consecutive two matches). Path: `/Users/mingjianliu/code/wowarenalogs/packages/parser/test/testlogs/` (tests point via `GLADLOG_FIXTURES` env var, do not copy into repo — 40MB not tracked in git; CI skips this test group when env var is absent).

### Task 1: Segment Types + Segmenter State Machine

**Files:** Create `packages/parser/src/l2/segmenter.ts`, `src/l2/types.ts`; Test `test/l2.segmenter.synthetic.test.ts` (synthetic lines, no fixture dependency)

**Interfaces:**

- `interface Segment { kind: 'match' | 'shuffleRound'; bracket: string; zoneId: string; isRated: boolean; startLine: ParsedLine; records: ParsedLine[]; rawLines: string[]; sequenceNumber?: number }`
- `interface ShuffleClose { rounds: Segment[]; end: ParsedLine }`
- `class Segmenter { push(line: ParsedLine, raw: string): void; end(): void; onMatch(cb: (seg: Segment, end: ParsedLine) => void): void; onShuffle(cb: (s: ShuffleClose) => void): void; onDiagnostic(cb: (d: { code: string; lineRef?: string }) => void): void }`
- State machine: `IDLE` → (START, non-shuffle) → `IN_MATCH` → (END) → emit match / (START again) → diagnostic + restart; `IDLE` → (START, shuffle) → `IN_SHUFFLE` collecting rounds, (START) → seal previous round & open new round, (END) → seal final round & emit shuffle; in any state on `COMBAT_LOG_VERSION` / `ZONE_CHANGE` → record only, do not transition; `end()` → unclosed segment `UNCLOSED_SEGMENT` diagnostic.

**Test Contract (Synthetic lines, fixed by controller, implementer must not modify)**: Construct sequences with minimal synthetic log lines to assert: ① non-shuffle normal single match → 1 match, records include intermediate lines; ② double START → 1 diagnostic + subsequent match complete; ③ shuffle 3 STARTs + END → `ShuffleClose.rounds.length=3`, `sequenceNumber=0,1,2`, END belongs to overall match; ④ `COMBAT_LOG_VERSION` intermingled does not interrupt; ⑤ unclosed at EOF → diagnostic, no emit; ⑥ END without matching START → diagnostic `ORPHAN_END`, no crash.

### Task 2: Fixture Scenario Acceptance Tests

**Files:** Test `test/l2.fixtures.test.ts` (read 6 files under `GLADLOG_FIXTURES`, feed line-by-line `parseLine → Segmenter`)

**Assertions (Probe Empirical Values)**: `one_solo_shuffle` → 1 shuffle, 6 rounds, first 6 records of each round are `COMBATANT_INFO`, END `winningTeamId=0`; `double_start` → 1 match + 1 `DOUBLE_START` diagnostic; `no_end` → 0 emit + 1 `UNCLOSED_SEGMENT`; `shuffle_reloads` → 1 shuffle, 6 rounds (reload does not split segment); `early_leaver` → 1 shuffle, 2 rounds, `end.arenaEnd.winningTeamId=255`; `two_matches` → 2 matches.

### Task 3: GladLogParser Outer Shell Wiring (L1 + L2 portion of spec public API)

**Files:** Create `packages/parser/src/api.ts`; Modify `src/index.ts`; Test `test/api.test.ts`

- `class GladLogParser`: `push(rawLine) → parseLine → segmenter`; events `matchSegment` / `shuffleSegments` / `diagnostic` (emits segment-level events prior to L3 completion; M3 upgrades them to `GladMatch`); `stats()` counters (`linesTotal` / `linesDropped` / `segmentsDropped`). Synthetic lines + 1 fixture smoke assertion.

## Definition of Done

- All three tasks green + typecheck; all assertions across 6 fixture scenarios pass; commit per task.
