# A1 — Parser Differential Oracle (LOG Pillar parity gate) Design

Date: 2026-07-13
Status: Pending user review

## Background and Goals

Verifiability roadmap (`docs/verifiability-roadmap.md`) Pillar A first sub-project. **Prove the new gladlog parser parses raw combat logs into correctly structured matches**: run the old fork parser (oracle) and the new parser in parallel on real logs, perform structured diffs on the **fields actually consumed by the application**, set parity as a **rerunnable gate**, and catch silent parsing regressions missed by golden tests. Dual audience: besides CI, it is also a **cross-agent verification/feedback** primitive — headless runnable + machine-readable diff.

**This is not proving parity from scratch** — M4 (`docs/reports/2026-07-10-m4-differential-report.md`, 200 logs) and 2026-07-11 e2e (`docs/reports/2026-07-11-e2e-old-vs-new-regression.md`, 1190 matches) have already exhaustively proven Level-1 parity in a one-off manner (599/600, zero unadjudicated differences), and left a ledger of ~30 adjudications. The value of A1 is to productize that **old-fork scratch-resident, one-off, non-rerunnable** differential into a **resident, adjudication-baselined, gateable oracle in a private repository**, specifically catching **newly introduced** regressions.

Scope: **Level-1 core facts + Level-2 downstream prompts** (user explicitly requested both layers), the two layers are bucketed and isolated so prompt layer regressions are not confused with parser bugs.

## Compliance Topology (Hard Constraints)

The old fork (`~/code/wowarenalogs`, CC BY-NC-ND) can only be used **locally and privately**. Boundary definition: **There is only one single file that touches the old fork code, and it only spits out JSON.**

- **Old-side runner** — Resides in `~/code/wowarenalogs/scratch/parser-diff/runOld.ts` (existing, hardened). It is the only artifact coupled with the old fork; for each log it spits out two blocks of JSON: (a) Level-1 normalized core facts, (b) old `IArenaMatch` (for Level-2). **Written directly by the controller, controller-only.**
- **Private oracle** — Lives in `~/code/gladlog-eval-private/oracle/`, **100% devoid of old fork code**: it spawns the old-side runner to consume its JSON; it imports the **new** side from the public gladlog workspace (`GladLogParser → toLegacyMatch → IArenaMatch`); it performs normalization, diffing, classification, and gating.
- **clean-room:** agy/sub-agents **never read the old fork**. Because the oracle only consumes old-side JSON, sub-agents can safely participate in everything except `runOld.ts`.
- **Public gladlog** only gets: this design document + an optional `npm run verify:parser-oracle` (if the private oracle is present it shells over, if not it gracefully skips, identical to eval oracle conventions). **Does not enter public CI** (GitHub runners have no old fork); this is a local/pre-merge + agent-runnable gate.

## agy Debate Conclusions (Ritual, conversation debate-open, OPPOSE→Adopt)

Original design used **aggregate envelopes** (damage drift median≤4%/p90≤14%) + **boolean structural signature** gating. agy countered: wrong granularity, lets through **false negatives** — (a) localized per-match regressions whose corpus aggregate drift still falls within the median/p90 envelope → missed; (b) new regressions collapse into already whitelisted structural signatures → silently pass.

**Adopt steelman: Instead of loosening tolerances to absorb noise, model the noise.**

- **Per-match reduction shim:** M4 already precisely isolated residuals to `#14 periodic zeroing` (whitelist = Σ old eff=0 line amounts, **deterministically modelable**), etc. When comparing each match, apply these **precisely characterized** old parser quirks as mathematical shims to the **new** side's output (for comparison only). After reduction, the per-match numeric tolerance is **tightened to ~0% (<0.1%)**. Localized regressions can no longer hide within aggregates.
- **Incidence bounding:** The structural signature whitelist asserts **exact per-match occurrence counts**, rather than boolean categorical matches. If a signature's recurrence count exceeds the adjudicated count (= new occurrences), it counts as a new difference → FAIL.

**Defense (partial):** `#19 absorbed deduction self-contradictory across eras` (M4 frozen as "new side semantics take precedence") — M4 noted this as a "uniform 5-13% offset per spell". **If** it can be deterministically modeled per-(spell,era), it will also use shims; **if** the residual genuinely cannot be deterministically reduced, it degrades to a narrow envelope **restricted to the affected spell set** (not a corpus-level full damage envelope) + incidence tracking, strictly confining tolerance to the cause of the adjudication.

## Components (`~/code/gladlog-eval-private/oracle/`)

- `runOld` (inside old fork) → old core facts JSON + old `IArenaMatch` JSON.
- `runNew.ts` → gladlog parse + `toLegacyMatch` → new core facts + new `IArenaMatch`.
- `align.ts` → matches/rounds alignment across both sides: death signature LCS over `(file, index)` (inheriting e2e method).
- `reconcile.ts` → **per-match shim**: applies already characterized quirks like `#14` to the new side (or deducts from the old side), yielding normalized values for ~0% comparison; the shim rules table = part of `baseline.json`, with each referencing its M4 adjudication number.
- `normalize.ts` → Level-1 core facts normalization + enum order canonicalization (eliminating enum-order buckets by construction).
- `diffLevel1.ts` → core facts field-by-field diff (post-shim) → categorize `Divergence`.
- `diffLevel2.ts` → feed both sides' `IArenaMatch` into the **same** gladlog `buildMatchContext` (timeline variant) → prompt line diffs → categorize.
- `classify.ts` → C mechanism: buckets each difference into `identical | enum-canon | numeric{within|over} | structural{known-sig|new}`; structural buckets include **incidence** comparison.
- `baseline.json` → machine-readable adjudication baseline: shim rules + numeric tolerances (~0% post-shim, narrow per-spell envelopes for #19 residuals) + structural signature whitelist (**each containing expected incidence**), each referencing M4/e2e adjudication numbers.
- `gate.mjs` → orchestration; reads `corpus/manifest.txt` (defaults to seeded T1-200, `--full` = all 1190); outputs `report.json` + `summary.md`; exits non-zero if there are any **new unadjudicated differences**.
- `adjudications.md` → ported human-readable ledger (the "why" behind each baseline entry).

## Data Flow

`manifest → per log: {runOld(spawn)→JSON, runNew→JSON} → align matches → reconcile (shim characterized quirks) → Level-1 normalize+diff+classify → Level-2 buildMatchContext (both sides)+line diff+classify → classified differences vs baseline.json (post-shim ~0% numeric + incidence-bounded structural signatures) → report.json + summary.md → exit 0 (fully adjudicated) / 1 (has new differences)`.

## Gate (C + agy Adopted, specifics)

- **Level-1 Core Facts** (per M4): Match segmentation, roster/unit sets, spec, teamId, win/loss, true deaths (excluding unconscious), total damage & healing.
  - *Categorical* fields (roster/spec/team/win/loss/death count): **Exact**; any mismatch → structural signature, must be in whitelist **and incidence not exceeded**, otherwise FAIL.
  - *Numeric* totals: **First reconcile shims** (#14 etc.) → per-match tolerance tightens to `<0.1%`; exceeding this is a FAIL. Healing post-shim should be ≈0 (M4: median 0.00%/p90 0.00%). `#19` residuals: prioritize per-spell shim; unmodelable parts use narrow envelope limited to the affected spell set + incidence.
- **Level-2 Prompt**: Line diff bucketing into `numericDrift` (bound by the same shims/tolerances), `enum-canon` (eliminated by normalization), `structural` (signature whitelist + incidence). New structural signatures (e.g., missing chunks, like e2e R1/R2) or known signature incidence exceeded → FAIL.
- **Structural Signatures** = `{level, category, normalized-locus}` + `expectedIncidence` — locus is stable across matches, not per-match itemized, so valid differences collapse into a single signature, making the baseline small and auditable; incidence prevents "stuffing into existing signatures".

## Error Handling and Determinism

- Old runner crashes / log unparseable → recorded as `oracle-error`, **does not silently skip, does not count as a pass**.
- Alignment failures (unit sets don't match) → surfaces as structural differences (M4 classes #1-5) → adjudicated or FAIL.
- Old fork missing → hard error with clear messaging; public wrapper gracefully skips.
- Determinism pinned: UTC timezone, sampling seed `20260710`, prompt variant `timeline`, datagen/build manifest — reruns are byte-for-byte reproducible.

## Testing (inside private repository, **no old fork included** — synthetic `IArenaMatch` pairs)

- Unit: `normalize`/enum-canon; `reconcile` shims (synthetic data containing #14 type eff=0 lines → both sides equal post-shim); `classify` (synthetic pairs → correct buckets); baseline matcher (known signature + correct incidence passes, new signature/over incidence fails); post-shim <0.1% tolerance.
- **Proofs with teeth:** Inject synthetic **new-side regressions** — (a) delete a death, (b) inflate a total damage to >0.1% post-shim, (c) delete a prompt block — the gate **must FAIL** and classify correctly. Mimicking C1's lying render tests.

## Out of Scope

- **Do not** re-adjudicate the corpus from scratch (M4 has already done this); baseline is ported from existing `adjudications.md`.
- **Do not** fix any prompt regressions discovered by this gate (e.g., R1/R2/R3) — put into backlog, handled identically to e2e.
- **Does not** enter public CI (no old fork); local + agent-runnable + private.
- Downstreams beyond Level-2 (replay/export, etc.) are not in this gate.

## Unresolved Issues

- Whether `#19` can be deterministically modeled per-(spell,era) will be empirically verified using real corpora during implementation: If yes → merge into shims, tolerance remains <0.1% throughout; If no → restrict to narrow per-spell envelopes (record affected spell set + cause). Both paths close false negatives (tolerance is no longer a corpus-level full envelope).
