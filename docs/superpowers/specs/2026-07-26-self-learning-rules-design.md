# Self-Learning Evolution: Cross-Match Pattern Accumulation (Design)

Date: 2026-07-26
Status: Aligned with user; see implementation plan at `docs/superpowers/plans/2026-07-26-self-learning-rules.md`

## Corrections (2026-07-26 Planning Phase, subject to implementation plan)

1. **The cross-match key is not findingKey**: findingKey = `category|sorted(eventIds)`, and eventIds
   are local IDs of candidate events per match, which never repeat across matches (the existing `aggregate()` also only uses
   category across matches; findingKey only serves single-match flags). The cross-match granularity is changed to **category
   (+ candidate event type, e.g., survival+death)**: during live analysis, main has candidates
   to parse the type; backfilled old matches have no candidates, degrading to pure category level.
2. **Ledger rows changed to "one row per run, embedding findings"**, re-analysis of the same match replaces the whole match by matchId
   using last-run-wins — last-write-wins per finding would leave old findings permanently residual
   if abandoned by a new round. The sort key uses meta's `startTime` (not endTime); removed
   ownerSpec (condition slicing does not use it, YAGNI).
3. **Enhanced consolidation failure semantics**: Deterministic parts (stats/retirement/resurrection) **always** persist; AI distillation
   failures only affect description/advice text. Rules missing text use deterministic fallback display in UI,
   and will be lazily backfilled in the next consolidation — stronger than "retain old rules.json entirely if audit is completely empty".
4. description/advice store **templates** (containing `{{hits}}`/`{{windowMatches}}` placeholders),
   interpolated from current stats by the shared `interpolate` function during rendering — stats updates do not invalidate text.

## Goals and Non-Goals

**Goal**: Evolve AI analysis from "one-time per-match feedback" to "cross-match learning" — concentrate historical findings into local storage, periodically consolidate them, and generate **fixed, verifiable patterns**, used for:

1. **Deterministic Rules**: Automatically highlight "habitual problems" during new match analysis without calling the AI.
2. **Long-Term Pattern Report**: A standalone page displaying the player's long-term bad habits and improvement curves.

**Non-Goals** (explicitly excluded, do not smuggle into implementation):

- Do NOT feedback into single-match analysis prompts (the user explicitly rejected "the more you use it, the better it knows you" injections).
- Do NOT rely on user markings (done/recurring remain independent features, not used as learning signals for this feature).
- Do NOT upload to the cloud. Storage is entirely local in the main process (`userData/learning/`).
- Do NOT use embedding/clustering for pattern mining (conflicts with the "predicates as specifications" philosophy, unverifiable).

**Learning Signal Source**: Exclusively AI historical findings themselves (cross-match pattern mining), requiring no user action.

## Confirmed Key Decisions

| Decision Point       | Conclusion                                                     |
| -------------------- | -------------------------------------------------------------- |
| Learning Signal      | AI historical findings (findingKey/category cross-match frequency) |
| Pattern Destination  | Deterministic rules + Long-term pattern report page (does not enter prompt) |
| Consolidation Mech   | Deterministic filter stable patterns → AI only translates/summarizes → Deterministic audit |
| Storage              | Local `userData/learning/`, managed by main process            |
| Consolidation Trigger| Ledger adds ≥10 matches automatically + Manual button on report page |
| Rule Lifecycle       | Deterministic retirement: recent window frequency drops below threshold → `improved`, not deleted, resurrectable |
| Description Language | Generated in current aiLanguage, lazy re-translation on language switch (only reruns distillation, stats untouched) |
| Condition Slicing Dims | Initial version only "enemy spec presence" and "map" dimensions |

## Architecture: Four-Layer Data Flow

```
Single match analysis done ──append──▶ ledger.ndjson (Learning Ledger)
                              │
                              ▼ (≥10 new matches or manual)
                     patternScan (Deterministic filter, pure function)
                              │ StablePattern[]
                              ▼
                     AI Distillation (main learning.ts, sonnet)
                              │ Rule[] draft
                              ▼
                     Deterministic Audit (Placeholder discipline, discard violations)
                              │
                              ▼
                        rules.json ──┬──▶ New matches: Rule engine runs on deterministic candidates, attaches "Habitual Problem" badges (no AI call)
                                     └──▶ Long-term pattern report page (trends/status/evidence chain)
```

## 1. Storage: `userData/learning/`

### `ledger.ndjson` (append-only ledger)

One finding instance per row:

```jsonc
{
  "v": 1,
  "matchId": "...",
  "findingKey": "...",
  "category": "...",
  "severity": 2,
  "meta": {
    "endTime": 1753500000000,
    "mapId": 1552,
    "win": false,
    "ownerSpec": 105,
    "enemySpecs": [62, 71, 264],
  },
  "promptVersion": 12,
  "createdAt": 1753500100000,
}
```

- **Only stores keys and structured metadata, no text**. findingKey (`packages/desktop/src/shared/findingKey.ts`, `category|sorted(eventIds)`) is language-agnostic, making the ledger naturally cross-lingual.
- Re-analyzing the same match → append new row; when reading, use **last-write-wins** by `(matchId, findingKey)`; skip bad rows (same fault-tolerance convention as `_index.ndjson`).
- **promptVersion is only recorded, not invalidated**. This is the core reason the ledger exists: `analysis-v2.*.json` caches are entirely invalidated upon promptVersion upgrades, so learning memory must be decoupled from cache invalidation.
- Write point: `packages/desktop/src/main/analysis.ts` appends after every successful analysis cache write (written in the initial run; deepDive only fills in text, producing no new ledger entries).

### `rules.json` (Consolidation Output)

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": 0,
  "ledgerCursor": "...",
  "rules": [
    {
      "ruleId": "...",
      "status": "active", // "active" | "improved"
      "category": "...",
      "findingKeys": ["..."],
      "condition": { "enemySpecs": [62], "mapIds": [] }, // nullable = unconditional
      "stats": {
        "windowMatches": 20,
        "hits": 9,
        "firstSeen": 0,
        "lastSeen": 0,
        "trend": [2, 3, 1, 2, 1],
      }, // bucketed per 5 matches
      "description": { "zh": "…{{hits}}…", "en": null }, // lazy re-translation: null for ungenerated languages
      "advice": { "zh": "…", "en": null },
      "evidence": ["matchId1", "matchId2"],
      "distilledAt": 0,
      "distillModel": "claude-sonnet-5",
    },
  ],
}
```

### Backfilling

Upon first enablement, scans all existing `matches/*/analysis-v2.*.json` (≈794 matches) to write the ledger, reusing `notebook()`'s scanning logic, one-time, with progress events, writing a `backfill-done` marker upon completion. **Unlike `notebook()`: old matches with mismatched promptVersion are also collected** (just record their promptVersion). Everything is incremental thereafter.

## 2. Deterministic Filter: `packages/analysis/src/learning/patternScan.ts`

Pure function: `LedgerEntry[] → StablePattern[]`. All thresholds exported as constants, **filtering, retiring, badge rendering, and any future verification gates share the exact same predicates** (predicates as specifications):

```ts
export const PATTERN_WINDOW_MATCHES = 20; // Stats window: recent N matches
export const PATTERN_MIN_HITS = 5; // Minimum hits within the window
export const RULE_RETIRE_MAX_HITS = 2; // Recent window hits ≤ this value → improved
```

- Grouping: Primary = normalized category (`normalizeFindingCategory`); Granular = findingKey.
- **Stability determination**: Hits ≥ `PATTERN_MIN_HITS` within the recent `PATTERN_WINDOW_MATCHES` match window, **and the hit distribution spans both the front and back halves of the window** (excluding a single loss-streak spike).
- **Condition Slicing** (Initial version two dimensions: enemy spec presence, map): Produces conditional patterns when the subset hit rate is significantly higher than the overall set. "Significantly" uses deterministic thresholds (subset hit rate ≥ 2× overall hit rate AND subset sample ≥ 4 matches), without statistical tests.
- Outputs `StablePattern`: groupKey, hits, window, trend buckets, representative instances (2-3 entries, including matchId to fetch the then-explanation text during distillation), condition slices.

## 3. AI Distillation + Deterministic Audit (new `learning.ts` service in main)

- Input: `StablePattern[]` + the original explanation text of 2-3 representative instances per pattern (read from the corresponding match's analysis cache; matches where the cache is already invalidated by promptVersion degrade to only providing structured fields).
- Model: Default sonnet (consistent with the coach product line), routing through the existing `resolveAiClient`/`resolveAiModel` three-backend system.
- Requires Rule JSON array output: translates statistical patterns into human-readable descriptions, summarizes applicable conditions, and provides a coaching suggestion. Parsing uses the existing `parseModelJsonArray` (tolerates markdown fences).
- **Audit (copying existing disciplines, offending items entirely discarded)**:
  1. No raw numbers in descriptions/advice, only `{{key}}` placeholders, interpolated from stats by code (reusing the placeholder mechanism pattern of `auditFindings`).
  2. Rules can only reference the fed patternId; findingKeys ⊆ the pattern's key set.
  3. The condition field values must be ⊆ the spec/map enums that actually appeared in the pattern.
  4. Adhering to the causalLint spirit: bans evidence-free causal assertions.
- Failure handling: bad-json retries once (same strategy as `analysis.ts`); if rule count is 0 after audit → keep the old rules.json without overwriting, and display the consolidation failure reason on the report page.

## 4. Rule Application + UI

### New Match Automatic Tagging (No AI Call)

- After the renderer produces candidates in `extractCandidateFindings`, it fetches rules.json via IPC, and runs the rule engine on candidates using the **exact same matching predicates** exported by `packages/analysis`.
- Hit → Attaches a badge to the finding/candidate in the match report: "Habitual Problem · {{hits+1}}th time in the last {{windowMatches}} matches" (numbers interpolated from stats, not generated by any model).
- Badge is clickable → jumps to the corresponding rule on the long-term pattern report page.

### Long-Term Pattern Report Page

Attached next to StatsDashboard (reusing its page skeleton):

- Rule list: active/improved badges, description, advice, conditions.
- Mini-curve of frequency trend per rule (stats.trend, bucketed per 5 matches).
- Clickable evidence matchId jumping to the corresponding match report.
- Manual "Re-consolidate" button + last consolidation time / ledger coverage match count.
- Displays progress when backfilling is incomplete.

### IPC Surface (New, following existing naming)

`gladlog:learning:getRules` / `consolidate` / `getState` (including backfill progress) / events `gladlog:learning:progress|done|error`.

## 5. Triggers and Lifecycle

- **Consolidation Trigger**: Upon analysis done, check if the ledger has ≥10 new matches since the last consolidation → runs automatically; the manual button on the report page can run it anytime. Concurrency guard (same Set pattern as `deepening`).
- **Retirement**: Every consolidation recalculates stats for all existing rules; recent window hits ≤ `RULE_RETIRE_MAX_HITS` → status `improved` (not deleted, serves as evidence of progress on the report page); frequency rebounding ≥ `PATTERN_MIN_HITS` → automatically resurrects to active. Retirement/resurrection is purely deterministic and bypasses the AI.
- **Rule Identity**: ruleId is derived from category+findingKeys+condition (stable hash), making consolidation idempotent — running the same ledger twice yields the exact same rule set, AI only affects the description text.

## 6. Error Handling and Boundaries

- Bad ledger rows: skipped, counts reported (not silent).
- Same-match re-analysis: last-write-wins, old rows remain in the file, compacted and rewritten in the background when reaching a threshold (e.g., >20% redundancy) (tmp+rename atomic, same method as analysis cache).
- Language switch: description/advice missing current language → report page triggers lazy re-translation (only reruns the distillation step, stats and rule set remain untouched).
- Library is very small (<PATTERN_WINDOW_MATCHES matches): window takes actual match count, report page explicitly states "Insufficient sample, patterns for reference only"; < 5 matches produces no rules.

## 7. Testing and Acceptance

- Unit Tests (fixture method, desktop-dev convention):
  - patternScan: threshold boundaries, front/back half distribution check, condition slice significance.
  - Audit: rules with forged numbers / out-of-bounds patternId / out-of-bounds condition are discarded.
  - Retirement/resurrection predicates; ruleId stable hashing idempotency.
  - Ledger: last-write-wins, bad row fault-tolerance, equivalence before and after compaction.
- **Acceptance provides before/after numbers** (verification rule): Backfill + consolidate on the real 794 match library, report "Filtered N stable patterns / Distilled M rules / Audit discarded K items", spot-check 3 rules and trace every interpolated number in the description back to the ledger to recalculate and verify.
- Single source predicate check: Badge rendering, report page, patternScan referencing the same set of constants — write unit tests asserting equality in places where shared imports cannot be achieved.

## 8. Implementation Scope Slicing (reference for writing implementation plans)

1. Ledger tier: ledger read/write + analysis.ts write point + backfill.
2. patternScan pure function + unit tests.
3. learning.ts service: distillation prompt + audit + rules.json + IPC.
4. Rule engine application + match report badges.
5. Long-term pattern report page.

Each step can be independently verified; after completing 1+2, you can first see "what patterns are filtered out" on the real library and adjust thresholds, without waiting for the full pipeline.
