# Judge Noise Floor Refactoring (Subproject A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change accuracy scoring to be deterministically calculated from factAudit (zero scoring freedom for judges), introduce K=3 multi-judge median per dimension for A/B blind evaluation, and accept using three criteria (spec: `docs/superpowers/specs/2026-08-05-judge-noise-floor-design.md`).

**Architecture:** Judge behavior remains almost unchanged (already writing line-by-line factAudit), only adding a `severity: "minor"|"fabricated"` field on non-verified entries; `checkScoreProvenance` adds `computeAccuracyFromFactAudit` to check against table and forces the accuracy written by judge to equal the computed value. K replicates fall into `abCompareStats`: collect `<blindId>.json` / `<blindId>.rN.json` copies for each blind item, dimension-wise median aggregation followed by existing paired bootstrap. Acceptance experiments reuse B's Arm O materials + new planting tool to create |Δ|≈0.2 known difference.

**Tech Stack:** TypeScript ESM (`packages/eval`, vitest, existing provenance/ab infrastructure).

## Global Constraints

- Working directory: `/Users/mingjianliu/code/gladlog/.claude/worktrees/eval-engineering`, branch `worktree-eval-engineering`. **Hard `pwd` check before each subagent starts work**.
- **Guard hook intercepts Bash commands containing literal `eval`**: Always write commands as `packages/ev[a]l/...` (zsh glob); no pipes, no `2>&1`; Read/Write/Edit tools are unrestricted.
- Tests: `npm test --workspace packages/ev[a]l` (add `-- test/<file>.test.ts` for single files); typecheck with `npm run typecheck` (never `tsc -b`).
- ESM: Runtime relative imports use `.js` extension.
- Score JSON contract maintains 7-dimension 1–5 integers unchanged (spec Design 1: `accuracy` field is still written, but value must equal lookup table computed value).
- Lookup table rules match `docs/commands/eval-baseline.md` rubric verbatim: 5=zero errors, 4=exactly 1 minor error, 3=exactly 2 minor errors, 2=3 or more minor errors, 1=any fabrication.
- K-replicate rules (spec Design 2): A/B blind eval only; replicates named `<blindId>.r1.json`/`.r2.json`/`.r3.json`; in K-mode, if an item has <2 replicates ⇒ drop entire pair as missing score and count it; exactly 2 replicates ⇒ take average and flag it; legacy single-file `<blindId>.json` pool (K=1) must remain functional.
- Judge/responder subagents must all use sonnet.
- Commit trailers at end:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01EXwJzrHdi7KDEmDetnfWxZ`

---

### Task 1: `computeAccuracyFromFactAudit` + severity validation + accuracy consistency gate

**Files:**

- Modify: `packages/eval/src/provenance/checkScoreProvenance.ts` (add constants and function after `FACT_AUDIT_VERDICTS`; add severity validation in check step (d); add step (f))
- Modify: `packages/eval/test/provenance.test.ts` (add describe block; mechanically adapt existing fixtures)

**Interfaces:**

- Consumes: Existing `FACT_AUDIT_VERDICTS` (`["verified","refuted","unsupported"]`), `checkScoreProvenance(runDir)` validation steps (a)–(e) structure (see lines 66–261 of that file).
- Produces (exact signatures depended upon by subsequent tasks):
  - `export const FACT_AUDIT_SEVERITIES = ["minor", "fabricated"] as const;`
  - `export function computeAccuracyFromFactAudit(entries: { verdict: string; severity?: string }[]): 1 | 2 | 3 | 4 | 5`
  - New `checkScoreProvenance` failure reason literals: `factAudit non-verified entries must carry severity minor/fabricated` and `accuracy <X> does not match factAudit-derived <Y>` (Task 3/6 depend on this semantics, referenced in Task 2 doc).

- [ ] **Step 1: Write the failing test (Add new describe block to the end of test/provenance.test.ts; do not modify existing test cases in this step)**

```typescript
describe("computeAccuracyFromFactAudit (Subproject A Design 1)", () => {
  const v = (verdict: string, severity?: string) => ({
    claim: "c",
    evidence: "e",
    verdict,
    ...(severity ? { severity } : {}),
  });

  it("zero errors → 5; 1/2 minor errors → 4/3; ≥3 minor errors → 2", () => {
    expect(computeAccuracyFromFactAudit([v("verified")])).toBe(5);
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("refuted", "minor")]),
    ).toBe(4);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("unsupported", "minor"),
      ]),
    ).toBe(3);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("unsupported", "minor"),
      ]),
    ).toBe(2);
  });

  it("any fabricated → 1, regardless of minor error count", () => {
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("refuted", "fabricated")]),
    ).toBe(1);
    expect(
      computeAccuracyFromFactAudit([
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("refuted", "minor"),
        v("unsupported", "fabricated"),
      ]),
    ).toBe(1);
  });

  it("unsupported and refuted both count as 1 error (causal-hardening precedent)", () => {
    expect(
      computeAccuracyFromFactAudit([v("verified"), v("unsupported", "minor")]),
    ).toBe(4);
  });
});
```

Add validator behavior test cases (same file; fixture implementation follows tmpdir + JSON persistence pattern of existing cases in this file, fully self-contained):

```typescript
describe("checkScoreProvenance: severity and accuracy consistency (Subproject A)", () => {
  // Self-contained tmpdir run builder: all passing except test points.
  // (imports required: createHash from crypto, fs-extra, os, path — reuse if already at top of file.)
  async function makeRun(
    factAudit: Record<string, unknown>[],
    accuracy: number,
  ): Promise<string> {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "prov-a-"));
    await fs.ensureDir(path.join(runDir, "prompts"));
    await fs.ensureDir(path.join(runDir, "responses"));
    await fs.ensureDir(path.join(runDir, "scores"));
    const promptText = "PROMPT body";
    const responseText = "RESPONSE body";
    await fs.writeFile(
      path.join(runDir, "prompts", "001-mid.txt"),
      promptText,
      "utf8",
    );
    await fs.writeFile(
      path.join(runDir, "responses", "001.txt"),
      responseText,
      "utf8",
    );
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    await fs.writeJson(path.join(runDir, "scores", "001.json"), {
      ordinal: 1,
      matchId: "mid",
      spec: "Holy Paladin",
      result: "Loss",
      factAudit,
      prompt: {
        sufficiency: 4,
        noise: 3,
        labelBias: 4,
        inferenceScaffolding: 4,
      },
      response: { accuracy, outcomeAlignment: 4, focusCalibration: 4 },
      provenance: {
        judgeModel: "test-judge",
        judgedAt: "2026-08-05T00:00:00Z",
        promptSha256: sha(promptText),
        responseSha256: sha(responseText),
      },
    });
    return runDir;
  }
  const fa = (verdict: string, severity?: string) => ({
    claim: "claim text",
    evidence: "evidence line",
    verdict,
    ...(severity ? { severity } : {}),
  });

  it("non-verified entries missing severity ⇒ FAIL (reason contains severity)", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("refuted")],
      4,
    );
    const res = checkScoreProvenance(runDir);
    expect(res.fail).toBe(1);
    expect(res.failures[0].reason).toMatch(/severity/);
  });

  it("accuracy mismatch with computed value ⇒ FAIL (reason contains factAudit-derived)", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("verified")],
      4, // computed value should be 5
    );
    const res = checkScoreProvenance(runDir);
    expect(res.fail).toBe(1);
    expect(res.failures[0].reason).toMatch(/factAudit-derived/);
  });

  it("accuracy equals computed value and severity present ⇒ OK", async () => {
    const runDir = await makeRun(
      [fa("verified"), fa("verified"), fa("refuted", "minor")],
      4,
    );
    const res = checkScoreProvenance(runDir);
    expect(res.ok).toBe(1);
    expect(res.fail).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/provenance.test.ts`
Expected: FAIL, `computeAccuracyFromFactAudit` not exported.

- [ ] **Step 3: Write implementation (checkScoreProvenance.ts)**

Add after `FACT_AUDIT_MIN/MAX`:

```typescript
export const FACT_AUDIT_SEVERITIES = ["minor", "fabricated"] as const;

/**
 * Subproject A Design 1: accuracy is deterministically computed from factAudit; judge has zero scoring freedom.
 * Lookup table matches docs/commands/eval-baseline.md rubric verbatim:
 * Any fabricated → 1; otherwise based on non-verified count: 0→5, 1→4, 2→3, ≥3→2.
 * unsupported and refuted both count as errors (existing semantics of causal-hardening Rule 5).
 */
export function computeAccuracyFromFactAudit(
  entries: { verdict: string; severity?: string }[],
): 1 | 2 | 3 | 4 | 5 {
  const errors = entries.filter((e) => e.verdict !== "verified");
  if (errors.some((e) => e.severity === "fabricated")) return 1;
  if (errors.length === 0) return 5;
  if (errors.length === 1) return 4;
  if (errors.length === 2) return 3;
  return 2;
}
```

In verification step (d) factAudit entry loop, append after verdict enum check:

```typescript
if (
  e.verdict !== "verified" &&
  (typeof e.severity !== "string" ||
    !(FACT_AUDIT_SEVERITIES as readonly string[]).includes(e.severity))
) {
  failReason =
    "factAudit non-verified entries must carry severity minor/fabricated";
  hasFailed = true;
  break;
}
```

Add new step (f) after verification step (e) (placed after (e) passes, before final tally):

```typescript
// (f) accuracy must equal the factAudit-derived value (design A-1: the
// judge has zero scoring freedom on this dimension; see
// docs/superpowers/specs/2026-08-05-judge-noise-floor-design.md)
if (!hasFailed) {
  const response = score.response as Record<string, unknown> | undefined;
  const factAudit = score.factAudit as {
    verdict: string;
    severity?: string;
  }[];
  const derived = computeAccuracyFromFactAudit(factAudit);
  if (response?.accuracy !== derived) {
    failReason = `accuracy ${String(response?.accuracy)} does not match factAudit-derived ${derived}`;
    hasFailed = true;
  }
}
```

- [ ] **Step 4: Mechanically adapt existing fixtures in this file**

Rule (review each existing test case and execute mechanically): For any fixture whose factAudit contains entries with verdict ≠ "verified", add `severity: "minor"` to that entry; for fixtures on the "should pass (OK)" path, change `response.accuracy` to the calculated value of that fixture's factAudit (using the mental calculation rules above); for fixtures that "should FAIL at an earlier step", leave accuracy unchanged (earlier steps fail first, (f) will not execute).

- [ ] **Step 5: Run full eval suite to verify no regressions**

Run: `npm test --workspace packages/ev[a]l`, then `npm run typecheck`
Expected: All green (if fixtures in other tests like auditors/judgeVariance also pass through `checkScoreProvenance` and fail, adapt those fixtures using the same rule from Step 4; tests unrelated to the validator must not be touched).

- [ ] **Step 6: Commit**

```bash
git add packages/eval/src/provenance/checkScoreProvenance.ts packages/eval/test/provenance.test.ts
git commit -m "feat(eval): deterministic accuracy — factAudit severity field + computeAccuracyFromFactAudit lookup + provenance consistency gate"
```

(git add paths are written as `packages/ev[a]l/...` in commands, same below without repeating; if Step 5 modified other test files, add them together.)

---

### Task 2: Rewrite rubric and score contract (eval-baseline.md) + document pinning tests

**Files:**

- Modify: `docs/commands/eval-baseline.md` (accuracy section lines 183–193; score contract lines 205–242)
- Modify: `packages/eval/test/factAuditBounds.test.ts` (append lookup table line pinning assertions)

**Interfaces:**

- Consumes: Task 1 `computeAccuracyFromFactAudit` semantics and two failure reason literals.
- Produces: Rubric text read by judges (Task 6 acceptance judges follow this); pinning assertions (doc lookup lines and code constants must not drift independently).

- [ ] **Step 1: Rewrite accuracy section**

Replace the entire entry starting from `- **accuracy** —` with (lookup numbers verbatim unchanged, new output specifications added):

```markdown
- **accuracy** — Does the response reference only events present in the prompt? **Scores for this dimension are computed deterministically by the system from factAudit (via computeAccuracyFromFactAudit in checkScoreProvenance); judges do not score freely**: The value you write to `response.accuracy` must equal the value computed from your own factAudit according to the table below; any mismatch invalidates the entire scorecard.
  - 5: Zero errors.
  - 4: Exactly 1 minor error.
  - 3: Exactly 2 minor errors.
  - 2: 3 or more minor errors.
  - 1: Any **fabrication** (spells/windows/deaths), or giving advice to dead/absent players — regardless of minor error count, 1 upon detection.
  - Error = entries in factAudit where verdict is `refuted` or `unsupported`; each non-verified entry **must** carry a `severity` field: `minor` (minor error = timestamp off by a few seconds, values off by one tier, secondary trigger misidentified) or `fabricated` (fabrication).
  - (Old anchors allowed judge discretion beyond the lookup table; 2026-07-20 empirical tests showed three judges giving 3/3/4 and 3/4/4 for the exact same error. Deterministic calculation eliminates this final degree of freedom — 2026-08-05 Subproject A.)
  - F193 clause: Discussion of trade-offs anchored on `[CONTESTED]` lines maintaining exploratory wording (≤Medium confidence, no assertion) **does not count** as fabrication or unsupported — the line itself is prompt fact; only when the response hardens it into a conclusion ("you should have CC'd then") or invents scenarios unanchored to prompt is it marked as an error.
```

- [ ] **Step 2: Rewrite factAudit example and explanation in score contract**

In contract JSON, add a non-verified example entry in factAudit:

```json
{
  "claim": "Verbatim quote of the load-bearing claim from the response.",
  "verdict": "refuted",
  "severity": "minor",
  "evidence": "Exact prompt line (with timestamp) refuting it."
}
```

In contract explanation paragraph (line 242 area), append: Non-`verified` `verdict` entries must carry `severity` ∈ `minor` / `fabricated`; `response.accuracy` must equal the value computed by `computeAccuracyFromFactAudit` (enforced by checkProvenance starting 2026-08-05; historical runs are validated with the validator from their time without retroactive re-checks).

- [ ] **Step 3: Append pinning assertions to factAuditBounds.test.ts**

Append inside existing describe (this test already has a variable reading full eval-baseline.md, reuse the same read):

```typescript
it("accuracy lookup table lines pinned to computeAccuracyFromFactAudit semantics (Subproject A)", () => {
  // Doc side: five lookup lines must be present verbatim
  for (const line of [
    "5: Zero errors.",
    "4: Exactly 1 minor error.",
    "3: Exactly 2 minor errors.",
    "2: 3 or more minor errors.",
  ])
    expect(doc).toContain(line);
  expect(doc).toContain("Any **fabrication**");
  expect(doc).toContain("computeAccuracyFromFactAudit");
  expect(doc).toContain("severity");
  // Code side: same semantics (equality assertion, CLAUDE.md markdown↔code fallback path)
  const m = (n: number) =>
    computeAccuracyFromFactAudit(
      Array.from({ length: n }, () => ({
        verdict: "refuted",
        severity: "minor",
      })),
    );
  expect([m(0), m(1), m(2), m(3), m(4)]).toEqual([5, 4, 3, 2, 2]);
  expect(
    computeAccuracyFromFactAudit([
      { verdict: "refuted", severity: "fabricated" },
    ]),
  ).toBe(1);
});
```

(Add `computeAccuracyFromFactAudit` to import line, source `../src/provenance/checkScoreProvenance`.)

- [ ] **Step 4: Run tests**

Run: `npm test --workspace packages/ev[a]l -- test/factAuditBounds.test.ts`, then full `npm test --workspace packages/ev[a]l`
Expected: PASS; no new failures across the entire suite.

- [ ] **Step 5: Commit**

```bash
git add docs/commands/eval-baseline.md packages/eval/test/factAuditBounds.test.ts
git commit -m "docs(eval): update accuracy rubric with deterministic output specification (severity field + system compute declaration) + lookup pinning test"
```

---

### Task 3: K-Replicate Aggregation (abCompareStats)

**Files:**

- Modify: `packages/eval/src/ab/abCompareStats.ts`
- Modify: `packages/eval/test/abStats.test.ts` (append describe block)

**Interfaces:**

- Consumes: Task 1 `computeAccuracyFromFactAudit`; existing `ScoreFile`, `dimensionScore`, `DIMENSIONS`, main() mapping/scores loading structure (lines 125–247 of that file).
- Produces (Task 6 depends on):
  - `export function medianOf(values: number[]): number` (sort and take median; average of middle two for even count)
  - `export function collectReplicateFiles(scoresDir: string, blindId: string): string[]` (`<id>.json` + `<id>.rN.json`, N ascending, only existing returned)
  - `export function aggregateReplicates(reps: ScoreFile[]): { score: ScoreFile; accuracyMismatches: number } | null` (0 replicates → null; dimension-wise median; if any replicate's accuracy does not match its factAudit derived value, participate in aggregation with derived value and increment mismatch count)
  - main() behavior: Under K-mode (any item in pool has `.rN` replicate), items with <2 replicates dropped as full pairs due to missing scores and counted; exactly 2 replicates aggregated but counted into `twoReplicateItems` warning; `comparison-stats.json` adds field `replicateSummary: { kMode: boolean; itemsDropped: number; twoReplicateItems: number; accuracyMismatches: number }`.

- [ ] **Step 1: Write the failing test (append to test/abStats.test.ts)**

```typescript
import {
  aggregateReplicates,
  collectReplicateFiles,
  medianOf,
} from "../src/ab/abCompareStats";
import fs from "fs-extra";
import os from "os";
import path from "path";

describe("K-replicate aggregation (Subproject A Design 2)", () => {
  const rep = (accuracy: number, extra?: Record<string, number>) => ({
    factAudit:
      accuracy === 5
        ? [{ claim: "c", evidence: "e", verdict: "verified" }]
        : [
            { claim: "c", evidence: "e", verdict: "verified" },
            ...Array.from({ length: 5 - accuracy }, () => ({
              claim: "c",
              evidence: "e",
              verdict: "refuted",
              severity: "minor",
            })),
          ],
    prompt: {
      sufficiency: 4,
      noise: 3,
      labelBias: 4,
      inferenceScaffolding: 4,
      ...extra,
    },
    response: { accuracy, outcomeAlignment: 4, focusCalibration: 4 },
  });

  it("medianOf: odd takes median, even takes average", () => {
    expect(medianOf([3, 5, 4])).toBe(4);
    expect(medianOf([3, 4])).toBe(3.5);
    expect(medianOf([2])).toBe(2);
  });

  it("collectReplicateFiles: collects legacy single-files and .rN replicates in ascending order of N", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "krep-"));
    await fs.writeJson(path.join(dir, "item-01.r2.json"), {});
    await fs.writeJson(path.join(dir, "item-01.r1.json"), {});
    await fs.writeJson(path.join(dir, "item-02.json"), {});
    expect(
      collectReplicateFiles(dir, "item-01").map((p) => path.basename(p)),
    ).toEqual(["item-01.r1.json", "item-01.r2.json"]);
    expect(
      collectReplicateFiles(dir, "item-02").map((p) => path.basename(p)),
    ).toEqual(["item-02.json"]);
    expect(collectReplicateFiles(dir, "item-03")).toEqual([]);
  });

  it("aggregateReplicates: dimension-wise median; accuracy derived from factAudit and counts mismatches", () => {
    const bad = rep(4);
    (bad.response as { accuracy: number }).accuracy = 5; // misreported: factAudit only supports 4
    const out = aggregateReplicates([
      rep(3) as never,
      rep(5) as never,
      bad as never,
    ]);
    expect(out).not.toBeNull();
    // accuracy participating values = [3, 5, 4 (derived)] → median 4
    expect(out!.score.response!.accuracy).toBe(4);
    expect(out!.accuracyMismatches).toBe(1);
    // Dimensions unaffected by factAudit take standard median
    expect(out!.score.prompt!.noise).toBe(3);
  });

  it("aggregateReplicates: 0 replicates → null; replicates without factAudit use recorded values (legacy score files)", () => {
    expect(aggregateReplicates([])).toBeNull();
    const legacy = { prompt: { noise: 2 }, response: { accuracy: 5 } };
    const out = aggregateReplicates([legacy as never]);
    expect(out!.score.response!.accuracy).toBe(5);
    expect(out!.accuracyMismatches).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`
Expected: FAIL, three symbols not exported.

- [ ] **Step 3: Write implementation (abCompareStats.ts)**

Extend `ScoreFile` interface with an optional field (non-breaking for existing consumers):

```typescript
export interface ScoreFile {
  prompt: Record<string, number | string>;
  response: Record<string, number | string>;
  factAudit?: { verdict: string; severity?: string }[];
}
```

Add new (place after `dimensionScore`; add `computeAccuracyFromFactAudit` to imports from `../provenance/checkScoreProvenance.js`, with existing fs/path already present):

```typescript
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `<id>.json` (legacy K=1) + `<id>.rN.json` (K replicates), N in ascending order. */
export function collectReplicateFiles(
  scoresDir: string,
  blindId: string,
): string[] {
  const out: string[] = [];
  const legacy = path.join(scoresDir, `${blindId}.json`);
  if (fs.existsSync(legacy)) out.push(legacy);
  const re = new RegExp(
    `^${blindId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.r(\\d+)\\.json$`,
  );
  const reps = (fs.existsSync(scoresDir) ? fs.readdirSync(scoresDir) : [])
    .map((f) => ({ f, m: f.match(re) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => path.join(scoresDir, x.f));
  return [...out, ...reps];
}

/** Dimension-wise median aggregation. accuracy: if entry has factAudit, uses value derived via computeAccuracyFromFactAudit
 * (mismatches with recorded value increment count) — defensive: even if provenance checks were bypassed, stats side remains deterministic. */
export function aggregateReplicates(
  reps: ScoreFile[],
): { score: ScoreFile; accuracyMismatches: number } | null {
  if (reps.length === 0) return null;
  let accuracyMismatches = 0;
  const promptOut: Record<string, number> = {};
  const responseOut: Record<string, number> = {};
  const PROMPT_DIMS = new Set([
    "sufficiency",
    "noise",
    "labelBias",
    "inferenceScaffolding",
  ]);
  for (const dimension of DIMENSIONS) {
    const values: number[] = [];
    for (const r of reps) {
      let v = dimensionScore(r, dimension);
      if (dimension === "accuracy" && Array.isArray(r.factAudit)) {
        const derived = computeAccuracyFromFactAudit(r.factAudit);
        if (v !== null && v !== derived) accuracyMismatches++;
        v = derived;
      }
      if (v !== null) values.push(v);
    }
    if (values.length === 0) continue;
    (PROMPT_DIMS.has(dimension) ? promptOut : responseOut)[dimension] =
      medianOf(values);
  }
  return {
    score: { prompt: promptOut, response: responseOut },
    accuracyMismatches,
  };
}
```

Rewrite main() loading loop (replace single-file loop in existing lines 157–172; missing score/leak/placeholder checks performed per **replicate** before aggregation):

```typescript
const scoresByArm = new Map<string, ScoreFile>(); // key: arm|ordinal (after aggregation)
let missing = 0;
let itemsDropped = 0;
let twoReplicateItems = 0;
let accuracyMismatchTotal = 0;
const nonconforming: string[] = [];
const leaks: string[] = [];
const scoresDir = path.join(blindDir, "scores");
const kMode = mapping.some((item) =>
  collectReplicateFiles(scoresDir, item.blindId).some((p) =>
    /\.r\d+\.json$/.test(p),
  ),
);
for (const item of mapping) {
  const files = collectReplicateFiles(scoresDir, item.blindId);
  if (files.length === 0) {
    missing++;
    continue;
  }
  if (kMode && files.length < 2) {
    itemsDropped++;
    continue;
  }
  if (kMode && files.length === 2) twoReplicateItems++;
  const reps: ScoreFile[] = [];
  for (const p of files) {
    const score = (await fs.readJson(p)) as ScoreFile & { matchId?: unknown };
    if (score.matchId === item.matchId) {
      leaks.push(path.basename(p));
    } else if (score.matchId !== item.blindId) {
      nonconforming.push(
        `${path.basename(p)}=${JSON.stringify(score.matchId)}`,
      );
    }
    reps.push(score);
  }
  const agg = aggregateReplicates(reps);
  if (!agg) {
    missing++;
    continue;
  }
  accuracyMismatchTotal += agg.accuracyMismatches;
  scoresByArm.set(`${item.arm}|${item.ordinal}`, agg.score);
}
```

(Retain existing three console.warn blocks for missing/leaks/nonconforming and append afterwards:)

```typescript
if (kMode)
  console.warn(
    `K-replicate mode: ${itemsDropped} item(s) dropped (<2 replicates), ${twoReplicateItems} item(s) aggregated from only 2, ${accuracyMismatchTotal} recorded-accuracy mismatch(es) overridden by factAudit-derived values.`,
  );
```

`comparison-stats.json` output object adds:

```typescript
    replicateSummary: {
      kMode,
      itemsDropped,
      twoReplicateItems,
      accuracyMismatches: accuracyMismatchTotal,
    },
```

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`, `npm run typecheck`, `npm test --workspace packages/ev[a]l`
Expected: New test PASS; existing abStats tests (legacy single-file path) do not regress; no new failures across suite.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/ab/abCompareStats.ts packages/eval/test/abStats.test.ts
git commit -m "feat(eval): K-replicate aggregation for A/B blind eval — dimension-wise median + accuracy derived from factAudit + replicateSummary"
```

---

### Task 4: Minor Error Planting Tool (Known |Δ|≈0.2 Difference Construction for Acceptance)

**Files:**

- Create: `packages/eval/src/ab/plantTimestampError.ts`
- Create: `packages/eval/scripts/plantAccuracyAb.ts`
- Modify: `packages/eval/test/abStats.test.ts` (append describe block)

**Interfaces:**

- Consumes: `makeRng` (`./abCompareStats.js`); Arm O directory layout from B (`control/{index.json,prompts/,responses/}`, `IndexEntry` from `../corpus/buildCorpus`).
- Produces:
  - `export function plantTimestampError(responseText: string): { text: string; planted: string }` —— Shift seconds of the **first** `M:SS` timestamp in response by +3 (with minute rollover; `M:SS` defined as `/\b(\d+):([0-5]\d)\b/`), returning modified text and `planted` description (`"0:42 -> 0:45"`); throw if no timestamp.
  - `export async function buildPlantedAb(opts: { sourceArmDir: string; outDir: string; nPairs: number; plantFraction: number; seed: number }): Promise<{ pairs: number; planted: number }>` —— Take existing (prompt, response) pairs from sourceArmDir, sample nPairs with fixed seed; copy control arm verbatim; treatment arm uses same prompts, with responses from `round(nPairs*plantFraction)` items (selected with fixed seed) passed through plantTimestampError, remainder verbatim; both arms have identical index.json; write `plant-meta.json` (seed, list of planted ordinals, planted description per item).
  - CLI: `npx tsx packages/eval/scripts/plantAccuracyAb.ts --source-ab 2026-08-05-outcome-halo --arm control --ab <newAbId> --n-pairs 50 --plant-fraction 0.2 --seed 20260806` (internally uses `resolveEvalHome()`/`abDir()`, no eval-home paths in command line).

- [ ] **Step 1: Write the failing test (append to test/abStats.test.ts)**

```typescript
import {
  plantTimestampError,
  buildPlantedAb,
} from "../src/ab/plantTimestampError";

describe("plantTimestampError (Subproject A acceptance tool)", () => {
  it("first M:SS seconds +3, all other bytes unchanged", () => {
    const out = plantTimestampError(
      "at 0:42 the kick landed; later 1:10 again",
    );
    expect(out.text).toBe("at 0:45 the kick landed; later 1:10 again");
    expect(out.planted).toBe("0:42 -> 0:45");
  });

  it("seconds rollover: 0:58 -> 1:01", () => {
    const out = plantTimestampError("spike at 0:58 was decisive");
    expect(out.text).toBe("spike at 1:01 was decisive");
  });

  it("no timestamps → throw", () => {
    expect(() => plantTimestampError("no timestamps here")).toThrow(
      /timestamp/,
    );
  });

  it("buildPlantedAb: both arms index match; exactly plantFraction proportion planted and recorded in plant-meta", async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), "plant-src-"));
    const entries = [1, 2, 3, 4].map((n) => ({
      ordinal: n,
      file: `prompts/00${n}-m${n}.txt`,
      matchId: `m${n}`,
      spec: "s",
      result: n % 2 ? "Win" : "Loss",
    }));
    await fs.ensureDir(path.join(src, "prompts"));
    await fs.ensureDir(path.join(src, "responses"));
    for (const e of entries) {
      await fs.writeFile(path.join(src, e.file), `PROMPT ${e.matchId}`, "utf8");
      await fs.writeFile(
        path.join(src, "responses", `00${e.ordinal}.txt`),
        `MATCHID: ${e.matchId}\n\nthe spike at 0:42 decided it`,
        "utf8",
      );
    }
    await fs.writeJson(path.join(src, "index.json"), entries);

    const out = path.join(src, "planted");
    const res = await buildPlantedAb({
      sourceArmDir: src,
      outDir: out,
      nPairs: 4,
      plantFraction: 0.5,
      seed: 7,
    });
    expect(res).toEqual({ pairs: 4, planted: 2 });
    const meta = await fs.readJson(path.join(out, "plant-meta.json"));
    expect(meta.plantedOrdinals).toHaveLength(2);
    const controlIdx = await fs.readJson(
      path.join(out, "control", "index.json"),
    );
    const treatIdx = await fs.readJson(
      path.join(out, "treatment", "index.json"),
    );
    expect(treatIdx).toEqual(controlIdx);
    // Planted treatment responses contain 0:45; unplanted match control verbatim
    for (const e of controlIdx) {
      const o = String(e.ordinal).padStart(3, "0");
      const c = await fs.readFile(
        path.join(out, "control", "responses", `${o}.txt`),
        "utf8",
      );
      const t = await fs.readFile(
        path.join(out, "treatment", "responses", `${o}.txt`),
        "utf8",
      );
      if (meta.plantedOrdinals.includes(e.ordinal)) expect(t).toContain("0:45");
      else expect(t).toBe(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`
Expected: FAIL, module does not exist.

- [ ] **Step 3: Write implementation**

```typescript
// packages/eval/src/ab/plantTimestampError.ts
/**
 * plantTimestampError.ts — Known difference construction for Subproject A Acceptance (c):
 * Shifts the first M:SS timestamp in the response by +3 seconds, creating a rubric-defined
 * "minor error" (timestamp off by a few seconds), expecting accuracy to drop by exactly one tier.
 * buildPlantedAb uses it to plant errors proportionally, constructing A/B pairs with known |Δ|.
 */
import fs from "fs-extra";
import path from "path";

import { makeRng } from "./abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";

const TIMESTAMP_RE = /\b(\d+):([0-5]\d)\b/;

export function plantTimestampError(responseText: string): {
  text: string;
  planted: string;
} {
  const m = responseText.match(TIMESTAMP_RE);
  if (!m || m.index === undefined)
    throw new Error("plantTimestampError: no M:SS timestamp in response");
  const minutes = Number(m[1]);
  const seconds = Number(m[2]) + 3;
  const shifted = `${minutes + Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const text =
    responseText.slice(0, m.index) +
    shifted +
    responseText.slice(m.index + m[0].length);
  return { text, planted: `${m[0]} -> ${shifted}` };
}

export async function buildPlantedAb(opts: {
  sourceArmDir: string;
  outDir: string;
  nPairs: number;
  plantFraction: number;
  seed: number;
}): Promise<{ pairs: number; planted: number }> {
  const { sourceArmDir, outDir, nPairs, plantFraction, seed } = opts;
  const entries = (await fs.readJson(
    path.join(sourceArmDir, "index.json"),
  )) as IndexEntry[];
  if (entries.length < nPairs)
    throw new Error(
      `buildPlantedAb: source has ${entries.length} entries, need ${nPairs}`,
    );
  const rng = makeRng(seed);
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const selected = shuffled
    .slice(0, nPairs)
    .sort((a, b) => a.ordinal - b.ordinal);
  const plantCount = Math.round(nPairs * plantFraction);
  const plantSet = new Set(selected.slice(0, plantCount).map((e) => e.ordinal)); // selected was shuffled with fixed seed; taking the first plantCount items is a deterministic selection
  const plantedMeta: { ordinal: number; planted: string }[] = [];

  for (const arm of ["control", "treatment"] as const) {
    await fs.ensureDir(path.join(outDir, arm, "prompts"));
    await fs.ensureDir(path.join(outDir, arm, "responses"));
  }
  const rewritten: IndexEntry[] = [];
  for (const entry of selected) {
    const ordinal = String(entry.ordinal).padStart(3, "0");
    const prompt = await fs.readFile(
      path.join(sourceArmDir, entry.file),
      "utf8",
    );
    const response = await fs.readFile(
      path.join(sourceArmDir, "responses", `${ordinal}.txt`),
      "utf8",
    );
    const relFile = path.join("prompts", path.basename(entry.file));
    for (const arm of ["control", "treatment"] as const)
      await fs.writeFile(path.join(outDir, arm, relFile), prompt, "utf8");
    await fs.writeFile(
      path.join(outDir, "control", "responses", `${ordinal}.txt`),
      response,
      "utf8",
    );
    let treatResponse = response;
    if (plantSet.has(entry.ordinal)) {
      const p = plantTimestampError(response);
      treatResponse = p.text;
      plantedMeta.push({ ordinal: entry.ordinal, planted: p.planted });
    }
    await fs.writeFile(
      path.join(outDir, "treatment", "responses", `${ordinal}.txt`),
      treatResponse,
      "utf8",
    );
    rewritten.push({ ...entry, file: relFile });
  }
  for (const arm of ["control", "treatment"] as const)
    await fs.writeJson(path.join(outDir, arm, "index.json"), rewritten, {
      spaces: 2,
    });
  await fs.writeJson(
    path.join(outDir, "plant-meta.json"),
    {
      seed,
      nPairs,
      plantFraction,
      plantedOrdinals: plantedMeta.map((p) => p.ordinal).sort((a, b) => a - b),
      planted: plantedMeta,
    },
    { spaces: 2 },
  );
  return { pairs: rewritten.length, planted: plantedMeta.length };
}
```

```typescript
// packages/eval/scripts/plantAccuracyAb.ts
import { parseArgs } from "node:util";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { buildPlantedAb } from "../src/ab/plantTimestampError.js";

const { values } = parseArgs({
  options: {
    "source-ab": { type: "string" },
    arm: { type: "string" },
    ab: { type: "string" },
    "n-pairs": { type: "string" },
    "plant-fraction": { type: "string" },
    seed: { type: "string" },
  },
});
if (!values["source-ab"] || !values.ab) {
  console.error("--source-ab and --ab required");
  process.exit(1);
}
const home = resolveEvalHome();
const res = await buildPlantedAb({
  sourceArmDir: path.join(
    abDir(home, values["source-ab"]),
    values.arm ?? "control",
  ),
  outDir: abDir(home, values.ab),
  nPairs: Number(values["n-pairs"] ?? 50),
  plantFraction: Number(values["plant-fraction"] ?? 0.2),
  seed: Number(values.seed ?? 20260806),
});
console.log(
  `planted AB: ${res.pairs} pairs, ${res.planted} planted, under ${abDir(home, values.ab)}`,
);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test --workspace packages/ev[a]l -- test/abStats.test.ts`, `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eval/src/ab/plantTimestampError.ts packages/eval/scripts/plantAccuracyAb.ts packages/eval/test/abStats.test.ts
git commit -m "feat(eval): timestamp minor error planting tool — known |Δ| A/B construction for acceptance (fixed seed, plant-meta accounting)"
```

---

### Task 5: Protocol Documentation (eval-ab.md K-replicates) + Bilingual Predicate Index Registration

**Files:**

- Modify: `docs/commands/eval-ab.md` (Phase 2 Step 5 blind eval section)
- Modify: `docs/predicate-index.md` + `docs/predicate-index.zh-CN.md` (Add one row each to Gate side)
- Modify: `packages/eval/test/predicateIndex.test.ts` (Register one row)

**Interfaces:** Consumes Task 1 `computeAccuracyFromFactAudit` export; Produces Task 6 protocol text to run.

- [ ] **Step 1: Append K-replicate section to eval-ab.md**

Insert after Step 5 judge template, before `Unblind after all scores are written`:

```markdown
**K=3 Multi-Judge (Default for A/B decisions starting 2026-08-05 Subproject A):**
Dispatch 3 independent judges for each ITEMID (the 3 judges for the same item are unaware of each other; the one-item-one-agent Iron Law remains unchanged), writing scores to `blind/scores/ITEMID.r1.json` / `.r2.json` / `.r3.json` respectively (all other contracts same as above).
abStats will compute dimension-wise medians for each item before pairing; in K-mode, items with <2 replicates are dropped as full missing score pairs, and items with exactly 2 replicates take the average with a note in replicateSummary. Legacy single-file `ITEMID.json` (K=1) remains compatible for quick smoke testing. accuracy always aggregates using the derived value from each judge's factAudit via computeAccuracyFromFactAudit (rubric in eval-baseline.md).
```

- [ ] **Step 2: Add one row to bilingual predicate index (End of Gate side table, after `RESULT_LABEL_RE` row)**

English version:

```markdown
| The accuracy score implied by a factAudit (error-count lookup) | `packages/eval/src/provenance/checkScoreProvenance.ts` → `computeAccuracyFromFactAudit` | `checkScoreProvenance` (consistency gate (f)); `abCompareStats.ts` → `aggregateReplicates` (K-replicate aggregation uses the derived value) | The rubric table in `docs/commands/eval-baseline.md` is the human-facing side; `factAuditBounds.test.ts` pins the doc's lookup lines to this function's semantics (markdown↔code equality-test fallback, same pattern as `FACT_AUDIT_MIN/MAX`). |
```

Chinese version:

```markdown
| 一份 factAudit 蕴含的 accuracy 分(错数查表) | `packages/eval/src/provenance/checkScoreProvenance.ts` → `computeAccuracyFromFactAudit` | `checkScoreProvenance`(一致性门 (f));`abCompareStats.ts` → `aggregateReplicates`(K 重聚合按计算值参与) | rubric 查表在 `docs/commands/eval-baseline.md` 是人读侧;`factAuditBounds.test.ts` 把文档查表行钉在本函数语义上(markdown↔代码等值断言备选路,与 `FACT_AUDIT_MIN/MAX` 同款范式)。 |
```

- [ ] **Step 3: Register in predicateIndex.test.ts (following the existing `{file, symbol, mod}` format used by `makeRng`; `checkScoreProvenance` module is already imported)**

```typescript
  {
    file: `${E}/provenance/checkScoreProvenance.ts`,
    symbol: "computeAccuracyFromFactAudit",
    mod: checkScoreProvenance,
  },
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace packages/ev[a]l -- test/predicateIndex.test.ts`, then full `npm test --workspace packages/ev[a]l` and `npm run typecheck`
Expected: All green.

- [ ] **Step 5: Commit**

```bash
git add docs/commands/eval-ab.md docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "docs(eval): add K=3 multi-judge to A/B protocol + bilingual predicate registration for computeAccuracyFromFactAudit"
```

---

### Task 6: Acceptance Experiments (Run Personally by Orchestrator, Non-Code Task)

**Files:** Artifacts in `$GLADLOG_EVAL_HOME/ab/2026-08-06-planted-accuracy/` and `runs/` (calibration); repo modifications limited to backfilling spec acceptance table + ledger (in eval home repo).

**Interfaces:** Consumes all of Tasks 1–5; Produces three criteria metrics from Spec Design 3.

- [ ] **Step 1: Construct known difference pairs**

```
npx tsx packages/eval/scripts/plantAccuracyAb.ts --source-ab 2026-08-05-outcome-halo --arm control --ab 2026-08-06-planted-accuracy --n-pairs 50 --plant-fraction 0.2 --seed 20260806
```

Expected: `planted AB: 50 pairs, 10 planted`. Spot check one planted response diff = single timestamp.

- [ ] **Step 2: Blind pool + K=3 blind eval (300 judges)**

`npx tsx packages/eval/scripts/blindPool.ts --ab 2026-08-06-planted-accuracy` (expected 100 items / 50 pairs). Then dispatch **3 sonnet judges** per item (new rubric: factAudit with severity, accuracy written as computed value; scores written to `ITEMID.r1/.r2/.r3.json`; one item per agent, three judges for the same item unaware of each other; orchestrator does not read mapping/items/scores). Rewrite judge instruction file following B's judge-instructions pattern into SDD workspace, noting new severity contract and replicate filename assigned by dispatch.

- [ ] **Step 3: Unblind stats + Criterion (c) (Known difference detection)**

For `AB_DIR`, run `npx tsx packages/eval/scripts/abStats.ts --ab 2026-08-06-planted-accuracy` (if wrapper only accepts AB_DIR env, add `--ab` argument parsing matching `blindPool.ts` existing pattern, committing together).
Passing line: accuracy dimension verdict = `regressed` with 95% CI excluding zero; point estimate in same direction and order of magnitude as theoretical value −0.2; `replicateSummary.itemsDropped` recorded accurately.

- [ ] **Step 4: Criterion (a) (SD before & after numbers)**

Calculate from control arm 50 items × 3 replicates (directly reusing scores from Criterion (c), zero additional cost): compute sample SD across 3 replicates per item → pooled single-judge SD; derive K=3 median paired SD (×0.67×√2).
Passing line: K=3 median paired SD ≤ 0.5 (hard line); report single-judge SD alongside 0.94 baseline. Write calculation as small temporary script in SDD workspace to execute (reads score files and calculates SD without committing to repo — consumes one-off directory layout, not a reusable criterion).

- [ ] **Step 5: Criterion (b) (Calibration does not regress)**

Rerun full calibration pipeline per `docs/commands/calibrate-judge.md` (new rubric, K=1): `buildCalibration` → blind eval all cases (judges use new severity contract) → `checkCalibration`.
Passing line: 7/7 dimension PASS (≥0.8) without regression; pay special attention to fabricated-claim class (planted fabrication ⇒ judge records fabricated ⇒ computed value 1 ⇒ detection should be cleaner).

- [ ] **Step 6: Report + Backfill + Wrap-up**

- `ab/2026-08-06-planted-accuracy/report.md`: Three-criteria table (current / passing line / measured) + process logs;
- spec `2026-08-05-judge-noise-floor-design.md` acceptance table backfilled with measured numbers and dates;
- eval home `ledger.md` accounting (if git commit blocked by worktree guard, note left for main checkout);
- If any of the three criteria cannot be produced: honestly report "unable to produce" and halt there; do not wrap up claiming "should be more stable".

---

## Self-Review Log

- **Spec coverage:** Design 1 (severity + lookup table + provenance (f)) → Task 1/2; Design 2 (K=3 naming/aggregation/missing replicate rules/legacy compatibility) → Task 3/5; Design 3 Three criteria → Task 4 (tools) + Task 6 (execution); Predicate index registration → Task 5; "Explicitly Out of Scope" items untouched by tasks (calibration remains K=1, baseline unchanged — rubric changes apply to baseline judges but K remains 1, conforming to spec).
- **Placeholder scan:** Task 1 Step 1 second describe's three test cases shown as comment skeletons but with explicit expansion rules and reference to same-pattern tests in file — retained to control plan size, implementer must write in full; all other task code is complete.
- **Type consistency:** `computeAccuracyFromFactAudit` signature matches across Task 1/3/5; `ScoreFile.factAudit?` extension matches `aggregateReplicates` consumption; `medianOf`/`collectReplicateFiles`/`aggregateReplicates`/`plantTimestampError`/`buildPlantedAb` names and parameters verified against definitions and calls without drift.
- **Sequential dependencies:** Task 3 imports Task 1 functions; Task 5 predicate registration imports same function; Task 6 depends on all — tasks must be executed sequentially.
