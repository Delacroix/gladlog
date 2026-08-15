# Subproject 5: Game Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** wago.tools DB2 CSV + raidbots talent JSON -> `packages/analysis/scripts/datagen/` generator family, artifacts in-place replace placeholder / manual data (zero consumer changes); UI wires named talents + icons (disk caching).

**Architecture:** Pure transformation functions (offline testing with fixture CSV slices) separated from network fetches; emit layer shape assertions prevent writing invalid artifacts to disk; real fetches only occur during batch execution steps (executed by controller). 4 generators written clean-room (do not read upstream source; requirements derived solely from gladlog existing shapes + real column names pinned in this plan), 2 proprietary items ported and delivered by controller. Spec: `docs/specs/2026-07-11-game-data-pipeline-design.md`.

**Tech Stack:** TypeScript ESM, vitest, tsx CLI, node fetch (built-in), fs-extra.

## Global Constraints

- **Compliance (Hard)**: Nobody (including controller) reads source code of the 4 upstream generators from the old fork (`generateSpellIdLists` / `generateSpellsData` / `generateSpellClassMap` / `update_statics`); 2 proprietary items (`generateTrinketItemIds` CLEAN, `generateTalentModifiers` NEEDS_SCRUB) delivered via `/tmp` staging after controller verification and audit; implementer does not access old fork.
- **Shape Locking**: Artifacts must match existing consumer interface shapes —— `IMinedSpell` (`packages/analysis/src/data/spellEffectData.ts`), `talentIdMap.json` (`RaidBotsTalentData` in `talentStrings.ts`), `trinketItemIds.json`, `talentModifiers.json`. Consumer source code must not be modified except where explicitly named in this plan.
- **Real Column Names (2026-07-11 probe, build 12.1.0.68629)**: `SpellName=ID,Name_lang`; `SpellCooldowns=ID,DifficultyID,CategoryRecoveryTime,RecoveryTime,…,SpellID`; `SpellDuration=ID,Duration,MaxDuration,…`; `SpellCategories=ID,DifficultyID,Category,DefenseType,DiminishType,DispelType,Mechanic,…,ChargeCategory,SpellID`; `SpellMisc contains DurationIndex,PvPDurationIndex,SpellIconFileDataID,SpellID,DifficultyID`; `SpellCategory=ID,Name_lang,Flags,UsesPerWeek,MaxCharges,ChargeRecoveryTime,TypeMask`; `PvpTalent contains SpellID`; `SkillLineAbility contains Spell,ClassMask`.
- **dispelType Enum (wowdev.wiki, pinned golden)**: `DispelType 1=Magic 2=Curse 3=Disease 4=Poison; rest -> undispellable (undefined)`.
- **PvP Duration Priority**: When `SpellMisc.PvPDurationIndex !== 0`, use it to look up `SpellDuration`, otherwise `DurationIndex`; `SPELL_EFFECT_OVERRIDES` remains the final override layer.
- Time units: DB2 milliseconds -> `IMinedSpell` seconds (divide by 1000).
- Network failure / CSV headers not matching expectations -> non-zero exit with zero disk writes; fixture tests fully offline; real batch runs = controller steps.
- ESM, TS strict, vitest, tests in `packages/analysis/test/datagen/`; root whole-repo test green = regression gate for each data replacement; TDD, one commit per task.

## Extraction List (Controller only)

```
Old packages/tools/src/generateTrinketItemIds.ts  (CLEAN)      -> Delivered via /tmp -> scripts/datagen/genTrinketItemIds.ts
Old packages/tools/src/generateTalentModifiers.ts (NEEDS_SCRUB) -> Scrubbed per audit lines and delivered via /tmp by controller -> scripts/datagen/genTalentModifiers.ts
Old packages/tools/src/customTalentModifiers.ts   (CLEAN)      -> Delivered together if imported by above item
Old docs/commands/update-wow-data.md              (CLEAN)      -> Rewritten by controller -> docs/commands/update-wow-data.md
Forbidden to read: generateSpellIdLists.ts / generateSpellsData.ts / generateSpellClassMap.ts / scripts/update_statics.js (upstream)
```

---

### Task 1: datagen Common Foundation Layer (wagoCsv + emit)

**Files:** Create `packages/analysis/scripts/datagen/lib/wagoCsv.ts`, `lib/emit.ts`, `packages/analysis/test/datagen/lib.test.ts`, fixture directory `packages/analysis/test/datagen/fixtures/` (place `mini.csv` for this task first)

**Interfaces:** Produces `parseCsv(text: string): { header: string[]; rows: Record<string, string>[] }` (RFC4180 quotes / embedded commas / embedded newlines correctly handled); `fetchLatestBuild(): Promise<string>` (GET `https://wago.tools/api/builds?branch=retail&product=wow`, take highest version); `fetchTable(table: string, build: string, cacheDir?: string): Promise<string>` (GET `https://wago.tools/db2/<table>/csv?build=<build>`, reads directly on cacheDir hit); `assertMinRows(rows, n, what)`, `assertColumns(header, required: string[], table)` (throws on mismatch); `writeArtifact(path, content: string)`.

- [ ] Step 1 (Contract): `lib.test.ts` — parseCsv three cases: `a,b\n1,"x,y"\n` -> `rows[0].b === "x,y"`; newlines inside quotes; empty file -> `rows []`. `assertColumns` missing column throws and message includes table name and missing column name. `assertMinRows` throws when insufficient.
- [ ] Step 2: Run tests FAIL -> Implement both libs -> PASS + typecheck.
- [ ] Step 3: Commit `feat(datagen): wago csv + emit foundations`.

---

### Task 2: fetchTalents (raidbots -> talentIdMap.json) + Activate Named Talent Decoding

**Files:** Create `scripts/datagen/fetchTalents.ts`; Test `test/datagen/talents.test.ts`; Modify (data) `src/data/talentIdMap.json`

**Interfaces:** Produces `validateTalentData(data: unknown): asserts` —— array, length >= 13×3-ε (>= 30 spec objects), each spec has `classNodes/specNodes` array, sampled entry has `spellId:number` + `name:string` + `icon:string`; CLI: fetch `https://www.raidbots.com/static/data/live/talents.json` -> validate -> write as-is (2 spaces indentation) to `src/data/talentIdMap.json`.

- [ ] Step 1 (Contract): fixture `fixtures/mini-talents.json` (constructed by controller: minimal valid structure with 2 specs) -> validate passes and writes to disk; variant missing classNodes -> throws with zero writes.
- [ ] Step 2: Implement -> tests + typecheck green.
- [ ] Step 3 (Controller, real batch run): `npx tsx packages/analysis/scripts/datagen/fetchTalents.ts` -> real talentIdMap.json written to disk; `npm test -w @gladlog/analysis` all green (talentStrings/talents.ts receives real data for the first time — if decoding assertions expose shape drift, report as BLOCKED for controller ruling).
- [ ] Step 4: Commit `feat(datagen): raidbots talent fetch + real talentIdMap (activates named-talent decoding)`.

---

### Task 3: genSpellNames (SpellName.csv -> spellNames.json)

**Files:** Create `scripts/datagen/genSpellNames.ts`; Test `test/datagen/spellNames.test.ts`; Modify (data) `src/data/spellNames.json`

**Interfaces:** Produces `transformSpellNames(csvText: string): Record<string, string>` (ID->Name_lang, full unfiltered); CLI: fetchTable("SpellName") -> transform -> assertMinRows(>= 100000) -> write minified single-line JSON to disk; cannot add comments to header (JSON) —— record build version in Task 7's `datagen-manifest.json`.

- [ ] Step 1 (Contract): fixture `fixtures/SpellName.mini.csv` (real header + 10 rows, including quoted names with commas) -> transform golden; row count assertion parameterized with small threshold (`assertMinRows(rows, min)` passes 100000 from CLI, 5 from tests).
- [ ] Step 2: Implement -> green.
- [ ] Step 3 (Controller): Real batch run -> replace with new spellNames.json (minified); `ls -la` compare size and record; repo-wide tests green (regression gate).
- [ ] Step 4: Commit `feat(datagen): spell names regenerated from wago (enUS, minified)`.

---

### Task 4: genSpellEffects (Candidate Set Mining -> Generated Base Layer)

**Files:** Create `scripts/datagen/genSpellEffects.ts`, `scripts/datagen/lib/candidates.ts`; Test `test/datagen/spellEffects.test.ts`; Create (data) `src/data/spellEffectGenerated.ts`

**Interfaces:**

- `collectCandidateIds(): Set<string>` —— Union of: `SPELL_CATEGORIES` keys, `classMetadata` all abilities spellId, `spellIdLists` three tables, `spellClassMap.diminishingReturns` all categories, `SPELL_EFFECT_OVERRIDES` keys, talentIdMap all entries `spellId` (`type === "active"` prioritized but collecting all), PvpTalent.csv `SpellID` column.
- `mineSpellEffects(csv: { spellMisc, spellDuration, spellCooldowns, spellCategories, spellCategory, spellName }, candidates: Set<string>): Record<string, IMinedSpell>` —— For each candidate id: name <- SpellName; duration <- SpellMisc (DifficultyID=0 rows) `PvPDurationIndex || DurationIndex` -> SpellDuration.Duration (ms->s; 0/missing -> undefined); cooldownSeconds <- SpellCooldowns (DifficultyID=0) `max(RecoveryTime, CategoryRecoveryTime)` (0 -> undefined); charges <- SpellCategories.ChargeCategory -> SpellCategory `{charges: MaxCharges, chargeCooldownSeconds: ChargeRecoveryTime/1000}` (MaxCharges 0 -> undefined); dispelType <- SpellCategories.DispelType enum mapping (1..4, rest undefined). Candidates matching no fields still emit `{spellId, name}` (skip if name is also missing).
- CLI: Real fetch 6 tables -> mine -> `writeArtifact` generates `src/data/spellEffectGenerated.ts`: `export const SPELL_EFFECTS_GENERATED: Record<string, IMinedSpell> = {…}` (header comment: generatedAt/build/candidateCount/hitCount).

- [ ] Step 1 (Controller): Create 6 fixture slices (real headers; row coverage: Polymorph 118 -> DispelType 1; Curse of Tongues 1714 -> DispelType 2; one CC with PvPDurationIndex !== 0; one with ChargeCategory -> MaxCharges 2; one pure CD ability). Write to `fixtures/*.mini.csv`.
- [ ] Step 2 (Contract): goldens —— `mine(...)["118"].dispelType === "Magic"`; `["1714"].dispelType === "Curse"`; PvP duration rows select seconds corresponding to PvPDurationIndex; charges case `{charges: 2, chargeCooldownSeconds: 20}`; pure CD case `cooldownSeconds` correct and without duration; candidate set function unions SpellID from mock PvpTalent slice.
- [ ] Step 3: Implement -> green.
- [ ] Step 4 (Controller): Real batch run (watch SpellMisc size when downloading 6 tables, use cacheDir) -> write artifacts to disk; `head` spot-check 3 known abilities against wowhead facts; repo-wide tests green.
- [ ] Step 5: Commit `feat(datagen): spell effects miner (PvP-duration-aware) + generated base layer`.

---

### Task 5: Two-layer Merge Wiring (generated Base + overrides)

**Files:** Modify `src/data/spellEffectData.ts`; Test `test/datagen/spellEffectMerge.test.ts`

**Interfaces:** `spellEffectData` becomes `{...SPELL_EFFECTS_GENERATED, ...SPELL_EFFECT_OVERRIDES}`; exported interface surface (`spellEffectData`, `getEnglishSpellName`, `IMinedSpell`) unchanged.

- [ ] Step 1 (Contract): Same ID coexisting in both layers -> overrides value wins (take a real overlapping ID to assert; if no overlap, use unit test constructed inside test for merge function semantics + assert all keys in overrides are preserved verbatim in merged result within real data).
- [ ] Step 2: Implement -> `npm test --workspaces` all green (4a calibration assertions = regression gate; any discrepancy resolved at override layer and recorded).
- [ ] Step 3: Commit `feat(analysis): two-layer spell effect data (generated base, curated overrides win)`.

---

### Task 6: Proprietary Generator Porting (trinket + talentModifiers)

**Files:** Create `scripts/datagen/genTrinketItemIds.ts`, `scripts/datagen/genTalentModifiers.ts` (+ `scripts/datagen/customTalentModifiers.ts` if dependent); Test `test/datagen/ownGenerators.test.ts`; Modify (data) `src/data/trinketItemIds.json`, `src/data/talentModifiers.json`

- [ ] Step 1 (Controller): CLEAN / scrub audit -> 3 items delivered via /tmp; inform implementer of rewriting rules (paths: output to src/data/; fetch: swap to lib/wagoCsv fetchTable; zero logic changes otherwise).
- [ ] Step 2 (Contract): trinket —— fixture ItemSparse slice (containing 1 row Sigil of Adaptation, 1 row Relentless, 1 row unrelated) -> artifact correctly buckets both ID categories; talentModifiers —— using Task 2 mini-talents + Task 4 mini spellEffects emits non-empty result matching current top-level shape of talentModifiers.json.
- [ ] Step 3: Implement (mechanical refactor) -> green.
- [ ] Step 4 (Controller): Real batch run -> replace two JSONs -> repo-wide green.
- [ ] Step 5: Commit `feat(datagen): own generators ported (trinkets, talent modifiers) + regenerated artifacts`.

---

### Task 7: genSpellClassMap + validateCatalogs + datagen manifest

**Files:** Create `scripts/datagen/genSpellClassMap.ts`, `scripts/datagen/validateCatalogs.ts`; Test `test/datagen/classMapValidate.test.ts`; Create (data) `src/data/spellClassMapGenerated.ts`, `src/data/datagen-manifest.json`

**Interfaces:**

- `classesForSpell(skillLineAbilityRows, spellId): CombatUnitClass[]` —— ClassMask bit decoding (bit n = classId n+1, using parser-compat CombatUnitClass ordering); artifact `SPELL_TO_CLASSES: Record<string, number[]>` (only contains IDs within candidate set, avoiding gigantic table).
- `validateCatalogs(spellNameRows, catalogs): { missing: {catalog, id}[]; renamed: [] }` —— Curated catalogs (spellCategories/classSpells/spellIdLists/drCategories/overrides) every ID must exist in SpellName; non-zero exit on missing and prints list.
- `datagen-manifest.json`: `{ build, generatedAt, artifacts: {file: lineCount/entryCount} }` (each real batch CLI appends its own entry).

- [ ] Step 1 (Contract): ClassMask golden (mask 16397 -> expected class array, assert bitwise expansion); validateCatalogs against fixture SpellName slice + catalog with one fake ID -> hits missing.
- [ ] Step 2: Implement -> green.
- [ ] Step 3 (Controller): Real batch run; run validateCatalogs against all real curated catalogs —— **if output missing list is non-empty, manually adjudicate item-by-item and fix catalogs** (record in ledger); repo-wide green.
- [ ] Step 4: Commit `feat(datagen): spell-class map, catalog validation, datagen manifest`.

---

### Task 8: UI Named Talents (UnitPanel)

**Files:** Modify `packages/desktop/src/renderer/src/report/components/UnitPanel.tsx`; `packages/analysis/src/index.ts` (export talentStrings decoding entry point); Test `packages/desktop/test/report.talents.test.tsx`

**Interfaces:** Consumes talentStrings existing decoding exports (follow source code; report as BLOCKED if no usable entry point); UnitPanel talent section becomes: on successful decoding -> named talent list (name + tier), on failure / empty -> current count display (no regression).

- [ ] Step 1 (Contract): jsdom tests —— run decoding entry point with desktop fixture unit's `info.talents` / talent string; if fixture is anonymized 2v2 (spec=undefined), construct known talent string with mini-talents to assert decoded names; UnitPanel render assertions include named nodes or graceful fallback.
- [ ] Step 2: Implement -> desktop tests all green.
- [ ] Step 3: Commit `feat(report): named talents in unit panel`.

---

### Task 9: SpellIcon + Main Process Icon Disk Cache

**Files:** Create `packages/desktop/src/main/iconCache.ts`, renderer `report/components/SpellIcon.tsx`; Modify `src/main/ipc.ts`, preload, UnitPanel (talent icons) + Meters/Timeline (catalog spell icons); Test `packages/desktop/test/iconCache.test.ts`, `report.spellicon.test.tsx`

**Interfaces:** `createIconCache(deps: { cacheDir: string; fetchImpl?: typeof fetch }): { get(iconName: string): Promise<string | null> }` —— hit reads `<cacheDir>/<safe-name>.jpg` -> data URL; miss GET `https://wow.zamimg.com/images/wow/icons/large/<iconName>.jpg` (2xx writes to disk); failure memoization (no retry for same name in session) returns null. IPC `gladlog:icon:get(iconName) -> string|null`; renderer `SpellIcon({ icon, label })` null -> initial letter box.

- [ ] Step 1 (Contract): iconCache —— fake fetch three states (hit disk / successful fetch writes to disk / failure null and second call does not re-fetch); SpellIcon —— dataURL renders img, null renders letter box (mock bridge).
- [ ] Step 2: Implement + wire (talent list icons use talentIdMap entries.icon; spell icons v1 only within catalog: SPELL_EFFECT data has no icon names —— v1 icon sources only use talent entries.icon, timeline/meters deferred, documented as descoped). **Scope Clarification (Plan Ruling)**: Spell icon names require ManifestInterfaceData table (hundreds of thousands of rows) mapping FDID -> name, not done in v1; this task delivers = talent icons + SpellIcon component + caching facility; timeline icons tracked as backlog.
- [ ] Step 3: desktop all green -> Commit `feat(report): talent icons with local disk cache (zamimg, offline-degrading)`.

---

### Task 10: update-wow-data Workflow + Finalization

**Files:** Create `docs/commands/update-wow-data.md`, `.claude/commands/update-wow-data.md`; Modify `README.md`, `.superpowers/progress.md`

- [ ] Step 1 (Controller): CLEAN rewrite of workflow doc: fetchLatestBuild compares build with datagen-manifest.json -> run each CLI (fetchTalents->genSpellNames->genSpellEffects->genTrinketItemIds->genTalentModifiers->genSpellClassMap) stopping on failure -> validateCatalogs -> repo-wide tests -> report git diff --stat. Thin pointer into .claude/commands.
- [ ] Step 2 (Controller): End-to-end acceptance —— dev mode inspect UnitPanel named talents + icons (screenshots); repack dmg; repo-wide test/tc green.
- [ ] Step 3: Dual review (agy fallback chain): T1-7 datagen merged review + full branch final review; close findings loop.
- [ ] Step 4: Ledger Subproject 5 completion entry + check off README + Commit `docs: sub-project 5 complete`.

## Self-Review Record

- Spec coverage: Six generators (T2-7), judgment layer validation (T7), two-layer merge (T5), PvP duration priority (T4), UI two items (T8-9), workflow (T10), icon cache graceful degradation (T9), error handling (T1 emit / each CLI non-zero exit), test strategy five items all mapped. ✔
- Placeholder scan: No TBDs; T9 scope clarification is explicit ruling, not a placeholder. ✔
- Type consistency: `IMinedSpell` single source (`spellEffectData.ts`); `SPELL_EFFECTS_GENERATED` naming defined in T4 consumed in T5; candidates/emit interface consistent between T1/T4. ✔
- Known risks recorded: raidbots JSON shape drift (T2 BLOCKED path), SpellMisc volume (cacheDir), fixture needs coverage for filtering `DifficultyID !== 0` rows.
