# SP-A: Structured Analysis UI — Design

Date: 2026-07-12
Status: Design (Pending user review)
Belongs to: Migrating the second AI subsystem from the old fork into the gladlog desktop. Parallel to SP-B (Pro Comparison, completed); it is the last major component of the "move the entire repo functionality over" goal.

## Goal

In one sentence: Replace the current minimal `<pre>` streaming AI analysis with **evidence-anchored structured findings** — the LLM selects, ranks, and interprets "verifiably occurred" events from the match into cards, with numbers deterministically grounded, deliberately non-causal coaching phrasing, rendered into FindingsList/MatchHero/TimelineStrip/ExportButtons.

## Key Decisions (determined by agy debate, see end of document)

- **Facts can be "honest by construction", causality cannot.** The numerical claimChecker in SP-B2 only catches numerical hallucinations; the real hallucination surface for coaching is **qualitative/causal** judgments ("You greedily held your shield", "Wrong positioning", "You died because of X") — a sentence without numbers would pass blindly. Therefore:
  - **Fact layer** (whether an event occurred, numbers) — Deterministic grounding: finding must anchor to realistically extracted events; numbers use SP-B2's `{{placeholder}}` interpolation. "0:47 you were one-shot by Chaos Bolt" cannot appear if there was no such cast.
  - **Causal layer cannot be deterministically verified** (verifying isolated facts cannot verify the logical relationship between facts; "because you greedily held the shield at 1:00, you died at 2:00" — if that shield was absolutely necessary to use, "greedily held" is a hallucination). **Therefore, this design makes no strong causal assertions** (avoid-by-design): prompt instructs the LLM to output observation + suggestion style coaching, not "because/led to/threw this game". A **causal phrasing lint** (deterministic) serves as a fallback: if strong causal conjunctions appear in the explanation, it is flagged as a violation — it does not verify causal truth, but only enforces the "do not make causal assertions" policy.
- **Do not suffocate macro reasoning with a flat evidence menu**: Retain the existing **overall critical-moments sequence** in `buildMatchContext` (cross-event: resources were used 15s before the kill window) as rich context, allowing the LLM to reason about the match arc; simultaneously provide structured event anchors (with ids) for findings to reference. It is not a flat tiling of isolated events.
- **LLM-as-judge semantic verification** (reviewing causal logic) — agy considers this the only mechanism to review causality, but it is non-deterministic, cross-family only decorrelates but does not eliminate, and has cost/latency. **Listed as SP-A.1 long-term enhancement**, v1 uses avoid-by-design + causal lint.

## Scope

**This spec (SP-A)**: extractCandidateFindings (structured verifiable events) + buildFindingsPrompt (evidence menu + rich context, non-causal instructions) + auditFindings (grounding + numerical claimChecker reuse + causal lint) + main process analysis-v2 service + FindingsList / MatchHero / TimelineStrip / ExportButtons. Replaces the `<pre>` AIAnalysisPanel output.

**Out of scope**: SP-B compare (completed), SP-A.1 (LLM-judge causal semantic audit), SP-B2.1 CDN.

## Architecture & Data Flow

```
Renderer (existing parsed match + derive/{summary,timeline,casts,roster})
  → extractCandidateFindings(match) [packages/analysis]: Reuse verified event extraction 
     in buildMatchContext (death/missed-interrupt/cd-waste/dispel/positioning…),
     producing structured CandidateEvent[]: { id, type, t, units, spell, facts:{…} }
  → IPC gladlog:analysis:run { matchId, candidates, richContext, wowBuild? }
Main Process createAnalysisService (mirrors compare.ts: injected client, generational cancellation, version caching, atomic writes):
  → buildFindingsPrompt(candidates, richContext): Provides event menu (with id) + buildMatchContext
     rich context (critical-moments sequence); Instructions: only select/rank/interpret menu events, reference event id;
     Numbers use {{event.fact}} placeholders; **Prohibit strong causal assertions** (observation + suggestion, do not write "lost this game because...").
  → stream JSON findings: [{ eventIds[], severity, category, title, explanation }]
  → auditFindings():
     (a) Each eventId must resolve to a real CandidateEvent (grounding, LLM cannot reference unextracted events);
     (b) SP-B2 claimChecker: {{key}} in explanation must come from the referenced event's facts, no naked 
         statistical numbers outside of placeholders (numerical honesty);
     (c) Causal lint: explanation contains strong causal conjunctions (because/caused/cost you/lost because...)
         → the finding is in violation (discarded or de-causalized). Enforces avoid-by-design policy.
  → interpolate + rank by severity, returning audited findings + full candidate set (for timeline)
Renderer: FindingsList (cards) · MatchHero (overview) · TimelineStrip (finding moments) · ExportButtons
```

**Payload Assertion**: The LLM never invents events or numbers (only selects/ranks/interprets from pre-extracted menu); numbers are deterministically grounded; **causal assertions are prohibited by policy and backed by a lint** — it does not pretend to have verified causality, but rather avoids entering the category of causal hallucinations entirely.

## Components & Files

**`packages/analysis/src/analysis/` (pure, unit tested)** — Controller for audit CLEAN extraction, swap imports:

| File                     | Responsibility                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidateFindings.ts`   | `extractCandidateFindings(match): CandidateEvent[]`. Refactors event extraction of buildMatchContext into structured events (id/type/t/units/spell/facts).  |
| `buildFindingsPrompt.ts` | `buildFindingsPrompt(candidates, richContext, specName): string`. Evidence menu + rich context + placeholders/non-causal hard rules.                        |
| `auditFindings.ts`       | `auditFindings(rawFindings, candidates): { findings: Finding[], dropped: DroppedFinding[] }`. Grounding + claimChecker + causal lint + interpolate.         |
| `causalLint.ts`          | `causalLint(text): string[]`. Strong causal conjunction/assertion detection (deterministic, enforces avoid-by-design).                                      |

Reuse `interpolate`/`claimChecker` (numerical layer) from `packages/analysis/src/compare/claimChecker.ts`, do not rewrite.

**Desktop Main Process**: `packages/desktop/src/main/analysis.ts` — `createAnalysisService(deps)` mirrors `createCompareService`; orchestrates prompt→stream→auditFindings; trust boundary (audit) is in the main process. IPC/preload adds `gladlog:analysis:*`.

**Renderer** (dark data-intensive, reuse `derive/` + `SpellIcon`, complements `ReportHeader`/`Timeline` without duplicating logic):

- `MatchHero.tsx` — Overview (derive/summary: spec/comp/result/duration) + findings headline (count/highest severity).
- `TimelineStrip.tsx` — Compact scrubber for finding reference moments; dot markers highlight corresponding cards (and vice versa). Reuses derive/timeline.
- `FindingsList.tsx` — Cards sorted by severity: severity color bar, category, interpolated explanation, evidence chip (SpellIcon + timestamp, cross-linked to strip).
- `ExportButtons.tsx` — Export findings + overview to Markdown / export panel to image.
- `MatchReport.tsx` — Replaces the current `<pre>` output of `AIAnalysisPanel` with the above (the `ProComparisonVerified` in the compare panel is kept and coexists).

## Honesty Model (Three Gates)

1. **Grounding**: Each eventId in a finding must resolve to a real CandidateEvent; otherwise discarded. (Factual existence, by construction.)
2. **Numerical**: Numbers in the explanation use `{{event.fact}}` interpolation + claimChecker residual scan for naked statistical numbers. (Numerical honesty, reusing SP-B2.)
3. **Causal lint**: The explanation must not contain strong causal assertions (deterministic keywords/patterns); violations are discarded or de-causalized. (Does not verify causal truth — causality is indeterministically verifiable; rather, it enforces "do not make causal assertions".)

Violations / No API key → Render deterministic CandidateEvent (without narrative).

## UI Layout

```
┌ MatchHero ─────────────────────────────────────────────────┐
│ Disc Priest · 3v3 · Win +18 · 4:32   ⟶  "6 findings · 2 high" │
├ TimelineStrip ─────────────────────────────────────────────┤
│  ●───▲──────●────▲───●──   (finding moments, dot → card)    │
├ FindingsList ──────────────────────────────────────────────┤
│ ▎HIGH  cc-usage   "Trinket used for first CC…"     [icons][0:47]   │
│ ▎MED   cd-waste   "Pain Suppression held until…"   [icon][2:10]    │
│  … sorted by severity; evidence chip links to strip          │
└ ExportButtons:  Copy Markdown · Export Image ──────────────┘
```

## Error Handling & Caching

- Cache key = `(matchId, PROMPT_VERSION)`; invalidated if prompt changes (same as compare).
- No API key / No candidates: Render deterministic event table, without narrative, no error thrown.
- Cancellation: Reuse generational counting.
- JSON parsing failure (LLM outputs invalid JSON): Discard this attempt, fallback to deterministic event table + log droppedReason.

## Testing

- `extractCandidateFindings`: golden — Given parsed fixture, assert event types/ids/facts; spot-check consistency with buildMatchContext text extraction (no missing key events).
- `causalLint`: adversarial — "because you wasted X you lost" hits; "at 1:00 you used X; kill came at 2:00" does not hit.
- `auditFindings`: referencing non-existent eventId → drop; explanation naked statistical numbers → drop; strong causal → drop; clean finding → interpolate passes.
- `analysis.ts`: Inject AnthropicLike returning canned JSON, assert audit + ranking + caching + cancellation; invalid JSON → fallback.
- UI: FindingsList rendering + severity sorting + chip cross-linking; no findings → empty state; jsdom + native matcher (repo lacks jest-dom).

## Compliance

- Extracting from old fork only touches **audit CLEAN** files; NEEDS_SCRUB UI (`icons.tsx`, etc.) controllers scrub; agy/subagents do not read old fork, only take clean interfaces + this spec.
- Independence: agy cross-family review; do not use claude-family alias to review Claude's own work.

## Debate Log (spec ritual, agy / Gemini 3.1 Pro, conversation 2357b056)

- **Round 1**: agy OPPOSE. (3) SP-B2 numerical claimChecker structurally cannot see qualitative/causal hallucinations (lies without numbers pass blindly) — the real risk surface for coaching; (1) A flat evidence menu kills the existing cross-event macro synthesis in buildMatchContext.
- **Round 2**: I proposed "separate fact substrate and coaching opinion + run deterministic counter-proofs on qualitative claims embedding verifiable facts + tag pure opinions". agy OPPOSE: **Extraction Paradox** (to deterministically check embedded facts in prose, either use LLM to parse = non-deterministic judge again, or force LLM to output rigid enumeration = suffocates macro reasoning again); **Causal Hallucinations** (verifying isolated facts cannot verify logical relationships between facts; "Because A therefore B", both facts can be true but the causality can be false; attaching an "interpretation" tag does not protect the user, the user is exactly here for the interpretation).
- **Endgame (resolved)**: Deterministic grounding is necessary but not sufficient; reviewing causality requires semantic verification (LLM-judge). User selects **avoid-causality-by-design**: v1 makes no strong causal assertions, numerical/factual deterministic grounding, causal lint as fallback policy; LLM-judge causal audit is listed in SP-A.1.

## SP-A.1 Preview (Long-term)

Cross-family LLM-as-judge causal semantic audit: For findings making causal assertions, use another family's model to review whether its causal logic aligns with the match data, discarding/softening those that do not hold up — the only (probabilistic) mechanism to review causality, cross-family to decorrelate.
