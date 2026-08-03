/** Auto-update, Windows NSIS installs only (design doc:
 * docs/superpowers/specs/2026-08-02-auto-update-design.md).
 *
 * This module stays free of electron and of electron-updater: the real
 * autoUpdater and everything it needs (platform, packaged flag, install
 * directory listing) are injected, so the whole gate + state machine can be
 * tested under vitest without launching electron. Same reasoning as the header
 * of quitLifecycle.ts. */

export type UpdateState =
  | { phase: "disabled"; reason: "platform" | "dev" | "portable" }
  | { phase: "idle"; lastCheckedAt: number | null }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export interface UpdaterEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** dirname(process.execPath) */
  execDir: string;
  /** Lists file names under execDir; readdirSync in production, an array in tests. */
  readDir: (dir: string) => string[];
  /** Value of GLADLOG_UPDATER_TEST_FEED; undefined when unset. */
  testFeed: string | undefined;
}

export type GateResult =
  | { ok: true; feed: { owner: string; repo: string } | null }
  | { ok: false; reason: "platform" | "dev" | "portable" };

/** "<owner>/<repo>" and nothing else. */
const TEST_FEED_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** NSIS drops "Uninstall <productName>.exe" next to the app executable
 * (app-builder-lib 26.15.3, templates/nsis/common.nsh:17 UNINSTALL_FILENAME,
 * written into $INSTDIR by templates/nsis/include/installer.nsh:100). A zip
 * portable extraction never has one, yet it reports app.isPackaged === true
 * and ships the same app-update.yml, so electron-updater cannot tell the two
 * apart on its own -- without this guard a portable user would get a second
 * copy installed under %LOCALAPPDATA%\Programs\gladlog.
 *
 * Matched as a pattern rather than the literal "Uninstall gladlog.exe":
 * renaming productName would silently break a hard-coded name, and the
 * failure direction ("looks portable, never updates") produces no error at
 * all. updater.uninstallerName.test.ts asserts this pattern still matches what
 * app-builder-lib's template produces. */
const UNINSTALLER_PATTERN = /^Uninstall .+\.exe$/;

export function evaluateGate(env: UpdaterEnv): GateResult {
  // Order matters. The dev gate runs first so that a stale/typo'd
  // GLADLOG_UPDATER_TEST_FEED in a developer shell can never throw during an
  // unpackaged run -- E2E inherits process.env (qa/support/launch.ts:30) and
  // would otherwise die at startup with a confusing error.
  //
  // Note what this gate is NOT for (2026-08-03 verification round corrected
  // the spec here): it is not about preventing a throw. When unpackaged,
  // electron-updater already no-ops on its own -- isUpdaterActive()
  // (AppUpdater.js:277-283) logs one info line and returns false, so
  // checkForUpdates() just resolves null (AppUpdater.js:253-256) and never
  // touches app-update.yml. We short-circuit earlier only so the state
  // machine can report reason: "dev" instead of sitting in "idle".
  if (!env.isPackaged) return { ok: false, reason: "dev" };
  if (env.testFeed !== undefined) {
    // Same rule as e2eEnv.ts: set-but-invalid throws instead of falling back.
    // Falling back to the production feed would make the dummy-release test
    // look like it passed while verifying nothing.
    if (!TEST_FEED_PATTERN.test(env.testFeed)) {
      throw new Error(
        `GLADLOG_UPDATER_TEST_FEED 需要 <owner>/<repo> 形式,收到:${env.testFeed}`,
      );
    }
    const [owner, repo] = env.testFeed.split("/");
    return { ok: true, feed: { owner, repo } };
  }
  // mac is excluded on purpose: build/afterSign.cjs signs ad-hoc, and
  // Squirrel.Mac requires the update to match the running app's designated
  // requirement, which an ad-hoc identity can never satisfy.
  if (env.platform !== "win32") return { ok: false, reason: "platform" };
  let entries: string[];
  try {
    entries = env.readDir(env.execDir);
  } catch {
    // Unreadable install directory: fall to the safe side and do not update.
    return { ok: false, reason: "portable" };
  }
  if (!entries.some((name) => UNINSTALLER_PATTERN.test(name))) {
    return { ok: false, reason: "portable" };
  }
  return { ok: true, feed: null };
}
