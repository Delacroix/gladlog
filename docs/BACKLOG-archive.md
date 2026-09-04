# BACKLOG Archive (Completed Items)

**Completed** items migrated from [BACKLOG.md](BACKLOG.md), retaining original numbering and all implementation notes
(completion dates/commits/spec pointers are in each section heading and body text). Non-blocking incidental leftovers
noted within individual sections have pointers in the Session follow-ups section of BACKLOG.md. Document created 2026-08-06.

## 2. Interrupt (kick) dashboard ✅ (2026-07-22, shipped together with #3, f145aaf: KickDashboard two-team aggregation + per-entry audit + seek; shares the `analyzeKickAudit` predicate with the burst ledger)

A per-match (and maybe cross-match) view of interrupts: kicks landed vs. missed,
by player, interrupt availability windows, locked schools, wasted kicks.

- **Already have the data:** `packages/analysis/src/utils/enemyInterrupts.ts`
  (`computeEnemyInterruptAvailability`) + the `[KICK]` timeline events in
  `buildMatchContext`. This is mostly an **aggregation + renderer** on top of
  existing analysis, not new parsing.
- **Scope signals:** small–medium. A new report tab/panel in the desktop
  renderer + a small aggregator in `analysis` (kicks by caster/target, hit/miss,
  interrupt uptime). Reuse the report UI patterns (FindingsList/TimelineStrip).

## 3. Purge / dispel dashboard ✅ (2026-07-22, shipped together with #2, f145aaf: DispelDashboard bidirectional ledger + missed purge/missed dispel lists + CC removal rate; `reconstructDispelSummary` shared predicate)

A view of offensive purges and dispels: purges done, **missed purge
opportunities** (an enemy buff left up), by player, plus friendly dispels.

- **Already have the data:** `packages/analysis/src/utils/dispelAnalysis.ts` +
  the `[MISSED PURGE OPPORTUNITY]` / `[CLEANSE]` / `[MINOR DISPELS]` timeline
  events in `buildMatchContext`. Again mostly **aggregation + renderer**.
- **Scope signals:** small–medium, parallel to #2 (same shape: aggregator in
  `analysis` + a report panel). Could ship #2 and #3 together as a "utility
  dashboards" sub-project since they share structure.

## 4. Burst-window analysis timeline (visual) ✅ (2026-07-29 shipped: report Timeline bottom pressure lanes with DMG SPIKE click-to-set-window connecting to #16 + HEALER EXPOSURE markers; TimelineStrip deprecated in the same pass — confirmed this component has no instantiation point in production (KeyMomentAxis has replaced it, only exists in faithfulness test fixtures), confirmed 2026-07-29; spec docs/superpowers/specs/2026-07-29-pressure-lanes-design.md)

A visual timeline of offensive/burst windows, damage spikes, and healer-exposure
moments — the "bursting window" timeline from the old repo's analysis view.
Today gladlog only renders _deaths_ on `TimelineStrip`; this adds the burst/
pressure lane.

- **Already have the data:** `buildMatchContext` emits `[OFFENSIVE WINDOW]`,
  `[DMG SPIKE]`, `[HEALER EXPOSURE]` via `computePressureWindows`
  (`packages/analysis/src/utils/healerMetrics.ts` / `context/*`). The candidate
  data exists; this is a **timeline visualization** on top.
- **Old-fork reference (concept):**
  `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
  - `TimelineStrip.tsx` (the burst/offensive-window timeline strip) and
    `CombatReplay/` for the scrubbable timeline. gladlog's own `context/matchTimeline*`
    already ports much of the _data_ side.
- **Scope signals:** medium — extend the existing `TimelineStrip` (currently
  deaths-only, `packages/desktop/src/renderer/src/report/components/TimelineStrip.tsx`)
  to render burst/pressure/exposure lanes with hover detail. Ties in with #1
  (video sync) if that ships — the same timeline could scrub the recording.

## 5. Settings UI (Anthropic API key + model) ✅ (actually already completed, status not updated: settings page with API key/backend/model/language etc. shipped with the 2026-07-18 three-phase UI launch, expanded in multiple subsequent iterations; 2026-08-06 archive note)

There is currently **no GUI to enter the Anthropic API key** — only the DevPanel
AI-backend dropdown. That's why the app shows `NO_API_KEY`. Add a real settings
panel: API key (write-only, redacted like the main-process store already does),
model, WoW dir, AI backend. Small; the IPC (`settings.get/save`, `redactSettings`)
already exists — this is renderer UI.

## 6. 2D positional replay ✅ (actually already completed, status not updated: ReplayView with map + GCD lanes + speed control + deep-dive-this-moment already live, iterated over multiple rounds since 2026-07; 2026-08-06 archive note)

A scrubbable top-down arena replay (positions, HP, casts, dampening over time) —
distinct from #1's video. Old-fork reference: `CombatReport/CombatReplay/` (Pixi.js
— `ReplayCharacter`, `ReplayHealthBar`, `ReplayCastBar`, `ReplayDampeningTracker`,
speed control). gladlog already parses advanced-logging coordinates (positioning
section in `buildMatchContext`), so the data exists. Medium–large; shares the
timeline seam with #4.

## 7. Competitive stats / trends ✅ (actually already completed, status not updated: StatsDashboard with win rate / per-spec / per-map aggregation shipped with the 2026-07-18 three-phase UI launch; 2026-08-06 archive note)

Cross-match aggregation: win rate over time, per-spec/per-comp performance, a tier
list. Old-fork reference: `CompetitiveStats/` (`SpecStats`, `CompStats`,
`TierList`). gladlog stores every match locally, so this is aggregation + a new
view — no cloud needed (unlike the old fork's server-backed version).

## 8. Deterministic mistake detection ✅ v1 (2026-07-23 shipped on release/0.1 branch, c59ba8c: MISTAKE_RULES 8 rules across 3 severity tiers + anti-corruption tests + MistakesCard/timeline ⚠; all consuming existing deterministic predicates, no LLM involved. To add rules, just declare them in the MISTAKE_RULES table)

A rules-based "mistakes" engine that flags concrete errors (trinket held through a
full-DR CC, defensive wasted, kick missed) **without an LLM** — complements the AI
findings with cheap, always-available, fully-verifiable output. Old-fork reference:
`CombatReport/CombatMistakes/` (`analyzeMistakes` + `mistakeKnowledgeBase`). Fits
gladlog's honesty ethos (deterministic, grounded) and reuses the existing
`candidateFindings` / analysis utils. Medium.

## 9. Match search / filter ✅ (2026-07-22 completed, fc2c73b: on top of existing win/loss, bracket, single-spec filters, added comp filter (spec chips, all teammates must match) and date range; after #12 makes all metadata resident, pure client-side filtering covers the full set without touching MatchStore)

Filter the (now paginated) match list by spec, bracket, comp, result, date. Natural
follow-on to the windowed list — extend `MatchStore.page` with predicates and add
filter controls to the sidebar. Small–medium.

---

## 10. Surface the structured analysis (currently LLM-text-only) ✅ closed out (2026-08-01)

gladlog computes a deep per-match analysis (~40 signals) inside `buildMatchContext`
but feeds _all_ of it to the LLM as text — the UI surfaces only the 6 healer
metrics + deaths/cd-waste. The rest is invisible to the user. Items #2 (interrupts),
#3 (purge), #4 (burst timeline) are subsets of this. Other computed-but-unshown
signals worth their own panels/lanes:

- **Diminishing returns / dampening** — `computeIncomingDR`, `computeDampeningTimeline`, `buildDampeningEvents`. ✅
  (2026-08-01: Timeline added `dampening?` lane, `dampeningSeries.ts` changed to consume
  `buildDampeningEvents` + `getInitialDampening` with event-level forward-fill).
- **CC chains** — `analyzeOutgoingCCChains`, `extractAoeCCEvents`, healer-CC-received. ✅
  (2026-08-01: new `CCChainPanel` consumes `analyzeOutgoingCCChains` unfiltered full chains, row expansion showing per-cast + DR tier;
  `dr-clipped-cc` subset already in `MistakesCard`; healer-CC-received aggregation is part of baseline 6 metrics, per-CC-received events shown on
  `KeyMomentAxis`; `extractAoeCCEvents` remains text-only, determined to overlap with CC chain panel info, no separate item created).
- **Kill windows / target selection** — `analyzeKillWindowTargetSelection`, `buildKillSequenceBlock`, contested-trade facts. ✅
  (2026-08-01: `BurstLedgerCard` "window target discipline" section wired to `analyzeKillWindowTargetSelection`,
  `betterTargetExists` highlighted in red showing the preferred target).
- **Positioning / LoS** — `computeOwnerPositionEvents`, `analyzeHealerExposureAtBurst`. ✅
  (2026-08-01: `computeOwnerPositionEvents` piped into barrel, STAYED_IN (requires `stayedInHadRealCost` to verify real cost)
  / MISSED_PUSH / CD_OUT_OF_RANGE — three types routed to `KeyMomentAxis`; `analyzeHealerExposureAtBurst` was previously already
  wired via `computeHealerExposureEvents` as single source into #4 pressure lanes).
- **Defensive management** — `detectFriendlyCDOverlaps` (**dead code, deleted**, along with `IOverlapCast` /
  `IFriendlyCDOverlapGroup` / `formatFriendlyCDOverlapsForContext`, verified zero call sites repo-wide),
  `detectOverlappedDefensives`, `detectPanicDefensives`, `findCheaperDefensiveAlternatives`,
  `computeCDResponseLatency`. ✅ (2026-08-01: `detectPanicDefensives` wired to `DeathRecapCard` /
  `KeyMomentAxis` defensive entries with "panic usage" annotation; `findCheaperDefensiveAlternatives` cheaper-alternative
  text wired to death recap; aggregate ratios/latency already part of baseline 6 metrics, per-cast Early/Optimal/Reactive labels already in
  `KeyMomentAxis`).
- **Healing gaps** — `detectHealingGaps`, `computeSlackSegments`, `computeHealingInWindow`. ✅
  (2026-08-01: `detectHealingGaps` routed to `KeyMomentAxis` (`heal-gap` kind) + `healerMetrics` added
  `healingGapSeconds` / `healingGapCount` scalars, plumbed through ProComparison/corpus-tools/preload).
- **Trinket usage** — `analyzePlayerCCAndTrinket`, `detectTrinketType`. ✅ (2026-08-01 code audit:
  this predicate is already a shared input for `DeathRecapCard` / `KeyMomentAxis` / pressure lanes / `healerMetrics`,
  trinket state is structurally visible at every point, no separate item needed).
- **Death root-cause** — `buildDeathRootCauseTrace`, `findContributingDeath`. ✅ (2026-08-01 code audit:
  these two functions are dead code in the UI path, but the same "why did they die" structured breakdown has been
  superseded by #17b's `computeMitigationAudit` + counterfactual series, rendered per-entry in `DeathRecapCard`,
  no longer "death moment visible, cause is plain text").
- **Match arc / flow** — `buildMatchArc`, `buildMatchFlow`, `extractMatchDynamics`. ✅
  (2026-08-01: new `buildMatchArcStructured` single-source structured early/mid/late phases + turning points, `buildMatchArc` changed to
  purely format its output, prose byte-for-byte unchanged; render layer added `MatchArcLine` report header row with three phases, clickable turning-point jumps;
  `buildMatchFlow` / `extractMatchDynamics` are deprecated/internal auxiliaries, not consumed, out of scope for this round).

Approach: promote these from `buildMatchContext` text into structured events (like
`extractCandidateFindings` does for deaths/cd-waste) so both the UI _and_ the
findings pipeline can use them — and so #8 (deterministic mistakes) has grounded
inputs. Big theme; slice into panels/lanes over several sub-projects.

Note: `extractRotations` is computed but only consumed by offline `corpus-tools`,
not the app — either surface it or leave it corpus-only by design.

**2026-08-01 closed out** (plan `.superpowers/sdd/2026-08-01-backlog10-surfacing/`, 5 tasks,
9 commits, `60441ad..2a85724`): all eight signal groups surfaced, see per-item ✅ notes above. All consuming existing analysis
predicates with zero new computation (the only new function is `buildMatchArcStructured`, which structures previously discarded internal values, prose output
byte-for-byte anti-corruption tested); presubmit all green (lint/typecheck/test/verify:vision/build).

3 incidental minor items left (all logged, non-blocking, to be addressed opportunistically):

- Timeline dampening lane has pointer-events dead zones (hover title overlay doesn't cover the full new lane area).
- `detectPanicDefensives` enemy-side call site and friend-side predicate naming have a second spelling inconsistency.
- `keyMoments.ts` and `ProComparison`'s owner fallback chains should share a single `resolveOwner`; currently each has its own implementation
  (unreachable today, needs consolidation before POV selector ships).

## 11. Report detail breakdown (wowarenalogs original detail level) ✅ (2026-07-18 completed: meters inline expansion, output/healing/damage-taken three modes; damage-taken by source and interrupt/dispel lists not done — user did not select them)

User request (2026-07-18): current report meters only show per-player totals (one row each for damage/healing),
less informative than old wowarenalogs' detail view. Goal: click on a player → detailed breakdown:

- **Output by spell**: total damage/share/count/crit rate/max hit per spell;
- **Healing by spell** (including overheal percentage);
- **Damage taken by source**: who hit you with which spell for how much (essential for death analysis);
- **Healing received by source**; optional: per-entry interrupt/dispel/CC lists.

Data is all in unit event arrays (aggregate damageOut/healOut/damageIn by spellId),
pure derive + expandable UI (meters row click-expand or standalone detail tab). Complementary to #10's
structured panels: this is "raw ledger", #10 is "analysis conclusions".

## 12. Lazy-load background backfill + live stats updates ✅ (2026-07-18 completed, see App.tsx background backfill loop + StatsDashboard matchStored subscription)

User feedback (2026-07-18): current lazy-load (only parse the most recent N matches for first screen) does load fast,
but has two gaps:

1. **No background backfill**: after the first screen, remaining matches are never parsed during idle time, scrolling down the list /
   searching for old matches still shows gaps; after first-screen render, use an idle queue (per-match, interruptible) to backfill remaining
   matches into the in-memory cache.
2. **Stats dashboard doesn't update with backfill**: the stats page still only counts the initially loaded few matches — after a backfill
   batch completes, incrementally recompute aggregations (or at least show "counted X/Y matches" + manual refresh),
   otherwise win rate / per-character stats are wrong for veteran players.

Related: docs/plans/2026-07-19-large-match-load-optimization.md (Plan A's
workerHost async parse + LRU already designed, can serve as execution vehicle for background backfill).

## 13. Deep-dive global anchors / non-kill mistakes as standalone findings (logged 2026-07-19) ✅ (2026-08-01 closed out: auto-sweep version, see end of section)

Current state: deep-dive is a **magnifying glass** — it only collects evidence within the `[-30s, +10s]` window
of moments already marked as findings in round 1 (including positioning), and does no global scan. If a time period
has no round-1 finding, even if there are positioning mistakes or other evidence there, they **will not** enter
deep-dive (see [[gladlog-deepdive-value]]).

Direction: let non-kill mistakes serve as **standalone anchors / new findings**, rather than only supplementing
existing finding windows. The raw signals mostly already exist (`candidateFindings.ts`'s `unconverted-burst` /
`burst-into-immunity` / `off-target-in-window` / `juked-kick` / `dr-clipped-cc` / `cd-waste`, plus positioning
mistakes from `computeOwnerPositionEvents`). Trade-off: this transforms deep-dive from "explain known deaths
thoroughly" to "discover issues that round 1 missed", which requires the same signal gate (hasCoachableSignal
spirit) + audit, otherwise re-introduces noise/filler risk.
Overlaps with #8 (deterministic mistake engine) and #10 (structured signal surfacing) in direction — all three
should be thought through together on the product form of "help during non-kill segments" before starting.
This item is one candidate implementation path from that brainstorm.

> **2026-08-01 code-level audit check**: after 2026-07-23, #8 deterministic mistake engine already lets 9 types of non-kill candidates
> become standalone list items independent of round-1 findings; the round-1 prompt has had non-death coverage hard rules since 2026-07-18
> (`buildFindingsPrompt.ts:47`), evidence menu three-window coverage went from 0/17 → 11/17 (07-24). #16 windowOverride
> (`buildWindowPack`, `deepDive.ts:999`) proved the "arbitrary window + same signal gate" mechanism works, but still requires user-triggered
> selection. What truly remains is just automation: making this mechanism auto-sweep across the entire match, instead of waiting for user clicks
> or round-1 finding hits — `analysisInput.ts:97-134`'s auto deep-dive path still strictly anchors on `finding.eventIds`, zero global scanning.

**2026-08-01 closed out** (spec `docs/superpowers/specs/2026-08-01-backlog13-autosweep-design.md`):
the automation half is now filled in — full-match 20s windows, 10s step, running #16's existing signal gate
(`buildWindowAnalysisRequest`, zero re-implementation), overlaps with existing anchors (round-1 findings time anchors
∪ deterministic mistake list `deriveMistakes`'s `tS`) within ±5s tolerance are discarded, hitting windows are merged with
union boundaries, ranked by signal density (pack.items count) descending and top 3 taken. AI analysis view adds
"Uncovered Highlights" card below the findings section (not rendered when zero highlights), clicking
[AI Analyze This Segment] directly reuses #16's `runWindowAi` (set window + trigger, zero new IPC, shares cache/force semantics).

The sweep itself is fully deterministic (no model calls); only when the user clicks the card button does an actual model call fire
— continuing #16's cost discipline. Implementation: `derive/uncoveredHighlights.ts` (pure geometry, mock
signal gate unit tests covering hit/dedup tolerance boundaries/merge islands/rank trimming) +
`components/UncoveredHighlightsCard.tsx` + `MatchReport.tsx` /
`StructuredAnalysisPanel.tsx` wiring (`onFindingsAnchors` callback feeds round-1 findings
time anchors to parent). Real fixture integration test confirmed this chain truly reuses the gate (90s/9 windows
<30ms, not a fake green disguised as passing).

Boundaries (v1 not doing, see spec): auto-sweep highlights are not auto-promoted to findings; not in batch analysis; not surfaced in
non-AI views; window width/step not configurable.

## ~~spellNames 12MB top-level await blocking first screen~~ ✅ fixed (2026-07-19)

**Symptom**: first screen (report render / app cold start) consistently takes ~22-25 seconds.

**Root cause is not "large file", but "compiled as source code"**: `spellNames.json` has 410K keys,
Vite 5 by default converts JSON to a **JS object literal**, and V8 must parse it as source code. The same data
takes only **42ms** with `JSON.parse` — three orders of magnitude difference.

**Fix**: all three build targets (main/preload/renderer) and the test bench config enable
`json: { stringify: true }`, making Vite output `JSON.parse("…")`. One line of config,
no API changes, no modifications to the 40+ `getEnglishSpellName` call sites.

**Results** (measured in CI):

| Metric             | Before      | After      |
| ------------------ | ----------- | ---------- |
| App cold start     | 18.7–24.0s  | 1.59–1.72s |
| Report first render| 21.9–27.0s  | 2.12–2.19s |
| Visual suite total | 3.0 min     | 22 sec     |
| E2E suite total    | 1.3 min     | 14.5 sec   |

The three budgets in `qa/budgets.ts` were tightened accordingly from 5100/41000/36000 to 4900/3300/2600.

**Lesson for future developers**: before bundling large JSON, verify it goes through `JSON.parse` rather than
an object literal. This pitfall produces no errors, only manifests as "startup is slow", and only becomes visible
above a certain size threshold.
The QA system's performance budgets exist precisely so this kind of regression doesn't rely on humans noticing it —
it was caught by `[budget] coldStart`, not by someone "feeling it was a bit slow".

## 15. AI analysis text inline icons (spell/class names → icon + Chinese name) ✅ (2026-07-28 shipped: render-layer post-processing inlineRich + zhCN dictionary generated artifact; spec docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md)

User's exact words: "In the log analysis, spell names and character classes would be more intuitive as icons — you use icons
on the other pages, why not in the analysis? The AI says I missed a normal Tranquility, and I'm still guessing from the English name."

Current state: other report views (lanes/meters/detail/mistake cards) all render icons via `SPELL_ICONS_GENERATED`,
but AI-produced narrative/findings/deep-dive text is plain text with spell names appearing in English; deep-dive
chips already have `spellId` (icon only), but body text does not. Chinese users have to guess English spell names.

Direction: **render-layer post-processing**, without touching the prompt/audit chain (raw number audit, claimChecker all operate on
text, must interpolate first then replace). Known spell names in findings/deep-dive/narrative text are replaced via an "English name → id"
reverse lookup table with inline components (icon + localized name); class/spec names likewise (`classMetadata`).
Reverse lookup ambiguity (same name, multiple ids) resolved by taking the one with an icon / higher corpus frequency; replacement doesn't
modify stored text, display only.
Scope: small–medium, pure renderer + a shared `<SpellInline>` component.

## 16. Selected time range → [AI Analyze] (arbitrary window on-demand deep-dive) (logged 2026-07-27, Bilibili user feedback) ✅ (2026-07-29 shipped: TimeRangeBar selection → windowOverride pack construction → window-mode deep-dive → WindowAnalysisCard; zero-signal zero-cost path; windowAnalysis.<lang>.json LRU cache; spec docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md; real model filler smoke pending real device)

User scenario: after reading the full match analysis, select a segment on the timeline, click [AI Analyze], and see
"are there other possibilities" for that segment.

Existing foundation: the deep-dive pack is already window-based — `buildDeepDivePack` collects evidence from any
`[minT-30, maxT+10]` window (CC/defensives/enemy CDs/HP/dispels/positioning/available-unused), independent of
the specific round-1 finding type. Swap the window for the user-selected `[from, to]`, create a synthetic
finding anchor, and the entire pipeline is reused (pack → prompt → audit → chips jump to replay).

Same direction as #13 (deep-dive global anchors): #13 is the system automatically finding non-kill anchors, this item is
**user-specified window**, simpler to implement, more intuitive as a product, can serve as an advance validation for #13.
Note: when there's no coachable signal in the window, honestly output "no issues found in this segment"
(hasCoachableSignal gate retained, empty result is valid output, don't force-generate advice for clicks);
latency/cost of a single model call needs UI expectation management.
Scope: medium — renderer selection interaction + IPC + analysisService reusing the deep-dive pipeline.

## Multi-model analysis comparison ✅ shipped (2026-08-01, spec/plan at `.superpowers/sdd/2026-08-01-multi-model-analysis/`)

Analysis cache changed to slotted storage (`AnalysisSlot` / `AnalysisCacheDocV2`, slot key
`${backend}:${model}`) + panel tab switching (only shown when ≥2 slots) + "analyze with another
model" split arrow next to the analyze button (temporarily switches backend/model for one run, doesn't write to global default settings). Final review also fixed a renderer production build hygiene issue: `shared/analysisCache.ts` top-level `import "path"`
was indirectly pulled into the browser bundle by renderer-side `slotLabel.ts`, causing `electron-vite build` to
consistently fail (vitest/tsc can't catch this, only production build does) — extracted zero-fs/path-dependency
`shared/analysisSlots.ts` housing all pure slot logic, `analysisCache.ts` retains only Node-specific
`analysisCachePath` + deprecated v1 envelope, `export *` keeps main-side old import paths unchanged.

**Final review remaining item (handoff item, handle next time `StructuredAnalysisPanel.tsx` is touched)**:
old slot tabs with invalidated cache (prompt version upgrade etc.) correctly show placeholder prompt and don't clear underlying
`result`, but the top status line ("Cached · N findings") and Export still read from the underlying old
`result` — in placeholder state these two will show stale slot numbers/content that don't match the placeholder message, won't
crash, just visually inconsistent, can be disabled or hidden in the same batch. **Closed 2026-09-04 (GH #38)**: status line now shows a stale-slot message and Export is hidden while the placeholder is up.

## 20. AI analysis chat box (logged 2026-07-30, user request) ✅ (actually already completed, status not updated: Ask Coach shipped 2026-08-02, spec docs/superpowers/specs/2026-08-02-coach-chat-design.md, CLI three-backend resume sessions; 2026-08-06 archive note)

Add a **chat box** to the AI analysis view: users can ask follow-up questions about the current match analysis ("why did you say I
used wall too early?" "what should I have done differently during the 2:08 burst?"), and the AI continues the conversation with
existing context (analysis cache findings/deep-dive evidence packs/match data), instead of being a read-only one-way report.

- **Existing foundation**: the analysis service already has complete prompt construction (buildMatchContext/deep-dive evidence packs/
  window mode), streaming emit channel (`gladlog:analysis:delta`), per-match cache; chat =
  adding multi-turn message history + an input box UI on top of these.
- **Think it through before starting**: context strategy (re-sending full match context every turn is expensive, consider first-turn system +
  incremental history), relationship with deep-dive/selected-segment analysis (#16) (chat may replace part of "pre-made follow-ups"),
  whether to persist chat history, cost guardrails (local backend vs API billing).
- **Status**: logged, not scheduled.

## Session follow-ups (completed items, migrated from the same-named section in BACKLOG)

- ~~**SP-B2.1**~~ ✅ (2026-07-29 shipped: userData/reference_vectors.json override path,
  bad file falls back to built-in; to swap in new corpus = drop new json into user data directory and restart) — CDN corpus refresh
  (ship an updated `reference_vectors.json` without a full rebuild).

- ~~**zh/EN analysis-language toggle**~~ ✅ (actually already completed, status not updated: settingsStore.aiLanguage + buildCoachSystemPrompt language injection + per-language cache partitioning + SettingsPanel toggle + panel follows, all LLM outputs — narrative/deep-dive/findings/comparison commentary — consume this setting; verified 2026-07-22) — the prompts/output are zh-leaning; a
  language switch for findings + narrative.

- ~~**F170 `[ENEMY HARD CAST]` narrower than old (A1 oracle finding, 2026-07-13)**~~
  ✅ (2026-07-29 root-caused + fixed: wiring bug, not intentional narrowing — F170
  read `enemy.spellCastEvents` filtered for `SPELL_CAST_START`, but the new L3
  parser split that stream so `spellCastEvents` is SUCCESS-only and START events
  live in the sibling `castStartEvents` field; the filter was empty-set-by-construction.
  Fix: point F170 at `enemy.castStartEvents`. Same-sample before/after on 60 seeded
  matches / 208 combats: 0/208 combats emitting → 28/208 (10/60 matches). Regression
  test added (`matchTimeline.hardCast.test.ts`). Oracle allowlist entry retired.

- **Tolerant JSON extraction for local models** — the analysis service does
  `JSON.parse(raw.trim())`; agy/Claude returned clean JSON in testing, but other
  local models may wrap it in ```json fences → parse fails → silent fallback.
  Strip fences / extract the first `[...]` before parsing so local backends are
  robust. (Surfaced by the MODE=local e2e.)
  ✅ (actually already completed, status not updated: 2026-07-31 `parseModelJsonArray` single-source tolerant extraction shipped — strips ```json fences / extracts first array, claude -p tested form regression test pinned; 2026-08-06 archive note)
