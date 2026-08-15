# Ability-Fact Grounding Design

Date: 2026-08-14 · Status: Pending User Review
User confirmed: Project approved; **Use official data as much as possible; unofficial, uncertain facts must be signed off by the user**.

## Background and Motivation

The full normative audit from the deep dive experiment (58 normative assertions, 10 substantive suspects, ~17% normative layer error rate) exposed a structural pathology: the pipeline only verifies the fact leg (pre-screening replay of evidence lines), but never verifies the normative leg. Error motifs are highly concentrated:

- Out of 6 mechanic-level errors, **3 = "What can be pressed while CC'd"** (Divine Shield blocks stun, Levitate digests stun, Spellwarding dispels HoJ);
- 2 cases of misattributing talent effects (Chrysalis's cocoon CD reduction was attributed to Peaceful Mending, causing even the appeal step to fail);
- 1 case of name table ambiguity (Living Flame cd ledger casts constantly empty, casting coexists with "ready").

Current state inventory (2026-08-14 probe): Ability fact assertions fall into three tiers—

1. **Official Endorsement**: DR tables (genDrCategories, officialized 2026-07-25), spell effects/cast times/CDs (spellEffectGenerated 4909 entries), mitigation coefficients (mitigationGenerated), offGcd, icons/class mapping, etc., from 16 datagen scripts, with manifest anti-corruption tests;
2. **Manual Whitelists**: The cooldowns.ts family (MAJOR_DEFENSIVE_IDS 39 / EXTERNAL 14 / CD_ROLE_TAGS 7 without tests / TEAM_HEAL 8 /…), spellIdLists, SPELL_CATEGORIES 163 entries, classSpells 132 manual D/O/C tags, 5 spec collections of dispel capabilities;
3. **Pure a priori, zero data endorsement**: **`USABLE_WHILE_CC_SPELL_IDS` has only 6 handwritten IDs** (cooldowns.ts:127)—yet SpellMisc's `Attributes_*` flag columns (official usable-while-stunned/feared/confused bits) have never been pulled in the repo; talent effect causalities (except for the 23 sourced entries in talentBehaviors.ts) are scattered in the model's a priori knowledge.

Template precedent: **DR officialization commit 028e625** 7-step method (Empirical anchor enumeration → Establish key space → Official vs manual table diff → Acknowledge gaps without official fields to preserve manual → Override layer always on top → Retire tables in the same commit → Official ≠ exempt from corpus bidirectional error checks). This project will copy this method.

## Goals / Non-Goals

**Goals**

1. **A. Assertion Inventory Archiving + Official Effects Census** (2026-08-14 user expanded scope):
   - A1 Write the three-tier classification inventory produced by the probe into `docs/ability-fact-inventory.md` (Per table: file:line, count, tier, test coverage, consumers), serving as an exposure ledger; update it upon every future officialization/sign-off;
   - A2 **Census the official effects data surface itself**: Enumerate DB2 effect-bearing tables/columns relevant to combat analysis (SpellMisc's Attributes_0..15 all flag families, SpellAuraOptions, SpellInterrupts, SpellShapeshift, SpellEffect un-mined aura types, SpellCategories remaining fields, etc.), marking each as "Pipeline mined / un-mined", and for un-mined items write one line of "What analysis it unlocks + Recommended to enter pipeline or not"—merge the coverage map into the inventory doc as a candidate pool for future datagen extensions.
2. **B1. Officialization of Usable-While-CC Table (Highest Priority)**: New datagen script to mine SpellMisc Attributes flags → `usableWhileCcGenerated.ts` (Categorized by CC type: usable while stunned / feared / confused); `USABLE_WHILE_CC_SPELL_IDS` downgraded to a thin DR-style shim (Generated layer ∪ Manual gap layer).
3. **B2. Unofficial Facts Ledger (Sign-off Mechanism)**: Extend the talentBehaviors.ts pattern into a formal system—any ability/talent fact assertion without official field endorsement goes into a curated entry with an approval mark: `{claim, source, approved: "<Date> user"}`; consistency test enforces: **Entries without approved field fail CI**. The Chrysalis / Peaceful Mending fix enters as the first batch.
4. **B3. Name Table Ambiguity Fixes**: Fix the spell/aura dual ID broken link that caused Living Flame-like "cd ledger casts constantly empty", feed back into extractMajorCooldowns cast matching item-by-item following rotScan conventions; fix at least the empirically proven Living Flame case.
5. **B4. Consumer Wiring**: Deep dive manual's mechanic disciplines, normative audit layer, and candidate layer guards changed to cite the new tables ("What can be pressed while CC'd" goes from model a priori to machine verifiable).

**Non-Goals**

- Will not audit the full semantics of all 4909 spells—only covers the fact surface the pipeline **actually asserted**;
- Will not do full-volume modeling of talent effects (talentModifiers already covers CD modifications; effect semantics only enter the signed-off ledger, added as needed);
- SPELL_CATEGORIES 163 entries and classSpells 132 D/O/C tags **do not require the user to sign off line-by-line**—registered as "Legacy Unaudited" tier, slowly burned down sorted by consumer impact relying on official diffs and corpus scans; sign-off obligation only covers **new entries and stock entries marked by audits** (otherwise the sign-off system would drown the user on day one);
- POSITION_MISTAKES (event taxonomy, not game data assertions) is out of scope.

## Design

### B1 Usable-While-CC Table (Following DR 7-Step Method)

1. **Empirical Anchor Flag Bits**: Do not make assumptions about SpellMisc's Attributes column order and bit meanings—first pull the table, verify interpretation against an **anchor list**: Gladiator's Medallion (336126) usable while stunned = True, Divine Shield (642) usable while stunned = False (2026-08-14 User ruled), Icebound Fortitude etc... The anchor list itself is signed off by the user. If bit interpretation does not match anchors → Stop, report, do not output table.
2. **Key Space**: Aligned with log cast events using cast spellId; unlike the DR table (which uses aura id), consumers of this table (candidate layer/deep dive) check "can it be pressed", so key = cast id.
3. **Three-Line Evidence**: Official flag bits ∪ Corpus observation (raw SPELL_CAST_SUCCESS occurring within an active hard CC aura period = empirically usable while stunned—our unique third evidence line, readily available from the free arm pipeline) ∪ Current manual 6 entries; three-way diff, discrepancies listed item by item for user arbitration.
4. **Preserve Manual for Gaps**: Categories not covered by official bits (like usable while disarmed) remain in the manual layer, annotated.
5. **Override Layer Always Above Generated Layer** (DB2 quirk fixes are not written into the generator).
6. Output: `usableWhileCcGenerated.ts` (`{ stunned: Set<id>, feared: Set<id>, confused: Set<id> }`) + shim refactor `cooldowns.ts:127` + manifest registration + predicate index registration (bilingual).
7. **Official ≠ Exempt from Verification**: Run bidirectional corpus errors before launch (sample size of spells official says usable but never seen cast while stunned in corpus; contradiction cases where official says unusable but appeared in corpus—the latter must be 0 or explained line-by-line).

### B2 Sign-off Mechanism

- File format: Extend `talentBehaviors.ts` structure (or a parallel new file `curatedAbilityFacts.ts`), each entry: `{ id, claim, kind, source, approved }`.
- Testing: `test/curatedFacts.test.ts` asserts each entry has `approved`; adding unsigned entries → CI red; sign-off process = user "approves" line-by-line in PR/session, date is archived (Precedent: MITIGATION_OVERRIDES each entry has source + user confirmed date).
- First batch of entries: Chrysalis (202424, cocoon -45s), Peaceful Mending (353313, does not modify cocoon CD), Divine Shield cannot be cast while stunned (if B1 official bits cover this, then it belongs to B1).

### B3/B4

- B3: Use Living Flame as empirical sample, locate why extractMajorCooldowns cast collection missed it (id broken link / name table ambiguity), fix + unit test; incidentally run a full cd ledger "ready coexists with cast" scan (rotScan style) to quantify similar exposures.
- B4: Deep dive manual's "usable while CC" section changed to cite the new table; normative audit prompt adds "check usableWhileCc table first before citing mechanics"; candidate layer line 1816 usable_in_cc fact changed to take data from the shim.

## Acceptance (Fixes must provide before/after numbers)

- Usable-While-CC Table: Manual 6 → Official + Corpus N; three-way diff discrepancy list and arbitration record; corpus bidirectional error numbers; existing tests all green after switching candidate layer / deep dive consumers.
- Name table fix: Living Flame casts empty → non-empty (replay of that match); exposure count from the similar scan.
- Sign-off ledger: 0 unapproved entries (CI enforced).
- Audit inventory archived, predicate index and bilingual pairs updated.

## Testing

- datagen script: Anchor list assertion tests (Anchor interpretation wrong → red);
- shim: Union semantics of generated ∪ manual identical to DR shim tests;
- Sign-off ledger: `approved` enforcement test;
- Consumers: existing behavioral tests for candidateFindings usable_in_cc branch remain green.
