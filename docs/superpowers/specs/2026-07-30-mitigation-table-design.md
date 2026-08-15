# Mitigation {Percentage, School} Table (#17 Foundation) Design

2026-07-30 · Foundation piece for backlog #17.2: {percentage, effective school} for each major mitigation,
criteria follow DB2 official fields ([[official-data-over-heuristics]]), official tables also need real testing.
Prerequisite quantification is complete: death window damageIn school field coverage is 100% (148/148 windows ≥90%
attributable, seed=20260729, n=302 evaluation units); DR table officialization was completed on 2026-07-25,
no need to redo.

## Goals and Criteria

`packages/analysis/src/data/mitigationData.ts` exports:

```ts
export interface IMitigationEntry {
  /** Mitigation percentage, 0-100; immunity class = 100. */
  pct: number;
  /** Effective school mask, same bit semantics as log spellSchoolId (0x7F all schools/0x7E magic only/0x1 physical only...). */
  schoolMask: number;
  /**
   * Optional, conditional mitigation (condition = positioning) annotation: only effective for units within the spell area; #17
   * Consumers must combine advanced coordinate data to determine if the unit is within the area, if not checked it must not be
   * counted towards this mitigation —— failing to check will lead to a 40% directional overestimation of conditional mitigations
   * like Darkness (196718) by treating them as unconditional. Only when the condition dimension itself is determinable in logs (like positioning)
   * is it allowed to mark this field and give a value; entries where the condition dimension is indeterminable in logs
   * (like whether damage is AoE, see 374227 Zephyr) maintain no-mitigation preferring omission, and do not enter this table.
   */
  positional?: true;
}
export const MITIGATION_TABLE: Record<string, IMitigationEntry>;
```

Scope = `bigDefensiveSpellIds ∪ externalDefensiveSpellIds` (~35 items, the entire
consumer surface of #17). **No consumers are built in this phase** —— pure foundation: table + datagen + tests + workflow registration.

Acceptance criteria: Each of the 35 whitelist ids must either have an entry in the merged table or be in the explicit
`NO_MITIGATION_IDS` registry table (pure immunity absorb/pure healing class, with comments explaining why there is no mitigation
attribute) —— **no third state is allowed** (silent absence means anti-corruption test turns red).

## Decision Record (brainstorm approved)

1. **Dual-layer: Generated base + Curated overrides** (same precedent as spellEffectData) —— what can be mined from DB2
   goes into `mitigationGenerated.json`, what cannot be mined/is mined incorrectly goes to `MITIGATION_OVERRIDES` manual
   calibration values which always win. Rejected: pure curation (violates official-data decision), pure generation (mitigation aura
   semantics are diverse, no one catches mining errors).
2. Immunity class semantics: `pct: 100, schoolMask` as-is; does not conflict with burstLedger's isImmunity
   binary check, consumers differentiate on their own.
3. Scope pinned to whitelist of 35 items, do not do the full table (mitigation entries outside the consumer surface are not checked, whitelist rot
   lesson: a big table does not mean it's right).
4. **2026-07-30 User reversed 196718 (Darkness)**: The original implementation decision of no-mitigation was
   overturned by the user, changed to `{ pct: 40, schoolMask: 0x7f, positional: true }` (major spells
   cannot be counted as 0, but position must be calculated —— not counted if not standing in Darkness). This establishes the determinability divide:
   When the condition dimension itself is **determinable** in the log (Darkness = positioning, advanced coordinate data checkable), give a value
   and mark `positional: true`, delegating the check responsibility to the consumer; when the condition dimension is **indeterminable** (Zephyr
   374227 = whether it's AoE, `{pct, schoolMask}` schema lacks condition dimension expression ability), maintain
   no-mitigation preferring omission. Future similar conditional mitigations will be classified according to this divide without asking case-by-case.

## Architecture

### Generation Layer (new datagen script genMitigation.ts)

- Fetch `SpellEffect` table (`fetchTable("SpellEffect", build, cacheDir)`,
  genTalentModifiers.ts:252 precedent), filter by whitelist ids;
- Identify mitigation aura: primarily `EffectAura === 87` (AURA_MOD_DAMAGE_PERCENT_TAKEN,
  `EffectBasePointsF` = negative percentage, `EffectMiscValue_0` = school mask —— DB2
  standard semantics, **assert and verify against known anchors within the script**: e.g. Barkskin should mine `{20, 0x7F}`
  class, anchor values hardcoded into assertions based on real checks during implementation);
- Multi-effect ambiguity (multiple 87 rows for the same spell/conditional auras) or un-mineable entries **do not guess**:
  Write them into the `unresolved` list of the generation report, to be handled by the curation layer;
- Artifact `mitigationGenerated.json` (small table, does not involve large JSON discipline);
  register in `datagen-manifest.json`; add steps to `docs/commands/update-wow-data.md`.

### Curation Layer and Merging

- `MITIGATION_OVERRIDES: Record<string, IMitigationEntry>` (each entry with comments:
  source = game facts/tooltip, why overridden);
- `NO_MITIGATION_IDS: ReadonlySet<string>` (entries in the whitelist that definitely have no mitigation attributes,
  each with comments explaining why);
- Merge: `MITIGATION_TABLE = { ...generated, ...overrides }`, overrides layer always wins.

### Real Testing Acceptance (official-data discipline: official tables also need real testing)

1. After generation, all 35 items must be human-reviewed one by one against game facts (tooltip percentage/school), errors/omissions go into
   overrides —— human review records go into the implementation report;
2. Corpus sanity: Sample 2-3 real matches with clear mitigation windows (e.g. Shield Wall / Defensive Stance active periods),
   compare the actual damageIn reduction during the buff active period relative to the baseline with the table value, they should be in the same magnitude (±10pp level
   tolerance, to prevent systemic mining errors, not pursuing precision —— confounding factors like absorb shields/armor/resilience are not modeled).

## Boundaries (deliberately not doing)

- Any consumer integration (that's the main work of #17);
- Mitigation entries outside the whitelist; conditional mitigation (e.g. AoE only) condition modeling —— mark the basic value
  as-is, condition semantics are left to be decided during #17 design;
- Multiplicative/additive interactions (multiple mitigations in the same window) —— the table only records single-spell values, stacking rules belong to #17's arithmetic layer.

## Testing

- Anti-corruption: whitelist full coverage assertion (TABLE ∪ NO_MITIGATION_IDS ⊇ whitelist, no third state);
  Value range assertions pct∈(0,100], schoolMask∈(0,0x7F]; overrides keys must be in the whitelist
  (prevents out-of-bounds drift);
- datagen transform pure function unit tests (row 87 identification / negative value absolute / mask pass-through / ambiguity goes to
  unresolved);
- Anchor assertions: {pct, schoolMask} precise values for 2-3 well-known spells (hardcoded after real checks during implementation).

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Mitigation aura types are not just 87 (e.g. mod school absorb class) | Generation layer only recognizes 87, the rest go to unresolved for curation to handle; do not expand mining (YAGNI, 35 item human review fallback) |
| SchoolMask semantics do not match log spellSchoolId bit semantics | Anchor assertions + corpus sanity double insurance; if inconsistent stop immediately, report back before deciding |
| Curation layer rot (season changes) | update-wow-data workflow steps + generate/override diff naturally exposed during refresh |
