import { dateKeyOf, latestById, type LedgerEntry } from "./archiveLedger";
import type { DetailedMatchStub } from "./feedClient";
import {
  checkDecompressedPayload,
  checkRawPayloadBytes,
  type CompletenessResult,
} from "./pvpLogFetch";

/**
 * Pagination stop threshold: only after seeing this many consecutive
 * "already in the ledger" matches do we consider ourselves caught up.
 *
 * It cannot be 1 -- the feed has occasional out-of-order entries and
 * re-transmits, so stopping at the first known match would silently skip the
 * newer matches behind it, and a missed match is a permanent loss under the
 * 7-day window. 200 = 4 pages, which leaves ample margin.
 */
export const STOP_AFTER_KNOWN = 200;

const BATCH_MAX_COUNT = 200;
const BATCH_MAX_BYTES = 500 * 1024 * 1024;

/**
 * The date (UTC) a match belongs to. Uses the **match start time**, not the
 * download time -- otherwise a backfill scan would scatter same-day matches
 * across different directories. Formatting itself goes through `dateKeyOf`
 * (single-source with the ledger shard name; do not write it a second time).
 */
export function matchDateKey(startTimeMs: number): string {
  return dateKeyOf(startTimeMs);
}

/** Shape of a date directory name: `YYYY-MM-DD`, isomorphic to the output of
 * `dateKeyOf`. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether this name is a date shard directory (`YYYY-MM-DD`).
 *
 * The staging root is **not guaranteed to contain only date directories**:
 * opening it once in Finder leaves a `.DS_Store`, which sorts before every
 * date lexicographically. Without this filter, `readdirSync` on a plain file
 * throws ENOTDIR, which escapes into `main().catch` and exits 1 -- nothing
 * gets flushed, the feed is never scanned, and even the single "0 new
 * matches" warning is never reached, so every run afterwards stalls silently
 * at the same spot.
 */
export function isDateKeyDir(name: string): boolean {
  return DATE_KEY_RE.test(name);
}

/**
 * Whether this match is **known** (already archived / already staged /
 * already downloaded in this run).
 *
 * Two keys: check id **and** logObjectUrl. A shuffle match's 6 rounds share
 * one log object but have distinct ids, so checking only the id would
 * re-download the same GCS object across pages/runs and store it several
 * times on Drive (the have/haveLogs pair in `fetchPvpLogs.ts:148-153` is the
 * precedent for the same predicate). An empty `logObjectUrl` must pass a
 * truthiness guard first -- otherwise, once an empty string gets into the
 * set, every stub missing that field is judged known as well.
 *
 * `shouldArchive` (take it or not) and the orchestration shell's
 * `consecutiveKnown` (when to stop paging) must share this **same**
 * predicate: getting the former wrong means re-downloading (costs money),
 * getting the latter wrong means stopping early (a missed match = permanently
 * lost after 7 days).
 */
export function isKnownStub(
  stub: DetailedMatchStub,
  known: ReadonlySet<string>,
  knownLogUrls: ReadonlySet<string> = new Set(),
): boolean {
  if (known.has(stub.id)) return true;
  if (stub.logObjectUrl && knownLogUrls.has(stub.logObjectUrl)) return true;
  return false;
}

/**
 * Whether this match should be downloaded.
 *
 * The caller must add ids/URLs to both sets as it downloads **within the
 * current run** -- the feed is live, new matches shift the whole list down
 * while paging, and a stub at the end of one page reappears verbatim at the
 * start of the next.
 */
export function shouldArchive(
  stub: DetailedMatchStub,
  known: ReadonlySet<string>,
  knownLogUrls: ReadonlySet<string> = new Set(),
): boolean {
  if (!stub.hasAdvancedLogging) return false;
  if (isKnownStub(stub, known, knownLogUrls)) return false;
  // A missing/zero startTime would file the match under a 1970 directory,
  // polluting the whole day-sharded structure.
  if (!stub.startTime || stub.startTime <= 0) return false;
  return true;
}

/**
 * Completeness predicate for the archive path. Three layers; failing any one
 * discards the whole match -- and it **must count toward the consecutive
 * failure counter**: a systematic failure (e.g. another bug like "compressed
 * size compared against decompressed length") makes every match fail, and
 * without counting it we would download the entire feed and throw all of it
 * away, spinning through ~2.4GB of a volunteer project's egress per run x 4
 * runs/day, while the `shouldAbortAfterFailures` brake is never applied.
 *
 * 1. `content-encoding` must be `gzip`. When GCS does not receive
 *    `Accept-Encoding: gzip` it transcodes server-side (sends it
 *    decompressed, with no content-length), and then the byte check passes
 *    straight through because `expectedBytes === undefined` -- what lands on
 *    disk is **plaintext** under a `.txt.gz` name, 11.4x the size, and
 *    anyone reading it as gzip later blows up.
 * 2. The compressed byte count matches what GCS declared
 *    (`checkRawPayloadBytes`, which must compare on **undecompressed** bytes).
 * 3. The decompressed text contains both sentinels
 *    (`checkDecompressedPayload`).
 *
 * `decode` takes a thunk rather than an already-decompressed string: if the
 * first two layers fail there is no need to waste a gunzip.
 */
export function checkArchivePayload(input: {
  contentEncoding: string;
  byteLength: number;
  expectedBytes: number | undefined;
  decode: () => string;
}): CompletenessResult {
  if (input.contentEncoding !== "gzip") {
    return {
      ok: false,
      reason: `content-encoding 不是 gzip(实为 "${input.contentEncoding}")—— 明文不能以 .txt.gz 落盘`,
    };
  }
  const bytes = checkRawPayloadBytes(input.byteLength, input.expectedBytes);
  if (!bytes.ok) return bytes;
  return checkDecompressedPayload(input.decode());
}

export function shouldStopScanning(consecutiveKnown: number): boolean {
  return consecutiveKnown >= STOP_AFTER_KNOWN;
}

/** Staging file suffix -- path building and id parsing share this one
 * constant; do not spell it out in two places. */
export const STAGED_SUFFIX = ".txt.gz";

export function stagingPathFor(
  stagingRoot: string,
  dateKey: string,
  matchId: string,
): string {
  return `${stagingRoot}/${dateKey}/${matchId}${STAGED_SUFFIX}`;
}

/** Parse the matchId back out of a staging file name; returns null for
 * non-staging files (index.jsonl / .DS_Store). */
export function stagedMatchIdFrom(fileName: string): string | null {
  if (!fileName.endsWith(STAGED_SUFFIX)) return null;
  const id = fileName.slice(0, -STAGED_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** The ids of every staged match in a directory listing. */
export function stagedIdsFrom(fileNames: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of fileNames) {
    const id = stagedMatchIdFrom(f);
    if (id) out.add(id);
  }
  return out;
}

export interface StagingPlan {
  /** Has a ledger entry and is not yet uploaded -- only this batch should be
   * uploaded, recorded, and deleted. */
  toUpload: LedgerEntry[];
  /** Ledger already says uploaded:true yet the file is still local -- just
   * delete it; no re-upload and no duplicate ledger entry. */
  alreadyUploaded: string[];
  /** File on disk with no matching ledger entry -- leftovers from being
   * killed between writing to disk and recording in the ledger. */
  orphans: string[];
}

/**
 * Reconcile "what is on disk" against "what the ledger says", then decide how
 * to flush this day.
 *
 * Why: `rclone copy <dir>` uploads **every** .txt.gz in the directory, while
 * the ledger writes and deletions only cover the batch the caller holds. Once
 * the two diverge, three kinds of orphan appear:
 * - Killed after recording but before deleting: the entry is already
 *   uploaded:true, so the next !uploaded filter skips it, the file stays
 *   local forever, and every run pointlessly triggers rclone once more.
 * - Killed after writing to disk but before recording: no ledger entry, yet
 *   copy blindly uploads it to Drive (possibly a truncated gz), and it never
 *   appears in index.jsonl -- a cloud file the index cannot find.
 * - Empty batch: it would still write the index, spawn rclone, and append an
 *   empty string to the ledger.
 *
 * Orphans are always deleted locally rather than blindly uploaded: the feed
 * still has a 7-day window, so re-downloading is a bounded cost, whereas
 * uploading an unverifiable file that is absent from the index is permanent
 * pollution.
 */
export function reconcileStaging(
  fileNames: readonly string[],
  entries: readonly LedgerEntry[],
): StagingPlan {
  const byId = new Map(latestById([...entries]).map((e) => [e.id, e]));
  const plan: StagingPlan = { toUpload: [], alreadyUploaded: [], orphans: [] };
  for (const f of fileNames) {
    const id = stagedMatchIdFrom(f);
    if (!id) continue;
    const e = byId.get(id);
    if (!e) plan.orphans.push(id);
    else if (e.uploaded) plan.alreadyUploaded.push(id);
    else plan.toUpload.push(e);
  }
  return plan;
}

/**
 * Under DRY_RUN the flush must be **skipped entirely**: no index write, no
 * rclone spawn, no ledger entry, no local deletion.
 *
 * Why (2026-08-01 review C1): `rclone copy --dry-run` uploads nothing, exits
 * 0, and prints `NOTICE: ... Skipped copy as --dry-run is set` on stderr, so
 * `uploadSucceeded` judged it a success and the ledger appended a line with
 * `uploaded:true`. On the next real run: the pre-flush `reconcileStaging`
 * classifies it as `alreadyUploaded` -> the local bytes are deleted;
 * `knownKeysFrom` classifies it as known -> it is never re-downloaded. Once
 * the 7-day feed window passes, that match is **permanently lost** -- purely
 * because a "do nothing" rehearsal was run once.
 *
 * So the predicate is "was it actually uploaded", and `--dry-run` is by
 * definition a no.
 */
export function shouldSkipFlush(dryRun: boolean): boolean {
  return dryRun;
}

/**
 * After a flush is confirmed successful, which entries to append to the
 * ledger -- `uploaded: true` is stamped **here and only here**.
 *
 * Returns empty when `dryRun` is true: this and `shouldSkipFlush` are two
 * gates on the same predicate (the orchestration shell already returned at
 * the top of `flushDay`, so in theory we never get here). The duplication is
 * deliberate, because getting it wrong permanently loses matches, and each
 * gate is pinned by its own unit test.
 */
export function ledgerEntriesToAppend(
  toUpload: readonly LedgerEntry[],
  dryRun: boolean,
): LedgerEntry[] {
  if (dryRun) return [];
  return toUpload.map((e) => ({ ...e, uploaded: true }));
}

/**
 * Lower bound for throttling env vars. Empty string / non-numeric / 0 all
 * fall back to the default -- `Number("")` is 0 and `Number("2s")` is NaN
 * while `setTimeout(r, NaN)` is equivalent to 0ms, so both make throttling
 * **disappear entirely** without a peep. Upstream is a volunteer project;
 * a polite request rate is a hard constraint and must never default to 0.
 */
export const MIN_DOWNLOAD_SLEEP_MS = 250;

export function parseThrottleEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
): { value: number; usedFallback: boolean } {
  if (raw === undefined || raw.trim() === "") {
    return { value: fallback, usedFallback: false };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min)
    return { value: fallback, usedFallback: true };
  return { value: n, usedFallback: false };
}

/**
 * How many consecutive failures abort the current run.
 *
 * A single-match anomaly (download retries exhausted, decompression throwing
 * on an oversized shuffle log, ENOSPC on write) should not interrupt the
 * 22-hour initial full pull, but sustained failure should stop -- spinning on
 * is just hammering someone else's GCS.
 */
export const MAX_CONSECUTIVE_FAILURES = 20;

export function shouldAbortAfterFailures(consecutiveFailures: number): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

/** Relative destination directory on Drive: 2026-08-01 -> 2026/08/01. */
export function driveDestFor(dateKey: string): string {
  return dateKey.replace(/-/g, "/");
}

export interface BatchState {
  count: number;
  bytes: number;
}

/**
 * Whether to flush this batch. Too small and the per-batch rclone process
 * overhead dominates; too large and a mid-way crash costs a lot to re-upload
 * -- 200 matches or 500MB, whichever comes first.
 */
export function shouldFlushBatch(state: BatchState): boolean {
  return state.count >= BATCH_MAX_COUNT || state.bytes >= BATCH_MAX_BYTES;
}
