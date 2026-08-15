# PvP Log Long-Term Archive Pipeline Design (BACKLOG #19 Step 1)

> 2026-08-01 Finalized via brainstorm with user. Compliance basis see `docs/DATA-COMPLIANCE.md`.

## Goal

To **persistently archive the original** public PvP combat logs rolling on the wowarenalogs feed.

The feed only retains data for about 7 days, disappearing permanently upon expiration. Processing logic can be changed and rerun at any time, but if the raw data is lost, it's gone forever —
Therefore, the first step is strictly collection and archiving, **without any parsing or processing**. Another benefit of archiving the original data is versatility: it can be used directly by any other software, without being tied to this repository's schema.

How the data will be used in the future (updating population baselines, skill usage statistics, cross-version comparisons, training materials) **is not within the scope of this design**,
and will be designed separately once the archive is up and running with a real volume of data.

## Explicit Non-Goals

- No parsing, no metric calculation, no derived data persistence (local staging is merely a transit before uploading).
- No quota matrices / balanced sampling — full collection, no filtering by spec (see "Why not filter by spec").
- No gap detection and retroactive backfilling — if it's missed, it's missed (user confirmed).
- No modifications to the existing behavior of `fetchPvpLogs.ts` / `buildCorpus.ts`.

## Measured Baselines (2026-08-01)

Design parameters are entirely derived from actual measurements, not estimates:

| Metric                | Measured Value                                     | Measurement Method                 |
| --------------------- | -------------------------------------------------- | ---------------------------------- |
| Feed depth (7-day window)| 3v3 ~27,000 / 2v2 ~7,000 / SS ~25,000 stubs      | offset binary search probing       |
| Deduplicated matches  | 3v3 27,000 / 2v2 7,000 / SS ~5,000 (6 rounds share 1 file) | In-page `logObjectUrl` deduplication measured 50→10 |
| **Total**             | **~39,000 matches/week ≈ 5,570 matches/day**       |                                    |
| Single match size (compressed) | 3v3 0.30MB / 2v2 0.20MB / SS 1.4MB                 | GCS HEAD fetching `content-length` |
| Single match size (uncompressed) | 3v3 3.4MB / SS ~16MB                               | Actual fetch comparison            |
| Compression ratio     | **11.4x** (GCS side `content-encoding: gzip`)      | Same object compressed/uncompressed size |
| Archive growth rate   | **16.5GB/week ≈ 860GB/year** (compressed)          | Product of the two items above     |
| advanced logging ratio| Sampled 3 brackets, all **100%**                   | In-page stub statistics            |

Inference: 5TB Google Drive can last **about 6 years** if stored compressed; if stored uncompressed, it would only last about 27 weeks.
**Storing compressed is the single highest-yield decision in this design.**

Counterparty costs (GCS bill for a volunteer project): Full collection uses about 2.4GB/day in egress traffic, costing roughly **$100–200/year** at public rates. The user is informed and accepts this.

## Architecture and Data Flow

```
feed (GraphQL, reverse chronological order)
  ↓  Pagination, 50/page, 500ms between pages
stub stream
  ↓  Filter: hasAdvancedLogging && not in ledger && logObjectUrl deduplication
Queue pending download
  ↓  Download raw gzip bytes (uncompressed), 2s interval
Local staging  staging/<MatchDate>/<matchId>.txt.gz
               staging/<MatchDate>/index.jsonl
  ↓  Per-batch rclone copy
Google Drive   gdrive:gladlog-pvp-archive/YYYY/MM/DD/
  ↓  Confirm successful upload
Delete local + record entry in ledger
```

### Drive Directory Structure

```
gladlog-pvp-archive/
  2026/08/01/
    <matchId>.txt.gz      Raw compressed bytes, matching exactly what is on GCS
    index.jsonl           One line per match containing stub metadata
```

Partitioned by day, approximately 5,570 files and 2.4GB per directory.

`index.jsonl` **must be saved**: fields in the stub like `playerTeamRating`, `team0MMR`/`team1MMR`,
and both sides' `teamId` are **not present in the log body**, and similarly only exist within the 7-day window. Since they are already retrieved
when scanning the feed, saving a few extra hundred bytes permanently preserves the rating context.

Known risk: Google introduced a "5 million items per account" limit in 2023 and then **rolled it back**, stating
"rolling back this change as we explore alternate approaches" — meaning no promise was made not to reintroduce it.
At 2 million files/year, if this limit resurfaces, it would be hit in about 2.5 years. Mitigation: directories are already partitioned by day, and when the time comes, they can simply be packed day-by-day into
`YYYY/MM/DD.tar`; this is a mechanical migration and requires no redesign.

## Components

Follows the existing `corpus-tools` layering: pure logic exported for unit tests, spawn/IO kept in the `scripts/` shell
(consistent with `driveSync.ts` / `pvpLogFetch.ts`).

| File                        | Responsibility                                      |
| --------------------------- | --------------------------------------------------- |
| `src/archiveLedger.ts`      | Ledger: partitioned by day, load recent 10 days, query/record |
| `src/archivePlan.ts`        | Pure predicates: whether to stop pagination, whether to download, date attribution, staging path |
| `src/archiveUpload.ts`      | rclone args construction and output parsing       |
| `scripts/archivePvpLogs.ts` | Orchestration shell, launchd entrypoint             |

**The ledger and `index.jsonl` are two views of the same data**, avoiding redundant maintenance: the ledger partition
`ledger/YYYY-MM-DD.jsonl` per line = stub metadata + `uploaded` flag; the `index.jsonl` uploaded to Drive
is simply the exported result of rows where `uploaded` is true in that partition, with the status field stripped. Ledger partitions
are retained locally long-term (extremely small footprint, about 5,570 lines a day); only the staged `.txt.gz` are deleted after transmission.

## Specific Parameters

| Parameter            | Value                                      | Reason                                                |
| -------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Pagination interval  | 500ms                                      | Follows existing `PAGE_SLEEP_MS`                      |
| Download interval    | 2s                                         | Follows existing `DOWNLOAD_SLEEP_MS`                  |
| Stop threshold K     | 200 (4 pages)                              | Tolerates sporadic out-of-order/retransmissions       |
| Ledger load window   | 10 days                                    | Leaves a 3-day buffer over the feed's 7-day window    |
| Upload batch size    | Every 200 matches or 500MB, whichever comes first | If too small, rclone process overhead is high; if too large, retransmission cost on crash is high |
| Disk lower bound     | Stop current run if free space < 20GB      | Staging peak (500MB batch) plus system buffer, avoiding bursting a 460GB disk |
| Run lock             | `staging/.lock` (contains pid)             | See below                                             |

**A run lock is mandatory**: Scheduling is every 6 hours, while the initial full run takes about 22 hours — without a lock,
multiple instances would scan the same feed segment and redownload the same batch of files simultaneously. If an active lock is detected, the current run exits immediately (logging a line, not counted as a failure); the lock stores the pid to identify stale locks (taking over if the process is gone).

## Key Decisions and Reasons

**Directories organized by "match date" instead of "download date"** — derived from the stub's `startTime`. Otherwise, matches from the same day
would be scattered across different directories during retroactive scanning.

**Ledger partitioned by day, loading only the recent 10 days** — matches older than 7 days can no longer appear in the feed, so deduplication
doesn't need to query the entire history. The memory footprint is only about 56k records, instead of accumulating millions over the years.

**The stop condition is "K consecutive knowns" (K=200, i.e., 4 pages) instead of "encountering the first known"** — the feed
might have sporadic out-of-order entries or retransmissions; leaving a buffer prevents silent omissions caused by early stopping.

**The ledger is written only after confirming successful upload** — recording too early permanently loses a match. This leads to the next point.

**Every run first flushes the leftover staging from the previous run before scanning the feed** — otherwise, matches that were "downloaded successfully, uploaded failed"
would be redownloaded because they aren't in the ledger, wasting another round of the counterparty's bandwidth. Retaining the staging directory across runs serves exactly this purpose.

**Why not filter by spec** — all 6 players in a 3v3 match carry full advanced parameters (measured: recorder's
median casts 84, other 5 players 85; advanced parameter ratio is 100% for all; other 5 players having 0 casts is 0/200).
Filtering by spec requires deep pagination to find targets (costing more of their Firestore) while slashing the sample size to 1/6. A sequential full scan is
the most economical method for both parties.

**Running frequently > running long** — every 6 hours, about 1,400 stubs / 47 minutes each time, rather than once a day
for 3 hours. The total burden on the counterparty remains the same, but the cost of interruption is lower, and the probability of the machine being awake is higher.

## Failure and Recovery

| Failure Point | Handling | Cost |
| --- | --- | --- |
| Feed pagination failure | `fetchWithRetry` existing backoff (429/5xx/network, capped at 15s); aborts current run if exhausted | None, resumes scanning next time |
| Download failed/incomplete | Do not write file, do not record in ledger | Redownloads next time |
| rclone upload failure | Retain staging, do not record in ledger, do not delete local | Flushes first next time |
| Mid-run sleep/disconnect | Same as above, naturally resumable | None |
| Disk near full | Active detection, stops current run and explicitly errors if below threshold | Avoids bursting the system disk |

**Completeness validation modification**: The existing `checkPayloadCompleteness` criteria is "check for `ARENA_MATCH_START` after unzipping and compare byte counts", which is no longer applicable when storing compressed bytes. Change to **unzipping and validating once in memory** (gzip integrity + confirm it starts as a valid log), discard the unzipped result after validation, and only persist the compressed bytes to disk.
The CPU cost is negligible, but it preserves the guarantee of "not archiving bad files as successes" — once archived, there is no second copy of the raw data.

## Scheduling and Observability

**launchd instead of cron**: cron tasks are skipped entirely when the laptop lid is closed, while launchd's
`StartCalendarInterval` will catch up on missed runs after waking up. Every 6 hours.

User has explicitly stated: The machine is kept on as much as possible, occasional lid closures are temporary; if it's really off for a long time, missing data is fine — therefore
**no gap detection and retroactive backfilling will be implemented**.

**Keep observability minimal**: Each run writes a one-line summary (pages scanned, matches added, matches skipped, matches failed,
bytes uploaded), ending with a non-zero exit code upon failure.

One case needs a separate alert: **a run adds 0 matches**. Normally, every run should add thousands of matches; 0 means the feed is down
or the query failed (e.g., they changed the schema), and a silent failure like this persisting for a week means a permanent loss of a week's data.

## Impact on Existing Features: Zero

`downloadWithMeta` and `checkPayloadCompleteness` are shared code used by `fetchPvpLogs.ts`,
and their behavior cannot be directly altered. The approach is to extract a `downloadRaw()` layer underneath that returns compressed bytes and response headers:

- Archiver: directly persists the compressed bytes to disk
- `fetchPvpLogs`: unzips on top of `downloadRaw()`, keeping its outward behavior identically unchanged (still writing uncompressed `.txt`)

`buildCorpus.ts` is unaffected. The existing contents and semantics of `$GLADLOG_EVAL_HOME/downloads/` remain untouched.

## Testing

Unit tests cover pure functions (all runnable with mock data):

- **Stop condition** — only stops after K consecutive knowns; if a new one is sandwiched in between, it must continue (prevents silent omissions from early stopping).
- **Date attribution** — based on `startTime` instead of download time; crossing UTC midnight boundaries.
- **Staging flush sequence** — must upload before scanning if leftover staging exists.
- **Ledger partitioning** — only loads the recent 10 days; old records beyond the window do not affect deduplication results.
- **Run lock** — a second instance must exit if there is an active lock; stale locks (pid no longer exists) must be taken over.
- **Record after upload confirmation** — the ledger must not contain the entry if the upload fails.
- **Completeness validation** — truncated gzips or valid gzips containing non-log content must both evaluate as failures.

The IO shell will not have unit tests (consistent with the existing `fetchPvpLogs.ts`), relying on a single `LIMIT=2` actual smoke verification
end-to-end: real scan, real download, real upload, real deletion, real recording.

## Initial Run

When the ledger is empty, it will scan all the way to the end of the feed: about 39,000 matches, 16.5GB, taking about 22 hours at a 2s interval.
Interruptible, resumes on the next run.
