/** Single source of truth for the auto-update check schedule: how long after
 * launch the first check runs, and how often it repeats after that.
 *
 * Two independent consumers need the exact same two numbers:
 *   - main/updater.ts builds its setTimeout/setInterval pair from these.
 *   - the settings page renders "checks 30s after launch, then every 4h" from
 *     these same two numbers, so the copy can never drift from what the timer
 *     actually does.
 *
 * Living in shared/ rather than main/updater.ts is an architecture-boundary
 * constraint, not fastidiousness: the renderer needs a *value* import to
 * render that sentence, but main/updater.ts is a main-process module and
 * renderer code must never cross that layer with a value import, regardless
 * of what updater.ts happens to pull in itself (its own file header notes it
 * stays free of electron and electron-updater). This mirrors the existing
 * shared/aiModels.ts and shared/promptVersion.ts precedent -- both are
 * value-imported from renderer and main/* alike.
 *
 * This module must stay a pure leaf: no import of electron, electron-updater,
 * or anything from main/*. main/updater.ts imports these two constants (it
 * does not re-export them) -- a second export point is exactly the "one fact,
 * two copies" drift this repo's CLAUDE.md bans. */

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
