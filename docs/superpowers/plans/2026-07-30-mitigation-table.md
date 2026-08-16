# Mitigation {Percentage, School} Table (#17 Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whitelist 35 major defensive / external `{pct, schoolMask}` table: DB2 generated base + curated overrides, no-third-state anti-regression, zero consumers in this phase.

**Architecture:** New datagen script scrapes `SpellEffect`'s `EffectAura==87` (AURA_MOD_DAMAGE_PERCENT_TAKEN) rows -> `mitigationGenerated.json`; `mitigationData.ts` two-layer merge (overrides always win) + explicit `NO_MITIGATION_IDS` registration; 35-item human review + corpus sanity verification.

**Tech Stack:** TypeScript, vitest, wago.tools DB2 CSV.

**Spec:** `docs/superpowers/specs/2026-07-30-mitigation-table-design.md`
**Working Directory:** Always worktree `/Users/mingjianliu/code/gladlog-wt-small` (main; dependencies installed). Main checkout `/Users/mingjianliu/code/gladlog` is occupied by user, **strictly do not touch**.

## Global Constraints

- Commit directly to worktree main, push at the end; never bare `cd` in compound commands; never pipe to gate chain; run `npm run presubmit` before push.
- Test with workspace scope (`npm test --workspace=packages/analysis`).
- **Whitelist Single Source**: 35 IDs derived only from `spellIdLists.bigDefensiveSpellIds ∪ externalDefensiveSpellIds` (21+14), no file may duplicate ID arrays;
- **No Third State**: `MITIGATION_TABLE ∪ NO_MITIGATION_IDS ⊇ Whitelist`, asserted by anti-regression tests;
- Generation layer only recognizes `EffectAura===87`, ambiguities / unresolvable cases **not guessed** into unresolved; curated overrides always win;
- schoolMask bit semantics match combat log `spellSchoolId` (0x1 Physical ... 0x7F All); pct ∈ (0,100], immunity = 100;
- datagen supports `DATAGEN_BUILD` env to pin build (`genSpellNamesZh` precedent) — **generation must pin `DATAGEN_BUILD=12.1.0.68629`** (same build as other repo artifacts, manifest must not drift).

---

### Task 1: datagen — genMitigation.ts + Generated Artifacts + Registration

**Files:**

- Create: `packages/analysis/scripts/datagen/genMitigation.ts`
- Test: `packages/analysis/test/datagen.mitigation.test.ts` (new)
- Modify: `packages/analysis/scripts/datagen/writeManifest.ts` (add artifact entry)
- Create (generated): `packages/analysis/src/data/mitigationGenerated.json`
- Modify: `packages/analysis/src/data/datagen-manifest.json` (script generated)
- Modify: `docs/commands/update-wow-data.md` (Step 6g registration)

**Interfaces:**

- Consumes: `parseCsv/fetchLatestBuild/fetchTable/assertColumns` (`lib/wagoCsv`), `writeArtifact` (`lib/emit`), `spellIdLists` (default export, `packages/analysis/src/data/spellIdLists.ts`).
- Produces:
  - `transformMitigation(csvText, whitelistIds): { entries: Record<string, { pct: number; schoolMask: number }>; unresolved: Array<{ id: string; reason: string }> }` (pure function, exported)
  - `mitigationGenerated.json` = `{ entries, unresolved }` (unresolved written to disk — curation layer needs to see it to fill in)

- [ ] **Step 1: Write failing transform unit tests**

`packages/analysis/test/datagen.mitigation.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { transformMitigation } from "../scripts/datagen/genMitigation";

// SpellEffect CSV minimal sample: column names follow real table (implementer first fetchTable to verify real CSV header;
// below uses columns already consumed by genTalentModifiers)
const HEADER =
  "ID,DifficultyID,EffectAura,EffectBasePointsF,EffectMiscValue_0,SpellID,Effect";
const row = (
  spellId: string,
  aura: string,
  points: string,
  misc: string,
  diff = "0",
) =>
  `${Math.random().toString().slice(2, 8)},${diff},${aura},${points},${misc},${spellId},6`;

describe("transformMitigation", () => {
  const WL = new Set(["22812", "33206", "642", "97462"]);

  test("87 rows: negative points take absolute value, mask passed through; non-whitelist / non-87 rows ignored", () => {
    const csv = [
      HEADER,
      row("22812", "87", "-20", "127"), // Barkskin: 20% all schools
      row("33206", "87", "-40", "127"), // Pain Suppression: 40%
      row("99999", "87", "-30", "127"), // Non-whitelist -> ignored
      row("22812", "4", "-15", "1"), // Non-87 aura -> ignored
    ].join("\n");
    const r = transformMitigation(csv, WL);
    expect(r.entries).toEqual({
      "22812": { pct: 20, schoolMask: 127 },
      "33206": { pct: 40, schoolMask: 127 },
    });
    expect(r.unresolved).toEqual([]);
  });

  test("multiple 87 rows for same spell with different values -> do not guess, goes to unresolved", () => {
    const csv = [
      HEADER,
      row("97462", "87", "-10", "127"),
      row("97462", "87", "-15", "127"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["97462"]));
    expect(r.entries["97462"]).toBeUndefined();
    expect(r.unresolved).toEqual([
      { id: "97462", reason: "multiple-conflicting-87-rows" },
    ]);
  });

  test("multiple 87 rows for same spell with identical values -> converges to single entry (no ambiguity)", () => {
    const csv = [
      HEADER,
      row("642", "87", "-20", "126"),
      row("642", "87", "-20", "126"),
    ].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toEqual({ pct: 20, schoolMask: 126 });
  });

  test("zero matching 87 rows within whitelist -> neither in entries nor unresolved (absence caught at merge layer by anti-regression test)", () => {
    const csv = [HEADER, row("642", "4", "-20", "1")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries).toEqual({});
    expect(r.unresolved).toEqual([]);
  });

  test("rows with non-0 DifficultyID ignored (same deduplication caliber as genDrCategories)", () => {
    const csv = [HEADER, row("642", "87", "-20", "127", "1")].join("\n");
    expect(transformMitigation(csv, new Set(["642"])).entries).toEqual({});
  });

  test("positive points (non-mitigation semantics) -> unresolved instead of included", () => {
    const csv = [HEADER, row("642", "87", "25", "127")].join("\n");
    const r = transformMitigation(csv, new Set(["642"]));
    expect(r.entries["642"]).toBeUndefined();
    expect(r.unresolved).toEqual([{ id: "642", reason: "positive-points" }]);
  });
});
```

⚠ Implementer Step 1: Pull real `SpellEffect` CSV under `DATAGEN_CACHE=$(mktemp -d)` first, verify header column names (whether `EffectAura/EffectBasePointsF/EffectMiscValue_0/SpellID/DifficultyID` match those consumed by genTalentModifiers.ts:142-147); if mismatched, correct tests and implementation per real column names, state clearly in report.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/analysis -- datagen.mitigation`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implementation**

`genMitigation.ts` (structured following genSpellNamesZh.ts: DATAGEN_BUILD override + main auto-start):

```ts
import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertColumns,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";
import spellIdLists from "../../src/data/spellIdLists";

/** AURA_MOD_DAMAGE_PERCENT_TAKEN: EffectBasePointsF = negative percentage,
 * EffectMiscValue_0 = school mask (same bit semantics as log spellSchoolId). */
const MITIGATION_AURA = "87";

export interface IMitigationRaw {
  pct: number;
  schoolMask: number;
}

export function transformMitigation(
  csvText: string,
  whitelistIds: ReadonlySet<string>,
): {
  entries: Record<string, IMitigationRaw>;
  unresolved: Array<{ id: string; reason: string }>;
} {
  const { rows } = parseCsv(csvText);
  const seen = new Map<string, IMitigationRaw[]>();
  for (const row of rows) {
    if (row.DifficultyID !== "0") continue;
    if (row.EffectAura !== MITIGATION_AURA) continue;
    const id = row.SpellID;
    if (!whitelistIds.has(id)) continue;
    const points = Number(row.EffectBasePointsF);
    const mask = Number(row.EffectMiscValue_0);
    const arr = seen.get(id) ?? [];
    arr.push({ pct: points, schoolMask: mask }); // Stash raw signs, evaluate during convergence
    seen.set(id, arr);
  }
  const entries: Record<string, IMitigationRaw> = {};
  const unresolved: Array<{ id: string; reason: string }> = [];
  for (const [id, hits] of seen) {
    const uniq = [...new Set(hits.map((h) => `${h.pct}:${h.schoolMask}`))];
    if (uniq.length > 1) {
      unresolved.push({ id, reason: "multiple-conflicting-87-rows" });
      continue;
    }
    const h = hits[0]!;
    if (h.pct >= 0) {
      unresolved.push({ id, reason: "positive-points" });
      continue;
    }
    entries[id] = {
      pct: Math.abs(Math.round(h.pct)),
      schoolMask: h.schoolMask,
    };
  }
  return { entries, unresolved };
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const csv = await fetchTable("SpellEffect", build, process.env.DATAGEN_CACHE);
  const wl = new Set([
    ...spellIdLists.bigDefensiveSpellIds,
    ...spellIdLists.externalDefensiveSpellIds,
  ]);
  const r = transformMitigation(csv, wl);
  const outPath = new URL(
    "../../src/data/mitigationGenerated.json",
    import.meta.url,
  ).pathname;
  writeArtifact(outPath, JSON.stringify(r, null, 2)); // Small table, pretty-printed for easy human review diffs
  console.log(
    `entries=${Object.keys(r.entries).length} unresolved=${r.unresolved.length}`,
    build,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genMitigation.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

(`assertColumns` added to main per real column names after pulling real CSV; style follows genDrCategories.ts:34-38.)

- [ ] **Step 4: Run tests to verify pass + run real generation**

```bash
npm test --workspace=packages/analysis -- datagen.mitigation
export DATAGEN_CACHE=$(mktemp -d)
DATAGEN_BUILD=12.1.0.68629 npx tsx packages/analysis/scripts/datagen/genMitigation.ts
```

Expected: Tests PASS; stdout prints entries/unresolved counts (order of magnitude expected: direct extraction hits a dozen to twenty-something out of 35, unresolved + zero hits total around ten — actual numbers into report). Add to `writeManifest.ts` artifacts:

```ts
"mitigationGenerated.json": {
  entries: Object.keys(readJson("mitigationGenerated.json").entries).length,
  unresolved: readJson("mitigationGenerated.json").unresolved.length,
  bytes: statSync(dataDir + "mitigationGenerated.json").size,
},
```

`DATAGEN_BUILD=12.1.0.68629 npx tsx packages/analysis/scripts/datagen/writeManifest.ts`, git diff verify build still 68629. Add after 6f in Step 4 of `update-wow-data.md`:

```bash
# 6g. Mitigation table (#17 foundation; whitelist = big ∪ external 35 items, curated overrides in mitigationData.ts)
npx tsx packages/analysis/scripts/datagen/genMitigation.ts
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add packages/analysis docs/commands/update-wow-data.md
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "feat(analysis): mitigation table generation layer genMitigation (SpellEffect aura87, ambiguities into unresolved)"
```

---

### Task 2: mitigationData.ts Two-layer Merge + 35-item Human Review Curation + Anti-regression Tests

**Files:**

- Create: `packages/analysis/src/data/mitigationData.ts`
- Modify: `packages/analysis/src/index.ts` (export)
- Test: `packages/analysis/test/mitigationData.test.ts` (new)

**Interfaces:**

- Consumes: Task 1 `mitigationGenerated.json`, `spellIdLists`.
- Produces (#17 future consumption; index export):
  - `IMitigationEntry = { pct: number; schoolMask: number }`
  - `MITIGATION_TABLE: Record<string, IMitigationEntry>` (merged)
  - `NO_MITIGATION_IDS: ReadonlySet<string>`
  - `MITIGATION_OVERRIDES: Record<string, IMitigationEntry>` (exported only so tests can assert key surface)

- [ ] **Step 1: Write failing anti-regression tests**

`packages/analysis/test/mitigationData.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  MITIGATION_OVERRIDES,
  MITIGATION_TABLE,
  NO_MITIGATION_IDS,
} from "../src/data/mitigationData";
import spellIdLists from "../src/data/spellIdLists";

const WL = new Set([
  ...spellIdLists.bigDefensiveSpellIds,
  ...spellIdLists.externalDefensiveSpellIds,
]);

describe("Mitigation table anti-regression (no third state)", () => {
  test("Whitelist full coverage: TABLE ∪ NO_MITIGATION_IDS ⊇ Whitelist, with no third state", () => {
    const missing = [...WL].filter(
      (id) => !(id in MITIGATION_TABLE) && !NO_MITIGATION_IDS.has(id),
    );
    expect(missing).toEqual([]); // Whichever is missing turns red, error message directly readable
  });

  test("Two states mutually exclusive: IDs registered as no mitigation must not be in table simultaneously", () => {
    const both = Object.keys(MITIGATION_TABLE).filter((id) =>
      NO_MITIGATION_IDS.has(id),
    );
    expect(both).toEqual([]);
  });

  test("Value range: pct ∈ (0,100], schoolMask ∈ (0,0x7F]", () => {
    for (const [id, e] of Object.entries(MITIGATION_TABLE)) {
      expect(e.pct, id).toBeGreaterThan(0);
      expect(e.pct, id).toBeLessThanOrEqual(100);
      expect(e.schoolMask, id).toBeGreaterThan(0);
      expect(e.schoolMask, id).toBeLessThanOrEqual(0x7f);
    }
  });

  test("Table within bounds: keys of TABLE/OVERRIDES/NO_MITIGATION_IDS are all within whitelist", () => {
    for (const id of Object.keys(MITIGATION_TABLE))
      expect(WL.has(id), id).toBe(true);
    for (const id of Object.keys(MITIGATION_OVERRIDES))
      expect(WL.has(id), id).toBe(true);
    for (const id of NO_MITIGATION_IDS) expect(WL.has(id), id).toBe(true);
  });
});

describe("Anchors (game facts, pinned after implementer human review)", () => {
  // After reviewing 35 items, pick 3 cross-source anchors to pin hard -- below are candidates;
  // if review values differ, update assertions per review and record rationale in comments:
  test("Barkskin 22812: 20% all schools", () => {
    expect(MITIGATION_TABLE["22812"]).toEqual({ pct: 20, schoolMask: 0x7f });
  });
  test("Pain Suppression 33206: 40% all schools", () => {
    expect(MITIGATION_TABLE["33206"]).toEqual({ pct: 40, schoolMask: 0x7f });
  });
  test("Divine Shield 642: immunity = 100", () => {
    expect(MITIGATION_TABLE["642"]?.pct).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/analysis -- mitigationData`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implementation + 35-item human review fill-in**

`mitigationData.ts`:

```ts
import generated from "./mitigationGenerated.json";

export interface IMitigationEntry {
  /** Mitigation percentage, 0-100; immunity types = 100. */
  pct: number;
  /** Applicable school mask, same bit semantics as log spellSchoolId (0x7F All / 0x7E Magic only / 0x1 Physical only). */
  schoolMask: number;
}

/** Curated overrides layer (always wins): each entry notes source and override rationale. Entries unresolvable (unresolved /
 * zero hits) or incorrect in generation layer (conflicts with game facts) are fixed here. */
export const MITIGATION_OVERRIDES: Record<string, IMitigationEntry> = {
  // Entries formatted as:
  // "642": { pct: 100, schoolMask: 0x7f }, // Divine Shield: immunity, game fact; zero hits in generation layer (immunity does not use aura87)
  // ... implementer fills in per human review results ...
};

/** Whitelist entries confirmed to have no (percentage-based) mitigation attributes -- pure absorption shields / heals / special mechanics only;
 * each notes rationale. Mutually exclusive with MITIGATION_TABLE, guarded by anti-regression tests for no third state. */
export const NO_MITIGATION_IDS: ReadonlySet<string> = new Set([
  // "xxxxx", // Spell name: rationale (e.g. pure absorption shield, no percentage mitigation semantics)
]);

const gen = (
  generated as unknown as {
    entries: Record<string, IMitigationEntry>;
  }
).entries;

/** Merged table: generated base + curated overrides always win (same pattern as spellEffectData two-layer). */
export const MITIGATION_TABLE: Record<string, IMitigationEntry> = {
  ...gen,
  ...MITIGATION_OVERRIDES,
};
```

**Human Review Process (Core work of this task, do not skip)**: Go through all 35 items one by one -- compare generated values against game facts (spell tooltip semantics); decide case by case whether discrepancies/missing entries go to OVERRIDES (with comments) or NO_MITIGATION_IDS (with rationale). Produce a 35-row list into report: id / spell name / generated value / final value / source (generated|override|no-mitigation) / one-sentence rationale. **For uncertain entries, create a dedicated 'Awaiting Human Ruling' section in the report**; do not guess values -- controller will present this section to the user.
`index.ts` exports four symbols (adjacent to existing data exports).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test --workspace=packages/analysis` (full suite) + `npm run typecheck`
Expected: All green (if anchor values differ from review, update assertions per review and note rationale).

- [ ] **Step 5: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add packages/analysis
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "feat(analysis): mitigation table two-layer merge + 35-item human review curation + no third state anti-regression (#17 foundation)"
```

---

### Task 3: Corpus Sanity + Gate + Push + Ledger Reconciliation

**Files:**

- Modify: `docs/BACKLOG.md` (#17.2 foundation entry annotation)

- [ ] **Step 1: Corpus sanity (official-data discipline: official tables must also be empirically tested)**

One-off script (/tmp, delete after run): find 2-3 matches in local corpus with clear major mitigation windows (e.g., `auraEvents` where 22812/33206/871 applied->removed window >= 4s and damageIn >= 5 rows in window), calculate for each window: average damage taken per second in window vs average damage taken per second in 10s prior to window reduction ratio, check same order of magnitude against table value (+-10pp tolerance; confounding factors like absorbs/armor/target switching are unmodeled, only guarding against **systematic** extraction errors — e.g. table says 40% but empirically only drops 5%, or direction inverted). Numbers for each sampled window into report; significant discrepancy -> stop and report, do not force table values.

- [ ] **Step 2: presubmit + push**

```bash
(cd /Users/mingjianliu/code/gladlog-wt-small && npm run presubmit)
# After green:
git -C /Users/mingjianliu/code/gladlog-wt-small push
# If remote has new commits: fetch + rebase origin/main + re-run presubmit then push
```

- [ ] **Step 3: Monitor CI by headSha**

```bash
SHA=$(git -C /Users/mingjianliu/code/gladlog-wt-small rev-parse HEAD)
# Select by headSha in gh run list -> gh run watch <id> --exit-status (if empty, sleep 20 and recheck)
```

This plan is pure analysis data layer, visual baselines should not move; if frontend-qa turns red it is anomalous, report truthfully.

- [ ] **Step 4: BACKLOG Ledger Reconciliation**

Add note to `docs/BACKLOG.md` #17 2nd sub-item ("Mitigation percentage table + per-school damage breakdown"):
`✅ Table foundation (2026-07-30: MITIGATION_TABLE two-layer 35 items with no third state, spec docs/superpowers/specs/2026-07-30-mitigation-table-design.md; school coverage quantified 148/148 windows >= 90% attributable; per-school damage breakdown consumption reserved for #17 main body)`

```bash
git -C /Users/mingjianliu/code/gladlog-wt-small add docs/BACKLOG.md
git -C /Users/mingjianliu/code/gladlog-wt-small commit -m "docs: backlog #17.2 table foundation ledger reconciliation"
git -C /Users/mingjianliu/code/gladlog-wt-small push
```

- [ ] **Step 5: Report**

35-row human review list (including 'Awaiting Human Ruling' section if any), generated/override/no-mitigation three-state counts, corpus sanity numbers, CI conclusion.

---

## Self-Review Record (Run before finalization)

1. **Spec Coverage**: generation layer includes anchor verification and unresolved disk flushes (T1), two-layer merge / no third state / value range / table bounds (T2), human review 35 items + corpus sanity (T2/T3), update-wow-data registration (T1), zero consumers (no entry points throughout plan).
2. **Placeholders**: T2 OVERRIDES/NO_MITIGATION_IDS content produced by human review — this is the task itself rather than TBD, and "uncertain entries create awaiting ruling section" provides clear outlet; anchor assertions marked "pinned after human review, candidate values may be modified with documented rationale".
3. **Type Consistency**: `IMitigationEntry` T1 (IMitigationRaw isomorphic) / T2 consistent; `transformMitigation` return shape matches json artifact; four exports consumed in tests match implementation.
