/**
 * Archive ledger: records which matches have been **confirmed uploaded** to
 * Drive.
 *
 * Sharded by day and only the most recent LEDGER_WINDOW_DAYS are loaded: a
 * match older than the feed's 7-day window can never show up in a scan again,
 * so dedupe simply does not need the whole history. This keeps roughly 56k
 * entries in memory instead of the millions that accumulate year over year.
 *
 * The ledger and the index.jsonl uploaded to Drive are two views of the same
 * data — the ledger is the superset (it has the extra `uploaded` state), and
 * the index is exported from it by toIndexLine.
 */

import type { GcsMeta } from "./pvpLogFetch";

/** Ledger load window (days). 3 days of slack over the feed's ~7 days. */
export const LEDGER_WINDOW_DAYS = 10;

/**
 * epoch ms → UTC date key `YYYY-MM-DD`. **This is the only formatter.**
 *
 * The ledger shard name (`recentDateKeys` → `ledgerShardPath`) and the staging
 * / Drive directory name (`archivePlan.matchDateKey`) must match character for
 * character. If each side wrote its own `toISOString().slice(0,10)`, any change
 * on either side (local timezone, zero padding, separator) would make "today's
 * shard" disagree with "today's staging directory" and dedupe would silently
 * stop working: already archived matches find no ledger entry → everything is
 * downloaded again. UTC, not local time: archiving must be reproducible across
 * machines.
 */
export function dateKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface LedgerEntry {
  id: string;
  /**
   * URL of the GCS log object for this match — the **second dedupe key**.
   *
   * One Solo Shuffle match has 6 rounds sharing a single logObjectUrl but 6
   * distinct ids (see dedupeByLogObject in pvpLogFetch.ts). Deduping by id
   * alone means: across a page boundary the same object is downloaded twice
   * and stored under two filenames; across runs an offset shift changes which
   * round is "first seen", that id is not in the ledger → the whole match is
   * downloaded again and Drive gets yet another copy.
   * `fetchPvpLogs.ts:114-116,151` has long deduped on both have/haveLogs keys;
   * the archiver must carry over that other half.
   */
  logObjectUrl: string;
  dateKey: string;
  bracket: string;
  startTime: number;
  playerTeamRating: number;
  team0MMR: number;
  team1MMR: number;
  playerTeamId: string;
  winningTeamId: string;
  durationInSeconds: number;
  /**
   * specId of everyone in the match. It is in the log body too, but keeping a
   * copy avoids decompressing the whole file just to look up a spec.
   */
  specs: string[];
  /** Compressed byte size of the archived file. */
  bytes: number;
  /**
   * GCS object meta captured at download time (the four `x-goog-meta-*`
   * fields).
   *
   * **Must be stored**: the log body's timestamps carry no year and are in the
   * uploader's local timezone, so these headers are the only way to
   * reconstruct absolute time (see `docs/DATA-COMPLIANCE.md` §4). GCS objects
   * disappear after roughly 30 days, so whatever is not stored at archive time
   * is gone forever — `fetchPvpLogs.ts` already stores them in the manifest,
   * and the archiver gets the same `raw.header()`, so it must store them too.
   *
   * Optional: old ledger rows do not have this field, and the individual keys
   * are optional as well (missing when an old upload client or a CDN stripped
   * the header — `buildGcsMeta` omits a missing key entirely rather than
   * writing an empty string).
   */
  gcsMeta?: GcsMeta;
  /**
   * True only once the upload is confirmed — writing it early means losing a
   * match permanently.
   */
  uploaded: boolean;
}

export function ledgerShardPath(ledgerRoot: string, dateKey: string): string {
  return `${ledgerRoot}/${dateKey}.jsonl`;
}

/** dateKeys for the last `days` days, including today, newest first. */
export function recentDateKeys(todayMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(dateKeyOf(todayMs - i * 86_400_000));
  }
  return out;
}

export function serializeEntry(e: LedgerEntry): string {
  return JSON.stringify(e);
}

/**
 * Parse one shard. Bad lines are skipped rather than thrown on — when the
 * process is killed the last line may be only half written, and letting one
 * truncated line destroy a whole day's dedupe information costs a full
 * re-download of that day.
 */
export function parseShard(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LedgerEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      // skip bad line
    }
  }
  return out;
}

/**
 * Which matches this scan should skip, returned under **both** keys: id and
 * logObjectUrl.
 *
 * Two kinds are included:
 * 1. Those with `uploaded` true — confirmed to be on Drive.
 * 2. Those in `stagedIds` — the match's .txt.gz is still sitting in the local
 *    staging directory. Their `uploaded` is still false (staged files are left
 *    behind only when the upload failed), but the bytes are already local, so
 *    downloading again would waste the upstream volunteer project's bandwidth
 *    for nothing — which is exactly what the pre-flush comment means by "do not
 *    spend another of their downloads for nothing". Accepting only
 *    uploaded:true would disable this protection precisely when it is needed
 *    most (while uploads keep failing).
 *
 * Matches that merely downloaded successfully but failed to upload and whose
 * staging was already cleaned are NOT included — those must be re-downloadable.
 */
export function knownKeysFrom(
  entries: LedgerEntry[],
  stagedIds: ReadonlySet<string> = new Set(),
): { ids: Set<string>; logUrls: Set<string> } {
  const ids = new Set<string>();
  const logUrls = new Set<string>();
  for (const e of entries) {
    if (!e.uploaded && !stagedIds.has(e.id)) continue;
    ids.add(e.id);
    // Old ledger rows lack this field; letting an empty string into the set
    // would mark every stub missing the field as already known.
    if (e.logObjectUrl) logUrls.add(e.logObjectUrl);
  }
  return { ids, logUrls };
}

/**
 * Set of archived ids. **Counts only those with uploaded true** — a match that
 * downloaded but failed to upload must be retryable.
 */
export function knownIdsFrom(entries: LedgerEntry[]): Set<string> {
  // Single-source predicate: share the exact test used by knownKeysFrom, do
  // not write a second filter here.
  return knownKeysFrom(entries).ids;
}

/**
 * Keep only the last entry per id (preserving first-appearance order).
 *
 * Shards are append-only: a match first gets a row with uploaded:false (so
 * leftover staging can be recognised after a crash), then a second row with
 * uploaded:true once the upload is confirmed. Without folding, the index would
 * contain duplicate lines.
 */
export function latestById(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  const order: string[] = [];
  for (const e of entries) {
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  return order.map((id) => byId.get(id)!);
}

/** Index line exported to Drive: drops the local-only state field. */
export function toIndexLine(e: LedgerEntry): string {
  const { uploaded: _uploaded, ...rest } = e;
  return JSON.stringify(rest);
}

/**
 * Merge this local batch into the index.jsonl **already in the cloud** instead
 * of overwriting it with the local view.
 *
 * The local ledger keeps only the last 10 days, and it is empty after moving
 * machines, losing the ledger, or changing ARCHIVE_ROOT. If we rebuilt from
 * local state and copied over, then for every date touched again the remote
 * index would be truncated down to just the new batch — the .txt.gz files
 * themselves would survive (uploads use copy, not sync) but they would vanish
 * from the index, which is the same as being unfindable.
 *
 * Remote lines are kept verbatim (not re-serialized, to avoid pointless
 * rewrites caused by field version differences); for a shared id, local wins.
 */
export function mergeIndexLines(
  remoteText: string,
  local: LedgerEntry[],
): string {
  const byId = new Map<string, string>();
  for (const line of remoteText.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as { id?: unknown };
      if (typeof o?.id === "string") byId.set(o.id, s);
    } catch {
      // Skip bad lines: same reasoning as parseShard, one truncated line must
      // not destroy a whole day's index
    }
  }
  for (const e of local) byId.set(e.id, toIndexLine(e));
  if (byId.size === 0) return "";
  return [...byId.values()].join("\n") + "\n";
}
