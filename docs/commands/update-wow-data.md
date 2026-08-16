# update-wow-data — Game Data Update Workflow

Refresh generated data in `packages/analysis/src/data/` when a new WoW retail build is released or during season updates.

## Steps

### 1. Check the Current Data Build

Read the `build` field in `packages/analysis/src/data/datagen-manifest.json` and record it as `CURRENT_BUILD` (if the file does not exist, consider a full update required).

### 2. Check the Latest Retail Build

GET `https://wago.tools/api/builds?branch=retail&product=wow`, take the highest `version`, and record it as `LATEST_BUILD`. If fetching fails, ask the user for the current latest build number.

### 3. Compare

`CURRENT_BUILD == LATEST_BUILD` → Report "Data is already up to date" and stop. Otherwise proceed.

### 4. Run Batch Datagen Generator by Generator (Sequential Execution, Stop on Failure)

Run from repo root. **`DATAGEN_BUILD` must first be pinned to `LATEST_BUILD` discovered in step 2**—
all generators resolve builds through a single source in `lib/wagoCsv.ts`'s `resolveBuild()` (CLI argument >
`DATAGEN_BUILD` > latest wago). Without pinning, if wago releases a new build mid-batch, mixed-build
artifacts will be produced; before 2026-08-11, `genSpellIcons` would also read an old build from the previous
round's manifest (the actual record of an entire batch of icons extracted from the wrong build can be seen in
09ae85b on that day). In addition, set `DATAGEN_CACHE` to reuse large table downloads:

```bash
export DATAGEN_BUILD=<LATEST_BUILD>
export DATAGEN_CACHE=$(mktemp -d)
# 1. Talent trees (raidbots; must run first — spellEffects candidate set reads talentIdMap)
npx tsx packages/analysis/scripts/datagen/fetchTalents.ts
# 2. Spell names (enUS compressed)
npx tsx packages/analysis/scripts/datagen/genSpellNames.ts
# 2b. Spell names zhCN (inline icon display name; depends on 6b icon table existing — move this step after 6b during full refresh)
npx tsx packages/analysis/scripts/datagen/genSpellNamesZh.ts
# 3. Spell effects base layer (PvP duration prioritized; candidate set = curated catalogs ∪ talents ∪ PvpTalent)
npx tsx packages/analysis/scripts/datagen/genSpellEffects.ts
# 4. PvP trinket item ids
npx tsx packages/analysis/scripts/datagen/genTrinketItemIds.ts
# 5. Talent CD modifier extraction
npx tsx packages/analysis/scripts/datagen/genTalentModifiers.ts
# 6. Spell -> class mapping
npx tsx packages/analysis/scripts/datagen/genSpellClassMap.ts
# 6b-pre. Observed spell ID universe (input for icons/offGcd; new season IDs come in via this)
#   Manifest contains absolute paths to logs; logs now reside in ~/gladlog-sync/logs (since
#   2026-08-11, old wowarenalogs/scratch path is dead and fully remapped eval-private ac3a6a2f).
#   Note the `>` redirection in this step: script failure will still truncate the output file first; recover with git checkout if it fails.
npx tsx packages/eval/scripts/observedSpellIds.ts \
  --manifest $GLADLOG_EVAL_HOME/corpus/manifest-fullscale.txt \
  --store ~/Library/Application\ Support/gladlog/matches \
  > packages/analysis/src/data/observedSpellIdsGenerated.json
# 6b. Spell icon names (desktop swimlane/replay icons; SpellMisc -> ManifestInterfaceData;
#     universe = observed ∪ SpellCooldowns ∪ candidates; do not revert to full table — 13.8MB busts initial render budget)
npx tsx packages/analysis/scripts/datagen/genSpellIcons.ts
# 6c. PvP talent replacement table (PvpTalent.OverridesSpellID; consumed by cd-waste ledger)
npx tsx packages/analysis/scripts/datagen/genPvpTalentReplaces.ts
# 6d. PvP talent pool (PvpTalent SpecID/SpellID/ActionBarSpellID; consumed by talentOwnershipOf)
npx tsx packages/analysis/scripts/datagen/genPvpTalentPool.ts
# 6e. DR category table (SpellCategories.DiminishType; consumed by drAnalysis, aura ID key)
npx tsx packages/analysis/scripts/datagen/genDrCategories.ts
# 6f. off-GCD active abilities table (SpellCooldowns StartRecoveryTime==0; consumed by swimlane folding)
npx tsx packages/analysis/scripts/datagen/genOffGcd.ts
# 6g. Damage mitigation table (#17 foundation; whitelist = big ∪ external 35 items, curated overrides in mitigationData.ts)
npx tsx packages/analysis/scripts/datagen/genMitigation.ts
# 6h. Usable while CC'd table (B1; SpellMisc.Attributes bitwise union search, anchored to usableWhileCcAnchors.ts;
#     only stunned dimension converges to a unique bit combination; feared/confused are known gaps — see generated file header
#     comments and task-3-report.md. 2026-08-14 correction: cooldowns.ts USABLE_WHILE_CC_SPELL_IDS
#     has migrated since Task 5 to "stunned generated set ∪ unconditional manual gap layer"; the overall semantics are stunned-
#     specific, no longer the old model of "handwritten layer backstopping feared/confused" — feared/confused currently have no
#     ground-truth layer; consumers (wasLockedOutByStunOnly, etc.) handle each CC type separately: only query this table during pure stunned
#     lockout windows; non-stun hard CCs (fear/disorient/incap) are unconditionally forgiven and must not be evaluated against
#     the stunned table. Non-zero exit = stunned no longer converges; rerun anchoring/bit search from scratch,
#     do not relax criteria to force table generation)
npx tsx packages/analysis/scripts/datagen/genUsableWhileCc.ts
# 7. Manifest summary
npx tsx packages/analysis/scripts/datagen/writeManifest.ts
```

If any script exits non-zero: display error, stop, and report to the user; do not proceed with subsequent scripts.

### 4b. Empirical Verification of Official Tables (2026-07-25 Lesson: Official ≠ Exemption from Verification)

Official DB2 tables themselves may be incomplete or link fields to incorrect IDs: SkillLineAbility lacks 12.x modern
trait abilities (a pure spellbook gate will falsely eliminate 20+ real keybinds like Cleanse/Penance); DR/dispel
fields link to **aura IDs**, whereas manual tables often write cast IDs (Shockwave 46968 dead entry). After introducing or
refreshing any official criteria, measure error rates in both directions on real corpus (manual review of false-positive list +
spot checks of false-negatives) before applying, with accompanying re-scans: parserInvariants / confidenceAudit / evidenceDist.

### 5. Curated Catalog Validation (Manual Adjudication Gate)

```bash
DATAGEN_CACHE=$DATAGEN_CACHE npx tsx packages/analysis/scripts/datagen/validateCatalogs.ts
```

Non-zero exit = curated IDs invalidated in the new build. Adjudicate manually item by item:

- Spell removed but still needed for historical logs → Add to `KNOWN_REMOVED_SPELLS` in `validateCatalogs.ts` (note spell name and adjudication date)
- Spell renamed / ID changed → Fix corresponding curated catalog
- Catalog typo → Fix catalog

### 6. Regression Gate

```bash
npm test --workspaces && npm run typecheck --workspaces --if-present
```

### 7. Whitelist Rot Check (Corpus Coverage Regression)

New builds often accompany ability reworks / ID changes, causing curated whitelists to rot silently (2026-07 spec-level audit:
Frost Mage / Windwalker / Survival Hunter none-tracked rate was 100%, root cause was entirely reworks). After data refresh, rebuild sample prompts on recent
corpus and check two rates:

```bash
# Enemy CD tracking gap: calculate none-tracked rate by spec (check denominator! Absolute numbers can be deceptive)
grep -rB6 "<cooldowns>none tracked" <runDir>/prompts | grep -o 'spec="[^"]*"' | sort | uniq -c | sort -rn
# DR category gap: any [DR: spell:<id> fallback rendering indicates missing mapping
grep -rho "\[DR: spell:[0-9]*" <runDir>/prompts | sort | uniq -c
```

If any spec rate spikes → Supplement via "corpus empirical evidence" workflow: mine SPELL_CAST_SUCCESS for that spec to find new
burst IDs (filtering with CD data will **happen to miss new IDs**; inspect unfiltered top first, then add overrides;
CD/duration measured empirically from corpus: min inter-cast gap / median buff applied→removed).
Known expected gaps (do not falsely report): Retribution Radiant Glory passive AW, Enhancement Doom Winds per-strike
proc — cast-type trackers cannot resolve these; commented in spellCategories.ts.

Must be all green. If step 4a data calibration assertions fail due to new data: prioritize manually calibrated values → add correct values into `SPELL_EFFECT_OVERRIDES` (override layer always wins), do not modify tests.

### 8. Summary

```bash
git diff --stat packages/analysis/src/data/
```

Report: changed files, old/new builds, key counts (number of mined entries, talentModifiers ability count, spec count). Note the build number in the commit message.

## Notes

- Override layer maintenance tax (final judgment by spec on record): PvP durations / server-side modifiers are not encoded in DB2; when deviations are found, add `SPELL_EFFECT_OVERRIDES` entries in place.
- `spellNames.json` at 12MB is expected; optimizing slow dev initial load is a separate matter.
- Icons are fetched at runtime + cached to disk, not involved in data updates.
