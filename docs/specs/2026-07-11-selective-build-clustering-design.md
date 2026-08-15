# SP-B1.5: Selective keystone-talent grouping (build-aware cohort baseline) — Design

Date: 2026-07-11
Status: Design (pending user review)
Part of: SP-B (Pro Comparison). A supplementary sub-project of SP-B1 (Cohort corpus reconstruction), to be landed before SP-B2 (compare engine + UI) because it changes the corpus schema and prescribes the lookup contract for SP-B2.

## Objective

In one sentence: For healing specs where the **talent build substantially changes the compared metrics**, further partition the cohort cells by a **deterministic keystone-talent boolean gate** (spec × bracket × archetype × buildGroup), so that "your playstyle vs high-rating cohort" is compared within the same build family; for specs where build doesn't affect metrics, keep archetype-only to avoid pointless fragmentation.

## Background and Motivation (Empirical)

After wrapping up SP-B1, a build→metric variance study was conducted (3600 real 2300+ Solo Shuffle round records, measured **within fixed archetypes**, compared against a randomly partitioned null):

- **Discipline Priest**: offensiveIndex is distinctly bifurcated — roughly 22% of players run a build with a median offensiveIndex of **0.49 vs the standard 0.20 (2.4×)**, permP=0.000 across all archetypes. This build is marked by **Voidweaver tree** nodes: Expiation (82585), Death's Torment (110277), Abyssal Reverie (82583), which co-occur at the 22% mark.
- **Holy Paladin / Restoration Druid / Restoration Shaman**: Substantial but thinner forks exist on offensiveIndex or ccDensity (e.g., Resto Druid high-CC build marked by **Lycara's Inspiration (92229)**, +1.07 ccDensity, ~10% of players).
- **Mistweaver Monk / Preservation Evoker**: **Zero** substantive build effects — applying a build dimension across the board would just fruitlessly fragment the sample.

Conclusion: build is a **real and large** confounding factor, but **varies by spec**. Mixing offensive-build and standard Disc into the same cohort would make standard build players falsely appear "too low on offense" against a mixed baseline skewed by the 0.49 cohort. Disc Priest is the most popular healer, so it is the flagship case.

**Why keystone boolean gates instead of k-means clustering** (design debate conclusion, see bottom): k-means/dynamic gates have three fatal flaws — (1) Empirical re-partitioning every rebuild → user percentiles silently drift with patch rebuilds (baselines should be deterministic over time); (2) Centroids of sparse binary talent vectors are equidistant → hybrid builds get thrown into wrong cohorts due to irrelevant minor talents; (3) Fixed k forcefully folds real modalities. Keystone boolean gates are deterministic, O(1), interpretable ("Comparing against offensive-build Disc"), and the forks in the variance study happen to perfectly anchor onto named keystone nodes, rather than diffuse combinations.

## Scope

**This spec (SP-B1.5)**:

- **Offline discovery tool** (maintainer-side): Variance study + node separation ranking, yielding **candidate keystone gates** for manual review.
- **keystone-gate table**: Version-stamped, manually-reviewed static data (`spec → keystone nodes + boolean operator → group label`).
- **collector grouping**: For specs with activated gates, split cells further by buildGroup; preserve-build hierarchical fallback; N_floor guard.
- **offensiveIndex winsorization**: Outliers exposed by the study (ratio explodes when healing≈0) are capped before aggregation.
- **Corpus schema extension**: Add `buildGroup` to cells; add `buildGroups` (activated gates, for SP-B2 consumption) at the top level.

**Out of Scope**:

- SP-B2: Runtime classification of user builds into groups (nearest — here it's boolean logic), fail-open degradation, compare engine, and UI. This spec only defines its **lookup contract**, not the implementation.
- Non-keystone-separable forks (diffuse mid-tier node combinations): Intentionally **uncovered**, leaving them archetype-only — debate adoption: these are mostly tuning/utility preference noise rather than independent playstyles.

## Architecture and Components

### 1. Offline Discovery Tool (`packages/corpus-tools/scripts/`, maintainer-side, not included in release)

Reuse the existing `collectBuildStudy.ts` (sampling SS round-by-round `{session, player, spec, archetype, talents, metrics}` rows). Add `discoverKeystones.ts`:

- For each spec, **within fixed archetypes**, run a permutation test on offensiveIndex / ccDensity (H-statistic + random partition null, NP≥500); if any archetype stratum for the spec has permP<0.05 and the median gap ≥ threshold (offensiveIndex 0.10 / ccDensity 0.30), mark the spec as **forking**.
- For forking specs, calculate `median(metric | node present) − median(metric | node absent)` for each talent node, ranked by |diff|; filter **candidate keystones**: prevalence ∈ [8%, 45%] (neither core must-pick nor extremely rare) and |diff| ≥ threshold.
- Output candidate gates (node id + resolved talent name + prevalence + gap + associated metric) to stdout for the maintainer to review and manually write into the gate table. **The tool only suggests, it does not automatically edit the gate table**.

> Study already validated: Disc → {82585, 110277, 82583} (Voidweaver, any); Resto Druid → {92229} (Lycara's Inspiration).

### 2. Keystone Gate Table (`packages/corpus-tools/data/keystoneGates.json`, version-stamped, manual review)

```jsonc
{
  "wowPatchVersion": "12.1.0.68629", // The game version corresponding to the gate table, SP-B2 uses this to determine if it's outdated
  "gates": [
    {
      "spec": "Discipline Priest",
      "keystoneNodeIds": [82585, 110277, 82583], // Voidweaver offensive package (co-occurring)
      "match": "any", // any | all
      "metric": "offensiveIndex", // Primary metric for this fork (for record-keeping, easing review)
      "groupPresent": "offensive",
      "groupAbsent": "standard",
    },
    // Holy Paladin / Resto Druid/Shaman can be added as needed based on N_floor guard results
  ],
}
```

The gate table **only changes when the maintainer re-runs the discovery tool + manually edits it** — baselines are deterministic over time, and patches will not silently re-partition them.

### 3. Collector Grouping (modifying `cellAggregator.ts` + `perMatchRecord.ts`)

- `perMatchRecord.combatToRecords`: For each healer record, if its spec is in the gate table, evaluate the gate (the `match` operator applied to `keystoneNodeIds` and the healer's `talents`) to yield `buildGroup = groupPresent|groupAbsent`; otherwise `buildGroup = "*"`. Attach `buildGroup` to the record.
- `cellAggregator.aggregateCells`: The cell key becomes `spec|bracket|archetype|buildGroup`. Emitted cells vary based on whether the spec is gated, and **every emitted cell lies on some fallback chain** (no useless cells emitted):
  - **Ungated specs** (buildGroup is always `*`): `spec×bracket×archetype×*` and `spec×bracket×*×*` — exactly the same as SP-B1.
  - **Gated specs**: `spec×bracket×archetype×buildGroup` (complete), `spec×bracket×*×buildGroup` (**build parent**: preserve build, merge archetype), `spec×bracket×archetype×*` (**archetype baseline**: preserve archetype, merge build), `spec×bracket×*×*` (bracket parent). Gated specs **also emit** `archetype×*`, ensuring every bracket retains an archetype baseline (see fallback).
- **Fallback preference = preserve build, but retain archetype baseline** (evidence-backed + closeout review correction): The variance study **proved** the build effect for gated specs (Disc offensiveIndex 2.4×), but **did not** prove that they have other massive differences on some rare archetype; thus we prioritize preserving build. However, gates are activated **per bracket**, a spec might fork in one bracket but not in another; if `archetype×*` isn't emitted, SP-B2 would drop directly from `*×buildGroup` (missing) to `*×*` in the non-forked bracket, missing out on an otherwise usable archetype baseline. Thus gated specs also emit `archetype×*`, and the fallback chain hits it after `*×buildGroup` and before `*×*`.
- **N_floor Guard (gate activation condition, evaluated at build time)**: A gate for a gated spec is **activated** only if **its `spec×bracket×*×buildGroup` (build parent) cell for every buildGroup reaches N_floor=30**; otherwise the spec **falls back entirely to archetype-only** (cells only emit `buildGroup="*"`, identical to ungated), and **is not written to the corpus `buildGroups`**. This guarantees that any grouping appearing in the corpus definitely has sample support.

### 4. offensiveIndex Winsorization (modifying `cellAggregator.ts`)

When aggregating each (cell, offensiveIndex) pool, first **cap the values to the pool's p99** (`v = min(v, p99)`), then compute p10/p50/p90. Root cause: offensiveIndex = damage / healing, when a round's healing ≈ 0 (early death/pure damage round), the ratio explodes (study saw 51.16 outlier). Capping protects p90 from long-tail pollution. Only applied to offensiveIndex (the sole unbounded ratio dimension); other dimensions are untouched.

### 5. Corpus Schema Extension

```jsonc
{
  "wowPatchVersion": "...", "builtAt": "...", "sourceFloor": 2300,
  "buildGroups": {                    // Only **activated** (passed N_floor guard) gated specs
    "Discipline Priest": {
      "keystoneNodeIds": [82585,110277,82583], "match": "any",
      "groupPresent": "offensive", "groupAbsent": "standard"
    }
  },
  "cells": [
    { "spec":"Discipline Priest","bracket":"Rated Solo Shuffle","archetype":"hybrid",
      "buildGroup":"offensive", "sampleN":138,"insufficient":false,"metrics":{…},"exemplarCrises":[…] },
    { "spec":"Discipline Priest","bracket":"Rated Solo Shuffle","archetype":"*",
      "buildGroup":"offensive", "sampleN":312, … }  // build parent (cross-archetype), for fallback
    // For ungated specs, all cells have buildGroup always "*"
  ]
}
```

## Runtime Contract (consumed by SP-B2, this spec only defines, does not implement)

- **Group Resolution**: If `g = corpus.buildGroups[userSpec]` exists, perform boolean evaluation on the user build's talents according to `g.match`/`g.keystoneNodeIds` → `groupPresent|groupAbsent`; otherwise `"*"`.
- **Fallback (4-level preserve-build)**: `spec×bracket×archetype×buildGroup` → `spec×bracket×*×buildGroup` (preserve build, merge archetype) → `spec×bracket×archetype×*` (preserve archetype, merge build) → `spec×bracket×*×*` → insufficient ("insufficient sample"). Ungated specs have 2 levels (`archetype×*` → `*×*`, same as SP-B1).
- **fail-open (Hard Constraint)**: If `corpus.wowPatchVersion` does not match the current game build's major version, **or** `keystoneNodeIds` do not exist in the current talent tree data (nodes removed/renumbered), the spec silently falls back to `buildGroup="*"`, never crashing, never blindly evaluating obsolete node IDs.

## Error Handling and Validation Gates (Hard Gates)

- **Gate Table Validation**: `validateCorpus` extension — every `buildGroups` entry has non-empty `keystoneNodeIds`, `match ∈ {any,all}`, `groupPresent≠groupAbsent`; every non-`*` `buildGroup` appearing in the corpus must be within the corresponding spec's `buildGroups` declaration; every non-`*` buildGroup cell (or its buildGroup parent) has `sampleN ≥ N_floor` (post-facto assertion of the guard).
- **Winsorization Assertion**: offensiveIndex distribution p90 ≤ p99 pool ceiling (cannot have out-of-bounds after capping).
- **Schema Compatibility**: For ungated specs, cell `buildGroup` is always `"*"`; when `buildGroups` is an empty object, the corpus degrades to pure SP-B1 shape (backwards compatible).

## Testing

- Discovery Tool: Synthetic rows (planted a fork with "node X present → high metric") → Assert the node is ranked as the top candidate; Synthetic spec with no forks → Assert no candidates yielded.
- Gate Evaluation: `combatToRecords` on synthetic healers with/without keystones → Assert correct buildGroup; `match:"all"` and `"any"` covered separately.
- N_floor Guard: Construct a spec where a split group is <30 → Assert fallback to archetype-only and not written to `buildGroups`; ≥30 → Assert preserved.
- Preserve-build Fallback: Construct corpus missing `archetype×buildGroup` but containing `*×buildGroup` → Assert fallback hits build parent (rather than dropping to build-agnostic).
- Winsorization: Pool contains 51.16 outlier → Assert p90 is capped, unpolluted.
- End-to-end Real Run (Maintainer Gate): Rebuild corpus, assert Disc Priest emits `offensive`/`standard` groups and both meet the floor, Mistweaver is always `*`.

## Debate Record (spec ritual, agy / Gemini 3.1 Pro)

- **Round 1 (Whether to group)**, conversation 9fe91dff: agy OPPOSED my "defer to SP-B2 for feedback". Argument: silent-failure trap (users won't report baseline bugs, just churn); archetype-consistency requires treating build equally. I rebutted: build diversity ≠ metric divergence (unproven). Consensus: run a build→metric variance study **within fixed archetypes** to decide → PARTIAL. Study conclusion: Disc etc. substantively diverge, MW/Evoker do not → selective grouping.
- **Round 2 (Design)**, agy OPPOSED k-means/dynamic gate design on four points: sample collapse, dynamic gate baseline instability, equidistant centroids, forced k=2; steelman = static keystone gates. I conceded the instability/equidistant/forced k; synthesized as "variance study for offline **discovery**, keystone boolean gates for runtime **mechanism**". agy **CONCEDED**: static keystone gates provide necessary determinism and performance; "uncovered diffuse forks" is a healthy constraint; version stamping is safe **if and only if** fail-open degradation is strictly defined (already incorporated into runtime contract hard constraints).

## SP-B2 Preview

Read `corpus.buildGroups` for boolean grouping → Preserve-build fallback to fetch cells → Per-dimension percentiles (build-aware) → exemplar-led prompt → claimChecker → ProComparisonVerified UI; fail-open degradation; CDN versioning (comparing wowPatchVersion + gate table version).
