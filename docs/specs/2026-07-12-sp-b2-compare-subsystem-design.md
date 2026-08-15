# SP-B2: Pro Comparison compare subsystem — Design

Date: 2026-07-12
Status: Design (Pending User Review)
Belongs to: SP-B (Pro Comparison). Consumes `reference_vectors.json` produced by SP-B1 (Cohort Corpus) + SP-B1.5 (Build-aware Grouping).

## Objective

In one sentence: Desktop "Your playstyle vs High-rated cohort" — The main process reads the packaged corpus, calculates per-dimension percentiles according to the build-aware cell, and uses **template interpolation** (the model only writes placeholders, the main process fills in the true values) to generate a non-hallucinated, honest narrative, which is rendered into the `ProComparisonVerified` panel of the report.

## Scope

**This spec (SP-B2)**: compare engine (cellLookup fallback + verifiedComparison), template-interpolation prompt + claimChecker gate, main process IPC handler, `ProComparisonVerified` UI, fail-open version downgrade. Corpus is **packaged static resources**.

**Out of scope**:

- **CDN versioned distribution** (pull/version comparison/silent refresh/fallback) → SP-B2.1 (fail-open version check is done in this spec, so expired packaged corpus can gracefully downgrade).
- **SP-A**: Structured analysis UI (FindingsList, etc.).
- Client-side anonymous telemetry (data flywheel) — Future.

## Background and Key Decisions

- **Trust boundary in the main process**: claimChecker (deterministic honesty gate) and corpus reading are in the main process and cannot be bypassed by the renderer. The existing `ai.analyze(matchId, context)` builds context in the renderer; compare is heavier and security-sensitive, so it goes through a **new main process pipeline**.
- **claimChecker = template interpolation (agy debate conclusion, see end of document)**: The "post-hoc token membership check" in the old fork has two fatal flaws—(1) Semantic swap false negative ("Your offensive index 0.49 ranks at the 30th percentile": the numbers are all in the set, but the user value and cohort median are swapped, yet the membership check allows it); (2) Natural language false positive ("about 0.3", "almost half": rounding/colloquial numbers are not in the exact set → the entire piece is mistakenly dropped). Changed to: the model only writes named placeholders `{{key}}`, and the main process deterministically interpolates the true values from a facts dictionary. **Numeric/verdict hallucination is impossible by construction**; claimChecker is reduced to "all `{{key}}` can be parsed + residual scan for bare statistical numbers still written by the model".
- **User metrics calculated in the renderer without drift**: User matches and the cohort are calculated for metrics using the **same** `@gladlog/analysis`, without drift between them (the drift in 4a was between the old/new parser, which doesn't apply here). claimChecker guards the **LLM narrative**; a user tampering with their own client to forge their own record is outside the threat model (personal analysis tool). Therefore, metrics are calculated on the renderer side and passed in via IPC.

## Architecture and Data Flow

```
Renderer (already parsed match + @gladlog/analysis)
  → IPC gladlog:compare:run { matchId, healerMetrics, spec, talents[], bracket, archetype, wowBuild }
Main process createCompareService:
  1. loadCorpus()             Packaged reference_vectors.json (memory cache)
  2. failOpenCheck()          corpus.wowPatchVersion vs wowBuild; keystone nodes invalid in talent data → forces buildGroup="*" for this spec
  3. assignBuildGroup()       keystone boolean gates of corpus.buildGroups[spec] applied to talents (possibly "*" after fail-open)
  4. lookupCell()             4-level fallback: archetype×buildGroup → *×buildGroup → archetype×* → *×*; hits insufficient or empty → no cohort
  5. verifiedComparison()     Per dimension: user value, cohort p10/p50/p90, percentile rank, deterministic verdict label → facts dictionary (named keys)
  6. buildExemplarLedPrompt() facts dictionary + this cell's exemplar crisisEvents; Instructions: only use {{key}} placeholders, bare numbers/self-assessment forbidden
  7. stream(AnthropicLike)    Reuses ai.ts's injected client + generation cancellation
  8. interpolate()            Streaming: fills true values from facts dictionary when placeholder span is complete (buffers `{{`…`}}`)
  9. claimChecker()           (a) Each {{key}} must be in dictionary; (b) Residual scan: bare "statistic-like" numbers outside placeholders (number + %/percentile/dimension name adjacency) → violation
  → Violation or no API key: drop narrative, fallback to **deterministic numbers table** (verifiedComparison rendered directly);
  → Returns { verifiedComparison, report?, droppedReason?, cellMeta:{spec,bracket,archetype,buildGroup,sampleN,insufficient,fellBackTo} }
Renderer → Renders ProComparisonVerified panel (narrative or numbers table fallback), annotates matched cell's build/archetype/sample size
```

## Components and Files

**New `packages/analysis/src/compare/` (pure, no Electron, unit tests)** — Controller extracts old fork logic for subproject 0 audit CLEAN, change imports:

| File                        | Responsibility                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cellLookup.ts`             | `lookupCell(corpus, {spec,bracket,archetype,buildGroup}, nFloor): { cell, fellBackTo }`. 4-level fallback, skips insufficient.                              |
| `verifiedComparison.ts`     | `verifiedComparison(metrics, cell): { dims: PerDim[], facts: FactsDict }`. Per dimension percentile rank + deterministic verdict; produces facts dictionary (all narratable true values, named keys). |
| `buildExemplarLedPrompt.ts` | `buildExemplarLedPrompt(vc, cell, specName): string`. facts + exemplar crises; enforces placeholders, forbids bare numbers.                                 |
| `claimChecker.ts`           | `interpolate(text, facts): string` (stream safe); `claimChecker(rawText, facts): { ok, violations[] }`.                                                     |

**Desktop Main Process**:

- `packages/desktop/src/main/compare.ts` — `createCompareService(deps)`, mirrors `createAiService` (injects client, cache, generation cancellation). Orchestrates steps 1–9.
- `main/ipc.ts` + `preload/api.ts` — Registers `gladlog:compare:run` / `:cancel` / `:getCached`; `GladlogApi.compare` bridge.
- Corpus packaging: `reference_vectors.json` as a main process readable resource (copied into the package at build time).

**Renderer**:

- `renderer/src/report/components/ProComparisonVerified.tsx` — **New** "vs High-rated cohort" section in the report, **coexists** with the current `AIAnalysisPanel` (not a replacement). Renders per-dimension bars (user value vs cohort p10–p90 + percentile), honest narrative or numbers table fallback, cell meta information (build/archetype/N, shows "Insufficient sample" when insufficient).

## facts Dictionary and verdict (Deterministic Foundation of claimChecker)

`verifiedComparison` produces for each dimension: `{ key, value, p10, p50, p90, percentile, verdict }`. The facts dictionary is a **flat named key → formatted string**, for example:

```jsonc
{
  "offensiveIndex": "0.31",
  "offensiveIndex.cohortMedian": "0.49",
  "offensiveIndex.percentile": "30th percentile",
  "offensiveIndex.verdict": "below your build's cohort",
  // ...remaining 5 dimensions; verdict is calculated from deterministic thresholds (e.g. percentile <25 "well below" / 25-75 "in line with" / >75 "well above")
}
```

The prompt instructs the model to only use placeholders like `{{offensiveIndex.verdict}}`; the main process `interpolate` fills them using the dictionary. Unknown `{{key}}` or bare statistical numbers outside placeholders → claimChecker violation → drop narrative and fallback to numbers table.

## fail-open (SP-B1.5 Contract, Hard Constraints)

- `wowBuild` takes the **packaged game data manifest** (`build` in `packages/analysis/src/data/datagen-manifest.json`, updates with the App, packaged + version-stamped resource along with the corpus) — comparing the two detects expired corpus, self-sufficient, no need to check the game process.
- `corpus.wowPatchVersion` major version ≠ `wowBuild`, **or** `corpus.buildGroups[spec].keystoneNodeIds` does not exist in the current talent data (removed/changed ID) → this spec silently falls back to `buildGroup="*"` (archetype-only comparison). Never crashes, never blindly evaluates invalid node IDs.
- Expired packaged corpus → downgrades to archetype-only instead of giving a wrong build baseline.

## Error Handling and Caching

- **Cache**: key = `(matchId, corpus.wowPatchVersion, PROMPT_VERSION)`; invalidated if corpus or prompt changes (same as `ai.getCached`).
- **No API key**: directly outputs deterministic numbers table (no narrative), no error.
- **cell insufficient / no match**: panel shows "Insufficient sample for this build×bracket×archetype, percentiles temporarily unavailable", optionally fall back to numbers of a broader parent cell (annotated).
- **Cancel**: reuses generation counting from `ai.ts`.

## Testing

- `cellLookup`: constructs corpus missing `archetype×buildGroup` but has `*×buildGroup` / `archetype×*`, asserts 4-level fallback hit order + `fellBackTo`; insufficient cell is skipped.
- `verifiedComparison`: golden — given metrics + cell, asserts percentile rank, verdict thresholds, and complete facts dictionary keys.
- `claimChecker` / `interpolate` (adversarial): model output contains unknown `{{key}}` → violation; bare "0.3"/"85%" written outside placeholders → violation; pure placeholders + colloquial numbers ("first 2 minutes") → pass; `interpolate` streaming correctly buffers half `{{`.
- `compare.ts`: injects `AnthropicLike` returning canned template text, asserts interpolate + claimChecker + cache + cancel; violating text → fallback to numbers table.
- fail-open: stale-version corpus / invalid keystone → asserts buildGroup fallback to "*".

## Compliance

- Extracting old fork only touches **audit CLEAN** files (verifiedComparison / exemplar prompt / claimChecker logic is CLEAN); UI (`icons.tsx`, etc. NEEDS_SCRUB) is extracted and scrubbed by the controller, agy/subagents **do not read the old fork**, only taking clean interfaces and this spec.
- Independence: do not use claude-family alias to review Claude's own work (review goes through agy cross-family).

## Debate Record (spec ritual, agy / Gemini 3.1 Pro, conversation 93137a32)

- agy **OPPOSE** post-hoc token membership claimChecker, cites two counterexamples: semantic swap false negative (numbers are in the set, meaning inverted but still passes), natural language false positive (rounding/colloquial numbers cause mistaken drop of the entire piece). steelman = **template interpolation** (placeholders + deterministic value filling, hallucination impossible by construction).
- Adopted template interpolation; verdict labels are also deterministic (prevents qualitative direction inversion). renderer calculates metrics: agy cited 4a drift, upon analysis not applicable (user and cohort share the same parser), self-tampering is not in the threat model; retain renderer calculation, passed in via IPC.

## SP-B2.1 Preview (Next Spec)

CDN versioned corpus: silently refreshes based on `wowPatchVersion` + gate table version, packaged corpus serves as fallback; main process pulls + validates + atomically replaces. Zero other external dependencies changed at runtime.
