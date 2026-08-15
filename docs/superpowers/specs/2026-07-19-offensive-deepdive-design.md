# Offensive Deep Dive (Non-Death Finding Deep Dive) Design

**Goal:** Ensure the deep dive round (deepDive multi-turn questioning) also covers non-death findings, using offensive evidence that **mirrors** the death path to balance the coach's current bias towards death windows—non-death mistakes can also secure a deep dive seat and be thoroughly explained.

**Architecture:** Add a new "offensive pack builder" sibling + a dispatcher, reusing the existing `deepen()` / `buildDeepDivePrompt` / `auditDeepDives` scaffolding; **the survival (death) path remains completely untouched**, ensuring zero regression for the recently validated death deep dives.

**Tech Stack:** TypeScript monorepo. Analysis is in `packages/analysis`, deep dive service is in `packages/desktop/src/main`, triggered in the renderer. Eval harmonics are in `packages/eval/scripts`, with outputs in `$GLADLOG_EVAL_HOME` (defaults to `~/code/gladlog-eval-private`).

## Global Constraints

- **Single Source of Truth for Predicates Ironclad Rule**: The offensive pack strictly consumes `analyzeBurstLedger` / `analyzeOutgoingCCChains` / `computeOffensiveWindows` / `getHpPercentAtTime` — the **exact same batch of predicates** used when generating similar candidates in `candidateFindings.ts`, calculating no new facts. See CLAUDE.md "Predicates as Specifications".
- **Placeholder Discipline**: All numbers in the deep dive narrative must be `{{key.field}}` placeholders, interpolated only after the claimChecker; names use `sn()` to strip realm numbers; do not encode structured numerical values into key names (HP/hit rate/DR split into independent placeholder fields). See [[gladlog-deepdive-eval]].
- **Type Checking** `npm run typecheck` (never `tsc -b`). Before desktop push: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`.
- **Deep Dive Builder is inside `packages/analysis`**, using relative imports to fetch utils predicates (no need to export from index).
- Eval subagent responder/judge uniformly uses sonnet; cross-AI = sonnet + gemini (agy); agy output redirected to file (do not use `| tail`).

---

## Background / Current State

Deep Dive Current State (Death-Oriented):

- `buildDeepDivePack(combat, finding, findingIndex, candidates, ownerName?)` gathers **survival evidence** around the finding's reference event `[minT-30, maxT+10]`: friendly CC (`analyzePlayerCCAndTrinket`), friendly defensive + timing (`annotateDefensiveTimings`), enemy offensive CDs, owner HP, dispels, owner positioning (fix 3).
- `hasCoachableSignal` determines "friendly controllable mistakes": defensives used too early/late, ≥3s hard CC missing trinket usage, low-priority dispel wasting GCD, positioning mistakes.
- renderer (`StructuredAnalysisPanel.tsx`) sorts findings by `SEVERITY_RANK`, takes the top `DEEP_DIVE_MAX=2` that pass the gate to build packs, in a single `deepen()` call. `death` candidates have severity=high, almost dominating the 2 seats.

Non-death candidate types **already exist** (`candidateFindings.ts`, each bringing offensive facts):

| type                           | Trigger Condition (already pre-curated)            | Built-in facts                                          |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------- |
| `unconverted-burst`            | Burst unconverted to kill with no immunity         | target, damageM, hpStart, hpEnd, defensive, allyAligned |
| `burst-into-immunity`          | Main target gains immunity during burst            | target, immunity, overlap                               |
| `off-target-in-window`         | Hit percentage on window target too low in kill window | target, onTargetPct, offTarget                          |
| `juked-kick`                   | Kick baited by fake cast                           | kick, fake                                              |
| `dr-clipped-cc`                | owner CC lands on 25%/Immune DR                    | spell, target, dr                                       |
| ~~`cd-waste`~~ **(Excluded, see below)** | Never-used **survival** major cooldown (pure defensive wall), whole-round `t:0` | spell, unit(healer)                                     |

**Scope Correction (discovered via spec self-check):** `cd-waste` **does not enter this design**. Two reasons: (1) It is a
whole-round observation (`t:0`, `cdWasteEvents` commented as "whole-round observation, not
time-specific"), and the window-style pack builder filtering `c.t > 0` would directly evaluate to null, leaving no time anchor to deep dive into;
(2) It is actually a "never-used **survival** defensive wall" (healer anchored, `isThroughput` excluded),
which is fundamentally a survival category rather than an offensive mistake. Therefore, the offensive deep dive covers **5 categories of window-style non-death mistakes**: unconverted-burst
/ burst-into-immunity / off-target-in-window / juked-kick / dr-clipped-cc. If cd-waste
requires coaching, a separate whole-round mechanism needs to be established (add to backlog, not in this design).

Reusable predicates (all in `packages/analysis/src/utils/*`, already used by candidateFindings):

- `analyzeBurstLedger(owner, allies, enemies, combat)` → burst windows, each containing `dominantTarget`{`hpStartPct`, `hpEndPct`, `damage`, `defensivesHit`[{spellName, isImmunity, overlapSeconds}]}, `allyCDsOverlapping`, `spells`.
- `analyzeOutgoingCCChains(friends, enemies, combat)` → friendly outgoing CC chains against enemies (target, applications[{casterName, spellName, atSeconds, drInfo.level}]).
- `computeOffensiveWindows(enemies, friends, combat)` / `auditWindowTargeting` → offensive windows + targeting audit.
- `analyzeKickAudit(owner, enemies, combat)` → kick audit (juked).
- `getHpPercentAtTime(unit, t, startTime)` → HP percentage of any unit at a specific time (already used in the death path).
- `isHealerSpec(spec)` → identify enemy healer.

---

## Components

### 1. `buildOffensiveDeepDivePack(combat, finding, findingIndex, candidates, ownerName?): DeepDivePack | null`

New function, a sibling to `buildDeepDivePack`, outputting **the exact same `DeepDivePack` shape** (`deepen`/`prompt`/`audit` fully reused). Window anchoring is identical to the death path: `[min(eventIds.t)-30, max(eventIds.t)+10]`, filtered by `inWin`.

Collections within the window (all entering facts, numerical values via placeholders, names using `sn()` short names):

- **`target-hp`** — Enemy target health trajectory: points sampled via `getHpPercentAtTime(target, tPt)` within the window (mirroring the owner-HP split), facts `{t, hp, unit=sn(target), role:"enemy-target"}`.
- **`enemy-defensive`** — Defensives answering the burst (non-immunity): from the ledger `dominantTarget.defensivesHit.filter(!isImmunity)`, facts `{t, spell, unit=sn(target), role:"enemy"}`.
- **`immunity`** — Immunities: `defensivesHit.filter(isImmunity)`, facts `{t, spell, unit=sn(target), overlap, role:"enemy"}`.
- **`our-cc`** — Friendly outgoing CC against the **enemy healer**: `analyzeOutgoingCCChains` filtering target=enemy healer and caster∈friends, within the window, facts `{t, spell, unit=sn(enemyHealer), caster=sn(caster), role:"owner"|"teammate"}`.
- **`our-cd`** — Friendly offensive cooldown alignment: friendly offensive CD casts within the window (`extractMajorCooldowns` offensive tag, or ledger `allyCDsOverlapping`), facts `{t, spell, unit=sn(caster), role:"owner"|"teammate"}`.
- **Type-specific exclusive items** (inheriting built-in facts from candidates):
  - unconverted-burst → `off-target` if there are targeting issues; the core is the target-hp + enemy-defensive combination.
  - burst-into-immunity → `immunity` item (overlap seconds).
  - off-target-in-window → `off-target` item facts `{t, onTargetPct, target=sn, offTarget=sn(offTarget), role:"owner"}`.
  - juked-kick → `juked-kick` item facts `{t, kick, fake, role:"owner"}` + nearby enemy hard-casts within the window (`our-cd` not applicable, pulling enemy hard-cast context).
  - dr-clipped-cc → `dr-clip` item facts `{t, spell, target=sn, dr, role:"owner"}`, reusing the CC chain context of `our-cc`.

**Execution of the two categories (juked-kick / dr-clipped-cc) takes a subset**: They are point events, not laying out a full mirror—juked-kick pulls nearby enemy casts, dr-clip pulls CC chains. Conversion of the three categories (unconverted-burst / burst-into-immunity / off-target) takes the full mirror. (cd-waste is excluded, see background scope correction.)

Each category uses an independent `try/catch`; if advanced logs/geometry are missing, that category is absent (same as the death pack). Truncation reuses the "closest to focal moment" logic from the death pack (`PACK_MAX_ITEMS`).

`PackItem.kind` union extension: `| "target-hp" | "enemy-defensive" | "immunity" | "our-cc" | "our-cd" | "off-target" | "juked-kick" | "dr-clip"`.

### 2. Dispatcher

Add routing above `buildDeepDivePack` and `buildOffensiveDeepDivePack`: For each finding, check the candidate `type` referenced by its `eventIds`—

- Hits death/death-setup → Survival builder + `hasCoachableSignal`.
- Hits one of the 5 window-style non-death types → Offensive builder + `hasOffensiveCoachableSignal`.
- Mixed → Take the dominant one (majority of referenced candidates; ties favor death, as the death coaching value anchor is stronger).

The dispatcher is placed in the renderer's selection logic (see Component 4), not inside the builder (separation of concerns, same as placing the fix 1 gate on the caller side).

### 3. `hasOffensiveCoachableSignal(items: PackItem[]): boolean`

Parallel to `hasCoachableSignal`. Non-death candidates are already pre-curated as mistakes, so the gate is light—requiring an offensive story to be present:

- Has `target-hp` bottoming out at a certain threshold (e.g., ≤35%) **and** an `enemy-defensive` or `immunity` answered it → "Should swap/should wait/should CC healer" story is established; or
- Has an `off-target` item (hit rate is already below good); or
- Has a `juked-kick` item; or
- Has a `dr-clip` item.
  Criteria entirely use pack facts, sharing the same source as the candidate pre-curation.

### 4. Seat Selection (renderer, `StructuredAnalysisPanel.tsx`)

- Survival: Still takes the top `DEEP_DIVE_MAX=2` passing `hasCoachableSignal` sorted by severity.
- **1 Guaranteed Seat**: Picks the best 1 among non-death findings (passing `hasOffensiveCoachableSignal`; if multiple, sorted by candidate severity/damage to take top-1).
- Merges ≤3 packs, via **a single** `deepen()` call. `DEEP_DIVE_MAX` semantics remain unchanged (survival limit), adding a new constant `OFFENSIVE_DEEP_DIVE_MAX=1`.

### 5. Prompt Extension (`buildDeepDivePrompt`)

The same prompt accommodates both survival + offensive packs (both entering deepen once). Additions:

- Offensive item legend (Add a line to HARD RULES, explaining what target-hp/enemy-defensive/immunity/our-cc/our-cd/off-target/juked-kick/dr-clip each are, and role semantics).
- Offensive coaching framework: "you had the kill set up — coach what to change to close it(swap to the exposed target, hold burst past the immunity, lock their healer first)".
- Other disciplines remain unchanged (only reference pack keys, no raw numbers, no causality, clean window whitespace, firm verdict).
- `PROMPT_VERSION` 11→12 (invalidating old caches).

### 6. Audit

`auditDeepDives` **remains unchanged**: Placeholder resolution + raw number ban + causalLint + citedKeys⊆pack. Offensive numerical facts (hpStart/hpEnd/onTargetPct/dr/overlap) use placeholders; names use `sn()` short names to avoid realm number false positives.

---

## Data Flow

```
Initial findings
  └→ Dispatcher (routes by candidate type)
       ├→ Death category → buildDeepDivePack → hasCoachableSignal → ≤2 survival packs
       └→ Non-death category → buildOffensiveDeepDivePack → hasOffensiveCoachableSignal → ≤1 offensive pack
  └→ Merge ≤3 packs → Single deepen() → Single prompt (containing survival+offensive segments)
  └→ Model output → auditDeepDives (placeholders/raw numbers/causality/cited)
  └→ Render deep dive notes + chips (jumping to offensive window anchors)
```

---

## Testing

1. **Unit Tests** (`packages/analysis/src/analysis/offensiveDeepDive.test.ts` or merged into `deepDive.test.ts`):
   - `buildOffensiveDeepDivePack` produces the expected kind + facts (target-hp, enemy-defensive, immunity) on synthetic unconverted-burst / burst-into-immunity fixtures.
   - `hasOffensiveCoachableSignal`: target bottoms out+defensive answers → true; off-target → true; juked → true; purely neutral → false.
   - Dispatcher routing: death finding → survival; unconverted-burst finding → offensive; mixed → dominant.
2. **Deterministic Scan** (`packages/eval/scripts/deepDiveOffensiveScan.ts`, mirroring `deepDiveScan`): Run the full buildOffensiveDeepDivePack + gate on each non-death candidate in the corpus, asserting no crashes / missing roles / facts↔items inconsistencies / residual numbers (name-related), calculating pass rates per type and mean items per pack. Add `hpStart/hpEnd/onTargetPct/dr/overlap` to `NUMERIC_FIELDS`.
3. **Single Source Predicate Unit Test**: Assert that the offensive pack's target HP / defensives are identical to `analyzeBurstLedger` (or directly consumed, inherently from the same source).

---

## Large-Scale A/B Testing (Delivery Validation, User Emphasized)

Mirroring the positioning value eval (`deepDivePositionValue{Gen,Audit}.ts`), but comparing **before and after the offensive deep dive launch**:

- **before**: Non-death findings are not deep-dived (current state—seats all given to death, non-death silent).
- **after**: Offensive deep dive launched (guaranteed seat + offensive pack).
- **Corpus**: Public matches ≥200 (reusing `gladlog-eval-private/corpus` for deepdive-2v2 / 220 / hi / public-dps ≈578 files, deduplicated).
- **Generation**: Generate v12 offensive prompts for each non-death finding passing `hasOffensiveCoachableSignal`; sonnet responder produces deepDive JSON; reconstruct pack + auditDeepDives parsing.
- **Blind Grading**: sonnet + gemini (agy) blind grades actionability 1–5; unblind and bucket by type (3 conversion categories / 2 execution categories).
- **Control Anchor**: The same batch of death deep dives (survival bucket) enters blind grading, proving the judge's ruler is normal + offensive is not inferior to survival.
- **Metrics**:
  - Output rate (model true output post-gate vs honest whitespace vs failed audit), per type.
  - Value mean (combined + per judge), offensive vs survival control.
  - **Zero filler hard metric** (neither judge gives ≤2 points), same as fix 1+2 standards.
  - Net new coverage: How many non-death findings now have deep dives (silent before).
- **Decision Rule**: If the offensive deep dive value mean falls in the actionable zone (≥3.5) and zero filler → launch is validated; if a certain type is systematically low/filler → tighten the gate or demote that type (no spec customization parameters, user ironclad rule).

---

## Boundaries / YAGNI

- **No Global Anchoring** (BACKLOG #13): Offensive deep dives remain a magnifying glass—gathering evidence only within the windows of non-death findings already marked in the initial round, not globally scanning for new problems. Global discovery is an independent brainstorm.
- **Execution of the two categories takes subset evidence**, not a full mirror (user confirmed).
- **cd-waste excluded**: whole-round + survival category, no window anchor, does not enter this design (added to backlog).
- **No Spec Customization Parameters**: Gate thresholds are entirely spec-agnostic.
- Offensive packs fail gracefully without throwing when advanced logs (missing coordinates/detailed damage) are absent.
