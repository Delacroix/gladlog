# Subproject 4b: Eval Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the eval methodology from the legacy work repo (baseline loop / A/B loop / judge calibration) into the `@gladlog/eval` package + three workflow documents; corpus and run artifacts reside in a private sister repo (`GLADLOG_EVAL_HOME`).

**Architecture:** Porting tasks follow the **controller extraction + implementer mechanical transformation** pattern (implementers never touch the legacy fork); the corpus builder is the only custom-adapted component (legacy component was tied to legacy parser + web API, rewritten by controller following 4a `collectBenchmarks` parse-chain pattern). Zero logic changes to stats / sampling / rubric semantics. Spec: `docs/specs/2026-07-11-eval-tooling-design.md`.

**Tech Stack:** TypeScript ESM, vitest, fs-extra, `@gladlog/parser` + `parser-compat` + `analysis`, tsx CLI; workflows = `.claude/commands` thin pointers + `docs/commands/` full text.

## Global Constraints

- **Compliance (Hard requirement)**: Implementers (agy/subagent) must not access `/Users/mingjianliu/code/wowarenalogs`; each file to extract is copied only after the controller verifies CLEAN against subproject 0 compliance audit; files without provenance proof are not ported and must be rewritten from methodology (spec debate clause 1).
- **Zero Logic Changes on Porting**: Stats, sampling, and rubric semantics strictly follow the legacy source; only allowed changes: (a) import surface rewrites (`@wowarenalogs/parser` → `@gladlog/parser-compat`, `../../shared/src/…` → `@gladlog/analysis` named exports, `resolveRepoPath` → `resolveEvalHome`); (b) directory constants swapped to eval-home layout; (c) adaptations explicitly called out in this plan. Any other behavioral changes = BLOCKED.
- **Explicit Adaptations (Spec verdict, deviations permitted from legacy source)**: ① Provenance checks no longer tolerate legacy files lacking provenance — missing provenance/dimensions/factAudit = FAIL (no legacy baggage in the new ledger era); ② Validator concurrently verifies 7 integer dimensions 1–5 + factAudit ≥3 items (previously checked in workflow, now codified into validator).
- Score file contract (executor-agnostic, spec "Contract and Future Extensions"): `{ prompt: {<prompt-side 7 dimensions>: int}, response: {<response-side 7 dimensions>: int}, factAudit: [{claim, verdict, evidence}]≥3, provenance: {judgeModel, judgedAt, promptSha256, responseSha256} }`; 7 dimensions = sufficiency / noise / labelBias / inferenceScaffolding / accuracy / outcomeAlignment / focusCalibration.
- Private repo layout: `$GLADLOG_EVAL_HOME/{corpus,runs/<runId>,ab/<abId>,ledger.md}`; `{prompts,responses,manifests,scores}` inside run directory isomorphic to legacy BASE_DIR; `{control,treatment,blind}` inside AB directory isomorphic to legacy AB_DIR (env `BASE_DIR`/`AB_DIR` override mechanisms preserved).
- ESM, TS strict, vitest globals, tests in `packages/eval/test/`; root `npm test --workspaces` all green; TDD, one commit per task.
- Corpus fingerprint format: `<match_count>: <first_8_of_first_matchId>..<first_8_of_last_matchId>`.

## Extraction Manifest (Controller only; → = gladlog target path, all under `packages/eval/`)

```
Legacy packages/tools/src/coverageManifest.ts          → src/quality/coverageManifest.ts
Legacy packages/tools/src/promptQualityCheck.ts        → src/quality/promptQualityCheck.ts
Legacy packages/tools/src/blindAbPool.ts               → src/ab/blindAbPool.ts
Legacy packages/tools/src/abCompareStats.ts            → src/ab/abCompareStats.ts
Legacy packages/tools/src/buildJudgeCalibrationSuite.ts → src/judge/buildCalibrationSuite.ts
Legacy packages/tools/src/checkJudgeCalibration.ts     → src/judge/checkCalibration.ts
Legacy scripts/check-score-provenance.mjs              → src/provenance/checkScoreProvenance.ts (convert to TS)
Legacy scripts/judge-spot-audit.mjs                    → src/provenance/judgeSpotAudit.ts (convert to TS)
Legacy scripts/calibrate-auditor.mjs                   → src/provenance/calibrateAuditor.ts (convert to TS)
Legacy docs/commands/{eval-healer-prompts,improve-healer-prompts,calibrate-judge}.md
                                                       → docs/commands/{eval-baseline,eval-ab,calibrate-judge}.md (controller rewrites paths/command names)
Reference (do not copy; controller reads and paraphrases): buildHealerPromptCorpus.ts (index/response headers/tiering conventions), printMatchPrompts.ts (ParsedCombat type, MATCHID header convention)
Do not port: printMatchPrompts.ts main body (tied to legacy parser+claudeCli+web fetch), resolveRepoPath.ts (superseded by resolveEvalHome), englishSpellName.ts (gladlog already has getEnglishSpellName)
```

---

### Task 1: `packages/eval` Package Scaffold

**Files:** Create `packages/eval/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,test/smoke.test.ts}`

**Interfaces:** Produces package skeleton `@gladlog/eval`: deps `{"@gladlog/parser":"0.0.1","@gladlog/parser-compat":"0.0.1","@gladlog/analysis":"0.0.1","fs-extra":"^11.2.0"}`, devDeps `{"@types/fs-extra":"^11.0.4","@types/node":"^26.1.1","tsx":"^4.19.0","typescript":"^5.5.0","vitest":"^2.0.0"}`; scripts `{"test":"vitest run --passWithNoTests","typecheck":"tsc --noEmit"}`; tsconfig/vitest verbatim copies of corresponding `packages/analysis` files; `src/index.ts` starts with `export {};`.

- [ ] Step 1: Create 5 files; smoke.test.ts asserts `import * as pkg from "../src/index"` does not throw.
- [ ] Step 2: Root `npm install`; `npm test -w @gladlog/eval && npm run typecheck -w @gladlog/eval` PASS.
- [ ] Step 3: Commit `feat(eval): package scaffold`.

---

### Task 2: `resolveEvalHome` + `init` CLI (New Code TDD)

**Files:** Create `src/evalHome.ts`, `scripts/init.ts`; Test `test/evalHome.test.ts`

**Interfaces:** Produces `resolveEvalHome(opts?: { env?: NodeJS.ProcessEnv }): string` (reads `GLADLOG_EVAL_HOME`, defaults to `~/code/gladlog-eval-private`; throws if directory does not exist or lacks `.git`, message includes `gladlog-eval init` instructions); `runDir(home: string, runId: string): string` = `<home>/runs/<runId>`; `abDir(home, abId)` = `<home>/ab/<abId>`. `scripts/init.ts` (tsx): creates `{corpus,runs,ab}`, runs `git init`, writes `ledger.md` header (append-only rules comment + 3 empty tables for baseline/AB/calibration, column names match legacy ledger).

- [ ] Step 1 (Contract):

```ts
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { resolveEvalHome, runDir } from "../src/evalHome";

describe("resolveEvalHome", () => {
  it("env points to valid git directory -> returns that path", () => {
    const d = mkdtempSync(join(tmpdir(), "gl-eval-"));
    execSync("git init -q", { cwd: d });
    expect(resolveEvalHome({ env: { GLADLOG_EVAL_HOME: d } })).toBe(d);
  });
  it("missing directory -> throws with init instructions in message", () => {
    expect(() =>
      resolveEvalHome({ env: { GLADLOG_EVAL_HOME: "/nonexistent/x" } }),
    ).toThrow(/gladlog-eval init/);
  });
  it("exists but not a git repo -> throws", () => {
    const d = mkdtempSync(join(tmpdir(), "gl-eval-"));
    expect(() => resolveEvalHome({ env: { GLADLOG_EVAL_HOME: d } })).toThrow(
      /git/,
    );
  });
  it("runDir path join", () => {
    expect(runDir("/h", "2026-07-11-a")).toBe("/h/runs/2026-07-11-a");
  });
});
```

- [ ] Step 2: Run test FAIL (module does not exist).
- [ ] Step 3: Implement `src/evalHome.ts` (existsSync + `<dir>/.git` check) and `scripts/init.ts`; export evalHome named items from index.ts.
- [ ] Step 4: Tests + typecheck PASS; manual `GLADLOG_EVAL_HOME=$(mktemp -d)/home npx tsx packages/eval/scripts/init.ts` followed by resolveEvalHome passes.
- [ ] Step 5: Commit `feat(eval): eval-home resolver and private-repo init CLI`.

---

### Task 3: coverageManifest Port

**Files:** Create `src/quality/coverageManifest.ts`; Test `test/coverageManifest.test.ts`

**Interfaces:** Produces `buildCoverageManifest(combat: ParsedCombat): CoverageManifest` and `CoverageManifest` type (players/deaths/ccApplied/interrupts/dispels/counts, based on legacy source); `export type ParsedCombat = IArenaMatch | IShuffleRound` (locally declared, types from `@gladlog/parser-compat`).

- [ ] Step 1 (Controller): Verify CLEAN per subproject 0 audit; copy `coverageManifest.ts` into place.
- [ ] Step 2 (Implementer): Import rewrites — `@wowarenalogs/parser` → `@gladlog/parser-compat`; `ccSpellIds, trinketSpellIds` ← `@gladlog/analysis` (spellTags already exported); `specToString` ← `@gladlog/analysis`; `englishSpellName` → `getEnglishSpellName` (`@gladlog/analysis`, signature `(spellId: string, fallback?: string | null): string`, adapt call sites accordingly); `ParsedCombat` changed from importing printMatchPrompts to local type declaration. Zero logic changes.
- [ ] Step 3 (Contract): Use 4a legacy fixture bridge (replicated in `test/helpers/` of this package following `packages/analysis/test/helpers/legacyFixture.ts`, reads `packages/desktop/test/fixtures/report-match.json`):

```ts
it("fixture manifest: all players present, friendly deaths and CC array shapes correct", () => {
  const m = loadLegacyMatchFixture();
  const manifest = buildCoverageManifest(m);
  expect(manifest.players.length).toBeGreaterThanOrEqual(4);
  for (const p of manifest.players) expect(typeof p.spec).toBe("string");
  for (const d of manifest.deaths)
    expect(["friendly", "hostile"]).toContain(d.reaction);
  expect(manifest.counts.trinketCasts).toBeGreaterThanOrEqual(0);
  for (const e of manifest.ccApplied)
    expect(e.spellId ?? e.spellName).toBeTruthy();
});
```

- [ ] Step 4: All green → Commit `feat(eval): coverage manifest port`.

---

### Task 4: Corpus Build CLI (Controller Adaptation & Rewrite)

**Files:** Create `src/corpus/buildCorpus.ts`, `scripts/buildCorpus.ts`; Test `test/buildCorpus.test.ts`

**Interfaces:** Produces `buildCorpus(opts: { logPaths: string[]; outDir: string; ownerFilter?: "healer" }): Promise<{ entries: IndexEntry[]; fingerprint: string }>`; `IndexEntry = { ordinal: number; file: string; matchId: string; spec: string; result: string }` (isomorphic to legacy index.json, all downstream tasks depend on this shape). Written to disk: `<outDir>/prompts/NNN-<matchId first 8>.txt`, `<outDir>/manifests/NNN.json` (buildCoverageManifest output), `<outDir>/index.json`, `<outDir>/fingerprint.txt`.

**Process** (rewritten by controller, parse chain copies 4a `packages/analysis/scripts/collectBenchmarks.ts` pattern with on("match"/"shuffle") + toLegacyMatch/toLegacyShuffle + shuffle round fallback-id pattern):

- [ ] Step 1 (Contract):

```ts
it("desktop fixture -> corpus artifacts complete on disk, fingerprint format correct", async () => {
  const out = mkdtempSync(join(tmpdir(), "gl-corpus-"));
  const { entries, fingerprint } = await buildCorpus({
    logPaths: [fixtureLogPath],
    outDir: out,
    ownerFilter: "healer",
  });
  expect(entries.length).toBeGreaterThan(0);
  expect(fingerprint).toMatch(/^\d+: [^.]{1,8}\.\.[^.]{1,8}$/);
  for (const e of entries) {
    const prompt = readFileSync(join(out, e.file), "utf-8");
    expect(prompt.length).toBeGreaterThan(500);
    expect(
      existsSync(
        join(out, "manifests", `${String(e.ordinal).padStart(3, "0")}.json`),
      ),
    ).toBe(true);
  }
  const idx = JSON.parse(readFileSync(join(out, "index.json"), "utf-8"));
  expect(idx).toEqual(entries);
});
```

fixtureLogPath = Select a real match log containing a healer from `packages/parser` test fixtures (designated by controller; desktop report-match.json is parsed output not log, this test requires raw .txt log fixture — available in parser package fixtures).

- [ ] Step 2 (Implementer): Implement `buildCorpus`: per-file GladLogParser parsing → for each match take unit where `isHealerSpec(u.spec)` and `u.reaction === CombatUnitReaction.Friendly` as owner (ownerFilter="healer"; skip matches without healers) → partition friends/enemies by owner faction → prompt = `buildMatchContext(combat, friends, enemies, { owner })` (`@gladlog/analysis`) → manifest = `buildCoverageManifest(combat)` → numbered disk write + index + fingerprint. `scripts/buildCorpus.ts`: argv `--manifest <log list> --run <runId>`, outDir = `runDir(resolveEvalHome(), runId)`.
- [ ] Step 3: Tests + typecheck PASS → Commit `feat(eval): corpus builder (gladlog parse chain, healer-owner prompts)`.

---

### Task 5: promptQualityCheck Port

**Files:** Create `src/quality/promptQualityCheck.ts`, `scripts/qualityCheck.ts`; Test `test/promptQuality.test.ts`

**Interfaces:** Consumes Task 3 `CoverageManifest`, Task 4 `IndexEntry`. Produces `checkMatch(entry: IndexEntry, promptText: string, manifest: CoverageManifest): MatchQuality` (shape follows legacy source: coverage 5 categories + noise + labelBias + hardFailures) and CLI (`BASE_DIR` env override, defaults to refusing execution with `--run` hint).

- [ ] Step 1 (Controller): CLEAN verification; copy into place.
- [ ] Step 2 (Implementer): Import/path rewrites (rules per Global Constraints); export `checkMatch` and individual check functions as named exports (legacy source only inlined in main — exports are import-surface changes, zero logic changes); retain CLI main.
- [ ] Step 3 (Contract):

```ts
const entry = {
  ordinal: 1,
  matchId: "m1",
  spec: "Restoration Druid",
  result: "loss",
  file: "prompts/001-m1.txt",
};
const manifest = {
  players: [{ name: "Heals-Realm", spec: "Restoration Druid" }],
  deaths: [{ unitName: "Heals-Realm", reaction: "friendly", tRelSec: 42 }],
  ccApplied: [
    { spellId: "408", spellName: "Kidney Shot", spellNameEn: "Kidney Shot" },
  ],
  interrupts: [],
  dispels: [],
  counts: { trinketCasts: 1 },
} as unknown as CoverageManifest;
it("friendly death not in prompt -> hardFailure; present -> 100% coverage", () => {
  const miss = checkMatch(entry, "nothing here\njust lines", manifest);
  expect(miss.hardFailures.length).toBeGreaterThan(0);
  const hit = checkMatch(
    entry,
    "[DEATH] 42s Heals died\nKidney Shot lands\ntrinketed out",
    manifest,
  );
  expect(hit.hardFailures).toEqual([]);
  expect(hit.coverage.friendlyDeaths.present).toBe(1);
  expect(hit.coverage.ccSpells.present).toBe(1);
  expect(hit.coverage.trinketCasts.present).toBe(1);
});
it("duplicate ratio: 1 pair duplicate among lines -> exactDuplicateRatio computed", () => {
  const q = checkMatch(
    entry,
    "[DEATH] Heals\nKidney Shot\nsame\nsame",
    manifest,
  );
  expect(q.noise.exactDuplicateRatio).toBeCloseTo(0.25, 3);
});
it("bias dictionary hit count and line numbers", () => {
  const q = checkMatch(
    entry,
    "[DEATH] Heals ok\nKidney Shot\nthat was catastrophic",
    manifest,
  );
  expect(q.labelBias.totalHits).toBe(1);
  expect(q.labelBias.hits[0].sampleLines).toEqual([3]);
});
```

- [ ] Step 4: All green → Commit `feat(eval): deterministic prompt quality checks port`.

---

### Task 6: A/B Compare Stats and Blind AB Pool Port

**Files:** Create `src/ab/abCompareStats.ts`, `src/ab/blindAbPool.ts`, `scripts/{abStats,blindPool}.ts`; Test `test/abStats.test.ts`

**Interfaces:** Produces named exports `signTestP(deltas: number[]): { p, positives, negatives, ties }`, `bootstrapCI(deltas: number[], rng): { lo, hi }`, `makeRng(seed: number)`, `dimensionScore(score, dim)`, `DIMENSIONS` (7 dimensions as const); `buildBlindPool(abDir: string): Promise<{ items: number; pairs: number }>` (logic unchanged: MATCHID header verified then stripped, Math.random shuffle non-reproducible, mapping.json written to disk). CLIs override via `AB_DIR`, defaulting to `abDir(resolveEvalHome(), <--ab arg>)`.

- [ ] Step 1 (Controller): CLEAN verification; copy both files into place.
- [ ] Step 2 (Implementer): Import/path rewrites + statistical functions exported as named exports (main retained); zero logic changes (especially: blind pool shuffle **must** remain unseeded Math.random — rationale documented in comments).
- [ ] Step 3 (Contract, math golden):

```ts
it("signTestP exact binomial: all positive 3 -> p=0.25; symmetric 1+1- -> p=1; ties excluded", () => {
  expect(signTestP([1, 1, 1]).p).toBeCloseTo(0.25, 10);
  const s = signTestP([1, -1]);
  expect(s.p).toBeCloseTo(1, 10);
  expect(signTestP([1, 0, -1]).ties).toBe(1);
  expect(signTestP([]).p).toBe(1);
});
it("bootstrapCI determinism: same seed and input yields identical value across runs; constant sample CI collapses to that constant", () => {
  const a = bootstrapCI([0.5, 0.5, 0.5], makeRng(1337));
  expect(a.lo).toBe(0.5);
  expect(a.hi).toBe(0.5);
  const b1 = bootstrapCI([1, -1, 2, 0], makeRng(42));
  const b2 = bootstrapCI([1, -1, 2, 0], makeRng(42));
  expect(b1).toEqual(b2);
  expect(b1.lo).toBeLessThanOrEqual(b1.hi);
});
it("dimensionScore: prompt side preferred, falls back to response side, non-numeric returns null", () => {
  expect(dimensionScore({ prompt: { noise: 4 }, response: {} }, "noise")).toBe(
    4,
  );
  expect(
    dimensionScore({ prompt: {}, response: { accuracy: 3 } }, "accuracy"),
  ).toBe(3);
  expect(
    dimensionScore({ prompt: { noise: "x" }, response: {} }, "noise"),
  ).toBeNull();
});
```

Also `buildBlindPool` integration assertion: create 2 ordinals × dual arms (with MATCHID header) in tmp dir → items=4, `blind/items/item-0*/{prompt,response}.txt` exist, response header stripped, mapping.json covers all items with distinct blindIds; create response where MATCHID does not match index → that ordinal is dropped.

- [ ] Step 4: All green → Commit `feat(eval): blind AB pool + paired stats port`.

---

### Task 7: Judge Calibration Port

**Files:** Create `src/judge/buildCalibrationSuite.ts`, `src/judge/checkCalibration.ts`, `scripts/{buildCalibration,checkCalibration}.ts`; Test `test/calibration.test.ts`

**Interfaces:** Consumes Task 4 run directory layout (prompts/responses/index.json). Produces `buildCalibrationSuite(baseDir: string, opts: { sourceCount: number; seed: number }): Promise<CalibrationCase[]>` (7 defect categories: fabricated-claim/duplicated-noise/severity-labels/shuffled-events/removed-deaths/wrong-outcome/trivia-focus + none control; LCG seed reproducible; manifest blind evaluation isolation) and `checkCalibration(baseDir): Promise<{ pass: boolean; failures: … }>` (perturbed must score lower than none homomorphic counterpart on target dimension). **v1 contains no excluded defect categories** (all 7 categories are feature-agnostic — spec exclusion clause is a no-op on the current set, plan records this fact).

- [ ] Step 1 (Controller): CLEAN verification; copy both files into place.
- [ ] Step 2 (Implementer): Import/path rewrites + build/scoring functions exported as named exports; zero logic changes.
- [ ] Step 3 (Contract):

```ts
it("fixed seed: each source produces none control + several perturbation cases; perturbation cases differ from original; manifest fully covers", async () => {
  const base = makeTmpRunWithTwoPairs(); // helper: 2 sets of prompt/response + index.json
  const cases = await buildCalibrationSuite(base, { sourceCount: 2, seed: 42 });
  const byOrdinal = groupBy(cases, (c) => c.sourceOrdinal);
  for (const group of Object.values(byOrdinal)) {
    expect(group.some((c) => c.perturbation === "none")).toBe(true);
    for (const c of group.filter((c) => c.perturbation !== "none")) {
      expect(c.targetDimension).toBeTruthy();
      const perturbed = readCase(base, c.caseId);
      const original = readCase(
        base,
        group.find((g) => g.perturbation === "none")!.caseId,
      );
      expect(perturbed.prompt + perturbed.response).not.toBe(
        original.prompt + original.response,
      );
    }
  }
  const again = await buildCalibrationSuite(makeTmpRunWithTwoPairs(), {
    sourceCount: 2,
    seed: 42,
  });
  expect(again.map((c) => c.perturbation)).toEqual(
    cases.map((c) => c.perturbation),
  ); // seed reproducible
});
it("checkCalibration: perturbation case without score drop on target dimension -> FAIL named", async () => {
  // Handwritten scores/: none all score 4; fabricated-claim case accuracy also 4 (not dropped) -> this case in failures
});
```

- [ ] Step 4: All green → Commit `feat(eval): judge calibration suite port`.

---

### Task 8: Score Provenance Validation Port (mjs → TS, including explicit tightening)

**Files:** Create `src/provenance/checkScoreProvenance.ts`, `src/provenance/judgeSpotAudit.ts`, `src/provenance/calibrateAuditor.ts`, `scripts/checkProvenance.ts`; Test `test/provenance.test.ts`

**Interfaces:** Produces `checkScoreProvenance(runDir: string): { ok: number; fail: number; failures: { file: string; reason: string }[] }` — for each `scores/*.json`: ① provenance block exists and `promptSha256`/`responseSha256` equal measured sha256 of corresponding files in run dir, `judgeModel` non-empty; ② each of the 7 dimensions has an integer 1–5 in at least one of prompt/response; ③ `factAudit` array has ≥3 items, each with `claim`/`verdict`. If any requirement is not met → that file FAILS (**Explicit adaptation: no legacy leniency**). `judgeSpotAudit`/`calibrateAuditor` ported following legacy source (agy invocations externalized to workflow documents; module only handles testcase extraction and injection).

- [ ] Step 1 (Controller): CLEAN verification; copy 3 files into place (.mjs translated verbatim to .ts, with minimal type annotations).
- [ ] Step 2 (Implementer): Path rewrites + explicit tightening (see Interfaces) + named exports.
- [ ] Step 3 (Contract): tmp run directory helper creates prompt/response files:

```ts
it("valid score (real sha256 + 7 dimensions + factAudit×3) -> ok", …);
it("missing provenance -> FAIL reason contains provenance", …);
it("sha256 mismatch (prompt modified 1 byte) -> FAIL", …);
it("missing 1 dimension (delete focusCalibration) -> FAIL reason contains dimension name", …);
it("dimension value 6 (out of range) -> FAIL", …);
it("factAudit has only 2 items -> FAIL", …);
```

(Each test case 5–8 lines, written out fully: construct score JSON, write to disk, assert `checkScoreProvenance(dir).failures`.)

- [ ] Step 4: All green → Commit `feat(eval): score provenance validation (strict, no legacy leniency)`.

---

### Task 9: Three Workflow Documents (Controller Rewrite)

**Files:** Create `docs/commands/{eval-baseline,eval-ab,calibrate-judge}.md`, `.claude/commands/{eval-baseline,eval-ab,calibrate-judge}.md` (thin pointers, format follows legacy fork: frontmatter description + "Follow the workflow in docs/commands/….md exactly")

- [ ] Step 1 (Controller): CLEAN verification of 3 legacy workflow docs; rewrite and write to disk — commands/paths all replaced with plan's CLI (`npx tsx packages/eval/scripts/…`) and eval-home layout; rubric text (7 dimension anchors, factAudit procedure, score JSON contract) preserved verbatim; responder/judge subagent roleplay mechanism and "judge writes scores via file write tools, not via stdout" convention retained; ledger append row procedure points to `$GLADLOG_EVAL_HOME/ledger.md`; verdict discipline (INCONCLUSIVE adopted on deterministic grounds must be logged) preserved.
- [ ] Step 2 (Controller): Self-check 3 documents for no leftover legacy repo paths (`grep -n "wowarenalogs\|local-batch" docs/commands/eval-*.md docs/commands/calibrate-judge.md` zero hits).
- [ ] Step 3: Commit `docs(eval): baseline/AB/judge-calibration agent workflows`.

---

### Task 10: Wrap-up — End-to-End Smoke + Ledger + Dual Review

**Files:** Modify `README.md` (roadmap 4b note), `.superpowers/progress.md`; real private repo init.

- [ ] Step 1 (End-to-end smoke, Controller): `GLADLOG_EVAL_HOME=$(mktemp -d)/home` → init → run `buildCorpus` with parser real log fixture → `qualityCheck` → manually create 1 valid + 1 bad score → `checkProvenance` passes one and rejects one → tmp AB dual arms (copy same corpus to both arms) → `blindPool` → manually fill scores → `abStats` generates all-0 Δ table. Verify exit codes across entire chain one by one.
- [ ] Step 2: Initialize real private repo `~/code/gladlog-eval-private` (git init + ledger headers); no corpus included (user corpus migration is an operational action during use, not in this plan).
- [ ] Step 3: Dual review (agy, fallback chain as usual): T3-8 combined diff review + full branch final review; close all findings.
- [ ] Step 4: Log 4b completed entry in ledger + check off subproject 4 overall in README (both 4a+4b ✅) + Commit `docs: sub-project 4b complete`.

```

## Self-Review Records

- Spec Coverage: Three workflows (T9), five modules (T3-8), private repo + resolver (T2/T10), score contract (Global Constraints + T8), error handling 4 items (T2 resolver rejects run / T8 strict validation / T6 fingerprints written in T4 + comparison rejection documented in workflow doc T9 / T7 calibration regeneration), testing strategy 5 items (T6 golden / T7 injected defects / T5 fixture coverage / T8 bad files / T4 corpus e2e). Fingerprint mismatch comparison rejection: execution point in abStats CLI — merged into T6 Step 2 scope (mapping/fingerprint verification belongs to path surface). ✔
- Placeholder Scan: Ellipsis cases in T8 Step 3 clearly noted with "written out fully" requirement, acting as contract item checklist rather than TBD; no others. ✔
- Type Consistency: IndexEntry 5 fields defined in T4, consumed consistently in T5/T6/T7; CoverageManifest T3 → T5; resolveEvalHome/runDir/abDir T2 → T4/T6. ✔
```
