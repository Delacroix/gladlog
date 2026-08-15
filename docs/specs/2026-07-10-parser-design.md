# gladlog Subproject 1: Combat Log Parser Library — Design Spec

Date: 2026-07-10
Status: Pending User Review
Parent Document: [2026-07-10-clean-rewrite-roadmap-design.md](2026-07-10-clean-rewrite-roadmap-design.md)

## Goals and Non-Goals

**Goals**: Implement a WoW combat log parser library from scratch, covering **Retail Arena (2v2/3v3) and Solo Shuffle**; freely design the data model; build a thin adapter layer to allow existing downstream code (AI analysis, eval toolchain) to integrate with minimal changes; use the old pipeline as a private differential oracle, aligning core facts and key derived metrics.

**Non-Goals**: Battlegrounds (including Blitz), Classic log branches, uploading/cloud, replay integration. Downstream consumers have never subscribed to events like `malformed_arena_match_detected`/`parser_error`/`activity_started` from the old parser, so they are excluded from the adapter surface (diagnostics will be designed separately, see Error Handling).

**Compliance Boundaries (Hard Constraints)**: Implementers (agy or subagent) **must not read the old parser's source code**. Allowed inputs are strictly limited to: this spec, publicly available community documentation on Blizzard's log format (wowpedia COMBAT_LOG_EVENT), real log samples, and the downstream consumer inventory (Appendix A). Interface/field names and enum values in the downstream inventory are "API facts already referenced by your code" and can be replicated according to Appendix A; implementation logic must be completely original.

## Data Model (All New)

Naming prefix `Glad*`, independent of the upstream naming system. All timestamps are epoch ms after timezone parsing.

```ts
// L1 Product
interface LogRecord {
  timestamp: number;
  eventName: string; // e.g., 'SPELL_CAST_SUCCESS'
  params: string[]; // Raw parameters (quotes stripped, nesting split by top-level commas)
  raw: string; // Original raw line
}
// Event Family Decoding (dispatched by eventName within L1):
//   Base Triplet: srcGuid/srcName/srcFlags/destGuid/destName/destFlags
//   Spell Family: spellId/spellName/spellSchool
//   Damage/Heal Family: amount/overkill|overheal/absorbed/critical + advanced payload (actorGuid/ownerGuid/hp/maxHp/x/y/…)
//   Aura Family: auraType('BUFF'|'DEBUFF'), amount?
//   Extra-Spell Family (INTERRUPT/DISPEL/STOLEN): extraSpellId/extraSpellName
//   COMBATANT_INFO: Structured JSON-ish payload (talents/pvpTalents/equipment/teamId/specId/rating/auras)
//   ARENA_MATCH_START/END, UNIT_DIED, PARTY_KILL, ZONE_CHANGE

// L3 Product
interface GladUnit {
  id: string; // GUID
  name: string;
  ownerId?: string; // Pet → Owner
  kind: UnitKind; // Player | Pet | Guardian | NPC | Object | Unknown
  reaction: Reaction; // Friendly | Hostile | Neutral (from the perspective of the log owner)
  classId: number; // Blizzard class ID; 0=Unknown
  specId: number; // Blizzard spec ID; 0=Unknown
  info?: GladCombatantInfo; // Players only
  damageOut: GladHpEvent[];
  damageIn: GladHpEvent[];
  healOut: GladHpEvent[];
  healIn: GladHpEvent[];
  absorbsOut: GladAbsorbEvent[];
  absorbsIn: GladAbsorbEvent[];
  casts: GladSpellEvent[];
  petCasts: GladSpellEvent[];
  auraEvents: GladAuraEvent[];
  actionsOut: GladSpellEvent[];
  actionsIn: GladSpellEvent[];
  deaths: GladDeathEvent[];
  advancedSamples: GladAdvancedSample[]; // hp/maxHp/x/y sampling
}
interface GladCombatantInfo {
  teamId: number;
  specId: number;
  personalRating: number;
  talents: unknown[];
  pvpTalents: unknown[];
  equipment: unknown[];
  interestingAuras: { casterGuid: string; spellId: number }[];
}
interface GladMatchBase {
  id: string; // Content hash
  bracket: string;
  zoneId: string;
  startTime: number;
  endTime: number;
  units: Record<string, GladUnit>;
  playerId: string; // Log owner GUID
  playerTeamId: number;
  winningTeamId: number | null;
  result: MatchResult; // Win | Lose | Draw | Unknown
  linesTotal: number;
  linesDropped: number;
  rawLines: string[];
  hasAdvancedLogging: boolean;
  timezone: string;
}
interface GladMatch extends GladMatchBase {
  kind: "match";
} // 2v2/3v3
interface GladShuffleRound extends GladMatchBase {
  kind: "shuffleRound";
  sequenceNumber: number;
}
interface GladShuffle {
  kind: "shuffle";
  rounds: GladShuffleRound[];
  startTime: number;
  endTime: number;
  rawLines: string[];
}
```

Event objects (`GladSpellEvent`/`GladHpEvent`/`GladAuraEvent`/…) common fields: `timestamp`, `eventName`, `spellId`, `spellName`, `srcId`/`srcName`, `destId`/`destName`; HP events also include `amount` (raw) and `effectiveAmount` (effective amount deducting overkill/overheal, semantics: effective = amount - overkill|overheal, lower bound 0); absorb events include `absorbedAmount`; extra-spell events include `extraSpellId`/`extraSpellName`; advanced sampling includes `hp`/`maxHp`/`x`/`y`.

## Three-Tier Pipeline

**L1 Line Parser** `parseLine(line, {timezone}): LogRecord | null` — Stateless pure function. Responsibilities: Timestamp parsing (current format includes year `7/2/2026 13:38:30.8888`; resolved to epoch ms based on timezone param), top-level CSV splitting (handling commas inside double quotes, `[]`/`()` nesting), and decoding event family parameters by eventName. Never throws exceptions on any input; returns null if unparseable. Unknown event names yield a generic LogRecord (params kept as-is).

**L2 Match Segmenter** `Segmenter` — State machine taking LogRecord stream as input, outputting `Segment { records, rawLines, kind }`. Rules:

- **(2026-07-10 Probe Validation, Correcting Original Assumptions)** Shuffle structure = **One `ARENA_MATCH_START` per round (bracket='Rated Solo Shuffle'), one `ARENA_MATCH_END` for the entire match**. Rules:
  - Non-shuffle bracket (2v2/3v3): START opens buffer; encountering another START → discard previous segment (diagnostic `DOUBLE_START`) and restart; END closes.
  - Shuffle bracket: Regions between consecutive STARTs are rounds; END closes the final round and finalizes the whole match; number of rounds can be <6 (early leaver is legal, empirical fixture only has 2 rounds); winningTeamId=255 on END acts as a "no winner" sentinel.
  - Every START is immediately followed by 6 COMBATANT_INFO lines, **teamId is reassigned every round** — roster/reaction must be processed per round.
  - Reload signal = encountering `COMBAT_LOG_VERSION` in the stream (+ `ZONE_CHANGE` in the same zone); do not terminate ongoing match/round sequences, skip as noise (empirically: rounds continue normally after reloads). Residual risk of dropped lines during a reload mid-round: rely on the next START/END to naturally recover state, T1 diff will measure its scale.
  - `UNIT_DIED` with final param =1 is feign death/unconscious (empirically: Hunter Feign Death), **does not count as a true death**; the logical outcome of a round is determined by the first player death where final param=0, but segment boundaries are still governed by the next START/END.
- EOF/Timeout (configurable, defaults to 30 mins with no new lines): Unclosed segments are discarded with a diagnostic.
- **Edge Case Behavior Contract (M2 Pre-probe Output, revised via agy debate)**: For the four known dirty log scenarios (`double_start`, `one_match_synthetic_no_end`, `shuffle_reloads`, `shuffle_early_leaver`), the first step of M2 is using a probe script to empirically verify "what exactly happens in the log" on the corresponding fixture and self-collected logs (e.g., is START re-emitted after a reload? how do rounds close after an early leaver?), and accordingly write down a **behavior contract** for each scenario (which data is recoverable, what is dropped, which diagnostic code is incremented for drops); L2's acceptance = behavior matches the contract, rather than "100% recovery". Any data loss must be reflected in diagnostic counts, silent drops are forbidden. Heuristic recovery like "synthesize segment if no START" will not be included in v1 — the T1 diff will expose the true scale of such losses, and we will initiate it later if the scale is significant.

**L3 Match Builder** `buildMatch(segment): GladMatch | GladShuffle` — Independent reducer modules split by dimension, one file each, consuming records one by one:
`roster.ts` (unit registry, GUID→kind/reaction inference, pet ownership) / `combatantInfo.ts` / `hpEvents.ts` / `auras.ts` / `casts.ts` / `deaths.ts` / `advanced.ts` / `outcome.ts` (match outcome: END parameters + team death facts). `composeMatch.ts` for assembly + content hashing.

- Reaction inference: Determined relatively using COMBATANT_INFO's teamId versus the log owner (the first player with advanced actorGuid=srcGuid, or the first COMBATANT_INFO entry after START; determined empirically); must be able to yield a result without relying on flags, with flags used for cross-validation.

**Public API**:

```ts
class GladLogParser {
  constructor(opts?: { timezone?: string; wowVersion?: 'retail' });  // wowVersion is purely a passthrough placeholder
  push(line: string): void;
  end(): void;                                 // flush EOF diagnostics
  on(event: 'match', cb: (m: GladMatch) => void): this;
  on(event: 'shuffle', cb: (s: GladShuffle) => void): this;
  on(event: 'diagnostic', cb: (d: Diagnostic) => void): this;
  stats(): { linesTotal: number; linesDropped: number; segmentsDropped: number };
}
parseText(text, opts): { matches, shuffles, diagnostics }            // Convenience function
parseFile(path, opts): Promise<same>                                 // Node-only entry point, streaming read
```

Includes a minimal internal emitter (core has zero runtime dependencies, no Node API; `parseFile` is exposed via the `@gladlog/parser/node` sub-entry).

## Adapter Layer `@gladlog/parser-compat`

Independent package, the only place that knows about the "old shape". Self-defines the interfaces required downstream (**Appendix A is the sole source of truth for the contract**, do not import upstream), exporting:

- Types: `IArenaMatch`/`IShuffleRound`/`IShuffleMatch`/`AtomicArenaCombat`/`ICombatUnit` (minimum field set from Appendix A) + event structure types + all enums (full `LogEvent` with ~48 members, exact string values for `CombatUnitSpec` like `Priest_Holy='257'`, `CombatUnitReaction/Type/Class`, `CombatResult`, `SpellTag`, `CombatUnitPowerType`). Enum string values must match game facts like Blizzard IDs or event names.
- Conversions: `toLegacyMatch(m: GladMatch): IArenaMatch`, `toLegacyShuffle(s: GladShuffle): IShuffleMatch`. `winningTeamId` becomes a first-class typed field (fixing the historical baggage of any-casting downstream, to be updated synchronously when migrating consumers).
- Entry point proxying: `class WoWCombatLogParser` (constructor `(wowVersion, timezone?)`, `.parseLine()`, events `arena_match_ended`/`solo_shuffle_ended`) wrapping `GladLogParser` — covering all 7 existing call sites, migration entails simply renaming the imported package.
- Utilities: `getUnitType(flag)`/`getUnitReaction(flag)` (bit flag decoding, flag bit meanings are facts from Blizzard documentation).
- **`classMetadata` is excluded from this package**: It is a manually maintained data compilation from upstream and cannot be taken along. The compat package exports the `IClassMetadata` type and an injection point `setClassMetadata(data)`, while the actual data payload will be built in Subproject 5 (during the transition, downstream features relying on it will explicitly report "data not ready").

## Differential Testing (Acceptance Core)

**Location**: `scratch/parser-diff/` in the old fork (private use of the old parser is compliant; tools and results won't enter the gladlog repository, though report conclusions can).

**Two-Level Alignment**:

1. **Core Facts**: For the same log, normalize the outputs of both the new and old pipelines into an identical JSON shape (number of matches and rounds, bracket/zoneId, unit roster with kind/spec/teamId, outcome, per-unit death counts and timestamps, per-unit total damage/heal effectiveAmount, frontline event counts) before diffing. Goal: 100% consistency on T1 corpus; discrepancies must be adjudicated one by one — **the old parser is not the unconditional truth**, differences are judged against the raw log. When the new parser is correct, document the "old pipeline defect" in the diff report instead of altering new code to accommodate it.
2. **Derived Metrics** (revised via agy debate): Outputs from both sides are fed via compat (the old side operates as an identity function) into the React-free `buildMatchContext` from the old fork. Contrast their **structured context objects before string concatenation** (canonicalization: concurrent events with the same timestamp must be stably sorted by (timestamp, eventName, spellId, srcId) before diffing) to avoid large-scale text-scrambling false positives caused by differing underlying array iteration orders; text diffs of prompts are relegated to smoke signals. Automatically covers all derived metrics including CC chains, pressure windows, DRs, etc. **Acceptance criteria: every diff is adjudicated, unresolved diffs = 0** — NEW_CORRECT (new right, old wrong) scenarios are whitelisted, keyed by root cause (spellId/event type), backed by log evidence, and logged as "old pipeline defect"; NEW_WRONG dictates fixing the new code. Do not use LLMs to assess semantic degradation: deterministic checks take precedence over LLM judgment (a core project eval discipline).

**Corpus Stratification**:

- **T0** (runs on every test): 14 upstream `.txt` fixtures (Blizzard output, portable; old `.test.ts` assertion files are not portable, but their filename-indicated behavioral intents—double_start, no_end, early_leaver, reloads, dedup—serve as the test scenario manifest for the L2 state machine) + several manually constructed synthetic lines.
- **T1** (Regression): Stratified sample of ~200 logs by bracket × spec × duration from the self-collected corpus (`benchmarks/logs/` 5,160 items + `playstyle-logs-cache/` 1,050 items, ~104GB total), fixed manifest.
- **T2** (Milestone One-off): Full sweep, validating only "zero crashes + reasonable diagnostic counts + self-consistent core facts", skipping match-by-match diffs.

## Error Handling and Performance

- `push()` never throws exceptions; bad lines increment `linesDropped` and emit a `diagnostic` (line number, reason code); bad segments are discarded and emit a diagnostic. Diagnostic reason code enum: `BAD_TIMESTAMP`/`BAD_CSV`/`UNKNOWN_EVENT_SHAPE`/`UNCLOSED_SEGMENT`/`DOUBLE_START`.
- Performance: T1 single-file throughput ≥ 50k lines/sec (M-series Mac benchmark, vastly exceeding real-time tail needs; the old parser operated at a few thousand lines/sec and should not serve as a ceiling); `parseFile` is streaming, memory is O(current segment). Benchmark scripts will be checked into the repo, with numbers included in CI artifacts.
- TS strict, `noUncheckedIndexedAccess`; core package has 0 runtime dependencies.

## Repository Layout and Implementation Approach

```
gladlog/
  package.json           # npm workspaces
  packages/parser/       # @gladlog/parser  (src/l1 src/l2 src/l3 src/api node子入口)
  packages/parser-compat/# @gladlog/parser-compat
```

Implementation follows the user's established workflow: **Specific code should preferably be dispatched to agy (`agy exec`) for writing** (each dispatch must include complete task code/precise interfaces, and outputs must be spot-checked), falling back to cheaper subagent models if agy quota is exhausted; architecture decisions, reviews, and integration are handled by Claude. TDD: Write failing tests (vitest) first for every L1 event family / L3 reducer.

## Milestone Breakdown (Independently Verifiable)

M1 L1 Line Parser + T0 synthetic line tests + 104GB signal-to-noise ratio sweep (revised via agy debate: typed decoding success rate on non-empty lines ≥ 99.9%, unknown event rate reported separately, coverage stats per event family — parsers returning null across the board cannot pass; "zero crashes" is merely a prerequisite, not a metric)
M2 L2 Segmenter (including shuffle round boundary empirical validation) + T0 scenario tests
M3 L3 Reducers + GladMatch Assembly + T0 golden assertions
M4 compat package + diff harness + T1 two-level alignment
M5 Performance Benchmarks + T2 Sweep + Diff report finalization

## Design Decision Debate Log (agy debate ritual)

2026-07-10, conversation `f62c2649`, two rounds (PARTIAL → OPPOSE), all three points absorbed into the spec:

1. **Concession: M1 "zero crashes" is a vanity metric** — measuring crash rates in a system architected to swallow exceptions is meaningless, as it could pass by returning null on everything. Revised to use signal-to-noise metrics (≥99.9% typed decoding success rate + unknown event rate + event family coverage).
2. **Concession: L2 commitments were self-contradictory** — it cannot promise to pass reload/early-leaver fixtures while hardcoding "discard if no START". Revised to "probe empirical validation → behavior contract → acceptance = contract adherence", with heuristic recovery deferred until differential data proves its necessity.
3. **Concession: Prompt text diffs would be drowned in concurrent event sorting noise** — revised to comparing structured context objects before string concatenation + canonical sorting; text diff relegated to smoke test. **Defense upheld**: Refused to use LLM evals for acceptance (agy's first round suggestion), prioritizing deterministic regression signals — agy accepted this in the second round.

---

## Appendix A: Adapter Layer Minimum Contract (from 2026-07-10 downstream consumer reconnaissance, 90 consumer files)

| Category           | Must Provide                                                                                                                                                                                                                                         | Explicitly Cut (Zero downstream references)                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Entry Points       | `new X(wowVersion, timezone?)`, `.parseLine(line)`, events `arena_match_ended`+`solo_shuffle_ended`                                                                                                                                                  | `.flush()`, `.resetParserStates()`, all other events                                                  |
| Match Containers   | `startTime`,`endTime`,`units`,`startInfo.{bracket,zoneId}`,`playerId`,`playerTeamId`,`result`,`dataType`,`winningTeamId`,`rawLines`,`sequenceNumber`(round),`rounds`(shuffle match),`wowVersion`,`hasAdvancedLogging`,`durationInSeconds`,`timezone` | `endInfo`,`killedUnitId`,`scoreboard`,`shuffleMatchEndInfo`,`shuffleMatchResult`                      |
| Unit `ICombatUnit` | `id`,`name`,`ownerId`,`type`,`class`,`spec`,`reaction`,`info`(narrowed),`damageIn`,`damageOut`,`healOut`,`healIn`,`absorbsIn`,`absorbsOut`,`auraEvents`,`spellCastEvents`,`petSpellCastEvents`,`actionIn`,`actionOut`,`deathRecords`,`advancedActions` | `isWellFormed`,`affiliation`,`supportDamage*`,`supportHeal*`,`absorbsDamaged`,`consciousDeathRecords` |
| Actions            | `spellId`,`spellName`,`timestamp`,`logLine.{event,timestamp}`,`srcUnitId`,`destUnitId`,`srcUnitName`,`destUnitName`,`srcUnitFlags`,`destUnitFlags`,`spellSchoolId`                                                                                   | —                                                                                                     |
| Damage/Heal        | `effectiveAmount`,`amount`                                                                                                                                                                                                                           | `isCritical`                                                                                          |
| Advanced           | `advancedActorCurrentHp`,`advancedActorMaxHp`,`advancedActorPositionX/Y`,`advanced`                                                                                                                                                                  | `advancedActorPowers`,`advancedActorFacing`,`advancedActorItemLevel`,`advancedOwnerId`                |
| Absorbs            | `absorbedAmount` + inherited `effectiveAmount`                                                                                                                                                                                                       | `critical`,`shieldOwnerUnit*`,`shieldSpell*`                                                          |
| Extra-Spell        | `extraSpellId`,`extraSpellName`                                                                                                                                                                                                                      | —                                                                                                     |
| CombatantInfo      | `teamId`,`talents`,`pvpTalents`,`equipment`,`personalRating`,`specId`,`interestingAurasJSON`                                                                                                                                                         | ~20 raw attribute fields                                                                              |
| Enums              | `LogEvent`(full),`CombatUnitReaction/Type/Class`,`CombatUnitSpec`(exact string values),`CombatResult`,`SpellTag`,`CombatUnitPowerType`                                                                                                               | `CombatUnitAffiliation`                                                                               |
| Data/Utils         | `getUnitType(flag)`,`getUnitReaction(flag)`; `IClassMetadata` type + `setClassMetadata` injection point (data payload = built separately in Subproject 5)                                                                                            | All other exports (hash/query/dps helpers, etc.)                                                      |

Complete reconnaissance report (per-field reference counts, 7 call site locations, corpus inventory details) is stored in the old fork at `scratch/parser-consumption-inventory.md`.

## Unresolved Matters

- Exact signals for Shuffle round boundaries: Handled via empirical probe validation in the implementation plan (M2 prerequisite step).
- Stratification dimension weights for the T1 sampling manifest: To be determined in the implementation plan.
