# Hindsight Bias Predicate (Subproject C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade findings timing constraints from prose rules to a deterministic predicate `hindsightViolations`, consumed by both the product gate (auditFindings 5th layer drop) and eval scanning, and add it to the predicate index.

**Architecture:** Single predicate file `hindsightLint.ts` (same paradigm as causalLint: single source of truth export in analysis, multiple consumer imports); comparison is based on the **rendered fact** `facts.t` (fmtFactNum decimal seconds string), not `CandidateEvent.t` (whole-round candidates have `t` as 0, which poisons min; `facts.t === undefined` is the criteria for whole-round, fully consistent with menu rendering `t=whole-round`).

**Tech Stack:** TypeScript, vitest. Test commands: `npm test --prefix packages/eval` (eval side) and `npx vitest run <file> --root packages/analysis` (analysis side). Never use `tsc -b`; use `npm run typecheck` for type checking.

## Global Constraints

- Gate predicate as specification: `HINDSIGHT_CLUSTER_SLACK_S` and `hindsightViolations` are exported from a single source and imported by consumers; do not duplicate constants.
- Comparisons anchor on rendered values: always use `Number(facts.t)`; references with `facts.t === undefined` do not participate in anchors nor exempt the entire item.
- Bilingual pairs: add synonymous rows to both languages in predicate-index.
- Follow rules 1-3 verbatim from the spec `docs/superpowers/specs/2026-08-06-hindsight-predicate-design.md`.
- Violation reason strings must be in Chinese and contain three specific values: `T`, `e.t`, and `e.type`.
- Do not change findings output schema, do not change PROMPT_VERSION, do not modify deepDive.

---

### Task 1: hindsightLint Predicate

**Files:**

- Create: `packages/analysis/src/analysis/hindsightLint.ts`
- Test: `packages/analysis/src/analysis/hindsightLint.test.ts`

**Interfaces:**

- Produces: `export const HINDSIGHT_CLUSTER_SLACK_S = 30;` and `export function hindsightViolations(eventIds: string[], byId: Map<string, CandidateEvent>): string[]` (empty array = pass). Note that the input parameter is `eventIds`, not the entire finding — the audit layer is invoked after grounding, so IDs are guaranteed to be resolvable.

- [ ] **Step 1: Write failing tests** (using minimal CandidateEvent builder `mk(id, type, t?)`, when `t === undefined`, facts does not contain t):

```ts
import { describe, expect, it } from "vitest";
import {
  HINDSIGHT_CLUSTER_SLACK_S,
  hindsightViolations,
} from "./hindsightLint";
import type { CandidateEvent } from "./types";

const mk = (id: string, type: string, t?: number): CandidateEvent => ({
  id,
  type,
  t: t ?? 0,
  unitNames: [],
  facts: t === undefined ? {} : { t: String(t) },
});
const byId = (...es: CandidateEvent[]) => new Map(es.map((e) => [e.id, e]));

describe("hindsightViolations", () => {
  it("cross-type and outside cluster window => violation, reason contains three specific values", () => {
    const m = byId(
      mk("a", "kick-eaten", 130),
      mk("b", "death-unused-defensive", 161),
    );
    const v = hindsightViolations(["a", "b"], m);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("130");
    expect(v[0]).toContain("161");
    expect(v[0]).toContain("death-unused-defensive");
  });
  it("exactly 30s boundary => passes (only > is violation)", () => {
    const m = byId(mk("a", "kick-eaten", 100), mk("b", "cc-locked", 130));
    expect(hindsightViolations(["a", "b"], m)).toEqual([]);
  });
  it("same type across different periods => passes (pattern exemption)", () => {
    const m = byId(mk("a", "kick-eaten", 10), mk("b", "kick-eaten", 200));
    expect(hindsightViolations(["a", "b"], m)).toEqual([]);
  });
  it("whole-round references do not participate in anchors nor exempt remaining references", () => {
    const m = byId(
      mk("w", "cd-waste"),
      mk("a", "kick-eaten", 130),
      mk("b", "cc-locked", 200),
    );
    expect(hindsightViolations(["w", "a", "b"], m)).toHaveLength(1);
  });
  it("fewer than 2 timed events => passes", () => {
    const m = byId(mk("w", "cd-waste"), mk("a", "kick-eaten", 130));
    expect(hindsightViolations(["w", "a"], m)).toEqual([]);
    expect(hindsightViolations(["a"], m)).toEqual([]);
  });
  it("anchor ties multiple types: future event type appeared within cluster => passes", () => {
    const m = byId(
      mk("a", "kick-eaten", 10),
      mk("b", "cc-locked", 12),
      mk("c", "cc-locked", 300),
    );
    expect(hindsightViolations(["a", "b", "c"], m)).toEqual([]);
  });
  it("multiple future cross-type references reported individually", () => {
    const m = byId(
      mk("a", "kick-eaten", 10),
      mk("b", "cc-locked", 100),
      mk("c", "wasted-trinket", 200),
    );
    expect(hindsightViolations(["a", "b", "c"], m)).toHaveLength(2);
  });
  it("constant exported as 30", () => {
    expect(HINDSIGHT_CLUSTER_SLACK_S).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify failure** (module does not exist)
- [ ] **Step 3: Minimal implementation**:

```ts
import type { CandidateEvent } from "./types";

/** Same encounter clustering window (seconds). Independent constant, semantic != deepDive's PACK_BEFORE_S. */
export const HINDSIGHT_CLUSTER_SLACK_S = 30;

/**
 * Hindsight bias predicate (spec 2026-08-06-hindsight-predicate-design rules 1-3).
 * Comparison is based on rendered facts facts.t (the value the model sees in the menu); missing facts.t = whole-round,
 * does not participate in anchor calculation and does not exempt the entire finding.
 */
export function hindsightViolations(
  eventIds: string[],
  byId: Map<string, CandidateEvent>,
): string[] {
  const timed = eventIds
    .map((id) => byId.get(id))
    .filter(
      (e): e is CandidateEvent => e !== undefined && e.facts.t !== undefined,
    )
    .map((e) => ({ e, t: Number(e.facts.t) }))
    .filter(({ t }) => Number.isFinite(t));
  if (timed.length < 2) return [];
  const anchorT = Math.min(...timed.map(({ t }) => t));
  const clusterTypes = new Set(
    timed
      .filter(({ t }) => t <= anchorT + HINDSIGHT_CLUSTER_SLACK_S)
      .map(({ e }) => e.type),
  );
  const out: string[] = [];
  for (const { e, t } of timed) {
    if (t - anchorT > HINDSIGHT_CLUSTER_SLACK_S && !clusterTypes.has(e.type)) {
      out.push(
        `hindsight: referenced ${e.type} event ${t}s after anchor ${anchorT}s, cross-type and outside ${HINDSIGHT_CLUSTER_SLACK_S}s clustering window`,
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify all green**
- [ ] **Step 5: Commit** `feat(analysis): hindsightLint hindsight bias predicate -- implicit anchor + cluster exemption, anchored on rendered facts.t`

### Task 2: auditFindings 5th Layer Drop

**Files:**

- Modify: `packages/analysis/src/analysis/auditFindings.ts` (after causalLint layer, before accept)
- Test: `packages/analysis/src/analysis/auditFindings.test.ts` (append test cases; append if file exists, create if not)

**Interfaces:**

- Consumes: Task 1 `hindsightViolations(finding.eventIds, byId)`.
- Produces: dropped reason prefix `hindsight: ` (predicate return string already includes prefix, directly `dropped.push({ finding, reason: violations.join("; ") })`).

- [ ] **Step 1: Failing test** — Construct an `auditFindings` call containing two candidates: kick-eaten@130 + death-unused-defensive@161, assert that this finding goes to `dropped` and reason contains `hindsight:`; add another same-type across periods finding to assert survival. Candidate facts in the test must include `t` (string), and finding explanation uses valid placeholders (following existing test construction style in that file).
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implementation** — After causalLint drop block:

```ts
const hv = hindsightViolations(f.eventIds, byId);
if (hv.length > 0) {
  dropped.push({ finding: f, reason: hv.join("; ") });
  continue;
}
```

(Add import to file header; if the finding variable name in that file's drop loop is not `f`, or map is not `byId`, align with existing file.)

- [ ] **Step 4: Run full analysis test suite + `npm run typecheck`**
- [ ] **Step 5: Commit** `feat(analysis): auditFindings 5th layer hindsight drop -- consumes hindsightLint predicate`

### Task 3: hindsightScan Corpus Tool

**Files:**

- Create: `packages/eval/scripts/hindsightScan.ts`
- Test: `packages/eval/test/hindsightScan.test.ts` (core pure functions)

**Interfaces:**

- Consumes: `hindsightViolations`, `HINDSIGHT_CLUSTER_SLACK_S` from `@gladlog/analysis` (cross-package import via existing workspace dependency; use directly if eval already depends on analysis, otherwise declare dependency).
- Produces: Two modes:
  - `--synthesize --run <runId>`: Samples menus from run corpus (reuse existing path from `smokeFindingsPrompt.ts` to get candidate menus; extract shared helper if not yet reusable), synthesizes two finding groups: 20 **planted violations** (pairs of events within same menu with different types and Δfacts.t > 30s) and 20 **legitimate** (same-type pairs / cluster pairs within 30s / death-setup single event), runs predicate on each, prints `planted caught X/20, legit passed Y/20` along with itemized table. If menus are insufficient for 20, print actual n truthfully without inflating.
  - `--check <jsonl>`: Each line `{eventIds, candidates}`, runs predicate and reports violating line numbers and reasons (used for smoke audit).
- Core logic (sampling, synthesis, evaluation) extracted as exported pure functions; script shell handles only IO — tests verify pure functions: given synthetic menus, planted synthesis must be caught by predicate, legit synthesis must pass.

- [ ] **Step 1: Failing test** (Pure functions: each finding returned by `synthesizePlanted(menu)` produces non-empty predicate violations; each from `synthesizeLegit(menu)` produces empty)
- [ ] **Step 2: Verify failure → Step 3: Implement → Step 4: All green + typecheck**
- [ ] **Step 5: Commit** `feat(eval): hindsightScan corpus tool -- two modes: planted/legit synthesis + predicate audit`

### Task 4: Bilingual Registration in Predicate Index

**Files:**

- Modify: `docs/predicate-index.md` ("Gate side (`packages/eval`)" section) and matching section in `docs/predicate-index.zh-CN.md`
- Modify: `packages/eval/test/predicateIndex.test.ts`

**Steps:**

- [ ] Add one line to each language (following existing row format in that section, registering `hindsightViolations` + `HINDSIGHT_CLUSTER_SLACK_S`, consumers `auditFindings` (product) and `hindsightScan` (eval), with a one-sentence note on exemption semantics).
- [ ] Pin in `predicateIndex.test.ts` following existing paradigm: symbol exists in `hindsightLint.ts`, constant value 30 is single-sourced, index rows exist in both languages.
- [ ] Run `npm test --prefix packages/eval` to verify all green.
- [ ] Commit `docs: bilingual registration of hindsightViolations predicate + consistency pins`

### Task 5: Acceptance Experiments (Run by orchestrator directly, do not delegate to implementation subagents)

- [ ] Step 1: `--synthesize` run against real corpus run (pick a widely covering existing run, e.g. 2026-07-16-baseline), record planted X/20, legit Y/20; if not 20/20 and 0/20, fix predicate and re-run (fixes committed, no relaxation of acceptance criteria).
- [ ] Step 2: 20-match real smoke test: construct findings prompt for 20 matches from corpus (smokeFindingsPrompt path), one sonnet responder subagent per match producing findings JSON, pass through parse + auditFindings (new 5-layer gate), tally hindsight drop rate; manually review drops one by one, if false positive > 1/3, iterate rules (changes documented in spec).
- [ ] Step 3: Write results back to spec acceptance table (actual measured numbers) + SDD ledger; output report to `$GLADLOG_EVAL_HOME/ab/2026-08-06-hindsight/report.md`.
- [ ] Commit spec updates.

## Self-review

- Spec coverage: Rules 1-3 (Task 1), product gate (Task 2), eval scan + planted acceptance (Tasks 3+5), predicate index (Task 4), acceptance table three rows (Task 5) all covered; `buildCalibrationSuite` hindsight-pair perturbation class from spec landing section **moved to implementation inside hindsightScan** (planted synthesis is perturbation generation; judge calibration is orthogonal to deterministic predicates) — spec landing section will be corrected upon Task 5 writeback.
- Placeholder scan: No TBDs; Task 2 variable name alignment note is a practical constraint, not a placeholder.
- Type consistency: `hindsightViolations(eventIds: string[], byId: Map<string, CandidateEvent>)` consistent throughout; facts.t criteria consistent throughout.
