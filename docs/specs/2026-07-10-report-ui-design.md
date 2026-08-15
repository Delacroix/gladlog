# Subproject 3: Combat Report UI Design

Date: 2026-07-10
Status: Pending user review
Upstream docs: roadmap (`2026-07-10-clean-rewrite-roadmap-design.md`), desktop shell spec (`2026-07-10-desktop-shell-design.md`)

## Goals and Scope

Original design of the match combat report interface, consuming `GladMatch`/`GladShuffle`, rendered in the desktop shell renderer and becoming the **official main interface** (match list sidebar + combat report main area; the current debug page is downgraded to developer view).

**In Scope** (Confirmed):

- Scoreboard header: Both teams' compositions (class color + spec name + rating), win/loss, duration, map (zoneId text), bracket
- Meters: Bar chart comparison of damage/healing/absorb output by unit, switchable damage taken view
- Combat timeline: HP curve (advancedSamples) + death markers, hover to view moment details
- Unit details panel: Selected unit's cast sequence, aura events, talents/gear/rating (CombatantInfo)
- Shuffle: Match-level summary header + round tab navigation, a full combat report per round
- Visuals: Dark data-dense style, **original** (no reference to old layouts/pixels)
- Shell renderer refactoring to list + combat report main interface; developer view (monitoring status/diagnostics) moved to a separate entry point

**Out of Scope**: Positioning replay (advanced x/y is already in data, left for v2), spell icons (waiting for subproject 5), light theme, AI analysis panel (just reserving a hook point for subproject 4).

## Confirmed User Decisions

| Decision | Choice |
| -------- | ------ |
| v1 Panels | Scoreboard header + meters, timeline, unit details (positioning left for v2) |
| Visuals | Dark data-dense style |
| Game Data | v1 no icons: spellName text + hardcoded class color mapping |
| Entry Form | Official main interface, debug page downgraded to developer view |
| Architecture | Plan A revised after debate: report module in renderer + fixture mode + d3-scale + hand-written SVG |

**Architecture Trade-offs**: The initial independent report-ui package was judged by debate as premature modularization (see debate records) — revised to a module in the renderer + fixture mode with mock bridge, browser iteration is naturally consistent with the shell's visuals; recharts-like chart libraries are still excluded (dark mode customization is limited, heavy dependencies), coordinate math is handed over to d3-scale micro-primitives.

## Package Structure

```
packages/desktop/src/renderer/src/
  report/                 # Combat report module (via debate: not split into independent package; will extract if subproject 4 creates a second consumer)
    derive/               # Pure function derivation layer (core of report correctness, strictly unit tested, no Electron/DOM dependencies)
      types.ts            # StoredMatch = GladMatch without rawLines (shell disk shape); derived structure definitions
      summary.ts          # Unit aggregation: damage/healing/absorb out totals, damage taken, DPS/HPS, pets merged into owners
      timeline.ts         # HP sequence per unit (advancedSamples) + death markers + time range
      casts.ts            # Cast sequences (casts+petCasts merged by time), aura event sequences
      roster.ts           # teamId grouping, player filtering (kind=Player), win/loss annotations
    components/
      MatchReport.tsx     # Assembly: header/meters/timeline/details; derivation lazily executed via useMemo based on visible round/selected unit
      ShuffleReport.tsx   # Match-level header + round tabs → MatchReport per round
      ReportHeader.tsx  Meters.tsx  Timeline.tsx  UnitPanel.tsx
    data/gameConstants.ts # classId→official class color/name, specId→spec name (public facts hardcoded, to be replaced after subproject 5)
  fixtureBridge.ts        # fixture mode: injects mock window.gladlog under VITE_FIXTURE_MODE,
                          # supplies matches from local JSON—pure browser (vite dev) visual iteration, using the same code as shell rendering
  App.tsx                 # Refactoring: match list sidebar + combat report main area + developer view entry (original debug four columns retained entirely)
```

Charts: Coordinate math uses `d3-scale` (only scaleLinear/scaleTime, micro-dependency MIT); SVG markers (path/rect/marker/tooltip) are all hand-written, maintaining complete control over the dark data-dense visuals.

## Key Design Points

### Derivation Layer (derive) Contract Principles

- Components **only consume derived structures**, and do not directly iterate over GladMatch raw events; derivation functions are all pure functions, inputting `StoredMatch` (= the `data` of the shell's `match.json`, i.e., `GladMatch` without `rawLines`).
- Unit aggregation: Pet/guardian (`ownerId` is not empty) output is merged into the owner's row (decoupled from the parser's native model of "pets as independent units"); amounts strictly use `effectiveAmount`. Sign conventions follow the parser's native model (empirically verified with fixtures during the planning phase, not following the compat's negation convention).
- Timeline: `advancedSamples` is the main source for HP; for matches without advanced logging (`hasAdvancedLogging=false`), the timeline degrades to only event markers, without hp estimation (YAGNI).
- Shuffle: `GladShuffleRound` is `GladMatchBase`, reusing the same set of derivation + components per round; the match-level header displays the 6-round win/loss sequence and players' total records.

### Shell Integration

- IPC surface remains unchanged: `matches.list()` builds the sidebar, `matches.get(id)` fetches `data` to feed `<MatchReport/>`/`<ShuffleReport/>`.
- Developer view: The current debug page's four columns (monitoring status/diagnostics) are fully retained, moved to a separate entry point (a small top button or menu), and are no longer the initial screen.
- fixture mode: When `VITE_FIXTURE_MODE=1`, `fixtureBridge.ts` injects mock `window.gladlog` (list/get supplies data from local JSON), `vite dev` runs the same interface code in pure browser to iterate visually.

### Visuals and Compliance

- Implementation phase uses frontend-design + dataviz skills to produce **original** visuals; viewing old fork CombatReport source code, screenshots, or layouts is prohibited; "meters/death timeline/round segments" are domain common knowledge and can be used.
- Class colors are Blizzard's public palette (e.g., Warrior #C69B6D, etc.), spec names are public facts, hardcoding ~40 entries; the file header notes the source and "to be replaced by pipeline artifacts after subproject 5".
- The match JSON for fixture mode is generated using self-collected corpus (directly copying the shell's `match.json`), the parts not checked into git follow the `GLADLOG_FIXTURES` convention; a desensitized sample (with player names replaced) can be checked-in for fixture mode and component testing.

## Testing Strategy

Continuing the working method (Claude writes contracts, agy implements, Claude independently verifies; TDD):

- **derive layer**: Strict unit testing — use small synthesized GladMatch (manually constructed events) to assert the exact values of aggregated numbers; then use real fixture matches to assert key quantities (e.g., total damage matches meters, number of deaths matches the length of deaths).
- **Components**: vitest + jsdom + @testing-library/react lightweight smoke test (rendering doesn't crash, key numbers appear in DOM); no snapshot testing for visuals (too noisy).
- **Visual Acceptance**: Manual iteration in fixture mode + screenshots for user confirmation; ultimately going through a real match end-to-end within the shell (dev + packaged).

## Design Decision Debate Record (agy debate ritual)

2026-07-10, Gemini 3.1 Pro (High), conversation `0214a9db`. Initial **OPPOSE** → after one round of replies **CONCEDE** ("The revised spec eliminates premature boundaries and correctly targets UI performance constraints").

**Concession 1 (Design changed)**: The independent `packages/report-ui` package was judged as premature modularization — no second consumer, duplicate build pipelines, workspace linking overhead. Revision: report module moved into desktop renderer, visual iteration uses fixture mode (mock `window.gladlog`) running on the existing Vite dev server, rendering the same code as within the shell; the derive layer remains pure functions, with existing vitest in the desktop package directly running unit tests without losing testability; extract package later if a second consumer appears in subproject 4.

**Concession 2 (Design changed)**: Hand-writing coordinate math (domain→pixel, responsive viewBox, pointer→time inversion) will inevitably recreate a buggy chart library. Revision: Introduced `d3-scale` micro-primitives, while SVG markers are still all hand-written to maintain visual control.

**Concession 3 (Mechanism adopted, degree in doubt)**: Full eager derivation of 6-round shuffle risks GC pauses. Revision: Derivation lazily executed via `useMemo` based on visible round/selected unit. We retain the judgment that "O(n) summation magnitude itself is very cheap"; laziness is adopted because its cost is zero.

## Unresolved Issues

- Whether aura uptime in unit details should be made into a summary bar (tendency: v1 only lists event sequences, uptime is left for later).
- Scoreboard rating changes (rating delta) — CombatantInfo in the log only has pre-match rating, v1 only shows pre-match value.
