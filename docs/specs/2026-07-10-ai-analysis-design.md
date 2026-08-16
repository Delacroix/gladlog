# Subproject 4a: In-app AI Post-Match Analysis + Data Re-alignment Design

Date: 2026-07-10
Status: Pending User Review
Upstream Docs: roadmap, desktop shell spec, match report UI spec; old fork proprietary docs `AI_UTILS.md`/`AI_FEATURES.md` (domain fact sources)

## Goals and Scope

Connect the proprietary AI post-match analysis system to the new data model, making it usable within the gladlog desktop app: initiate analysis from the match report page → main process connects directly to Anthropic streaming return → panel presentation; and complete the first round of the **data re-alignment phase** (benchmark reconstruction using locally self-collected corpus, threshold verification).

**In Scope**:

- `packages/analysis` (`@gladlog/analysis`): 12 proprietary analysis utils (cooldowns/enemyCDs/dampening/dispelAnalysis/healingGaps/ccTrinketAnalysis/offensiveWindows/healerOffenseAnalysis/drAnalysis/killWindowTargetSelection/spellTags/spellEffectData etc.) + `buildMatchContext` prompt assembly, ported as-is (audited CLEAN), input = legacy shape (`@gladlog/parser-compat`'s `toLegacyMatch/toLegacyShuffle` output)
- Minimum game data slice carried with the package: proprietary `spellNames.json`/`talentModifiers.json`/`trinketItemIds.json` + **hand-written `spellEffectOverrides.ts`** (revised via debate: abandoned spellEffects.json hunk extraction; only includes spell durations/effects actually referenced by ported utils, sourced from Blizzard's public facts, replaced by subproject 5 pipeline products)
- desktop main process `ai` module: `gladlog:ai:analyze` IPC, Anthropic SDK streaming (key/model taken from settings, existing fields), chunk pushed to renderer via `gladlog:ai:delta` event; cancellation, error, no-key guidance
- renderer AI panel: old CombatAIAnalysis logic ported directly, shell changed to slate black + gold token; entry point hooked to the match report page
- Bridging: The conversion of `StoredMatch/StoredShuffle → compat legacy shape` is called on the renderer side (compat pure functions, browser usable)
- benchmark reconstruction CLI (modified `packages/analysis/scripts/collectBenchmarks.ts`): data source switched from GCS to **local self-collected corpus** (filtered by CombatantInfo personalRating ≥ threshold), produces `benchmark_data.json`
- **Data re-alignment first round**: old vs new benchmark comparison report (quantified metric drift per spec) + `PANIC_PRESS_DAMAGE_THRESHOLD_*` threshold verification conclusions, placed in `docs/reports/`

**Out of Scope**: eval toolchain porting (4b, separate spec; principle of code going to public repo, corpus staying private is established), collection pipeline (windows-agent/pipeline-app productization), prompt system iteration/new features, replay.

## Confirmed User Decisions

| Decision       | Choice                                                          |
| -------------- | --------------------------------------------------------------- |
| Scope Splitting| 4a (this spec) goes first; 4b eval toolchain separate; collection pipeline later |
| Benchmark Data | Reconstruction with local self-collected corpus (re-alignment phase already requires re-running with new parser) |
| Eval Destination| Code goes to public repo, corpus/run history stays private (implemented in 4b) |
| UI Porting     | Logic ported directly, shell reskinned (proprietary components have no compliance issues, purely visual unification) |
| Architecture   | Option A: Independent `packages/analysis` package (eval/benchmark as the second consumer) |

## Packages and Data Flow

```
packages/analysis            # @gladlog/analysis, zero UI/Electron dependencies
  src/utils/*                # 12 analysis utils (proprietary, ported as-is; internal imports changed to relative paths within package)
  src/context/buildMatchContext.ts   # prompt assembly (extracted pure functions from CombatAIAnalysis/index.tsx)
  src/data/*.json|ts         # minimum game data slice (note: will be replaced by pipeline products after subproject 5)
  scripts/collectBenchmarks.ts       # local corpus version of benchmark reconstruction
  benchmarks/benchmark_data.json     # new baseline (committed); old json also checked in for comparison (old-parser tagged)
packages/desktop
  src/main/ai.ts             # IPC: gladlog:ai:analyze(matchContext, opts) → Anthropic streaming
                             # events: gladlog:ai:delta / gladlog:ai:done / gladlog:ai:error; supports abort
  src/preload/api.ts         # bridge adds ai: { analyze(ctx), cancel(), onDelta, onDone, onError }
  src/renderer/src/report/components/AIAnalysisPanel.tsx  # old CombatAIAnalysis logic + new skin
```

Data Flow: match report page (existing `StoredMatch`) → `toLegacyMatch` (compat) → utils → `buildMatchContext` → `window.gladlog.ai.analyze(context)` → main process Anthropic streaming → delta event → panel progressive rendering; results cached per match (`userData/matches/<id>/analysis.json`, includes model + prompt version envelope, skips re-running on reopen, manual re-analysis available).

## Key Design Points

- **Shape Boundary**: The analysis package only recognizes the legacy shape (`IArenaMatch`/`IShuffleRound`, defined and exported by parser-compat). New model evolution does not touch analysis; the bridging point is unique (at the match report page conversion).
- **Direct Anthropic Connection**: Only the main process holds the key; the renderer never sees the key. The model is taken from settings.anthropicModel, default `claude-sonnet-5`. Streaming uses the official SDK's streaming; abort uses AbortController, automatically cancelled when window closes/switches matches.
- **No-key State**: Panel shows guidance (entry to settings page); analyze button is in a disabled state.
- **analysis.json Cache Envelope**: `{ schemaVersion, model, promptVersion, createdAt, content }`; promptVersion is a manually incremented constant.
- **Benchmark Reconstruction** (revised via debate, preventing self-collected corpus selection bias): Input = local corpus list + `MIN_RATING` (default 2100); **stratified sampling by spec and comp archetype**, report sample size n per spec; parsing uses **new parser + compat** (same pipeline as app); metric definitions are consistent with the old version (pressure P90/HPS/DPS/defensive timing/never-used/purge/dampening at death).
- **Re-alignment Report and Re-fitting Threshold** (revised via debate): Old `benchmark_data.json` is checked in as an **immutable baseline**; new vs old metrics table per spec + drift %; **re-fitting double confirmation rule**—only tweak thresholds when the new stratified P90 drifts in the same direction as the old baseline and the spec sample size ≥ threshold, specs with insufficient samples or skewed coverage are marked "keep old values/insufficient data", the report must explicitly disclose coverage bias. PANIC thresholds (Healer 35k, calibrated 2026-04-08) are verified according to this rule.
- **Game Data Boundary** (revised via debate): The three JSON files are audited as proprietary and brought directly; `spellEffects.json` **no hunk extraction is done**—changed to hand-written `spellEffectOverrides.ts`, statically enumerating the set of spells actually referenced by the ported utils (expected dozens), durations and similar values are taken from Blizzard's public facts, header notes the source and the subproject 5 replacement plan; `spellIdLists.json`/`spellClassMap.json` are from the upstream ND period and **not taken**, util branches depending on them are replaced with proprietary data or runtime derivations (verify imports per util during the planning phase).
- **API Forward Compatibility** (debate concession): The type design of `@gladlog/analysis`'s public entry point does not block the future coexistence of "native StoredMatch shape" utils and legacy utils; migrate one by one when a single util has specific native data needs, no big-bang rewrites.

## Compliance Boundaries (Execution Constraints)

- Porting sources are strictly limited to audited CLEAN files and proprietary hunks; implementers do not read the old fork's upstream source code. utils/CombatAIAnalysis/analyze.ts/collectBenchmarks.ts are fully CLEAN, content can be extracted from the old fork by the controller (Claude) and handed to the implementer, the implementer does not directly access the old fork.
- `spellEffects.json` hunk extraction is executed by the controller with sources recorded.
- Benchmark corpus consists of self-collected logs (private), `benchmark_data.json` is a statistical product that can go to the public repo.

## Testing Strategy

Continue the working method (contracts written by Claude, implemented by agy, independently verified by Claude; porting tasks = controller gets source + agy mechanical modification + full testing):

- utils porting: If the old fork has corresponding proprietary tests (ccCoverage, etc.), port them together; at least one smoke contract per util of "real fixture match produces non-empty and correctly shaped output"; critical utils (cooldowns/drAnalysis) use synthetic scenarios to assert exact values.
- buildMatchContext: Do golden assertions on fixture matches (paragraph existence + key numbers, no full-text snapshots).
- Main process ai module: Transport-injected unit tests (fake Anthropic client: stream order, abort, error, no-key); real API smoke is run manually once by the controller (user key).
- Panel: jsdom smoke (progressive rendering, cancellation, no-key state).
- benchmark CLI: Small list end-to-end (10 matches) successful run + metric field completeness assertions.
- Re-alignment: Number reports are produced and spot-checked by the controller, agy verify cross-checks the conclusions.

## Design Decision Debate Record (agy debate ritual)

2026-07-10, Gemini 3.1 Pro (High), conversation `020f8d19`. Initial **OPPOSE** → **CONCEDE** after one round of replies ("The revised design successfully de-risks the major compliance and statistical pitfalls").

**Defense Successful (W1, opponent retracted)**: "analysis should immediately switch to eating the new model's native shape" was rejected — a thin adapter is an already decided roadmap decision, compat was verified via 599/600 diffs, and protecting the stability of calibrated thresholds is exactly the purpose of the re-alignment phase; a big-bang rewrite of 12 calibrated utils would introduce compound variables. Adopted concession: The package API type design allows native shape utils to coexist in the future, migrating incrementally per util.

**Concession 1 (W2, design changed)**: Self-collected corpus selection bias (MMR pockets/comp skew) will overfit thresholds. Revision: stratified sampling by spec × comp archetype + per spec sample size disclosure + minimum n threshold + old baseline immutable check-in + re-fitting double confirmation (only tweak if directions match), specs with insufficient coverage are marked as keeping old values.

**Concession 2 (W3, design changed)**: Hunk extraction of 4.7k line JSON is fragile and has entanglement risks. Revision: abandon extraction, change to hand-written `spellEffectOverrides.ts` (statically enumerate spells actually referenced by utils, values taken from Blizzard's public facts), pipeline replacement in subproject 5.

## Unresolved Items

- AI panel entry form (3rd tab in match report right column vs collapsible area below report) — determine by visuals during implementation, leaning towards right column tab.
- Comp archetype taxonomy (for stratified sampling) — decide on a version during the planning phase from proprietary `matchArchetypes` related tools or simplified rules (healer class × melee/ranged composition).
