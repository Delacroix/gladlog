# Long Match match.json Load Optimization (Design, Pending Implementation)

## Background

UI stress test sample pool (2026-07-19) empirical measurements: A 10-minute real-world match's `match.json` reaches **227MB** (production app storage is of the same scale; a 5.5-minute CN match is 64MB). Headless derive smoke tests all pass, but the loading path incurs three layers of cost.

## Load Path Trace (Confirmed)

1. `matchStore.get(id)` (end of `packages/desktop/src/main/matchStore.ts`):
   **Main-process synchronous** `readFileSync` + `JSON.parse` — at 227MB, this freezes the main process, stalling all IPC (including messages for other windows) for several seconds.
2. `ipcMain.handle("gladlog:matches:get")` (`ipc.ts`) serializes the entire object via structured-clone over IPC — a second full traversal.
3. The renderer side holds another complete copy; all `report/derive/*` consume full event arrays (faithfulness gates prohibit dropping events, so the storage format cannot be slimmed down).

## Proposals (Plan A Recommended)

- **A. Move parsing off the main thread + caching (Low risk, recommended)**: Convert `get` to async; move file reading and `JSON.parse` into the existing `workerHost.ts` worker; add a 1-2 entry LRU in the main process (avoiding re-parsing when opening the same match repeatedly). IPC/renderer contract remains unchanged (`invoke` is already a Promise). Eliminates main-process freezing; retains IPC clone cost.
- **B. Custom binary/segmented format (mmap-style lazy loading)**: Maximum benefit, but requires modifying storage format and all derive logic — refactoring-level scope.
- **C. Renderer-side Web Worker parsing**: Only saves renderer framerate, does not fix main-process freezing, and passing raw strings across IPC requires contract changes.

## Acceptance Criteria

- During the opening of `stress-long-3v3.json` (227MB), the main process remains responsive to other IPC calls (verified via probe tests);
- `smokeStressFixtures.ts` all pass; desktop 225 tests + typecheck + lint all green;
- Opening duration before/after recorded in this document.
