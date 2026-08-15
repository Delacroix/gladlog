# Unlimited Token Deep Dive Upper Bound Experiment + Review Workbench Design

Date: 2026-08-12 · Status: Pending User Review
User confirmed: Purpose = explore capability upper bound (research); Form = tool-based autonomous verification; Evaluation = human arbitration-centric, machine pre-screening + cross AI/judge only for reference; run one match at a time, select user's own match, duration > 2 minutes; build specific UI for review, hosted in dev:ui testbed; scoring dimensions determined by Claude (see §5).

## Background and Motivation

Question: If given unlimited tokens to deep dive into a match, can AI do better than the existing pipeline? What can we learn from it?

Explored and known boundaries:

- Dense moment snapshot experiment (2026-08-05, `2026-08-05-moment-deep-dive-design.md`) proved that **data density determines depth** (1 generic finding → 4 specific ones), but that was still a **larger single prompt**. Blind evaluation N=20 did not beat the default baseline, deprecated.
- The truly unexplored form: **Multi-round autonomous verification**—AI continuously checks data with hypotheses, decides what to query on its own, until fully exhausted.
- Two quantification pitfalls from the last experiment (single-paragraph output form makes depth unquantifiable, CLI quota poisons data) + Judge noise floor (accuracy SD≈1.3), showing that pure machine evaluation lacks arbitration power. User specifically requested: evaluation system centered around human arbitration, and the human must have sufficient context (cannot just read one-sided concluding words).

This experiment is research, not a product feature. Output feedback direction: distillable signal list + manual gold standard dataset.

## Overall Architecture

```
① Verification Tool CLI ──> ② Deep Dive Agent (Strongest model, multi-round autonomous verification)──> findings JSON
                                                                                                      │
③ Machine Pre-screening (Deterministic truth verification, hallucination tagging)─────────────────────┤
                                                                                                      ▼
④ Review Workbench (dev:ui new mode)<── Review session package (findings from both pipelines mixed anonymously + match citations)
                │
                └──> Line-by-line manual annotations saved to $GLADLOG_EVAL_HOME (Gold standard dataset)
```

## ① Verification Tool CLI (Placed in `packages/eval`, named `matchExplore`—eval already has match loading and analysis importing, research products belong to research side)

Thin CLI, wraps predicates registered in `docs/predicate-index.md` as subcommands, query a single match via `--t` / `--from --to`:

- Cooldown ledger (`extractMajorCooldowns` + `cdAvailableAt`)
- Coordinate Distance / LoS (`getUnitPositionAtTime` / `getUnitRawPositionAtTime` + `hasLineOfSight`, LoS null → "Unknown", never treat as false)
- Auras active (`aurasActiveAt`, single source predicate already built for moment snapshot)
- DR tiers (`analyzeOutgoingCCChains` + `analyzePlayerCCAndTrinket`)
- Cast flow (`buildCastFlowLines`)
- HP curve / Same-second HP (`getHpPercentAtTime`, render grid aligned)
- Healing gap window (#10 healingGap predicate)

**Red line: Do not write any new sampling logic, purely wrap existing exports; all timestamp outputs must be floored to the render grid first** (gate predicates are the spec). Output should be directly citeable text lines, each carrying a timestamp and value, for findings to cite and for ③ to verify back.

## ② Deep Dive Agent

- A Claude Code session, **strongest available model** (upper bound probing, not restricted by "batch responder fixed to sonnet"—that constraint is only for batch evaluation).
- Task discipline (written as agent prompts, saved with the experiment script): Read through overview → Propose hypotheses → Use ① to query data lines for verification → Revise/Dive deeper → **Stop if two consecutive rounds yield no new findings**.
- Every finding must attach the exact queried output (data line) it cites, otherwise deemed invalid.
- Output structured findings JSON: `{ claim, anchorT, evidenceLines[], severity, actionable }`.
- Control group: The report from the existing pipeline (auto analysis + deepDive) for the same match, converted to the identical JSON structure.

## ③ Machine Pre-screening

Each finding's `evidenceLines` is re-queried line-by-line back through ①'s predicates (reusing existing audit discipline), marked with three states: **Verified True / Inaccurate Citation / Unverifiable**. Hallucinations are tagged but not deleted—they enter the review package, source and pre-screening conclusion are blinded to the reviewer, and revealed after unblinding.

## ④ Review Workbench (Main Engineering Effort)

Host: dev:ui testbed (`packages/desktop/dev/`) adds a new "Review Mode". **Zero changes to product src**; if external drive is needed to jump playback timestamps, reuse existing evidence chain jump mechanisms, at most patch a dev-only controlled entry point.

Layout:

- **Left side**: Full product battle report (Report / Playback / AI all three tabs present), reviewer can freely browse the whole match—meters, timeline, swimlanes, HP curves, damage reduction table.
- **Right side**: Review panel.
  - Card queue: findings from both pipelines mixed and source anonymized. Each card: Conclusion text, anchor time, exact cited evidence lines.
  - Click card → Left playback/timeline jumps to anchor ±30s.
  - Five QA questions (see §5) + Freeform notes, auto-advance to next after answering.
  - When all answered → Unblind: Source of each card (Deep Dive vs Existing Pipeline) + Pre-screening conclusion + Spot comparison summary.

Disk persistence: Add a dev-only middleware endpoint to Vite dev server, POST annotation → write to `$GLADLOG_EVAL_HOME/review-sessions/<matchId>.json`; read back on page load, persisting across refreshes.

Match data: The dev middleware serves match data directly from the local match library (`~/Library/Application Support/gladlog/matches/<id>/match.json`) based on matchId, avoiding copying into `dev/local/` (a simplification from the implementation planning stage, replacing the earlier "dev/local directory expansion" proposal).

## §5 Scoring Dimensions (Gold Standard Schema, Finalized)

Five questions per card + Notes:

| Dimension | Question | Options |
| --- | --- | --- |
| truth | Is this factually accurate? | True / Discrepancies / Untrue / Cannot tell |
| awareness | Was I aware of this while playing? | Knew it / Vague / Completely unaware |
| actionable | Is the advice actionable? | Specific action / Too broad / Inoperable |
| adopt | Will I follow this next match? | Yes / Maybe / No |
| impact | Impact on this match's outcome? | High / Medium / Low / Irrelevant |

Notes are free-form text. Each annotation JSON entry contains `findingId, truth, awareness, actionable, adopt, impact, note, answeredAt`.

Operational definition of "Novel and Valuable" (used for upper bound report statistics): truth=True AND awareness=Completely unaware AND impact≥Medium.

## Selection Criteria (Finalized)

- User's own match (local library), **duration > 2 minutes**, featuring a death or clear turning point.
- Only run one match per experiment; subsequent matches repeat the same workflow, and the gold standard dataset accumulates across matches.
- No video recording required.

## Experiment Workflow (Single Match)

1. Match selection → Deep dive agent runs once → Machine pre-screening → Generate review session package (merged and mixed with existing pipeline report).
2. User goes through all cards in the workbench.
3. Unblind, produce single-match comparison: Verified new discovery count (by operational definition above), hallucination rate, dimension-by-dimension distribution of both pipelines.
4. Reference layer: agy/Gemini independent review + 7-dimension judge continues to run, serving only as reference, not arbitration.

## Deliverables

1. **Upper Bound Report**: What the deep dive uncovered beyond the existing pipeline, hallucination patterns, token costs.
2. **Gold Standard Dataset**: Line-by-line manual annotations, accumulated to calibrate machine criteria (quantifying "to what extent machine criteria predict human judgment").
3. **Distillable List**: Signal types found in the deep dive worth crystallizing into deterministic predicates/new candidates (inputs for the miner direction).

## Explicitly Not Doing (YAGNI)

- No MCP server / multi-agent orchestration—CLI + single agent session is enough to probe the upper bound.
- No in-product entry point—it's a research tool living in dev:ui.
- No video integration.
- No multi-person / multi-round annotation management—single reviewer.
- Do not touch the judge pipeline itself.

## Testing

- ① CLI: Snapshot tests for each subcommand against a fixed fixture match; predicate consistency backed by predicate-index tests (CLI only imports, no duplication).
- ③ Pre-screening: Inject a fixture with known inaccurate findings to verify three-state determination.
- ④ Workbench: Round-trip test of annotation POST → disk persistence → read back; DOM test for card jumping; exclude from product visual baselines (dev harness scenario, avoiding known issues with appShell fixture baseline drifts).
