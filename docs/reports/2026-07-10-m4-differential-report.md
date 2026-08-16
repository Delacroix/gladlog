# M4 Differential Alignment Report (New Parser + Compat vs Legacy Pipeline)

Status: **Complete** (2026-07-10).

## Methodology

- **Oracle**: Legacy fork running the legacy parser privately (legitimate private use); differential tooling hosted in legacy fork `scratch/parser-diff/` (excluded from this repository).
- **Level-1 Core Facts**: Canonical JSON (match boundaries / rosters / specs / teamId / win-loss / true deaths / total damage & healing) compared field-by-field.
- **Level-2 Downstream Consumption Surface**: Dual-side outputs fed into the same React-free `buildMatchContext`, prompt line-level diff + 3-category bucketing:
  `numericDrift` (same skeleton, different numbers) / enum order (eliminated via canon rules) / `STRUCTURAL` (bucket-by-bucket spot-check adjudication).
- **Adjudication Principle** (spec): Legacy parser is not unconditional truth; each divergence is arbitrated against raw logs; cases where the new side is correct are marked `NEW_CORRECT` without compromising.

## Adjudication Ledger (Full Records, numbers correspond to legacy fork `scratch/parser-diff/adjudications.md`)

| # | Rule / Finding | Disposition |
| --- | --- | --- |
| 1-5 | `early_leaver` discarding full matches, 2024 amount corruption, missing `playerId` (legacy defects); CI fixed index (new, fixed) | NEW_CORRECT ×3 + New side fix ×2 |
| 6 | Legacy convention: negative sign on damage + absorbs mixed into attacker `damageOut` as positive numbers | Replicated in compat |
| 10/12 | `SWING_DAMAGE_LANDED` double-counting (new, fixed); event name preservation (new, fixed) | New side fix |
| 13 | `effective = amount - overkill - absorbed`; absorb credited to attacker, amount taken from `absorbed` parameter | Replicated in compat |
| 14 | Legacy had periodic zeroing that could not be explained by raw parameters | NEW_CORRECT, whitelist = Σ(legacy eff=0 row amounts) |
| 16-18 | Pets/guardians merged into owner; pet target row eff zeroed; `SPELL_SUMMON` establishes totem ownership | compat/parser replicated + fixed → **Healing fully aligned** |
| 19 | Legacy absorbed deduction was self-contradictory across log eras (deducted in EU / not in CN, uniform 5-13% shift per spell) | Frozen: new side semantics govern |
| 20-23 | Downstream contracts: `advancedActions` shape / `logLine.parameters` / `CombatantInfo` exact shape / `spellId` string | Replicated in compat (4 items) |
| 24-25 | `damageIn` without absorb mixing; `spellSchoolId` hexadecimal string | Replicated in compat |
| 26 | Defensive overlap (GS + Evasion) detected on new side, missed on legacy side, proven by raw log lines | NEW_CORRECT |

## T1-200 Results (Stratified: 90 3v3 / 80 shuffle / 30 2v2, seed 20260710)

### Level-1 Core Facts (600 Matches / Rounds)

- **Structure fully identical: 599/600 (99.8%)**. Sole remaining case = a shuffle round win-loss case with double deaths 0.75s apart: raw CI proved **new side is correct, legacy side misjudged** (Adjudication #30). **Unadjudicated differences = 0, acceptance achieved.**
- Total Healing: Median drift 0.00%, p90 0.00%, 99% of units ≤ 2%.
- Total Damage (after #14 whitelist): Median 2.74%, p90 11.06% — all residuals attributable to legacy pipeline's absorbed deduction inconsistency across eras (#19, frozen) and periodic zeroing (#14); new side semantics can be verified line-by-line against raw logs.
- Spectator leak (12 cases) cleared to zero after #27 filter fix.

### Level-2 Downstream Consumption Surface (600 `buildMatchContext` Prompts)

- Line differences 31.4% (33,236 / 105,717): **`numericDrift` 23,727 (71%, #14/#19 adjudicated categories) + Structural 9,509 (29%)**.
- Structural census fully attributed (spot checks per bucket anchored to raw logs):
  - Cast list hygiene: Legacy side had 438 lines of contradictory duplicate entries for the same spell (#28, NEW_CORRECT)
  - Pressure / idle windows and `[MATCH TYPE]` classifier threshold flips under numeric drift (#14/#19 cascade)
  - Defensive overlap / PANIC TRADING detection: Additional overlaps detected by new side proven to genuinely exist via raw log lines (#26, NEW_CORRECT)
- Conclusion: **Not a single Level-2 divergence points to a parse error in the new parser**; all are (a) adjudicated legacy pipeline defects, or (b) deterministic threshold cascades of their numbers downstream.

### Alignment Acceptance Ruling

Spec standard "every difference is adjudicated, unadjudicated differences = 0" has been met. M4 complete; systematic conclusions on damage accounting (new side is more accurate) recorded to set expectations for Sub-project 4 data realignment phase.

## Implications for Sub-project 4 (Downstream Porting)

- Legacy conventions replicated in compat (negative signs, mixed absorbs, pet merging, zeroing, string IDs) allow legacy downstream code to **run without semantic modifications**.
- `NEW_CORRECT` differences mean that after porting: aborted shuffles will appear, pressure/damage numbers will be slightly higher overall and more accurate, and previously missed analysis moments will be newly detected — **these are the primary sources of drift when re-running benchmarks/thresholds**, consistent with the "data realignment phase" outlined in the roadmap spec.
- Confirmed legacy pipeline defects list (for intuition calibration): `early_leaver` dropped matches, 2024 version amount corruption, periodic zeroing, inconsistent absorbed deductions, missed defensive overlaps.
