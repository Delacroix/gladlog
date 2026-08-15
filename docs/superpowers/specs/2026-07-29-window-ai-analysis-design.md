# Selected Time Range → [AI Analysis] (backlog #16) Design

2026-07-29 · Source: Bilibili user feedback (same thread as #15) —— "After reading the full match analysis, select a segment on the timeline, click AI analysis, to see if there are other possibilities in this segment".

## Goals and Criteria

The match report view already has time window selection (`TimeRangeBar` dropdown + HP curve drag selection, `timeRange {fromS,toS}`).
When the window is activated, an [AI Analyze this Segment] button appears; clicking it triggers an on-demand deep dive for this window, and the result is displayed as an inline card below the
TimeRangeBar (finding card style + #15 inline icon + chips to jump to replay). Three end states:

1. Audit-passed segment observation text + evidence chips;
2. No coachable signal in the window → **Do not invoke model**, zero-cost display of deterministic text "No coachable signal detected in this segment
   (no CC/defensive casts/enemy bursts/sudden HP drops, etc.)";
3. All model outputs failed audit → "Model output failed audit" + retry button.

An empty result is a valid output —— do not force-produce suggestions just because it was clicked.

## Decision Record (brainstorm approved)

1. **Result Location**: Match report view inline card (does not enter StructuredAnalysisPanel, no pop-up).
2. **No-signal Path**: Pack construction and gate checking are completed in the renderer, if the gate fails, IPC is not sent at all, and the model is not invoked.
3. **Cache**: **Persist to disk** in a sidecar file (user approved), do not touch `analysis-v2` documents.
4. **Route**: Plan A —— synthetic anchor + reuse the entire deep dive pipeline (pack → prompt → audit).
   Rejected: Independent new prompt/audit (duplicate audit infrastructure); masquerade as a first-round finding to run two rounds (detour).

## Three-layer Mitigation for Plan A's Shortcomings (approved)

The framework copy is written to "ask follow-up questions on existing conclusions", while the selection mode has no conclusions. Applying it directly will guide the model to force-find problems:

- **Prompt Layer (fixes tone)**: The title/explanation of the synthetic anchor finding is generated deterministically by pack statistics, 
  purely neutral factual description ("User selected segment 0:36–0:59: X CCs, Y defensive
  casts within the window..."), without "problem/mistake" wording; `buildDeepDivePrompt` adds `mode: "window"`,
  injecting an explicit empty-output contract —— does not presuppose the window has problems, only states observations supported by evidence in the window, and returns an empty array when there are no decision points worth pointing out.
- **Audit Layer (fixes facts, structural fallback)**: Placeholder discipline/raw numbers/chips validation are inherited intact,
  the worst outcome of the framework's bias is wording, it is impossible to fabricate facts outside the window.
- **Verification Layer (fixes blind spots)**: Feature unit tests for placeholder discipline are blind spots ([[gladlog-deepdive-eval]]
  lesson), after landing, test with real model smoke ~10 windows (with signal/no signal/offensive), human review filler rate.
  If it exceeds the standard, upgrade to the second tier ("clean" upgraded to explicit structured output) —— don't do this first, wait for the numbers.

## Architecture

### Analysis Layer (packages/analysis · deepDive.ts)

- The item collection body of the current `buildDeepDivePack` is refactored into a private `collectPackItems(combat,
anchorFrom, anchorTo, candidates, ownerName)`; `buildDeepDivePack` (finding
  anchor, window [minT-30, maxT+10]) and the newly exported `buildWindowPack(combat, fromS, toS,
candidates, ownerName)` (user window **as is**, no padding —— what the user selected is what they want to see)
  share it, single source for predicates. The `findingIndex` of `buildWindowPack` is fixed at 0.
- **Signal Gate Grading** (newly exported `windowPackGate(pack)`): First `hasCoachableSignal`
  (survival), if it fails then `hasOffensiveCoachableSignal` (offensive window "hit but didn't kill" is also coachable);
  if both fail → `"none"`, caller follows the no-signal copy.
- `buildDeepDivePrompt(packs, findings, spec, ownerName, mode?)`:
  When `mode: "window"`, replaces the instruction header (segment mode contract, see above), other rendering (facts/placeholder
  instructions) remains unchanged.
- Synthetic anchor constructor `buildWindowAnchorFinding(pack, fromS, toS)`: Deterministically generates neutral
  title/explanation (fmtTime rendering grid, adhering to gate predicates is the standard —— time is first floored to
  render seconds before entering text).

### Main Process + IPC (packages/desktop main)

- New IPC `gladlog:analysis:analyzeWindow`: Input
  `{matchId, fromS, toS, pack, spec, ownerName}` (pack constructed by renderer, same as
  deepen mode); `invoke` directly returns the result (single request-response, does not use emit channel —— unlike deepen's
  "merge into cache then emit", window results do not enter findings).
- Flow: Check disk cache hit → return directly; miss → single LLM (`buildDeepDivePrompt`
  window mode, max_tokens 2048, single pack single finding) → `parseModelJsonArray` →
  `auditDeepDives` → take findingIndex 0's `{text, chips}`; empty/all dropped →
  return `{status:"audit-empty"}`.
- **Disk sidecar file** `windowAnalysis.<lang>.json` (one per match, located in the match's matches
  directory): `{ [windowKey]: {fromS, toS, text, chips, at} }`,
  `windowKey = "${floor(fromS)}-${floor(toS)}"`; **Limit 20 entries, LRU evicted by `at`**.
  Atomic write (tmp+rename, same precedent as analysis-v2). audit-empty is not persisted to disk
  (allows retry).
- Idempotency guard: Duplicate calls in flight for the same match and same windowKey are directly dropped (same as deepening set,
  must be in main process, renderer check is TOCTOU).

### Render Layer (packages/desktop renderer)

- `MatchReport`: When `timeRange` is active, [AI Analyze this Segment] button appears at the end of the TimeRangeBar row.
  Click → `buildWindowPack` (via `toLegacySafe`, pack construction/gate checking all in renderer, reuses
  `buildAnalysisInput`'s owner parsing caliber) → if gate fails, directly drop to no-signal card (no IPC sent);
  if gate passes → IPC, loading state ("Analyzing, about 10–30s") → end state card.
- Result card `WindowAnalysisCard`: finding card style; text passes through #15 `rich()` inline icons;
  chips reuse existing chip buttons + `onJumpT` to jump to replay; card is bound to the current selection —— folds up immediately when `timeRange`
  changes (instant re-display when switching back to the same window if cache hits).
- Pre-contract: Before constructing pack, `await ensureAnalysisData()` (prompt spell names are not allowed to downgrade,
  same as panel/batch).

## Boundaries (deliberately not doing)

- Multi-window comparison, results entering StructuredAnalysisPanel/cross-match aggregation, replay view entry point.
- "clean" explicit structured output (second tier, wait for smoke numbers).
- No special treatment for EN mode (aiLanguage pipeline already supports it natively, system prompts follow settings).

## Testing

- Analysis Layer: `buildWindowPack` and `buildDeepDivePack` equivalence assertion for the same window (refactoring invariance);
  `windowPackGate` grading (survival passed/only offensive passed/all failed); `buildWindowAnchorFinding`
  render grid rounding; window mode prompt contains empty output contract, assertion that it does not contain follow-up framework copy.
- Main Process: Cache hit does not invoke client (mock client count), LRU eviction, audit-empty is not persisted to disk,
  idempotency guard, atomic write.
- Render Layer: Button appearance conditions (only appears if there is a timeRange), three end-state renderings, fold card on window switch,
  no-signal path does not send IPC (bridge mock count).
- Real model smoke (after landing, on real device): ~10 windows filler rate human review —— the only way to patch unit test blind spots.
- `npm run presubmit` before push; if visual baseline changes, run CI recipe.

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Model force-finding problems (filler) | Three-layer mitigation (neutral anchor + empty output contract + audit); smoke quantification, if exceeded upgrade to second tier |
| Arbitrary window cache accumulation | 20 LRU entries per match + sidecar file, does not pollute analysis-v2 |
| Duplicate clicks wasting tokens | Main process idempotency guard + disk cache hit short-circuit |
| Window too short (<2s) resulting in near-empty pack | Gate naturally fails → no-signal copy, no special handling needed |
