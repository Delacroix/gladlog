# Pro Match In-Depth Comparison — Design (2026-07-17)

> User feedback: Current pro comparison only has four or five metrics, too general.
> Current status: `ReferenceCell` (spec × bracket × archetype × buildGroup) aggregates
> `IHealerMetrics` 7 match-wide scalars (offensiveIndex/ccDensity/reactionLatency/
> burstResponseCoverage/defensiveOverlapRatio/effectiveCastRatio/
> ccAvoidanceRate), 2300+ corpora, p10/50/90 + exemplarCrises.
> Only covers healers, and all are **match-wide averages** — losing situational context.

## 1. Root Cause of "Too General": Scalar Comparison vs Situational Comparison

You and a 2400-rated player might have the exact same ccDensity; the difference is that **a pro's CCs all land in kill windows**. Match-wide scalars flatten this nuance. To become more granular, it's not about adding more scalars, but anchoring comparison to the **game situation**: under the same burst windows, same enemy composition, and same dampening stage, what did the pro do?

## 2. Three-Layer Expansion (From Shallow to Deep, All Using Existing Predicates)

### P1: DPS Metric Group into Cells ✅ (Completed 2026-07-17)

> computeDpsMetrics 7 dimensions (predicates = burst ledger suite) → perMatchRecord friendly DPS record → cell aggregation; full rebuild of 2300+ × 3600 matches → 387 cells (262 DPS / 27 specs, max n=1885); UI keys generic with zero changes, ProComparisonVerified selects metrics by recorder role. Rebuild entry point corpus:build-reference (LOG_CACHE_DIR caching); weekly launchd auto-install command in collect-logs.md.

The burst ledger three-piece suite (`analyzeBurstLedger`/`auditWindowTargeting`/`analyzeKickAudit`) consists of deterministic pure functions. Run them directly on DPS recorders from high-rated corpora and aggregate into distributions:

| Metric | Predicate Source | Coach Wording Example |
| --- | --- | --- |
| Burst conversion rate (target net HP loss ≥ 20% or death within window) | burstLedger | You: 1/4, 2400-rated Sub Rogue p50 = 2.5/4 |
| Proportion of bursts into immunity/defensives | defensivesHit | You: 50%, pro p90 is only 15% |
| Coordinated burst proportion | allyCDsOverlapping | You solo-burst all match, pro p50 = 70% coordinated |
| Kill window target damage percentage | targetAudit | You: 35%, pro p50 = 72% |
| Kick hit rate / baited rate | kickAudit | You: 1/5 landed, pro p50 = 3/4 |
| Seconds from match start to first burst | burstLedger[0].fromSeconds | Pro: 8s, You: 25s |

Similarly on the healer side: median dispel latency, total lock seconds from interrupted school, external response latency (deterministic items from healer-depth doc).

Implementation: `perMatchRecord` runs the three-piece suite on non-healer recorders → `cellAggregator` aggregates (MetricDist structure reused); `ProComparisonVerified` renders new rows via existing claimChecker pipeline — invalid reference auto-drop mechanism applies as-is.
Corpus: `npm run logs:fetch-public -- --bracket 3v3 --min-rating 2400 --count 300` (fetchable after minRating fix; recorder spec buckets naturally).

### P2: Matchup Comp Dimension ✅ (Completed 2026-07-17)

> enemyCompSignature single predicate (shared by builder/renderer); comp cell = spec|bracket|enemy composition, COMP_CELL_N_FLOOR=20 (shared constant in validateCorpus), with duration distribution + first kill counts; lookupCell comp tier prioritized, falls back to legacy chain; UI displays "Pro matches vs same comp · Median duration · X% first kill Y". Initial build: 14 comp cells (grows with weekly refreshes).

Cell key adds **enemy comp signature** (specId ascending, matching match history page comps caliber): "2400 Ret Paladin vs RMP: avg 2:10 duration, 67% first kill Priest, opening burst p50 at 12s". Sample size is the primary constraint — only produce cells for high-frequency comps (n ≥ 20), rest fallback to spec × bracket aggregate distribution; `insufficient` flag mechanism already exists. First kill target / duration aggregations are meta-level stats, just add fields to perMatchRecord.

### P3: Exemplar Matches — "See How Pros Play Your Comp" (Killer Feature, Zero New Analysis)

Public logs are originally complete raw logs → **directly import into application**, replay / burst ledger / stat tables all fully functional. Workflow:

1. Match report page adds "Find Pro Match with Same Situation": query high-rating public matches by friendly spec + enemy comp signature (feedClient already capable) → download → store into DB as match entity (flagged `exemplar`);
2. Users review the pro match using our own replay + ledger: all bursts coordinated, 3/3 kicks, engaged at 8s from start — more intuitive than any p50 number;
3. Prompt side (future): Pro match ledger summary enters AI context as comparison block, "You had 3 bursts with 1 into immunity; pro match vs same comp had 0" — run via /eval-ab.

## 3. Deliberation Points

- **Sample size**: Every dimension layer drops n by an order of magnitude; insufficient threshold + fallback chain (comp cell → spec cell) must come first.
- **Fairness phrasing**: User at 1800 vs 2400 benchmark, difference should be phrased as "Pro Reference" rather than "You are sub-par"; rubric labelBias lessons apply.
- **Exemplar privacy**: Public logs were originally public, but storage needs source tagging, excluded from user match history aggregations (dashboard naturally isolates by playerName bucketing, exemplar playerName is the pro player's character name).
- **Cost**: P1 one-off 300-match analysis takes minutes locally; cell is an offline artifact, application is read-only.

## 4. Suggested Order

P1 (DPS metric expansion, 1 datagen offline task + UI new rows) → P3 (exemplar import, mostly pipeline wiring) → P2 (comp dimension, wait for P1 corpus to gather enough sample size).
