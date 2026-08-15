# Judge Outcome Halo Experiment (Sub-project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quantify the judge's outcome halo — after redacting the `Result:` label, check if the halo alignment difference for the six non-outcomeAlignment dimensions is significantly non-zero (spec: `docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md`).

**Architecture:** The experiment directory uses the existing A/B structure (`$GLADLOG_EVAL_HOME/ab/2026-08-05-outcome-halo/`, control=original arm O, treatment=redacted arm R), thereby reusing `blindPool.ts`, judge protocol, and score JSON contract **with zero modifications**. The new code only has three parts: redaction transform `redactOutcome.ts`, arm builder `buildHaloArms.ts`, and alignment statistics `haloStats.ts`, all going into the `packages/eval` resident test suite.

**Tech Stack:** TypeScript ESM (`packages/eval`, vitest, fs-extra, tsx CLI wrapper pattern).

## Global Constraints

- Working directory: `/Users/mingjianliu/code/gladlog/.claude/worktrees/eval-engineering`, branch `worktree-eval-engineering`. All edits and commits happen here; **each dispatched subagent must perform a hard `pwd` check before starting work** (historical incident: subagent ran in wrong checkout and committed to user's main branch twice).
- **The worktree guard hook in this session will intercept any Bash command containing literal `eval`** (mistaking directory name for shell eval). Always write `packages/ev[a]l/...` in commands (zsh glob expansion); CLI wrapper internally uses `resolveEvalHome()` (`packages/eval/src/evalHome.ts:5`) to resolve eval home, and the command line **must not** contain the `gladlog-eval-private` path.
- responder / judge subagents are uniformly **sonnet** (Agent tool `model: "sonnet"`; repository convention).
- Iron law of blind evaluation (copied from `docs/commands/eval-ab.md:64`): Before all blind scores are written and haloStats has run, orchestrator does not read `blind/mapping.json`, does not read `blind/items/` content, and does not read `blind/scores/`; one item per judge, never two items in one agent.
- Typecheck only with `npm run typecheck`, never `tsc -b`.
- Single package test command: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`.
- `packages/eval` is ESM (`"type": "module"`): runtime relative imports must include `.js` extension.
- Every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01EXwJzrHdi7KDEmDetnfWxZ`

---

### Task 1: Redaction Transform `redactOutcomeLabels`

**Files:**

- Create: `packages/eval/src/halo/redactOutcome.ts`
- Test: `packages/eval/test/outcomeHalo.test.ts` (new)

**Interfaces:**

- Consumes: None (pure function).
- Produces: `redactOutcomeLabels(promptText: string): RedactedPrompt`, where `RedactedPrompt = { text: string; result: "Win" | "Loss" }`. Rejects on anomaly: throws Error when 0 or multiple `Result:` labels exist, when value is not Win/Loss, or when body contains other explicit outcome wording. Task 2/3 depend on this signature.

**Background (Measured on 2026-08-05):** In the corpus of 300 prompts, each has exactly one line `  Spec: … |  Result: Win|Loss  |  Duration: …` (rendered by `packages/analysis/src/context/buildMatchContext.ts:802`); other wordings such as `victory/we won/defeat` appear 0 times, and `finalAssessment/macroOutcome` paths are not triggered in this corpus. Therefore, transform only handles the header label, throwing errors in all other cases (shared predicate principle: eval side re-parses analysis-rendered text, format drift must turn red rather than silently degrading).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/eval/test/outcomeHalo.test.ts
import { describe, expect, it } from "vitest";

import { redactOutcomeLabels } from "../src/halo/redactOutcome.js";

// Header format anchored to rendering template in buildMatchContext.ts:802 (shared predicate: eval re-parses
// analysis rendered text; if template changes, this must turn red accordingly).
const header = (result: string) =>
  [
    "ARENA MATCH — DECISION ANALYSIS REQUEST",
    "",
    "MATCH SUMMARY",
    `  Spec: Holy Paladin (Healer)  |  Bracket: 3v3  |  Result: ${result}  |  Duration: 2:19  |  Map: Ruins of Lordaeron`,
    "  My team: Holy Paladin, Assassination Rogue, Arms Warrior",
    "  Deaths: Holy Paladin (my team, 1:55)",
    "",
  ].join("\n");

describe("redactOutcomeLabels", () => {
  it("Win -> Unknown, only this token changes, rest byte-for-byte unchanged", () => {
    const input = header("Win") + "SUPPORTING DATA\n  0:12 something\n";
    const out = redactOutcomeLabels(input);
    expect(out.result).toBe("Win");
    expect(out.text).toBe(
      header("Unknown") + "SUPPORTING DATA\n  0:12 something\n",
    );
  });

  it("Loss -> Unknown", () => {
    const out = redactOutcomeLabels(header("Loss"));
    expect(out.result).toBe("Loss");
    expect(out.text).toBe(header("Unknown"));
  });

  it("Zero Result: labels -> throw", () => {
    expect(() => redactOutcomeLabels("no label here\n")).toThrow(/exactly 1/);
  });

  it("Multiple Result: labels -> throw", () => {
    expect(() => redactOutcomeLabels(header("Win") + header("Loss"))).toThrow(
      /exactly 1/,
    );
  });

  it("Result: Unknown (already no outcome, cannot redact) -> throw", () => {
    expect(() => redactOutcomeLabels(header("Unknown"))).toThrow(/unusable/);
  });

  it("Body contains other explicit outcome wording -> throw (minimal intervention failure guard)", () => {
    expect(() =>
      redactOutcomeLabels(header("Win") + "a well-earned victory\n"),
    ).toThrow(/outcome wording/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL, `Cannot find module '../src/halo/redactOutcome.js'` (or equivalent resolution error).

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/eval/src/halo/redactOutcome.ts
/**
 * redactOutcome.ts — Redaction transform for Sub-project B (Judge Outcome Halo Experiment).
 *
 * Minimal intervention: Only rewrites `Result: Win|Loss` in MATCH SUMMARY header line
 * to `Result: Unknown`, leaving all other bytes unchanged. Header line is rendered by buildMatchContext.ts:802;
 * re-parsing rendered text here — format drift, label count != 1, or occurrence of other explicit outcome
 * wording in corpus throws error; fail loudly for human review rather than silent degradation.
 * Design and interpretation rules: docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md
 */

const RESULT_LABEL_RE = /\bResult: (Win|Loss|Unknown|Draw)\b/g;
const OUTCOME_WORDING_RE =
  /\b(victory|victorious|we won|we lost|defeat(?:ed)?|winning team|losing team)\b/i;

export interface RedactedPrompt {
  text: string;
  result: "Win" | "Loss";
}

export function redactOutcomeLabels(promptText: string): RedactedPrompt {
  const labels = [...promptText.matchAll(RESULT_LABEL_RE)];
  if (labels.length !== 1)
    throw new Error(
      `redactOutcomeLabels: expected exactly 1 "Result:" label, found ${labels.length}`,
    );
  const value = labels[0][1];
  if (value !== "Win" && value !== "Loss")
    throw new Error(
      `redactOutcomeLabels: unusable Result value "${value}" (need Win|Loss)`,
    );
  if (OUTCOME_WORDING_RE.test(promptText))
    throw new Error(
      "redactOutcomeLabels: prompt contains explicit outcome wording beyond the Result: label — minimal redaction no longer holds, review the corpus",
    );
  const m = labels[0];
  const text =
    promptText.slice(0, m.index!) +
    "Result: Unknown" +
    promptText.slice(m.index! + m[0].length);
  return { text, result: value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/halo/redactOutcome.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): redactOutcomeLabels transform for outcome halo experiment -- minimal intervention + format drift guard"
```

(Paths with literal eval in git add will be caught by guard — use `git add packages/ev[a]l/src/halo/redactOutcome.ts packages/ev[a]l/test/outcomeHalo.test.ts`, same below, not repeated in subsequent commit steps.)

---

### Task 2: Arm Builder `buildHaloArms` + Response Copying + CLI

**Files:**

- Create: `packages/eval/src/halo/buildHaloArms.ts`
- Create: `packages/eval/scripts/haloBuild.ts`
- Create: `packages/eval/scripts/haloCopyResponses.ts`
- Modify: `packages/eval/test/outcomeHalo.test.ts` (append describe block)

**Interfaces:**

- Consumes: `redactOutcomeLabels` (Task 1); `IndexEntry` (`../corpus/buildCorpus`, shape `{ ordinal, file, matchId, spec, result, ownerName? }`); `makeRng(seed)` (`../ab/abCompareStats.js`, LCG, returns `() => number`).
- Produces:
  - `buildHaloArms(opts: { sourceDir: string; outDir: string; nPerStratum: number; seed: number }): Promise<{ pairs: number; wins: number; losses: number }>` — writes out `outDir/{control,treatment}/{index.json,prompts/,responses/}` and `outDir/sample-meta.json`; treatment's prompt is redacted version.
  - `copyResponsesAcrossArms(haloDir: string): Promise<number>` — copies `control/responses/*.txt` to `treatment/responses/`, returns count, throws if 0.
  - Directory layout conforms to consumption contract of `blindAbPool.loadArm` (`packages/eval/src/ab/blindAbPool.ts:36`): `<arm>/index.json`'s `entry.file` points to relative path under `<arm>/`, responses at `<arm>/responses/<3-digit ordinal>.txt`.

- [ ] **Step 1: Write the failing test (append to outcomeHalo.test.ts)**

```typescript
// Append imports
import fs from "fs-extra";
import os from "os";
import path from "path";

import {
  buildHaloArms,
  copyResponsesAcrossArms,
} from "../src/halo/buildHaloArms.js";

// Append describe block
describe("buildHaloArms", () => {
  async function makeSourceDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-src-"));
    const entries = [
      {
        ordinal: 1,
        file: "prompts/001-aaaa.txt",
        matchId: "aaaa",
        spec: "Holy Paladin",
        result: "Win",
      },
      {
        ordinal: 2,
        file: "prompts/002-bbbb.txt",
        matchId: "bbbb",
        spec: "Discipline Priest",
        result: "Loss",
      },
      {
        ordinal: 3,
        file: "prompts/003-cccc.txt",
        matchId: "cccc",
        spec: "Restoration Druid",
        result: "Win",
      },
      {
        ordinal: 4,
        file: "prompts/004-dddd.txt",
        matchId: "dddd",
        spec: "Mistweaver Monk",
        result: "Loss",
      },
    ];
    await fs.ensureDir(path.join(dir, "prompts"));
    for (const e of entries)
      await fs.writeFile(
        path.join(dir, e.file),
        header(e.result) + `BODY of ${e.matchId}\n`,
        "utf8",
      );
    await fs.writeJson(path.join(dir, "index.json"), entries);
    return dir;
  }

  it("Fixed-seed stratified sampling; treatment differs from control only in Result token; both arm indexes match", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    const res = await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    expect(res).toEqual({ pairs: 2, wins: 1, losses: 1 });

    const controlIndex = await fs.readJson(
      path.join(out, "control", "index.json"),
    );
    const treatmentIndex = await fs.readJson(
      path.join(out, "treatment", "index.json"),
    );
    expect(treatmentIndex).toEqual(controlIndex);
    expect(controlIndex).toHaveLength(2);
    const results = controlIndex
      .map((e: { result: string }) => e.result)
      .sort();
    expect(results).toEqual(["Loss", "Win"]);

    for (const e of controlIndex) {
      const c = await fs.readFile(path.join(out, "control", e.file), "utf8");
      const t = await fs.readFile(path.join(out, "treatment", e.file), "utf8");
      expect(c).toContain(`Result: ${e.result}`);
      expect(t).toBe(c.replace(`Result: ${e.result}`, "Result: Unknown"));
    }

    // Reproducible: same seed builds again selecting identical batch of ordinals
    const out2 = path.join(src, "halo2");
    await buildHaloArms({
      sourceDir: src,
      outDir: out2,
      nPerStratum: 1,
      seed: 42,
    });
    const index2 = await fs.readJson(path.join(out2, "control", "index.json"));
    expect(index2.map((e: { ordinal: number }) => e.ordinal)).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );

    // sample-meta records seed and selected ordinals
    const meta = await fs.readJson(path.join(out, "sample-meta.json"));
    expect(meta.seed).toBe(42);
    expect(meta.ordinals).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );
  });

  it("index result contradicts prompt label -> throw (corpus integrity cross-verification)", async () => {
    const src = await makeSourceDir();
    await fs.writeFile(
      path.join(src, "prompts/001-aaaa.txt"),
      header("Loss") + "BODY\n", // index says Win, file says Loss
      "utf8",
    );
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 1,
        seed: 42,
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("insufficient samples in stratum -> throw", async () => {
    const src = await makeSourceDir();
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 3,
        seed: 42,
      }),
    ).rejects.toThrow(/stratum/);
  });

  it("copyResponsesAcrossArms copies control responses to treatment; empty directory throws", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    await expect(copyResponsesAcrossArms(out)).rejects.toThrow(/no responses/);
    await fs.writeFile(
      path.join(out, "control", "responses", "001.txt"),
      "MATCHID: aaaa\n\nadvice",
      "utf8",
    );
    const n = await copyResponsesAcrossArms(out);
    expect(n).toBe(1);
    expect(
      await fs.readFile(
        path.join(out, "treatment", "responses", "001.txt"),
        "utf8",
      ),
    ).toBe("MATCHID: aaaa\n\nadvice");
  });
});
```

Note: First test case asserting `results` sorted is exactly `["Loss", "Win"]` relies on stratification guarantee of nPerStratum=1, independent of seed — seed only determines selection within stratum, assertion is robust.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL, `Cannot find module '../src/halo/buildHaloArms.js'`.

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/halo/buildHaloArms.ts
/**
 * buildHaloArms.ts — Turns corpus run output by buildCorpus into halo experiment A/B arms:
 * control = original prompt (arm O), treatment = redactOutcomeLabels redacted version (arm R).
 * Directory layout conforms to blindAbPool.loadArm consumption contract; subsequent blindPool/judge/stats
 * all reuse existing A/B infrastructure. Seeded sampling, equal Win/Loss stratification, reproducible.
 */
import fs from "fs-extra";
import path from "path";

import { makeRng } from "../ab/abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";
import { redactOutcomeLabels } from "./redactOutcome.js";

function seededSample<T>(items: T[], n: number, rng: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export async function buildHaloArms(opts: {
  sourceDir: string;
  outDir: string;
  nPerStratum: number;
  seed: number;
}): Promise<{ pairs: number; wins: number; losses: number }> {
  const { sourceDir, outDir, nPerStratum, seed } = opts;
  const entries = (await fs.readJson(
    path.join(sourceDir, "index.json"),
  )) as IndexEntry[];
  const winPool = entries.filter((e) => e.result === "Win");
  const lossPool = entries.filter((e) => e.result === "Loss");
  if (winPool.length < nPerStratum || lossPool.length < nPerStratum)
    throw new Error(
      `buildHaloArms: stratum too small (Win ${winPool.length}, Loss ${lossPool.length}, need ${nPerStratum} each)`,
    );
  const rng = makeRng(seed);
  const selected = [
    ...seededSample(winPool, nPerStratum, rng),
    ...seededSample(lossPool, nPerStratum, rng),
  ].sort((a, b) => a.ordinal - b.ordinal);

  for (const arm of ["control", "treatment"] as const) {
    await fs.ensureDir(path.join(outDir, arm, "prompts"));
    await fs.ensureDir(path.join(outDir, arm, "responses"));
  }

  const rewritten: IndexEntry[] = [];
  for (const entry of selected) {
    const prompt = await fs.readFile(path.join(sourceDir, entry.file), "utf8");
    const redacted = redactOutcomeLabels(prompt);
    if (redacted.result !== entry.result)
      throw new Error(
        `buildHaloArms: ordinal ${entry.ordinal} result mismatch — index says ${entry.result}, prompt says ${redacted.result}`,
      );
    const relFile = path.join("prompts", path.basename(entry.file));
    await fs.writeFile(path.join(outDir, "control", relFile), prompt, "utf8");
    await fs.writeFile(
      path.join(outDir, "treatment", relFile),
      redacted.text,
      "utf8",
    );
    rewritten.push({ ...entry, file: relFile });
  }
  for (const arm of ["control", "treatment"] as const)
    await fs.writeJson(path.join(outDir, arm, "index.json"), rewritten, {
      spaces: 2,
    });
  await fs.writeJson(
    path.join(outDir, "sample-meta.json"),
    {
      seed,
      nPerStratum,
      sourceDir,
      ordinals: rewritten.map((e) => e.ordinal),
    },
    { spaces: 2 },
  );
  const wins = rewritten.filter((e) => e.result === "Win").length;
  return { pairs: rewritten.length, wins, losses: rewritten.length - wins };
}

export async function copyResponsesAcrossArms(
  haloDir: string,
): Promise<number> {
  const from = path.join(haloDir, "control", "responses");
  const to = path.join(haloDir, "treatment", "responses");
  const files = (await fs.readdir(from)).filter((f) => f.endsWith(".txt"));
  if (files.length === 0)
    throw new Error(`copyResponsesAcrossArms: no responses under ${from}`);
  await fs.ensureDir(to);
  for (const f of files)
    await fs.copy(path.join(from, f), path.join(to, f), { overwrite: true });
  return files.length;
}
```

```typescript
// packages/eval/scripts/haloBuild.ts
import { parseArgs } from "node:util";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { buildHaloArms } from "../src/halo/buildHaloArms.js";

const { values } = parseArgs({
  options: {
    "source-run": { type: "string" },
    ab: { type: "string" },
    seed: { type: "string" },
    "n-per-stratum": { type: "string" },
  },
});
if (!values["source-run"] || !values.ab) {
  console.error(
    "--source-run <dir name under runs/> and --ab <dir name under ab/> required",
  );
  process.exit(1);
}
const home = resolveEvalHome();
const result = await buildHaloArms({
  sourceDir: path.join(home, "runs", values["source-run"]),
  outDir: abDir(home, values.ab),
  nPerStratum: Number(values["n-per-stratum"] ?? 50),
  seed: Number(values.seed ?? 20260805),
});
console.log(
  `halo arms: ${result.pairs} pairs (${result.wins} Win + ${result.losses} Loss) under ${abDir(home, values.ab)}`,
);
```

```typescript
// packages/eval/scripts/haloCopyResponses.ts
import { parseArgs } from "node:util";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { copyResponsesAcrossArms } from "../src/halo/buildHaloArms.js";

const { values } = parseArgs({ options: { ab: { type: "string" } } });
if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}
const n = await copyResponsesAcrossArms(abDir(resolveEvalHome(), values.ab));
console.log(`copied ${n} responses control → treatment`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: PASS (10 tests). Then run `npm run typecheck`, Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/halo/buildHaloArms.ts packages/eval/scripts/haloBuild.ts packages/eval/scripts/haloCopyResponses.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): halo experiment arm builder -- fixed-seed stratified sampling + A/B layout reusing blindPool contract"
```

---

### Task 3: Alignment Statistics `haloStats`

**Files:**

- Create: `packages/eval/src/halo/haloStats.ts`
- Create: `packages/eval/scripts/haloStats.ts`
- Modify: `packages/eval/test/outcomeHalo.test.ts` (append describe block)

**Interfaces:**

- Consumes: `DIMENSIONS`, `ScoreFile`, `dimensionScore`, `makeRng`, `bootstrapCI`, `signTestP` (all existing exports, `../ab/abCompareStats.js`); `blind/mapping.json` entries shape `{ blindId, arm: "control"|"treatment", ordinal, matchId }` (`blindAbPool.ts:29`); score file `blind/scores/<blindId>.json` shape `{ prompt: {sufficiency,noise,labelBias,inferenceScaffolding,...}, response: {accuracy,outcomeAlignment,focusCalibration,...} }`.
- Produces: `computeHaloStats(haloDir: string): Promise<HaloReport>`; CLI prints markdown main table + stratified appendix table and writes `<haloDir>/halo-stats.json`.

```typescript
export interface HaloDimStats {
  dimension: string;
  n: number;
  alignedMean: number; // Halo alignment delta: Win takes -(R-O), Loss takes +(R-O)
  alignedSd: number;
  ci95: { lo: number; hi: number };
  signTest: { p: number; positives: number; negatives: number; ties: number };
  winRawMean: number; // Win stratum raw delta = R-O mean (appendix, for direction check)
  winN: number;
  lossRawMean: number;
  lossN: number;
  verdict: "contaminated" | "reverse" | "inconclusive" | "expected-change";
}
export interface HaloReport {
  pairs: number;
  missingScores: number;
  stats: HaloDimStats[];
}
```

Interpretation semantics (spec "Interpretation Rules"): `outcomeAlignment` is always `expected-change` (rubric switch expectation, does not participate in contamination judgment); for other 6 dimensions, `ci95.lo > 0` => `contaminated`, `ci95.hi < 0` => `reverse`, otherwise `inconclusive`.

- [ ] **Step 1: Write the failing test (append)**

```typescript
// Append import
import { computeHaloStats } from "../src/halo/haloStats.js";

describe("computeHaloStats", () => {
  async function makeHaloDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-stats-"));
    const index = [
      {
        ordinal: 1,
        file: "prompts/001-aaaa.txt",
        matchId: "aaaa",
        spec: "s",
        result: "Win",
      },
      {
        ordinal: 2,
        file: "prompts/002-bbbb.txt",
        matchId: "bbbb",
        spec: "s",
        result: "Win",
      },
      {
        ordinal: 3,
        file: "prompts/003-cccc.txt",
        matchId: "cccc",
        spec: "s",
        result: "Loss",
      },
      {
        ordinal: 4,
        file: "prompts/004-dddd.txt",
        matchId: "dddd",
        spec: "s",
        result: "Loss",
      },
    ];
    await fs.ensureDir(path.join(dir, "control"));
    await fs.writeJson(path.join(dir, "control", "index.json"), index);
    await fs.ensureDir(path.join(dir, "blind", "scores"));
    const mapping: unknown[] = [];
    let blindN = 0;
    for (const e of index) {
      for (const arm of ["control", "treatment"] as const) {
        const blindId = `item-${String(++blindN).padStart(2, "0")}`;
        mapping.push({ blindId, arm, ordinal: e.ordinal, matchId: e.matchId });
        // Construction: accuracy has pure halo (Win tag lifts 1 pt, Loss tag depresses 1 pt);
        // noise has no effect; outcomeAlignment uniformly -2 after redaction (rubric switch).
        const isTreatment = arm === "treatment";
        const halo =
          e.result === "Win" ? (isTreatment ? -1 : 0) : isTreatment ? 1 : 0;
        await fs.writeJson(
          path.join(dir, "blind", "scores", `${blindId}.json`),
          {
            matchId: blindId,
            prompt: {
              sufficiency: 4,
              noise: 3,
              labelBias: 4,
              inferenceScaffolding: 4,
            },
            response: {
              accuracy: 3 + halo,
              outcomeAlignment: isTreatment ? 2 : 4,
              focusCalibration: 4,
            },
          },
        );
      }
    }
    await fs.writeJson(path.join(dir, "blind", "mapping.json"), { mapping });
    return dir;
  }

  it("alignment delta: pure halo dimension contaminated, zero effect dimension inconclusive, outcomeAlignment always expected-change", async () => {
    const report = await computeHaloStats(await makeHaloDir());
    expect(report.pairs).toBe(4);
    expect(report.missingScores).toBe(0);
    const by = new Map(report.stats.map((s) => [s.dimension, s]));

    const acc = by.get("accuracy")!;
    // Win raw delta = R-O = -1 (aligned +1); Loss raw delta = +1 (aligned +1) => overall +1
    expect(acc.alignedMean).toBe(1);
    expect(acc.winRawMean).toBe(-1);
    expect(acc.lossRawMean).toBe(1);
    expect(acc.verdict).toBe("contaminated");

    const noise = by.get("noise")!;
    expect(noise.alignedMean).toBe(0);
    expect(noise.verdict).toBe("inconclusive");

    const oa = by.get("outcomeAlignment")!;
    expect(oa.verdict).toBe("expected-change");
    expect(oa.winRawMean).toBe(-2);
    expect(oa.lossRawMean).toBe(-2);
  });

  it("ordinal with missing scores drops entire pair and increments count", async () => {
    const dir = await makeHaloDir();
    await fs.remove(path.join(dir, "blind", "scores", "item-01.json"));
    const report = await computeHaloStats(dir);
    expect(report.missingScores).toBe(1);
    const acc = report.stats.find((s) => s.dimension === "accuracy")!;
    expect(acc.n).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`
Expected: FAIL, `Cannot find module '../src/halo/haloStats.js'`.

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/halo/haloStats.ts
/**
 * haloStats.ts — Halo experiment unblinded statistics. Primary metric is halo alignment delta:
 * raw delta = treatment - control (R-O); Win matches take -delta, Loss matches take +delta before merging
 * (halo expected directions in win/loss matches are opposite, direct merge cancels out — spec "Blind Evaluation Protocol and Statistics").
 * outcomeAlignment is expected change from rubric switch, always judged expected-change,
 * not participating in contamination judgment. Reuses bootstrap/sign test predicates from abCompareStats.
 */
import fs from "fs-extra";
import path from "path";

import {
  DIMENSIONS,
  type ScoreFile,
  bootstrapCI,
  dimensionScore,
  makeRng,
  signTestP,
} from "../ab/abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";

const BOOTSTRAP_SEED = Number(process.env.BOOTSTRAP_SEED ?? 1337);

interface MappingItem {
  blindId: string;
  arm: "control" | "treatment";
  ordinal: number;
  matchId: string;
}

export interface HaloDimStats {
  dimension: string;
  n: number;
  alignedMean: number;
  alignedSd: number;
  ci95: { lo: number; hi: number };
  signTest: { p: number; positives: number; negatives: number; ties: number };
  winRawMean: number;
  winN: number;
  lossRawMean: number;
  lossN: number;
  verdict: "contaminated" | "reverse" | "inconclusive" | "expected-change";
}

export interface HaloReport {
  pairs: number;
  missingScores: number;
  stats: HaloDimStats[];
}

const mean = (xs: number[]) =>
  xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function computeHaloStats(haloDir: string): Promise<HaloReport> {
  const index = (await fs.readJson(
    path.join(haloDir, "control", "index.json"),
  )) as IndexEntry[];
  const resultByOrdinal = new Map(index.map((e) => [e.ordinal, e.result]));

  const { mapping } = (await fs.readJson(
    path.join(haloDir, "blind", "mapping.json"),
  )) as { mapping: MappingItem[] };
  const scores = new Map<string, ScoreFile>(); // key: arm|ordinal
  let missingScores = 0;
  for (const item of mapping) {
    const p = path.join(haloDir, "blind", "scores", `${item.blindId}.json`);
    if (!(await fs.pathExists(p))) {
      missingScores++;
      continue;
    }
    scores.set(
      `${item.arm}|${item.ordinal}`,
      (await fs.readJson(p)) as ScoreFile,
    );
  }

  const ordinals = [...new Set(mapping.map((m) => m.ordinal))].sort(
    (a, b) => a - b,
  );
  const rng = makeRng(BOOTSTRAP_SEED);
  const stats: HaloDimStats[] = [];
  for (const dimension of DIMENSIONS) {
    const aligned: number[] = [];
    const winRaw: number[] = [];
    const lossRaw: number[] = [];
    for (const ordinal of ordinals) {
      const c = scores.get(`control|${ordinal}`);
      const t = scores.get(`treatment|${ordinal}`);
      const result = resultByOrdinal.get(ordinal);
      if (!c || !t || (result !== "Win" && result !== "Loss")) continue;
      const cv = dimensionScore(c, dimension);
      const tv = dimensionScore(t, dimension);
      if (cv === null || tv === null) continue;
      const raw = tv - cv;
      (result === "Win" ? winRaw : lossRaw).push(raw);
      aligned.push(result === "Win" ? -raw : raw);
    }
    if (aligned.length === 0) continue;
    const alignedMean = mean(aligned);
    const alignedSd = Math.sqrt(
      aligned.reduce((s, d) => s + (d - alignedMean) ** 2, 0) /
        Math.max(1, aligned.length - 1),
    );
    const ci95 = bootstrapCI(aligned, rng);
    const verdict: HaloDimStats["verdict"] =
      dimension === "outcomeAlignment"
        ? "expected-change"
        : ci95.lo > 0
          ? "contaminated"
          : ci95.hi < 0
            ? "reverse"
            : "inconclusive";
    stats.push({
      dimension,
      n: aligned.length,
      alignedMean,
      alignedSd,
      ci95,
      signTest: signTestP(aligned),
      winRawMean: mean(winRaw),
      winN: winRaw.length,
      lossRawMean: mean(lossRaw),
      lossN: lossRaw.length,
      verdict,
    });
  }
  return { pairs: ordinals.length, missingScores, stats };
}

export function renderHaloMarkdown(report: HaloReport): string {
  const lines: string[] = [];
  lines.push(
    `Pairs: ${report.pairs}, missing scores: ${report.missingScores}`,
    "",
    "| Dimension | n | aligned Δ | SD | 95% CI | sign p | Win raw Δ (n) | Loss raw Δ (n) | Verdict |",
    "| --------- | - | --------- | -- | ------ | ------ | ------------- | -------------- | ------- |",
  );
  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  for (const s of report.stats)
    lines.push(
      `| ${s.dimension} | ${s.n} | ${f(s.alignedMean)} | ${s.alignedSd.toFixed(2)} | [${s.ci95.lo.toFixed(2)}, ${s.ci95.hi.toFixed(2)}] | ${s.signTest.p.toFixed(3)} | ${f(s.winRawMean)} (${s.winN}) | ${f(s.lossRawMean)} (${s.lossN}) | ${s.verdict} |`,
    );
  lines.push(
    "",
    "Verdicts: contaminated/reverse = halo alignment delta 95% bootstrap CI excludes zero; outcomeAlignment always expected-change (rubric switch expectation, not a contamination signal).",
  );
  return lines.join("\n");
}
```

```typescript
// packages/eval/scripts/haloStats.ts
import { parseArgs } from "node:util";
import fs from "fs-extra";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { computeHaloStats, renderHaloMarkdown } from "../src/halo/haloStats.js";

const { values } = parseArgs({ options: { ab: { type: "string" } } });
if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}
const haloDir = abDir(resolveEvalHome(), values.ab);
const report = await computeHaloStats(haloDir);
const outPath = path.join(haloDir, "halo-stats.json");
await fs.writeJson(outPath, report, { spaces: 2 });
console.log(renderHaloMarkdown(report));
console.log(`\nStats written to ${outPath}`);
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npm test --workspace packages/ev[a]l -- test/outcomeHalo.test.ts`, then `npm run typecheck`
Expected: PASS (12 tests); typecheck all green.

- [ ] **Step 5: Full regression**

Run: `npm test --workspace packages/ev[a]l`
Expected: Original 188 + new 12 = 200 passed | 1 skipped (if baseline changes due to parallel edits, criterion is "no new failures").

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/halo/haloStats.ts packages/eval/scripts/haloStats.ts packages/eval/test/outcomeHalo.test.ts
git commit -m "feat(eval): halo alignment delta stats -- Loss sign flipped and merged + Win/Loss stratified appendix"
```

---

### Task 4: Protocol Document + Spec/Predicate Index Sync

**Files:**

- Create: `docs/commands/outcome-halo.md`
- Modify: `docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md` (two path corrections in materials and deliverables)
- Modify: `docs/predicate-index.md` and `docs/predicate-index.zh-CN.md` (bilingual pair, register Result label predicate)

**Interfaces:** Consumes Task 1–3 CLIs; Produces protocol followed step-by-step during Task 5 execution.

- [ ] **Step 1: Write `docs/commands/outcome-halo.md`**

Content skeleton (execution commands implemented step-by-step, subagent instructions reference existing protocol rather than duplicate):

```markdown
# outcome-halo — Judge Outcome Halo Experiment Execution Protocol

One-off experiment (Design: docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md).
Tools reside in packages/eval; this document is the execution playbook.

## 0. Prerequisites

- Inside worktree `npm run typecheck` and eval package tests all pass green.
- Corpus source: $GLADLOG_EVAL_HOME/runs/2026-07-30-wire-unnecessary-baseline (300 match buildCorpus output, index.json contains result).

## 1. Build Arms

npx tsx packages/eval/scripts/haloBuild.ts --source-run 2026-07-30-wire-unnecessary-baseline --ab 2026-08-05-outcome-halo --seed 20260805 --n-per-stratum 50
Expected output: halo arms: 100 pairs (50 Win + 50 Loss).
Spot check: Pick any ordinal, diff between two arm prompts should only differ by one line Result: token.

## 2. Responder (100 items)

Execute following responsible party protocol in docs/commands/eval-baseline.md Step 2, differing only in paths:
Read control/prompts/NNN-*.txt, write control/responses/<3-digit ordinal>.txt,
First line includes MATCHID: <matchId> header per standard. sonnet subagents, one item per agent, <=8 concurrency.
After completion: npx tsx packages/eval/scripts/haloCopyResponses.ts --ab 2026-08-05-outcome-halo
Expected: copied 100 responses.

## 3. Mix Pool

npx tsx packages/eval/scripts/blindPool.ts --ab 2026-08-05-outcome-halo
Expected: Blind pool: 200 items (100 pairs).

## 4. Blind Evaluation (200 items)

Execute following docs/commands/eval-ab.md Step 5, contracts and anti-deblinding iron laws apply as-is:
One judge per item (sonnet); judge only reads blind/items/item-NN/{prompt.txt,response.txt};
7 dimensions integer 1-5 per docs/commands/eval-baseline.md rubric; score JSON writes to
blind/scores/item-NN.json, matchId fills blindId placeholder.
orchestrator does not read mapping/items/scores prior to Step 5.

## 5. Unblinded Statistics

npx tsx packages/eval/scripts/haloStats.ts --ab 2026-08-05-outcome-halo

## 6. Interpretation and Deliverables

Interpretation rules per spec: Any of 6 non-outcome dimensions contaminated => A adopts 2-pass judge;
All inconclusive => maintain 1-pass. reverse also counts as "label has effect", enters discussion.
Deliverables: ab/2026-08-05-outcome-halo/report.md (main table + stratified appendix + judgeModel/responderModel
+ seed and corpus source), $GLADLOG_EVAL_HOME/ledger.md logging, conclusions written back to spec Row A.
```

(Write out as full document per above skeleton; when executing commands in worktree session, type `packages/ev[a]l`, write standard name in doc.)

- [ ] **Step 2: Spec two path corrections**

`docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md`:

- First item in "Materials and Grouping": change corpus to `runs/2026-07-30-wire-unnecessary-baseline` (buildCorpus artifact of same 300-match corpus, index.json containing result metadata; `prompts-3v3-1800-2026-07-31/` is unindexed flat version of same batch, not programmatically consumable), sampling clarified as Win/Loss 50 each fixed-seed stratified.
- Item 1 in "Deliverables and Acceptance": `runs/<date>-outcome-halo/` → `ab/2026-08-05-outcome-halo/` (A/B directory layout reusing blindPool contract).

- [ ] **Step 3: Predicate index bilingual registration**

Add one line each to `docs/predicate-index.md` + `docs/predicate-index.zh-CN.md` (select "Analysis <-> Eval" section per existing document structure): Result label rendering (`buildMatchContext.ts` MATCH SUMMARY line) <-> `packages/eval/src/halo/redactOutcome.ts` `RESULT_LABEL_RE` re-parsing; consistency guarded by `outcomeHalo.test.ts` header template test + `buildHaloArms` index-vs-prompt cross check. If `packages/eval/test/predicateIndex.test.ts` requires symbol existence registration due to new line, supplement according to existing format in that test to make it pass.

- [ ] **Step 4: Verification**

Run: `npm test --workspace packages/ev[a]l` (predicateIndex consistency test must be green)
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git add docs/commands/outcome-halo.md docs/superpowers/specs/2026-08-05-outcome-halo-experiment-design.md docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "docs: outcome halo experiment execution protocol + spec path corrections + Result label predicate in index (bilingual)"
```

(If predicateIndex.test.ts requires no changes, omit from git add.)

---

### Task 5: Execute Experiment (orchestrator runs directly, non-code task)

**Files:** Artifacts all in `$GLADLOG_EVAL_HOME/ab/2026-08-05-outcome-halo/` (eval home is separate git repo, artifact commit follows that repo's conventions); repo changes only write conclusions back to spec Row A.

**Interfaces:** Consumes all steps in `docs/commands/outcome-halo.md`; Produces halo experiment report metrics (decision input for spec A).

- [ ] **Step 1: Follow outcome-halo.md Step 0–1 to build arms and spot check** (expected `100 pairs (50 Win + 50 Loss)`; diff check one pair, only Result line differs)
- [ ] **Step 2: Dispatch 100 sonnet responder subagents** (<=8 concurrency batches; hard check pwd for each agent; run haloCopyResponses after completion, expected copied 100)
- [ ] **Step 3: Run blindPool** (expected `200 items (100 pairs)`)
- [ ] **Step 4: Dispatch 200 sonnet judge subagents** (one agent per item, <=8 concurrency; orchestrator never reads mapping/items/scores throughout; delete old score files before resending missing items — contamination lesson from calibrate-judge.md:43)
- [ ] **Step 5: Run haloStats, write report.md** (main table + stratified appendix + judgeModel/responderModel + seed; stratification direction check: if Win/Loss raw delta for contaminated dimension have same sign, note discrepancy with halo direction hypothesis, downgrade interpretation to "label has effect but mechanism questionable")
- [ ] **Step 6: ledger.md logging + write conclusions back to spec batch table Row A + commit** (spec edits committed in worktree; eval home artifacts committed per repo convention)

---

## Self-Review Records

- **Spec coverage:** Redaction definition -> Task 1; Sampling/grouping/arm layout -> Task 2; Blind eval protocol -> Task 4 doc reference + Task 5 execution; Alignment delta stats/stratified appendix/interpretation -> Task 3; Deliverables -> Task 5; Resident unit tests -> Task 1–3; Two deviations between spec and measurements (corpus source, ab/ path) -> Task 4 explicit correction, no silent drift.
- **Placeholder scan:** No TBD/TODO; Task 4 doc skeleton provides complete step-by-step commands and expected outputs.
- **Type consistency:** `RedactedPrompt` / `buildHaloArms` return shape / `HaloDimStats.verdict` 4 values consistent across Task 1–3 and tests; `makeRng`/`bootstrapCI`/`signTestP`/`dimensionScore`/`DIMENSIONS`/`ScoreFile` are all existing exports in `abCompareStats.ts` (verified by reading lines 29–123).
