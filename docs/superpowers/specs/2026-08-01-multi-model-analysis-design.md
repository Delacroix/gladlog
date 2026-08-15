# Multi-Model AI Analysis Comparison (Slot-Based Storage + Tab Switching + Model Selection Entry Point) — Design

2026-08-01 · User requirement: Allow analyzing the same match with different AI agents, compare them via tab switching without overwriting each other; add an expansion arrow to the "AI Analyze / Re-analyze" button for "Analyze with another model" to switch models on the fly.
Design approved by user (2026-08-01).

## 1. Storage: `analysis-v2` Slots

- Upgrade `analysis-v2.<lang>.json` document structure: top-level changes from a single result to
  `{ slots: { "<backend>:<model>": AnalysisSlot }, lastSlotKey: string }`;
  `AnalysisSlot` = all existing single-result fields (`text`/`chips`/`promptVersion`/`deepDive`/conversation history/finding flags, etc.) pushed down one level as-is.
- **Slot Key = `${backend}:${model}`**, isomorphic to the #16 window cache (`analyzeWindow`);
  key source matches actual call arguments (`settings.aiBackend` + `resolveAiModel`, computed in a single place).
- **Migration**: When reading legacy format (top level is directly the result object), wrap it into a single slot:
  `{ slots: { "<legacy>": old }, lastSlotKey: "<legacy>" }`, legacy key uses current settings `backend:model` (best-effort attribution; naturally solidified when written back). No one-off batch migration; lazy migration on read.
- **Writing**: Analysis completion only upserts the current slot + updates `lastSlotKey`; other slots remain untouched at byte level.
  `promptVersion` stamps are stored per slot; version mismatches within a slot treat that slot as a cache miss (re-analyzing overwrites that slot), without affecting other slots.
- `deepDive` / follow-up conversations / finding flags are all isolated per slot — each model maintains its own complete session.

## 2. Downstream Consumption Semantics (Engineering Risk Point, Addressed Directly)

- Single-result consumers such as `listAnalyzed` / cross-match dashboard / self-learning (`distillRules`): unconditionally read **the slot pointed to by `lastSlotKey`** (= the most recent analysis for that match). Behavior remains completely identical to pre-refactor, comparison slots are purely retained artifacts. This logic is encapsulated into a shared helper (`resolveActiveSlot(doc)`), imported by all consumers — direct access to `slots` is prohibited.
- Batch analysis driver writes slots using current global settings `backend:model` (consistent with single match).

## 3. UI: Comparison Tabs

- Top of `StructuredAnalysisPanel`: renders a small tab bar when `slots` count ≥ 2; labels use model short names (mapped from `label` in `aiModels` table, truncated if too long; includes model name when multiple models share the same backend).
- Tab switching = pure frontend view swap with zero network requests; active slot highlighted; switching does not mutate `lastSlotKey` (`lastSlotKey` is only updated when a real analysis completes).
- Single slot does not render tabs (zero noise, preserves status quo look and feel).
- Deleting individual slots is out of scope (YAGNI; can be overwritten via re-analysis if cleanup is needed).

## 4. UI: Button Expansion Arrow (Split Button)

- Small arrow on the right side of "AI Analyze / Re-analyze", menu titled "Analyze with another model", listing:
  detected local CLI backends (`claude`/`agy`/`codex`, existing `cliDetect` results) + API backends configured with keys (`anthropic`/`deepseek`), along with their respective available models (`aiModels` table).
- Selecting an item initiates analysis with that `backend:model` and writes to its slot; **temporary selection, does not alter global settings** (settings view defaults remain unchanged). The current global default is annotated in the menu.
- Unavailable backends (undetected / missing keys) do not appear in the menu (omitted rather than grayed out — keeps the menu concise).

## 5. Scope Boundaries (Deliberately Out of Scope)

- Side-by-side split screen diff view; cross-model automated scoring/judging; slot deletion management; multi-slot tabs for window analysis (#16) (it already has `backend:model` key caching; UI comparison deferred until demand arises); global default switching entry point (remains in Settings view).

## 6. Testing and Verification

- Storage layer: lazy migration of legacy format (read old, write new), slot isolation (writing slot A leaves bytes of slot B untouched), `lastSlotKey` update timing, within-slot `promptVersion` miss only affecting that slot — fully covered by unit tests, red → green.
- Consumption semantics: `resolveActiveSlot` single-source helper + anti-corruption assertions across all consumers.
- UI: single slot renders no tabs / double slot renders tabs with correct switching / split menu lists only available items / temporary selection does not write to global settings — component tests.
- Visual baselines: split arrow changes `report-ai` scenario (button appearance) → CI regenerated for human review; tab bar does not appear under baseline fixtures (single slot), causing no additional impact.
- Manual device sign-off: analyze a match with two models → tab comparison → temporary switch menu.
