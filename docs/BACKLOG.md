# gladlog feature backlog

Ideas not yet scheduled. Each is a starting point for a future brainstorm → spec →
plan cycle, not a committed design. Compliance: where an item references the old
fork (`/Users/mingjianliu/code/wowarenalogs`, CC BY-NC-ND) it's for the _concept_
only — any port is clean-room (controller extracts audit-CLEAN files; the app's
data is already gladlog-native).

---

> Completed items (#2-13, #15, #16, #20, multi-model, spellNames, etc.) have been moved to
> [BACKLOG-archive.md](BACKLOG-archive.md), retaining original numbering and landing notes.

## 1. OBS / video recording integration

Record arena matches (video) and sync playback to the combat-log timeline — click
a death / finding / burst window and jump to that moment in the video.

> **2026-07-27 evaluation complete (not yet approved)**: three approaches (external control via obs-websocket / embedded noobs /
> two-phase) + seam-by-seam verification + risk inventory documented in
> `docs/plans/2026-07-27-obs-recording-integration-eval.md`, leaning toward two-phase starting with external control.
>
> **2026-07-28 phase 1 started (approach C approved)**: external control via obs-websocket, `feature/obs-recording`
> branch; plan at `docs/plans/2026-07-28-obs-recording-phase1-plan.md`. All unit tests green;
> real-machine (Windows + OBS) end-to-end awaiting user testing.

- **Old-fork reference:** `packages/recorder` (OBS bindings — `manager.ts`,
  `noobs.d.ts`, `activity.ts`, config schema) and the playback UI in
  `packages/shared/src/components/CombatReport/CombatVideo/VideoPlayerTimeline.tsx`
  - `CombatReplay/`. The roadmap explicitly deferred the recorder ("not in v1"),
    so this is net-new work in gladlog.
- **Scope signals:** largest item here — a recorder subsystem (native OBS/noobs
  integration, Windows-first), on-disk video↔match association, and a
  video-timeline component. Likely its own multi-task sub-project. Decide first:
  drive OBS externally vs. embed a capture lib; how video files map to stored
  matches (by timestamp window).
- **gladlog seam:** the desktop app already stores matches with `startTime`/
  `endTime`; a recording started around a match window can be associated by time.

## Session follow-ups & hardening (smaller, not full features)

- **SP-A.1** — LLM-judge causal audit + digit/constant refinement (deferred from
  the SP-A honesty gate; causal/qualitative claims can't be verified
  deterministically).

- **Timeline-prompt token compression** — the timeline-variant prompt is ~76%
  larger than the sparse one; compress it (also helps the slow `claude -p` local
  backend).

- **CI code-signing / notarization** — wire macOS notarization + Windows signing
  secrets into `.github/workflows/build.yml` when certs exist, for zero-warning
  installs. See [[gladlog-packaging-gotchas]].

- **MatchStore hardening (accepted-low-risk today)** — `safeName` id collision →
  phantom duplicates; out-of-band `meta.json` edits go stale (index is a cache).
  Fine for the app-private store now; revisit if the store ever lives in a synced
  folder.

- **Residual items from archived entries (details in the corresponding sections of BACKLOG-archive.md)**: #10 three non-blocking minors (dampening swim-lane dead zone / panic predicate typo / resolveOwner convergence), #16 real-model filler smoke pending real machine, multi-model comparison stale slot placeholder state row and Export tearing.

## 17. Mitigation numerical counterfactual trio (logged 2026-07-27, same thread as Bilibili user feedback)

User request (paraphrased from a warrior's perspective): after Shield Wall there's 20% magic damage reduction, "I don't know if 20% is enough" —
wants AI to numerically back-validate the experience-based conclusion drawn from a CC perspective (after stacking full DR, Shield Wall can skip Spell Reflect;
without full DR stacking, it's not enough); plus "possibility hints" that only rearrange skill timing/order while keeping established facts unchanged (using trinket
earlier → Shield Wall covers 2 casts instead of 1), not requiring 100% correctness — users will iterate through trial and error themselves.
"Not just a checklist of what hasn't been used yet."

Three sub-items, ordered by dependency:

1. **Unnecessary external determination** (can go first, small): enemy burst CDs all far away, no damage spike, target at full HP
   when casting Spell Reflect/externals → new candidate `questionable external`. Criteria already exist (enemy CD ledger +
   damage curve + `annotateDefensiveTimings`), currently Early is only defined as "N seconds before burst window",
   casts with no window and no pressure fall to Unknown and aren't flagged — just add one tier. Addresses user's "you can't just say my Spell Reflect usage was fine."
   ✅ Landed (2026-07-30: `questionable-external` candidate + MISTAKE_RULES dual registration, spec
   `docs/superpowers/specs/2026-07-30-counterfactual-design.md`; full-corpus fixed-seed empirical
   incidence rate 0.52% (cast-level, 25/4780 external casts hit all three negation conditions), not falling in either
   "criteria too strict ≈0" or "too broad >50%" stop zones, shipped with threshold per plan;
   `UNNECESSARY_TARGET_HP_PCT=80` is a prior value, pending user testing for tuning)
2. **Mitigation percentage table + per-school damage breakdown** (shared foundation for 1 and 3): each major mitigation's
   {percentage, school of magic} (Shield Wall 20% magic only, Ironbark 20% all, Spell Reflect 40%…). Follow
   [[official-data-over-heuristics]] via DB2 official fields, but need to empirically test coverage (same issue as the DR table).
   School field already exists in logs (`spellSchoolId`, parsed by parser-compat, not consumed by analysis layer).
   ✅ Table foundation (2026-07-30: MITIGATION_TABLE two-layer 35 entries with no third state, spec
   `docs/superpowers/specs/2026-07-30-mitigation-table-design.md`; school coverage
   quantified at 148/148 windows ≥90% attributable; per-school damage breakdown consumption deferred to #17 main body. Includes
   `positional?: true` contract — conditional mitigations (Darkness 196718) delegate positional check
   responsibility to #17 consumer when providing values; if not checked, must not be counted — see spec decision record item 4)
   ✅ Consumer landed (2026-07-30, see sub-item 3 notes): A/B/narrow-gate all three forms of arithmetic fully filter
   in-window hit damage by `schoolMask`, per-school damage breakdown is no longer a TODO.
3. **Death window arithmetic counterfactual + timing reorder enumeration** (large) ⚠ 2026-07-30 full-corpus quantification (1310 deaths): "available but unused" opening rate only 5.6% (rough estimate 79.7% was a kit-coverage denominator illusion, off by 13x), main form needs to pivot — "already-used mitigation audit" opening 33.2% / "external available but not given" 23.0%, see docs/reports/2026-07-30-counterfactual-feasibility.md; also discovered deathOutcome external whitelist 7≠14 and deathRecap zoneId shape suspected bug: actual damage stream N seconds before death × hypothetical mitigation
   × per-school, compared against (max HP + actual healing received), output three tiers — clearly survivable / borderline / still dead;
   only "clearly survivable" (margin > 15% max HP or similar hard threshold) opens up. Reorder enumeration narrowed to
   "each CC break point within the window × trinket/unused defensive" ~dozen combinations, only reporting the one clearly better option.
   ✅ A/B/narrow-gate arithmetic landed (2026-07-30, spec
   `docs/superpowers/specs/2026-07-30-counterfactual-design.md`): three-tier predicate single-source
   (`counterfactualTier`, same denominator as quantification report) + three forms (`computeMitigationAudit`
   already-used mitigation audit / `computeMissedExternalCounterfactuals` external available but not given /
   `computeUnusedSelfCounterfactuals` self available but unused narrow gate) land in death recap card deterministic
   display + `[DEATH]` prompt facts dual output (same arithmetic, facts floor to render
   seconds before entering text). B's two prerequisite fixes (external whitelist 7→14 convergence + deathRecap zoneId dual-fix)
   shipped with this round, see Task 2 commit (`ff8243e`) with before/after numbers on same criteria. **17c (timing reorder
   enumeration) not done this round, remains an open item** — decision record confirmed 17c deferred, not in scope for this round.

Note (deferred, unresolved): During Task 2 whitelist convergence verification, also discovered that `cooldowns.ts`'s
`FORBEARANCE_GATED_IDS` contains `633` (Lay on Hands), but that id is not in
`spellIdLists.externalDefensiveSpellIds`/`bigDefensiveSpellIds`/
`externalOrBigDefensiveSpellIds` any main whitelist (`ff8243e` concurrently removed the same 633 from
deathOutcomeAnalysis's off-list whitelist, reasoning "not in any main whitelist")
— the two treatments of 633 appear inconsistent, not yet determined which is correct (LoH is pure healing,
excluding it from mitigation/self-defensive wall whitelists may be correct, but Forbearance gating depends on it triggering the same
id), needs separate review before deciding whether to change — see git history (`ff8243e` and its discussion).
Wording follows the possibility framework ("if X were stacked in the same window, damage in that segment would drop below lethal threshold"), compatible with causalLint's
causal assertion prohibition — no gate changes needed. **Arithmetic is feasible, simulation is not**: healing behavior would change, opponents would switch targets — these are not modeled; confidence is expressed via tiers. Before starting, empirically measure two things in the corpus: death window school field
coverage rate; "clearly survivable" tier hit rate in real deaths — if 90% fall in the "borderline" tier, the opening rate
won't support a product form.

causalLint regex is English-only, zh output is a blind spot (discovered via agy 300-match simulation) — Chinese causal patterns need to be added.

---

## 18. arenacoach rule absorption batch 2 + batch 1 residuals (logged 2026-07-27)

Batch 1 (DEATH-001/003 + TRINKET-001) already merged (plan `docs/plans/2026-07-27-arenacoach-rules-batch1.md`,
corpus incidence rates 63.6%/14.1%/15.6%, n=1245). Full rule directory landscape and absorption assessment in that day's session conclusion;
batch 2 candidates sorted by whitelist cost:

1. **DEATH-002 immunity available at death**: needs immunity sub-table + Hypothermia-class shared debuff ledger
   (Forbearance has precedent via `FORBEARANCE_GATED_IDS`/`selfForbearanceActiveAt`).
2. ✅ **COOLDOWN-001 CC held >90s**: offensive version of cd-waste, criteria already exist (`availableWindows` ×
   `ccSpellIds`). Merged in 2026-08-06 signal expansion batch 1 (candidate type `cc-held`, threshold set by corpus empirical evidence from
   "60/90s pick one" to 90s — at the 60s threshold, 23% of all CC available windows naturally exceed the line, mixing in too many
   normal cast rhythm gaps). Design in
   `docs/superpowers/specs/2026-08-07-signal-expansion-batch1-design.md`.
3. ✅ **DEFENSIVE-001 healer eats full CC (had avoidance tools)**: merged 2026-08-07 (candidate type
   `cc-avoidable`, table 100% reuses existing `ccTrinketAnalysis.ts`'s
   `CC_AVOIDANCE_BUFF_SPELLS`/`REPOSITIONING_SPELL_IDS`, zero new tables), after excluding overlap with
   `trinketState=available_unused` (64.3%, already covered by `cc-locked`/`wasted-trinket`)
   corpus rescan yielded 96 entries (pre-cap) / 78 entries (post cap 2/round) / hit rate 9.3% of rounds (59/635).
   Design in `docs/superpowers/specs/2026-08-07-defensive-001-design.md`.
   ❌ **DEFENSIVE-002 low HP not cycling minor mitigations: vetoed by data 2026-08-07** (same design doc) —
   widest threshold (HP<50%) hit rate only 1.1% (3/264 judgable rounds), below batch 1's `healing-gap`
   5.3% precedent line; Discipline Priest (194/194 rounds) and Holy Priest (60/60 rounds) under
   `MITIGATION_TABLE` minor mitigation subset have structural 100% zero applicability; Discipline's nominally sole
   applicable Power Word: Barrier saw only 8 successful casts across 808 matches globally — effectively nonexistent. No new
   type added, no field dimensionality upgrade, no longer waiting for user to approve threshold.
   ✅ **DEFENSIVE-003 slow response to enemy burst**: merged 2026-08-11 (candidate type
   `slow-defensive-response`, healer-owner exclusive). Pressure gate empirical selection: absolute damage gate
   300k has no discriminative power at window scale (95.7% of burst windows pass, window span p50=21.6s), switched to the window's
   built-in `damageRatio >= 1.5` (rate-based, 20.2% of windows pass); response set =
   `MAJOR_DEFENSIVE_IDS` ∪ trinkets ∪ `REPOSITIONING_SPELL_IDS` ∪ hard CC against enemies
   (`destUnitId` attribution), zero new tables; threshold 8s set by corpus distribution tiers (response
   delay for pressured + has-tools + not-CC'd rounds p50=6.9s / p75=12.1s, 3s/5s tiers would classify median behavior as mistakes — cc-held rejected
   60s tier with same logic); exemption gates = pre-wall (shared `PRE_WALL_SECONDS`) + no tools available at window start
   (`cdAvailableAt`) + owner CC'd (covered by cc-locked) + windows with render span < 8s don't owe a response; ±10s dedup gate (200-match empirical overlap 70.8%, above DEFENSIVE-001's
   gating precedent of 64.3%). All determinations made on the render grid (agy flash review of 5 same-family cases
   all accepted: delay/pre-wall/window span/dedup boundary raw sub-second vs render-second drift).
   Full corpus rescan (810 matches / 2621 rounds, real production denominator): **76 entries (40 no-response / 36 slow, slow
   delayS p50=15s / p90=19s), round hit rate 2.9% (76/2621), menu share 0.48%**.
   200-match empirical script `packages/desktop/scripts/tmp-slowdef-rates.mts` — deleted after evaluation.
4. ✅ **DISPEL late/failed tiering**: merged 2026-08-06, but in a different form than originally envisioned — empirical evidence showed late
   dispels (≥3s) only account for 7.1% (69/972) of total dispels, volume can't support an independent candidate type, changed to field
   dimensionality upgrade on `missed-cleanse` (`latencySeconds`, only carried by late-dispel entries), no new type, no cap change. Same batch, same design doc.
5. **OFFENSIVE-001 cone ability whiff**: needs cone spell table + geometric determination, still an open item.
   ✅ **OFFENSIVE-002 bursting into major mitigation when should switch targets**: merged 2026-08-11 (candidate type
   `burst-into-mitigation`, reuses `MITIGATION_TABLE` (#17) + `analyzeBurstLedger`'s
   dominantTarget.defensivesHit (non-immunity) + `analyzeKillWindowTargetSelection`'s
   betterTargetExists — the latter's `windows` parameter narrowed to `Pick<...>`, fed a synthetic window
   assembled from the burst window's own time span/target, reusing the same soft comparison predicate rather than building a new one.
   `positional: true` entries (Darkness 196718) excluded per #17 spec decision record item 4 contract
   (positional check not implemented, if it can't be checked it must not be counted, consistent with `counterfactual.ts` existing approach). Production
   single-owner denominator (`resolveOwner`) shows 898/899 local corpus matches are healer-recorded, DPS-owner rounds
   0/0 — structural artifact of corpus composition, not the signal itself; rescanned using `deriveMistakes.ts` actual "each
   non-healer friendly as owner" denominator (1794 DPS-owner rounds): 225/1794 rounds
   (**12.5%**) hit ≥1 entry, 263 qualifying windows, mitigation spells not dominated by any single spell (11 types,
   highest Pain Suppression at 34.4% of raw hits). 200 matches / 899 sources zero-model deterministic scan,
   temporary script `packages/desktop/scripts/tmp-off002-rates.mts` — deleted after evaluation.

**2026-08-06 additions (not in the original 5-item list above, surfaced from same-day corpus empirical report)**:

- ✅ **HEAL-001 healing gap**: reuses existing `detectHealingGaps`, adding `freeCastSeconds>=4` and
  `mostDamagedAmount>0` two gates. Candidate type `healing-gap`.
- ✅ **POSITION-001 positioning mistake**: reuses existing `computeOwnerPositionEvents` +
  `stayedInHadRealCost` (same predicate as deepDive.ts, three-state discipline unchanged). Candidate type
  `position-mistake`. MISSED_PUSH/CD_OUT_OF_RANGE have 0 incidence rate in local corpus (healer perspective dominant),
  keeping the check without removing (for future DPS perspective corpus).

> **2026-08-06 `#22` linked to wrap-up, but did not reach removal threshold**: items 2/4 above (CC held, DISPEL tiering)
> plus the added HEAL-001/POSITION-001, three new candidate types have landed, `#22`'s recorded
> `cc-locked`/`missed-purge`/`missed-cleanse`/`wasted-trinket` four-type share dropped from 58.6% to
> **50.0%** (200 matches / 899 sources rescan, same criteria, `extractCandidateFindings` direct call;
> `healing-gap` 53 entries, `position-mistake` 115 entries, `cc-held` 250 entries, closely matching design estimates
> 54/118/259; `missed-cleanse` increased from 500 to 570 entries due to DISPEL-002 latency field upgrade,
> increment of 70 aligns with empirical "69 late dispels"). Three new types combined account for **7.7%** (418/5453) of the menu
> — less than the originally envisioned 15-25%, because the three signals themselves have low corpus incidence rates (HEAL-001 is filtered by
> detectHealingGaps' own three-layer gate + 4s secondary filter; POSITION-001's MISSED_PUSH/
> CD_OUT_OF_RANGE are dead signals on healer-perspective corpus). **`#22`'s stopgap cap is not being removed with this batch** —
> batch 1 expansion share is insufficient to lift the gate, waiting for batch 2 (DEATH-002/OFFENSIVE types) to land before re-evaluating.

Batch 1 residuals (final/re-review deferred items):

- ✅ "available but unused at death" three divergent implementations converged (2026-07-29): matchTimelineSections'
  [DEATH] Unused (originally hand-calculated availableWindows hit), timelineHelpers'
  [DEFENSIVE AVAILABLE] (originally hand-calculated readyAt) changed to directly import and call `cdAvailableAt`;
  candidateFindings' death-unused-defensive/external-unused confirmed to already consume it.
  Semantic difference map: timelineHelpers' implementation is word-for-word equivalent to cdAvailableAt (zero semantic diff),
  matchTimelineSections' sole difference is availableWindows table's GRACE_SECONDS=3s
  short-window trimming (that trimming is designed for "cheaper alternative" suggestions, not applicable to death-time-point queries) —
  boundary difference only triggers in edge cases where window < 3s, does not constitute the "convergence must change output and which side is correct isn't self-evident" stop
  clause. Local corpus fixed seed (20260729) sampled 60 matches for timeline variant buildMatchContext before/after
  comparison (33 with relevant lines): [DEFENSIVE AVAILABLE] 0 matches changed; [DEATH] Unused
  1 match changed, 2 lines (1 diff group, same line from "(Unused: Spirit Walk)" to
  "(Unused: Astral Shift, Spirit Walk)"). Empirical verification direction confirmed: that match's Astral Shift was
  cast at 88.226s, cooldown 60s, readyAt=148.226s, death at 148.583s — ability was indeed ready for
  0.357s, old version trimmed the entire window (only 2.357s < GRACE_SECONDS) resulting in
  false negative, new version correctly catches it, direction confirmed "old implementation was false negative, new version is the fix." Anti-drift unit test
  `packages/analysis/test/cdAvailablePredicateConvergence.test.ts`: constructs 4 synthetic
  ledger groups (never used / just used not ready / already ready / two casts take most recent), simultaneously calls three consumers
  and `cdAvailableAt` itself asserting function-level consistency.
- ✅ Follow-up round (2026-07-29, same day): the "out-of-scope same-type duplication" review confirmed
  criticalMoments.ts three locations (`buildKillMomentFields`' mechanicalAvailability
  "on CD" text determination / interpretation's spentCDs / tieredOptions.unavailable's
  allDefensivesSpent) and matchNarrative.ts' `spentAtEnd` (`buildMatchFlow`
  Final Burst/Phase section) totaling 4 locations, all are single-time-point equivalents of `!cdAvailableAt(cd, t)`
  — mechanically replaced with direct `cdAvailableAt` calls, deleted local readyAt hand-calculations.
  **Liveness correction (previous "is live code" statement was inaccurate, corrected here)**: `identifyCriticalMoments`
  (internally calls `buildKillMomentFields`/`getOwnerCDsAvailable`/`buildDeathRootCauseTrace`)
  is indeed unconditionally computed in `buildMatchContext`, but its rendered text (CRITICAL MOMENTS section,
  including the three locations changed this round) only gets written to `lines` in the `useTimelinePrompt: false` (old sparse variant) branch
  — the timeline branch `return`s before rendering this code (code comment verbatim: "timeline
  branch returns before here and never renders, E2E tested old 139 matches → new 0"). Production side `analysisInput.ts`
  and `buildCorpus.ts` both default to `useTimelinePrompt: true`, meaning the current production pipeline never renders this
  section — **the 4 locations converged this round are in code that still exists but is not rendered by the current default pipeline, i.e. the sparse variant**
  (`buildMatchFlow` goes further: full-repo grep confirms zero call sites, purely
  `@deprecated`/`@internal` dead code). Using the same 60-match seed (20260729) with
  `useTimelinePrompt: false` to rebuild prompt before/after comparison: out of 60 directories only 1 combat's
  CRITICAL MOMENTS section hits text patterns related to this round's changes (small sample, because most
  moments' tieredOptions/mechanicalAvailability branches are empty anyway); that 1 case shows
  0 line changes. The real confidence comes from the anti-drift unit test (same
  `cdAvailablePredicateConvergence.test.ts`, expanded to 5 consumers, 4 synthetic ledger groups
  all passing) — the pre-change formulas at all 4 locations are word-for-word algebraically equivalent to `cdAvailableAt` (no GRACE_SECONDS-type
  boundary differences), zero drift is a provable necessary result, not coincidence.
  **matchNarrative.ts' `ownerDefsAvailableInWindow` (`buildMatchFlow`
  Post-Trade Window section, approx. lines 122-127) does not belong to this category — it's a "cast before window start
  `firstBurst.toSeconds` vs. whether it's ready by window end `midEnd`" dual-time-point
  check (takes the most recent cast at time t1, compares against t2 to check readiness), mechanically replacing with single-time-point
  `cdAvailableAt` would lose "new cast between t1→t2" type information and change behavior, so it was not touched.**
  Left for future generalization of cdAvailableAt to a dual-time-point predicate, or confirmation that the current state (the function itself is
  `@deprecated`/`@internal`, already superseded by `buildMatchArc`, only kept for test coverage) is the
  final form — not tracked as a residual from this round.
  Additionally, out-of-scope new finding: criticalMoments.ts' `getOwnerCDsAvailable` (approx. lines
  108-138) and `buildDeathRootCauseTrace` (approx. lines 218-249) also each hand-calculate the same
  readyAt formula; like the 4 locations this round, they only render in the sparse variant, not in this round's convergence scope
  — left as candidates for the next same-type convergence (if by then the sparse variant is still not on the production path, suggest evaluating
  whether the entire `identifyCriticalMoments` branch should be retired wholesale, rather than patching predicates one by one).
- victimCDs' Pick missing isThroughput (type tightening); reconstructEnemyCDTimeline rebuilt twice within
  extractCandidateFindings (perf); scan script inner try/catch missing failure count.

## 19. Self-built PvP log collection and unified storage (training corpus) (logged 2026-07-29) — step one (collection archival) landed 2026-08-01

Vision: build a product/pipeline for **balanced collection** of others' PvP combat logs with **unified long-term storage**,
as model training data — not on-demand filtered retrieval, but balanced sampling by a quota matrix of spec × bracket × rating tier,
eliminating "only collected popular specs / high brackets / certain days" corpus bias.

**Current state and constraints (2026-07-29 research findings, details in `.claude/skills/fetch-pvp-logs`)**:

- The only public source in the entire ecosystem = wowarenalogs.com feed (**third-party volunteer project, not self-owned** — we only
  forked its code; the prior compliance note in this repo stating "self-owned product" was incorrect, now corrected). Collection must be restrained:
  pagination cap 50, don't page through empty pages, polite rate limiting — communicate with maintainers before heavy usage.
- Feed retrieval window is only ~7 days (GCS objects ~30 days) — to accumulate, must **poll on schedule + self-store**,
  missing data is permanently lost. `fetchPvpLogs.ts`'s resume-from-checkpoint + manifest is already a seed implementation.
- Log timestamps lack year and use uploader's timezone, absolute time is in GCS meta header; matchId = md5 of first
  16KB of log, usable as global dedup key.

**Possible forms (not yet approved, for brainstorming)**:

1. **Polling archiver**: cron running fetchPvpLogs' quota matrix version (N matches/day per tier per spec),
   landing in own storage (local disk / object storage), manifest aggregated into queryable index.

   **✅ Implemented** (`scripts/archivePvpLogs.ts`, design in
   `docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`). Scope converged to
   collection only, no processing; quota matrix removed per user decision, changed to full collection (one match with 6 players = 6 spec observations,
   filtering by spec would cost more Firestore queries and discard 5/6 of samples).

2. **Self-owned upload client**: long-term, build own collection client (gladlog log-pipeline's cross-machine byte-exact
   relay is already a ready foundation), player-informed uploads, for true data sovereignty and retention policy.
3. **Training data pipeline**: dedup (matchId), filter by parser parsability, anonymization strategy (player names),
   unified schema with existing 794-match self-owned corpus and eval corpus.

Compliance note: WAL's logs are voluntarily publicly uploaded by players, but the **code** fork is CC BY-NC-ND;
review data-side compliance separately before using data for training/commercial purposes — don't conflate with code license.

## 21. 2026-07-31 full-week audit P2 deferred items

This week's full-repo audit (desktop services/main/IPC + analysis + corpus-tools) Important fixes already committed
are in corresponding commits; the following are items discovered during the audit, assessed as P2 (low risk / low incidence / requires real-machine verification),
logged but not scheduled:

1. ~~**DeathRecapCard not connected to inline icons**~~ ✅ Fixed (2026-07-31, `6d36798`, this log entry text wasn't struck through at the time, retroactively marked 2026-08-11 during review): `DeathRecapEvent` now has `spellId?: string` pipeline (five event construction points + `availableImmunities`/`missedExternals`), `DeathRecapCard.tsx` five locations displaying spell names (event table row / immunity available pill / teammate missed-external pill / mitigation audit row / counterfactual row) all connected to `ChipIcon`. Tests in `packages/desktop/test/report.deathrecap.test.tsx` (spellId pass-through assertion + known/unknown id icon rendering assertions).
2. **`isAvailableAt` is a third cooldown availability predicate**: `packages/analysis/src/utils/deathOutcomeAnalysis.ts:229`
   with `resetSpellIds` parameter, reads raw `unit.spellCastEvents`, semantically adjacent to `cooldowns.ts`'s
   `cdAvailableAt` but with different data source/denominator (third one, `FORBEARANCE_GATED_IDS`-type
   reset spells are the existing second). If `cdAvailableAt` adds reset-type spell support in the future, must
   converge simultaneously to prevent three cooldown availability predicates from continuing to drift.
3. **`DMG_SPIKE_THRESHOLD` (`packages/analysis/src/context/timelineHelpers.ts:475`,
   300k, prompt/swim-lane spike) vs. `DAMAGE_SPIKE_THRESHOLD` (`packages/analysis/src/utils/cooldowns.ts:917`,
   50k, timing determination) same-named near-synonyms with different values** — they are indeed different concepts (pressure swim-lane spike vs. single
   timing determination threshold) but names collide, recommend renaming one (e.g., `TIMING_SPIKE_THRESHOLD`)
   to prevent future misuse/wrong constant modification.
4. **`corpusLoader.ts` corrupted override silently falls back with no logging**: `packages/desktop/src/main/corpusLoader.ts`
   L44-58 per-path try/catch, `JSON.parse`/shape rough validation failure always `continue`s to next candidate,
   all failures result in `null` — user placing a bad file (e.g., hand-editing corpus JSON with typo) won't know why it didn't
   take effect, should add a warn log line in the `catch` branch (via `onLoaded` same callback pattern, without introducing
   electron-log dependency).
5. **`obsAutoConfig.ts:55`** `authRequired: raw.auth_required !== false` treats missing
   `auth_required` field as "password required" — when OBS config file schema drifts (field renamed/
   missing), it would falsely report "password required" instead of honestly reporting "uncertain", should change to three-state
   (`true`/`false`/`undefined` each handled separately).
6. **Local CLI backend (claude/agy) has no version detection**: `#12` already does zero-config detection, but if the detected
   binary is protocol-incompatible with expectations (old CLI version), failure surfaces as raw stderr output, with no version number/
   friendly message. Add lightweight `--version` detection + readable error when version is incompatible.
7. **OBS password / API key both stored in plaintext in `settings.json`** — evaluate upgrading to Electron
   `safeStorage`. Ecosystem consistency: OBS itself also stores passwords in plaintext in profiles, not urgent,
   logged for evaluation.
8. ~~**Shuffle mid-log rotation discards completed round's `shuffleCallback`**~~ ✅ Fixed (2026-08-15, `85f9d0e1`).
   Root cause: `Segmenter.end()` unconditionally discarded `this.rounds` while in `IN_SHUFFLE` state, regardless of
   how many rounds inside it had already fully closed out in the "next round's `ARENA_MATCH_START` already
   appeared" sense — both batch import (one parser per file, `parser.end()` called at end of file) and the
   desktop app's real-time monitoring rotation hit this path. Side finding along the way:
   `worker/pipeline.ts`'s `processFlush()` rotation branch never called `parser.end()` at all — it just discarded
   the old parser instance whole, so the analysis-side fix couldn't reach the real-time monitoring path on its
   own; fixed in tandem. Fix: `end()` now fires `shuffleCallback` once for the already-fully-closed rounds when
   `rounds.length > 0`, discarding only the genuinely truncated `currentSegment`; the `end` field uses the
   truncated round's own `ARENA_MATCH_START` line (real, not fabricated), with no `arenaEnd`, and
   winner/result fall back to the existing "Unknown" default. `quietSweep`/`teardown`'s `closeOpenSegment()`
   deliberately was NOT touched by this fix — the 40-minute silence valve depends on the same parser instance's
   state being untouched when a late, genuine END later arrives (already locked in by a regression test).
   **Honest incidence-rate disclaimer**: dropped `shuffleCallback`s were never persisted, so historical incidence
   can't be reconstructed retroactively — even though the corpus's meta index records `roundCount`, shuffles
   under 6 rounds happen legitimately in bulk from disconnects/early leaves, so they aren't a reliable signal
   for rotation, and retroactive counting doesn't hold up. The differential oracle gate
   (`gladlog-eval-private/oracle`) runs green, 0 new diffs.
9. **`quitLifecycle` (`packages/desktop/src/main/index.ts` / `quitLifecycle.test.ts`)
   only stops recording on exit**, AI analysis flow (DeepSeek fetch / CLI subprocess) not actively aborted.
   Low risk (connections naturally drop when host process exits), logged for completeness, not a bug.
10. **`fetch-pvp-logs` (`packages/corpus-tools/scripts/fetchPvpLogs.ts:24`) `BRACKET`
    has no validation** (typo value silently returns empty results, no error) **+ happy-path has no throttle sleep** (only
    error/backoff paths have delays). This is politeness hardening toward the third-party feed, not a functional bug.

11. **#16 honest empty results not cached, reopening same window re-incurs model call**: `packages/desktop/src/main/analysis.ts`'s
    `analyzeWindow` does not write disk cache for `audit-empty` (model honestly answers `[]`) — headless simulation
    (2026-07-31, 79 windows) shows ~22% of runnable windows hit this path, clicking "AI analyze this segment" again on the same window will
    make another model call. Consider caching empty terminal state (with version stamp) or UI-side hint.

## 22. Temporary rate limiting: dispel/trinket-type candidates per-round cap (logged 2026-08-06, TEMPORARY)

**Motivation**: 200-match candidate menu empirical test (healer perspective default owner — `extractCandidateFindings` defaults to
friendly healer), `cc-locked`/`missed-purge`/`missed-cleanse`/`wasted-trinket` four types combined account for
**64.0%** (3351/5233; `cc-locked` 1629, `missed-purge` 1062, `missed-cleanse`
569, `wasted-trinket` 91) of all candidate events, drowning healer perspective coach output in "all dispel/trinket", crowding out `death-setup`/
`external-unused`/`questionable-external` and nine other types' exposure. User approved: use hard per-round
caps as a stopgap first, **don't do the full signal expansion fix**, log this item pending removal after #18 batch 2 lands.

**Cap values** (`packages/analysis/src/analysis/candidateFindings.ts`, before truncation sort by respective severity
field descending — `missed-cleanse`/`cc-locked` by damage taken, `missed-purge` by (whether in kill window, duration),
`wasted-trinket` by `teamMinHpPct`, keeping the most severe instances):

- `cc-locked`: 3 → **2**
- `missed-purge`: 3 → **2**
- `missed-cleanse`: 3 → **2**
- `wasted-trinket`: no cap → **1** (previously the only type without a per-round cap)

**Empirical before/after numbers** (same criteria, same 200 matches / 899 sources snapshot, tested then changed):

|        | cc-locked | missed-purge | missed-cleanse | wasted-trinket | Four-type total | Share     |
| ------ | --------- | ------------ | -------------- | -------------- | --------------- | --------- |
| Before | 1629      | 1062         | 569            | 91             | 3351/5233       | 64.0%     |
| After  | 1253      | 817          | 500            | 89             | 2659/4541       | **58.6%** |

**Honest disclosure**: pre-change expectation was "~40% range", actual only dropped to 58.6% — below expectations, because most individual matches/rounds were already
well below the old cap (cc-locked averages 1.81 entries per match, old cap of 3 was rarely hit), per-round hard cap has limited ceiling effect on types whose "distribution is already
concentrated at low counts". This stopgap is **real but limited** mitigation, not the complete fix for these four types' disproportionate share; the complete fix remains the signal expansion referenced in the title (see below).

**Removal conditions (2026-08-06 update)**: batch 1 expansion (healing gap HEAL-001 / positioning signal POSITION-001 /
CC held COOLDOWN-001 three new candidate types + dispel DISPEL-002 latency field upgrade) has landed, share dropped from 58.6%
to **50.0%** (200 matches / 899 sources rescan, same criteria), but three new types combined account for only **7.7%** (418/5453) of the menu —
**insufficient to lift the gate**. This item's caps are kept unchanged, pending batch 2 (`#18`'s DEATH-002 / DEFENSIVE-001/002 /
OFFENSIVE-001/002 types) landing before evaluating whether to remove
the const block marked `TEMPORARY, BACKLOG #22` in `candidateFindings.ts` (four cap constants +
comments), restore `MISSED_CLEANSE_CAP`/`MISSED_PURGE_CAP`/`CC_LOCKED_CAP` to 3,
and remove `WASTED_TRINKET_CAP` entirely (restoring no-cap).

- **Cross-reference**: see `#18` entry "2026-08-06 additions" and the COOLDOWN-001/DISPEL late/failed two lines —
  this stopgap was waiting for those, now landed but did not reach removal threshold.

**Gate removal dry run (2026-08-11, after DEFENSIVE-001 + OFFENSIVE-002 landed, temporarily changed constants for empirical test then reverted)**:
Latest 200 matches / 898 rounds, same criteria, dual-run menu layer + agy real selection smoke (n=12, same
`smokeFindingsBackends.ts` denominator):

|                                         | Current (caps 2/2/2/1) | Gate removed (3/3/3/none) |
| --------------------------------------- | ---------------------- | ------------------------- |
| Menu four-type share                    | 53.7% (2729/5083)      | 59.3% (3436/5790)         |
| Rounds with four-type >50%              | 47.3% (425/898)        | 57.9% (520/898)           |
| Average menu entries                    | 5.7                    | 6.4                       |
| agy selection surviving four-type share | 42.5% (previous n=12)  | 46.8% (22/47, n=11)       |

Increase almost entirely from `cc-locked` (1253→1629) and `missed-purge` (817→1062). Selection layer dual safeguards
(prompt selection-limit sentence + `auditFindings` deterministic fallback) keep reports at ~1.9 four-type entries/match (≤2 hard constraint
not breached), new types still get selected from menu as before (healing-gap 1/1, position-mistake 2/2, cc-held 3/4).
**Conclusion: do not remove** — removing yields zero benefit (report side only skews without improving, menu side four-type share rises +5.6pt), new types' combined menu
share still only ~8.5%, removal threshold maintains original judgment: wait for batch 2 expansion (DEATH-002 / OFFENSIVE-001) to land before re-evaluating.
n=12 selection layer difference (+4.3pt) is near judge noise floor, not used as independent evidence — directional consistency with menu layer used only as supporting evidence.

## 14. eval / QA system residuals (logged 2026-07-20)

> **2026-07-22 wrap-up round addendum**:
>
> - **d243f4b three-fix judge-layer re-evaluation done** (same 35 layerb flagged matches, HEAD rebuilt prompt →
>   sonnet re-responded + scored, 35/35 provenance green): accuracy mean **1.89 → 4.14**, flagged
>   **35 → 2**, fabrication-level **4 → 0**, DMG SPIKE start/end confusion class **~13 → 1**, unit attribution class **~11 → 3**.
>   Denominator limitations (regression to mean / end-to-end attribution not decomposable) and per-case evidence in
>   `gladlog-eval-private/runs/2026-07-22-recheck/recheck-report.md`.
> - **✅ noise re-anchoring side effect fixed (2026-07-22 approved, going with (a) standalone tier)**: `templateDuplicateRatio`
>   given standalone tier in eval-baseline.md (≤45% no deduction; 45–60% → 3; >60% → 1, thresholds from 1245-match
>   natural distribution p50=31.2%/p90=40.7%/p99=49.1% beyond). Rule-based scores across full corpus 3.03 → 4.92
>   (old rules pressed 1207/1245 matches to tier 3; new rules only 49 true tail matches fall to tier 3, 0 to tier 1). Calibration unaffected
>   — calibration cases have no quality-report, judge already skips consistency rules.
> - **✅ §7ter enabled (2026-07-22 approved)**: sufficiency (det-gate dimension) removed from other dimensions' specificity
>   checks. Same batch `scores-det3` scores: accuracy 90→100, inferenceScaffolding 90→100,
>   outcomeAlignment 90→100, labelBias 80→90, noise 90 unchanged, focusCalibration 100 unchanged
>   — **7/7 all pass with minimum 90%**, pressure dimensions cleared to zero.
> - 14.3 maintained as monitor (this round is a flagged-subset re-evaluation, does not constitute a new baseline, not used as observation point).

These four items come from the 2026-07-20 prompt defect fix round + blind A/B wrap-up. 14.1 is fixed,
14.2–14.4 are not done, ordered by processing sequence. The remaining three items are **all within `packages/eval`** (the eval system
itself), don't go into the product package, don't block releases. Background in
`docs/reports/2026-07-20-prompt-defects-and-blind-ab.md`.

### 14.1 `report-replay` visual test flaky ✅ (fixed 2026-07-20)

**Symptom**: CI failed on `0eeabb2` at `scenario report-replay matches baseline`,
1871 px (0.01 ratio of full image) inconsistent. That commit only changed `packages/eval/src/quality/`
two files, zero renderer code; the next commit (`258dcdc`) ran the same test green.

**Root cause is NOT render timing** (this entry originally stated "has timeline/animation, suspected render not settled",
which was wrong — `playing` starts as false, the rAF loop never ran at all). True root cause is **a public network image embedded in the baseline**:
`ReplayView.tsx`'s arena background map `<image href={arenaMapUrl(zoneId)}>` points to
`images.wowarenalogs.com`, fetched at runtime. The real background is a "transparent background + opaque collision bodies"
shape map, so when fetched it draws some gray obstacles, when not fetched it draws fewer — same code, two pixel outputs.

Hard evidence from the failure artifact: diff box locked to x174-279 / y196-272, **every diff pixel on the actual side
is the same background color `[26,27,40]`**, expected side is neutral gray `[98,99,105]`/`[120,121,128]`
— not jitter, it's "that entire layer wasn't drawn."

**Fix**: `qa/support/stubExternal.ts` — known external resources fulfilled with locally generated fixed stub PNGs,
all others aborted and logged to a **leak ledger**, with test cases asserting the ledger is empty. Adding a new CDN dependency
will explicitly fail red, rather than leaving a random red light. Also switched Inter from Google Fonts to
`@fontsource` self-hosted (same class of issue, and the product UI falls back to system fonts when offline).

**Verification** (same build, online vs. offline, full-page pixel comparison):

|                                     | Diff pixels                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Pre-fix · page layer                | 33192 (bbox x16-1261 y28-936, nearly full page)                                                           |
| Post-fix · page layer               | 2286 (only background map remains; product still fetches from CDN, offline degrades to no background map) |
| Post-fix · baseline layer (stubbed) | **0**                                                                                                     |

Post-fix page layer bbox matches the production failure's x174-279 y196-272 pixel-for-pixel, confirming local
reproduction of the failure. After baseline regeneration only report-replay changed out of seven images, the other six are byte-identical.

**Residual**: product-side background map still uses CDN (vendoring involves copyright + bundle size, see `arenaMaps.ts` comment),
offline users see a degraded no-background-map view. This is intentionally preserved.

### 14.2 sufficiency judge blind spot (calibration detection rate 20%) ✅ Closed (2026-07-22, resolved via deterministic coverage gate; rubric anchor point direction rejected after five tests)

**Empirical test** (2026-07-20 calibration, 40 synthetic defects): after deleting **all** death-related
lines from a match's prompt, in 4 of 5 cases the judge gave the same or higher sufficiency score (source 002 deleted 18 lines, 5→5).
Detection rate for all other six dimensions was 80–100%.

**Implication**: the judge can only see what's in the prompt, cannot see what the builder **didn't include**.
This is structural, not fixable via prompt engineering.

**Direction** (choose one, undecided):

- Modify the rubric, give the judge an explicit coverage checklist as anchor points; or
- Simply abandon blind scoring for this dimension, let `qualityCheck`'s deterministic coverage gate score directly.
  The current `eval-ab.md` already specifies this dimension is adjudicated by deterministic metrics, blind scores have no adjudication power — that's a bypass, not a fix.

**Correction (2026-07-20 full-corpus round)**: the original "detection rate 20%" counted **suite defects** against the judge.
`removed-deaths` deletes death lines from the prompt while leaving the response unchanged — claims in the response about that death
are then truly no longer supported by the prompt, so accuracy should indeed drop — the judge was doing its job correctly, but was judged
as violating by the specificity rules. After fixing this premise error (`751f6bc`, constructive coupling exemption), the dimension's detection rate went from 20% → 60%.

**Final version (n=10 suite, 80 cases, same day evening)**: the blind spot is real, and **more severe** than the corrected estimate —
in 10 cases **6 scored `5→5`** (all death lines deleted, judge deducted zero points), pure sensitivity failure. Detection rate 40%.
n=5 two rounds + n=10 one round, three independent measurements, this finding consistently reproduces. The two fix directions above still stand.

**n=5 is unreliable, empirically proven**: under the same rubric, focusCalibration went from 40% to 80%, noise from
80% to 50% — two dimensions nearly swapped after sample doubling. Except for inferenceScaffolding (n=5 and n=10 both
100%), any dimension-level conclusion based on n=5 is invalid. **Calibration suites must use `--source-count ≥10`.**

**Final final version (2026-07-21, all 80 cases re-evaluated under latest rubric, `scores-det3`)**: blind spot **reproduced a fifth time,
and deeper** — detection rate 40% → 30% → **20%**, in 10 pairs 8 were undetected and **all showed zero response**
(`5→5` five times, `4→4` twice, `3→3` once). Three rounds of rubric changes (`cca541c` / `3d92ba3` /
audit set cap `d39b34b`) had **zero effect on it**, consistent with the "structural, not fixable via prompt engineering" judgment.

**Conclusion: go with the second direction, stop trying the first.** Hand it to `qualityCheck`'s deterministic coverage gate,
`eval-ab.md` already specifies this anyway. It's a bypass, not a fix — but after five measurements,
"modify rubric to add coverage checklist anchor points" has no evidence supporting continued investment.

**✅ Closed (2026-07-22): coverage gate landed.** `checkCalibration` for removed-deaths pairs now adjudicated by
deterministic coverage gate (`checkFriendlyDeaths` × ground-truth manifest, same predicate as production `qualityCheck`;
`removeDeaths` perturbation also changed to import the same `DEATH_KEYWORDS`, predicate single-source). Judge
blind scores still recorded, just without adjudication power. Same suite, same batch of judge scores (`scores-det3`) before/after: **detection
2/10 (20%) FAIL → 6/6 (100%) PASS** (4 pairs' source matches had no friendly deaths, gate has no jurisdiction, scored as unscored — not counted
as detection or miss); **calibration total 6/7 → 7/7, exit 0**. Manifests for old runs that were cleaned need to be rebuilt from the same
log list then aligned by matchId and copied back (2026-07-20-smoke already done). §7ter's "remove sufficiency from
specificity check" still awaits human approval — but its prerequisite (this dimension is indeed independently adjudicated by deterministic gate) is now established.

**Incidental finding, adopted 2026-07-22**: sufficiency is now also **the largest leak source** —
the other six dimensions' combined 6 undetected cases are all specificity drift of 2, of which **4 cases' drifting dimension is sufficiency**.
Removing it from specificity checks would raise the six dimensions to 90–100%. The judgment at the time was that this is only valid when sufficiency is truly independently
adjudicated by the deterministic gate, not "adjusting the gate until it turns green" — that prerequisite was established the same day, so removing sufficiency
from specificity checks landed: `packages/eval/src/judge/checkCalibration.ts` (~lines 332-337,
`DET_GATE_DIMENSIONS` skips specificity determination, comment marked "2026-07-22 approved for enabling"). Details in
`docs/reports/2026-07-21-judge-variance-v3.md` §7ter.

### 14.5 accuracy inter-judge variance ±2 — factAudit's 3 claims should be fixed rather than judge-selected ✅ Closed (2026-07-21, lookup-table anchor: anchor noise 0/30; residual errCount disagreement is judgment-capacity noise)

**Empirical test** (2026-07-20, n=10 suite): `noise` and `labelBias` failures are **all specificity**,
sensitivity is good (5→3, 5→1), leaked dimension is always `accuracy` with drift=2.

**Root cause is not the suite**. Examined case-by-case the claims judged refuted in case-06/13/49 — respectively "Hammer of
Justice attributed to wrong person", "Life Cocoon cooldown state misjudged", "41% HP one second off" — these errors **exist
in the original response text**. And `duplicated-noise` only changes the prompt, not the response — control group and perturbation group
judges see the same response, one gives accuracy=5, the other gives 3.

True mechanism: the rubric (`eval-baseline.md` PASS 1) lets the judge **self-select** "the 3 most load-bearing claims" for fact
audit. Different judges pick different 3 claims — if they pick ones containing errors, they deduct; if not, they give full marks. So accuracy's
inter-judge variance reaches ±2, while the specificity tolerance is ±1, structurally unbeatable.

**Tried and measured (`cca541c`, same day): changed the audit set to be rule-determined** — take all assertions in the response containing `M:SS`
timestamps (cap 12, pad to 3 if insufficient), and accuracy **scored only on that set**. Re-evaluated those 30 cases
(10 sources × {none, severity-labels, duplicated-noise}, i.e., the three types where response and verifiable content are identical):

| Criterion                      | Pre-change (self-select 3) | Post-change (rule set) |
| ------------------------------ | -------------------------- | ---------------------- |
| accuracy range mean            | 1.00                       | 0.80                   |
| Maximum range                  | 2                          | 2                      |
| Sources with range ≥2          | 4                          | 3                      |
| Sources with perfect agreement | 4                          | 5                      |

**Effect not confirmed.** Magnitude −20%, at n=10 indistinguishable from noise; and it's displacement not contraction (source 3 dropped from 2 to 0,
source 1 rose from 0 to 2). The change itself is principled (eliminates an arbitrary degree of freedom, audit becomes verifiable),
so it's kept, but **must not be considered resolved**.

---

**Closed (2026-07-21)** — details in `docs/reports/2026-07-21-judge-variance-v3.md`.

The subsequent two rounds of changes completed this item, but **the winning area is not the same thing as the title**:

| Criterion (scale-independent)                            | Self-select 3 | Rule set `cca541c` | Lookup anchor `3d92ba3` |
| -------------------------------------------------------- | ------------- | ------------------ | ----------------------- |
| **errCount range mean** (substantive judge disagreement) | 0.50          | **0.30**           | 0.50                    |
| Anchor application noise (accuracy ≠ 5−errCount)         | 9/30          | 8/30               | **0/30**                |
| Verification detection total (30 cases)                  | 6             | 11                 | **21**                  |

- **What was actually fixed is "same finding given different scores"**: in v2, of 11 cases with errCount=1, accuracy was
  scored 3 eight times and 4 three times; in v3's 16 cases it's **all 4**, 30/30 zero exceptions. This is pure noise, zero signal,
  eliminating it is a net gain.
- **Substantive inter-judge disagreement didn't decrease**: errCount range returned to 0.50, same as the initial level. Remaining variance **is entirely verification misses** —
  three judges reading the exact same response find error sets that can be {A} / {A,B,C} / {C} (source 001 instance).
- **⚠ The registered criterion (accuracy range 1.00 → 0.80 → 0.50) looks like two consecutive drops, but doesn't translate to A/B discriminative power**:
  lookup changed "1 error" deduction from 2 points to 1 point, noise and signal shrink proportionally. Lesson separately documented —
  before comparing scoring-class metrics, must convert to underlying counts that don't change with anchor points.

**The anchor point approach has hit bottom** (0/30 violations, no remaining room). If further variance reduction is needed, the direction is **verification misses**:
consider requiring judges to write the **line number** in the prompt for each claim, turning "I checked it" into a verifiable trace.

**Calibration total: 4/7 → 5/7 → 6/7** (see 14.2 final version), threshold 5/7 met, Layer B no longer blocked.

~~**Remaining variance is elsewhere**: after the fix, judges audit the same set of claims but can still differ by 2 points — indicating disagreement is in "same
claim judged verified vs. refuted" and "n errors maps to which anchor score", i.e. **anchor calibration**, not sampling.
Next step should investigate this direction, not continue modifying the audit set.~~
**(2026-07-21 overturned: this guess was half right.)** At the time, two mechanisms were written together. Empirically decomposed, it turns out —
"n errors maps to which anchor score" is indeed a problem, and **has been completely solved by lookup anchors** (violations 9/30 → 0/30);
but "same claim judged verified vs. refuted" **is not an anchor problem, it's verification misses**, lookup has zero effect on it
(errCount range 0.30 → 0.50). Remaining variance is entirely in the latter — see the closing table above.

**Self-inflicted collateral from the change**: when modifying PASS 1, the `factAudit` length convention wasn't synced — the format section and
`checkScoreProvenance.ts` were both still locked to "exactly 3 items", causing the re-evaluated 30 cases to have item counts ranging from 3 to 12
(sub-agents each interpreted differently). Validator relaxed to [3,12] and required recording the complete rule set (truncation equals
losing verifiability, and verifiability was the whole point of this change). Lesson: when changing judge workflows, any script that
validates that workflow's outputs must be changed in the same commit.

**Same self-inflicted issue recurred 2026-07-21** (when changing cap from 12 → 20, `provenance.test.ts` two test cases
hardcoded 12, 1 of 88 tests went red). Fixed this time, also exported constants as `FACT_AUDIT_MIN/MAX`,
test cases changed to derive from constants, additionally added `factAuditBounds.test.ts` that **parses the rubric document and asserts the document's
numbers equal the validator constants** (verified by changing constant back to 12, 3/3 failed, not a vacuous pass). **Same-type drift stops here.**

**Dead ends tried** (don't repeat): at one point assumed `duplicated-noise` has constructive coupling with accuracy (duplication
changes counts, rubric requires recounting), planned to add to `COUPLED_BY_CONSTRUCTION`. Case-by-case verification
**disproved** it. Progressively relaxing the exemption table until the gate turns green is exactly the failure mode warned about in that table's comments.

### 14.3 Two accuracy proxy metrics slightly pointing toward treatment being worse (monitor)

2026-07-20 A/B (50 pairs) two independent metrics pointing same direction:

| Metric                 | Δ      | 95% CI            | MDE at n=50 |
| ---------------------- | ------ | ----------------- | ----------- |
| accuracy (1–5)         | −0.30  | [−0.66, +0.06]    | 0.36        |
| factAudit refuted rate | +5.3pp | [−2.4pp, +13.1pp] | —           |

**Neither is significant**, and both are below this sample size's minimum detectable effect.

**Ruled-out explanation**: it's not "prompt grew 5% / 86 new DR annotations gave more citable material" —
empirically, in both arms' refuted claims, claims mentioning the new annotation surface are **all 0**.

**No further action**; observe alongside the next baseline run. If the same direction recurs with larger n, investigate.

### 14.4 `blindPool` blind cases missing matchId placeholder convention ✅ (closed 2026-07-22)

This round's blind cases don't contain `MATCHID:` headers (stripped by design), but judge instructions require score JSON to include `matchId`,
so sub-agents each made up `null` / `"unknown"` / `"NO_MATCHID_HEADER_FOUND"` three different formats.
Doesn't affect this round's statistics (`abStats` joins by blindId), but would create problems for future matchId-based aggregation analysis.

**Fix**: placeholder convention hardcoded to `matchId = blind case id (item-NN)` — the blind case directory name itself is a stable id that doesn't
leak arm assignment, real matchId aggregation always goes through `blind/mapping.json` for lookup. Landed in two places:
`eval-ab.md` judge template explicitly states "set matchId to exactly ITEMID, don't make up values, don't look it up";
`abCompareStats` checks this field during unblinding — non-compliant values logged as warning, **values equal to the real matchId trigger a separate alert as suspected unblinding breach**
(this information doesn't exist in the blind case — the judge could only have obtained it by reading files outside their scope).

---

## 23. GitHub issues batch 1 (logged 2026-08-11, 4 issues opened by users on GH)

Classified by suspected root cause; work begins after completing the currently running #3 (enemy burst response delay candidate).

1. **[#8](https://github.com/mingjianliu/gladlog/issues/8) unused abilities include abilities the player doesn't have
   → talent awareness (2026-08-11 user corrected root cause)**: Power Word: Barrier **does
   exist**, but it's a talent 2-pick-1 node and the vast majority don't pick it — the issue isn't table corruption, it's that the **analysis layer
   doesn't know what talents the player chose**, treating "theoretically available to the class" as "this player has it", saying
   "unused CD" for untalented abilities. Supporting evidence same direction: DEFENSIVE-002 rejection measured PW:Barrier with only
   8 casts across 808 global matches, perfectly consistent with "unpopular talent choice."
   **Data status**: parser already parses `COMBATANT_INFO`'s `talents: number[][]` (talent tree
   node entries) and `pvpTalents` (`packages/parser/src/l1/combatantInfo.ts`), attached to
   `u.info`, zero consumption by analysis layer. Missing two pieces:
   (a) **talent entry → granted ability** mapping table (DB2 trait tables, follow
   [[official-data-over-heuristics]], official tables also need empirical coverage testing);
   (b) **ability gate consumption**: all "you have X but didn't use it" type determinations (unused-CD / loadout [UNUSED] /
   death recap availableImmunities / missedExternals etc.) first pass "this player actually has X in their talents."
   Gate should be installed at the **candidate layer** with rich context guard comments (missed-cleanse ability gate 8fba412 and
   [[gladlog-context-bypasses-candidate-gate]] two precedents: only blocking the menu would be bypassed by loadout
   bare facts). Single-source predicate (canDefensiveCleanse pattern) goes into predicate-index.
   Before starting, measure: full-corpus coverage rate of matches with talent data + affected whitelist entry inventory (which kit abilities
   are actually talent pick-one). **Checkpoint: verify whether slim migration preserved info.talents** (doc slim process modified
   params, if talents were trimmed need to restore to storage layer first).
   **✅ Completed (2026-08-11, including "precision: neither false-negatives nor false-positives" acceptance batch)**. Inventory conclusion: kit main
   path `extractMajorCooldowns` and all its downstream (loadout/[UNUSED], cd-waste,
   cc-held, slow-defensive-response, death-unused-defensive, external-unused,
   computeUnusedSelfCounterfactuals, matchNarrative/criticalMoments/
   momentSnapshot) **already talent-aware** (pick-one filtering + pvpTalents + replacement table + dynamic discovery;
   300-match empirical test 29900 kit entries 0 phantoms); the real gap is `deathOutcomeAnalysis`'s
   IMMUNITY_SPELLS / EXTERNAL_DEFENSIVE_SPELLS two spec tables (only gated by spec, feeding
   prompt's DEATHS WITH MISSED OPTIONS, deepDive immunity/external facts, desktop
   DeathRecapCard three locations). Fix: three-state single-source predicate `talentOwnershipOf`
   (analysis/src/utils/talentOwnership.ts, added to predicate-index), ownership set covers
   four sources: class/spec/hero tree (pick-one only counts selected branch) + **official PvP talent pool**
   (new datagen `genPvpTalentPool.ts` → pvpTalentPoolGenerated, DB2 PvpTalent,
   including ActionBar carrier 215982→215769; COMBATANT_INFO pvpTalents=SpellID semantics empirically verified
   at 110/111 across full corpus) + replacement relationships + exclusion-method baseline; two anti-false-positive fallbacks: free/entry auto-granted
   nodes absent → unknown (Chain Lightning 214/214 casters' loadouts all lack that node), loadout contains
   nodes unresolvable in current tree (old build rounds / pet tree rows) → tree judgment no → unknown. Both tables' listing
   loops each add "only filter on confirmed no, unknown passes through" gate + `<player_loadout>` header guard comment.
   **Before/after numbers**: (a) phantom scan (same criteria, latest 200 + sampled 100 matches = 1172 rounds):
   missedExternals phantoms 517/918 (56.3%, PWB 330 / Zephyr 109 / BoP 75) → **0/404**;
   availableImmunities 149→149 zero false-positives; kit 0 phantoms unchanged. (b) **Full-corpus contradiction audit**
   (810 matches 2622 rounds 345,942 cast pairs, criterion = table judges "no" but player actually cast in that round, permanent script
   `packages/desktop/scripts/auditTalentOwnership.ts`): **235 → 7** (0.002%),
   residual 7 each traced to = pre-gate / round-boundary cast timing edge cases (poisons / weapon enchants / sacrament / BoP replaced by PvP talent,
   pvp talents dormant outside arena) and old build node-id drift invisible residuals; production predicate
   all immune via cast evidence fallback. (c) Whitelist determination 17747 unit-instances: unknown 47 (0.26%, all
   old build rounds), 0 when data is available; PWB = yes 12 / no 1542 / unknown 0 (99.2% of Disc rounds
   didn't talent it, issue #8 confirmed). Whitelist 36 (spellId, spec) pairs each classified by official source and pinned in
   `talentWhitelistClassification.test.ts` (data refresh drift would turn red). Coverage
   15650/15650 unit talent data parseable (slim preserved info.talents intact). Solo Shuffle round-level
   empirical evidence: 171/186 shuffle matches had players changing talents between rounds, 361/1099 multi-round players (32.8%) —
   predicate uses per-round unit.info, never caches across rounds.
   **Incidental finding (not addressed, deferred)**: Netherwalk (196555) absent from both 12.1 tree/pool + full-corpus
   808+ matches 0 casts + 414 Havoc units — suspected removed from the game, IMMUNITY_SPELLS entry
   is whitelist rot ([[gladlog-aura-id-rot]] family), will continue producing suspicious "had Netherwalk
   available" claims; pending season data confirmation before removal.
   Numeric corrections (talentModifiers cooldown reduction type) not in scope for this item.
2. **[#9](https://github.com/mingjianliu/gladlog/issues/9) Mind Control causes minimap mode friend/foe
   count errors**: during Mind Control the unit's reaction flips, replay minimap friend/foe
   counts get skewed. Suspected in parser/replay layer's reaction snapshot denominator (using COMBATANT_INFO static
   faction vs. per-event dynamic reaction). First reproduce: find a match with Mind Control and locate the count source.
   **✅ Completed (2026-08-11, two fixes each in independent commits)**. Root cause two layers:
   (a) **Replay chain is the last surface across the entire app that uses reaction flags for friend/foe determination** (predicate split,
   all other surfaces use `sideOfUnit`) — `ReplayTrack.reaction` → `side`, derived from `sideOfUnit`
   (anchored to COMBATANT_INFO teamId), falls back to reaction only for unknown; map both-sides HP bars/
   dot outlines/swim-lane grouping/both-team chips — one change fixes all four surfaces. Empirical test archive fb672a41 round 5:
   Hiyâkun (reaction=Hostile, teamId=friendly) pre-fix in enemy column → post-fix in friendly column, count 2v4→3v3.
   (b) **Perf commit 1c9c05d when deduplicating flagsSeen silently changed reaction voting from
   "by event occurrence count" to "by distinct value count"** (ties bias toward Friendly), units
   touched once by Mind Control get 1-1 tie and flip for the entire match — restored occurrence-count voting (flagCounts count Map,
   preserving dedup's performance benefit). Before/after numbers (full corpus 280 matches with 605 corpus entries, 1325 segments / 7941 player
   units, criterion = voted reaction strictly contradicts COMBATANT_INFO teamId): distinct-value
   voting **1459 instances / 230 matches** → occurrence-count voting **1 instance / 1 match** (residual 1 = fb672a41
   round 5's persistent mechanism flip, caught by (a); investigation estimate was 59 instances / 8 matches, actual blast radius
   25x larger). Incidental finding: oracle parity gate hasn't been run since 1c9c05d, has
   pre-existing red (ENEMY HARD CAST old=0 new=8, old fork structurally lacks
   castStartEvents); (c) this made it 8→13, all 5 new instances individually verified as correctly re-attributed
   (caster teamId confirmed enemy). **✅ Baseline adjudication closed (2026-08-15)**: private repo
   `gladlog-eval-private`'s `oracle/adjudications.md` records the evidence table — all 13 individually verified
   (cast-event source GUID × COMBATANT_INFO teamId, cross-checked against mutual exclusivity with this round's
   friendly teamId), 8 structural (F170 unrelated to the Mind Control voting fix — the old fork's `CombatUnit.ts`
   has no `castStartEvents` field at all, `?? []` always empty) + 5 brought in by the Mind Control voting fix;
   worktree replay of the pre-voting-fix commit reconfirmed the before/after numbers 8/164→13/164, matching this
   item's estimate. `oracle/baseline.json` now records `L2:block-added:ENEMY HARD CAST` (the old `block-removed`
   entry was invalidated by the F170 fix's direction reversal and removed along with it). Gate back to green
   (164 pairs, 13 adjudicated, 0 new diffs).
3. **[#10](https://github.com/mingjianliu/gladlog/issues/10) agy excessive dispel conclusions**
   (no body text): this is the topic domination complaint, already has an entire governance track running — #22 rate limiting (kept, not removed, see gate
   removal dry run documentation) + selection layer diversity (LEGACY_TOPIC_TYPES dual safeguard, agy 61.3%→42.5%) + #18
   signal expansion. This issue tracked on this line, if still unsatisfactory after expansion batch 2 then escalate.
4. **[#11](https://github.com/mingjianliu/gladlog/issues/11) death recap UX**: filter out
   small damage, only keep GCD-related / significant damage and dispels. Pure renderer/derive layer
   (deathRecap derive + DeathRecapCard), be careful not to create a second set of predicates for threshold — if analysis layer
   already has a "significant damage" criterion (e.g., timing's DAMAGE_SPIKE_THRESHOLD area) check
   predicate-index first to evaluate reuse vs. independent UI display threshold, record the trade-off in implementation comments.
   **✅ Completed (2026-08-11)**: per-type processing landed — direct hits (SPELL_DAMAGE) / direct heals filtered by
   `DEATH_RECAP_MIN_EVENT_PCT` (2% maxHp, derive layer independent UI display threshold, maxHp sourced from
   same advancedActions as hpRangeAt; DAMAGE_SPIKE_THRESHOLD is a window cumulative damage criterion,
   not a single-event fact, evaluated and not reused) retain/collapse; DoT/auto-attack and other non-SPELL_DAMAGE subtotaled by
   (spell × source); HoT ticks go into collapse bucket (empirical test: collapse median 24 rows vs. subtotal 26 rows, take the fewer);
   dispel rows consume reconstructDispelSummary bidirectional unconditional retention; collapsed rows expandable +
   "show all" toggle. Before/after numbers (50 matches / 176 deaths same corpus): per-recap row count median
   114→24, p90 245→36, max 607→46; amount conservation 0/176 violations; 158 new dispel rows
   (previously 0 — dispels were not in the event stream before). Incidental: death-before-10s dual-write unified to
   COUNTERFACTUAL_WINDOW_S single source (criticalMoments 10_000 and desktop
   DEATH_RECAP_WINDOW_S both changed to alias consumption, predicate-index bilingual annotated).

---

## 24. 12.1/S2 data wrap-up batch (logged 2026-08-11)

12.1 data refresh (526a3fb, build 12.1.0.69273) and DR era boundary (5856ee0,
`drResetMsAt` 16s/20s, cutpoint 2026-08-11T22:00Z) are in main; the following are remaining data items,
**all dependent on S2 (2026-08-18 season start) corpus becoming available**, will act after sufficient volume:

1. ~~DR 20s cutpoint empirical verification~~ **Empirically verified 2026-08-12 (launch day)**: wowarenalogs
   30 12.1 US matches downloaded (all after cutpoint), `drWindowVerify.mts` verdict — stun-type
   16.5–19.5s interval bucket duration med 1.5s (n=5) ≈ 8–15.5s bucket (both rules at 50%,
   n=25)'s 1.5s, far from 25–60s fresh bucket (n=155)'s 3.0s → **20s rule in effect**,
   cutpoint needs no adjustment. All categories same direction (n=14/43/317). Incidental: parser 30 matches 0 errors,
   1673 observed ids spell name table 0 missing. Bucket A n is small, can rerun same script for reinforcement after more corpus accumulates.
2. **spellEffectOverrides discrepancy review** — majority resolved 2026-08-11 same day, one remaining truly depends
   on 12.1 corpus:
   - ~~Shadow Dance 185313~~ **Ruled to delete**: 12.0 full-corpus empirical bidirectional disproof of override
     (60/8) — cast interval n=1996 min 6.1s / median 18.5s ≈ generated's 20s charge;
     buff 185422 duration n=2261 median 6.5s ≈ generated's 6s. Override's two values were
     already wrong in 12.0, generated is directly correct. Measurement lesson: buff aura is 185422 not cast
     id 185313 (aura-id-rot family, measuring duration requires aura id).
   - ~~Malevolence/Soul Rot/Coordinated Assault~~ **Deleted as redundant** (DB2 and override
     byte-identical; Soul Rot actually unlocked dispelType:Magic that was being masked by the override).
   - **Fel Barrage 258925 (sole remaining)**: override dur=3 vs DB2 8, but 808 matches of
     12.0 corpus have **0 casts** (92 string matches are all loadout talent ids), bidirectionally
     unfalsifiable. Will resolve by empirical measurement when first cast appears in 12.1 corpus; if no samples ever appear, adopt official 8s.
3. **rotScan whitelist rot check** (update-wow-data step 7 denominator): scan by spec
   none-tracked rate + `[DR: spell:<id>` fallback scan; ~20 reworked specs are worst hit,
   expected gaps (Retribution Radiant Glory / Enhancement Doom Winds) — don't false-alarm. #23's deferred
   Netherwalk removal also confirmed in this batch.
   > 2026-08-12 launch day initial scan (`noneTrackedScan.mts`, 30 matches): 22 specs 179
   > cooldowns blocks none-tracked **all 0%**, DR fallback 0 — no 2026-07 style full-spec
   > collapse. But 18 specs absent on day one (Subtlety/Outlaw Rogue, Balance/Guardian Druid, Arcane/Fire Mage,
   > Holy/Shadow Priest, Destruction/Demonology Warlock, Brewmaster/Mistweaver Monk, Protection Warrior/Paladin, Blood DK, Augmentation Evoker, etc.),
   > and present specs partially n≤3 — conclusive check still awaits one week of corpus.
4. **benchmarks.json rebuild**: current baseline from 2026-07-20 based on 12.0 corpus (2100+),
   healing/damage numbers significantly retuned and now stale; rerun after S2 corpus reaches volume, note
   [[metric-scale-vs-agreement]] — compare scale-independent counts before drawing conclusions.
5. **dispelObservedGenerated backfill**: `confidenceAudit --emit-table`,
   observational table "hasn't happened ≠ can't happen", feed new corpus entries back one by one.
6. **eval baseline / candidate incidence rates full recalibration**: 63.6/14.1/15.6 and other old numbers considered
   expired after 12.1; rerun `/eval-baseline`, rate-limiting type (#22 temporary gate) thresholds reviewed alongside incidence rates.
7. ~~observedSpellIds +7 new ids into icons/offGcd universe~~ **Done 2026-08-11**
   (pipeline fix ac3a6a2f same-day opportunistic: observed 3346→3353, icons 41729→41734,
   offGcd 295→296, validateCatalogs green) — didn't actually depend on S2 corpus, was incorrectly categorized in this batch.

8. **Ring of Fire new id tracking** (2026-08-13 patch notes review finding): official 12.1
   notes explicitly state "Ring of Fire duration increased to 4 seconds (was 3)" — the ability
   is still alive; yet 363405 was deleted from SpellName@69273 (526a3fb per orphan row deregistration). Both being true simultaneously
   has only one explanation: the mage rework assigned a new id (aura-id-rot family). Search S2 corpus by
   "Ring of Fire" name to find the new id, register DR classification + observed universe; deregistration ruling itself stays
   (historical logs still need the old id).
9. **Ancient of Lore (473909) 20% damage reduction not in mitigation table**: cc_immunity side already registered
   with the 2026-08-13 patch review batch in talentBehaviors (corpus empirically verified 7d74b373), but its
   20% damage reduction during transformation still lacks DB2 aura87 evidence chain — enter
   mitigationData after S2 corpus + DB2 review, don't fill numbers based solely on patch notes text.

New season log collection/archival (launchd loading etc.) see #19, user-managed, not in this item.

## 24. `dr` reverse query always empty — `analyzeOutgoingCCChains` target side hardcoded Hostile

> **2026-08-14 fixed** (`packages/analysis/src/utils/drAnalysis.ts`): target filter changed from
> `e.reaction === CombatUnitReaction.Hostile` to "Player type + belongs to the passed-in
> second parameter set" id-set membership, `reaction` no longer participates in target determination. All product
> forward callsites (candidateFindings/momentSnapshot/deepDive/ccChainDash etc.)
> behavior unchanged (parity tests pinned). Ripple check found `archetypeInference.ts` already had one
> reverse call (`analyzeOutgoingCCChains(enemies, friends, combat)` computing
> `enemyTeamCCPerMin`), its companion ported test (B53) even manually set friendly units' `reaction`
> to Hostile to work around this bug — after the fix that workaround is no longer necessary but the test still passes;
> that function (`extractMatchDynamics`) is currently not called by any product runtime path, so this
> semantic change has zero product impact. Acceptance: `matchExplore.ts 76ea5f90 dr --from 0 --to 188`
> pre-fix 25 rows (all forward, 0 reverse) → post-fix 55 rows (25 forward unchanged + 30 reverse enemy CC landing on
> Girlbye/Minilay/Boofers etc.). Test: added
> `packages/analysis/test/drOutgoingCCReverse.test.ts` (reverse RED→GREEN +
> forward parity snapshot).

`packages/eval/src/explore/matchExplore.ts`'s `dr` query as designed calls `analyzeOutgoingCCChains` once in each direction,
but the predicate internally filters target side to
`e.reaction === CombatUnitReaction.Hostile` (drAnalysis.ts ~:454), so the reverse call
`(enemies, friends)` has all friendly targets filtered out — enemy-cast CC is always 0 rows. Deep dive ceiling experiment
first match (2026-08-12, match 60ab1e8f) real usage exposed it immediately: enemy hammer forced owner to trinket 5 times,
`dr` showed 0 enemy CC. Product side unaffected (enemy CC uses `analyzePlayerCCAndTrinket`
owner-side predicate).

Fix direction: change the predicate's target filter from hardcoded Hostile to "belongs to the passed-in second parameter set"
(semantically more correct, existing product calls `(friends, enemies)` behavior unchanged), with parity tests + product
callsite regression; or have the `dr` query's enemy direction use `analyzePlayerCCAndTrinket` aggregated per owner.
Check predicate-index before starting (involves DR chain single-source).

> **2026-08-14 ability fact foundation project closing note**: this project (`usableWhileCcGenerated.ts`/
> `usableWhileStunned`/signed register) does not cover this item — `analyzeOutgoingCCChains`' target-side filter
> and "what abilities can be used while CC'd" are two different fact surfaces (former is CC cast attribution direction, latter is self
> ability availability after being CC'd), unrelated to each other — still an independent open item.

## 25. Two cases of mechanistic misuse in product suggestions (caught by deep dive experiment first-match blind review, match 60ab1e8f)

Reviewer (the holy paladin player themselves) judged two types of baseline suggestions as "fundamentally wrong" in 2026-08-12 blind review:

1. **BoS self-cast regression suspected**: "Blessing of Sacrifice was still available when downed" implies the dying player could use Sacrifice to self-rescue — Sacrifice
   cannot be cast on self. This type was fixed 2026-08-01 (12→0, see backlog #10 closing notes),
   recurred with promptVersion 24, needs prod-triage to confirm whether this is a same-path regression or new generation path.
2. **Immunity-blocks-stun-type counter-suggestion** (2026-08-14 corrected): Divine Shield mechanistically **can be pressed in any CC state**
   (user clarification + flag bits corroborate, original "can't be pressed" judgment was wrong) — the issue is not at the mechanics layer but at the **cost normalization layer**:
   a 5-minute major cooldown shouldn't be recommended as a routine CC counter (Ice Block same situation). Fix = candidate layer cost-norm
   guard comment (signed register entry), not a mechanics gate; "usable while CC'd" mechanics fact officiated by ability fact foundation project.

Reproduction materials: `gladlog-eval-private/review-sessions/2026-08-12-60ab1e8f.*` (session contains
per-card annotations, answers contains reviewer's verbatim notes).

> **2026-08-14 ability fact foundation project closing note**:
>
> 1. **BoS self-cast regression suspected**: not covered by this project, unrelated (involves candidate generation path regression, not
>    an ability fact assertion issue) — still needs prod-triage per original text to locate independently.
> 2. **Immunity-blocks-stun-type counter-suggestion**: mechanics layer now officiated — `usableWhileStunned` confirms Divine Shield
>    (642) / Ice Block (45438) **can be cast while stunned**, official DB2 `SpellMisc.Attributes` bit flags
>    (`usableWhileCcGenerated.ts`) only prove this one point; "mechanistically castable in any CC state" — this broader
>    statement comes from user signed anchor point (Task 2, 2026-08-14), not from the official bit itself — the official bit and user ruling
>    conclusion are consistent, but evidence sources must be distinguished, cannot be broadly attributed to "official DB2 bit flags" (finding #5, 2026-08-14
>    final review correction). There is no such thing as "can't be pressed" — the original judgment was wrong and that conclusion is settled. **Cost normalization layer signed register
>    entries have landed**: 642/45438 two `cost_norm` entries registered in
>    `curatedAbilityFacts.ts` (Task 6, 2026-08-14 user signed: "mechanistically castable in any CC state,
>    but cost too high, must not be recommended as routine CC counter, only as last resort under lethal threat"). **Candidate layer
>    guard comment consumer not yet wired** — the signed register currently has no consumer importing it to filter/downrank
>    candidate suggestions (full-repo search confirmed), meaning "should not be recommended as routine CC counter" is currently only recorded on file,
>    no code actually blocks the model from suggesting 642/45438 as routine responses; this candidate layer wiring left for the next batch
>    of tasks.
>
> **Candidate layer guard comment consumer now wired (2026-08-14, deferred items cleanup Task D, commit 415353e)**:
> `candidateFindings.ts`'s `deathUnusedDefensiveEvents` (defensive available but unused at death) and
> `cdWasteEvents` (major defensive CD unused entire match) — the two locations most likely to produce "should have used 642/45438" suggestions —
> when hitting `curatedAbilityFacts.ts`'s new single-source helper `costNormPhrase(spellId)`,
> attach `facts.costNorm` phrase; `buildFindingsPrompt.ts`'s corresponding legend line explains the field's meaning
> (model can only suggest these abilities as "last resort under lethal threat", must not suggest as routine response).
> `CURATED_ABILITY_FACTS` now has its first consumer (previously the signed register had zero consumers, only a record).
> Deep dive handbook `docs/commands/deepdive-probe.md` "how to write decision point cards" section has a reminder added.

## 26. Two high-value streams discarded by the parsing layer from raw logs: mana values + SPELL_CAST_FAILED

Deep dive experiment free arm (2026-08-14, match 60ab1e8f) empirical evidence: parser's `advancedActorPowers`
being always empty is **a parsing layer choice, not log absence** — raw.txt's advanced parameters contain per-event mana values,
SPELL_CAST_FAILED stream (933 entries/match) contains player key-press intent (spell name + rejection reason). Both streams' unlocked
analysis capabilities have been empirically demonstrated:

- Healer mana war reconstruction (that match's death cause was reclassified as **mana death**: final 10 seconds Holy Shock rejected 15 times,
  mana 545/273000; all four previous rounds of constrained deep dive attributed the cause to defensive rotation, missing the root cause);
- Enemy healer drink detection and harassment prescription (three sit-downs recovering 144k mana, one tick of damage interrupting drink empirically demonstrated);
- Healer spell mana efficiency audit (Flash of Light 29% mana cost only bought 11% effective healing);
- Intent distinction for "no response" type conclusions (pressed but rejected vs. truly didn't press).
  Additionally: trinket (336126) cast is also only visible in raw (previously discovered).
  Direction: parser collects these two streams (or minimally: analysis side builds raw.txt auxiliary predicates), downstream feeds
  candidate layer (mana pressure candidate / drink harassment candidate) and deep dive tools. Evaluate parsing cost and slim migration impact before deciding.
  Reproduction scripts: gladlog-eval-private/review-sessions/freeform-60ab-scripts/.

> **2026-08-14 ability fact foundation project closing note**: not covered by this project, still an open item — mana values /
> `SPELL_CAST_FAILED` are **parsing layer (parser)** discarded raw log streams, not unmined fields in DB2 official data tables,
> and are unrelated to this project's A2 census (`docs/ability-fact-inventory.md` "A2. Official effect surface
> census" section, `dumpTableColumns.ts` per-column mined/unmined inventory of 7 candidate tables including `SpellMisc`/`SpellAuraOptions`) —
> A2's candidate pool has no fields that could substitute for these two streams. If systematic treatment of
> "what the parsing layer discards" is needed in the future, it should be a census dimension independent of A2, not searched for in A2's pool.

## 27. `aurasActiveAt`'s slice(0,10) truncation can hide critical auras (hard CC pushed out by cosmetic auras)

`packages/analysis/src/analysis/momentSnapshot.ts:76` hard-truncates the moment aura list to 10 entries, with no priority
sorting — 2026-08-14 free arm empirical evidence (match 76ea5f90): owner 2:48-2:53 frozen by Freezing Trap spanning the teammate's
entire death slide, but the trap aura was pushed out of the top 10, causing constrained arm two rounds (R1 "2:51 BoP could have saved", R2 "healing
gap 5 seconds") to both be built on the false premise of "he could move" — even the reviewer themselves misjudged and accepted. Fix direction:
sort by aura category before truncation (hard CC / immunity / major CD auras always in front, cosmetic at the back), or raise cap + annotate truncation.
Involves auras query and moment snapshot pack dual consumers — check predicate index before changing.

> **2026-08-14 ability fact foundation project closing note**: the truncation bug described here **has still not been fixed, remains
> an open item** (`momentSnapshot.ts:76`'s `slice(0, 10)` unchanged). But this project mitigated from another path
> a portion of the same false-premise family: this item's core mistake is "assuming owner could move" (aura list didn't show
> freeze), not "knowing CC'd but not knowing if abilities can be pressed" — `usableWhileStunned` officiating
> (Task 3/5, `usableWhileCcGenerated.ts` official 468 set ∪ signed register gaps/conditional layer, total 471)
> solves the latter type of misjudgment (e.g., #25's Divine Shield "can't be pressed"), has no help for this item's "CC state itself not being seen" type
> truncation problem — **the two are different stages under the same broad false-premise category, #27 still needs independent fixing**.

> **Fixed (2026-08-14, see commit)**: `aurasActiveAt` now sorts by `auraPriority` before truncation — hard CC
> (`spellId` ∈ `drAnalysis.ts`'s `DR_CATEGORY_MAP`) > major CD/immunity (`spellId` ∈
> `cooldowns.ts`'s `MAJOR_DEFENSIVE_IDS`, which already contains all `IMMUNITY_SPELLS` ids) > rest in original order,
> cap still 10. Replay acceptance (match 76ea5f90, `auras --t 170`, 2:48-2:53 Freezing Trap window):
> pre-fix Minilay aura list had no Freezing Trap, post-fix shows "Freezing Trap, Freezing Trap, …".
>
> **Diagnosis correction (2026-08-14, reviewer re-derived from raw to confirm)**: "Freezing Trap" appearing twice in replay
> is **not** two casts/sources — that window (160-176s) has only one real `APPLIED` (168.075s, caster
> Boofers). At 173.421s and 173.422s two close events arrive in succession (`SPELL_AURA_BROKEN_SPELL`
> caster Brucatodo, then `SPELL_AURA_REMOVED`): the first normally consumes the sole open interval; the second
> arrives with the open interval already consumed, finds no match, falls into `buildAuraIntervals`'s "pre-existing before match" fallback branch
> (`auraIntervals.ts:143-155`), back-projects a phantom interval using official duration (6s)
> `[167.422, 173.422]` — overlapping the real interval `[168.075, 173.421]` at `t=170`, `aurasActiveAt`
> thus renders the same CC as two entries. This is `buildAuraIntervals`'s own **dual-close-event race** pre-existing
> bug (same spellId closed by two different close events in a short window, second one misjudged as "pre-existing before match"),
> this fix only made it visible for the first time in `aurasActiveAt`'s truncated output — **not introduced or
> fixed by this item's fix** — **independently filed as BACKLOG #28, not fixed alongside this item**. Both consumers
> (`auras` CLI query, moment snapshot pack) tests all green; predicate index bilingual annotations synced.

## 28. `buildAuraIntervals` dual-close-event race fabricates phantom interval (logged 2026-08-14, root-caused by reviewer from #27 replay)

`packages/analysis/src/utils/auraIntervals.ts`'s close event handling (`CLOSE_EVENTS` =
`SPELL_AURA_REMOVED`/`SPELL_AURA_BROKEN`/`SPELL_AURA_BROKEN_SPELL`, pairing logic at
`:118-156`) assumes an open interval for the same spellId will only be closed once within the entire matching window. When the same spellId
receives **two different** close events in a very short time window, the first normally consumes the sole open interval; the second
arrives finding no matching open interval, falls into the "pre-existing before match, only seeing it drop this match" fallback branch
(`:143-155`), back-projecting a **phantom interval** using `officialDurationS` — fabricating a record that overlaps heavily
in time with the real interval but has fictitious boundaries.

**Reproduction**: match `76ea5f90`, Minilay, spellId `3355` (Freezing Trap), window 160-176s.
Real `APPLIED` only once (168.075s, caster Boofers). 173.421s's `SPELL_AURA_BROKEN_SPELL`
(caster Brucatodo) arrives first, closes normally, producing real interval `[168.075, 173.421]`; 173.422s (1ms later)
`SPELL_AURA_REMOVED` arrives, finds no open interval, fallback branch back-projects phantom interval using 6s official duration
`[167.422, 173.422]`. Both intervals cover `t=170` — any consumer querying this spellId at a time point will see
"two Freezing Traps" at `t=170`. #27's `aurasActiveAt` truncation priority fix made this
pre-existing but previously truncated/unnoticed phantom interval visible in the output for the first time — **#27's fix did not
create this bug, only stumbled upon it**.

**Mechanism summary**: the fallback branch's trigger condition is "close event arrives and `open` map has no
open interval for that spellId" — this condition was designed to handle the legitimate case of "only seeing the drop, never seeing the apply" across the whole match
(auras existing before match start), but doesn't distinguish "truly never APPLIED" from "APPLIED before but already
consumed by another close event that arrived earlier." The latter is the same real CC being redundantly reported by two close events (WoW
combat logs frequently emit more than one of `BROKEN`/`BROKEN_SPELL`/`REMOVED` for the same drop),
and should not be treated as a second "pre-existing" aura.

**Fix direction** (not designed, only recording direction): when a close event arrives with no matching open interval, if the same spellId
was **just** closed within a very short time window (needs a new constant, can't be arbitrary) (i.e., the most recent entry in `out` for the same
spellId has `toS` close to current event time), should be treated as a duplicate close event for the same CC instance — discard/dedup,
rather than unconditionally entering the "pre-existing" branch to back-project a new interval. The change should only affect this one judgment path, not touch open interval
normal pairing logic (`:96-104`), DOSE semantics, or the existing "exact key priority, same spellId fallback" close
strategy (`:122-129`, the target of the 2026-07-25 fix — don't regress the old problem it solved).

**Impact surface**: `buildAuraIntervals` is the single source for aura intervals — **all** downstream consumers affected —
`aurasActiveAt` (`momentSnapshot.ts`, where #27 stumbled upon it), `auraUptime` (uptime stats/rendering),
`counterfactual.ts` (mitigation counterfactual aura interval filtering), and any future consumers via `utils/auraIntervals.ts`.
**Not** the same thing: `docs/predicate-index.md`'s "not yet unified" section documenting
`utils/utils.ts` and `utils/auraIntervals.ts` having two same-named `buildAuraIntervals` — those are two different functions
(different signatures, different consumers, `utils.ts` version only feeds `burstLedger.ts`), this item
is a race bug internal to the `utils/auraIntervals.ts` function, unrelated to the name collision — fixing this doesn't involve that
name collision registration.

---

✅ **Fixed (2026-08-15)**.

**Measured first** (`packages/eval/scripts/auraDoubleCloseScan.ts` + `src/explore/auraDoubleClose.ts`,
full corpus, 1028 matches, 0 errors): this diagnostic script independently replays `buildAuraIntervals`'s
open/close pairing logic (does not touch production code) and, for every "close event finds no open
interval" fallback-branch trigger, additionally records "gap since the previous close event for the same
spellId" — a signal the production function itself never computes. Corpus-wide: the fallback branch fired
96089 times total, of which 32384 had no prior close at all (genuine "already up before the match, only
saw it drop" cases — unaffected by this fix); the remaining 63705 had a prior close, with the following
cumulative gap distribution: ≤0.01s 45719, ≤0.1s 53421, ≤0.5s 61620, ≤1s 63590, ≤2s 63613, ≤5s 63638,
≤10s 63673, ≤30s 63686 — **gaps cluster sub-second** (≤0.5s already accounts for 96.7% of the non-empty
gaps, ≤1s for 99.8%), and barely grow beyond that (1s→30s is only +96), proving that "redundant close
events double-reporting the same real drop" and "genuinely independent drops separated by a real gap" are
cleanly separated on the gap-distance scale — not an arbitrary call.

Classifying by a 1-second threshold (`DUPLICATE_CLOSE_WINDOW_S`, justification above): **63590 phantom
intervals, affecting 1023/1028 matches (99.5%)**. The incidence is this high because the underlying
mechanism is common — most hard CC (Freezing Trap, Polymorph, Cyclone, Psychic Scream, etc.) drops with
WoW's combat log frequently emitting more than one of `SPELL_AURA_BROKEN`/`BROKEN_SPELL`/`REMOVED` for the
same drop; `76ea5f90` was simply the first case the reviewer happened to run into.

**Mechanism**: when a close event arrives and the `open` map has no open interval for that spellId, the
original code unconditionally judged "already up before the match, this match only saw it drop" and
back-projected a fabricated interval from the official duration. The fix: instead ask whether this spellId's
most recent already-emitted close event (whether from normal pairing or an earlier fallback-branch hit) is
within `DUPLICATE_CLOSE_WINDOW_S` (= 1 second) — a hit is treated as a redundant close-event report of the
same real drop and discarded (no interval produced); a miss falls through to the original fallback branch.
The change touches only this one judgment path (`auraIntervals.ts:118-172`) — normal pairing, DOSE
semantics, and the existing "exact key priority, same-spellId fallback" close strategy are untouched. TDD
coverage (`test/ported/auraIntervals.test.ts`, 4 new cases): exact reproduction of `76ea5f90`'s dual-close
1ms race (now emits only one interval), a triple redundant-close pile-up (still only one interval), and two
negative controls (a genuine already-up-before-match isolated `REMOVED` is unaffected; two drops of the same
spellId 60 seconds apart still both back-project normally — not swallowed).

**Before/after numbers (same criterion)**: `76ea5f90` @173s, `aurasActiveAt` used to render "Freezing Trap,
Freezing Trap" (duplicated) → after the fix, just "Freezing Trap" (single). Two additional spot-checks
(`c84e13b5`'s Eranu multi-`BROKEN_SPELL` Polymorph chain, `d2a90ac4`'s Холод) show no duplicate names either.
The diagnostic script's own count (fallback-branch triggers with a ≤1s prior gap) — **63590 → 0** — uses the
exact threshold logic now running in production (not a re-derivation), so this is not "read the code plus a
convincing commit message"; it is a corpus-wide count-based verification.

**No regression in scope**: `packages/analysis` full suite (incl. `momentSnapshot.test.ts`,
`counterfactual.test.ts`) and `packages/desktop` full suite (incl. `report.aurauptime.test.tsx`) both green;
`npm run typecheck` and `npx eslint . --quiet` clean.

**Predicate-index cross-check**: the `utils/utils.ts` vs `utils/auraIntervals.ts` `buildAuraIntervals`
name-collision entry registered 2026-08-05 in `docs/predicate-index.md`'s "Not yet unified" section is
unrelated to this item (per the existing conclusion in the "Impact surface" paragraph above) — this fix does
not touch that name-collision registration and left the predicate index unchanged.

## 30. P1/P2 distillation final-review debt (logged 2026-08-15, `final-review.md`) — renumbered from the original "## 29" to make way for the cooldown-ledger t=0 blind spot entry below, which now legitimately occupies "## 29"

1. ~~**`extractMajorCooldowns` computes a negative `cooldownSeconds` for a handful of spellIds**~~ ✅ Fixed
   (`2d5993c8` + `547ec6f1`): `packages/analysis/src/utils/cooldowns.ts`'s existing cooldown-derivation logic,
   unrelated to the four new candidate types added by this P1/P2 distillation work. Task 5 calibration
   (`~/code/gladlog-eval-private/reports/p1p2-calibration.md`) sampling 1681 team-offensive major-CD casts from a
   300-match sub-sample found 5 (~0.3%) with negative values: `265187` Summon Demonic Tyrant (×4) and `1719`
   Recklessness (×1). The magnitude was small and did not affect any calibration conclusion, so it was not fixed
   inside the calibration task at the time — flagged here for the next time `cooldowns.ts`'s cooldown-derivation
   logic is touched. **Resolved in two passes**: `2d5993c8` root-caused it to the datagen generation layer, not
   `cooldowns.ts` itself — `genTalentModifiers.ts` classified DB2 aura 107/108
   (`SPELL_AURA_ADD_FLAT/PCT_MODIFIER`, a generic "apply one SpellMod" aura whose `EffectMiscValue_0` is the real
   sub-type selector, a SpellModOp code) as `reduce_cd` regardless of sub-type. Cross-verified against real DB2
   rows (build 12.1.0.69273) and Wowhead tooltips: `265187`'s two negative contributions were actually Master
   Summoner (`1240189`, `MiscValue_0=10=SPELLMOD_CASTING_TIME` — a cast-time reduction, not a cooldown one) and
   Reign of Tyranny (`1276748`, `MiscValue_0=1=SPELLMOD_DURATION` — a duration extension); `1719`'s were Reckless
   Abandon (`396749`, `MiscValue_0=23=SPELLMOD_EFFECT3`) and Rampaging Berserker (`1269310`, also `DURATION`).
   Fix: gate aura 107/108 on `EffectMiscValue_0 === SPELLMOD_COOLDOWN (11)` (effect 148 and the dedicated
   charge-recovery aura 453 unaffected), regenerating `talentModifiers.json` (118 spellIds / 160 modifiers, net
   −296 misclassified `reduce_cd` entries versus the pre-fix 189/456). A full-table invariant over every
   `CD_TALENT_MODIFIERS` spellId (single and stacked extremes, `cooldownSeconds >= 0`) went 61/372 failing → 0/218
   passing (exhaustive over existing data, not a sample); `265187`/`1719` both cleared. Independent review
   (`fix-29a-review.md`) of `2d5993c8` then caught a second, distinct bug: the `SPELLMOD_COOLDOWN` gate fixed
   _whether_ a modifier counted but not _whether its computed number had the right unit_ — DB2 aura 108
   (`SPELL_AURA_ADD_PCT_MODIFIER`) stores a percentage, but `genTalentModifiers.ts` ran it through the same
   flat-seconds path as aura 107, and `cooldowns.ts` then subtracted it as flat seconds too (Unbreakable Spirit is
   really −30%; against Divine Shield's base 300s that is −90s, but the pre-fix code only subtracted 30s — off by
   an order of magnitude). `547ec6f1` fixed this: added `ICDModifier.effect: reduce_cd_pct` and a new
   `cooldowns.ts` export `applyCdTalentModifiers(spellId, base, baseCharges, talentedSpellIds, pvpTalentIds)` that
   owns all modifier-application arithmetic, with flat-then-percentage stacking order matching TrinityCore's
   `Player::ApplySpellMod`/`GetSpellModValues` (`Player.cpp:22636-22860`) — sum all flat amounts first, then
   multiply that sum by all percentage factors. 9 talentSpellIds / 20 target entries affected (Unbreakable Spirit
   −30%, Righteous Protector −50%, Honed Reflexes −10%, Survival of the Fittest −12%, Ursoc's/Elune's Guidance
   −50%, etc.); the invariant test now calls `applyCdTalentModifiers` directly instead of re-deriving its own
   subtraction (`extractMajorCooldowns` and the test share one function — shared-predicate-is-the-spec), coverage
   widened from "`reduce_cd` only" to "`reduce_cd` + `reduce_cd_pct`", 221 cases green. Corpus check (local match
   library, full 1028 documents, 1511 `265187`/`1719` casts): 0 negative-value casts both before and after — the
   local corpus never happened to hit the triggering talent combination (both talents are niche), so there is no
   corpus-level before/after delta to report, recorded as-is; the real acceptance evidence is the full-table
   invariant (61→0, exhaustive not sampled) plus the TDD reproduction from real pre-fix DB2 rows (red→green) for
   both bugs. **Along the way this patch round turned up two adjacent issues it did not fully resolve at the
   time**: ① ~~`addModifier`'s dedup key `(talentSpellId, effect)` was "first-come-first-served", a
   non-deterministic order dependency, whenever two rows with different true values collided~~ ✅ Fixed
   (2026-08-15, `4bb23b99`, "talent-modifier dedup switched to TrinityCore stacking semantics — flat sum / pct
   multiply, order-dependence eliminated"): no longer guesses "which row is authoritative" and drops the other —
   two matched rows are now folded into one only when their values agree (via Path A/B/C multi-path matching, or
   the same aura's two `EffectIndex`es both hitting the same real modifier); when values differ, both are kept as
   two genuinely independent DB2 `SpellEffect` rows on that talent spell, handed to `cooldowns.ts`'s existing
   `applyCdModifiers` (the new pure-function core inside `applyCdTalentModifiers`, shared by
   `extractMajorCooldowns` and this file's own invariant test — stacking arithmetic lives in exactly one place) to
   stack per TrinityCore's `Player::GetSpellModValues`/`ApplySpellMod` (`Player.cpp:22773-22860`,
   `TrinityCore/TrinityCore@master`, verified against source this round) — multiple `SPELLMOD_FLAT` rows sum
   (`*flat += value`), multiple `SPELLMOD_PCT` rows multiply (`*pct *= 1+value/100`). TDD: synthetic fixtures (two
   flat + two pct rows on the same talentSpellId→target pair — different values keep all four, matching values
   fold to one) plus a real-collision regression fixture (all 4 instances the current corpus hits:
   `50334`/`381647`/`344359`/`1270255` against target `11`). Regenerating `talentModifiers.json` produced an empty
   diff — the collision lands on `11` (a deprecated spellId not in `trackedSpellIds`), so `filteredResults`
   filtering had already dropped it before it could reach product code either way; zero product impact, same as
   before, only the semantics changed from "guess one, drop one". `console.warn` narrowed to fire only when values
   agree but `isConditional` conflicts (a shape that should never happen) — it no longer warns on "two rows with
   genuinely different values". ② Unbreakable Spirit's official tooltip lists 4 benefiting spells (Divine
   Shield/Lay on Hands/Ardent Defender/Divine Protection); the existing table's `SpellClassMask` matching hit
   variants of the first three but missed Lay on Hands (`633`) — traced to `633` simply not being in
   `classSpells.ts`/`spellIdLists.ts`'s `trackedSpellIds` at all, a gap one layer earlier in the generation
   pipeline (spell-coverage scope), not an aura-107/108-classification issue from this round — not fixed this
   round, left for the next time `classSpells.ts`'s Paladin spell table is touched.
2. ~~**`unsyncedBurstEvents`'s `healer` fact always takes the first enemy healer, while the CC-overlap check spans
   all enemy healers**~~ ✅ Fixed (`8c4ea6f9`, Task 9 commit 1, "unsynced-burst healer fact covers all enemy
   healers — double-healer mis-attribution fix"): in `packages/analysis/src/analysis/candidateFindings.ts`, the
   `teamPlayEvents` wiring site (originally `enemies.find((e) => isHealerSpec(e.spec))?.name`) fed
   `unsyncedBurstEvents` only the first matching enemy healer, but the `ccWindows` (`enemyHealerCcWindows`) it
   consumes already covers **all** enemy healers — the `hasHardCc` gate reads "was **any** enemy healer hard-CC'd
   inside this window", so a pass (zero overlap) proves every enemy healer was free at the time, not just
   whichever one `.find()` happened to pick. Under a double-healer comp the fact's named healer could be the
   wrong one, mis-attributing blame. Fix: `unsyncedBurstEvents`'s third parameter changed from
   `healerName: string | null` to `healerNames: string[]` — the fact/`unitNames` now name every enemy healer
   (comma-joined, matching the existing `missedSyncWindowEvents`/`readyCds` convention), the wiring site's
   `.find()` became `.filter()`, and `packages/eval/src/explore/candidateCalibration.ts`'s mirror predicate
   (`RoundContext.enemyHealerName` → `enemyHealerNames`) was updated in lockstep to keep parity. New double-healer
   fixture test in `candidateFindings.test.ts`. This was the mandatory precondition (final-review
   `final-review.md` decision i) before `CANDIDATE_TYPE_FLAGS.unsyncedBurst` (Task 9 commit 2) could be flipped
   `true` — now satisfied.

## 29. Cooldown ledger "never cast this round ⇒ ready since t=0" default is wrong under cross-round CD carryover (logged 2026-08-15, surfaced by #26 Task 2 review's reason-distribution forensics)

`extractMajorCooldowns` (`packages/analysis/src/utils/cooldowns.ts`) has no way to see a cooldown state that existed
**before** the current round's own log window began — when a major CD has zero recorded casts in the round so far, the
ledger defaults to "never cast ⇒ available since round start (`readyT`/`facts.t` = 0)". This default is silently wrong
whenever the cast that actually put the ability on cooldown happened in a **previous** round of the same Solo Shuffle
lobby (or, in principle, a prior arena bleeding into the same continuous log session) — the ledger has no cross-round
memory, so it reports the ability as available the whole time even though the game itself would reject a cast.

**How this was found**: not a direct audit of the ledger — the intent guard (#26 Task 2, `castFailedInWindow`) is the
first mechanism ever cross-checking the ledger's "available" windows against the game's own authoritative
`SPELL_CAST_FAILED` signal, and that cross-check is what surfaced the disagreement. Task 2's review did reason-
distribution forensics on a 60-item cd-hoarded sample (201 rounds scanned): of the guard's hits, the single largest
reason bucket, "尚未恢复"/still-on-cooldown (38.7% of all hits), is **not** evenly spread — 73.6% (53/72) concentrated
in one spell, **Ultimate Penitence**. A follow-up 120-item scan isolated to Ultimate-Penitence "尚未恢复" candidates
found **26/26 (100%) have `readyT === 0`** — i.e. every one of these is exactly the "no cast recorded yet this round"
shape. One instance was traced against real raw.txt: match `3df6ccf8`, round 0 — the candidate claims Ultimate
Penitence was ready from `t=0`, but the log shows the owner's own `SPELL_CAST_FAILED` "尚未恢复" firing repeatedly
(5 times) starting well after `t=0`, with the eventual successful `SPELL_CAST_START` landing only at the candidate's
own `castT=126`. The ability was demonstrably **not** available at `t=0` — some prior cast (most likely in an earlier
round of the same shuffle lobby, sharing one continuous raw.txt/session) put it on cooldown, and the ledger simply
can't see across the round boundary. Tranquility shows a smaller instance of the same shape (8/12 "尚未恢复" hits in
the 60-item sample) — plausible same root cause, not traced to the same depth (time budget).

**Current mitigation is a mask, not a fix**: the intent guard already downgrades these specific candidates' severity
one tier (since the player genuinely could not press the button at those instants, whatever the true underlying
reason — downgrading is still defensible in isolation). But the candidate's own `facts.t`/`facts.lateS` values remain
wrong underneath the downgrade — the model may still be coached with "you sat on this for 126s" (just one tier
softer) when the true hoard duration attributable to the player inside this round could be much shorter, or zero.

**Fix direction** (not designed, only recording direction): `extractMajorCooldowns`'s "never cast this round ⇒ ready
since round start" default needs pre-window cooldown-carryover modeling — at minimum for Solo Shuffle rounds sharing
one raw.txt/one continuous session, where the previous round's own cast ledger (or its own raw.txt tail) is directly
available and could seed the next round's "last known cast time" instead of resetting to null. A prior arena bleeding
into the same log session (not a shuffle round boundary) is a harder case with no clean data source and may need to
stay an accepted gap.

**Numbers to start from** (60-item / 201-round sample, cd-hoarded only — see
`.superpowers/sdd/2026-08-15-raw-streams/task-2-review.md` for the full reason-distribution table): 尚未恢复 = 38.7%
of all guard downgrades; 73.6% (53/72) of that bucket is Ultimate Penitence; ~28% of _all_ cd-hoarded guard hits in
the sample are Ultimate-Penitence "尚未恢复"; 100% (26/26) of a wider 120-item Ultimate-Penitence "尚未恢复" sample
have `readyT===0`. death-unused-defensive was not independently forensically audited at this depth (its guard-hit
count is far smaller). Measure incidence rate on the full corpus before designing the fix.

## 30. Per-healer name-fallback for cast-id/heal-tick-id drift is scoped, not structural (logged 2026-08-15, #26 Task 4 review M1)

`manaEfficiencyEvents` (`packages/analysis/src/analysis/candidateFindings.ts`) resolves a `healOut`/`absorbsOut`
event back to the cast that produced it via `resolveAgg`: exact `spellId` match first, then a `idByName` fallback —
matching the event's own `spellName` against the healer unit's own cast list — for the real cases where WoW logs a
spell's heal-tick under a **different** numeric spellId than its own cast (found via this task's real-match sanity
check on match `60ab1e8f`: Holy Shock casts as `20473` but its `SPELL_HEAL` events log under `25914`, identical
`spellName` on both; Prayer of Mending similarly casts as `33076` but heals as `33110`).

The fallback is deliberately scoped **per healer unit only** — built fresh from that one unit's own
`spellCastEvents` for each call, not a match-wide or cross-unit table — and the in-code comment reasons through why
a within-one-player name collision across two truly different abilities isn't a realistic risk in modern retail (a
character has exactly one castable ability per display name in their own kit at any time). Review disposition:
acceptable as shipped, not release-blocking (flag off, two regression tests pin the exact 60ab1e8f shape).

**Structural hardening not built here**: if a future consumer needs this same cast-id/heal-tick-id correspondence
match-wide or cross-unit (e.g. a match-level "which spell produced this heal" table, or extending `mana-efficiency`
to score pets/guardians whose heal events might reference the owner's cast list), the per-unit `idByName` closure
built inline in `manaEfficiencyEvents` won't generalize — it would need promoting to a proper shared predicate (own
export, own test, registered in `docs/predicate-index.md` per CLAUDE.md's shared-predicate rule) rather than being
copy-pasted into a second call site. No consumer needs this yet; revisit if/when one does.
