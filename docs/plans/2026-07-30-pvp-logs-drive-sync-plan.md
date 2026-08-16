# fetch-pvp-logs → Google Drive Archive (rclone) Implementation Plan

2026-07-30 User approved: **Option 1 (rclone)**, zero manual scheduling, **not entering product bundle/release**
(pure corpus-tools layer). Background: wowarenalogs feed only kept ~7 days, downloaded others' match corpus
needs long-term storage in Google Drive.

## Design (brainstorm finalized)

- Channel: rclone (built-in OAuth client, `rclone config` one-time interactive authorization; resume/retry/rate limit
  built-in, 30MB SS large files stable).
- Structure mirror: local `$GLADLOG_EVAL_HOME/downloads/<slug>/` ↔ Drive
  `<remote>:gladlog-pvp-logs/<slug>/`.
- Incremental semantics: **bare `rclone copy`** (size+modtime skips unchanged files) —— more correct than `--ignore-existing`:
  log files are immutable and naturally skipped, `manifest.json` grows each fetch and must be re-uploaded.
- Script form: `packages/corpus-tools/scripts/syncPvpLogsToDrive.ts`, env:
  `REMOTE` (default `gdrive`) / `SRC` (default `$GLADLOG_EVAL_HOME/downloads`) /
  `DEST` (default `gladlog-pvp-logs`) / `DRY_RUN=1`.
  Pre-check: rclone exists (missing → prompt install method), remote configured (missing → prompt `rclone config`
  steps); print `rclone size` summary at the end.
- Pure logic (args build/listremotes parse) enters `src/driveSync.ts` with unit tests; spawn shell not tested.
- skill `.claude/skills/fetch-pvp-logs/SKILL.md` supplements "Archive to Google Drive" section
  (one-time rclone configuration + daily two commands + 7-day rhythm reminder).

## Acceptance Criteria (Honest)

Unit tests: args/parsing pure functions. **Real machine upload cannot be tested locally** (mac no rclone) —— user runs
`DRY_RUN=1` to view list first on machine with rclone installed, then uploads once for real; script gives readable guidance
instead of stack trace for foreseeable failures (not installed/not configured/non-zero exit on copy).
