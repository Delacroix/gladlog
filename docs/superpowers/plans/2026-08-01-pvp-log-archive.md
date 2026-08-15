# PvP Log Long-term Archival Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan the wowarenalogs feed every 6 hours, download newly appearing public PvP combat logs as **raw gzip bytes**, upload them to Google Drive archived by daily directories, leaving only the ledger locally.

**Architecture:** Pure logic (predicates/ledger/rclone args/locks) is decoupled from IO for unit testing, leaving IO orchestration in the `scripts/archivePvpLogs.ts` shell — consistent with existing layering in `driveSync.ts` / `pvpLogFetch.ts`. The download layer extracts `downloadRaw()` returning uncompressed bytes; the archiver writes them straight to disk, while `fetchPvpLogs` decompresses on top.

**Tech Stack:** TypeScript (ESM), node-fetch v3, node:zlib, fs-extra, vitest, rclone (external binary), launchd (macOS)

Design spec: `docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`
Compliance spec: `docs/DATA-COMPLIANCE.md`

## Global Constraints

- All outbound requests must go through `fetchWithRetry` (which sets `USER_AGENT` as the single outbound bottleneck). Never introduce bare `fetch`.
- Pagination interval 500ms; download interval 2s (`DOWNLOAD_SLEEP_MS` configurable, must not default to 0). Sequential only, never concurrent.
- The ledger is written only **after upload success is confirmed**. Recording prematurely = permanent loss of a match (feed retention window is only 7 days).
- Every run **flushes legacy staging from previous runs before scanning the feed**.
- Stop threshold K = 200 (4 pages); ledger load window = 10 days; upload batch = 200 matches or 500MB, whichever comes first; abort run if free disk space < 20GB.
- Code comments and commit messages follow repository convention. Strings use double quotes (prettier configured).
- Before finishing each task, run `npm test --workspace=packages/corpus-tools` and `npm run typecheck`; both must pass cleanly.

---

### Task 1: Fix Download Completeness Check Compression/Decompression Scope Bug and Extract `downloadRaw()`

**Background (Required Reading):** The byte-count check introduced in `c9c463e` (2026-07-31 audit) compared `content-length` (which is the **compressed** size on GCS) against the byte length of the **decompressed** text. These two values never match — causing `fetchPvpLogs.ts` to currently **judge every single match as incomplete and skip it, downloading nothing**. 2026-08-01 real-world measurement: `content-length: 109885`, decompressed 1,463,618 bytes, with `checkPayloadCompleteness` returning `{ok:false, reason:"byte length mismatch: expected 109885, got 1463618"}`.

The fix separates the two concerns: byte-count verification belongs to the **raw byte layer** (comparing `content-length` against received compressed bytes), while sentinel checks belong to the **decompressed text layer**.

**Files:**

- Modify: `packages/corpus-tools/src/pvpLogFetch.ts` (replace `checkPayloadCompleteness`)
- Modify: `packages/corpus-tools/src/feedClient.ts` (add `downloadRaw`)
- Modify: `packages/corpus-tools/scripts/fetchPvpLogs.ts` (`downloadWithMeta` uses `downloadRaw` + decompress)
- Test: `packages/corpus-tools/src/pvpLogFetch.test.ts`
- Test: `packages/corpus-tools/src/feedClient.test.ts`

**Interfaces:**

- Consumes: `fetchWithRetry(f, url, init, label, opts)`, `expectedByteLength({contentLength, storedContentLength})` (existing, signatures unchanged)
- Produces:
  - `downloadRaw(url: string, label: string, fetchImpl?: any): Promise<RawDownload>`
  - `interface RawDownload { bytes: Buffer; contentEncoding: string; header(name: string): string; expectedBytes: number | undefined }`
  - `checkRawPayloadBytes(receivedBytes: number, expectedBytes: number | undefined): CompletenessResult`
  - `checkDecompressedPayload(text: string): CompletenessResult`
  - `decodeRawPayload(raw: RawDownload): string`

- [ ] **Step 1: Write failing tests (separating byte layer and text layer)**

Append to `packages/corpus-tools/src/pvpLogFetch.test.ts`:

```ts
describe("checkRawPayloadBytes (raw compressed byte layer)", () => {
  it("passes when received bytes equal content-length", () => {
    expect(checkRawPayloadBytes(109885, 109885)).toEqual({ ok: true });
  });
  it("rejects when received bytes are fewer than expected (truncated)", () => {
    const r = checkRawPayloadBytes(50000, 109885);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/109885/);
  });
  it("skips byte check when expected bytes unavailable (delegates to sentinel layer)", () => {
    expect(checkRawPayloadBytes(50000, undefined)).toEqual({ ok: true });
  });
});

describe("checkDecompressedPayload (decompressed text layer)", () => {
  it("passes when both sentinels are present", () => {
    const t = "x ARENA_MATCH_START,2373 y ARENA_MATCH_END,1 z";
    expect(checkDecompressedPayload(t)).toEqual({ ok: true });
  });
  it("rejects when missing ARENA_MATCH_START", () => {
    expect(checkDecompressedPayload("ARENA_MATCH_END,1").ok).toBe(false);
  });
  it("rejects when missing ARENA_MATCH_END (Solo Shuffle concludes with single END)", () => {
    expect(checkDecompressedPayload("ARENA_MATCH_START,2373").ok).toBe(false);
  });
  it("no longer compares decompressed text against compressed byte count — fixes c9c463e bug", () => {
    // 1.4MB decompressed text + 109885 compressed content-length: old implementation misjudged as truncated,
    // causing all matches to be skipped. New text layer does not inspect byte counts.
    const t = "ARENA_MATCH_START," + "x".repeat(1_400_000) + "ARENA_MATCH_END,";
    expect(checkDecompressedPayload(t)).toEqual({ ok: true });
  });
});
```

Add `checkRawPayloadBytes`, `checkDecompressedPayload` to imports at top of file (remove references to `checkPayloadCompleteness` and its old test block).

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- pvpLogFetch`
Expected: FAIL —— `checkRawPayloadBytes is not a function` / `checkDecompressedPayload is not a function`

- [ ] **Step 3: Implement the two validation functions, removing the old one**

In `packages/corpus-tools/src/pvpLogFetch.ts`, replace `checkPayloadCompleteness` with:

```ts
/**
 * Raw byte layer validation: received compressed bytes must strictly match GCS content-length.
 *
 * Catches HTTP 200 connection dropoffs (Solo Shuffle matches can reach 30MB).
 * **Must compare against uncompressed bytes** — GCS stores objects as gzip (content-encoding: gzip),
 * where content-length is the compressed size; comparing against decompressed text length never matches.
 */
export function checkRawPayloadBytes(
  receivedBytes: number,
  expectedBytes: number | undefined,
): CompletenessResult {
  if (expectedBytes === undefined) return { ok: true };
  if (receivedBytes !== expectedBytes) {
    return {
      ok: false,
      reason: `byte length mismatch: expected ${expectedBytes}, got ${receivedBytes}`,
    };
  }
  return { ok: true };
}

/**
 * Decompressed text layer validation: both sentinels must be present.
 *
 * ARENA_MATCH_END must be present — Solo Shuffle 6 rounds share the same log object,
 * round switches emit START, with only the final round emitting END (segmenter.ts proof),
 * so complete payloads conclude with END uniformly across brackets.
 *
 * This layer **does not check byte counts**: byte count validation belongs to checkRawPayloadBytes.
 */
export function checkDecompressedPayload(text: string): CompletenessResult {
  if (!text.includes("ARENA_MATCH_START")) {
    return { ok: false, reason: "missing ARENA_MATCH_START" };
  }
  if (!text.includes("ARENA_MATCH_END")) {
    return { ok: false, reason: "missing ARENA_MATCH_END" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- pvpLogFetch`
Expected: PASS

- [ ] **Step 5: Write failing test for `downloadRaw`**

Append to `packages/corpus-tools/src/feedClient.test.ts`:

```ts
describe("downloadRaw (raw bytes, uncompressed)", () => {
  it("requests with compress:false and returns uncompressed bytes and content-length", async () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
    const fake = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (k: string) =>
          ({
            "content-length": String(body.length),
            "content-encoding": "gzip",
          })[k.toLowerCase()] ?? null,
      },
      arrayBuffer: async () => body.buffer.slice(0, body.length),
      json: async () => ({}),
    });
    const raw = await downloadRaw("https://x/y", "probe", fake as any);
    // compress:false is critical — otherwise node-fetch automatically decompresses, losing raw bytes
    expect(fake.mock.calls[0][1].compress).toBe(false);
    expect(raw.bytes.length).toBe(body.length);
    expect(raw.contentEncoding).toBe("gzip");
    expect(raw.expectedBytes).toBe(body.length);
    // UA must be attached
    expect(fake.mock.calls[0][1].headers["user-agent"]).toBe(USER_AGENT);
  });
});
```

Add `downloadRaw` to imports at top of file.

- [ ] **Step 6: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- feedClient`
Expected: FAIL —— `downloadRaw is not a function`

- [ ] **Step 7: Implement `downloadRaw`**

Move `expectedByteLength` **from `pvpLogFetch.ts` to `feedClient.ts`** (with JSDoc),
and add `export { expectedByteLength } from "./feedClient";` to `pvpLogFetch.ts`.

Append to `packages/corpus-tools/src/feedClient.ts`:

```ts
export interface RawDownload {
  /** Raw uncompressed response body bytes. Objects on GCS are stored as gzip, returning compressed bytes. */
  bytes: Buffer;
  /** Response content-encoding, usually "gzip"; empty string if uncompressed. */
  contentEncoding: string;
  /** Get response header (lowercase name), returns empty string if missing. */
  header(name: string): string;
  /** Declared byte count on GCS (= compressed size), undefined if unavailable. */
  expectedBytes: number | undefined;
}

/**
 * Download without decompressing.
 *
 * node-fetch defaults to compress:true (auto gunzip), which causes content-length (compressed size)
 * to mismatch received body length. With compress:false we receive raw bytes directly.
 */
export async function downloadRaw(
  url: string,
  label: string,
  fetchImpl?: FetchLike,
): Promise<RawDownload> {
  const f: FetchLike =
    fetchImpl ?? ((await import("node-fetch")).default as any);
  const res: any = await fetchWithRetry(f, url, { compress: false }, label);
  const header = (name: string): string =>
    res.headers?.get?.(name.toLowerCase()) ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytes,
    contentEncoding: header("content-encoding"),
    header,
    expectedBytes: expectedByteLength({
      contentLength: header("content-length"),
      storedContentLength: header("x-goog-stored-content-length"),
    }),
  };
}

/** Raw bytes -> text. Decompresses with gunzip if content-encoding is gzip. */
export function decodeRawPayload(raw: RawDownload): string {
  if (raw.contentEncoding === "gzip") {
    return gunzipSync(raw.bytes).toString("utf8");
  }
  return raw.bytes.toString("utf8");
}
```

Add `import { gunzipSync } from "node:zlib";` at top of `feedClient.ts`.

- [ ] **Step 8: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- feedClient`
Expected: PASS

- [ ] **Step 9: Update `fetchPvpLogs.ts` to use new path**

In `packages/corpus-tools/scripts/fetchPvpLogs.ts`:
Change import to:
`import { decodeRawPayload, downloadRaw, fetchDetailedStubs } from "../src/feedClient";`
Change `checkPayloadCompleteness` import to `checkDecompressedPayload, checkRawPayloadBytes`.

Replace `downloadWithMeta` with:

```ts
async function downloadWithMeta(
  url: string,
  id: string,
): Promise<{
  text: string;
  meta: NonNullable<ManifestEntry["gcsMeta"]>;
  rawCheck: ReturnType<typeof checkRawPayloadBytes>;
}> {
  const raw = await downloadRaw(url, `log download for ${id}`);
  const { meta, missingFields } = buildGcsMeta({
    wowVersion: raw.header("x-goog-meta-wow-version"),
    clientTimezone: raw.header("x-goog-meta-client-timezone"),
    clientYear: raw.header("x-goog-meta-client-year"),
    startTimeUtc: raw.header("x-goog-meta-starttime-utc"),
  });
  if (missingFields.length > 0) {
    console.warn(`  ${id}: gcsMeta missing fields ${missingFields.join(",")}`);
  }
  const rawCheck = checkRawPayloadBytes(raw.bytes.length, raw.expectedBytes);
  return { text: rawCheck.ok ? decodeRawPayload(raw) : "", meta, rawCheck };
}
```

Replace the download loop completeness check with:

```ts
const { text, meta, rawCheck } = await downloadWithMeta(
  stub.logObjectUrl,
  stub.id,
);
const completeness = rawCheck.ok ? checkDecompressedPayload(text) : rawCheck;
```

- [ ] **Step 10: typecheck + full unit tests**

Run: `npm run typecheck && npm test --workspace=packages/corpus-tools`
Expected: Both pass.

- [ ] **Step 11: Real-world verification (acceptance criteria)**

Run: `cd packages/corpus-tools && BRACKET=3v3 LIMIT=2 OUT_DIR=/tmp/pvp-fix-check npx tsx scripts/fetchPvpLogs.ts`

Expected: Outputs `[1/2] ... KB` and `[2/2] ... KB`, followed by `done: 2 new logs`.
**Prior to fix, the exact same command resulted in `skip <id>: incomplete download (byte length mismatch...)` x N, `done: 0 new logs`**.

Clean up: `rm -rf /tmp/pvp-fix-check`

- [ ] **Step 12: Commit**

```bash
git add packages/corpus-tools/src/pvpLogFetch.ts packages/corpus-tools/src/feedClient.ts packages/corpus-tools/scripts/fetchPvpLogs.ts packages/corpus-tools/src/pvpLogFetch.test.ts packages/corpus-tools/src/feedClient.test.ts
git commit -m "fix(corpus-tools): download completeness check layering — byte length on compressed bytes, sentinels on text"
```

---

### Task 2: `archivePlan.ts` —— Pure Archival Predicates

**Files:**

- Create: `packages/corpus-tools/src/archivePlan.ts`
- Test: `packages/corpus-tools/src/archivePlan.test.ts`

**Interfaces:**

- Consumes: `DetailedMatchStub` (from `./feedClient`)
- Produces:
  - `STOP_AFTER_KNOWN = 200`
  - `matchDateKey(startTimeMs: number): string` -> `"2026-08-01"` (UTC)
  - `shouldArchive(stub: DetailedMatchStub, known: Set<string>): boolean`
  - `shouldStopScanning(consecutiveKnown: number): boolean`
  - `stagingPathFor(stagingRoot: string, dateKey: string, matchId: string): string`
  - `driveDestFor(dateKey: string): string` -> `"2026/08/01"`
  - `interface BatchState { count: number; bytes: number }`
  - `shouldFlushBatch(state: BatchState): boolean`

- [ ] **Step 1: Write failing tests**

Create `packages/corpus-tools/src/archivePlan.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DetailedMatchStub } from "./feedClient";
import {
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
  STOP_AFTER_KNOWN,
} from "./archivePlan";

function stub(over: Partial<DetailedMatchStub> = {}): DetailedMatchStub {
  return {
    typename: "ArenaMatchDataStub",
    id: "m1",
    logObjectUrl: "https://storage.googleapis.com/x/m1",
    playerId: "Player-1",
    hasAdvancedLogging: true,
    durationInSeconds: 120,
    bracket: "3v3",
    units: [],
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    result: 1,
    playerTeamRating: 2100,
    winningTeamId: "0",
    playerTeamId: "0",
    team0MMR: 2100,
    team1MMR: 2100,
    ...over,
  };
}

describe("matchDateKey", () => {
  it("groups by UTC date regardless of local machine timezone", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe("2026-08-01");
  });
  it("UTC midnight boundary: 23:59 and 00:01 belong to distinct days", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
    expect(matchDateKey(Date.UTC(2026, 7, 2, 0, 0, 1))).toBe("2026-08-02");
  });
  it("month-end boundaries", () => {
    expect(matchDateKey(Date.UTC(2026, 7, 31, 23, 59, 0))).toBe("2026-08-31");
  });
});

describe("shouldArchive", () => {
  it("new match with advanced logging -> archive", () => {
    expect(shouldArchive(stub(), new Set())).toBe(true);
  });
  it("already in ledger -> do not archive", () => {
    expect(shouldArchive(stub({ id: "m1" }), new Set(["m1"]))).toBe(false);
  });
  it("lacks advanced logging -> do not archive", () => {
    expect(shouldArchive(stub({ hasAdvancedLogging: false }), new Set())).toBe(
      false,
    );
  });
  it("startTime is 0 (corrupted metadata) -> do not archive", () => {
    expect(shouldArchive(stub({ startTime: 0 }), new Set())).toBe(false);
  });
});

describe("shouldStopScanning", () => {
  it("continues scanning when consecutive known count below threshold", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN - 1)).toBe(false);
  });
  it("stops when threshold reached — protects against silent omissions from feed reordering", () => {
    expect(shouldStopScanning(STOP_AFTER_KNOWN)).toBe(true);
  });
  it("threshold is 200 (4 pages)", () => {
    expect(STOP_AFTER_KNOWN).toBe(200);
    expect(shouldStopScanning(1)).toBe(false);
  });
});

describe("paths", () => {
  it("staging path partitioned by date directory with matchId.txt.gz filename", () => {
    expect(stagingPathFor("/s", "2026-08-01", "abc")).toBe(
      "/s/2026-08-01/abc.txt.gz",
    );
  });
  it("Drive destination is YYYY/MM/DD", () => {
    expect(driveDestFor("2026-08-01")).toBe("2026/08/01");
  });
});

describe("shouldFlushBatch", () => {
  it("flushes when reaching 200 matches", () => {
    expect(shouldFlushBatch({ count: 200, bytes: 1 })).toBe(true);
  });
  it("flushes when reaching 500MB", () => {
    expect(shouldFlushBatch({ count: 3, bytes: 500 * 1024 * 1024 })).toBe(true);
  });
  it("continues accumulating when neither limit reached", () => {
    expect(shouldFlushBatch({ count: 199, bytes: 1024 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- archivePlan`
Expected: FAIL —— cannot find module `./archivePlan`

- [ ] **Step 3: Implementation**

Create `packages/corpus-tools/src/archivePlan.ts`:

```ts
import type { DetailedMatchStub } from "./feedClient";

/** Stop threshold: consecutive known matches required to consider scan caught up. */
export const STOP_AFTER_KNOWN = 200;

const BATCH_MAX_COUNT = 200;
const BATCH_MAX_BYTES = 500 * 1024 * 1024;

/** Date key (UTC) of match based on start time. */
export function matchDateKey(startTimeMs: number): string {
  return new Date(startTimeMs).toISOString().slice(0, 10);
}

/** Determines whether match should be archived. */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: Set<string>,
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (known.has(stub.id)) return false;
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

export function shouldStopScanning(consecutiveKnown: number): boolean {
  return consecutiveKnown >= STOP_AFTER_KNOWN;
}

export function stagingPathFor(
  stagingRoot: string,
  dateKey: string,
  matchId: string,
): string {
  return `${stagingRoot}/${dateKey}/${matchId}.txt.gz`;
}

/** Relative destination directory on Drive: 2026-08-01 -> 2026/08/01. */
export function driveDestFor(dateKey: string): string {
  return dateKey.replace(/-/g, "/");
}

export interface BatchState {
  count: number;
  bytes: number;
}

export function shouldFlushBatch(state: BatchState): boolean {
  return state.count >= BATCH_MAX_COUNT || state.bytes >= BATCH_MAX_BYTES;
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- archivePlan`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/src/archivePlan.ts packages/corpus-tools/src/archivePlan.test.ts
git commit -m "feat(corpus-tools): archivePlan pure predicates — date key / archival decision / stop condition / batch flushing"
```

---

### Task 3: `archiveLedger.ts` —— Daily Sharded Ledger

**Files:**

- Create: `packages/corpus-tools/src/archiveLedger.ts`
- Test: `packages/corpus-tools/src/archiveLedger.test.ts`

**Interfaces:**

- Consumes: `matchDateKey` (Task 2)
- Produces:
  - `LEDGER_WINDOW_DAYS = 10`
  - `interface LedgerEntry { id: string; dateKey: string; bracket: string; startTime: number; playerTeamRating: number; team0MMR: number; team1MMR: number; playerTeamId: string; winningTeamId: string; durationInSeconds: number; specs: string[]; bytes: number; uploaded: boolean }`
  - `ledgerShardPath(ledgerRoot: string, dateKey: string): string`
  - `recentDateKeys(todayMs: number, days: number): string[]`
  - `parseShard(text: string): LedgerEntry[]`
  - `serializeEntry(e: LedgerEntry): string`
  - `knownIdsFrom(entries: LedgerEntry[]): Set<string>`
  - `toIndexLine(e: LedgerEntry): string`

- [ ] **Step 1: Write failing tests**

Create `packages/corpus-tools/src/archiveLedger.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  knownIdsFrom,
  latestById,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "./archiveLedger";

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "m1",
    dateKey: "2026-08-01",
    bracket: "3v3",
    startTime: Date.UTC(2026, 7, 1, 12, 0, 0),
    playerTeamRating: 2100,
    team0MMR: 2090,
    team1MMR: 2110,
    playerTeamId: "0",
    winningTeamId: "1",
    durationInSeconds: 120,
    specs: ["105", "265"],
    bytes: 309855,
    uploaded: true,
    ...over,
  };
}

describe("recentDateKeys", () => {
  it("returns recent N days inclusive of today, new to old", () => {
    const keys = recentDateKeys(Date.UTC(2026, 7, 3, 5, 0, 0), 3);
    expect(keys).toEqual(["2026-08-03", "2026-08-02", "2026-08-01"]);
  });
  it("default window is 10 days", () => {
    expect(LEDGER_WINDOW_DAYS).toBe(10);
    expect(
      recentDateKeys(Date.UTC(2026, 7, 3), LEDGER_WINDOW_DAYS),
    ).toHaveLength(10);
  });
  it("handles month boundary correctly", () => {
    expect(recentDateKeys(Date.UTC(2026, 8, 1), 2)).toEqual([
      "2026-09-01",
      "2026-08-31",
    ]);
  });
});

describe("shard path", () => {
  it("one jsonl per day", () => {
    expect(ledgerShardPath("/l", "2026-08-01")).toBe("/l/2026-08-01.jsonl");
  });
});

describe("serialization", () => {
  it("one entry per line, roundtrips correctly", () => {
    const e = entry();
    expect(parseShard(serializeEntry(e))).toEqual([e]);
  });
  it("ignores empty and malformed lines", () => {
    const text = `${serializeEntry(entry())}\n\n{broken\n${serializeEntry(entry({ id: "m2" }))}\n`;
    expect(parseShard(text).map((e) => e.id)).toEqual(["m1", "m2"]);
  });
});

describe("knownIdsFrom", () => {
  it("only counts uploaded=true as archived", () => {
    const ids = knownIdsFrom([
      entry({ id: "ok", uploaded: true }),
      entry({ id: "pending", uploaded: false }),
    ]);
    expect(ids.has("ok")).toBe(true);
    expect(ids.has("pending")).toBe(false);
  });
});

describe("latestById", () => {
  it("last written entry wins for same id", () => {
    const out = latestById([
      entry({ id: "m1", uploaded: false }),
      entry({ id: "m1", uploaded: true }),
      entry({ id: "m2", uploaded: false }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.id === "m1")!.uploaded).toBe(true);
    expect(out.find((e) => e.id === "m2")!.uploaded).toBe(false);
  });
  it("preserves first seen order for index stability", () => {
    const out = latestById([
      entry({ id: "a" }),
      entry({ id: "b" }),
      entry({ id: "a" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("toIndexLine", () => {
  it("exports index line for Drive omitting local state fields", () => {
    const line = JSON.parse(toIndexLine(entry()));
    expect(line.uploaded).toBeUndefined();
    expect(line.id).toBe("m1");
    expect(line.team0MMR).toBe(2090);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- archiveLedger`
Expected: FAIL —— module not found

- [ ] **Step 3: Implementation**

Create `packages/corpus-tools/src/archiveLedger.ts`:

```ts
/** Loading window (days) for ledger shards. */
export const LEDGER_WINDOW_DAYS = 10;

export interface LedgerEntry {
  id: string;
  dateKey: string;
  bracket: string;
  startTime: number;
  playerTeamRating: number;
  team0MMR: number;
  team1MMR: number;
  playerTeamId: string;
  winningTeamId: string;
  durationInSeconds: number;
  specs: string[];
  bytes: number;
  uploaded: boolean;
}

export function ledgerShardPath(ledgerRoot: string, dateKey: string): string {
  return `${ledgerRoot}/${dateKey}.jsonl`;
}

export function recentDateKeys(todayMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function serializeEntry(e: LedgerEntry): string {
  return JSON.stringify(e);
}

export function parseShard(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LedgerEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      // skip corrupted line
    }
  }
  return out;
}

export function knownIdsFrom(entries: LedgerEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.uploaded).map((e) => e.id));
}

export function latestById(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  const order: string[] = [];
  for (const e of entries) {
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  return order.map((id) => byId.get(id)!);
}

export function toIndexLine(e: LedgerEntry): string {
  const { uploaded: _uploaded, ...rest } = e;
  return JSON.stringify(rest);
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- archiveLedger`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/src/archiveLedger.ts packages/corpus-tools/src/archiveLedger.test.ts
git commit -m "feat(corpus-tools): daily sharded archive ledger — 10-day sliding window, uploaded-only deduplication"
```

---

### Task 4: `archiveUpload.ts` —— rclone Upload Arguments and Success Judgment

**Files:**

- Create: `packages/corpus-tools/src/archiveUpload.ts`
- Test: `packages/corpus-tools/src/archiveUpload.test.ts`

**Interfaces:**

- Consumes: None (pure string handling)
- Produces:
  - `ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive"`
  - `interface ArchiveUploadConfig { stagingDir: string; remote: string; driveDest: string; dryRun: boolean }`
  - `buildArchiveUploadArgs(cfg: ArchiveUploadConfig): string[]`
  - `uploadSucceeded(exitCode: number, stderr: string): boolean`

- [ ] **Step 1: Write failing tests**

Create `packages/corpus-tools/src/archiveUpload.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REMOTE_ROOT,
  buildArchiveUploadArgs,
  uploadSucceeded,
} from "./archiveUpload";

const cfg = {
  stagingDir: "/s/2026-08-01",
  remote: "gdrive",
  driveDest: "2026/08/01",
  dryRun: false,
};

describe("buildArchiveUploadArgs", () => {
  it("copies to remote:root/YYYY/MM/DD", () => {
    const a = buildArchiveUploadArgs(cfg);
    expect(a[0]).toBe("copy");
    expect(a[1]).toBe("/s/2026-08-01");
    expect(a[2]).toBe(`gdrive:${ARCHIVE_REMOTE_ROOT}/2026/08/01`);
  });
  it("uses copy instead of sync to avoid deleting cloud files from local staging", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("sync");
  });
  it("does not include --ignore-existing so index.jsonl updates overwrite properly", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--ignore-existing");
  });
  it("includes --dry-run when dryRun is true", () => {
    expect(buildArchiveUploadArgs({ ...cfg, dryRun: true })).toContain(
      "--dry-run",
    );
  });
  it("omits --dry-run when dryRun is false", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--dry-run");
  });
});

describe("uploadSucceeded", () => {
  it("exit code 0 without ERROR -> success", () => {
    expect(uploadSucceeded(0, "Transferred: 12 / 12")).toBe(true);
  });
  it("non-zero exit code -> failure", () => {
    expect(uploadSucceeded(1, "")).toBe(false);
  });
  it("exit code 0 with ERROR in stderr -> failure", () => {
    expect(uploadSucceeded(0, "ERROR : m1.txt.gz: Failed to copy")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- archiveUpload`
Expected: FAIL —— module not found

- [ ] **Step 3: Implementation**

Create `packages/corpus-tools/src/archiveUpload.ts`:

```ts
/** Archive root directory on Drive. */
export const ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive";

export interface ArchiveUploadConfig {
  stagingDir: string;
  remote: string;
  driveDest: string;
  dryRun: boolean;
}

export function buildArchiveUploadArgs(cfg: ArchiveUploadConfig): string[] {
  return [
    "copy",
    cfg.stagingDir,
    `${cfg.remote}:${ARCHIVE_REMOTE_ROOT}/${cfg.driveDest}`,
    "--transfers",
    "4",
    "--checkers",
    "8",
    "--exclude",
    ".DS_Store",
    ...(cfg.dryRun ? ["--dry-run"] : []),
  ];
}

export function uploadSucceeded(exitCode: number, stderr: string): boolean {
  if (exitCode !== 0) return false;
  return !/\bERROR\b/.test(stderr);
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- archiveUpload`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/src/archiveUpload.ts packages/corpus-tools/src/archiveUpload.test.ts
git commit -m "feat(corpus-tools): archive upload rclone arguments and success predicate"
```

---

### Task 5: `runLock.ts` —— Anti-Reentrancy Run Lock

**Files:**

- Create: `packages/corpus-tools/src/runLock.ts`
- Test: `packages/corpus-tools/src/runLock.test.ts`

**Interfaces:**

- Consumes: None
- Produces:
  - `interface LockInfo { pid: number; startedAt: number }`
  - `parseLock(text: string): LockInfo | null`
  - `serializeLock(info: LockInfo): string`
  - `isLockStale(info: LockInfo | null, isAlive: (pid: number) => boolean): boolean`

- [ ] **Step 1: Write failing tests**

Create `packages/corpus-tools/src/runLock.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isLockStale,
  type LockInfo,
  parseLock,
  serializeLock,
} from "./runLock";

describe("lock file serialization", () => {
  it("roundtrips properly", () => {
    const info: LockInfo = { pid: 4242, startedAt: 1_700_000_000_000 };
    expect(parseLock(serializeLock(info))).toEqual(info);
  });
  it("corrupted content -> null", () => {
    expect(parseLock("")).toBeNull();
    expect(parseLock("garbage")).toBeNull();
    expect(parseLock('{"pid":"not a number"}')).toBeNull();
  });
});

describe("isLockStale", () => {
  it("no lock -> can acquire", () => {
    expect(isLockStale(null, () => true)).toBe(true);
  });
  it("locking process alive -> cannot acquire", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => true)).toBe(false);
  });
  it("locking process dead -> stale lock, can acquire", () => {
    expect(isLockStale({ pid: 1, startedAt: 0 }, () => false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --workspace=packages/corpus-tools -- runLock`
Expected: FAIL —— module not found

- [ ] **Step 3: Implementation**

Create `packages/corpus-tools/src/runLock.ts`:

```ts
export interface LockInfo {
  pid: number;
  startedAt: number;
}

export function serializeLock(info: LockInfo): string {
  return JSON.stringify(info);
}

export function parseLock(text: string): LockInfo | null {
  try {
    const o = JSON.parse(text);
    if (typeof o?.pid !== "number" || typeof o?.startedAt !== "number") {
      return null;
    }
    return { pid: o.pid, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

export function isLockStale(
  info: LockInfo | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!info) return true;
  return !isAlive(info.pid);
}
```

- [ ] **Step 4: Run tests to verify success**

Run: `npm test --workspace=packages/corpus-tools -- runLock`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/src/runLock.ts packages/corpus-tools/src/runLock.test.ts
git commit -m "feat(corpus-tools): archive run lock with PID liveness check"
```

---

### Task 6: `scripts/archivePvpLogs.ts` —— Orchestration Shell and Real-World Smoke Test

**Files:**

- Create: `packages/corpus-tools/scripts/archivePvpLogs.ts`
- Modify: `packages/corpus-tools/src/index.ts` (export new modules)

**Interfaces:**

- Consumes: Outputs of Tasks 1–5
- Produces: Executable script

- [ ] **Step 1: Write orchestration shell**

Create `packages/corpus-tools/scripts/archivePvpLogs.ts`:

```ts
// PvP log archival pipeline: scans feed -> downloads raw gzip bytes -> uploads to Drive -> records ledger for deduplication.
// Design spec: docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md
// Compliance: docs/DATA-COMPLIANCE.md
//
// Usage: npx tsx scripts/archivePvpLogs.ts
// Environment variables: ARCHIVE_ROOT / RCLONE_REMOTE / DOWNLOAD_SLEEP_MS / MAX_PAGES / DRY_RUN
import { spawnSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { statfsSync } from "fs";

import {
  driveDestFor,
  matchDateKey,
  shouldArchive,
  shouldFlushBatch,
  shouldStopScanning,
  stagingPathFor,
} from "../src/archivePlan";
import {
  knownIdsFrom,
  LEDGER_WINDOW_DAYS,
  ledgerShardPath,
  type LedgerEntry,
  parseShard,
  recentDateKeys,
  serializeEntry,
  toIndexLine,
} from "../src/archiveLedger";
import { buildArchiveUploadArgs, uploadSucceeded } from "../src/archiveUpload";
import {
  decodeRawPayload,
  downloadRaw,
  fetchDetailedStubs,
} from "../src/feedClient";
import {
  checkDecompressedPayload,
  checkRawPayloadBytes,
  dedupeByLogObject,
  KNOWN_BRACKETS,
  shouldSleepBeforeDownload,
  shouldSleepBeforePage,
} from "../src/pvpLogFetch";
import { isLockStale, parseLock, serializeLock } from "../src/runLock";

const ARCHIVE_ROOT =
  process.env.ARCHIVE_ROOT ??
  path.join(os.homedir(), "code/gladlog-eval-private/archive");
const RCLONE_REMOTE = process.env.RCLONE_REMOTE ?? "gdrive";
const DOWNLOAD_SLEEP_MS = Number(process.env.DOWNLOAD_SLEEP_MS ?? 2000);
const PAGE_SLEEP_MS = 500;
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 2000);
const DRY_RUN = process.env.DRY_RUN === "1";
const MIN_FREE_BYTES = 20 * 1024 ** 3;

const STAGING = path.join(ARCHIVE_ROOT, "staging");
const LEDGER = path.join(ARCHIVE_ROOT, "ledger");
const LOCK = path.join(ARCHIVE_ROOT, ".lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freeBytes(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function acquireLock(): boolean {
  fs.ensureDirSync(ARCHIVE_ROOT);
  const existing = fs.existsSync(LOCK)
    ? parseLock(fs.readFileSync(LOCK, "utf8"))
    : null;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === "EPERM";
    }
  };
  if (!isLockStale(existing, alive)) return false;
  const tmp = `${LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    serializeLock({ pid: process.pid, startedAt: Date.now() }),
  );
  fs.renameSync(tmp, LOCK);
  return true;
}

function flushDay(dateKey: string, pending: LedgerEntry[]): number {
  const dir = path.join(STAGING, dateKey);
  if (!fs.existsSync(dir)) return 0;
  const shard = ledgerShardPath(LEDGER, dateKey);
  const prior = fs.existsSync(shard)
    ? parseShard(fs.readFileSync(shard, "utf8"))
    : [];
  const all = latestById([
    ...prior,
    ...pending.map((e) => ({ ...e, uploaded: true })),
  ]).filter((e) => e.uploaded);
  fs.writeFileSync(
    path.join(dir, "index.jsonl"),
    all.map(toIndexLine).join("\n") + "\n",
  );

  const args = buildArchiveUploadArgs({
    stagingDir: dir,
    remote: RCLONE_REMOTE,
    driveDest: driveDestFor(dateKey),
    dryRun: DRY_RUN,
  });
  const r = spawnSync("rclone", args, { encoding: "utf8" });
  if (!uploadSucceeded(r.status ?? 1, r.stderr ?? "")) {
    console.error(
      `  Upload failed (${dateKey}), retaining staging for retry: ${r.stderr?.slice(0, 300)}`,
    );
    return 0;
  }
  fs.ensureDirSync(LEDGER);
  fs.appendFileSync(
    shard,
    pending.map((e) => serializeEntry({ ...e, uploaded: true })).join("\n") +
      (pending.length ? "\n" : ""),
  );
  if (!DRY_RUN) {
    for (const e of pending)
      fs.removeSync(stagingPathFor(STAGING, dateKey, e.id));
  }
  return pending.length;
}

async function main() {
  if (!acquireLock()) {
    console.log("Archive process already running, exiting.");
    return;
  }
  fs.ensureDirSync(STAGING);
  fs.ensureDirSync(LEDGER);

  // Flush leftover staging before scanning
  for (const d of fs.readdirSync(STAGING)) {
    const files = fs
      .readdirSync(path.join(STAGING, d))
      .filter((f) => f.endsWith(".txt.gz"));
    if (files.length === 0) continue;
    console.log(`Flushing legacy staging ${d}: ${files.length} matches`);
    const shard = ledgerShardPath(LEDGER, d);
    const prior = fs.existsSync(shard)
      ? parseShard(fs.readFileSync(shard, "utf8"))
      : [];
    const byId = new Map(latestById(prior).map((e) => [e.id, e]));
    const pending = files
      .map((f) => byId.get(f.replace(/\.txt\.gz$/, "")))
      .filter((e): e is LedgerEntry => !e && !e.uploaded);
    flushDay(d, pending);
  }

  const known = new Set<string>();
  for (const k of recentDateKeys(Date.now(), LEDGER_WINDOW_DAYS)) {
    const p = ledgerShardPath(LEDGER, k);
    if (fs.existsSync(p)) {
      for (const id of knownIdsFrom(parseShard(fs.readFileSync(p, "utf8")))) {
        known.add(id);
      }
    }
  }
  console.log(`Ledger known matches: ${known.size} (last ${LEDGER_WINDOW_DAYS} days)`);

  let fresh = 0;
  let downloads = 0;
  for (const bracket of KNOWN_BRACKETS) {
    let consecutiveKnown = 0;
    const batch = new Map<string, LedgerEntry[]>();
    let state = { count: 0, bytes: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      if (freeBytes(ARCHIVE_ROOT) < MIN_FREE_BYTES) {
        console.error("Free disk space < 20GB, aborting run.");
        break;
      }
      if (shouldSleepBeforePage(page)) await sleep(PAGE_SLEEP_MS);
      const { stubs } = await fetchDetailedStubs({
        bracket,
        offset: page * 50,
        count: 50,
      });
      if (stubs.length === 0) break;
      for (const stub of dedupeByLogObject(stubs)) {
        if (!shouldArchive(stub, known)) {
          if (known.has(stub.id)) consecutiveKnown++;
          continue;
        }
        consecutiveKnown = 0;
        if (shouldSleepBeforeDownload(downloads))
          await sleep(DOWNLOAD_SLEEP_MS);
        downloads++;
        const raw = await downloadRaw(stub.logObjectUrl, `archive ${stub.id}`);
        const byteCheck = checkRawPayloadBytes(
          raw.bytes.length,
          raw.expectedBytes,
        );
        if (!byteCheck.ok) {
          console.warn(`  skip ${stub.id}: ${byteCheck.reason}`);
          continue;
        }
        const textCheck = checkDecompressedPayload(decodeRawPayload(raw));
        if (!textCheck.ok) {
          console.warn(`  skip ${stub.id}: ${textCheck.reason}`);
          continue;
        }
        const dateKey = matchDateKey(stub.startTime);
        const p = stagingPathFor(STAGING, dateKey, stub.id);
        fs.ensureDirSync(path.dirname(p));
        fs.writeFileSync(p, raw.bytes);
        const entry: LedgerEntry = {
          id: stub.id,
          dateKey,
          bracket: stub.bracket || bracket,
          startTime: stub.startTime,
          playerTeamRating: stub.playerTeamRating,
          team0MMR: stub.team0MMR,
          team1MMR: stub.team1MMR,
          playerTeamId: stub.playerTeamId,
          winningTeamId: stub.winningTeamId,
          durationInSeconds: stub.durationInSeconds,
          specs: stub.units.filter((u) => u.info).map((u) => u.spec),
          bytes: raw.bytes.length,
          uploaded: false,
        };
        fs.appendFileSync(
          ledgerShardPath(LEDGER, dateKey),
          serializeEntry(entry) + "\n",
        );
        batch.set(dateKey, [...(batch.get(dateKey) ?? []), entry]);
        state = {
          count: state.count + 1,
          bytes: state.bytes + raw.bytes.length,
        };
        if (shouldFlushBatch(state)) {
          for (const [d, es] of batch) fresh += flushDay(d, es);
          batch.clear();
          state = { count: 0, bytes: 0 };
        }
      }
      if (shouldStopScanning(consecutiveKnown)) {
        console.log(
          `${bracket}: ${consecutiveKnown} consecutive known matches encountered, caught up. Stopping pagination.`,
        );
        break;
      }
      if (stubs.length < 50) break;
    }
    for (const [d, es] of batch) fresh += flushDay(d, es);
  }

  console.log(`done: ${fresh} new matches archived, ${downloads} download attempts.`);
  if (fresh === 0) {
    console.error("Warning: 0 new matches archived — check feed availability or schema changes.");
  }
  fs.removeSync(LOCK);
}

main().catch((e) => {
  fs.removeSync(LOCK);
  console.error("archivePvpLogs failed:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Export new modules**

Append to `packages/corpus-tools/src/index.ts`:

```ts
export * from "./archivePlan";
export * from "./archiveLedger";
export * from "./archiveUpload";
export * from "./runLock";
```

- [ ] **Step 3: typecheck + full unit tests**

Run: `npm run typecheck && npm test --workspace=packages/corpus-tools`
Expected: Both pass.

- [ ] **Step 4: DRY_RUN smoke test**

```bash
cd packages/corpus-tools
ARCHIVE_ROOT=/tmp/pvp-archive-smoke DRY_RUN=1 MAX_PAGES=1 npx tsx scripts/archivePvpLogs.ts
```

- [ ] **Step 5: Real machine smoke test**

Verify upload and deduplication behavior on second run.

- [ ] **Step 6: Commit**

```bash
git add packages/corpus-tools/scripts/archivePvpLogs.ts packages/corpus-tools/src/index.ts
git commit -m "feat(corpus-tools): PvP log archival pipeline orchestration shell — feed scan/raw byte storage/Drive upload/deduplication"
```

---

### Task 7: launchd Scheduled Task + Documentation

**Files:**

- Create: `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`
- Create: `docs/pvp-log-archive.md` (**English**)
- Create: `docs/pvp-log-archive.zh-CN.md` (Chinese version)
- Modify: `packages/corpus-tools/README.md`
- Modify: `docs/BACKLOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write plist file**

Create `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`.

- [ ] **Step 2: Write bilingual docs**

Create `docs/pvp-log-archive.md` and `docs/pvp-log-archive.zh-CN.md`.
Update `packages/corpus-tools/README.md`.

- [ ] **Step 3: Update BACKLOG and CLAUDE.md**

Update `docs/BACKLOG.md` item 19 and `CLAUDE.md` bilingual docs catalogue.

- [ ] **Step 4: Check documentation formatting and links**

- [ ] **Step 5: Commit**

```bash
git add packages/corpus-tools/ops/app.gladlog.pvp-archive.plist docs/pvp-log-archive.md docs/pvp-log-archive.zh-CN.md packages/corpus-tools/README.md docs/BACKLOG.md CLAUDE.md
git commit -m "docs: PvP log archiver bilingual documentation + launchd plist + BACKLOG #19 milestone note"
```

---

## Completion Criteria

1. `npm test --workspace=packages/corpus-tools` and `npm run typecheck` both green.
2. `BRACKET=3v3 LIMIT=2 npx tsx scripts/fetchPvpLogs.ts` successfully downloads 2 matches (Task 1 bug fix).
3. `npx tsx scripts/archivePvpLogs.ts` run twice: 1st run adds new logs, 2nd run results in 0 new logs, 0 downloads.
4. Google Drive `gladlog-pvp-archive/YYYY/MM/DD/` contains `.txt.gz` and `index.jsonl`.
5. Local `archive/staging/` is clean post-upload, `archive/ledger/*.jsonl` records `"uploaded":true`.
