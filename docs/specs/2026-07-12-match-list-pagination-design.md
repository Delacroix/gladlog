# Match List Pagination + Fast Boot Index Design

Date: 2026-07-12
Status: Pending User Review

## Background & Goals

Users have huge WoW log histories (thousands to tens of thousands of matches), causing the desktop app to take a "long time to load" at startup. We have identified two costs that scale linearly with total match count N:

1. **Boot**: `MatchStore.init()` synchronously reads `readFileSync(meta.json)` for each match directory — N synchronous reads block the main process, delaying the window availability.
2. **Rendering**: `App.tsx` maps `metas.map(...)` to render all N `<li>` rows at once — unvirtualized, thousands of DOM nodes slow down the initial paint + cause scrolling lag.

Ingestion is confirmed to be efficient: checkpoint (`checkpoints.json` + byte offset), boot only parses new logs without re-parsing history — **no changes to ingestion**.

Goal: One read at boot, render only the latest 100 matches on the initial screen; load older matches incrementally on scroll down.

## User-Confirmed Decisions

- Option A (Paginated data + Infinite scroll rendering).
- Initial screen = latest 100 matches (count-based), each scroll down loads 100 more.
- **Pagination only, no virtualization** (sufficient for normal use; DOM row stacking only re-occurs if a user deliberately scrolls through years of history, which is acceptable).
- No changes to ingestion/parsing core.

## Component 1: MatchStore — append-only NDJSON index + Pagination

### Fast Boot Index (append-only NDJSON)

Add single file `_index.ndjson` (one JSON `StoredMatchMeta` per line).

- `init()`: If `_index.ndjson` exists → **read once**, parse line by line, deduplicate by `id` (last-write-wins) to build memory index. If not exists (old install) → rebuild once from each directory's `meta.json` and write out `_index.ndjson` (migration, once only).
- `store()`: Atomically write match directory first (existing tmp→rename), **then append a line to `_index.ndjson`** (O(1), avoids rewriting entire file → no main thread pause). Order guarantee: Crash leaves at worst "directory exists, no index line", never "index line exists, no directory".
- **Reconciliation** (crash safe, cheap): `init()` does an extra `readdir` (directory names only, single syscall, no per-file read); for directories not in index, read only their `meta.json` to backfill and append line; drop index entries without corresponding directory. Zero extra reads under normal operation.
- store() deduplicates by `id` (existing `this.index.has(id)` guard) → NDJSON has exactly one line per match, won't grow infinitely, no compaction needed.

### Pagination Method

`page(opts: { before?: number; limit: number }): StoredMatchMeta[]` — Returns at most `limit` entries from memory index (descending by `startTime`) where `startTime < before` (latest if omitted). Pure in-memory slicing, zero disk IO. Keep `list()` (still used by DevPanel/tests).

### Trade-offs Adopted from Debate (agy ceremony)

2026-07-12 ran debate-open for "merged index" (conversation `8cd406a8`, OPPOSE). Adoptions & rulings:

- **Adopted**: Original design where store() rewrites entire `_index.json` was an O(N) write that would block the main thread → Changed to **append-only NDJSON**, making store() an O(1) append always.
- **Ruled to keep (low risk, documented)**: `safeName` lossy mapping could cause two different ids to collide on the same directory → phantom duplication. This is **existing store behavior** (not introduced here), and WoW GUIDs are alphanumeric + hyphens so they won't collide; will not fix here.
- **Ruled to keep (low risk, documented)**: Index as a cache is unaware of out-of-band edits to `meta.json` → staleness. But the match library is in the App's private `userData` (not a synced folder), `meta.json` is not edited externally after write; acceptable.
- **Rejected steelman (SQLite/better-sqlite3)**: Introduces native compiled dependencies, complicates electron-builder packaging, over-engineered just to "make the list faster"; append-only NDJSON already achieves O(1) boot + O(1) write with zero new dependencies.

## Component 2: IPC + bridge

`ipc.ts` adds `ipcMain.handle("gladlog:matches:page", (_e, opts) => store.page(opts))`; preload/bridge exposes `bridge().matches.page(opts)`. `matches:list`/`get` remain unchanged.

## Component 3: Render side (App.tsx)

- Boot: `matches.page({ limit: 100 })` fetches initial screen (replacing `list()`); still automatically selects latest match.
- Infinite scroll: When sidebar scroll nears bottom and `hasMore`, fetch `page({ before: oldestLoaded.startTime, limit: 100 })` to append. `hasMore` = previous page returned exactly `limit` items. Show "Loading earlier..." row at the bottom while fetching.
- New match ingested → Prepend (existing `onMatchStored` unchanged).

## Data Flow

Boot → init reads `_index.ndjson` once (+ cheap readdir reconciliation) → memory index → Render side `page({limit:100})` → initial 100 rows. Scroll down → `page({before, limit:100})` → append.

## Error Handling

- `_index.ndjson` missing/corrupted line → skip bad lines; totally missing → rebuild from directories.
- Reconciliation fixes index/directory divergence from crashes.
- `page` argument defense: `limit` lower bound 1, upper bound (e.g., 500); invalid `before` → treated as latest.
- Render side fetch failure → preserve loaded data, allow retry (do not clear).

## Test Strategy (vitest)

- `matchStore.page()`: Descending, `before` boundary (strict `<`), `limit`, empty tail, no `before` fetches latest.
- Index: append-only appending + init deduplication (last-write-wins), missing rebuild migration from directories, readdir reconciliation (directory no index line → backfill; index line no directory → discard).
- Atomicity: store ordering (directory first, index line second).
- Render: Initial `page` requests bounded page; scroll to bottom appends earlier metas; `hasMore` terminates (short page stops fetching). Existing desktop tests (matchStore/ipc/App) green.

## Out of Scope

- List virtualization (pagination only).
- Ingestion/parsing changes.
- SQLite migration (revisit later if writes become a hotspot or complex queries are needed).

## Unresolved Items

None (all decisions confirmed).
