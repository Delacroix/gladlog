# Parser M3: L3 Match Builder — Implementation Plan

> Working method identical to M1/M2: contract tests = written by controller; implementation = agy exec (fallback haiku); forbidden from reading legacy parser source code; commit per task.

**Goal:** `buildMatch(segment) / buildShuffle(close)`: L2 Segment → `GladMatch` / `GladShuffle` conforming to spec data model, split into reducer files by dimension.

## Key Determination Rules (Blizzard Facts, Hardcoded as Contract)

- **unitFlags Bit Meanings** (wowpedia UnitFlag): affiliation `0x1`=MINE / `0x2`=PARTY / `0x4`=RAID / `0x8`=OUTSIDER; reaction `0x10`=FRIENDLY / `0x20`=NEUTRAL / `0x40`=HOSTILE; type `0x100`=PLAYER controlled / `0x200`=NPC controlled; object type `0x400`=PLAYER / `0x800`=NPC / `0x1000`=PET / `0x2000`=GUARDIAN / `0x4000`=OBJECT.
- **Log Owner** = First unit in segment with `(flags & 0xF) === 0x1` and GUID prefix `Player-`.
- **unit.kind**: GUID prefix precedence (`Player-` / `Pet-` / `Creature-`), cross-validated with object-type bits; `Creature-` and `0x2000` → Guardian.
- **unit.reaction**: Majority vote of reaction bits in flags appearing for this unit across the segment; cross-validated with teamId (owner's teamId side = Friendly).
- **True Death** = `UNIT_DIED` where last parameter = 0 and `dest.kind = Player`; last parameter = 1 (Feign Death) goes into `unconsciousEvents` instead of `deaths`.
- **Outcome (Win/Loss)**: match → END `winningTeamId` vs `playerTeamId` → Win/Lose; 255/missing → Unknown. shuffleRound → opposing team of first true death in round wins; no death → Unknown. shuffle overall match result attached to END.
- **classId / specId**: specId comes from CI for that unit; classId mapped via specId → class lookup table (Blizzard facts, ~40 entries hardcoded in `data/specToClass.ts`). Missing CI (e.g. pet / unknown) → 0.
- **Pet Attribution ownerId**: `ownerGuid` in advanced payload (non-zero value).

## Tasks (Each = Contract Test + agy Implementation + Acceptance + Commit)

1. **types + specToClass table**: `src/l3/model.ts` (GladUnit / GladMatch / GladShuffleRound / GladShuffle / event object types per spec) + `src/l3/data/specToClass.ts`. Tests: lookup table spot-check (257 → Priest, etc., 10 total) + typecheck.
2. **flags utilities + roster reducer**: `src/l3/flags.ts` (`decodeFlags → {affiliation, reaction, kind}`) + `src/l3/roster.ts` (register unit, owner determination, reaction majority vote, pet attribution). Synthetic tests + DAMAGE/CAST real-line assertions (owner=Vierforfear, etc.).
3. **Event collection reducers**: `src/l3/collect.ts` (collect hp / aura / cast / extraSpell / absorb / death / advanced arrays into corresponding units, including petCasts attributed to master). Synthetic line assertions for each array's content and `effectiveAmount` pass-through.
4. **outcome + composeMatch**: `src/l3/outcome.ts` + `src/l3/compose.ts` (`buildMatch` / `buildShuffle`, content hash = FNV / SHA simplified implementation on `rawLines`, `linesTotal` / `linesDropped` injected from `GladLogParser` stats). Synthetic tests: all branches of outcome rules (Win / Lose / 255 / deathless round).
5. **Fixture Golden Assertions + API Upgrade**: Upgrade `GladLogParser` events to `match` (`GladMatch`) / `shuffle` (`GladShuffle`) (retaining segment-level events internally); fixture tests: `one_solo_shuffle` → 6 rounds each with `units=6` players, round 1 true death = `Kyberz@22:13:22`, 3 Feign Deaths do not enter deaths, per-round teamId reassignment; `early_leaver` → 2 rounds, match result Unknown; `two_matches` → 2 matches with correct win/loss.
6. **10-File Real Log Smoke Test**: tsx script running first 10 files from `playstyle-cache`, asserting 0 exceptions, reasonable unit counts per match (2v2=4 / 3v3=6 / shuffle round=6), print diagnostic counters. Record results in ledger.

## Definition of Done

- All tasks green + typecheck; fixture golden assertions pass; smoke test 0 exceptions.
