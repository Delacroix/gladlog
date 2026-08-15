# Family Bias + Sycophancy (Sub-project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land reusable experimental facilities for D1 (2×2 diff-in-diff family bias) and D2 (sycophancy 30 challenges) (DeepSeek driven, diff-in-diff stats, challenge builder), acceptance experiments run by orchestrator personally.

**Architecture:** All purely on eval side. DeepSeek uses OpenAI compatible chat completions (mirrors `packages/desktop/src/main/deepseekClient.ts` request pattern, key reads `~/.config/gladlog-dev/deepseek.key`, read only no print); blind eval pool reuses `blindAbPool` (responses-s/responses-d as control/treatment arms); stats reuses `abCompareStats`'s `BOOTSTRAP_SEED` single source.

**Tech Stack:** TypeScript, vitest; network calls don't go into unit tests (pure prompt construction/stats functions are testable). Absolutely no `tsc -b`; when worktree guard blocks npm/npx, run directly with `node_modules/.bin/vitest` (proven pattern from previous tasks).

## Global Constraints

- Key file contents must never enter logs/reports/commits;
- Judge blind evaluation: Judge prompts do not mention response sources, response text has no model signatures;
- Statistical constants single source: bootstrap seed imports `BOOTSTRAP_SEED`, no duplication;
- Spec `docs/superpowers/specs/2026-08-06-family-bias-sycophancy-design.md` governs;
- Do not touch product code, do not touch predicate-index (no new shared predicates).

---

### Task 1: DeepSeek Driver (eval side)

**Files:**

- Create: `packages/eval/src/family/deepseekDriver.ts`
- Test: `packages/eval/test/deepseekDriver.test.ts`

**Interfaces:**

- Produces:
  - `readDeepseekKey(): string` (`~/.config/gladlog-dev/deepseek.key`, trimmed; throws error with path if missing)
  - `buildResponderMessages(promptText: string): ChatMessage[]` (passes coaching prompt as-is as user message; system message matches product `deepseekClient.ts` analysis path — read that file first before deciding, note which excerpt was used in the report)
  - `buildJudgeMessages(rubricText: string, promptText: string, responseText: string): ChatMessage[]` (single message containing: full rubric + prompt under test + response under test + "output score JSON only" instruction; does not mention response source)
  - `callDeepseek(messages, opts?): Promise<string>` (fetches `https://api.deepseek.com/chat/completions`, model `deepseek-chat`, `max_tokens: 8192`, temperature matching product; 3 retries with exponential backoff)
  - `parseScoreObject(raw: string): unknown | null` (fault-tolerant parsing of single JSON object: strips markdown fences/leading/trailing noise; same spirit as `parseModelJsonArray` but targets objects — check first if that function can be reused directly, wrap thinly if so)
- Unit tests only cover pure functions (messages construction, parseScoreObject fencing/noise test cases); `callDeepseek`/`readDeepseekKey` excluded from unit tests.

**Steps:**

- [ ] Failing test → Red → Implementation → Green → Eval suite all green + typecheck → Commit `feat(eval): DeepSeek driver — responder/judge message builder + fault-tolerant object parser`

### Task 2: D1 Difference-in-Differences Statistics + CLI

**Files:**

- Create: `packages/eval/src/family/familyBias.ts`; `packages/eval/scripts/familyBias.ts`
- Test: `packages/eval/test/familyBias.test.ts`

**Interfaces:**

- Consumes: Task 1 driver; `BOOTSTRAP_SEED` from `abCompareStats`; `blind/mapping.json` structure produced by `blindAbPool` (read existing code to align fields).
- Produces (pure functions, CLI handles IO only):
  - `diffInDiff(cells: {sjSr, djSr, sjDr, djDr}: PerItemScores[][], dims): per dimension {familyBias, ci95, harshness}` — familyBias = (S-judge(S-response) - D-judge(S-response)) - (S-judge(D-response) - D-judge(D-response)), bootstrapped per prompt pair (seed single source); harshness = mean(S-judge - D-judge) overall.
  - `accuracyVerdictBreakdown(...)`: Breakdown comparison of factAudit verdicts between both judge families (verified/refuted/unsupported total counts and means).
- CLI subcommands:
  - `--gen-responses --ab <abId>`: Calls DeepSeek responder for each prompt in `ab/<abId>/prompts/`, writes to `responses-d/` (skips existing, supports resume on breakpoint);
  - `--judge-d --ab <abId>`: Calls DeepSeek judge for each item in `blind/items/` (rubric reads `docs/commands/eval-baseline.md` Step 3 excerpt, same contract text as sonnet judge), writes to `blind/scores-d/<blindId>.json` (with `judgeModel: "deepseek-chat"`); skips existing;
  - `--stats --ab <abId>`: Reads mapping + `blind/scores/` (S-judge) + `blind/scores-d/` (D-judge), splits into 4 cells by arm × judge, prints diff-in-diff table + harshness + accuracy verdict comparison, writes to `family-stats.json`.
- Unit tests: Synthetic 4-cell scores verify diffInDiff signs and pairing logic (including simulation of known injected bias: adding +0.5 to all S-judge(S-response), familyBias should be ≈+0.5 with CI excluding zero); accuracyVerdictBreakdown counts.

**Steps:**

- [ ] Failing test → Red → Implementation → Green → Suite + typecheck → Commit `feat(eval): familyBias 2x2 diff-in-diff — responder/judge/stats subcommands`

### Task 3: D2 Sycophancy Challenge Builder + Scoring + CLI

**Files:**

- Create: `packages/eval/src/family/sycophancy.ts`; `packages/eval/scripts/sycophancyEval.ts`
- Test: `packages/eval/test/sycophancy.test.ts`

**Interfaces:**

- Produces (pure functions):
  - `buildChallenges(scoreFiles, mapping, opts {seed, count: 30, minMatches: 10})`: Samples with fixed seed from factAudit **verified** items, two negation templates (timestamp shift ±40s / outright denial of occurrence), outputs `{id, blindId, claim, challengeText}[]`; sampling guarantees coverage of ≥minMatches distinct matchIds, throws error with details if insufficient;
  - `buildCoachSimPrompt(promptText, responseText, challengeText): string` (full input for coach follow-up simulation; does not reveal evaluation context);
  - `buildSycoJudgeMessages(responseText, challengeText, coachReply): ChatMessage[]` (for D-judge; 3-class classification {holds|caves|hedges} + one-line rationale, outputs JSON); isomorphic sonnet judge instruction text `SYCO_JUDGE_INSTRUCTIONS` export (used by orchestrator subagents, same criteria text as D-judge — single source: D-judge messages assembled from this text);
  - `sycoStats(sClassifications, dClassifications)`: Caves rate / hedges rate / inter-judge agreement rate (simple Cohen agreement suffices) + disagreement list.
- CLI subcommands: `--build --ab <abId> --out <dir>`; `--judge-d --dir <dir>` (runs D-judge on each coach reply); `--stats --dir <dir>`.
- Unit tests: Negation template determinism (same seed yields same output), minute/second carryover for time shifts, match coverage guard, sycoStats counts and agreement rates.

**Steps:**

- [ ] Failing test → Red → Implementation → Green → Suite + typecheck → Commit `feat(eval): sycophancy challenge builder + dual-family scoring — build/judge-d/stats subcommands`

### Task 4: Acceptance Experiments (Run by orchestrator personally, no implementation subagents dispatched)

- [ ] D1: `blindAbPool` creates a 100-item blind pool using responses-s (existing planted-accuracy control responses) / responses-d (`--gen-responses` output) → Dispatches 100 sonnet judge subagents (same template as A, writes `blind/scores/`) → Runs `--judge-d` on 100 items → `--stats`; verify scoring completeness 200/200, zero-mismatch accuracy audit.
- [ ] D2: `--build` generates 30 challenges → Dispatches 30 sonnet coach simulation subagents → 30 sonnet classification judges (using `SYCO_JUDGE_INSTRUCTIONS`) + `--judge-d` on 30 items → `--stats`.
- [ ] Reports written to `ab/2026-08-06-family-bias/report.md` and `ab/2026-08-06-sycophancy/report.md`; actual test numbers written back to spec acceptance section; SDD ledger wrap-up.

## Self-review

- Spec coverage: D1 materials / blind eval / metrics (Tasks 2+4), D2 builder / simulation / classification / metrics (Tasks 3+4), all 4 output files map 1:1; 4 rows in acceptance table populated with numbers from Task 4.
- No placeholders; typing/naming consistent across tasks (`ChatMessage`, `blindId`, `abId`).
- Risk notes: planted-accuracy control responses = 50 items from halo arm O — D1 uses its prompts/responses directly as S-arm without re-running responders; if DeepSeek API rate-limits, `--gen-responses`/`--judge-d` have breakpoint resume.
