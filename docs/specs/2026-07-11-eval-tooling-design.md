# Subproject 4b: eval tooling design

Date: 2026-07-11. Prerequisite: 4a (in-app AI analysis) completed — `@gladlog/analysis` provides `buildMatchContext` prompt pipeline and benchmark infrastructure.

## Objective

Bring the combat-tested prompt/analysis quality evaluation methodology from the old work repository to gladlog: **baseline evaluation, A/B iteration, and judge calibration** workflows. Code goes into the public repository, corpus and run history into a private sister repository.

**Out of scope**: prompt feature alignment (POSITIONING/HEALER EXPOSURE/CONTESTED and other old late-stage features — these are exactly the iteration materials for the A/B loop once 4b is built), playstyle/archetype/geometry auxiliary tools, CI integration, API-mode responder/judge (see "Contract and Future Extension"), regression gate golden-case system (introduced on demand during the first A/B cycle).

## Key Decisions (brainstorm finalized)

| Decision Point | Finalized Decision                                                                           |
| -------------- | -------------------------------------------------------------------------------------------- |
| Scope          | Layers 1+2+3: Baseline loop + A/B loop + judge calibration                                   |
| Execution Form | Claude Code subagents act as responder/judge (zero API cost), agy cross-family spot audit    |
| Private Side   | Private sister git repo, located by `GLADLOG_EVAL_HOME` (default `~/code/gladlog-eval-private`) |
| Port Strategy  | New package `packages/eval` + minimal extraction by controller (~1.8k lines TS + ~800 lines workflow docs) |

## Architecture

### Public Repo `packages/eval` (depends on parser / parser-compat / analysis)

| Module        | Responsibility                                                                                                                                                | Source                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `corpus/`     | Prompt corpus building: private repo log list → `GladLogParser` → `toLegacyMatch` → `buildMatchContext` (healer owner perspective); corpus fingerprint = match count + first/last matchId | `buildHealerPromptCorpus.ts` (324L) adaptation                                                 |
| `quality/`    | Deterministic metrics: death/kick/CC/trinket/dispel coverage — **tailored to gladlog's existing prompt feature set**                                          | `promptQualityCheck.ts` (287L) tailoring                                                       |
| `ab/`         | Stratified paired sampling, blind evaluation pool directory isolation, mean difference bootstrap CI + sign test                                               | `blindAbPool.ts` (130L) + `abCompareStats.ts` (189L)                                           |
| `judge/`      | 7-dimensional anchored rubric, calibration suite building (defect injection), calibration scoring                                                             | `buildJudgeCalibrationSuite.ts` (348L) + `checkJudgeCalibration.ts` (188L)                     |
| `provenance/` | Score file integrity verification (7-dim integer + 3 factAudit + sha256 envelope, missing any invalidates run), judge-spot-audit (agy cross-family)           | `check-score-provenance.mjs` (86L) + `judge-spot-audit.mjs` (121L) + `calibrate-auditor.mjs` (164L) |

7 dimensions: sufficiency / noise / labelBias / inferenceScaffolding / accuracy / outcomeAlignment / focusCalibration; plus factAudit (tracing 3 numerical claims one by one). Rubric text is ported along with workflow documents.

### Public Repo `.claude/commands/` Three Workflows

`eval-baseline.md` / `eval-ab.md` / `calibrate-judge.md` (source: old `docs/commands/` trio, ~800 lines). Both responder and judge are played by subagents; **judge does not deliver via stdout** — subagents use file writing tools to directly drop score JSON, harness only validates the file (empirical mechanism proven 80/80 valid at 80-blind-eval scale in the old system); retry unit for invalid files = single judge redispatch.

### Private Repo `gladlog-eval-private` (own git)

```
corpus/    # Self-collected log list + built prompt corpus
runs/      # One directory per run: prompts/ responses/ scores/ report.md
ab/        # A/B run (control/treatment arm directory isolation, blind eval pool)
ledger.md  # Append-only ledger (rules follow old system: append-only rows, corpus fingerprint, mean±SD)
```

Ledger **starts fresh**: absolute scores are incomparable to the old ledger (both prompt feature set and responder model have changed), only the methodology is comparable. Old ledger stays in the old fork.

## Data Flow (Baseline Loop)

Private repo log list → Corpus builder CLI (public repo) → prompts dropped into run dir → responder subagent runs batch (responses saved to disk) → blind judge subagent (score JSON saved to disk) → provenance verification (valid only if fully passed) → deterministic metrics aggregation → report.md → append row to ledger.

A/B Loop: Build both arms on the same corpus (control=main, treatment=branch), stratified pairing, arm labels shuffled in blind eval pool, statistics = mean difference CI of target dimensions + sign test; adjudication discipline follows old system (INCONCLUSIVE can be ADOPTed for deterministic grounding/safety reasons, rationale must be recorded in the ledger).

## Compliance and Porting Discipline (debate concession terms, hard)

1. **File-by-file CLEAN validation**: Each file to be extracted is first checked against Subproject 0 compliance audit to confirm self-owned originality before being copied into gladlog by the controller; files that cannot be proven self-owned are **not ported**, rewritten according to methodology notes.
2. Implementers (agy/subagent) must not read any files from the old fork; delivered by the controller.
3. Claude writes the test contract, implementation follows existing fallback chain, green light independently verified (via exit code).
4. Zero-logic-change porting: Statistics/sampling/rubric semantics adhere to the old source, only modifying import surfaces and data shape adaptation; any behavioral divergence is adjudicated by the old source (same rule as 4a).

## Error Handling

- Score file missing dimensions/missing factAudit/missing sha256 → the run is invalidated (no fallback to partially valid).
- Two runs with mismatched corpus fingerprints are rejected for comparison.
- `GLADLOG_EVAL_HOME` not set, directory does not exist, or not a git repo → CLI refuses to run and provides initialization guidance.
- Calibration suite regenerates each time from the current corpus; defect classes referencing tailored-out features are excluded along with their checkers, and will regress together when the feature lands via A/B.

## Contract and Future Extension

Score file contract (JSON schema: 7-dim integers, factAudit array, sha256 provenance envelope, judge model identifier) is executor-agnostic — adding API-mode responder/judge in the future won't require redesign, just omitted in v1.

## Test Strategy

- A/B statistics: golden numeric contract (fixed input → known CI/sign test p-value).
- Calibration suite builder: injected defects can be assertably detected; excluded defect classes do not appear.
- promptQualityCheck: Assert coverage calculation using real 4a fixtures.
- Provenance verifier: bad file cases (missing dimension/missing envelope/bad sha256) rejected class by class.
- Corpus builder: desktop fixture end-to-end, assert fingerprint format and non-empty prompt.

## Debate Log (agy Gemini 3.1 Pro, 2026-07-11)

OPPOSE→PARTIAL (all four points conceded under revised terms). Concessions made to opponent: ① File-by-file CLEAN validation into spec as a hard term; ② Calibration defect classes excluded along with tailored features; ③ Score contract is executor-agnostic. Held ground on: ① Subagent acting mechanism (opponent misunderstood as stdout parsing, rebuffed by file delivery + 80/80 empirical evidence); ② Refused steel-manning rewrite for Batch API (non-zero cost vs zero marginal in subscription, statistical corner-case handling from two months of real-world battle-testing cannot be discarded).
