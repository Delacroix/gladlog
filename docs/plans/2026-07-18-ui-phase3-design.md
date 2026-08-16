# UI Phase 3 Design: Cross-Match Stats + User Onboarding + Coaching Feedback Loop (2026-07-18)

> Single-match review UI (backlog #6–#11 + continuous follow-ups) has stabilized; this phase covers three directions:
> cross-match insights, out-of-the-box onboarding, and evolving coaching from commentary to follow-up. Implementation order: 1 → 2 → 3, with replay polish items added along the way.
> C3 HTML export is **not in this phase** (format requires user sign-off).

## Verified Code Facts (Design Foundations)

- `matches.list()` returns a full in-memory index (non-paginated) — dashboard aggregation consumes metadata directly with zero new IO;
  rich row fields `durationS`/`avgRating`/`teams` are already in metadata (2026-07-17 #7), though legacy rows lack some fields.
- `arenaObstacles` (`analysis arenaGeometry`) = `zoneId → circle{x, y, r} / polygon{vertices}` in world coordinates; replay already has world-to-pixel mapping, so rendering obstacles is pure rendering work.
- Historical log import: Watcher's `FilePipeline` uses a tail/checkpoint incremental model, unsuitable for one-off backfills; the main process can directly run full files through `new GladLogParser()` (store de-duplicates by ID, so repeated imports are naturally idempotent).
- Settings IPC (`get`/`save`/`redact`) and directory selection (`app.selectDirectory`) already exist.

## 1. Match Performance Dashboard (Cross-Match Stats)

- **Entry Point**: App top bar switches to a 3-segment control: Matches / Dashboard / Developer (currently a single Developer toggle).
- **Data**: `deriveDashboard(metas, period)` pure function (in `dashboard.ts` next to components), `period ∈ Today / 7 Days / All`. Outputs:
  - Overview strip: Match count, win rate, median duration;
  - Rating curve: `avgRating` over `startTime` line chart, **split by bracket** (SVG, reusing Timeline techniques);
  - Enemy comp win rate table: Sorts and concatenates `specId`s from `meta.teams[1]` into a comp signature → `{matches, winRate}`, sorted by match count descending, with spec icon rendering (reusing `SpecDot`);
  - Map win rate table: `zoneId` exists across all rows (legacy rows included).
- **Legacy Row Handling**: Rows without `teams` count toward overview/map stats, but are excluded from comp tables; table header notes:
  "N legacy matches lack comp data — rebuild index in Developer View to backfill".
- **Interactivity**: Clicking a comp row / map row → switches back to match list with pre-filled filters (reusing `ListFilter`, App filter state already in place; comp-to-specId filter selects the first spec in signature for v1, full comp matching deferred).

## 2. User Onboarding Essentials

- **Settings View**: Top bar "Settings" button (or 4th state next to Dashboard) → `SettingsPanel`: WoW directory (`selectDirectory`), Anthropic API key (masked, sentinel mechanism in place), model, AI backend, response language. Keep `DevPanel` for debugging while moving user-facing settings out.
- **First-Run Onboarding**: When `metas` is empty and `wowDirectory` is null → main area empty state replaced with an onboarding guide card:
  3-step walkthrough (Select Directory → Play a Match / Import History → View Combat Report), embedding "Select Directory" and "Import History" buttons.
- **Historical Log Import**: Main process adds new IPC `logs:importFiles()`: `showOpenDialog` (multi-select `.txt` / or directory) → reads files sequentially with `readFileSync` + runs full `GladLogParser` → `store.store` collects `{stored, dup}` counts; progress event `gladlog:import:progress {file, i, n, stored}`, completion event with summary. UI: "Import Historical Logs…" button + progress bar in Settings and onboarding guide. Large files (~50MB per evening) read in main process are acceptable; processed serially per file.

## 3. Coaching Feedback Loop

- **Finding Flags**: Adds a 2-state toggle at the footer of each card in `FindingsList`: "✓ Followed Up" / "↻ Still Happening" (can be cleared); persisted to `<matchesDir>/<matchId>/findingFlags.json` (key = hash of `${category}:${title}`, language-agnostic — shared flags across both language caches). IPC: `analysis:getFlags/setFlag`.
- **Cross-Match Aggregation**: Main IPC `analysis:aggregate()` scans `*/analysis-v2.*.json` (de-duplicates bilingual versions per match, picks one) → category counts + recent instances per category (`matchId`/`title`/`severity`/`flag`). Rendered in dashboard: "Most Frequent Mistakes" card (top 3 categories + most recent finding for each, clicking jumps to that match's AI view — requires deep linking via `selectedId` + target view; v1 just jumps to the match).
- **Out of Scope** (v1): Freeform text notes, automatic linking of cross-match identical findings (approximated via category aggregation).

## 4. Replay Polish (Independent Minor Commits)

- Keyboard controls: Space to play/pause, `←`/`→` for ±5s, `Shift+←/→` for ±1s; add `0.5×` to speed segmented control.
- Obstacles: `arenaObstacles[zoneId]` rendered as semi-transparent outlines (`circle → SVG circle`, `polygon → path`), overlaid when real map background is present, or replacing abstract pillars when absent.
- AI Analysis Streaming Preview: `analysis.ts` stream loop emits `gladlog:analysis:delta {matchId, text}` (mirrored from compare feature); running state shows raw gray text preview, replaced with structured rendering upon completion.

## Implementation Order

1a Dashboard skeleton (segmented control + `deriveDashboard` + overview/rating curves) → 1b Comp/map tables + list filtering linkage
→ 2a Settings view → 2b Onboarding guide card → 2c Historical import → 3a Finding flags → 3b Aggregation cards
→ 4 Three replay polish items. Each step with independent commit + test + CI watch.
