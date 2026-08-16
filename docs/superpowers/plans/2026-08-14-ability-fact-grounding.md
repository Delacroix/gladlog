# Ability Fact Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "what can be pressed while CC'd" from 6 hand-written priors into a SpellMisc flag-driven generated table (three-line evidence cross-verification), establish a user sign-off system for unofficial facts, survey the official effect data surface, and fix broken links in the name table — eliminating the largest source of the 17% spec layer error rate exposed by the spec audit.

**Architecture:** Copy the DR officialization (commit 028e625) seven-step method: empirical anchoring → official mining → three-party diff → retain gaps by hand → shim consumption → two-way error check on corpus. The new datagen script enters the existing pipeline (manifest registration + anti-corruption tests), consumers switch via a thin shim, and behavior tests remain green.

**Tech Stack:** Existing datagen infrastructure (`wagoCsv.ts` CSV fetch / column assertions / resolveBuild in `packages/analysis/scripts/datagen/lib/wagoCsv.ts`), tsx, vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-ability-fact-grounding-design.md`

## Global Constraints

- **Use official data to the greatest extent possible; unofficial or uncertain facts must be signed off by the user** (with `approved: "<date> user"` field; entries without sign-off fail CI red).
- **Make no assumptions when interpreting flag bits**: search driven by anchor checklist; if anchors cannot be matched → stop, report, do not generate table (spec B1 Step 1).
- Legacy large tables (SPELL_CATEGORIES / classSpells) are not signed off item by item—registered as "legacy unreviewed"; sign-off obligations only cover newly added and audit-flagged entries.
- Comply with all datagen conventions: build is single-sourced via `resolveBuild()`; artifacts use one of three marking conventions (Generated filename / header comment / generatedAt field) + registered in `datagen-manifest.json.artifacts` (otherwise `datagenManifest.test.ts` fails red); correction layer is always above generated layer; "official ≠ verification-free"—two-way corpus error metrics before launch.
- Predicate index bilingual pairs: `docs/predicate-index.md` and `.zh-CN.md` must be modified together with equivalent content; `predicateIndex.test.ts` registers new symbols following existing patterns.
- Type checking: `npm run typecheck` (never tsc -b); before pushing run `npm test --workspaces && npm run typecheck && npx eslint . --quiet`.
- Direct commit + push to main; one commit per task.
- **Two user sign-off pause points** (marked PAUSE in plan): after Task 2 (anchor checklist), after Task 4 (three-party diff discrepancy checklist). The controller is responsible for presenting them; subsequent tasks do not start until user approval.

## Data Contracts (Shared Across Plan)

```ts
// packages/analysis/src/data/usableWhileCcGenerated.ts (Task 3 output; generated file, do not edit manually)
// 2026-08-14 Scope revision: feared structurally falsified via brute force (SpellMisc pure OR bits have no solution in any combination),
// confused has insufficient anchors — both dimensions retained in handwritten layer per spec "retain handwritten gaps" clause; generated table only outputs stunned.
export const USABLE_WHILE_CC_GENERATED: {
  stunned: ReadonlySet<string>; // Cast spellIds castable while stunned
};

// packages/analysis/src/data/curatedAbilityFacts.ts (Task 6 output; sign-off registry)
export interface ICuratedAbilityFact {
  id: string; // spellId or talent spellId
  claim: string; // One-sentence fact assertion
  kind: "talent_effect" | "usable_while_cc_gap" | "usable_while_cc_conditional" | "mechanic" | "cost_norm";
  requiresTalent?: string; // conditional type: granting PvP talent spellId (2026-08-14 user design: usable while CC'd can be talent-conditional)
  source: string; // Source (official tooltip / wowhead link / adjudication record)
  approved: string; // "YYYY-MM-DD user" — entries without this field fail tests red
}
export const CURATED_ABILITY_FACTS: ICuratedAbilityFact[];
```

---

### Task 1: A1+A2 — Assertion Inventory Archival + Official Effect Surface Survey

**Files:**

- Create: `docs/ability-fact-inventory.md`
- Create: `packages/analysis/scripts/datagen/dumpTableColumns.ts` (one-off reconnaissance tool, retained in archive)

**Interfaces:**

- Consumes: Table fetch helpers in `lib/wagoCsv.ts` (first read that file and `genDrCategories.ts` to learn invocation patterns; replicate column name assertion conventions).
- Produces: inventory document (updated in subsequent tasks); "candidate pool of unmined effects" section surveyed in A2.

- [ ] **Step 1: Write reconnaissance script** — `dumpTableColumns.ts`: for the candidate table list (`SpellMisc`, `SpellAuraOptions`, `SpellInterrupts`, `SpellShapeshift`, `SpellCastingRequirements`, `SpellCategories`, `SpellEffect`, `SpellAuraRestrictions`, `SpellTargetRestrictions`), fetch the header row of CSV for the current build (`resolveBuild()`) via wagoCsv one by one, and print all column names for each table. **Column names must come from actual fetches, never written from memory**. Run once and archive the output into documentation.

- [ ] **Step 2: Write `docs/ability-fact-inventory.md`**, two major sections:
  1. **Assertion Inventory (A1)**: Three-tier classification table, based on 2026-08-14 exploration (table by table across cooldowns.ts family: MAJOR_DEFENSIVE_IDS 39 / EXTERNAL 14 / CD_ROLE_TAGS 7 · untested / TEAM_HEAL 8 / ADDITIONAL_OVERLAP 12 / USABLE_WHILE_CC 6 / FORBEARANCE 4 / PASSIVE_BLOCKLIST 8 · matched by name / SPEC_EXCLUSIVE / NON_SUBSTITUTE / SELF_CAST_NOOP / THROUGHPUT_EMPOWER; spellIdLists 3 tables; SPELL_CATEGORIES 163; classSpells 132 D/O/C; dispel 5 spec sets; talentBehaviors 23; spellEffectOverrides 22; racialAbilities 41; drCategories handwritten disarm/knockback; mitigationData overrides 12 + NO_MITIGATION 15; spellCategories kickLockoutSeconds) — each row: file:line, count, tier (officially backed / manual / pure prior), test coverage, consumers. Verify line numbers against source code item by item, do not blindly copy old exploration notes.
  2. **Official Effect Surface Survey (A2)**: Every table and column fetched in Step 1 (Attributes family listed by column), labeled "pipeline mined (which script) / unmined"; unmined items get one-line evaluation: "What analysis could this unlock + pipeline recommendation (yes/no/to-discuss)". Focus evaluation on: Attributes flag family (usable while CC'd / immunity types / uninterruptible types), SpellInterrupts (interrupted lockout school), SpellAuraOptions (proc probability / stacks), SpellShapeshift (stance/form restrictions).

- [ ] **Step 3: Self-check** — Sample 5 "file:line" references in document using Read to verify accuracy; ensure A2 column names match Step 1 output.

- [ ] **Step 4: Commit**

```bash
git add docs/ability-fact-inventory.md packages/analysis/scripts/datagen/dumpTableColumns.ts
git commit -m "docs(analysis): ability fact assertion inventory + official effect surface survey (A1+A2)"
```

---

### Task 2: Anchor Checklist Proposal (→ PAUSE User Sign-off)

**Files:**

- Create: `packages/analysis/scripts/datagen/usableWhileCcAnchors.ts`

**Interfaces:**

- Produces: `export const UWC_ANCHORS: Array<{ spellId: string; name: string; stunned: boolean | null; feared: boolean | null; confused: boolean | null; rationale: string }>` (`null` = dimension not anchored). Consumed by Task 3 search algorithm; `approvedBy` constant filled by controller after user approval.

- [ ] **Step 1: Draft anchor checklist** (12-16 items, covering positive/negative examples and 3 dimensions), must include:
  - Gladiator's Medallion 336126: stunned=true (medallion design purpose; 2026-08-14 corpus evidence shows 5 casts while stunned);
  - Divine Shield 642: **stunned=false** (2026-08-14 user ruling "Divine Shield cannot be cast while stunned" — note: current handwritten table `USABLE_WHILE_CC_SPELL_IDS` contains 642, conflicting directly with ruling; clarify in rationale that this is the #1 divergence awaiting official bit / corpus arbitration);
  - The other 5 entries in current handwritten table (33206 Pain Suppression / 22812 Barkskin / 47585 Dispersion / 55233 Vampiric Blood / 48792 Icebound Fortitude) with respective expected values and sources;
  - Negative examples: Holy Light (hard cast heal, stunned=false), Hammer of Justice (stunned=false);
  - Fear dimension anchors: Imp Singe Magic / Unending Resolve types 1-2 items each, with sources stated; fill null for uncertain dimensions, do not force guesses.
    Each item requires a one-line rationale and one source.
- [ ] **Step 2: Typecheck passes** (`npm run typecheck`), commit:

```bash
git add packages/analysis/scripts/datagen/usableWhileCcAnchors.ts
git commit -m "feat(datagen): proposal for usable while CC'd anchors (pending user sign-off)"
```

- [ ] **Step 3: PAUSE** — Report to controller: full anchor checklist text + 642 conflict explanation, submit for item-by-item user approval. **Task 3 does not start until user approval**; entries with revised user rulings are updated and recommitted (commit message noting ruling date).

---

### Task 3: B1 — genUsableWhileCc Official Mining (Anchor-Driven Bit Search)

**Files:**

- Create: `packages/analysis/scripts/datagen/genUsableWhileCc.ts`
- Create: `packages/analysis/src/data/usableWhileCcGenerated.ts` (script output)
- Modify: `packages/analysis/src/data/datagen-manifest.json` (artifacts registration)
- Modify: `docs/commands/update-wow-data.md` (add row to script inventory, matching existing sequence table format)
- Test: `packages/analysis/test/datagen/usableWhileCc.test.ts`

**Interfaces:**

- Consumes: `UWC_ANCHORS` (signed version); wagoCsv helper; `resolveBuild()`.
- Produces: `USABLE_WHILE_CC_GENERATED` (data contract signature); generated file carries `Generated at:` header comment.

- [ ] **Step 1: Write failing test** — anchor consistency (core safety net):

```ts
// packages/analysis/test/datagen/usableWhileCc.test.ts
import { describe, expect, it } from "vitest";
import { USABLE_WHILE_CC_GENERATED } from "../../src/data/usableWhileCcGenerated";
import { UWC_ANCHORS } from "../../scripts/datagen/usableWhileCcAnchors";

describe("usableWhileCcGenerated anchors", () => {
  it("every signed anchor matches the generated sets", () => {
    for (const a of UWC_ANCHORS) {
      if (a.stunned !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.stunned.has(a.spellId),
          `${a.name} stunned`,
        ).toBe(a.stunned);
      if (a.feared !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.feared.has(a.spellId),
          `${a.name} feared`,
        ).toBe(a.feared);
      if (a.confused !== null)
        expect(
          USABLE_WHILE_CC_GENERATED.confused.has(a.spellId),
          `${a.name} confused`,
        ).toBe(a.confused);
    }
  });
  it("sets are non-trivial (each has >20 spells at current build)", () => {
    expect(USABLE_WHILE_CC_GENERATED.stunned.size).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: RED** (module does not exist).
- [ ] **Step 3: Implement `genUsableWhileCc.ts`**. Algorithm (anchor-driven, no column/bit assumptions):
  1. Fetch all `Attributes_N` columns of `SpellMisc` (confirm actual column names via Task 1 column archive) + `SpellID`/`DifficultyID`, filter by `DifficultyID==="0"`;
  2. **Search** (2026-08-14 revision: single bit test across 13 anchors yielded 0 candidates across all dimensions — ground truth suspected to be union of multiple authorization paths): for each dimension, first search for a single (column N, bit b) 100% consistent candidate; if none → upgrade search to **≤2 bit union** (coverage set of bitA ∪ bitB matches all non-null anchors); adoption criterion = consistent union with minimal number of bits; multiple solutions with same size → prioritize solutions sharing bits across dimensions (family consistency); if still ambiguous → `console.error` reporting all candidates and mismatched anchors, `process.exit(1)` without generating table. Generated file header notes adopted bit combinations per dimension and anchor coverage accounting.
  3. Generate `usableWhileCcGenerated.ts`: header comment includes build, adopted (column, bit), anchor count; 3 ReadonlySets;
  4. Cross-reference with `spellNames.json`: format member spell names into header comment statistics (for manual sampling), warn on missing names count.
- [ ] **Step 4: Run script → GREEN** (anchor tests pass; record sizes of 3 sets). Manifest registration + `datagenManifest.test.ts` green. Add row to update-wow-data.md.
- [ ] **Step 5: Full check** (`npm test --workspace=@gladlog/analysis && npm run typecheck`), commit:

```bash
git add packages/analysis/scripts/datagen/genUsableWhileCc.ts packages/analysis/src/data/usableWhileCcGenerated.ts packages/analysis/src/data/datagen-manifest.json packages/analysis/test/datagen/usableWhileCc.test.ts docs/commands/update-wow-data.md
git commit -m "feat(datagen): officialize usable while CC'd — SpellMisc flag anchor search (handwritten 6 → official N)"
```

---

### Task 4: Corpus Observation Pipeline + Three-Party Diff (→ PAUSE User Ruling on Discrepancies)

**Files:**

- Create: `packages/eval/scripts/uwcCorpusScan.ts` (thin shell) + `packages/eval/src/explore/uwcObserved.ts` (logic)
- Test: `packages/eval/test/explore.uwcObserved.test.ts`

**Interfaces:**

- Consumes: Local match library raw.txt (`DEFAULT_MATCH_DIR`; `loadIndex` select N≥50 matches); `DR_CATEGORIES_GENERATED.stun` (stun aura id set, from `@gladlog/analysis/src/data/drCategories`); `USABLE_WHILE_CC_GENERATED`.
- Produces: `observedCastsWhileStunned(rawText: string, stunAuraIds: ReadonlySet<string>): Map<string, number>` — parses raw lines, tracks active stun aura intervals per unit (SPELL_AURA_APPLIED/REMOVED, spellId ∈ stun set), counts `SPELL_CAST_SUCCESS` spellIds for unit within interval.

- [ ] **Step 1: Failing unit test** — manually construct 6-line raw text fixture (APPLIED stun → two CAST_SUCCESS lines (one inside stun, one outside) → REMOVED), asserting Map contains exactly that inside-stun spellId with count 1. Write fixture according to real raw line format (copy a line from any matches/*/raw.txt and modify fields).
- [ ] **Step 2: RED → Implement → GREEN**.
- [ ] **Step 3: Thin shell runs on full corpus** (N≥50 matches, including shuffle games), outputs three-party diff report (stdout + write to `$GLADLOG_EVAL_HOME/reports/uwc-diff.md`):
  - Observed set ∩/− official set; **item-by-item breakdown of "official says unusable but cast observed while stunned in corpus"** (must be 0 or explained individually — instant cast grace period / 0.x sec timing jitter after stun removal, etc.);
  - Sample size notes for official set spells never observed in corpus (two-way error, official ≠ verification-free);
  - Final adjudication recommendations for the 6 handwritten entries (including 642) under official bits and corpus data.
- [ ] **Step 4: Commit**:

```bash
git add packages/eval/scripts/uwcCorpusScan.ts packages/eval/src/explore/uwcObserved.ts packages/eval/test/explore.uwcObserved.test.ts
git commit -m "feat(eval): usable while CC corpus observation pipeline — stun cast scan + three-party diff report"
```

- [ ] **Step 5: PAUSE** — Present discrepancy checklist for user adjudication (especially final ruling on 642). User rulings land in Task 6 sign-off registry.

---

### Task 5: Shim Consumption + Predicate Index

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts:127` region (`USABLE_WHILE_CC_SPELL_IDS`)
- Modify: `docs/predicate-index.md` + `docs/predicate-index.zh-CN.md` (bilingual equivalence)
- Modify: `packages/eval/test/predicateIndex.test.ts` (register symbol)
- Test: `packages/analysis/test/usableWhileCcShim.test.ts`

**Interfaces:**

- Produces (2026-08-14 PAUSE 2 revision: conditional layer design, confirmed by user):
  - `USABLE_WHILE_CC_SPELL_IDS` semantics changed to `stunned generated set ∪ unconditional manual gap layer` (exported name and consumers `matchTimelineSections.ts:685` / `candidateFindings.ts:1816` remain unchanged — internal swap under shim, zero external modifications; gap layer first entry = Divine Protection 498+403876, citing wowhead flag + 748 corpus occurrences + user main-spec three-line evidence);
  - New export `usableWhileStunned(spellId: string, pvpTalentIds?: ReadonlySet<string>): boolean` (registered in predicate index): hit unconditional set → true; hit conditional layer `USABLE_WHILE_CC_CONDITIONAL: Record<string, { requiresTalent: string; source: string }>` (initial candidates = Transference 119996, Thunderstorm 51490; takes effect only after granting talent id is verified and signed off by user) and pvpTalentIds contains requiresTalent → true; hit conditional layer but talent context not provided → false (conservative, function comments document rationale);
  - Conditional layer is empty Record before granting talent ids are signed off (structure lands first, data arrives in Task 6).

- [ ] **Step 1: Failing test**: shim = generated ∪ gap layer (union semantics, patterned after drCategories shim test style); members of original 6 that remain valid per Task 4 final ruling still have `has`===true; 642 asserted according to user final ruling.
- [ ] **Step 2: RED → Implement** (shimmed within cooldowns.ts, DR-style comments: generated layer source, gap layer rationale) → GREEN; existing consumer behavior tests (`candidateFindings.test.ts:673-704`, `context.timelineSections.test.ts:1076`) remain all green — if Ironbark (not usable in stun) is included by official bit causing line 1076 to fail red, resolve according to official + corpus evidence and user final ruling; do not silently alter assertions.
- [ ] **Step 3: Add bilingual rows to predicate index (format matching existing rows) + register in predicateIndex.test.ts; run test to verify green.**
- [ ] **Step 4: Full check + commit**:

```bash
git add packages/analysis/src/utils/cooldowns.ts packages/analysis/test/usableWhileCcShim.test.ts docs/predicate-index.md docs/predicate-index.zh-CN.md packages/eval/test/predicateIndex.test.ts
git commit -m "feat(analysis): shim USABLE_WHILE_CC — generated layer ∪ gap layer, usableWhileStunned predicate added to index"
```

---

### Task 6: B2 — Sign-off Registry and Enforcement Tests

**Files:**

- Create: `packages/analysis/src/data/curatedAbilityFacts.ts`
- Test: `packages/analysis/test/curatedFacts.test.ts`

**Interfaces:**

- Produces: `ICuratedAbilityFact` / `CURATED_ABILITY_FACTS` in data contract.

- [ ] **Step 1: Failing test**:

```ts
import { describe, expect, it } from "vitest";
import { CURATED_ABILITY_FACTS } from "../src/data/curatedAbilityFacts";

describe("curated ability facts sign-off", () => {
  it("every entry carries a user approval stamp", () => {
    for (const f of CURATED_ABILITY_FACTS) {
      expect(f.approved, `${f.id} ${f.claim}`).toMatch(
        /^\d{4}-\d{2}-\d{2} user$/,
      );
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = CURATED_ABILITY_FACTS.map(
      (f) => `${f.kind}:${f.id}:${f.claim}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: RED → Implement**. First batch of entries (approved fills user's actual ruling date): Chrysalis 202424 "Reduces cooldown of Life Cocoon by 45 seconds" (2026-08-14 ruling, source = official talent data + audit report); Restoral / Peaceweaver 353313 "Does not modify Life Cocoon cooldown" (same); gap layer entries from Task 4 user final rulings (e.g. 642 final ruling). Header comment: sign-off workflow explanation (new entries require user approval with date; enforced by CI).
- [ ] **Step 3: GREEN + commit**:

```bash
git add packages/analysis/src/data/curatedAbilityFacts.ts packages/analysis/test/curatedFacts.test.ts
git commit -m "feat(analysis): unofficial ability facts sign-off registry — approved CI enforcement, initial talent effect entries"
```

---

### Task 7: B3 — Living Flame Name Table Link Repair + Similar Exposure Scan

**Files:**

- Modify: `packages/analysis/src/utils/cooldowns.ts` (cast aggregation site in `extractMajorCooldowns`; inspect code to locate)
- Create: `packages/eval/scripts/cdLedgerRotScan.ts` (thin shell) + `packages/eval/src/explore/cdLedgerRot.ts` (logic)
- Test: Add new or expand existing cooldowns tests in `packages/analysis/test/`

**Interfaces:**

- Consumes: match 76ea5f90 (empirical sample: Girlbye's Living Flame appears in flow casts but cooldown ledger casts is empty).
- Produces: Replaying `cd` queries for this match after fix shows Living Flame is no longer perpetually ready; scan script outputs count of contradictory pairs where "flow has casts ∧ ledger has neverUsed" across full corpus.

- [ ] **Step 1: Reproduce** — Before writing failing tests, use real data from 76ea5f90 to isolate root cause of broken link (mismatch between cast spellId and ledger table key? name table ambiguity?), report root cause before modifying code; if root cause is in generated table key space, fix via data layer rather than logic layer (predicate discipline).
- [ ] **Step 2: Failing test** (based on root cause shape: synthetic fixture asserting cast aggregation for this spellId is non-empty) → RED → Fix → GREEN; record before/after comparison numbers for 76e replay in commit message.
- [ ] **Step 3: Run scan script on full corpus**, log contradictory pair counts in `$GLADLOG_EVAL_HOME/reports/cd-ledger-rot.md` (two numbers: before and after fix); list residual contradictions item by item (to fix in next batch).
- [ ] **Step 4: Commit** (message includes before/after metrics).

---

### Task 8: B4 — Consumer Wiring Completion + Documentation + Full Gate

**Files:**

- Modify: `docs/commands/deepdive-probe.md` (Update "Usable while CC'd" section to reference `usableWhileStunned` predicate / generated table; add "query table first for mechanic-level assertions" to source discipline section)
- Modify: `docs/ability-fact-inventory.md` (Migrate USABLE_WHILE_CC to officially backed; register sign-off registry / fixed items)
- Modify: `docs/BACKLOG.md` (Add notes if #26/#27 are partially covered by this project; pointer to A2 survey candidate pool)

**Interfaces:** Pure documentation wiring; code consumers completed in Task 5.

- [ ] **Step 1: Update three documents** (mechanics discipline section in manual updates "what can be pressed while CC'd" from model prior to "run predicate query on table first, label as prior only if not in table").
- [ ] **Step 2: Full Gate**: `npm test --workspaces && npm run typecheck && npx eslint . --quiet` all green (timeouts 600000ms).
- [ ] **Step 3: Commit + push**:

```bash
git add docs/commands/deepdive-probe.md docs/ability-fact-inventory.md docs/BACKLOG.md
git commit -m "docs: ability fact foundation wrap-up — deep dive discipline wired to table query, inventory tier migration"
git push
```

---

## Definition of Done

- Usable while CC'd: handwritten 6 → official N (+ corpus observation pipeline), all three-way discrepancies adjudicated by user, two-way error metrics documented;
- Sign-off registry CI enforcement active, initial batch of entries registered;
- Living Flame broken link resolved with before/after metrics recorded, similar exposures inventoried;
- inventory document becomes permanent exposure ledger; A2 candidate pool ready for user selection in next datagen batch.
