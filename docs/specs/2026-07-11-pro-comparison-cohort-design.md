# SP-B1: Pro Comparison Population Corpus Reconstruction Pipeline — Design

Date: 2026-07-11
Status: Design (Pending user review)
Associated with: The first sub-project of SP-B (Pro Comparison / compare subsystem). SP-B2 (compare engine + UI) has a separate spec.

## Goal

In one sentence: An **offline maintainer build tool** that uses gladlog's own parser + ported healerMetrics to recalculate all population baselines from 2300+ public feeds on wowarenalogs.com, producing a version-stamped, de-embedded static `reference_vectors.json` for consumption by the SP-B2 compare engine. **The released desktop App has zero external dependencies at runtime**—it only consumes static corpus on package/CDN, isomorphic with sub-project 5 (game data pipeline pulls offline from wago.tools, bundles static JSON).

## Background and Motivation

The old fork's Pro Comparison has been refactored into an honest pipeline of "server calculates / LLM only narrates / claimChecker deterministically discards any report citing unprovided numbers or skills" (hallucinations 30%→≤4%, exemplar path won 86% in 100-match A/B test). This logic does not require Next.js / Firestore (Firestore is only a web fallback path) and can be entirely moved into the gladlog desktop main process as an IPC handler (SP-B2). However, the population corpus `reference_vectors.json` it consumes contains metrics calculated by the **old parser**; whereas gladlog uses its own parser to measure users. Sub-project 4a has proven that there is a systemic drift between old/new parser metrics (having refitted spec baselines). If the population uses the old parser and the user uses the new parser, percentile comparisons will have systemic bias. Therefore, the population must be recalculated using the gladlog pipeline—which is the work of this spec.

## Scope

**This spec (SP-B1)**:

- Port metric calculation (healerMetrics + extractRotations/crisisEvents) into `@gladlog/analysis`.
- Create a new offline collector tool: feed collection → gladlog parser → gladlog metrics → Python talent clustering bridge → aggregation by cell → write version-stamped corpus.
- Full corpus reconstruction (Solo Shuffle + 2v2 + 3v3 all recalculated using gladlog parser, not just arena).
- Corpus validator (hard gate).

**Out of scope**:

- SP-B2: compare engine (desktop IPC handler for verifiedComparison / exemplar prompt / claimChecker) + ProComparisonVerified UI + CDN versioned distribution.
- SP-A: Structured analysis UI (FindingsList, etc.).
- Data flywheel (optional anonymous reporting by clients to accumulate samples)—introducing a lightweight reporting interface equates to some kind of backend, which conflicts with the "zero backend" premise, listed as an SP-B future enhancement.

## Architecture and Components

### Port into `@gladlog/analysis` (Controller audits CLEAN extraction for sub-project 0)

| Source File (old fork, audited CLEAN) | Target | Description |
| ------------------------------------- | ------ | ----------- |
| `shared/utils/healerMetrics.ts` | `@gladlog/analysis` | 6 dimensions: offensiveIndex / reactionLatency / ccDensity / defensiveOverlapRatio / effectiveCastRatio / ccAvoidanceRate. Consumes compat legacy match shape (`.units` / `damageOut.effectiveAmount`), just change parser type import; dependent `analyzePlayerCCAndTrinket`/`reconstructEnemyCDTimeline` are already in analysis. |
| `extractRotations` + crisisEvents extraction in `shared/utils/matchEmbeddingRecord.ts` | `@gladlog/analysis` | crisisEvents = sequence of key crisis moments in that match (basis for compare's exemplar selection). Embedding generation is not ported (new pipeline does not use it). |

### Create new offline collector tool (does not go into desktop App)

Place in **newly created `packages/corpus-tools`** (dedicated offline package, completely isolated from desktop App build, does not go into release package), pure Node CLI:

```
feed (wowarenalogs.com GraphQL, MIN_RATING=2300, quota by spec)
  → Download each match log text
  → GladLogParser (gladlog's own parser)
  → toLegacyMatch/toLegacyShuffle (compat)
  → computeHealerMetrics + extractCrisisEvents (gladlog analysis)
  → Python bridge get_spec_clusters.py (talent clustering → pythonClusterRank)
  → Aggregate by cell (see below)
  → Write reference_vectors.json (version-stamped, de-embedded)
```

Reuse the logic from old fork CLEAN files, change parser/utils import: `buildArenaCorpus.ts` + `buildSoloShuffleCorpus.ts` (merge into a unified collector, parameterize bracket), `buildHealerPlaystyleCorpus.ts` (enrich), `processAndUploadVectors.ts` (aggregate; remove upload/embedding, only keep local aggregation and file writing).

### Cell Definition (debate conclusion: escaping the aggregation trap)

**Problem**: Healer metric profiles are highly dependent on the enemy composition; rough aggregation by `spec × bracket` will calculate a "frankenstein baseline" that does not exist in real matches. Refining to a complete `enemy_comp` fragments the sample.

**Solution**: cell = `spec × bracket × matchArchetype`, archetype reuses gladlog buildMatchContext's **existing** coarse-grained classifier (`[MATCH TYPE: cc_swap_burst / dedicated_tunnel / …]`, a few buckets, not 39² types of comp). Provides tactical context without fragmenting samples. Paired with **hierarchical fallback**:

1. Prioritize using `spec × bracket × archetype` cell;
2. If the cell sample < N_floor → fallback to `spec × bracket` (archetype-agnostic) parent cell;
3. If parent cell is still < N_floor → mark `insufficient: true`.

When consumed by SP-B2: combinations that are insufficient display "Insufficient samples, comparison currently unavailable", and will absolutely not yield fake percentiles.

**Tension between quota and N_floor (requires parameter tuning during implementation phase)**: The archetype dimension is only valuable if each archetype-cell can gather N_floor=30. The old SS collector's `SPEC_QUOTA=50/spec` spread over ~4 archetypes left only ~12 per cell, mostly failing to meet the standard and falling back to bracket-wide. Therefore, the collection quota for this pipeline must be set to **"ensure every mainstream archetype of each spec×bracket clears N_floor"** (empirical value around `SPEC_QUOTA ≥ 30 × number of mainstream archetypes`, i.e., 100+/spec/bracket); unpopular archetypes are allowed to fallback to bracket-wide (acceptable). Specific quotas are determined during implementation based on the actual archetype distribution of each spec, not a fixed constant.

**Do not introduce embedding nearest neighbors**: That is the exact old design abandoned by the old repository due to 30% hallucinations; exemplar-led (honest narration based on metrics + crisisEvents) is the proven winning path.

## Corpus schema (version-stamped + de-embedded)

```jsonc
{
  "wowPatchVersion": "11.0.7.58123",   // debate conclusion: version stamp, allowing SP-B2 to determine expiration
  "builtAt": "2026-07-11T...",
  "sourceFloor": 2300,                  // MIN_RATING
  "cells": [
    {
      "spec": "RestorationDruid",
      "bracket": "3v3",
      "archetype": "cc_swap_burst",     // or "*" indicates bracket-wide parent cell
      "sampleN": 47,
      "insufficient": false,            // sampleN < 30
      "metrics": {                      // distribution per dimension (percentile), non-single value
        "offensiveIndex": { "p10": .., "p50": .., "p90": .., "n": 47 },
        "reactionLatency": { "p10": .., "p50": .., "p90": .., "n": 44 }, // n per dimension (some matches lack this dimension)
        // … remaining 4 dimensions
      },
      "exemplarCrises": [ /* Several high-rated player crisis moment samples, for exemplar selection */ ]
    }
    // … One entry per (spec,bracket,archetype) + one entry per (spec,bracket,*) parent cell
  ]
}
```

About 1.7MB after de-embedding (slightly increased after adding archetype dimension, still < 3MB).

## Data Sources and Compliance

- **Primary Source**: wowarenalogs.com GraphQL feed (public API of user's **own old product**, data sovereignty belongs to the user, not scraping competitors; user has confirmed feed can return logs). Only build-time, maintainer-side, offline invocation.
- **Fallback Source** (debate adopted): User's self-collected log corpus as a cold start/fallback basis, in case of feed fluctuations.
- **Build-time Python Dependency**: `get_spec_clusters.py` in `/Users/mingjianliu/code/wow-talent-gear-collector` (already exists). Maintainer-side, offline.
- **Release Layer**: App has zero external dependencies at runtime, only consumes static corpus.
- **Compliance**: Extraction only touches audited CLEAN files (healerMetrics / matchEmbeddingRecord / buildArenaCorpus / buildSoloShuffleCorpus / buildHealerPlaystyleCorpus / processAndUploadVectors are all CLEAN); `components/icons.tsx` (NEEDS_SCRUB) belongs to SP-A/SP-B2 UI scope, not in this spec. agy/subagents **must not read old fork**, extraction is done by the controller.

## Error Handling and Validation Gates (Hard gate, CI/Wrap-up)

- **feed go/no-go**: Step 1 of B1 smoke tests the feed (whether it can return 2300+ logs according to spec quota). If it fails, switch to fallback source or halt and report, avoiding discovering it halfway through building.
- **Per-cell validation**: The `0 records === 1.5` sentinel for `reactionLatency` must be cleared (old arena bug); crisis skill names must be all ASCII (English, not KR/CN localized); `sampleN ≥ 30` otherwise insufficient.
- **Quota saturation**: The collector stops for a spec as soon as it reaches the quota for that spec (the old SS collector would wastefully page to MAX_PAGES, needs to be killed early).
- **Metric consistency spot-check**: For a small number of fixture matches, compare gladlog healerMetrics output with golden values from the old repository before porting (allowing the parser drift envelope adjudicated by 4a, but structure/dimensions must be consistent).

## Testing

- Port CLEAN unit tests of `healerMetrics.ts` / `matchEmbeddingRecord.ts` (golden assertions, run on gladlog-compat fixtures).
- End-to-end run of the collector on small-sample fixtures (a few self-collected logs), asserting cell aggregation + hierarchical fallback + insufficient marking.
- Unit test the corpus validator itself (feed constructed bad cells: 1.5 sentinel / non-ASCII / N<30, assert all are caught).

## Delivery Strategy (subagent-driven-development + agy)

- Follow SDD: dispatch implementation subagent per task + task review + comprehensive wrap-up review.
- **agy roles**: `exec` (write self-contained code from clean interfaces/specs provided by controller, such as corpus validator, mechanical parts of metric porting) + `review`/`verify` (cross-family independent review of diffs and load-bearing claims). Today's overturn arbitration + meta-eval has verified that agy cross-family independence is effective.
- **Hard boundaries**: Extracting old fork code can only be done by the controller auditing against sub-project 0; agy/subagents receive clean interfaces and specs, not pointing to old file paths.
- Independence rule: Do not use claude-family alias to review Claude's own work.

## Debate Record (spec ritual, agy / Gemini 3.1 Pro, conversation 4cd1e554)

- **Acknowledge**: Static bundling becomes outdated with seasons/hotfixes ("marking the boat to find the sword") → corpus carries `wowPatchVersion`, distribution changed to CDN versioned silent refresh (SP-B2 layer); sample starvation N<30 causes noise → N_floor=30 hard gate + insufficient marker; data flywheel is a good idea but introduces a backend, listed for future.
- **Correct Gemini Assumptions**: wowarenalogs is the user's own asset, license/competitor scraping concerns do not apply; adopted self-collected corpus as fallback source.
- **Defend + Improve**: Aggregation trap (comp dependency) → Do not re-introduce embedding (abandoned in old repository due to hallucination), instead use gladlog's existing coarse archetype for celling + hierarchical fallback, balancing tactical context with sample size.
- Endgame STANCE: PARTIAL (Core architecture approved, aggregation trap resolved via archetype-celling).

## SP-B2 Preview (Next spec, not in this round)

Desktop main process IPC handler: `buildCompareLocalContext` (user match's gladlog metrics) → lookup corpus matching cell (archetype hierarchical fallback) → `verifiedComparison` (dimension-by-dimension percentile) → `buildExemplarLedPrompt` → Anthropic streaming → `claimChecker` deterministic gate → `ProComparisonVerified` UI. CDN versioned corpus refresh (compared against wowPatchVersion). Cache same as ai.analyze (per match + corpus version).
