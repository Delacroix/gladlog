# First Load Speedup Task Brief (Assigned to agy for Implementation)

Date: 2026-07-19. Test environment: Apple Silicon Mac, `packages/desktop/dev/local/stress-long-3v3.json` (217MB, 10-minute match; typical doc in user's real library is 64–80MB).

## Measured Baseline (End-to-End Match Opening Pipeline)

| Stage | 227MB | ~70MB Typical |
| --- | --- | --- |
| Main process `store.get`: readFileSync + JSON.parse (**freezes main process**) | 786ms | ~410ms |
| IPC structured clone | 701ms | ~325ms |
| Renderer first-screen derives total | ~1330ms | est. ~500ms |
| Of which duplicate `toLegacySafe` (statsTable 489 + vulnBands 395 + burstLedger 424, each containing a ~430ms conversion) | — | — |
| Renderer bundle 19MB parse/eval (every launch) | Untested, est. 0.5–1s | Same |

Bundle composition: `packages/analysis/src/data/spellNames.json` (12MB) + `talentIdMap.json` (3.1MB) statically imported into analysis, swallowed whole by renderer ≈ 80% of bundle.

## Three Approaches (In ROI Order, Submitted Independently)

### 1. `toLegacySafe` WeakMap Memoization (Renderer, minimal change for maximum gain)

`packages/desktop/src/renderer/src/report/derive/legacySource.ts`:
Module-level `WeakMap` keyed by `source` object caching conversion results. In renderer, doc is immutable (never modified after returning from bridge), so N derives on the same source share a single conversion.
First screen ~1.3s → ~0.5s, and all re-conversions when switching between replay/AI views disappear.
Add a unit test: two calls on same source return identical instance; different sources do not cross-contaminate.

### 2. Main Process Parse Offloaded to Worker + LRU (Design approved, see docs/plans/2026-07-19-large-match-load-optimization.md Scheme A)

`matchStore.get` converted to async: file read + JSON.parse placed into existing `workerHost.ts` infrastructure (or a dedicated `parseWorker`), main process adds 2-entry LRU (reopening same match avoids re-parsing).
`ipc.ts` handle is already a Promise, renderer contract remains unchanged.
Acceptance: Main process can respond to other IPC while opening 227MB (write a probe: send `matches:page` while get is pending, should return in <100ms); `matchStore.test` all green (call sites updated to await).

### 3. Bundle Slimming: Split Two Giant JSONs out of Main Chunk (Experimental, fallback permitted)

Preferred: Update `spellNames.json` and `talentIdMap.json` imports in `spellEffectData.ts` / `talentStrings.ts` / `utils/talents.ts` to **top-level await dynamic imports** (Vite splits them into separate chunks, saving ~15MB of JS parse/eval from main chunk; Electron's Chromium supports TLA). Must verify `npm run build --workspace=packages/desktop` (electron-vite production build) passes and main process side (analysis is also consumed by main) does not break — if main is bundled as CJS, TLA will fail, in which case fallback approach: Vite `manualChunks` splits the two JSONs into separate chunks (still loaded on startup, but JSON.parse is faster than JS eval), or change `spellNames` consumption to optional deferred loading (fallback name uses spellId first; no rerender needed after loading completes — it is only a prompt/text fallback).
If impractical, document conclusion clearly in commit message without forcing it.

## Acceptance Gates (Before Submitting Each Task)

```bash
npm test --workspace=packages/desktop && npm test --workspace=packages/analysis \
  && npm run typecheck && npx eslint packages/desktop/src --quiet \
  && npm run build --workspace=packages/desktop \
  && npx tsx packages/desktop/scripts/smokeStressFixtures.ts
```

Also run the retest benchmark script (compare against baseline after changes, write numbers into commit message):

```bash
npx tsx -e "
import { deriveStatsTable } from './packages/desktop/src/renderer/src/report/derive/statsTable';
import { deriveVulnBands } from './packages/desktop/src/renderer/src/report/derive/vulnWindows';
import { deriveBurstLedger } from './packages/desktop/src/renderer/src/report/derive/burstLedger';
import { readFileSync } from 'fs';
const doc = JSON.parse(readFileSync('packages/desktop/dev/local/stress-long-3v3.json','utf8'));
const src = doc.data ?? doc;
for (const [n, f] of [['stats', deriveStatsTable], ['vuln', deriveVulnBands], ['ledger', deriveBurstLedger]] as const) {
  const t0 = Date.now(); (f as (s: unknown) => unknown)(src); console.log(n, Date.now() - t0, 'ms');
}
"
```

## Red Lines

- Zero change to predicate / derive semantics: Only touch caching and load timings, never touch any computations.
- Renderer must never import `src/main/*` values (v0.0.4 build incident); cross-boundary constants go into `src/shared/`.
- Independent commit per task, format `perf(desktop): …`; do not tag or release.
