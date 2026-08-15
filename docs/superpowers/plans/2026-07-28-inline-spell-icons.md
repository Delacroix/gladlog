# AI Analysis Text Inline Icons (backlog #15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In zh reply mode, render English spell/spec names in the AI generated text (finding card 3 fields + comparison explanation) as "Icon + Chinese Name", revealing the English original name on hover; in en mode, only add the icon without changing the name. Storage/prompt/audit/export remain completely unchanged.

**Architecture:** Render-layer post-processing (spec Plan A). The analysis side adds a zhCN spell name generated artifact + a lazy inverted index of "English name → id (icon set only)"; the desktop side adds a pure function scanner `renderRichText` (first-word bucketed + longest match) replacing matched segments with `<SpellInline>`/`<SpecInline>`, at 6 integration points.

**Tech Stack:** TypeScript, React, vitest, wago.tools DB2 CSV (datagen), electron-vite.

**Spec:** `docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md`

## Global Constraints

- Commits: commit directly to main, do not create branches or PRs (project convention).
- Only pre-push gate: `npm run presubmit` (= lint + typecheck + full workspace test + verify:vision + electron-vite build). **Do not** just run the desktop triad.
- Never add pipes in the gate chain (`npm run typecheck | tail` returns the exit code of tail); never `cd` in compound commands (use absolute paths or a `(cd … && …)` subshell).
- Large generated data (>1MB) must use `.json` files (vite is configured with `json.stringify`), never `.ts` object literals (due to a past 22s first-paint incident).
- renderer/preload from `src/main/*` is restricted to type-only imports (not applicable to this plan, but don't accidentally violate it).
- Visual baselines are generated single-source in CI (linux), **never run `test:visual` locally**; see Task 8 for baseline update instructions.
- `npm run typecheck` must use tsc --noEmit, never `tsc -b`.
- Time unit convention: derive output / CandidateEvent.t = relative seconds (this plan does not add new time conversions).

**Pre-verified facts** (tested during planning phase, executor does not need to re-verify):
`https://wago.tools/db2/SpellName/csv?build=12.1.0.68629&locale=zhCN` returns a zhCN CSV, untranslated entries fallback to English in the same column (tested with curl, `ID,Name_lang` columns, `17,真言术:盾`).

---

### Task 1: datagen — zhCN Spell Name Generated Artifact + Manifest Registration

**Files:**

- Modify: `packages/analysis/scripts/datagen/lib/wagoCsv.ts` (add locale parameter to fetchTable)
- Create: `packages/analysis/scripts/datagen/genSpellNamesZh.ts`
- Create: `packages/analysis/test/datagen.spellNamesZh.test.ts`
- Modify: `packages/analysis/scripts/datagen/writeManifest.ts`
- Create (Generated): `packages/analysis/src/data/spellNamesZhGenerated.json`
- Modify: `packages/analysis/src/data/datagen-manifest.json` (script generated)
- Modify: `docs/commands/update-wow-data.md` (register step 2b)

**Interfaces:**

- Consumes: `parseCsv/fetchLatestBuild/fetchTable/assertMinRows` (`lib/wagoCsv`), `writeArtifact` (`lib/emit`), `ids` key set from `spellIconsGenerated.json`, `spellNames.json` (enUS cross-reference).
- Produces: `spellNamesZhGenerated.json` = `Record<spellId, zhName>`, **containing only** entries with "icon exists and zh ≠ en (genuine translation)"; `transformSpellNamesZh(csvZh, iconIds, enMap)` pure function.

- [ ] **Step 1: Write failing transform unit test**

`packages/analysis/test/datagen.spellNamesZh.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { transformSpellNamesZh } from "../scripts/datagen/genSpellNamesZh";

describe("transformSpellNamesZh", () => {
  const csv =
    'ID,Name_lang\n740,宁静\n17,真言术:盾\n999,"Test Spell"\n25,昏迷\n';
  const iconIds = new Set(["740", "17", "999"]);
  const enMap: Record<string, string> = {
    "740": "Tranquility",
    "17": "Power Word: Shield",
    "999": "Test Spell",
    "25": "Stun",
  };

  test("retains only: icon exists and zh differs from en (genuine translation)", () => {
    expect(transformSpellNamesZh(csv, iconIds, enMap)).toEqual({
      "740": "宁静",
      "17": "真言术:盾",
    });
    // 999: zh == en (wago untranslated fallback) → discarded, runtime fallback chain falls back to English anyway;
    // 25: no icon → discarded (inverted index only indexes icon set, unused if stored).
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/analysis/test/datagen.spellNamesZh.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Add locale to fetchTable + write generator script**

Modify `fetchTable` in `lib/wagoCsv.ts` (cache key must include locale to prevent colliding with enUS cache):

```ts
export async function fetchTable(
  table: string,
  build: string,
  cacheDir?: string,
  locale?: string,
): Promise<string> {
  let cacheFile: string | undefined;
  const cacheKey = locale ? `${table}-${locale}-${build}.csv` : `${table}-${build}.csv`;
  if (cacheDir) {
    cacheFile = path.join(cacheDir, cacheKey);
    if (fs.existsSync(cacheFile)) {
      return fs.readFileSync(cacheFile, "utf8");
    }
  }

  const url =
    `https://wago.tools/db2/${table}/csv?build=${encodeURIComponent(build)}` +
    (locale ? `&locale=${encodeURIComponent(locale)}` : "");
  // …rest of function remains unchanged
```

`genSpellNamesZh.ts` (patterned after `genSpellNames.ts`):

```ts
import { readFileSync } from "fs";
import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertMinRows,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";

/** zhCN spell name table: includes only entries with icons and differing from enUS names.
 * wago untranslated entries fall back to English in the same column → equal to enMap means untranslated,
 * discarded (runtime fallback chain: current match log name > this table > English original). */
export function transformSpellNamesZh(
  csvText: string,
  iconIds: ReadonlySet<string>,
  enMap: Record<string, string>,
): Record<string, string> {
  const { rows } = parseCsv(csvText);
  const map: Record<string, string> = {};
  for (const row of rows) {
    const id = row.ID;
    const zh = row.Name_lang;
    if (!iconIds.has(id)) continue;
    if (!zh || zh === enMap[id]) continue;
    map[id] = zh;
  }
  return map;
}

export async function main(): Promise<void> {
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;
  const icons = JSON.parse(
    readFileSync(dataDir + "spellIconsGenerated.json", "utf8"),
  ) as { ids: Record<string, number> };
  const enMap = JSON.parse(
    readFileSync(dataDir + "spellNames.json", "utf8"),
  ) as Record<string, string>;

  const build = await fetchLatestBuild();
  const csv = await fetchTable(
    "SpellName",
    build,
    process.env.DATAGEN_CACHE,
    "zhCN",
  );
  const map = transformSpellNamesZh(
    csv,
    new Set(Object.keys(icons.ids)),
    enMap,
  );
  // Icon set has ~42k entries, vast majority of player spells have genuine translations;
  // dropping below 10k indicates locale parameter or filtering logic broken.
  assertMinRows(Object.keys(map), 10000, "SpellName(zhCN)");
  writeArtifact(dataDir + "spellNamesZhGenerated.json", JSON.stringify(map));
  console.log(Object.keys(map).length, build);
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genSpellNamesZh.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/analysis/test/datagen.spellNamesZh.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate real artifact + manifest**

```bash
export DATAGEN_CACHE=$(mktemp -d)
npx tsx packages/analysis/scripts/datagen/genSpellNamesZh.ts
```

Add in `writeManifest.ts` under `artifacts`:

```ts
"spellNamesZhGenerated.json": {
  entries: Object.keys(readJson("spellNamesZhGenerated.json")).length,
  bytes: statSync(dataDir + "spellNamesZhGenerated.json").size,
},
```

Then run `npx tsx packages/analysis/scripts/datagen/writeManifest.ts`, confirm manifest updated with `git diff`.

In `docs/commands/update-wow-data.md` Step 4 after `# 2. Spell names`, add:

```bash
# 2b. Spell names zhCN (inline icon display names; depends on step 6b icon table — move after 6b on full refresh)
npx tsx packages/analysis/scripts/datagen/genSpellNamesZh.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/analysis/scripts/datagen packages/analysis/test/datagen.spellNamesZh.test.ts packages/analysis/src/data/spellNamesZhGenerated.json packages/analysis/src/data/datagen-manifest.json docs/commands/update-wow-data.md
git commit -m "feat(analysis): zhCN spell names generated artifact (icon set ∩ genuine translations, #15 data layer)"
```

---

### Task 2: analysis — Runtime Modules for zh Table / Observed Set / English Name Inverted Index

**Files:**

- Modify: `packages/analysis/src/data/spellEffectData.ts` (load completion probe + snapshot getter)
- Create: `packages/analysis/src/data/spellNamesZh.ts`
- Create: `packages/analysis/src/data/observedSpellIds.ts`
- Create: `packages/analysis/src/data/spellNameLookup.ts`
- Modify: `packages/analysis/src/index.ts` (exports)
- Create: `packages/analysis/test/spellNameLookup.test.ts`

**Interfaces:**

- Consumes: `spellNamesZhGenerated.json` (Task 1), `SPELL_ICONS_GENERATED`, `ensureSpellNames`.
- Produces (exported in index.ts, consumed by Task 5):
  - `SPELL_NAMES_ZH_GENERATED: Record<string, string>`
  - `OBSERVED_SPELL_IDS: ReadonlySet<string>`
  - `englishNameIndex(): ReadonlyMap<string, readonly string[]> | null` (English name → ascending candidate ids, icon set only; returns null if spellNames not yet loaded, UI self-heals on next render per ensure contract)

- [ ] **Step 1: Write failing unit test**

`packages/analysis/test/spellNameLookup.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { ensureSpellNames } from "../src/data/spellEffectData";
import { englishNameIndex } from "../src/data/spellNameLookup";
import { SPELL_NAMES_ZH_GENERATED } from "../src/data/spellNamesZh";
import { OBSERVED_SPELL_IDS } from "../src/data/observedSpellIds";

describe("spellNameLookup", () => {
  test("English name inverted index: queryable after load, icon set only, ascending ids", async () => {
    await ensureSpellNames();
    const idx = englishNameIndex();
    expect(idx).not.toBeNull();
    // 740 Tranquility: has icon, stable name
    expect(idx!.get("Tranquility")).toContain("740");
    // id 1 "Word of Recall (OLD)" is in spellNames but not in icon set → not in index
    expect(idx!.get("Word of Recall (OLD)")).toBeUndefined();
    for (const ids of idx!.values()) {
      const nums = ids.map(Number);
      expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    }
  });

  test("zh table and observed set loading", () => {
    expect(SPELL_NAMES_ZH_GENERATED["740"]).toBe("宁静");
    expect(OBSERVED_SPELL_IDS.has("17")).toBe(true); // Power Word: Shield
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/analysis/test/spellNameLookup.test.ts`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement four module updates**

In `spellEffectData.ts`: set module-level `let spellNamesLoaded = false;` in `.then` of `spellNamesLoad`, and export:

```ts
let spellNamesLoaded = false;
const spellNamesLoad = import("./spellNames.json").then((m) => {
  spellNamesMap = (m.default ?? m) as unknown as Record<string, string>;
  spellNamesLoaded = true;
});

/** Whether spellNames has finished loading in background (gate for spellNameLookup index; avoid counting 410k keys with Object.keys). */
export const spellNamesReady = (): boolean => spellNamesLoaded;
export function getSpellNamesSnapshot(): Record<string, string> {
  return spellNamesMap;
}
```

`spellNamesZh.ts`:

```ts
import raw from "./spellNamesZhGenerated.json";

/** zhCN spell names (datagen artifact, icon set ∩ genuine translations only).
 * Missing entries = untranslated or iconless. Fallback chain: match log name > this table > English original. */
export const SPELL_NAMES_ZH_GENERATED = raw as unknown as Record<
  string,
  string
>;
```

`observedSpellIds.ts`:

```ts
import raw from "./observedSpellIdsGenerated.json";

/** Corpus observed spellIds (strings, aligned with repository id convention). */
export const OBSERVED_SPELL_IDS: ReadonlySet<string> = new Set(
  (raw as unknown as number[]).map(String),
);
```

`spellNameLookup.ts`:

```ts
import { SPELL_ICONS_GENERATED } from "./spellIconsGenerated";
import { getSpellNamesSnapshot, spellNamesReady } from "./spellEffectData";

let index: ReadonlyMap<string, readonly string[]> | null = null;

/** English spell name → candidate id list (ascending). Includes only ids with icons.
 * Returns null if spellNames 12MB table is not yet loaded — presentation path degrades gracefully. */
export function englishNameIndex(): ReadonlyMap<
  string,
  readonly string[]
> | null {
  if (index) return index;
  if (!spellNamesReady()) return null;
  const names = getSpellNamesSnapshot();
  const m = new Map<string, string[]>();
  for (const id in SPELL_ICONS_GENERATED) {
    const n = names[id];
    if (!n) continue;
    const arr = m.get(n);
    if (arr) arr.push(id);
    else m.set(n, [id]);
  }
  for (const arr of m.values()) arr.sort((a, b) => Number(a) - Number(b));
  index = m;
  return index;
}
```

Add exports in `index.ts`:

```ts
export { SPELL_NAMES_ZH_GENERATED } from "./data/spellNamesZh";
export { OBSERVED_SPELL_IDS } from "./data/observedSpellIds";
export { englishNameIndex } from "./data/spellNameLookup";
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/analysis/test/spellNameLookup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analysis/src packages/analysis/test/spellNameLookup.test.ts
git commit -m "feat(analysis): English name inverted index (icon set) + zh table / observed set exports (#15)"
```

---

### Task 3: desktop — Spec Names Shared Table (`SPEC_NAMES_ZH` Lifted + English Phrases → specId)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/data/specNames.ts`
- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx` (remove local table, import shared table)
- Create: `packages/desktop/src/renderer/src/report/data/specNames.test.ts`

**Interfaces:**

- Consumes: `SPEC_SLUGS` (`report/data/gameConstants.ts`, specId → slug).
- Produces:
  - `SPEC_NAMES_ZH: Record<string, string>` (41 entries, "Restoration Druid" → "恢复德鲁伊"; migrated from ProComparisonVerified table)
  - `SPEC_ID_BY_EN: Record<string, number>` ("Restoration Druid" → 105; key set matches SPEC_NAMES_ZH)

- [ ] **Step 1: Write failing consistency unit test**

`specNames.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "./specNames";
import { SPEC_SLUGS } from "./gameConstants";

describe("specNames consistency", () => {
  test("both tables share identical key sets, all specIds have icon slugs", () => {
    expect(Object.keys(SPEC_ID_BY_EN).sort()).toEqual(
      Object.keys(SPEC_NAMES_ZH).sort(),
    );
    for (const [en, id] of Object.entries(SPEC_ID_BY_EN)) {
      expect(SPEC_SLUGS[id], `${en} → ${id}`).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/data/specNames.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Create shared table + update imports**

`specNames.ts`: Move `SPEC_NAMES_ZH` from `ProComparisonVerified.tsx` (41 entries), add `SPEC_ID_BY_EN`:

```ts
/** English spec phrase → specId (keys for SPEC_SLUGS). Must match key set of SPEC_NAMES_ZH. */
export const SPEC_ID_BY_EN: Record<string, number> = {
  "Blood Death Knight": 250,
  "Frost Death Knight": 251,
  "Unholy Death Knight": 252,
  // …remaining entries
};
```

In `ProComparisonVerified.tsx`: remove local `SPEC_NAMES_ZH`, add `import { SPEC_NAMES_ZH } from "../data/specNames";`.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/data/specNames.test.ts && npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/data packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx
git commit -m "refactor(desktop): lift SPEC_NAMES_ZH to shared table + English phrases -> specId (#15)"
```

---

### Task 4: desktop — `SpellInline`/`SpecInline` Components + `ChipIcon` Lifted + CSS

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/SpellInline.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx` (remove local ChipIcon, import shared)
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Create: `packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx`

**Interfaces:**

- Consumes: `SpellIcon` (IPC + disk cache), `SPELL_ICONS_GENERATED`, `specIconUrl` (`report/data/gameConstants`).
- Produces:
  - `SpellInline({ spellId, display, original }: { spellId: string; display: string; original: string })` — Icon + display text, `title=original` (reconciliation anchor).
  - `SpecInline({ specId, display, original }: { specId: number; display: string; original: string })` — Spec icon (CDN, `specIconUrl`) + display.
  - `ChipIcon({ spellId }: { spellId?: string })` — Migrated from FindingsList.

- [ ] **Step 1: Write failing component tests**

`SpellInline.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SpecInline, SpellInline } from "./SpellInline";

describe("SpellInline", () => {
  test("title=original English name, body=display, renders icon fallback when icon exists", () => {
    const { container } = render(
      <SpellInline spellId="740" display="宁静" original="Tranquility" />,
    );
    const el = container.querySelector(".rpt-inline-spell")!;
    expect(el.getAttribute("title")).toBe("Tranquility");
    expect(el.textContent).toContain("宁静");
    expect(container.querySelector(".rpt-spellicon-fallback")).not.toBeNull();
  });

  test("iconless entries: renders text only without icon fallback", () => {
    const { container } = render(
      <SpellInline
        spellId="1"
        display="召回"
        original="Word of Recall (OLD)"
      />,
    );
    expect(container.querySelector(".rpt-spellicon-fallback")).toBeNull();
    expect(container.textContent).toBe("召回");
  });

  test("SpecInline renders spec icon img + display", () => {
    const { container } = render(
      <SpecInline
        specId={105}
        display="恢复德鲁伊"
        original="Restoration Druid"
      />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("druid_restoration");
    expect(container.textContent).toContain("恢复德鲁伊");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement components + move ChipIcon + CSS**

`SpellInline.tsx`:

```tsx
import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";

import { specIconUrl } from "../data/gameConstants";
import { SpellIcon } from "./SpellIcon";

/** AI body text inline spell: icon (rendered only if listed) + display name; title=original English name —
 * replacement is presentation-only, hover provides reconciliation with storage/audit texts. */
export function SpellInline({
  spellId,
  display,
  original,
}: {
  spellId: string;
  display: string;
  original: string;
}) {
  const icon = SPELL_ICONS_GENERATED[spellId];
  return (
    <span className="rpt-inline-spell" title={original}>
      {icon ? <SpellIcon icon={icon} label="" size={14} /> : null}
      {display}
    </span>
  );
}

/** AI body text inline spec: CDN icon + display name. */
export function SpecInline({
  specId,
  display,
  original,
}: {
  specId: number;
  display: string;
  original: string;
}) {
  const url = specIconUrl(specId);
  return (
    <span className="rpt-inline-spell" title={original}>
      {url ? (
        <img
          src={url}
          alt=""
          width={14}
          height={14}
          className="rpt-inline-spec-img"
        />
      ) : null}
      {display}
    </span>
  );
}

export function ChipIcon({ spellId }: { spellId?: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  if (!icon) return null;
  return <SpellIcon icon={icon} label="" size={14} />;
}
```

In `styles.css`:

```css
/* AI text inline spells/specs (#15): baseline alignment with text */
.rpt-inline-spell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  vertical-align: -2px;
}
.rpt-inline-spell .rpt-spellicon,
.rpt-inline-spell .rpt-inline-spec-img {
  border-radius: 2px;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/SpellInline.test.tsx && npx vitest run packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`
Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components packages/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): SpellInline/SpecInline inline components + lift ChipIcon (#15)"
```

---

### Task 5: desktop — `inlineRich` Scanner (Pure Function, Injectable Dependencies)

**Files:**

- Create: `packages/desktop/src/renderer/src/report/derive/inlineRich.tsx`
- Create: `packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`

**Interfaces:**

- Consumes: `englishNameIndex/OBSERVED_SPELL_IDS/SPELL_NAMES_ZH_GENERATED` (Task 2), `SPEC_ID_BY_EN/SPEC_NAMES_ZH` (Task 3), `SpellInline/SpecInline` (Task 4), `ReportSource` (`derive/types`).
- Produces:
  - `makeRichText(source: ReportSource, lang: "zh" | "en", deps?: RichDeps): (text?: string | null) => ReactNode`
  - `buildMatchSpellIndex(source: ReportSource): { ids: ReadonlySet<string>; logNames: ReadonlyMap<string, string> }`
  - `RichDeps` (`{ nameIndex, zhNames, observed, specByName, specZh }` for test injection)

- [ ] **Step 1: Write failing unit tests**

Create `inlineRich.test.tsx` (all tests use injected dependencies, avoiding 12MB table):

```tsx
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ReportSource } from "./types";
import {
  buildMatchSpellIndex,
  makeRichText,
  type RichDeps,
} from "./inlineRich";

const deps: RichDeps = {
  nameIndex: new Map<string, readonly string[]>([
    ["Tranquility", ["740"]],
    ["Ice Block", ["45438"]],
    ["Block", ["107"]],
    ["Power Word: Shield", ["17"]],
    ["Chaos Bolt", ["116858", "999116"]],
  ]),
  zhNames: { "740": "宁静", "45438": "寒冰屏障", "17": "真言术:盾" },
  observed: new Set(["116858"]),
  specByName: { "Restoration Druid": 105 },
  specZh: { "Restoration Druid": "恢复德鲁伊" },
};
const emptySource = { units: {} } as unknown as ReportSource;
const rich = makeRichText(emptySource, "zh", deps);

const textOf = (node: React.ReactNode): string =>
  render(<span>{node}</span>).container.textContent ?? "";

describe("renderRichText (via makeRichText)", () => {
  test("CJK adjacent match: replaces English name with Chinese name", () => {
    expect(textOf(rich("你的Tranquility没用"))).toBe("你的宁静没用");
  });

  test("longest match: Ice Block is not intercepted by Block", () => {
    const { container } = render(<span>{rich("Cast Ice Block now")}</span>);
    expect(container.textContent).toContain("寒冰屏障");
    expect(container.textContent).not.toContain("Block");
  });

  test("multi-word name with colon matches as whole phrase", () => {
    expect(textOf(rich("Power Word: Shield absorbed"))).toContain("真言术:盾");
  });

  test("no intra-word false positives: Blockade does not trigger Block", () => {
    expect(textOf(rich("The Blockade held"))).toBe("The Blockade held");
  });

  test("disambiguation: match id takes precedence over observed", () => {
    const src = {
      units: {
        a: { casts: [{ spellId: 999116, spellName: "混沌之箭" }] },
      },
    } as unknown as ReportSource;
    const r = makeRichText(src, "zh", deps);
    expect(textOf(r("Chaos Bolt hit"))).toContain("混沌之箭");
  });

  test("disambiguation: no match id → observed (116858), fallback to lowest id", () => {
    expect(textOf(rich("Chaos Bolt hit"))).toContain("Chaos Bolt");
  });

  test("en mode: does not change names (component handles icons, text unchanged)", () => {
    const r = makeRichText(emptySource, "en", deps);
    expect(textOf(r("Tranquility was available"))).toBe(
      "Tranquility was available",
    );
  });

  test("spec phrases: translates in zh mode", () => {
    expect(textOf(rich("Restoration Druid died"))).toContain("恢复德鲁伊");
  });

  test("unmatched string returned as-is (=== short-circuit)", () => {
    const t = "没有任何英文技能名";
    expect(rich(t)).toBe(t);
  });

  test("nameIndex not ready (null) → returns full text unchanged", () => {
    const r = makeRichText(emptySource, "zh", { ...deps, nameIndex: null });
    expect(r("Tranquility")).toBe("Tranquility");
  });

  test("null/undefined input passed through", () => {
    expect(rich(undefined)).toBeNull();
    expect(rich("")).toBe("");
  });
});

describe("buildMatchSpellIndex", () => {
  test("defensively handles missing event arrays across 5 categories", () => {
    const src = {
      units: {
        a: { casts: [{ spellId: 740, spellName: "宁静" }] },
        b: {},
      },
    } as unknown as ReportSource;
    const idx = buildMatchSpellIndex(src);
    expect(idx.ids.has("740")).toBe(true);
    expect(idx.logNames.get("740")).toBe("宁静");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement scanner**

Create `inlineRich.tsx`:

```tsx
import type { ReactNode } from "react";

import {
  OBSERVED_SPELL_IDS,
  SPELL_NAMES_ZH_GENERATED,
  englishNameIndex,
} from "@gladlog/analysis";

import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "../data/specNames";
import { SpecInline, SpellInline } from "../components/SpellInline";
import type { ReportSource } from "./types";

export interface RichDeps {
  nameIndex: ReadonlyMap<string, readonly string[]> | null;
  zhNames: Record<string, string>;
  observed: ReadonlySet<string>;
  specByName: Record<string, number>;
  specZh: Record<string, string>;
}

const defaultDeps = (): RichDeps => ({
  nameIndex: englishNameIndex(),
  zhNames: SPELL_NAMES_ZH_GENERATED,
  observed: OBSERVED_SPELL_IDS,
  specByName: SPEC_ID_BY_EN,
  specZh: SPEC_NAMES_ZH,
});

type Entry =
  | { name: string; kind: "spell"; ids: readonly string[] }
  | { name: string; kind: "spec"; specId: number };

const ASCII = /[A-Za-z]/;
const firstToken = (s: string): string => /^[A-Za-z']+/.exec(s)?.[0] ?? "";

let bucketCache: {
  idx: RichDeps["nameIndex"];
  map: Map<string, Entry[]>;
} | null = null;

function entryBuckets(deps: RichDeps): Map<string, Entry[]> | null {
  if (!deps.nameIndex) return null;
  if (bucketCache && bucketCache.idx === deps.nameIndex) return bucketCache.map;
  const m = new Map<string, Entry[]>();
  const add = (e: Entry) => {
    const k = firstToken(e.name);
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  };
  for (const [name, ids] of deps.nameIndex) add({ name, kind: "spell", ids });
  for (const [name, specId] of Object.entries(deps.specByName))
    add({ name, kind: "spec", specId });
  for (const arr of m.values())
    arr.sort((a, b) => b.name.length - a.name.length);
  bucketCache = { idx: deps.nameIndex, map: m };
  return m;
}

export interface MatchSpellIndex {
  ids: ReadonlySet<string>;
  logNames: ReadonlyMap<string, string>;
}

export function buildMatchSpellIndex(source: ReportSource): MatchSpellIndex {
  const ids = new Set<string>();
  const logNames = new Map<string, string>();
  type Ev = { spellId?: number | string; spellName?: string };
  type UnitLike = Partial<
    Record<"casts" | "petCasts" | "damageOut" | "healOut" | "auraEvents", Ev[]>
  >;
  const eat = (evs?: Ev[]) => {
    for (const e of evs ?? []) {
      if (e.spellId == null) continue;
      const id = String(e.spellId);
      ids.add(id);
      if (e.spellName && !logNames.has(id)) logNames.set(id, e.spellName);
    }
  };
  for (const u of Object.values(source.units ?? {}) as UnitLike[]) {
    eat(u.casts);
    eat(u.petCasts);
    eat(u.damageOut);
    eat(u.healOut);
    eat(u.auraEvents);
  }
  return { ids, logNames };
}

interface Ctx {
  match: MatchSpellIndex;
  lang: "zh" | "en";
  deps: RichDeps;
}

function renderEntry(
  e: Entry,
  original: string,
  ctx: Ctx,
  key: number,
): ReactNode {
  if (e.kind === "spec") {
    const display =
      ctx.lang === "zh" ? (ctx.deps.specZh[e.name] ?? original) : original;
    return (
      <SpecInline
        key={key}
        specId={e.specId}
        display={display}
        original={original}
      />
    );
  }
  const id =
    e.ids.find((x) => ctx.match.ids.has(x)) ??
    e.ids.find((x) => ctx.deps.observed.has(x)) ??
    e.ids[0]!;
  const display =
    ctx.lang === "zh"
      ? (ctx.match.logNames.get(id) ?? ctx.deps.zhNames[id] ?? original)
      : original;
  return (
    <SpellInline key={key} spellId={id} display={display} original={original} />
  );
}

function renderRichText(text: string, ctx: Ctx): ReactNode {
  const buckets = entryBuckets(ctx.deps);
  if (!buckets) return text;
  const out: ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  let key = 0;
  while (i < text.length) {
    if (!ASCII.test(text[i]!) || (i > 0 && ASCII.test(text[i - 1]!))) {
      i++;
      continue;
    }
    const token = firstToken(text.slice(i, i + 48));
    let hit: Entry | null = null;
    for (const e of buckets.get(token) ?? []) {
      if (!text.startsWith(e.name, i)) continue;
      const after = text[i + e.name.length];
      if (after === undefined || !ASCII.test(after)) {
        hit = e;
        break;
      }
    }
    if (!hit) {
      i += token.length || 1;
      continue;
    }
    if (plainStart < i) out.push(text.slice(plainStart, i));
    out.push(renderEntry(hit, text.slice(i, i + hit.name.length), ctx, key++));
    i += hit.name.length;
    plainStart = i;
  }
  if (out.length === 0) return text;
  if (plainStart < text.length) out.push(text.slice(plainStart));
  return out;
}

export function makeRichText(
  source: ReportSource,
  lang: "zh" | "en",
  deps: RichDeps = defaultDeps(),
): (text?: string | null) => ReactNode {
  const match = buildMatchSpellIndex(source);
  return (text) =>
    text ? renderRichText(text, { match, lang, deps }) : (text ?? null);
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/derive/inlineRich.tsx packages/desktop/src/renderer/src/report/derive/inlineRich.test.tsx
git commit -m "feat(desktop): inlineRich rich text scanner (first-word bucketed + longest match, #15 core)"
```

---

### Task 6: Wiring — `FindingsList` / `KeyMomentAxis` / `StructuredAnalysisPanel` (Including Chips Icon Backfill)

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/KeyMomentAxis.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/StructuredAnalysisPanel.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`

**Interfaces:**

- Consumes: `makeRichText` (Task 5), `ChipIcon` (Task 4).
- Produces: `FindingsList` / `KeyMomentAxis` add optional prop `rich?: (text?: string | null) => ReactNode`.

- [ ] **Step 1: Write failing component test**

In `FindingsList.test.tsx`:

```tsx
test("rich prop: spell names in explanation render as SpellInline (title=English)", () => {
  const deps: RichDeps = {
    nameIndex: new Map([["Tranquility", ["740"] as readonly string[]]]),
    zhNames: { "740": "宁静" },
    observed: new Set<string>(),
    specByName: {},
    specZh: {},
  };
  const rich = makeRichText(
    { units: {} } as unknown as ReportSource,
    "zh",
    deps,
  );
  const { container } = render(
    <FindingsList
      findings={[
        {
          eventIds: [],
          severity: "high",
          category: "cooldown-usage",
          title: "Tranquility unused",
          explanation: "Tranquility was never pressed all match.",
        },
      ]}
      onSelect={() => {}}
      rich={rich}
    />,
  );
  const inline = container.querySelectorAll('[title="Tranquility"]');
  expect(inline.length).toBe(2);
  expect(container.textContent).toContain("宁静");
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/FindingsList.test.tsx`
Expected: FAIL (no rich prop).

- [ ] **Step 3: Wire three components**

In `FindingsList.tsx`:
- Add `rich?: (text?: string | null) => ReactNode;` to props.
- Wrap 3 text fields: `{rich ? rich(f.title) : f.title}`, `{rich ? rich(f.explanation) : f.explanation}`, `{rich ? rich(f.deepDive.text) : f.deepDive.text}`.

In `KeyMomentAxis.tsx`:
- Add `rich` prop, wrap 3 text fields similarly.
- Add `<ChipIcon spellId={c.spellId} />` in chip button.

In `StructuredAnalysisPanel.tsx`:
- Import `makeRichText`, add `rich` hook memoization:

```tsx
const rich = useMemo(
  () => makeRichText(source, lang ?? "zh"),
  [source, lang, dataReady],
);
```

- Pass `rich={rich}` to all 4 render points (two `<KeyMomentAxis …>`, two `<FindingsList …>`).

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components
git commit -m "feat(desktop): wire inline icons to finding card 3 fields, add icons to KeyMomentAxis chips (#15)"
```

---

### Task 7: Wiring — `ProComparisonVerified` Comparison Explanation

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`

**Interfaces:**

- Consumes: `makeRichText` (Task 5).

- [ ] **Step 1: Write failing test**

In `ProComparisonVerified.test.tsx`:

```tsx
test("comparison explanation rich rendering: English spell names output inline nodes", async () => {
  await ensureAnalysisData();
  expect(container.querySelector('[title="Tranquility"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
import { makeRichText } from "../derive/inlineRich";

const rich = useMemo(() => makeRichText(source, lang), [source, lang]);
```

Render `result.report` as `<p style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rich(result.report)}</p>`.

- [ ] **Step 4: Run test to confirm pass**

Run: `npx vitest run packages/desktop/src/renderer/src/report/components/ProComparisonVerified.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components
git commit -m "feat(desktop): wire inline icons to comparison explanation (#15 wrap-up)"
```

---

### Task 8: Gates, Push, CI, Visual Baselines, Backlog Ledger Wrap-up

**Files:**

- Modify: `docs/BACKLOG.md`
- Modify: `packages/desktop/qa/__screenshots__/scenes.spec.ts/*.png` (CI generated and human reviewed)

- [ ] **Step 1: Full Gate**

```bash
npm run presubmit
```

Expected: All green.

- [ ] **Step 2: Backlog ledger wrap-up + push**

Update `docs/BACKLOG.md` #15 title line:
`## 15. AI Analysis text inline icons (spell/spec names -> icon + zh name) ✅ (2026-07-28 Landed: render layer post-processing inlineRich + zhCN dictionary artifact; spec docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md)`

```bash
git add docs/BACKLOG.md
git commit -m "docs: backlog #15 ledger wrap-up"
git push
```

- [ ] **Step 3: Monitor CI**

```bash
SHA=$(git rev-parse HEAD)
RUN=$(gh run list --workflow test.yml --json databaseId,headSha --limit 5 -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)
gh run watch "$RUN" --exit-status
```

- [ ] **Step 4: Visual Baseline Regeneration (only when report scene pixels change; CI single source)**

```bash
gh workflow run visual-baseline.yml --ref main
RUN=$(gh run list --workflow visual-baseline.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run download $RUN -n visual-baselines -D /tmp/bl
for f in /tmp/bl/scenes.spec.ts/*.png; do n=$(basename $f); cmp -s "$f" packages/desktop/qa/__screenshots__/scenes.spec.ts/$n || echo "DIFF $n"; done
```

Review diffs, copy over, commit and push.

- [ ] **Step 5: Report Acceptance Metrics**

---

## Self-Review Records (Run Before Finalization)

1. **Spec Coverage**: Data layer (Tasks 1/2), inverted index + resolution (2/5), SPEC lifting (3), components (4), scanner + en mode + fallback chain (5), 6 integration points + chips (6/7), visual baselines / presubmit / ledger wrap-up (8).
2. **Placeholders**: Task 3 38 specIds noted to be filled matching `SPEC_SLUGS` from `gameConstants.ts` single source of truth; all other tasks fully specified without placeholders.
3. **Type Consistency**: `rich?: (text?: string | null) => ReactNode` signature consistent across 5/6/7; `RichDeps`/`MatchSpellIndex`/`Entry` defined in single location; `ChipIcon` uniquely sourced from `SpellInline.tsx`.
