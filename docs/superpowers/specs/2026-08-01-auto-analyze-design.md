# Auto-Analyze New Matches Design

2026-08-01 · Approved by user: When the setting toggle is turned on, every newly captured match will automatically be analyzed using the current global default model. Four design points verbally confirmed; two engineering details added after probing (live/import discrimination, busy queueing).

## 1. Settings

- `GladlogSettings` adds `autoAnalyzeNew: boolean` (AI section, after `aiLanguage`; DEFAULTS false; `settingsStore.get()` uses `{...DEFAULTS, ...raw}`, naturally backwards compatible with old files without migration).
- SettingsPanel AI section adds "Auto-analyze new matches" row at the end (after coach reply language row, before line 326), reusing the "Enable/Disable" button precedent (matching `recordingEnabled` :332-351 styling), description copy: "Automatically analyze matches with the default model when newly captured in real time (does not trigger on historical imports)".

## 2. live / import Discrimination (Main Process)

- `gladlog:logs:matchStored` event payload expanded from bare `StoredMatchMeta` to `StoredMatchMeta & { live?: boolean }`: `main/index.ts:112` live path includes `live: true`; `importLogs.ts:57` import path omits it (undefined). Existing subscribers (`App`/`DevPanel`/`StatsDashboard`) only read meta fields and are unaffected by the new field.
- Iron rule: Only `live === true` triggers auto-analysis — import floods strictly never trigger it.

## 3. Renderer-layer autoAnalyze Queue Module

- New file `packages/desktop/src/renderer/src/batch/autoAnalyze.ts`: Module-level `pending: string[]` (`meta.id`, deduplicated) + `startAutoAnalyzeListener()` (called once when App mounts, returns unsubscribe cleanup).
- Event arrives → `bridge().settings.get()` reads toggle on the fly (following recorder precedent of reading per event, never caching) → if enabled and `live` → enqueue → `drain()`.
- `drain()`: If `getBatchStatus().running` is true, attach `subscribeBatch` to wait until idle; once idle, invoke `startBatch(pending.splice(0).map(id => ({id, label})))` — queueing / serialization / skip-if-cached / auto deep-dive all reuse the batch driver, with zero new analysis logic. Label is formatted with bracket/time cached in meta (matching `BatchAnalyzeBar` `labelFor` style; fall back to first 8 characters of id if meta is unavailable).
- shuffle: `meta.id` = first round id; `startBatch`'s existing shuffle expansion logic (`matches.get → rounds` round-by-round) is naturally correct.
- Failures do not retry and do not show popups (user can manually retry on the report page); no backfill for time when app is closed (use existing batch analysis to backfill).

## 4. Tests

- settingsStore: `autoAnalyzeNew` defaults to false / save roundtrip.
- Main process: `live` flag — live path includes it, import path omits it (assert emit payload).
- autoAnalyze module (stubbed bridge): toggle off → does not enqueue; toggle on → enqueues and `startBatch` receives id; batch already running → suspends, drains after batch completes; import (no live) → does not trigger; duplicate ids deduplicated.
- SettingsPanel: Toggle row renders and invokes save.
- Visual baseline: settings scenario adds a row → regenerated in CI for human review.

## Boundaries (Out of Scope)

- Backfilling missed matches while app was closed; bracket filtering; running auto-analysis on non-default models; concurrent multi-instance analysis.
