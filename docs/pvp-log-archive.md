# PvP Log Long-Term Archive

**English** · [Chinese](pvp-log-archive.zh-CN.md)

`scripts/archivePvpLogs.ts` (in `packages/corpus-tools`) scans the
wowarenalogs.com public feed every 6 hours and archives every newly-seen
public match to Google Drive as **raw gzip bytes**, sorted into per-day
directories. It is collection-only: no parsing, no derived data, nothing
that changes the source bytes. Compliance basis (data source, terms,
collection discipline): [DATA-COMPLIANCE.md](DATA-COMPLIANCE.md). Design
rationale and the measured numbers behind every parameter:
`docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`.

## Before you enable it

The `gdrive:` rclone remote currently used by this archiver is configured
with **rclone's built-in shared Google Drive client_id**. Every rclone call
prints a notice that this client_id is being retired and will stop working
during 2026. Before turning the archiver on for unattended long-term
running, set up your own client_id:
https://rclone.org/drive/#making-your-own-client-id

If you skip this and the shared client_id is later cut off, uploads fail
silently from the archiver's point of view: `rclone copy` returns non-zero,
the run keeps the local staging directory and retries next time, so staging
only grows and never drains. The 20 GB free-disk guard (below) eventually
stops the process, but that is a halt, not an alert — nobody gets told why.

## Usage

```bash
cd packages/corpus-tools
npx tsx scripts/archivePvpLogs.ts
```

Requires `rclone` on `PATH` with a `gdrive` remote already configured
(or point `RCLONE_REMOTE` at a different configured remote name). The script
checks both **before** it touches the feed and exits with instructions if
either is missing — otherwise it would download tens of thousands of matches
from a volunteer project's storage and be unable to upload a single byte.

`DRY_RUN=1` still scans the feed, downloads, and writes to local staging —
that part is the point of the rehearsal — but it skips **flushing entirely**:
nothing is uploaded, nothing is recorded in the ledger as uploaded, and
nothing local is deleted. It is not "`rclone --dry-run`": `rclone copy
--dry-run` transfers nothing yet exits 0, so treating it as a successful
upload would write `uploaded: true` for matches that are not on Drive, and
the next real run would delete the local bytes and never re-download them.
Because staging is not drained, a `DRY_RUN` run leaves its downloads on disk
for the next real run to upload — remove `ARCHIVE_ROOT/staging` by hand if
you don't want that.

Note what the preflight above does **not** check: it only confirms `rclone`
is on `PATH` and that a remote named `gdrive` (or `RCLONE_REMOTE`) exists in
`rclone listremotes` — it never exercises auth, so an expired or revoked
token still passes it silently. `DRY_RUN=1` no longer touches rclone at all
(see above), so it can't stand in for an auth rehearsal either. Before
loading launchd for the first time, verify authorization directly: `rclone
lsd gdrive:` should list your Drive's top-level folders; if it errors, fix
auth before enabling the schedule.

## Environment variables

| Variable            | Default                                   | Meaning                                                                            |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `ARCHIVE_ROOT`      | `$HOME/code/gladlog-eval-private/archive` | Root for local staging and the ledger                                              |
| `RCLONE_REMOTE`     | `gdrive`                                  | rclone remote name                                                                 |
| `DOWNLOAD_SLEEP_MS` | `2000`                                    | Delay between downloads — **never set to 0** (the upstream is a volunteer project) |
| `MAX_PAGES`         | `2000`                                    | Max pages paged per bracket per run                                                |
| `DRY_RUN`           | unset                                     | `1` = skip flushing entirely (see below)                                           |

`DOWNLOAD_SLEEP_MS` and `MAX_PAGES` are parsed with a hard floor
(`parseThrottleEnv` in `src/archivePlan.ts`), and the two kinds of
"invalid" are treated differently. **Unset or an empty string** is
treated as "not configured" and silently falls back to the default —
no warning, since that's the ordinary case of the variable simply not
being set. **A non-numeric value, or a value below the floor**, is
different: it also falls back to the default, but the script prints a
`console.warn` naming the offending value, because that usually means
the variable was set to something wrong rather than left unset. The
floor for `DOWNLOAD_SLEEP_MS` is 250 ms (`MIN_DOWNLOAD_SLEEP_MS`); for
`MAX_PAGES` it is 1. The reason either case must not silently become
`0`: `Number("")` is `0`, `Number("2s")` is `NaN`, and
`setTimeout(r, NaN)` behaves like `0ms` — both would silently cancel
the politeness throttle against the upstream feed if left uncaught.

## Why store compressed bytes

Google Cloud Storage already stores each log gzip-compressed
(`content-encoding: gzip`). Downloading and storing the raw compressed
bytes — instead of decompressing before writing to disk — measured
**11.4x** smaller on the same objects. That turns a 5 TB Google Drive from
roughly **27 weeks** of runway (decompressed) into roughly **6 years**
(compressed). This is the single highest-leverage decision in the design;
see the "Empirical Base" table in the design spec for the underlying
measurements (feed depth, per-match size, growth rate).

## Installing as a scheduled job (launchd)

The plist lives at `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`
and is **not loaded automatically** — committing it to the repo does
nothing on its own. **When** to enable it is a decision for whoever runs
it, not something this doc prescribes. The current plan is to enable it
when the next competitive season starts in late August 2026: a corpus
should reflect the current season's meta, and the start of a season is a
clean point to begin accumulating from.

To install:

```bash
sed 's|<Repository Path>|/absolute/path/to/gladlog|' \
  packages/corpus-tools/ops/app.gladlog.pvp-archive.plist \
  > ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
launchctl load ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
```

To stop it:

```bash
launchctl unload ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
```

Runs 4 times a day (01:00 / 07:00 / 13:00 / 19:00 local time), logging to
`/tmp/gladlog-pvp-archive.log` / `.err`. launchd (rather than cron) is used
deliberately: cron simply skips a run missed because the laptop's lid was
closed, while launchd's `StartCalendarInterval` catches up on wake.

## Operational notes

1. **Zero new matches in a run is an incident, not a quiet success.** A
   normal run archives on the order of a thousand-plus matches. Zero means
   the feed is down or its query shape changed (e.g. an upstream schema
   change) — the script logs an explicit warning line when this happens,
   but nothing pages anyone. The feed only retains ~7 days, so a silent
   failure that lasts a week is a **permanent** week of lost data.
2. **Enablement timing is a human decision; the plist does not act on its
   own.** See "Installing as a scheduled job" above for the current plan
   and the install/uninstall commands.

## What's been verified so far

Real-machine verified (see `.superpowers/sdd/2026-08-01-pvp-log-archive/task-6-report.md`
for the full numbers): single-page scan against the live feed, downloading
and staging compressed bytes, uploading to Drive, the ledger only being
written **after** an upload is confirmed successful, and ledger-based
dedup across two consecutive runs (first run: 114 matches confirmed
uploaded, local staging emptied afterward, `rclone ls` showed 115 files on
Drive = 114 `.txt.gz` + 1 `index.jsonl`).

**Not yet real-machine verified**: a full first-time run, which is
expected to take about 22 hours end to end (see "First run" in the design
spec). Four branches that only trigger during a run that long have unit
test coverage but no real-machine evidence: batched flushing every 200
matches/500 MB, the 200-consecutive-known page-stop threshold, the 20 GB
free-disk guard, and flushing leftover staging from a prior run.

**One open risk to check first on the next smoke test**: `classifyIndexFetch`
(`src/archiveUpload.ts`) decides whether `rclone cat` failed because the
day's cloud index simply doesn't exist yet (normal, proceed with an empty
index) versus a real read failure (must abort the flush and keep local
staging) using a regex matched against `rclone`'s stderr text. That regex
has never been checked against real `rclone cat` output on a real machine.
The two misclassifications are **asymmetric**: treating a real read failure
as "doesn't exist" makes the run write this batch over the cloud's complete
index for that day — irreversible. Treating a genuinely-missing index as a
read failure is the recoverable direction: staging is kept and the next
round retries. So the regex is deliberately narrow —
`object|directory|file not found`, matching rclone's own
`ErrorObjectNotFound` / `ErrorDirNotFound` wording — and everything else
classifies as an error, including DNS failures whose text contains "no such
host" and rclone config errors like "didn't find section".

Note the residual risk that narrowness buys, because it is not merely "one
forfeited flush": if rclone's real "doesn't exist" wording is _not_ one of
those three, then **every day's first flush** is misread as a read failure,
staging never drains, and the archiver uploads nothing at all — a silent
stall, the same shape as the failure described under "Before you enable
it". Confirming the actual `rclone cat` stderr for a missing object is
therefore the first thing to check on the next real-machine smoke test.

The next smoke test should also use `MAX_PAGES=3` or higher, and should
**count duplicates by `logObjectUrl`, not by match `id`**. Solo Shuffle
plays 6 rounds that share a single GCS log object under 6 different match
ids, so id-based duplicate counting is blind to that entire class of
duplication.
