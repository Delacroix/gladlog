# P1/P2 Distillation (Synchronization + CD Economy Candidates) Design

Date: 2026-08-15 · Status: Pending User Review
User approved: Plan A (four candidate types + corpus calibration gate); constraint budget audit hitches a ride on the same eval A/B.

## Background

The deep dive experiment on four matches (60ab1e8f/76ea5f90/44ea4cf6/8531f0e7) repeatedly verified two cross-match stable finding patterns, and the reviewer (user) adjudicated their criteria case by case:

- **P1 Synchronization**: Burst initiation criteria = **enemy healer locked × burst in hand** (B8 correction: HP line is only an accelerator, not a threshold —— B1 endgame evidence: 93% HP punched through in 4 seconds); in the four matches, this metric perfectly distinguished wins and losses (loss 0 overlap, slow win 6 windows 0 overlap until endgame triple kill, shuffle win fully synced).
- **P2 CD Economy**: Major CD "pressed off cooldown / cast in empty window" (Medallion treadmill, Divine Protection blind cast, AW cast 34s late) hit in all four matches; **threat grading gate** (B6 ruling: in low threat matches, hoarding CDs has an opportunity cost, using off cooldown is correct —— without threat grading there will be reverse false alarms).

Phase 0 is complete: cd ledger cleared (949→121→110, remainder are all scanner false positives, ledger is credible), talent-corrected CD (extractMajorCooldowns talent awareness), cost_norm guardian note (Task D), aura-only fallback-only aggregation —— P2 data surface is clean.

## Goal: Four New Candidate Types (into `candidateFindings.ts` menu)

1. **`missed-sync-window`** (P1 Missed Window): A time interval exists satisfying "enemy healer is hard CC'd ∧ any friendly offensive major CD is ready", and within the window there is no friendly burst initiation (no offensive major CD cast) → one candidate. facts: window time, enemy healer CC skill and duration, list of ready offensive CDs at that time, enemy lowest HP in the window (accelerator info, not used as gate).
2. **`unsynced-burst`** (P1 Unsynced Forced Open): Friendly offensive major CD cast, but within its effective window the enemy healer is completely free (not hard CC'd) → candidate. Complements existing `unconverted-burst` (result: didn't kill) —— this type catches the **reason** (unsynced); both types can coexist for the same burst, eventIds are not mutually exclusive.
3. **`cd-hoarded`** (P2 Hoarded CD): Major CD turned ready but not pressed for ≥H seconds, and during this time a **crisis window** (moment when any friendly HP falls below threshold) appears → candidate. Use talent-corrected ledger for CD ready time (`cdAvailableAt`/`remainingCdSeconds` single source); typical example = AW cast 34s late skipping 6:30 crisis.
4. **`cd-spent-idle`** (P2 Empty Window Blind Cast): Defensive/survival CD cast when in a **no-pressure empty window** (see threat predicates) → candidate. Typical example = Divine Protection 2:03/6:18 blind cast. **Threat grading gate (B6)**: When the whole match enemy threat level is below the threshold, this type is not produced or downgraded (in low threat matches, using off cooldown is a correct strategy, do not alarm).

### Threat Predicates (P2 shared, single source new export)

`threatActiveAt(t)`: Enemy offensive major CD aura is active (existing table) ∨ friendly damage intake rate within window exceeds calibrated threshold; `matchThreatLevel`: Whole match pressure peak grading (low/medium/high). **Definitions in a single export, calibration gate tunes thresholds**; reuse existing pressure predicates from counterfactual/mitigation if possible, if not, register new pairs in the predicate index.

### Criteria Red Lines (all from user rulings, violators redo)

- Synchronization criteria do not set an HP threshold gate (B8); without threat grading, do not produce cd-spent-idle (B6); cd-hoarded suggestions involving cost_norm registered skills must carry a cost note (reuse `costNormPhrase`, Task D pipeline); usable-while-CC checks go through `USABLE_WHILE_CC_SPELL_IDS` shim + CC type awareness pardon (do not reinvent); "Missed Window" wording separates fact from suggestion (decision point card discipline: the window's existence is a fact, "should have bursted" is a suggestion).

## Corpus Calibration Gate (pre-launch, arenacoach batch one convention)

New eval scan (rotScan style, n≥500 matches): occurrence rate/average entries per match for each type; tune thresholds (H seconds, crisis HP, threat grading) until the average candidate volume is on the same magnitude as existing menu types (reference: occurrence rate calibration precedent of 63.6/14.1/15.6 for the three new candidates); bidirectional error awareness: for each threshold, specify what is missed by tightening/relaxing it. Calibration report lands in `$GLADLOG_EVAL_HOME/reports/`, numbers go into the spec appendix before wiring prompts.

## Prompt Wiring

One legend per type (`buildFindingsPrompt.ts`, following existing legend style); missed-sync-window/unsynced-burst legends emphasize "sync is a gate, HP is an accelerator"; cd-hoarded legend carries cost_norm interaction instructions.

## Evaluation (2026-08-15 User Revision: individual evaluation per type; includes constraint budget audit rider)

1. **Feature Flags**: One boolean flag per type (following `dispelFeatureFlags.ts` precedent, new `candidateTypeFlags.ts`), all off by default; detectors always run but menu assembly is filtered by flags —— A/B arms only flip flags, no code changes.
2. **Independent A/B per type**: Baseline vs Baseline + single type, run four groups in sequence. Evaluation set selected by type: pick **matches where the type triggered** from the calibration scan (otherwise diluted by zero-trigger matches). Primary criteria use deterministic metrics (model adoption rate of this type's candidates = finding cites its eventIds, corresponding finding passes gate rule audit rate, filler rate after candidate is adopted), blind judges are secondary (known noise floor SD≈1.3, for reference only). **Winning types default to on, losing types leave the flag off and don't launch** —— present to user case by case for final approval.
3. **Constraint budget audit rider**: Fifth experiment group: Baseline vs "Selective Relaxation" arm (disable 2-3 output space constraints —— specific candidates listed individually in the plan with past rent receipts attached, controller picks those with low mechanism risk, user can veto). Criteria: verified new finding rate vs mechanism error rate (gold standard set calibration caliber), produce Pareto data, ruling power with the user.

## Non-Goals

- Do not do cross-match habit aggregation (single match candidates; habit layer belongs to self-learning track); do not do UI changes (candidates go into existing menu/card rendering); do not touch judge pipeline; enemy healer identification uses existing spec check (isHealerSpec), do not create new archetype classifications.

## Acceptance (Before/After Numbers)

- Calibration report: Occurrence rate of four types + threshold sensitivity;
- A/B three-arm result tables;
- Existing candidates/prompt tests all green, each new type has behavior tests; predicate index registers new predicates (bilingual);
- Every criteria red line has a test pinned to it (no HP gate / threat gate active / costNorm note).
