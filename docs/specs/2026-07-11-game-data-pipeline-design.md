# Subproject 5: Game Data Pipeline Design

Date: 2026-07-11. Prerequisites: Subprojects 1-4 completed. User has authorized this spec's decisions to be self-selected per Recommended and recorded (user is sleeping, can be changed later).

## Goals

Authoritative data pipeline replaces placeholders and highly error-prone manual data from period 4a: wago.tools DB2 CSV (Blizzard public game data) + raidbots static talent JSON → generators output gladlog's **existing target shapes** (zero changes on the consumer side); UI wiring for named talents and spell icons.

**Out of scope**: Full spellId→icon mapping and offline icon prefetching (v1 only does talent icons + spells in the catalog), zone geometry (already has CLEAN port), positioning replay v2, Blizzard Game Data API source (debate rejected: OAuth barrier/rate limiting/no DB2 fidelity).

## Key Decisions (Self-selected + Debate Revisions)

| Decision Point | Finalization |
| --- | --- |
| Division of Labor | **Judgment layer manual, mechanical layer machine**: Judgment-type catalogs such as big defensives/DR categories remain manually curated (upstream is the same, BigDebuffs community data), the pipeline only performs **build validation** on them (id still exists in SpellName.csv, rename/removal reported for manual review); CD/duration/dispel type/name/trinkets/talent trees are the mechanical layer, machine-generated |
| Compliance | 4 upstream generators **clean room rewritten** (based only on gladlog existing output contracts + wago public table structures, not reading upstream sources); 2 owned pieces: generateTrinketItemIds (CLEAN direct port), generateTalentModifiers (NEEDS_SCRUB scrape migrated per audit); update-wow-data workflow doc CLEAN rewritten |
| Candidate Set | IMinedSpell mining whitelist = curated catalog ids ∪ raidbots active talent spellIds ∪ **PvpTalent.csv spellIds** (debate revision: PvE tree does not contain PvP talents, omitting them blinds the arena parser) |
| Two-tier Data | `spellEffectData` = generated base layer (DB2 raw values) + `SPELL_EFFECT_OVERRIDES` curated override layer **takes precedence** — 4a manually calibrated PvP modifiers (Hearthstone duration, etc.) retained; utils already prefer log empirical testing, static duration is just a fallback. **Known maintenance tax (debate final judgment)**: PvP duration modifiers cannot be purely automated by the pipeline, the override layer is a long-term manual responsibility, adding entries on the spot whenever benchmarks reveal deviations |
| Destination | Generators = `packages/analysis/scripts/datagen/*.ts` (tsx CLI, collectBenchmarks convention); outputs JSON/TS committed to public repo (objective game facts), replacing identically named and shaped files in place |
| Icons | icon name → zamimg CDN, **cached to disk after first fetch** (under desktop main process userData), degrades to text when offline and not cached; Blizzard art not committed to repo (public repo MIT, distribution is infringement — debate rejected its "commit image" steelman) |
| spellNames | wago SpellName.csv regenerated (enUS single language, compressed rows); if dev initial load is still slow, runtime optimization moves to legacy |

## Architecture and Components

### Generators (`packages/analysis/scripts/datagen/`)

| CLI | Input (wago.tools CSV / raidbots) | Output (Existing Shape) |
| --- | --- | --- |
| `fetchTalents.ts` | raidbots `static/data/live/talents.json` | `data/talentIdMap.json` (saved as-is, talentStrings.ts already implements decoding) |
| `genSpellNames.ts` | `SpellName.csv` | `data/spellNames.json` (id→enUS name, compressed) |
| `genSpellEffects.ts` | `SpellCooldowns.csv`, `SpellDuration.csv`, `SpellMisc.csv`, `SpellCategories.csv`, `SpellCharges?` (based on wowdev.wiki table structures) + candidate set | `data/spellEffectGenerated.ts` (`Record<string, IMinedSpell>` base layer) |
| `genSpellClassMap.ts` | `SkillLineAbility.csv` + `SkillLine.csv` (class association is direct encoding in the table, no heuristics) | `data/spellClassMapGenerated.ts` (current DR table for drCategories is **not** generated from this — judgment layer) |
| `genTrinketItemIds.ts` | `ItemSparse.csv` (owned piece direct port) | `data/trinketItemIds.json` |
| `genTalentModifiers.ts` | talentIdMap + spellEffects (owned piece scrape migrated) | `data/talentModifiers.json` |
| `validateCatalogs.ts` | `SpellName.csv` + all curated catalogs | Validation report: curated id invalidation/rename list (non-zero exit) |

Common Layer: `datagen/lib/wagoCsv.ts` (build query, CSV fetch and parse, caching to temp directory), `datagen/lib/emit.ts` (shape assertions: minimum entry count, required fields, unqualified outputs are not saved). Pure transform functions are separated from fetches; tested using committed fixture CSV slices (dozens of rows per table), actual fetching only happens in the manual workflow.

### Data Wiring

- `spellEffectData.ts` changed to: `{...GENERATED, ...SPELL_EFFECT_OVERRIDES}` (override layer takes precedence), export surface unchanged.
- dispelType integer mapping based on wowdev.wiki doc enums (1=Magic 2=Curse 3=Disease 4=Poison), golden assertions nail this down (Polymorph→Magic, Curse of Tongues→Curse).
- 4a's data calibration assertions (221+) serve as the replacement regression gate: after swapping data, the full suite of analysis tests must be green.

### UI Wiring (desktop renderer)

- UnitPanel: `talentStrings` decodes talent strings → named talent list (names from talentIdMap entries; PvP talent names from mined names table).
- `SpellIcon` component: icon name → main process `gladlog:icon:get` (cache hit reads from disk, miss fetches from zamimg and saves to disk) → data URL; fails degrade to initial letter block.
- Timeline/meters icons v1 only cover spells in the catalog, others have no icons (no broken images left behind).

### `update-wow-data` Workflow (docs/commands/, CLEAN rewritten)

Check wago builds API for the latest retail build → compare with the build recorded in outputs → run generators one by one (stop on failure) → `validateCatalogs` → full test suite → git diff --stat summary report.

## Error Handling

- Fetch failure/unexpected CSV shape → generators exit non-zero, do not write half-finished products (emit layer shape assertions).
- Curated catalog id invalidates in new build → validateCatalogs reports list, manual ruling (rename follow-up/removal).
- Icon fetch failure → cache not written, UI degrades to text, no retry storm (in-session failure memory).

## Testing Strategy

- Each pure transform function: fixture CSV slice → golden output assertion (including dispelType enum golden).
- Emit shape assertion: input with insufficient entries/missing fields constructed → writing to disk rejected.
- Two-tier merge: unit test for override-precedence merge semantics (override layer wins when both layers coexist for the same id).
- Regression gate: full repo tests green after real outputs are saved to disk (4a calibration assertions).
- UI: SpellIcon cache hit/miss/failure degradation three states (mock main process bridge); UnitPanel named talent rendering (desktop fixture's talent string).

## Debate Record (agy Gemini 3.1 Pro, 2026-07-11, three rounds)

OPPOSE→PARTIAL→CONCEDE. Concessions to the other side: ① judgment-type catalogs cannot be mechanically deduced — changed to "judgment layer manual + pipeline only validates" (hit); ② icon CDN and local-first contradiction — changed to fetch and cache to disk immediately (hit; its "commit image to repo" steelman rejected on copyright grounds); ③ PvP talents are not in raidbots PvE tree — candidate set merged with PvpTalent.csv (hit, structural fix); ④ PvP duration modifiers cannot be purely automated — two-tier data override precedence, **and accept final judgment: override layer is a lifetime maintenance tax for the project**. Held the line on: wago.tools source (vs Blizzard API steelman: OAuth/rate limiting/fidelity); dispelType mapping is not a blind guess (wowdev.wiki doc + golden assertions).
