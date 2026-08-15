# 7-Day Commit Review Report (2026-07-13 → 07-19) — Submitted for agy Review

**Status**: Concluded. Drafted by Claude Opus 4.8 → Reviewed by agy / Gemini 3.5 Flash
(verdict=REQUEST_CHANGES, all original 11 items affirmed, +2 new items added; I adopted 1.5 of them
and rebutted its erroneous rationale on P2#6) → Among the 13 items, **11 have landed and each committed individually**,
P1#2 has an implementation design, and 2 were evaluated and explicitly decided as no-op. Itemized results in checklist at end of document.

Sections P1/P2/P3 below preserve original arguments from drafting (including questions posed to agy at the time);
review conclusions are consolidated in the "agy Review Conclusions" section — this highlights which concerns were ruled out versus confirmed.

## Review Scope and Methodology (Honest Statement)

- Scope: `51221c0^..HEAD`, 261 non-merge commits, 347 files, +51969/-5625.
- **I did not read diffs commit-by-commit.** Reading commit-by-commit at this volume becomes a laundry list, so I stratified by risk:
  on the aggregated net diff, I deep-read source code for "new core logic + historical bug types named in CLAUDE.md",
  while other parts (docs/plans, eval scripts, generated data JSON, styling) were only scanned for structure.
- Files deep-read: `deepDive.ts`, `burstLedger.ts`, `positionAnalysis.ts` (partial),
  `candidateFindings.ts` (dpsOwnerEvents), `healerExposureAnalysis.ts` (constants block),
  `desktop/src/main/analysis.ts`, `StructuredAnalysisPanel.tsx`, `GcdSwimlane.tsx`,
  `log-pipeline/{flusher,collectLogs,protocol/reconstruct}.ts`.
- **Not deep-read**: 20+ deepDive* scripts in eval, 20 new derive modules in renderer,
  generated data for arenaFloors/spellIcons, styles.css (+2776). These represent coverage gaps, not proof of clean code.
- `npm run typecheck` currently all green. The findings below are not compilation errors, but semantic issues.

---

## P1 — Correctness, Recommended to Address Before Next Release

### 1. STAYED_IN "Opens Deep Dive Gate Even Without HP Loss": Comment-Promised HP Gate Does Not Exist

- `packages/analysis/src/analysis/deepDive.ts:642`
- `packages/analysis/src/utils/positionAnalysis.ts:305-350`

Inside `hasCoachableSignal`:

```ts
// Positioning mistake (Fix 3): STAYED_IN now triggers only upon HP loss; MISSED_PUSH / uncast are genuine mistakes.
if (it.kind === "position") return true;
```

However, when `computeOwnerPositionEvents` generates STAYED_IN, `hpStart`/`hpMin` are merely **computed and populated into
fields**, with no HP-based filtering prior to `events.push` — the criterion remains purely geometric (`delta <
STAY_DELTA_YARDS`). The context formatter in the same file proves this further:

```ts
// positionAnalysis.ts:671-673
: e.ownerHpMinPct >= 85 && (e.ownerHpStartPct ?? 100) - e.ownerHpMinPct < 15
  ? " (no real cost)"
```

The code itself admits that "STAYED_IN with no real cost" exists and must be explicitly tagged.

**Consequence**: The deep dive gate (whose entire value proposition in Fix 1 was "clean windows don't warrant a model call")
is completely bypassed on the positioning path — a STAYED_IN dropping HP 100%→98% opens the gate, triggering a paid call + high probability
of filler paragraphs. This directly erodes the filler 2.62→5.0 gain recorded in memory.

**Recommendation**: Pick one of two; don't rely on comments:

- (a) Add an HP condition for `kind=stayed-in` inside `hasCoachableSignal`, reusing the formatter's `(no real cost)`
  criterion and exporting it as a single predicate; keep `missed-push`/`cd-out-of-range` passing straight through.
- (b) Or avoid emitting no-cost STAYED_IN at the `computeOwnerPositionEvents` source — but note the
  formatter relies on it to render the "low risk" tag; changing the source alters prompt text and requires an eval run.

**Favor (a)**, because gating responsibility belongs to caller (f379503 stated "gate moved to caller").

**Key check for agy**: Is there a third caller that already performed this HP filtering that I missed? I grepped
all consumers of `ownerHpMinPct`, which were only deepDive facts population and formatter tags.

### 2. Full-Immunity Burst Missed by `burst-into-immunity`

- `packages/analysis/src/utils/burstLedger.ts:174-215`
- `packages/analysis/src/analysis/candidateFindings.ts:432-437`

`defensivesHit` is only calculated when `dominantTarget` is non-empty, and `dominantTarget` comes from
`damageByTarget[0]` — meaning **a damage record must exist**:

```ts
const top = damageByTarget[0];
if (top) {
  /* defensivesHit / immunity calculated only in here */
}
```

`damageOut` is populated by parser's `record.damage` branch (`packages/parser/src/l3/collect.ts:50`);
`SPELL_MISS` (IMMUNE) carries no `damage`, so it never enters. Thus:

- Immunity applied **midway** → first half has damage → dominantTarget exists → immunity caught ✅
- Immunity active **before burst starts** (Divine Shield / Ice Block covering throughout) → target has zero damage records → if player
  hit no one else, `dominantTarget = null`; if they hit someone else, dominant target becomes that other unit → **immunity completely invisible** ❌

What is missed is precisely the most coachable scenario: "popping burst before enemy immunity expired". Comment at deepDive.ts:655
calls burst-into-immunity the "flagship offensive error", yet it goes undetected in its most classic form.

**Recommendation**: Do not bind immunity determination to dominantTarget. Within burst window, run
`buildAuraIntervals(..., DEF_OR_IMMUNE_IDS, ...)` across **all enemy players**; whenever an immunity overlaps with span and that unit is
the "intended burst target" (derived from cast targets / previous window targets / recent targeting audit results), emit an entry.
Requires first defining an "intended target" predicate — this is a design trade-off; agy should provide proposal advice rather than direct implementation.

**Key check for agy**: Does parser truly never produce damage records for immune misses? I only read
`l3/collect.ts`'s damage branch without tracing l1/l2 event classifications. If l2 categorizes IMMUNE miss
as an `amount=0` damage record, this entire point does not hold.

### 3. `focusT` Systematically Too Early When "Death Is Close to Match End" (Most Common Finding Hit First)

`packages/analysis/src/analysis/deepDive.ts:243`

```ts
const anchorTo = Math.min(durS, Math.max(...ts) + PACK_AFTER_S); // Clamped by durS
const focusT = anchorTo - PACK_AFTER_S; // Back-calculated to anchor
```

`focusT` intends to represent "anchor timestamp" = `Math.max(...ts)`, but back-calculating from the clamped `anchorTo`
fails once clamping takes effect.

Example: anchor t=100s, match durS=105s → `anchorTo = min(105, 110) = 105` →
`focusT = 95`, 5 seconds earlier than real anchor. Thus:

- HP checkpoints shift from 85/90/95 to 80/85/90 — **all three "pre-death HP levels" in prompt are displaced**;
- Truncation sorting `Math.abs(a.t - focusT)` centers on wrong point, potentially pushing death-moment evidence out of 14-item cap.

In arena, decisive deaths inherently happen near match end (death is often the reason match ends), so
`max(ts) + 10 > durS` is not an edge case, but the **norm for the most critical finding**.

In the same file, offensive path writes `const focusT = Math.min(...ts);` (deepDive.ts:604) —
the two paths have inconsistent definitions of "focus" (one leans towards end anchor, one towards start anchor).

**Recommendation**: Use `const focusT = Math.max(...ts);` directly from anchor without back-calculating from anchorTo.
Concurrently unify focusT semantics across both paths or document why offensive uses min while survivability uses max.
Existing test cases in `deepDive.test.ts` never triggered clamp (150 / 50); **add a regression test with
`durS < max(ts)+10`**.

---

## P2 — Robustness / Duplicate Paid Calls / Spec Violations

### 4. 047b5c0 Only Protected Initial Round; `deepen` Still Triggers Duplicates on Page Switch (Duplicate Paid Calls)

- `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx:263-320`
- `packages/desktop/src/main/analysis.ts` (`running` set maintained only inside `run`)

The trigger logic for deep dive resides in renderer's effect, conditioned on `result && !result.deepened`.
The `deepened` flag is persisted by main process `writeMerged`. During the dozens of seconds while deepen is **in flight**,
`deepened` in cache remains falsy — if the user switches away and returns, the panel remounts, `getCached` retrieves
initial results, and the effect fires again → **second deepen**. Main process `nextGen(matchId)` aborts the first
call as stale, but tokens for that call were already spent.

This is the same category as "Root Cause 2" fixed in 047b5c0, but missed on deepen (`running` set only has `run`
calling `add`, so `isRunning` evaluates permanently false for deepen).

**Recommendation**: Also call `running.add` inside `deepen` (or introduce a separate `deepening` set + `isDeepening(matchId)`
IPC), and check before firing renderer effect.

### 5. Window Between `getCached` → `isRunning` Drops Results, Leaving Panel Idle

`StructuredAnalysisPanel.tsx:160-183`

```ts
const cached = await bridge().analysis.getCached(matchId);
if (cached) { … } else if (await bridge().analysis.isRunning(matchId)) { setState("running"); }
```

If analysis completes precisely between the two awaits: `getCached` returns null (not written to disk at that instant),
`isRunning` returns false (already cleared), and done event was emitted long before subscription was established →
**panel remains in idle state while results are actually resting in cache**, showing the large "Click to Analyze" button.

The race window is narrow, but is precisely the user experience 047b5c0 sought to eliminate ("disappears upon switching back").

**Recommendation**: Call `getCached` again inside the `isRunning === false` branch; or provide an atomic
`getState(matchId) → {cached, running}` single IPC from main process to eliminate this seam at the root.

### 6. Gate Constants Coupled via Comments — Direct Violation of Express CLAUDE.md Rules

- `packages/analysis/src/utils/healerExposureAnalysis.ts:44-51`
- `packages/eval/src/quality/positioningScan.ts:65-66`
- `packages/analysis/src/utils/positionAnalysis.ts:51`, `ccTrinketAnalysis.ts:45`

```ts
// These two constants MUST stay equal to TIME_SLACK_SECONDS /
// POSITION_MAX_GAP_MS in packages/eval/src/quality/positioningScan.ts.
const LOS_SWEEP_SLACK_S = 2;
const LOS_SWEEP_GAP_MS = 3_000;
```

**Current values are correct** (2 == 2, 3000 == 3000, verified). The problem is coupling method: CLAUDE.md states
verbatim — "place predicate in single export, import on both sides; **if infeasible, write unit tests asserting equality, do not rely on comments**".
Here there is neither export nor unit test, only comments. Furthermore, `POSITION_MAX_GAP_MS = 1_500` is declared
privately across `positionAnalysis` / `healerExposureAnalysis` / `ccTrinketAnalysis` (prefixed CC_), creating **homonymous constants with different meanings**
against positioningScan's `3_000` constant, easily confused when reading code.

Considering the historical cost documented in CLAUDE.md (5 bugs in 2026-07 audit all belonged to this category, including
"fractional vs rendered second scan grid"), this should not remain.

**Recommendation**: Hoist `TIME_SLACK_SECONDS` / `POSITION_MAX_GAP_MS` into a shared module export,
imported on both sides; at minimum add unit tests asserting equality. Concurrently rename the three 1_500 constants
(e.g., `INTERP_MAX_GAP_MS`) to eliminate name collisions.

### 7. User-Visible Text Uses Two Time Renderers, and `fmt` Is Duplicated in Two Places

- `packages/analysis/src/analysis/deepDive.ts:39`
- `packages/analysis/src/analysis/candidateFindings.ts:24` (verbatim duplicated definition)
- `packages/analysis/src/utils/cooldowns.ts:1165` `fmtTime`

```ts
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));  // → "83.5"
export function fmtTime(seconds) { … }                                        // → "1:23"
```

In the same report, timeline / burst ledger renders `1:23` via `fmtTime`, whereas finding and
deepDive bodies write `83.5` via placeholder interpolation. Users must manually convert between the two scales. CLAUDE.md's
"anchor on rendered values" addresses this exact issue — currently gate recomputation produces no failures (facts are self-consistent), but surface
inconsistency remains, and duplicating `fmt` in two places means future edits will inevitably miss one.

**Recommendation**: Hoist `fmt` into a single export imported on both sides (uncontroversial, recommend doing immediately);
whether to standardize to `fmtTime` is a product decision — alters prompt text and requires eval runs, **agy should provide advice without modifying code**.

---

## P3 — Hygiene Items (Low Priority, Can Batch Together)

8. **`GcdSwimlane.tsx:94-137`**: `orderedTracks` / `cols` are bare expressions, creating new array identities on every render, so dependent
   `useMemo` **never hits cache**, recalculating layout every frame; three instances of
   `eslint-disable-next-line react-hooks/exhaustive-deps` (:136/:145/:153) mask this signal.
   Recommend wrapping `orderedTracks`/`cols` in useMemo and removing the disable on :136.
   (The disable on :145/:153 is intentional for "scroll only on t/nonce changes", which is reasonable and should be kept.)

9. **`desktop/src/main/analysis.ts`**: `generations` Map only grows without deletion, leaving an entry for every viewed
   matchId in long sessions. Overhead is tiny, but since `running` gets cleared, clean up completed unreferenced generations in `finish` as well.

10. **`burstLedger.ts:281-283`**: `targetDeathMs` uses
    `deathRecords.map(...).find(t => t > fromMs)` to find "first death after window", which assumes
    `deathRecords` is sorted chronologically ascending. If upstream does not guarantee ordering, this does not yield the earliest. Recommend
    switching to `Math.min(...filter(...))` or documenting ordering as a formal contract in types/comments.

11. **`deepDive.ts` Truncation vs Gate Order**: Truncation via `PACK_MAX_ITEMS = 14` occurs
    before `hasCoachableSignal` (gate is on caller side). Theoretically, the sole coachable item could be truncated,
    causing a pack that should be deep-dived to be judged a "clean window". Currently sorted by "proximity to focusT", and coachable items
    are usually close to the anchor, so probability is low. **Noted for awareness, not recommended to change now** — changing requires rerunning eval.

---

## Portions I Believe Are Sound (For agy Cross-Validation, Avoid Wasting Time Reviewing)

- `log-pipeline`'s `flusher.ts` / `collectLogs.ts` / `protocol/reconstruct.ts`:
  Read in detail. Truncation/shrinkage detection, partial read loops, advance-by-actual, gunzip failure deferral,
  overlap self-healing are all handled properly; `remaining` is deleted prior to every continue path, ensuring loop termination.
  No issues found.
- The generation bucketing in 047b5c0 itself (global counter → per-matchId Map) is on the right track; Root Cause 1 was indeed that.
  The only issues are that it didn't cover deepen (see P2#4) and the await gap (P2#5).
- Full role name comparison in `offensivePackItems` (0b6d8df), adding `inWin` guard to `burst-start` entries:
  these two were adopted from previous agy review, implemented correctly with rationales documented in comments, very good.

---

## agy Review Conclusions (2026-07-19, Gemini 3.5 Flash Medium, verdict=REQUEST_CHANGES)

**All 11 items affirmed "valid"**, including negative evidence for the three P1 items — agy independently traced call chains to verify:

- **P1#1**: Searched full repo for `computeOwnerPositionEvents` call sites (including `buildMatchContext.ts`,
  `deepDivePositionProbe.ts`), confirming **no third caller performing HP filtering exists**. My concern was ruled out.
- **P1#2**: Traced down to the layer I didn't reach — in `parseLine.ts`, `SPELL_MISSED` does not populate
  `result.damage` because it does not end in `_DAMAGE`, resulting in `damageOut` receiving 0 records. Chain closed, conclusion affirmed.
- **P1#3**: Calculations matched mine (100s/105s → focusT=95s, HP checkpoints 80/85/90). Suggested unified semantics:
  survivability `Math.max(...ts)` (anchor death/climax), offensive `Math.min(...ts)` (anchor opening),
  **the two paths should naturally have different semantics; do not force unification**, just avoid back-calculating from clamped anchorTo.

agy also ran `npm run typecheck` (0 errors) and parser/parser-compat/log-pipeline unit tests (184 passed).

### Rebuttal to agy: Rationale on P2#6 Was Flawed (Conclusion Still Valid)

agy wrote: "the analysis module uses 1500 ms while the evaluation scanner uses 3000 ms,
creating discrepancies in positioning validation" — **this is a misreading; treating it as drift evidence misleads the fix**.

In reality they are two distinct predicates:

- `healerExposureAnalysis.LOS_SWEEP_GAP_MS = 3_000` ←→ `positioningScan.POSITION_MAX_GAP_MS = 3_000`,
  **this pair is equal**, serving as LoS sweep predicates without drift.
- The three `1_500` constants are a separate matter (interpolation grounding guards) and were never meant to equal 3000.

Thus, the issue in P2#6 **is purely the coupling method** (relying on comments + homonyms with different meanings), not that "values have already drifted".
Fix proceeds per original recommendation: single export source / add equality unit tests / rename 1_500 to avoid name collision.

### Two New Items from agy — Adoption Determinations

#### New #1: `auditDeepDives` Placeholder Regex Diverges from claimChecker → **Adopted**

- `packages/analysis/src/compare/claimChecker.ts:1` — `/\{\{\s*([\w.]+)\s*\}\}/g` (**tolerates spaces**)
- `packages/analysis/src/analysis/deepDive.ts:780` — `/\{\{(p\d+)\.[^}]+\}\}/g` (**does not tolerate leading spaces**)

Verified: the two regexes genuinely diverge. If model outputs `{{ p1.t }}`: claimChecker accepts it, raw number checks accept it
(`replace(/\{\{[^}]*\}\}/g," ")` eats spaces), but `usedKeys` fails to match →
when `citedKeys` is empty, entire entry is silently discarded; when non-empty, chips degrades to only recognizing citedKeys,
**silently neutralizing the 0b6d8df fix ("chips takes citedKeys ∪ usedKeys to prevent jumping to wrong timestamp")**.

This is a textbook "two predicates for the same fact", directly matching issues highlighted in CLAUDE.md. Recommend having `usedKeys`
reuse claimChecker's `PLACEHOLDER` (export it), rather than rewriting its own.
Rated P2 — trigger depends on model generating spaces, which prompt neither mandates nor forbids; probability unknown but cost is silent content loss.

#### New #2: effect Missing cancelled Guard → **Partially Adopted (agy's description exaggerated)**

The `getFlags` effect in `StructuredAnalysisPanel.tsx:109-118` indeed lacks a `cancelled` flag,
meaning when rapidly switching matches, flags from an older match could arrive later and overwrite the new match — **this is valid**,
rated P3; add a `cancelled` guard following the pattern in the :160 effect.

However, agy included the `aggregate` effect at `:85-107`, claiming it would "overwrite the goals for
Match C with Match A's" — **invalid**. `aggregate()` accepts no matchId parameter, returning a cross-match
global aggregation; calls from A/C retrieve the exact same data, and arrival order cannot display incorrect content.
The only actual issue is "depending on `[matchId]` causes a redundant refetch on every match switch", which is inefficiency, not a bug, barely qualifying as P3.

---

## Action Checklist (13 Items Finalized Across AI Review — Execution Results)

11 items landed and committed individually; each verified with tests failing against old implementations (not "pass immediately" hollow tests).

**Completed**

| # | Item | commit |
| --- | --- | --- |
| P1#3 | focusT anchors latest anchor, not back-calculated from clamped anchorTo | `536295c` |
| P2#4 | deepen idempotency guard (switching pages no longer burns duplicate tokens) | `ce33ef9` |
| P2#5 | Panel remount switches to single atomic getState | `d4bf4b4` |
| P2#6 | Position sampling predicates single-sourced export + renamed to avoid collisions | `46fc19a` |
| New #1 | Placeholder regex single-sourced from claimChecker | `5845f95` |
| P3#8 | GcdSwimlane layout memo genuinely takes effect | `1da25f9` |
| P3#9 | Generation entry recycling (only when match is quiet) | `8a37def` |
| P3#10 | Target death truncation picks earliest, independent of ordering | `624952c` |
| New #2 | getFlags adds cancelled guard (second half rejected) | `90a1e36` |
| P2#7 | fmt extracted to single-source fmtFactNum (standardizing fmtTime skipped) | `dd428dd` |
| P1#1 | STAYED_IN requires real cost to open deep dive gate | `43f4b65` |

**Designed, Unimplemented**

- P1#2 Full-immunity detection → `docs/specs/2026-07-19-immunity-detection-design.md`.
  Writing the spec revealed a key finding, downgrading it from "design trade-off" to a problem with direct evidence:
  **immunity cancels damage, not spellcasts** — `spellCastEvents` carries `destUnitId` on every entry
  (`convert.ts:383`), recording target entries for every cast landed into Divine Shield. Thus, "intended burst
  target" requires no heuristic guesswork; inspect cast targets directly. The spec still contains several constants to calibrate
  (`INTENT_MIN_CASTS`, whether pet casts count), left for deterministic scanning rather than hardcoding in code.

**Evaluated as Out of Scope / No-Op**

- P3#11 Truncation (`PACK_MAX_ITEMS=14`) occurs before gate; theoretically the sole coachable item could be truncated.
  Sorted by "proximity to focusT", and coachable items are usually close to anchor, so probability is low; altering requires rerunning eval. Recorded for reference only.
- P2#7 Second half: standardizing facts `83.5` to fmtTime `1:23`. Product decision that alters prompt
  text. Replaced by pinning the divergence between the two scales in module comments and unit tests to prevent casual "unification".

**P1#1 Empirical Impact Accurately Recorded** (Deterministic scan, 4 corpora 556 packs, no model calls):

| Corpus | packs | with position | stayed-in | no real cost | Gate flip |
| --- | --- | --- | --- | --- | --- |
| deepdive-220 | 179 | 19 | 17 | 2 | 0 |
| deepdive-hi | 191 | 23 | 21 | 3 | 0 |
| deepdive-2v2 | 136 | 24 | 20 | 1 | 0 |
| public-dps | 50 | 10 | 8 | 1 | 1 |

Among 7 no-cost STAYED_IN instances, only 1 genuinely flipped gate outcome (1 in 556) — the other 6 packs
contained other signals and should have opened anyway. **The benefit here is not saving calls, but eliminating a false premise**: the gate
previously relied on a comment contradicting code; had someone relaxed STAYED_IN geometric criteria, the gate would silently fail without
any test catching it.

**Residual Environmental Issue (Unresolved, Awaiting Confirmation)**

`.claude/worktrees/report-ui-redesign/` is a leftover git worktree containing a full set of stale files.
Running `npx vitest` from repo root scans it using root config, causing failures unrelated to current changes
(misled troubleshooting twice this round). `npm test --workspace=...` is unaffected. Recommend cleaning it up.
