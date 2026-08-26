# collect-logs — Log Collection Channels Overview

Four channels, one entry point (root `npm run logs:*`). Raw logs are the source of everything:
combat reports, replays, and AI all parse from `WoWCombatLog*.txt`.

## 1. Local Real-Time (Desktop built-in, no command needed)

The app monitors the WoW `Logs/` directory and automatically imports matches when finished; for historical logs, use the in-app
"Import Historical Logs..." (Settings page / first-launch guide), deduplicated per match.

## 2. Cross-Machine Relay (Gaming machine ≠ Analysis machine)

```bash
npm run logs:stream    # Gaming machine: tail logs → Google Drive (resumable upload)
npm run logs:collect   # Local machine: byte-accurately reconstruct log files from Drive
```

Implementation: `packages/log-pipeline` (independent deployment package, with built-in state/cleanup/heartbeat).

## 2b. Permanent Drive Archive of Your Own Logs

```bash
npm run logs:archive-own              # incremental: gzip + upload what is new
DRY_RUN=1 npm run logs:archive-own    # list what would go up, touch nothing
```

Copies the collector's reconstructed logs (`~/gladlog-sync/logs`) to
`gdrive:gladlog-own-logs` as gzip (measured **11.6x**: 21 GB of logs →
1.9 GB on Drive). The local `.txt` files are never touched — this adds a
copy, it does not move one.

Three things make it permanent, and all three are load-bearing:

- **`rclone copy`, never `rclone sync`.** `sync` deletes remote files that
  are absent locally, so the day the local 21 GB is cleared, the archive
  would be cleared with it. A unit test in
  `packages/corpus-tools/src/ownLogArchive.test.ts` pins the subcommand and
  the absence of any `--delete` flag.
- **No delete path at all.** The script deletes only its own local staging,
  after an upload is confirmed.
- **A separate Drive directory from `gladlog-relay`**, whose segments the
  relay cleans up by design.

Dedup keys on **(filename, source size)**, recorded in
`gdrive:gladlog-own-logs/manifest.json` (on Drive, not locally, so it
survives losing this machine). Size, not name alone: a session archived
while the streamer was still appending is a truncated snapshot, and
name-only dedup would pin that truncation forever. For the same reason a
log touched within the last 10 minutes is skipped — it is probably still
being written.

The manifest is written **after** the logs are confirmed uploaded. A
failed upload keeps the local staging and leaves the manifest alone, so a
re-run retries; the reverse order would mark a file done that never landed.

## 3. Public Match Fetching (eval corpus; wowarenalogs public feed)

```bash
export GLADLOG_EVAL_HOME=~/code/gladlog-eval-private
npm run logs:fetch-public -- --count 60                       # Latest public matches, filter: recorder=DPS + advanced log + arena only
npm run logs:fetch-public -- --count 60 --bracket 3v3 --min-rating 1600
```

- Output: `$GLADLOG_EVAL_HOME/corpus/public-dps/<matchId>.txt` + `manifest-recorder-dps.txt`,
  directly fed to `buildCorpus --manifest ... --owner recorder`.
- **minRating must be passed alongside --bracket** (Server Firestore composite index; single pass results in 500 error).
- Client = shared feedClient in `@gladlog/corpus-tools` (shares the same endpoint/retry/pagination
  with pro comparison corpus, `fetchDetailedStubs`/`downloadLogText`) — modify query in one place only.

## 4. Pro Comparison Corpus (Cell Aggregation)

`packages/corpus-tools`: Same feedClient fetches high-rating matches, aggregated into spec×bracket
benchmark cells (used for verified comparison). See `corpus-tools/src/feedClient.ts`.

## Conventions

- eval manifest = plain text with one absolute log path per line; manually maintained master manifests are at
  `$GLADLOG_EVAL_HOME/corpus/manifest*.txt`, crawler outputs include their own manifests.
- All wowarenalogs network requests go through `fetchWithRetry` (exponential backoff for 429/5xx) +
  polite delay; GraphQL combats is an interface type, **MUST** use
  `... on ArenaMatchDataStub` inline fragment to select fields (direct selection returns 400).

## 5. Reference Corpus Refresh

```bash
# Full rebuild (2300+, 1200 matches per each of the three brackets, ~1h; LOG_CACHE_DIR caches raw logs to accelerate re-runs)
WOW_PATCH=12.1.0.68629 LOG_CACHE_DIR=$HOME/code/gladlog-eval-private/corpus/logcache \
  npm run corpus:build-reference
```

Output: `packages/corpus-tools/data/reference_vectors.json` (read directly in dev; bundled into release
resources). Contains 6 healer dimensions + 7 DPS dimensions (burst conversion, immunity uptime, coordination, on-target, kick, etc.,
predicates = burst ledger trio).

**Weekly Automatic Refresh (Requires manual setup, single command)**:

```bash
cat > ~/Library/LaunchAgents/com.gladlog.corpus-refresh.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gladlog.corpus-refresh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd $HOME/code/gladlog &amp;&amp; WOW_PATCH=12.1.0.68629 LOG_CACHE_DIR=$HOME/code/gladlog-eval-private/corpus/logcache npm run corpus:build-reference >> /tmp/gladlog-corpus-refresh.log 2>&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.gladlog.corpus-refresh.plist
```

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.gladlog.corpus-refresh.plist && rm ~/Library/LaunchAgents/com.gladlog.corpus-refresh.plist`.
