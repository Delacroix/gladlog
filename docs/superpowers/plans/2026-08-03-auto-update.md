# gladlog desktop Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Windows NSIS installer users to automatically install the new version when quitting the app, so it is updated to the latest version on next launch.

**Architecture:** On the release side, add `publish` configuration and a space-free NSIS `artifactName` to electron-builder, so the build produces `latest.yml` and bundles `app-update.yml` into artifact resources — the client relies on this to know where to check for updates. On the client side, add `packages/desktop/src/main/updater.ts`, wrapping electron-updater via dependency injection: triple activation gate (win32 / packaged / has NSIS uninstaller) + six-phase state machine + installation chain reusing `quitLifecycle.shutdown()`, making the entire module testable in vitest outside electron. The renderer side consumes the update surface and the "post-update trace" predicate solely through `renderer/src/update/updateBridge.ts`; visible UI consists of only two places: the top bar banner and the Settings page "About" section.

**Tech Stack:** electron-updater 6.8.9 (GitHub provider, public repo token-free) · electron-builder / app-builder-lib 26.15.3 (NSIS target) · electron-log · Electron + React 19 + TypeScript · vitest 2.1.9 · Playwright (visual baselines generated in CI)

## Global Constraints

**Working directory is fixed to the worktree root `/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update`. All commands below run from here; do not cd to the main checkout `/Users/mingjianliu/code/gladlog`.**

The following 10 items are the rulings for this plan. Any mention of "Global Ruling N" in the text refers to item N here:

1. **Use dots instead of hyphens in installer names.** `build.nsis.artifactName` is strictly equal to `"${productName}.Setup.${version}.${ext}"`, producing `gladlog.Setup.0.1.20.exe` — byte-for-byte identical to the **asset name** of every historical release, so **not a single character of the user-visible download name or download URL needs to change**. The only things that become obsolete are three documentation lines mentioning the **local** `dist-app/` artifact name (with spaces), synchronized by Task 1 Step 6.
2. **Full test baseline is `136 files / 938 tests passed`** (verified in this worktree on 2026-08-02, re-verified on 08-03 with identical count); all "N + delta" are calculated from here. Before running, always take the live output of `npm test --workspace=packages/desktop 2>&1 | tail -5` as the ground truth.
3. **The sole implementation of `install()` is in Task 4.** Task 5 provides deltas on top of it (installing even if shutdown throws + installer watchdog). Do not rebuild harnesses, and do not rewrite `install()`.
4. **The sole timer implementation is in `updater.ts` (Task 4).** `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` are single-sourced in this module, with the service having built-in `setTimeout` / `setInterval`; Task 6 wiring only calls `dispose()`, and must not re-declare these two constants or build a second set of timers.
5. **`testFeed` passes through `process.env["GLADLOG_UPDATER_TEST_FEED"]` directly, without `GLADLOG_E2E` checks.** The gate evaluation order places `!isPackaged → dev` before testFeed validation, so dev / E2E naturally never reaches validation; zeroing it out at wiring would break §6.2 dummy release verification.
6. **`fixtureBridge.ts` does not add an `update` surface.** No update-related UI is rendered under fixture preview and visual baseline runs; pixel criteria in Task 7 / Task 8 directly rely on this.
7. **The sole implementation of §4.7 "post-update trace" logic is in `renderer/src/update/updateBridge.ts` (Task 6).** UpdateBanner (Task 7) and SettingsPanel (Task 8) must both import it, and must not inline duplicate comparison logic in components.
8. **`autoUpdater.logger = log` (electron-log) must actually be written**, located in Task 6's `initUpdater`, after obtaining `autoUpdater` and before `createUpdaterService(`. Missing this line breaks the primary evidence channel for §6.2 end-to-end verification.
9. **Do not touch `docs/predicate-index.md`.** Auto-update does not produce lines that need registration in the predicate index (that index only accepts prefixes `analysis` / `eval` / `corpus-tools`). Forcing entries there would uselessly modify three files and fail eval consistency tests.
10. **Visual baseline regeneration follows the 4-step CI workflow; never run `npm run test:visual` locally** (which would pollute single-source baselines with macOS-rendered images): ① Run only `test:visual:smoke` locally to ensure no crashes → ② After pushing branch, run `gh workflow run visual-baseline.yml --ref <branch>` → ③ Download artifacts via `gh run download` for manual visual inspection → ④ Overwrite modified PNGs into `packages/desktop/qa/__screenshots__/` and commit.

Other general hard constraints across the plan:

- `electron-updater@6.8.9` must be in `packages/desktop/package.json` **`dependencies`** (not devDependencies), and must **not** be added to the `externalizeDepsPlugin` exclude list in `electron.vite.config.ts` — that list is reserved for `@gladlog/*` workspace packages (whose `main` points to TS source).
- **Triple activation gate**: `process.platform === "win32" && app.isPackaged && isNsisInstalled()`; `isNsisInstalled()` = existence of a file matching `/^Uninstall .+\.exe$/` under `dirname(process.execPath)` (pattern scanning, **not** hardcoded `"Uninstall gladlog.exe"`).
- **Code comments in English**; plan docs / commit messages / test case names in English.
- **Type checking always uses `npm run typecheck` (internally `tsc --noEmit`), never `tsc -b`** — which emits `.js` into `src/`, polluting the tree and shadowing `.ts`.
- **Pre-push checklist**: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet`. Lint must scan the entire repo from the root (`eslint .`); scanning only `packages/desktop/src` will miss `test/`, `qa/`, `dev/`, `scripts/` — this gap broke CI three times.
- **Run tests uniformly using** `npm test --workspace=packages/desktop -- <file-path>` (single file) / `npm test --workspace=packages/desktop` (full suite).
- **Two evaluations of the same fact must share the same function/constant**; if impossible, write unit tests asserting equality (CLAUDE.md top red line).
- **Claims of fixes must provide before-and-after numbers under the same criteria**; if unobtainable, state so honestly.
- The worktree must have **its own** `node_modules`, otherwise module resolution climbs to the main checkout (which is source code from another branch), causing false red typecheck; if missing, run `npm install` at the worktree root first.

---

## Task 1: Release-side Configuration + Configuration Gate Tests

Corresponds to the entire section §3 of the design spec (`docs/superpowers/specs/2026-08-02-auto-update-design.md:24-100`, where §3.2 "NSIS artifactName" was added in the 2026-08-03 review round).

**Why this Task is first**: No matter how correctly client code is written, if `latest.yml` is missing from the Release, or if the filename written in `latest.yml` does not match the asset name on the Release, all installed clients will silently fail update checks — no errors, no dialogs, and no one will notice. Release-side configuration is the foundation of the entire chain.

**Files:**

- Create: `packages/desktop/test/releaseConfig.test.ts`
- Modify: `packages/desktop/package.json`
  - `:23-34` dependencies (`electron-updater` is already at `:31`; this task confirms and commits it to the repository)
  - `:54-91` `build` field — add `publish` after `"appId"` at `:55`
  - `:86-90` `build.nsis` — add `artifactName`
- Modify: `.github/workflows/build.yml:50-54` (upload-artifact `path` glob)
- Modify: `.github/workflows/build.yml:60-63` (softprops release `files` glob)
- Delete: `packages/desktop/electron-builder.yml` (22 lines, dead config)
- Modify: `.claude/skills/release/SKILL.md:70-72` (asset verification checklist 4 → 7), `:59` (overwrite version warning)
- Modify: `docs/BUILD-WINDOWS.md:45` + `docs/BUILD-WINDOWS.zh-CN.md:44` (**bilingual pair, must modify together**) and `docs/commands/release-gladlog.md:48` — these three lines specify **local build artifact names**, which become obsolete after changing `artifactName` (Step 6)

**The user-visible download name does not change at all** (see conclusion of "Pitfall A" below): `gladlog.Setup.X.Y.Z.exe` is byte-for-byte identical to the asset name of every historical release, so `docs/setup-windows-claude-cli*.md` / `README*` / `docs/commands/release-gladlog.md:78` (download URL) remain untouched.
**The only things that change are the three lines of "local artifact names" above**: the filename in `dist-app/` actually changes from `gladlog Setup X.Y.Z.exe` to `gladlog.Setup.X.Y.Z.exe`.

**Interfaces:**

- Consumes: None (first Task of this plan).
- Produces:
  - `packages/desktop/package.json`'s `build.publish` is strictly equal to `{ "provider": "github", "owner": "mingjianliu", "repo": "gladlog" }` — `updater.ts` in subsequent Tasks does not read this, but electron-builder uses it to write `app-update.yml` into packaged resources, which the client runtime uses to find update feeds.
  - `build.nsis.artifactName` is strictly equal to `"${productName}.Setup.${version}.${ext}"`, and the NSIS installer filename looks like `gladlog.Setup.0.1.20.exe` (**no spaces**), byte-for-byte identical across three parties: `path` / `files[0].url` in `latest.yml`, and the asset name on the Release.
  - Both glob locations in `.github/workflows/build.yml` include `dist-app/*.yml` and `dist-app/*.blockmap`.

### Background: Two Pitfalls That Must Be Clarified First

**Pitfall A — NSIS artifact names must not contain spaces (critical; without this, all of §3 is wasted).**

Current chain: NSIS local artifact name is `gladlog Setup 0.1.19.exe` (contains spaces, originating from `installerFilenamePattern` in `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:100-104`, returning `"${productName} " + "Setup " + "${version}" + archSuffix + ".${ext}"`); `NsisTarget.js:303` calls `computeSafeArtifactNameIfNeeded(installerFilename, …)` → `platformPackager.js:690-703` judges "contains spaces = unsafe" → replaces spaces with hyphens → `safeArtifactName = gladlog-Setup-0.1.19.exe`; when provider is github, `updateInfoBuilder.js:100-107` writes this **hyphenated name** into `path` and `files[0].url` of `latest.yml`.

However, CI uses `softprops/action-gh-release` to upload local files directly, and GitHub normalizes spaces in filenames into **dots** — the actual asset names for v0.1.19 (verified via `gh release view v0.1.19 --json assets`) are:

```
gladlog-0.1.19-arm64-mac.zip
gladlog-0.1.19-arm64.dmg
gladlog-0.1.19-win.zip
gladlog.Setup.0.1.19.exe      ← dot, not hyphen
```

On the client side, `resolveFiles` in `electron-updater/out/providers/GitHubProvider.js:179-181` only does `p.replace(/ /g, "-")` (original comment "still replace space to - due to backward compatibility") and does nothing to a `path` that is already hyphenated, producing a download URL of `.../download/v0.1.20/gladlog-Setup-0.1.20.exe` — which does not match GitHub's `gladlog.Setup.0.1.20.exe`, resulting in a **404**. The same applies to `.blockmap` (its URL simply appends `.blockmap` to the exe URL).

Fix (adopted in this task): add to `build.nsis`:

```json
"artifactName": "${productName}.Setup.${version}.${ext}"
```

**Use dots, not hyphens.** `isSafeGithubName` is `/^[0-9A-Za-z._-]+$/` (`platformPackager.js:687-689`, verified from source code), and dots are legal characters — the local name `gladlog.Setup.0.1.20.exe` passes the safety check directly, `computeSafeArtifactNameIfNeeded` returns `null` at `:693-695` without any rewriting; GitHub also has no spaces to normalize. Local name = `path` in `latest.yml` = Release asset name, all three are byte-for-byte identical.

**Cost comparison between dot and hyphen**: Both approaches fix the 404, but the dot format is byte-for-byte identical to the asset name of every historical release — user bookmarks/direct links remain valid, and download names/URLs in README / setup docs require zero changes (only three documentation lines mentioning "local artifact names" need updating, see Step 6). The hyphen format would alter user-visible download names as well, paying unnecessary renaming costs. This decision was finalized on 2026-08-03 and spec §3.2 has been corrected accordingly.

The macOS side is unaffected: `gladlog-0.1.20-arm64.dmg` / `gladlog-0.1.20-arm64-mac.zip` already satisfy `/^[0-9A-Za-z._-]+$/`, so `computeSafeArtifactNameIfNeeded` returns `null` (verified). **This is precisely why macOS end-to-end tests would pass while Windows still hits 404** — subsequent dummy release verification cannot catch this pitfall, which must be guarded against by configuration and tests in this task.

**Pitfall B — Globs must never be written as `*.y*ml`.**

`node_modules/app-builder-lib/out/packager.js:298-300` writes a `builder-effective-config.yaml` to `dist-app/`, containing **local absolute paths** and full build configs. Precise context: that block is wrapped inside `if (!isCI && process.stdout.isTTY)` — when running on GitHub Actions, `isCI` is true, so this file **will not** be generated, meaning no leak is actively occurring in production. The actual attack surface is "someone manually uploading files from dist-app after running `npm run package:win` locally". The existing glob `packages/desktop/dist-app/*.yml` happens not to match `.yaml`; when adding the two new lines, strictly use `*.yml`. Writing `*.y*ml` for convenience would tear down this natural barrier. A guard test specifically monitors this.

### Steps

- [ ] **Step 1: Write guard test (should be red at this point)** — Create `packages/desktop/test/releaseConfig.test.ts` with verbatim content below (`describe`/`it`/`expect` do not need import: `globals: true` is configured in `packages/desktop/vitest.config.ts`, as done in `diagnosticLevel.test.ts` in the same directory):

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Release-side config gate for auto-update.
 *
 * None of the settings checked here have a runtime test that could catch a
 * regression: if `build.publish` disappears, or the NSIS artifact name gets a
 * space back, or the workflow stops uploading latest.yml, every installed
 * client keeps working normally and simply never finds an update again — no
 * crash, no error, nothing in any log we can see. The failure mode is
 * invisible in production, so this file is the only place it can be caught.
 *
 * Reads the real files off disk (same cross-file gate style as
 * diagnosticLevel.test.ts) instead of importing them, so what is checked is
 * the file that actually ships.
 */

const desktopDir = join(__dirname, "..");
const repoRoot = join(__dirname, "../../..");
const workflowPath = join(repoRoot, ".github/workflows/build.yml");

interface DesktopPackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    publish?: { provider?: string; owner?: string; repo?: string };
    nsis?: { artifactName?: string };
  };
}

function readPkg(): DesktopPackageJson {
  return JSON.parse(
    readFileSync(join(desktopDir, "package.json"), "utf-8"),
  ) as DesktopPackageJson;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Release-side config gate (foundation of auto-update)", () => {
  it("build.publish points to the official repository — without it there is no app-update.yml and clients won't know where to check", () => {
    expect(readPkg().build.publish).toEqual({
      provider: "github",
      owner: "mingjianliu",
      repo: "gladlog",
    });
  });

  it("NSIS artifactName has no spaces and passes isSafeGithubName — latest.yml path must be byte-for-byte identical to Release asset name", () => {
    const artifactName = readPkg().build.nsis?.artifactName ?? "";
    // Keep the pattern verbatim: electron-builder expands ${...} itself.
    expect(artifactName).toBe("${productName}.Setup.${version}.${ext}");
    expect(artifactName).not.toMatch(/\s/);
    // Same predicate as electron-builder's isSafeGithubName
    // (app-builder-lib/out/platformPackager.js:687-689). If the expanded name
    // fails it, computeSafeArtifactNameIfNeeded rewrites the name written into
    // latest.yml while the uploaded asset keeps another one → download 404.
    const expanded = artifactName
      .replace("${productName}", "gladlog")
      .replace("${version}", "0.1.20")
      .replace("${ext}", "exe");
    expect(expanded).toBe("gladlog.Setup.0.1.20.exe");
    expect(expanded).toMatch(/^[0-9A-Za-z._-]+$/);
  });

  it("electron-updater is in dependencies rather than devDependencies", () => {
    // What actually matters is which list it is in, not the exact patch level:
    // externalizeDepsPlugin externalizes `dependencies` only, and
    // electron-builder only ships `dependencies` into the packaged node_modules.
    // The major is still pinned — a 6→7 breaking change should go red.
    const pkg = readPkg();
    expect(pkg.dependencies["electron-updater"]).toMatch(/^\^6\./);
    expect(pkg.devDependencies["electron-updater"]).toBeUndefined();
  });

  it("Dead configuration electron-builder.yml has been deleted", () => {
    // package.json's `build` field wins; a stray electron-builder.yml is never
    // read, so anything written into it silently does nothing.
    expect(existsSync(join(desktopDir, "electron-builder.yml"))).toBe(false);
  });

  it("Both build.yml globs include latest.yml and .blockmap (one for upload-artifact + one for release)", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.yml"),
    ).toBeGreaterThanOrEqual(2);
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.blockmap"),
    ).toBeGreaterThanOrEqual(2);
  });

  it("build.yml must not use .yaml pattern globs — which would upload builder-effective-config.yaml containing local absolute paths to Releases", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(wf).not.toContain(".y*ml");
    expect(wf).not.toContain(".yaml");
  });
});
```

- [ ] **Step 2: Run test to confirm failure** — Run:
      `npm test --workspace=packages/desktop -- test/releaseConfig.test.ts`

      Expected: `Test Files 1 failed`, `Tests 4 failed | 2 passed (6)`. Specifically:
      - "build.publish points to official repo" → `AssertionError: expected undefined to deeply equal { provider: 'github', … }`
      - "NSIS artifactName has no spaces and passes isSafeGithubName" → `AssertionError: expected '' to be '${productName}.Setup.${version}.${ext}'` (`?? ""` fallback turns undefined to empty string to make subsequent `.replace` typed correctly; assertion fails immediately)
      - "Dead config electron-builder.yml has been deleted" → `AssertionError: expected true to be false`
      - "Both build.yml globs" → `AssertionError: expected +0 to be greater than or equal to 2`
      - Already passing: "electron-updater is in dependencies" (installed during review phase, see Step 3) and "must not use .yaml pattern globs" (status quo does not have it).

- [ ] **Step 3: Confirm electron-updater is installed and lock version (do not re-install)** — Run:

```bash
git diff HEAD -- packages/desktop/package.json
node -e "console.log(require('./node_modules/electron-updater/package.json').version)"
grep -n 'node_modules/electron-updater"' package-lock.json | head -3
```

      Expected: diff shows `packages/desktop/package.json` dependencies has added `"electron-updater": "^6.8.9",`; node prints `6.8.9`; package-lock.json contains `node_modules/electron-updater` entries. **Do not run `npm install` again**, and **do not** add `electron-updater` to the `exclude` list in `packages/desktop/electron.vite.config.ts:25-29` or `:59-63` — that list is only for `@gladlog/*` workspace packages (whose `main` points to TS source); externalizing normal npm packages to runtime `require` is expected behavior. `package-lock.json` is committed together with this task.

- [ ] **Step 4: Add publish configuration** — Edit `packages/desktop/package.json`, insert after `"appId"` in `"build": {` (i.e. after `:55`):

```json
    "publish": {
      "provider": "github",
      "owner": "mingjianliu",
      "repo": "gladlog"
    },
```

      After addition, the start of the `build` field looks like:

```json
  "build": {
    "appId": "com.gladlog.desktop",
    "publish": {
      "provider": "github",
      "owner": "mingjianliu",
      "repo": "gladlog"
    },
    "productName": "gladlog",
```

      This line serves two purposes: during build, it writes `latest.yml` (win) / `latest-mac.yml` (mac) + `.blockmap` into `dist-app/`; and writes `app-update.yml` into artifact resources (`resources/app-update.yml` on Windows, `<app>.app/Contents/Resources/app-update.yml` on macOS, see `onAfterPack` in `app-builder-lib/out/publish/PublishManager.js:75-91` (file written at `:89`) and `getResourcesDir` in `app-builder-lib/out/platformPackager.js:470-478`). The branch writing yml (`createUpdateInfoTasks` in `PublishManager.js:158-163`) is **outside** `if (this.isPublish)` (`:149-157`), so the existing workflow where "electron-builder only builds, and softprops handles upload" remains completely unchanged.

- [ ] **Step 5: Add NSIS artifactName** — Edit `build.nsis` in `packages/desktop/package.json` (previously at `:86-90`) to:

```json
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "artifactName": "${productName}.Setup.${version}.${ext}"
    }
```

      Reasoning detailed in "Pitfall A" above. Three notes:
      1. `${...}` is electron-builder's own template syntax and must be preserved verbatim in JSON, **do not** replace with real values (the guard test asserts this literal template).
      2. **Use dots, not hyphens** — this is the finalized decision, keeping artifact names byte-for-byte identical to historical releases.
      3. This template does not include `${arch}`. Currently Windows only builds x64 single architecture (package.json `:69-85`), avoiding name collisions; if win/arm64 is ever added, two architectures would produce identical exe names, in which case `${arch}` must be appended.

- [ ] **Step 6: Synchronize three documentation references to "local build artifact names"** — The previous step changed `artifactName`, so the exe name in **local** `dist-app/` changes from `gladlog Setup X.Y.Z.exe` (space) to `gladlog.Setup.X.Y.Z.exe` (dot). The user-visible **download name** does not change at all (GitHub has always normalized spaces to dots), but the following three lines specify **local artifact names / filenames in release notes templates**, which become obsolete if not updated. `docs/BUILD-WINDOWS.md` and `docs/BUILD-WINDOWS.zh-CN.md` are bilingual pair documents mandated by CLAUDE.md, **both versions must be updated together**.

      Verbatim replacements at three locations (line numbers verified on 2026-08-03). The first line of each group below is **before**, and the second line is **after**; fenced with `text` to preserve content as-is:

```text
docs/BUILD-WINDOWS.md:45
- `gladlog Setup 0.0.1.exe` — the installer.
- `gladlog.Setup.0.0.1.exe` — the installer.

docs/BUILD-WINDOWS.zh-CN.md:44
- `gladlog Setup 0.0.1.exe` — installer.
- `gladlog.Setup.0.0.1.exe` — installer.

docs/commands/release-gladlog.md:48
- \`gladlog Setup X.Y.Z.exe\` — installer. SmartScreen → **More info → Run anyway**.
- \`gladlog.Setup.X.Y.Z.exe\` — installer. SmartScreen → **More info → Run anyway**.
```

      The third location is inside the `gh release create --notes "..."` template where backticks are escaped as `\``; **preserve escaping** during replacement, only replacing the space with a dot.

      **Do not touch `docs/commands/release-gladlog.md:78`** — it specifies the download URL (`.../download/vX.Y.Z/gladlog.Setup.X.Y.Z.exe`), which was already in dot format and has always been correct.

      Self-check after editing (**must exclude `docs/superpowers/`**: this plan and spec both quote old space-containing names verbatim for "before" comparison, without which this self-check can never turn green):

```bash
grep -n "gladlog Setup" docs/BUILD-WINDOWS.md docs/BUILD-WINDOWS.zh-CN.md docs/commands/release-gladlog.md
grep -rn "gladlog Setup" docs/ README.md README.zh-CN.md | grep -v "^docs/superpowers/"
```

      Expected: both produce **no output** (verified on 2026-08-03: before changes, first command hit 3 lines, second hit the same 3 lines, with no other occurrences in the repo).

- [ ] **Step 7: Delete dead config file** — Run:
      `git rm packages/desktop/electron-builder.yml`

      Expected: `rm 'packages/desktop/electron-builder.yml'`.
      It is a dead file: electron-builder configuration parsing gives priority to the `build` field in `package.json`, and ignores the yml in the same directory when present. Evidence: yml specified `win: target: nsis` (nsis only), while actual releases produced `gladlog-0.1.19-win.zip` — which came from the zip target in package.json. No code/CI references it across the entire repo; the only references are in three historical plan documents (`docs/plans/2026-07-27-obs-recording-integration-eval.md:53`/`:88` had already listed deleting it as a prerequisite, along with `2026-07-12-sp-b2-compare-subsystem.md` and `2026-07-10-desktop-shell.md`) — historical documents, **do not edit**.

- [ ] **Step 8: Update both globs in build.yml** — Edit `.github/workflows/build.yml`.
      First location (upload-artifact, previously `:50-54`). **Indentation must match the original**: `path: |` has 10 spaces, entries have 12 spaces (verified on 2026-08-03 `:50-54`) — the two code blocks below use the exact indentation and can be replaced directly (fenced with `text` instead of `yaml` to prevent editor/formatter auto-normalization):

```text
          path: |
            packages/desktop/dist-app/*.exe
            packages/desktop/dist-app/*.dmg
            packages/desktop/dist-app/*.zip
            packages/desktop/dist-app/*.yml
            packages/desktop/dist-app/*.blockmap
          if-no-files-found: ignore
```

      Second location (softprops release, previously `:60-63`), `files: |` likewise has 10 spaces, entries 12 spaces:

```text
          files: |
            packages/desktop/dist-app/*.exe
            packages/desktop/dist-app/*.dmg
            packages/desktop/dist-app/*.zip
            packages/desktop/dist-app/*.yml
            packages/desktop/dist-app/*.blockmap
```

      **Strictly use `*.yml`, do not write `*.y*ml`** (reasoning in "Pitfall B" above).

      Self-check after editing (no repo gate catches YAML indentation errors — Step 1 guard test only does `toContain` string matching, passing even with skewed indentation until CI actually runs the workflow):

```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/build.yml','utf8'));console.log('YAML_OK')"
```

      Expected: `YAML_OK` (verified in this worktree on 2026-08-03).
      **Must run from worktree root** — relative paths in `node -e` and module resolution for `require('js-yaml')` are relative to cwd. `js-yaml` is brought in by `app-builder-lib` and hoisted to `node_modules/js-yaml` at the worktree root (verified present), requiring no extra installation.
      **Do not use `python3 -c "import yaml…"`**: local python3 does not have PyYAML installed (`ModuleNotFoundError: No module named 'yaml'`, exit code 1), so that command will never print `YAML_OK`, only giving a traceback unrelated to build.yml.

- [ ] **Step 9: Run tests to confirm green** — Run:
      `npm test --workspace=packages/desktop -- test/releaseConfig.test.ts`

      Expected: `Test Files 1 passed (1)` / `Tests 6 passed (6)`.

- [ ] **Step 10: Update release skill — asset checklist 4 → 7** — Edit `.claude/skills/release/SKILL.md`, replacing `:70-72`:

```
Must see 4 assets: `gladlog.Setup.0.0.X.exe`, `gladlog-0.0.X-win.zip`,
`gladlog-0.0.X-arm64.dmg`, `gladlog-0.0.X-arm64-mac.zip`. Missing = build failed
on some platform; check with `gh run view $RUN --log-failed`.
```

      Replace with the block below. **Note fence nesting**: the replacement text contains a bash code block (triple backticks), so **four backticks** wrap the entire block below; when pasting into SKILL.md, paste only the content between the four backticks, omitting the four backtick lines themselves.

````
Must see the following 7 assets, verified character-by-character:

- `gladlog.Setup.0.0.X.exe` — installer
- `gladlog.Setup.0.0.X.exe.blockmap` — for differential downloads
- `gladlog-0.0.X-win.zip` — portable version
- `latest.yml` — **lifeblood of auto-update**; missing upload causes all Windows clients to silently fail update checks
- `gladlog-0.0.X-arm64.dmg`
- `gladlog-0.0.X-arm64-mac.zip`
- `latest-mac.yml` — macOS equivalent; auto-update is not currently enabled on macOS, kept for future code signing purchase

Missing = build failed on some platform; check with `gh run view $RUN --log-failed`.
Additionally, macOS side `*-arm64.dmg.blockmap` / `*-arm64-mac.zip.blockmap` will be included;
presence or absence does not matter (macOS does not use auto-update), not treated as a hard gate.

**Add one more name consistency check** (exposes issues earlier than sha512 comparison):

```bash
gh release download v0.0.X -p latest.yml -D /tmp/relcheck --clobber
grep -E '^\s*(path|url):' /tmp/relcheck/latest.yml
gh release view v0.0.X --json assets -q '.assets[].name'
```

`path` / `files[].url` in `latest.yml` must match asset names in the asset list **character-by-character**.
A mismatch causes a 404: the client reads latest.yml, computes the new version, and then fails to download, while everything appears completely normal on the Release page.
````

      Expected (self-check after editing):
      `grep -c 'latest.yml' .claude/skills/release/SKILL.md` ≥ 2.

- [ ] **Step 11: Update release skill — upgrade overwrite version warning to hard rule** — Edit `.claude/skills/release/SKILL.md:59`, replacing:

```
Remind user: users who downloaded old packages have binaries with same version but different content; default should be +1.
```

      Replace with:

```
**Hard rule: unless user explicitly states "overwrite N", always use +1, never overwrite.** Starting with 0.1.20, clients include auto-update, and update criteria rely on version numbers — after overwriting vN, machines with vN already installed have the same version number and will never receive this fix; users have old content while believing they are on the latest version, with zero prompt. Before overwriting, user must be informed of this consequence and explicit confirmation obtained.
```

      Note: `.claude/**` is in ignores in `eslint.config.js:20`; editing SKILL.md **does not pass through lint** — eslint passing green in Step 12 does not prove these two edits are correct; perform a visual review.

- [ ] **Step 12: Full gate validation** — Run (all three must be green):

```bash
npm test --workspace=packages/desktop
npm run typecheck
npx eslint . --quiet
```

      Expected: vitest `Test Files 137 passed` / `Tests 944 passed` (baseline 136/938 + 1 file 6 tests in this task); typecheck exit code 0, `error TS` count 0 in log (all six workspaces: corpus-tools / desktop / eval / log-pipeline / parser / parser-compat green); eslint has no output.
      Note eslint must scan the whole repo (`eslint .`); scanning only `packages/desktop/src` will miss `test/`, `qa/`, `dev/`, `scripts/` — this broke CI three times.

- [ ] **Step 13: Commit** — Run:

```bash
git add packages/desktop/package.json package-lock.json \
  packages/desktop/test/releaseConfig.test.ts \
  .github/workflows/build.yml \
  .claude/skills/release/SKILL.md \
  docs/BUILD-WINDOWS.md docs/BUILD-WINDOWS.zh-CN.md \
  docs/commands/release-gladlog.md
git rm --cached packages/desktop/electron-builder.yml 2>/dev/null || true
git status --short
git commit -m "feat(desktop): release-side auto-update — publish config + latest.yml/blockmap upload + NSIS artifactName space removal

Adding build.publish to electron-builder generates latest.yml at build time
and bundles app-update.yml into artifact resources — the prerequisite for
clients checking updates.

build.nsis.artifactName fixed to \${productName}.Setup.\${version}.\${ext}:
default artifact names contain spaces, electron-builder replaces spaces with
hyphens in latest.yml, while GitHub upload normalizes spaces to dots, causing
404 on download URLs. With dots, local name / latest.yml path / Release asset
name are byte-for-byte consistent across all three, and identical to historical
release asset names — user-facing download names remain completely unchanged.
Local artifact names do change (spaces → dots); BUILD-WINDOWS bilingual pair
and release-gladlog release notes template (3 lines total) are synchronized.

Both globs in build.yml add *.yml and *.blockmap; strictly *.yml instead of
*.y*ml, which would upload builder-effective-config.yaml containing local
absolute paths to Releases.

Delete packages/desktop/electron-builder.yml: package.json build field takes
precedence; it never took effect (yml only had nsis, but zip was produced).

Add test/releaseConfig.test.ts guarding all above: misconfigurations do not
crash or throw errors, only causing silent check failures on all clients;
unit tests are the only place catching them."
```

      Expected: `git status --short` shows `packages/desktop/electron-builder.yml` as `D`, remainder as `M` / `A`; commit succeeds.

### Known Boundaries (written into plan rather than comments)

- **User-visible download name does not change at all; what changes is local artifact name**: GitHub has always normalized spaces in asset names to dots; Windows assets for every historical release have been named `gladlog.Setup.X.Y.Z.exe`, so bookmarks / direct links / README download instructions are unaffected. **What changes is the filename in local `dist-app/`** (`gladlog Setup 0.0.1.exe` → `gladlog.Setup.0.0.1.exe`), and three lines referencing old local names are synchronized in Step 6 (`docs/BUILD-WINDOWS.md:45` / `docs/BUILD-WINDOWS.zh-CN.md:44` / `docs/commands/release-gladlog.md:48`). `docs/commands/release-gladlog.md:78` is a download URL and was already in dot format, **untouched**.
- **Consistency between `path` in `latest.yml` and Release asset name cannot be verified locally** — requires a real CI Windows build. This is written as a release skill verification command in Step 10, executed during the 0.1.20 release.
- **`builder-effective-config.yaml` is not currently leaking in production** (`!isCI && process.stdout.isTTY` in `packager.js:298` prevents it); the strict `*.yml` syntax guards against manual uploads from local dist-app. Do not treat that guard test item as "fixing an active online vulnerability".

### Task Verification Criteria (honest disclosure)

- Measurable numbers: 6 guard test cases, before changes 4 red 2 green → after changes 6 green; full suite `136 files / 938 tests` → `137 files / 944 tests`.
- **Unobtainable numbers**: "latest.yml path is byte-for-byte identical to Release asset name" relies solely on source code deduction prior to the real 0.1.20 release (`isSafeGithubName` accepts dots → `computeSafeArtifactNameIfNeeded` returns null at `platformPackager.js:693-695` → rewrite branch in `updateInfoBuilder.js:100-107` not entered), **not considered live verification**.

---

## Task 2: Extract shutdown() from quitLifecycle

Corresponds to the quitLifecycle portion of design spec §4.3 (`docs/superpowers/specs/2026-08-02-auto-update-design.md` §4.3).

**Why it is needed**: Internally, `autoUpdater.quitAndInstall()` "first spawns the NSIS installer (detached, unref), then calls `setImmediate(() => app.quit())`" (`node_modules/electron-updater/out/BaseUpdater.js:13-27` → `NsisUpdater.js:101-148` → `spawnLog` in `BaseUpdater.js:129-141`, `detached: true` at `:133` + `p.unref()` at `:138`). Meanwhile, `quitLifecycle`'s initial `before-quit` intercepts with `preventDefault()` to stop OBS recording (capped at 4s), stop workers, and reap AI subprocesses.

The consequence of calling `quitAndInstall()` directly: the installer is already running outside while recording cleanup is still running inside, with no guaranteed execution order — at best leaving a corrupted/incomplete recording file, at worst causing installer timeouts or forced process termination.

The fix is to maintain a **single** cleanup chain, chaining `quitAndInstall` at the end:

```ts
await quitLifecycle.shutdown(); // Stop recording/workers/AI, reusing existing chain
autoUpdater.quitAndInstall(true, true); // Spawn installer only after cleanup is complete
```

When the internal `app.quit()` inside `quitAndInstall` triggers `before-quit` again, the phase is already `finishing`, so `quitLifecycle` lets it straight through — naturally connecting the two chains without extra state flags.

This is the application of CLAUDE.md's rule "one predicate exported once, imported on both sides" to the quit flow: **one cleanup logic, two entry points, never duplicate**. That is the sole guarantee this task must provide.

**Files:**

- Modify: `packages/desktop/src/main/quitLifecycle.ts`
  - `:46-51` `QuitLifecycleHandler` interface — add `shutdown()`
  - `:60-90` `finish()` — split into `cleanup()` + `finish()`
  - `:92-104` return object — add `shutdown` member
- Modify (Test): `packages/desktop/src/main/quitLifecycle.test.ts`
  — append 5 tests after the final `it(...)` closing `});` (`:178`) and before the `describe` closing `});` (`:179`) (line numbers verified)

**Interfaces:**

- Consumes: `createQuitLifecycleHandler(deps: QuitLifecycleDeps): QuitLifecycleHandler` (existing, signature unchanged); `QuitLifecycleDeps = { stopRecorder: () => Promise<void>; stopHost: () => void; quit: () => void; stopAiActivity?: () => void; timeoutMs?: number }`.
- Produces:

```ts
export interface QuitLifecycleHandler {
  onBeforeQuit(event: { preventDefault(): void }): void;
  waitForIdle(): Promise<void>;
  /** Runs cleanup chain and sets phase to "finishing", but does NOT call deps.quit().
   *  Repeated calls are non-reentrant, returning the same in-flight Promise. */
  shutdown(): Promise<void>;
}
```

**Task 4's `updater.ts`** injects it via `UpdaterDeps.shutdown: () => Promise<void>`; the sole implementation of `install()` is also in Task 4 (Task 5 only adds two increments on top of it).

**Hard constraint: Existing `onBeforeQuit` semantics and existing 9 test cases must not change by a single character.**
Changes in this task are only permitted to "split function + add one exit point", with no modifications to existing behavior.

### Steps

- [ ] **Step 1: Read existing test stubbing style first** — Run:
      `sed -n '1,60p' packages/desktop/src/main/quitLifecycle.test.ts`

      Expected: observe the `fakeEvent()` factory at the top of the file (returning an object with `preventDefault` and a read-only `prevented` getter), and in each `it`, using `createQuitLifecycleHandler({ stopRecorder, stopHost, quit, timeoutMs: 5000 })` + a `calls: string[]` array tracking call order. **New tests must follow this style verbatim**: same `fakeEvent()`, same `calls` array, asserting order via `toEqual` rather than merely "all were called".

- [ ] **Step 2: Append 5 failing tests** — Edit `packages/desktop/src/main/quitLifecycle.test.ts`, after the closing `});` (`:178`) of the last test `it("stopAiActivity does not participate in timeoutMs cap race…")` and before `describe`'s `});` (`:179`), insert:

```ts
it("shutdown(): runs cleanup chain (stopAiActivity + stopRecorder + stopHost) without calling quit", async () => {
  const calls: string[] = [];
  const handler = createQuitLifecycleHandler({
    stopRecorder: async () => {
      calls.push("recorder-stop");
    },
    stopHost: () => calls.push("host-stop"),
    stopAiActivity: () => calls.push("stop-ai"),
    quit: () => calls.push("quit"),
    timeoutMs: 5000,
  });

  await handler.shutdown();
  // The whole cleanup chain ran, in the same order as the before-quit path…
  expect(calls).toEqual(["stop-ai", "recorder-stop", "host-stop"]);
  // …but the quit itself belongs to the caller: autoUpdater.quitAndInstall()
  // spawns the installer and quits by itself right after this resolves.
  expect(calls).not.toContain("quit");
});

it("shutdown() repeated calls are non-reentrant: cleanup chain runs only once, returning the same in-flight Promise", async () => {
  const calls: string[] = [];
  let resolveStop!: () => void;
  const handler = createQuitLifecycleHandler({
    stopRecorder: () =>
      new Promise<void>((res) => {
        calls.push("recorder-stop-start");
        resolveStop = res;
      }),
    stopHost: () => calls.push("host-stop"),
    quit: () => calls.push("quit"),
    timeoutMs: 5000,
  });

  const p1 = handler.shutdown();
  const p2 = handler.shutdown();
  expect(p2).toBe(p1); // same in-flight promise, not a second chain
  expect(calls).toEqual(["recorder-stop-start"]);

  resolveStop();
  await p1;
  expect(calls).toEqual(["recorder-stop-start", "host-stop"]);

  // A call after it settled must not re-run the chain either
  await handler.shutdown();
  expect(calls).toEqual(["recorder-stop-start", "host-stop"]);
});

it("after shutdown(), subsequent before-quit: phase is already finishing, lets through directly without preventDefault", async () => {
  const handler = createQuitLifecycleHandler({
    stopRecorder: () => Promise.resolve(),
    stopHost: () => {},
    quit: () => {},
    timeoutMs: 5000,
  });

  await handler.shutdown();
  // This is the before-quit that quitAndInstall's own app.quit() triggers:
  // cleanup is already done, so it must go straight through.
  const e = fakeEvent();
  handler.onBeforeQuit(e);
  expect(e.prevented).toBe(false);
});

it("before-quit arriving while shutdown() is in progress remains suspended, without starting a second cleanup chain", async () => {
  const calls: string[] = [];
  let resolveStop!: () => void;
  const handler = createQuitLifecycleHandler({
    stopRecorder: () =>
      new Promise<void>((res) => {
        calls.push("recorder-stop-start");
        resolveStop = res;
      }),
    stopHost: () => calls.push("host-stop"),
    quit: () => calls.push("quit"),
    timeoutMs: 5000,
  });

  const p = handler.shutdown();
  const e = fakeEvent();
  handler.onBeforeQuit(e);
  expect(e.prevented).toBe(true); // cleanup not done — the quit cannot pass
  expect(calls).toEqual(["recorder-stop-start"]); // no re-entry

  resolveStop();
  await p;
  expect(calls).toEqual(["recorder-stop-start", "host-stop"]);
});

it("when before-quit precedes shutdown(), shutdown() reuses the same chain without re-running cleanup (that chain quits normally)", async () => {
  const calls: string[] = [];
  let resolveStop!: () => void;
  const handler = createQuitLifecycleHandler({
    stopRecorder: () =>
      new Promise<void>((res) => {
        calls.push("recorder-stop-start");
        resolveStop = res;
      }),
    stopHost: () => calls.push("host-stop"),
    quit: () => calls.push("quit"),
    timeoutMs: 5000,
  });

  handler.onBeforeQuit(fakeEvent());
  const p = handler.shutdown(); // joins the chain already in flight
  expect(calls).toEqual(["recorder-stop-start"]);

  resolveStop();
  await p;
  // The chain was started by before-quit, so it owns the quit and calls it
  expect(calls).toEqual(["recorder-stop-start", "host-stop", "quit"]);
});
```

- [ ] **Step 3: Run test to confirm failures** — Run:
      `npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts`

      Expected: `Test Files 1 failed (1)` / `Tests 5 failed | 9 passed (14)`, all 5 new test cases fail with `TypeError: handler.shutdown is not a function`. The existing 9 tests must **all pass** — if any fails, the tests were inserted at the wrong position, fix before proceeding.

- [ ] **Step 4: Split finish() into cleanup() + finish()** — Edit `packages/desktop/src/main/quitLifecycle.ts`, replacing the entire `finish` function at `:60-90` with the two functions below (note `phase = "finishing"` remains in `cleanup()`, and `deps.quit()` moves into `finish()`):

```ts
/** The cleanup chain itself, and the ONLY copy of it. Two entry points reach
 * it — before-quit (which owns the quit that follows) and shutdown() (whose
 * caller, the auto-updater, quits by itself after spawning the installer).
 * Copying this chain into the updater is exactly the "one predicate, two
 * importers" rule this repo bans breaking: a second copy would drift and one
 * of the two quit paths would stop stopping the OBS recording. */
async function cleanup(): Promise<void> {
  // Fire-and-forget, same best-effort shape as stopHost: not part of the
  // timeoutMs race below (a synchronous call has no async tail to await),
  // and a failure must not hold up the quit flow.
  try {
    deps.stopAiActivity?.();
  } catch {
    // Best effort: the quit flow must not stall on an error here.
  }
  const timeoutMs = deps.timeoutMs ?? 4000;
  await Promise.race([
    deps.stopRecorder().catch(() => {
      /* Best effort: the quit flow must not stall on an OBS error */
    }),
    new Promise<void>((res) => setTimeout(res, timeoutMs)),
  ]);
  try {
    deps.stopHost();
  } catch {
    // Caught by a review round: stopHost is a synchronous call and, unlike
    // stopRecorder, has no .catch backstop — a synchronous throw would reject
    // cleanup() outright, with no production caller to catch it, turning into
    // an unhandled rejection AND meaning quit() below is never called (a quit
    // flow worse than before the fix). Best effort, never holds up quit.
  }
  // Flip to finishing BEFORE anyone calls quit(): quit() often synchronously
  // triggers the next before-quit (electron's app.quit() does, and so does
  // autoUpdater.quitAndInstall's internal one), so the pass must already be
  // allowed through by then.
  phase = "finishing";
}

async function finish(): Promise<void> {
  await cleanup();
  deps.quit();
}
```

- [ ] **Step 5: Add shutdown() to interface** — Edit `packages/desktop/src/main/quitLifecycle.ts:46-51`, replacing `QuitLifecycleHandler` with:

```ts
export interface QuitLifecycleHandler {
  /** Wire up as `app.on("before-quit", (e) => handler.onBeforeQuit(e))`. */
  onBeforeQuit(event: { preventDefault(): void }): void;
  /** Test-only: await the cleanup chain (production code need not call it). */
  waitForIdle(): Promise<void>;
  /**
   * Run the cleanup chain and flip the phase to "finishing", but do NOT call
   * deps.quit(). The auto-updater awaits this before calling
   * autoUpdater.quitAndInstall(), which spawns the NSIS installer detached and
   * then quits on its own — the installer must not start while the OBS
   * recording is still being stopped, and there must never be a second copy of
   * the cleanup chain.
   *
   * Non-reentrant: repeated calls return the same in-flight promise and never
   * start a second chain. Once it resolves the phase is "finishing", so the
   * before-quit that quitAndInstall's internal app.quit() triggers is let
   * straight through.
   */
  shutdown(): Promise<void>;
}
```

- [ ] **Step 6: Add shutdown member to returned object** — Edit the return object in `packages/desktop/src/main/quitLifecycle.ts` (previously `:92-104`), after the `waitForIdle` line add:

```ts
    shutdown() {
      if (phase === "idle") {
        phase = "stopping";
        inFlight = cleanup();
      }
      // phase "stopping": a chain is already in flight — possibly the one
      // before-quit started, which will also call quit(). That is fine: a quit
      // is already underway, and joining it is strictly better than running a
      // second chain.
      // phase "finishing": already finished; the settled promise is returned so
      // callers can await unconditionally.
      return inFlight ?? Promise.resolve();
    },
```

      After editing, the returned object looks like:

```ts
return {
  onBeforeQuit(event) {
    if (phase === "finishing") return; // cleanup done: real quit, allow it
    event.preventDefault();
    if (phase === "idle") {
      phase = "stopping";
      inFlight = finish();
    }
    // phase === "stopping": cleanup still running — block this redundant
    // quit request, no re-entry
  },
  waitForIdle: () => inFlight ?? Promise.resolve(),
  shutdown() {
    /* …as above… */
  },
};
```

- [ ] **Step 7: Run tests to confirm green** — Run:
      `npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts`

      Expected: `Test Files 1 passed (1)` / `Tests 14 passed (14)` — existing 9 + new 5. If any of the existing 9 fails, splitting the function changed semantics; revert Step 4 and redo, **do not modify existing tests to accommodate the implementation**.

- [ ] **Step 8: Full gate validation** — Run (all three must be green):

```bash
npm test --workspace=packages/desktop
npm run typecheck
npx eslint . --quiet
```

      Expected: vitest `Test Files 137 passed` / `Tests 949 passed` (137/944 at end of Task 1 + 5 in this task, no new files); typecheck exit code 0; eslint has no output.

- [ ] **Step 9: Commit** — Run:

```bash
git add packages/desktop/src/main/quitLifecycle.ts \
  packages/desktop/src/main/quitLifecycle.test.ts
git commit -m "refactor(desktop): extract shutdown() from quitLifecycle — single cleanup chain, two entry points

Internally autoUpdater.quitAndInstall() spawns the NSIS installer (detached)
and then calls app.quit(). Invoking it directly means the installer runs
outside while recording cleanup is still executing inside, with indeterminate
order — risking recording truncation or installer termination.

Split finish() into cleanup() + quit(): expose shutdown(), running the cleanup
chain and flipping phase to finishing without calling deps.quit(). Update
installation follows await shutdown() → quitAndInstall(); when the internal
app.quit() triggers before-quit, phase is already finishing and let straight
through, seamlessly connecting both chains.

Cleanup logic remains single-sourced: before-quit and shutdown() share the same
cleanup(), avoiding a second copy in updater (CLAUDE.md single-source rule).

Existing onBeforeQuit semantics and 9 tests untouched; added 5 tests covering
no quit called / non-reentrancy (returning same Promise) / subsequent
before-quit pass-through / in-progress before-quit suspension / before-quit
precedence reusing the same chain."
```

### Known Boundaries (written into plan rather than comments)

- **`before-quit` arriving during shutdown() is permanently swallowed once**: intercepted by `preventDefault()`, while `cleanup()` does not call `quit()` itself. This is harmless in actual invocation sequences — the next step in `install()` is `quitAndInstall()`, and cleanup is guaranteed to quit within 4s max; but if anyone calls `shutdown()` alone without subsequent quit in the future, the app will stay in a "features stopped but window still open" state. **The only legal caller is Task 4's `install()`, and must immediately follow with a quit.**
- **`quitAndInstall()` has a failure branch that does not quit**: in `BaseUpdater.js:16-25`, when `install()` returns `false`, it only resets `quitAndInstallCalled` and **does not call `app.quit()`**. At that point, `shutdown()` has already stopped recording, stopped workers, and killed AI subprocesses, with phase already `finishing` — the app is alive but entirely defunct, and subsequent `before-quit` would be let straight through without cleanup by `if (phase === "finishing") return`. **This branch is guarded by the installation watchdog in Task 4/5 `install()`**: if the process is still alive 10s after `quitAndInstall()` → transitions to `error` state and prompts the user to quit and relaunch manually. Deliberately **not** calling `app.quit()` here or in updater: updater does not hold a quit dependency, and opening a second quit path bypassing `quitLifecycle` is worse than leaving a visible error state. This task does not implement it, but **do not** add new dependencies to `QuitLifecycleDeps` because of this boundary.
- **The second argument of `quitAndInstall(true, true)` depends on the first**: `BaseUpdater.js:16` is `this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)` — only when `isSilent === true` is the second `true` (auto relaunch after install) honored. If someone changes the first argument to `false` in the future, the second argument is overridden by `autoRunAppAfterInstall`, **silently failing**.
- **The fallback of `autoInstallOnAppQuit = true` does not conflict with this task, but not because "phase is already finishing"**: `addQuitHandler()` in `BaseUpdater.js:69-89` listens to `app.onQuit(...)` (Electron's `quit` event, emitted **after** `before-quit` / `will-quit`), at which point the cleanup chain has long finished. Another easily overlooked shortcut: `if (exitCode !== 0) return` at `:83-86` — non-zero exit codes will not auto-install.
- **On macOS `quitAndInstall()` is a completely different implementation**: `quitAndInstall()` in `MacUpdater.js:240` **takes no arguments**, delegating to `this.nativeUpdater.quitAndInstall()` (`:233`, in `handleUpdateDownloaded()`) rather than spawn + `app.quit()`. Therefore, behaviors observed on macOS **cannot** serve as verification evidence for the design in this task where "installer starts after cleanup chain".

### Task Verification Criteria

- Before: `npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts` → 9 passed.
- Middle (Step 3): 9 passed / 5 failed (`handler.shutdown is not a function`).
- After (Step 7): 14 passed / 0 failed; full suite `137 files / 944 tests` → `137 files / 949 tests`.
- **Unobtainable numbers**: Actual exit sequence (installer vs OBS recording stop) can only be verified on a real Windows machine, running neither locally nor in CI. Source code justification is that `install()` in `BaseUpdater.js:13-27` precedes `setImmediate(app.quit())`, which is deduction rather than live measurement.

---

## Task 3: Add `autoCheckUpdates` / `lastSeenVersion` to settingsStore

Corresponds to the persistence portion of spec §4.6 (settings page switch) and §4.7 (post-update trace). Both fields are pure data and do not involve Electron.

**Files:**

- Modify: `packages/desktop/src/main/settingsStore.ts` (append to end of `GladlogSettings` interface `:15-43`; append two lines to `DEFAULTS` `:44-57`)
- Modify: `packages/desktop/test/settingsStore.test.ts` (update **both** full literal sites: default values snapshot assertion at `:16-29`, `base` object in `redactSettings` test at `:69-82`; also insert three new tests before `:45`)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts` (append two lines to full `GladlogSettings` literal at `:34-47`)

**Interfaces:**

- Consumes: None (this task does not depend on prior tasks)
- Produces:
  - `GladlogSettings.autoCheckUpdates: boolean`, `true` in `DEFAULTS`
  - `GladlogSettings.lastSeenVersion: string | null`, `null` in `DEFAULTS`
  - Subsequent tasks consume them as follows: updater wiring (Task 6) `isAutoCheckEnabled: () => settings.get().autoCheckUpdates`; Settings page "Auto Check for Updates" toggle `save({ autoCheckUpdates })`; **§4.7 trace comparison and write-back logic is single-sourced**, living in `src/renderer/src/update/updateBridge.ts` (`resolveVersionNotice` / `dismissVersionNotice`) in Task 6. UpdateBanner in Task 7 and SettingsPanel in Task 8 must both import it, and **must not inline duplicate `getVersion()` vs `lastSeenVersion` comparison in components**.

**Three things that do NOT need to be done (clarified up front to prevent confusion):**

1. `sanitizeSettingsPatch` (settingsStore.ts:98-143) **does not need modification**. It is a blacklist-style sanitizer: it only strips sentinel write-backs for `anthropicApiKey` / `obsWebsocketPassword` / `deepseekApiKey`, clamps numeric ranges for `recordingKeepCount`, and filters enum whitelists for `aiBackend` / `aiLanguage` / `aiModels`, passing through all other keys as-is. The existing two booleans (`autoAnalyzeNew` :52, `recordingEnabled` :53 in `DEFAULTS`) have no extra sanitization. Step 1 of this task writes a test locking down this "pass-through" behavior.
2. `redactSettings` (settingsStore.ts:89-96) **does not need modification**. It is a spread structure `{ ...s, threeKeyFields: sentinel }`, automatically passing through newly added non-secret fields. Step 1 also writes a test locking this down.
   **Distinguish between "implementation needs no change" and "the `base` literal in tests must change"**: The review round once claimed `base` was a bare object literal and wouldn't turn red — that statement was only half true. While it lacks a `: GladlogSettings` type annotation, it is passed into `redactSettings(base)` (:83) as an argument where the parameter type is `GladlogSettings`. Missing two required fields produces `TS2345: Argument of type ... is missing the following properties from type 'GladlogSettings': autoCheckUpdates, lastSeenVersion`. Therefore, Step 1 (c) is not optional. Spec §4.6 also explicitly states "two locations, do not update only the first".
3. **Do not add an `update` surface to `fixtureBridge.ts`.** The only change to fixtureBridge in this task is adding two lines to the settings literal. Fixture preview intentionally **does not provide** an update surface (Global Ruling 6); pixel criteria in Tasks 7 and 8 ("no update UI rendered under fixture") directly rely on this. Adding it would cause the settings baseline screenshot to render a "Check for updates" button, which manual review would fail as a bug.

### Steps

- [ ] **Step 1: Write failing tests** — Edit `packages/desktop/test/settingsStore.test.ts`. Complete all three changes (a), (b), (c) together.

  (a) Update full default value assertion at :16-29 (add two lines after `recordingKeepCount: 50,`):

  ```ts
  expect(s.get()).toEqual({
    wowDirectory: null,
    anthropicApiKey: null,
    deepseekApiKey: null,
    aiModels: {},
    aiBackend: "anthropic",
    aiBackendCommand: null,
    aiLanguage: "zh",
    autoAnalyzeNew: false,
    recordingEnabled: false,
    obsWebsocketUrl: null,
    obsWebsocketPassword: null,
    recordingKeepCount: 50,
    autoCheckUpdates: true,
    lastSeenVersion: null,
  });
  ```

  (b) Before `it("corrupted JSON → falls back to defaults, does not throw", ...)` (:45), insert three tests:

  ```ts
  it("autoCheckUpdates: defaults to true; lastSeenVersion: defaults to null; both round-trip through save", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.get().autoCheckUpdates).toBe(true);
    expect(s.get().lastSeenVersion).toBeNull();
    expect(
      s.save({ autoCheckUpdates: false, lastSeenVersion: "0.1.20" })
        .autoCheckUpdates,
    ).toBe(false);
    const reread = new SettingsStore(p).get();
    expect(reread.autoCheckUpdates).toBe(false);
    expect(reread.lastSeenVersion).toBe("0.1.20");
  });
  it("sanitizeSettingsPatch passes these two fields through (blacklist validator, requires no change)", () => {
    expect(
      sanitizeSettingsPatch({
        autoCheckUpdates: false,
        lastSeenVersion: "1.2.3",
      }),
    ).toEqual({ autoCheckUpdates: false, lastSeenVersion: "1.2.3" });
  });
  it("redactSettings leaves these two fields untouched (spread pass-through for non-secret fields)", () => {
    const s = new SettingsStore(join(dir(), "settings.json")).get();
    const redacted = redactSettings({
      ...s,
      anthropicApiKey: "sk-real",
      autoCheckUpdates: false,
      lastSeenVersion: "0.1.20",
    });
    expect(redacted.autoCheckUpdates).toBe(false);
    expect(redacted.lastSeenVersion).toBe("0.1.20");
    expect(redacted.anthropicApiKey).toBe(API_KEY_REDACTED);
  });
  ```

  (`sanitizeSettingsPatch` / `redactSettings` / `API_KEY_REDACTED` are already imported at :4-9, no import changes needed. `describe` / `it` / `expect` rely on vitest's `globals: true` (`packages/desktop/vitest.config.ts:5`); this file originally has no vitest import, do not add one.)

  (c) In the same file under `describe("settings redaction (keys never leave main process)")`, add two fields to `const base = { … }` at :69-82 — changing :81-82 from:

  ```ts
        recordingKeepCount: 50,
      };
  ```

  to:

  ```ts
        recordingKeepCount: 50,
        autoCheckUpdates: true,
        lastSeenVersion: null,
      };
  ```

  This change adds no new test cases and alters no assertions; it purely ensures `redactSettings(base)` (:83) continues to pass `npm run typecheck` after adding required fields to the interface.

- [ ] **Step 2: Run test to confirm failure** — Run (at worktree root):

  ```bash
  npm test --workspace=packages/desktop -- test/settingsStore.test.ts
  ```

  Expected: `Tests  2 failed | 10 passed (12)` (file had 9 tests before changes, adding 3 → 12; (c) only adds fields without new cases). The two failures are:

  ```
  × SettingsStore > missing file → defaults
    → expected { wowDirectory: null, …(11) } to deeply equal { wowDirectory: null, …(13) }
  × SettingsStore > autoCheckUpdates: defaults to true; lastSeenVersion: defaults to null; both round-trip through save
    → expected undefined to be true // Object.is equality
  ```

  The other two (sanitize / redact) **pass both before and after** — this is intentional: they do not verify new behavior, but lock in the regression gate that "these two functions require no modification".
  The type issue in (c) **will not** surface in this step: vitest uses esbuild which only transpiles without type checking; it only fails in Step 8's `npm run typecheck` — which is why (c) must be completed now, or Step 8 would fail with an error unrelated to that step.

- [ ] **Step 3: Add fields to interface** — Edit `packages/desktop/src/main/settingsStore.ts`, changing :40-43 from:

  ```ts
    /** Keep the most recent N recordings (anything beyond is deleted together
     * with its video file); 0 = never clean up. */
    recordingKeepCount: number;
  }
  ```

  to:

  ```ts
    /** Keep the most recent N recordings (anything beyond is deleted together
     * with its video file); 0 = never clean up. */
    recordingKeepCount: number;
    // -- Auto-update (2026-08-02, Windows NSIS installs only) --
    /** Escape hatch for the 30s/4h background check. Turning it off only stops
     * the scheduled polling: the "check for updates" button in settings still
     * works, otherwise this switch would kill the feature outright. */
    autoCheckUpdates: boolean;
    /** Version the user has already been told about. Compared against
     * app.getVersion() on startup so a silent background update can leave a
     * visible trace ("updated to 0.1.20"); null means never shown. The
     * comparison itself lives in exactly one place --
     * renderer/src/update/updateBridge.ts -- never inline in a component. */
    lastSeenVersion: string | null;
  }
  ```

- [ ] **Step 4: Add default values** — In the same file, in `DEFAULTS` (:44-57), change:

  ```ts
    recordingKeepCount: 50,
  };
  ```

  to:

  ```ts
    recordingKeepCount: 50,
    autoCheckUpdates: true,
    lastSeenVersion: null,
  };
  ```

- [ ] **Step 5: Add full literal to fixtureBridge** — Edit `packages/desktop/src/renderer/src/fixtureBridge.ts`, changing :45-47 from:

  ```ts
      obsWebsocketPassword: null,
      recordingKeepCount: 50,
    };
  ```

  to:

  ```ts
      obsWebsocketPassword: null,
      recordingKeepCount: 50,
      autoCheckUpdates: true,
      lastSeenVersion: null,
    };
  ```

  This line is required: `currentSettings` carries a `: GladlogSettings` type annotation; omitting fields here causes typecheck errors after adding required fields to the interface.
  **This file only has these two lines changed in this task**; do not add the `update` surface (reasoning in item 3 at the start of this task).

- [ ] **Step 6: Run tests to confirm green** — Run (at worktree root):

  ```bash
  npm test --workspace=packages/desktop -- test/settingsStore.test.ts src/main/settingsStore.test.ts src/main/settingsStore.recording.test.ts
  ```

  Expected: `Tests  26 passed (26)` (three files: 12 + 11 + 3). Before changes, the same command yielded `23 passed (23)` (9 + 11 + 3, verified on 2026-08-03).

- [ ] **Step 7: grep self-check — verify whether a fourth full literal exists across the repo** — Run (at worktree root):

  ```bash
  grep -rn "recordingKeepCount:" --include="*.ts" --include="*.tsx" packages/desktop | grep -v "src/main/settingsStore.ts"
  ```

  Expected (verified on 2026-08-03): hits **12 lines**, of which **only three** are full `GladlogSettings` literals that must include the new fields —
  `test/settingsStore.test.ts:28`, `test/settingsStore.test.ts:81`, `src/renderer/src/fixtureBridge.ts:46` (line numbers shift down after Step 1(a)(c) and Step 5).
  All other hits are **not** `GladlogSettings` and remain untouched: `SettingsPanel.tsx:488` is a `Partial` patch for `save({ recordingKeepCount: n })`; `recorder.test.ts:64/154/182` and `recorder.ts:66` are recorder's own config shape (`recorder.ts:66` declares another interface); `settingsStore.recording.test.ts:39/42/44/45` are `Partial` parameters for `sanitizeSettingsPatch`.
  Purpose of this step: `GladlogSettings` is an interface with required fields; missing any full literal causes the next step's typecheck to fail on an unrelated file.

- [ ] **Step 8: Pre-push trio** — Run (at worktree root, sequentially):

  ```bash
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  Expected: first command `Test Files 137 passed` / `Tests 952 passed` (137/949 at end of Task 2 + 3 net new tests, no new files); second command exits 0 across all six workspaces with no `error TS` output (**never use `tsc -b`**, which emits `.js` into `src`); third command has no output.

  This step is not a formality: this task modified `fixtureBridge.ts` (data source for fixture preview and visual baselines) and two `GladlogSettings` full literals, while Step 7's grep only scans `recordingKeepCount:`, missing full assertions constructed via spread — only full test runs guard against regressions. If skipped, errors would remain hidden until Task 4 Step 22, failing on a file unrelated to Task 4. Lint must scan the entire repo (`eslint .`); scanning only `packages/desktop/src` will miss `test/`, a gap that broke CI three times.

- [ ] **Step 9: Commit** — Run (at worktree root):

  ```bash
  git add packages/desktop/src/main/settingsStore.ts packages/desktop/test/settingsStore.test.ts packages/desktop/src/renderer/src/fixtureBridge.ts
  git commit -m "feat(desktop): add autoCheckUpdates / lastSeenVersion to settings — auto-update switch and update trace

autoCheckUpdates controls only the 30s/4h background polling; manual 'Check for
updates' in settings remains available. lastSeenVersion is compared against
app.getVersion() to leave traces for silent updates (comparison logic is
single-sourced in renderer/src/update/updateBridge.ts, not inlined in
components).

sanitizeSettingsPatch and redactSettings verified to require no changes
(blacklist + spread), with two new tests locking them in as regression gates;
GladlogSettings is an interface with required fields, so three full literals
(two in test + one in fixtureBridge) are updated to keep typecheck green.
settingsStore test count 9 → 12 (3 net new tests)."
  ```

---

## Task 4: `updater.ts` — Triple Activation Gate + State Machine + install() + Timers

Corresponds to the client side of spec §4.1 / §4.2 / §4.2.1 / §4.3. The module produced by this task **does not import electron or electron-updater at all**: real `autoUpdater` and everything it requires (platform, packaged flag, install directory listing) are injected, allowing the gate, state machine, and install sequence to run under vitest outside Electron. Same rationale as the header comment in `quitLifecycle.ts`.

**Files:**

- Create: `packages/desktop/src/main/updater.ts`
- Create: `packages/desktop/src/main/updater.test.ts` (22 tests)
- Create: `packages/desktop/src/main/updater.uninstallerName.test.ts` (1 cross-package consistency gate test)

(Tests live in the same directory as source code, matching existing convention of `quitLifecycle.test.ts` / `e2eEnv.test.ts`; files under `packages/desktop/test/` are renderer/integration-oriented.)

**Interfaces:**

- Consumes:
  - `GladlogSettings.autoCheckUpdates` from Task 3 — **not an import relationship**, injected solely via `UpdaterDeps.isAutoCheckEnabled: () => boolean`, wired in Task 6
  - `quitLifecycle.shutdown()` from Task 2 — likewise **not an import relationship**, injected solely via `UpdaterDeps.shutdown: () => Promise<void>`
  - `electron-updater@6.8.9` was committed into `packages/desktop/package.json:31` `dependencies` in **Task 1** along with release-side configs (the working tree is already clean, **do not edit package.json again**, and **do not** add it to the `externalizeDepsPlugin` exclude list in `electron.vite.config.ts` — that list is only for `@gladlog/*` workspace packages whose `main` points to TS source). This module **does not import it**, declaring `UpdaterBackend` structurally as a TypeScript interface
- Produces (verbatim, consumed as-is by subsequent tasks):

  ```ts
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
    execDir: string;
    readDir: (dir: string) => string[];
    testFeed: string | undefined;
  }

  export type GateResult =
    | { ok: true; feed: { owner: string; repo: string } | null }
    | { ok: false; reason: "platform" | "dev" | "portable" };

  /** Pure function; throws when testFeed is set but invalid, does not return GateResult. */
  export function evaluateGate(env: UpdaterEnv): GateResult;

  export interface UpdaterBackend {
    /* Full definition in Step 9 */
  }

  export interface UpdaterDeps {
    autoUpdater: UpdaterBackend;
    env: UpdaterEnv;
    now: () => number;
    emit: (state: UpdateState) => void;
    shutdown: () => Promise<void>;
    isAutoCheckEnabled: () => boolean;
  }

  export interface UpdaterService {
    getState(): UpdateState;
    check(): Promise<void>;
    autoCheck(): Promise<void>;
    install(): Promise<void>;
    dispose(): void;
  }

  export function createUpdaterService(deps: UpdaterDeps): UpdaterService;

  export const FIRST_CHECK_DELAY_MS: number; // 30_000
  export const CHECK_INTERVAL_MS: number; // 4 * 60 * 60 * 1000
  export const UNINSTALLER_PATTERN: RegExp; // /^Uninstall .+\.exe$/
  ```

### Division of Responsibilities with Task 5 / Task 6 (decided, do not re-implement)

**The sole implementation of `install()` is in this task** (Steps 14-15), including the sequence "call `quitAndInstall(true, true)` only after `await deps.shutdown()` resolves" and sequence assertion tests. `deps.shutdown` is injected as `() => Promise<void>`; updater.ts has zero dependencies on `quitLifecycle`, allowing full testing here.

**The sole implementation of timing intervals (30s initial check / 4h polling) is also in this task** (Step 12): constants `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` are single-sourced in updater.ts, timers are started by `createUpdaterService` itself and cleared in `dispose()`. **Task 6 wiring must not re-declare these two constants or build a second set of timers**; its `before-quit` handler only calls `updaterService?.dispose()`.

Ownership of other tasks:

- **quitLifecycle's `shutdown()` belongs to Task 2** (completed), not Task 5
- **main/index.ts wiring belongs to Task 6** (including `autoUpdater.logger = log`, dynamic imports, `evaluateGate` pre-check)
- **Task 5 only implements two deltas on `install()`**, editing `updater.ts` incrementally without rebuilding harnesses or rewriting `install()`:
  1. Wrap the bare `await deps.shutdown();` in Step 15 in a try/catch ("install even if teardown fails", spec §4.3)
  2. Add install watchdog: `INSTALL_WATCHDOG_MS = 10_000`, armed after `quitAndInstall`, transitioning to `error` state if not taken over by installer within timeout

  Task 5 uses three anchor points produced in this task; leave them clean and **do not implement them prematurely**:
  (i) below `let installing = false;` in local variables; (ii) after `backend.quitAndInstall(true, true)` in `install()`; (iii) top of `dispose()`.
  Note especially: **`await deps.shutdown();` in this task deliberately lacks try/catch** — that is Task 5's first delta; adding it early would cause Task 5's "confirm red" step to pass immediately.

### Handoff Instructions for Task 6 (Wiring)

1. Production arguments for `UpdaterEnv`: `platform: process.platform`, `isPackaged: app.isPackaged`, `execDir: dirname(process.execPath)`, `readDir: readdirSync` (`fs`), `testFeed: process.env["GLADLOG_UPDATER_TEST_FEED"]`.
2. **`autoUpdater.logger = log` (electron-log) must be explicitly written at wiring**, in `initUpdater`, after getting `autoUpdater` and before `createUpdaterService(`. Not in `UpdaterBackend` interface — updater.ts maintains zero Electron dependencies. **Missing this line breaks the entire evidence chain**: default logger is `console` (`this._logger = console;` in `AppUpdater.js:179`), so `Checking for update` / `Found version X` never enter `~/Library/Logs/gladlog/main.log`, which is the primary evidence channel for spec §6.2 dummy release verification.
3. Cold start budget 2600ms (`qa/budgets.ts:44`): wiring calls `evaluateGate(env)` first, and only when `ok` executes `await import("electron-updater")` followed by `createUpdaterService`. `evaluateGate` is a pure function evaluated twice (once at wiring, once inside `createUpdaterService`) with identical results — intentional single-source reuse rather than duplication.
4. **`testFeed` passes through directly without `GLADLOG_E2E` check** (Global Ruling 5). The gate evaluation order puts `!isPackaged → dev` before testFeed validation, so E2E/dev never reaches validation (Step 3 test 1 asserts this); leftover variables in dev shells cannot crash E2E. Conversely, clearing it at wiring **breaks spec §6.2** — the dummy release client is a packaged app launched with **both** `GLADLOG_E2E=1` (moving userData for isolation) and `GLADLOG_UPDATER_TEST_FEED`.
5. **Timers belong to this module; wiring only calls `dispose()`** (Global Ruling 4). `dispose()` is called from main/index.ts **via another registered `app.on("before-quit", ...)` listener** (`preventDefault()` does not block other listeners on the same event, and `QuitLifecycleDeps` has a fixed shape; do not add dependencies for this). If not called, the 4h `setInterval` would block application exit. Wiring **must not** declare duplicate constants like `UPDATE_FIRST_CHECK_MS` / `UPDATE_POLL_MS`, and **must not** run `setTimeout` / `setInterval` calling `autoCheck()` again — which would send duplicate requests per tick and duplicate the 30s/4h numbers (violating CLAUDE.md). **Task 6 Step 10b contains a grep self-check guarding this** (scanning `main/index.ts`, expecting zero output).
6. When renderer uses `UpdateState`, it must use `import type` (precedent: `import type { RecorderStatus } from "../main/recorder";` in `src/preload/api.ts:6`). A value import would pull electron-updater into the renderer bundle, breaking both `electron-vite build` and `npm run build:ui`.

### Steps

- [ ] **Step 1: Write test skeleton + 8 evaluateGate tests (red)** — Create `packages/desktop/src/main/updater.test.ts`:

  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

  import {
    CHECK_INTERVAL_MS,
    createUpdaterService,
    evaluateGate,
    FIRST_CHECK_DELAY_MS,
    type UpdaterBackend,
    type UpdaterEnv,
    type UpdateState,
  } from "./updater";

  function winEnv(over: Partial<UpdaterEnv> = {}): UpdaterEnv {
    return {
      platform: "win32",
      isPackaged: true,
      execDir: "C:\\Users\\x\\AppData\\Local\\Programs\\gladlog",
      readDir: () => ["gladlog.exe", "Uninstall gladlog.exe", "resources"],
      testFeed: undefined,
      ...over,
    };
  }

  describe("evaluateGate", () => {
    it("not packaged → dev, taking precedence over other gates (invalid testFeed does not throw)", () => {
      expect(
        evaluateGate(
          winEnv({
            isPackaged: false,
            platform: "darwin",
            testFeed: "garbage",
          }),
        ),
      ).toEqual({ ok: false, reason: "dev" });
    });

    it("packaged + win32 + has uninstaller → pass, production feed", () => {
      expect(evaluateGate(winEnv())).toEqual({ ok: true, feed: null });
    });

    it("non-win32 → platform (macOS ad-hoc signature fails Squirrel verification)", () => {
      expect(evaluateGate(winEnv({ platform: "darwin" }))).toEqual({
        ok: false,
        reason: "platform",
      });
    });

    it("win32 without uninstaller in directory (zip portable) → portable", () => {
      expect(
        evaluateGate(winEnv({ readDir: () => ["gladlog.exe", "resources"] })),
      ).toEqual({ ok: false, reason: "portable" });
    });

    it("uninstaller predicate scans pattern: recognizes even if productName changes", () => {
      expect(
        evaluateGate(winEnv({ readDir: () => ["Uninstall gladlog-next.exe"] })),
      ).toEqual({ ok: true, feed: null });
      // Similar filenames that are not NSIS uninstallers must not be misidentified
      expect(
        evaluateGate(
          winEnv({ readDir: () => ["Uninstaller.exe", "unins000.exe"] }),
        ),
      ).toEqual({ ok: false, reason: "portable" });
    });

    it("unreadable directory → treated as portable, does not throw", () => {
      expect(
        evaluateGate(
          winEnv({
            readDir: () => {
              throw new Error("ENOENT");
            },
          }),
        ),
      ).toEqual({ ok: false, reason: "portable" });
    });

    it("valid testFeed → bypasses platform and portable gates, returns feed", () => {
      expect(
        evaluateGate(
          winEnv({
            platform: "darwin",
            readDir: () => [],
            testFeed: "mingjianliu/gladlog-update-test",
          }),
        ),
      ).toEqual({
        ok: true,
        feed: { owner: "mingjianliu", repo: "gladlog-update-test" },
      });
    });

    it("invalid testFeed → throws error, never silently falls back to production feed", () => {
      for (const bad of ["", "garbage", "owner/", "/repo", "a/b/c"]) {
        expect(() => evaluateGate(winEnv({ testFeed: bad }))).toThrow(
          /GLADLOG_UPDATER_TEST_FEED/,
        );
      }
    });
  });
  ```

  Write the complete import block at once (including `createUpdaterService` / constants used in later steps): vitest (2.1.9) uses Vite SSR transforms, which do not throw resolution errors for missing named exports in TS modules, merely returning `undefined`, so writing them early does not affect the failure mode of this step.

  **Type checking is different: do not run `npm run typecheck` during Steps 1–8.** Named exports `UpdaterBackend` / `createUpdaterService` / `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` are exported in Step 9 (Step 3 only exports `UpdateState` / `UpdaterEnv` / `GateResult` / `evaluateGate`), so running `npm run typecheck` during Steps 1–8 produces `TS2305: Module './updater' has no exported member '…'`. Type checking passes uniformly in **Step 22**; Steps 2, 4, 8 rely solely on `npm test` output.

- [ ] **Step 2: Run test to confirm failure** — Run (at worktree root):

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Test Files  1 failed (1)` / `Tests  no tests` due to missing module:

  ```
  Error: Failed to load url ./updater (resolved id: ./updater) in /.../packages/desktop/src/main/updater.test.ts. Does the file exist?
  ```

- [ ] **Step 3: Minimal implementation of evaluateGate** — Create `packages/desktop/src/main/updater.ts`:

  ```ts
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
          `GLADLOG_UPDATER_TEST_FEED requires <owner>/<repo> format, received: ${env.testFeed}`,
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
  ```

- [ ] **Step 4: Run test to confirm pass** — Run: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`. Expected: `Tests  8 passed (8)`.

- [ ] **Step 5: Commit** — Run:

  ```bash
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): updater triple activation gate evaluateGate

Evaluation order !isPackaged → testFeed → platform → uninstaller; dev gate
runs first so stale GLADLOG_UPDATER_TEST_FEED in dev shell never breaks E2E,
without impacting §6.2 dummy release client (which is packaged, carrying both
E2E and test feed vars). isPackaged rationale updated: not for preventing throws
(electron-updater resolves null no-op when unpackaged), but to let state
machine report reason: 'dev' rather than idle. Invalid testFeed throws
immediately; uninstaller uses pattern matching rather than hardcoded names."
  ```

- [ ] **Step 6: Fake backend + 7 gate-failing and state machine tests (red)** — Insert FakeBackend after `winEnv` and before `describe("evaluateGate")` in `updater.test.ts`:

  ```ts
  /** Records every touch of the backend so "the gate never talks to
   * electron-updater" can be asserted, property assignments included. */
  class FakeBackend implements UpdaterBackend {
    calls: string[] = [];
    checkResult: Promise<unknown> = Promise.resolve(null);
    private listeners = new Map<string, ((payload: unknown) => void)[]>();
    private _autoDownload = false;
    private _autoInstallOnAppQuit = false;
    private _allowPrerelease = true;
    private _disableWebInstaller = false;

    get autoDownload(): boolean {
      return this._autoDownload;
    }
    set autoDownload(v: boolean) {
      this.calls.push(`set:autoDownload=${v}`);
      this._autoDownload = v;
    }
    get autoInstallOnAppQuit(): boolean {
      return this._autoInstallOnAppQuit;
    }
    set autoInstallOnAppQuit(v: boolean) {
      this.calls.push(`set:autoInstallOnAppQuit=${v}`);
      this._autoInstallOnAppQuit = v;
    }
    get allowPrerelease(): boolean {
      return this._allowPrerelease;
    }
    set allowPrerelease(v: boolean) {
      this.calls.push(`set:allowPrerelease=${v}`);
      this._allowPrerelease = v;
    }
    get disableWebInstaller(): boolean {
      return this._disableWebInstaller;
    }
    set disableWebInstaller(v: boolean) {
      this.calls.push(`set:disableWebInstaller=${v}`);
      this._disableWebInstaller = v;
    }
    setFeedURL(options: { provider: "github"; owner: string; repo: string }) {
      this.calls.push(`setFeedURL:${options.owner}/${options.repo}`);
    }
    on(event: string, listener: (payload: never) => void): void {
      const arr = this.listeners.get(event) ?? [];
      arr.push(listener as (payload: unknown) => void);
      this.listeners.set(event, arr);
    }
    checkForUpdates(): Promise<unknown> {
      this.calls.push("checkForUpdates");
      return this.checkResult;
    }
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
      this.calls.push(`quitAndInstall:${isSilent}:${isForceRunAfter}`);
    }
    /** Test driver: emit an electron-updater event. */
    fire(event: string, payload?: unknown): void {
      for (const l of this.listeners.get(event) ?? []) l(payload);
    }
  }
  ```

  Three notes:
  - Using getters/setters records property assignments so assertions verify that autoUpdater is never touched when gates fail.
  - `_allowPrerelease` starts at `true` to replicate real constructor behavior (`this.allowPrerelease = hasPrereleaseComponents(currentVersion)` in `AppUpdater.js:218`). Setting `allowPrerelease = false` in Step 9 must execute unconditionally.
  - `fire()` calls listener arrays directly rather than via EventEmitter, so unhandled error throwing is guaranteed structurally in Step 9 (listeners registered before any check).

- [ ] **Step 7: Append two describes (red)** — Append to the end of `updater.test.ts`:

  ```ts
  describe("createUpdaterService: gate fails", () => {
    it("disabled state includes reason and never touches any autoUpdater members", () => {
      const backend = new FakeBackend();
      const emitted: UpdateState[] = [];
      const svc = createUpdaterService({
        autoUpdater: backend,
        env: winEnv({ platform: "darwin" }),
        now: () => 1000,
        emit: (s) => emitted.push(s),
        shutdown: () => Promise.resolve(),
        isAutoCheckEnabled: () => true,
      });
      expect(svc.getState()).toEqual({ phase: "disabled", reason: "platform" });
      expect(backend.calls).toEqual([]);
      expect(emitted).toEqual([]);
      svc.dispose();
    });

    it("under disabled state check/autoCheck/install are all no-ops", async () => {
      const backend = new FakeBackend();
      const shutdown = vi.fn(() => Promise.resolve());
      const svc = createUpdaterService({
        autoUpdater: backend,
        env: winEnv({ isPackaged: false }),
        now: () => 1000,
        emit: () => {},
        shutdown,
        isAutoCheckEnabled: () => true,
      });
      await svc.check();
      await svc.autoCheck();
      await svc.install();
      expect(backend.calls).toEqual([]);
      expect(shutdown).not.toHaveBeenCalled();
      expect(svc.getState()).toEqual({ phase: "disabled", reason: "dev" });
      svc.dispose();
    });
  });

  describe("createUpdaterService: state machine", () => {
    let backend: FakeBackend;
    let emitted: UpdateState[];
    let shutdown: ReturnType<typeof vi.fn>;
    let svc: ReturnType<typeof createUpdaterService>;
    let autoCheckEnabled: boolean;

    beforeEach(() => {
      vi.useFakeTimers();
      backend = new FakeBackend();
      emitted = [];
      autoCheckEnabled = true;
      shutdown = vi.fn(() => Promise.resolve());
      svc = createUpdaterService({
        autoUpdater: backend,
        env: winEnv(),
        now: () => 1_700_000_000_000,
        emit: (s) => emitted.push(s),
        shutdown: shutdown as unknown as () => Promise<void>,
        isAutoCheckEnabled: () => autoCheckEnabled,
      });
    });
    afterEach(() => {
      svc.dispose();
      vi.useRealTimers();
    });

    it("initial idle, configuration hardcoded per design", () => {
      expect(svc.getState()).toEqual({ phase: "idle", lastCheckedAt: null });
      expect(backend.calls).toEqual([
        "set:autoDownload=true",
        "set:autoInstallOnAppQuit=true",
        "set:allowPrerelease=false",
        "set:disableWebInstaller=true",
      ]);
    });

    it("event sequence → state snapshots", () => {
      backend.fire("checking-for-update");
      backend.fire("update-available", { version: "0.1.20" });
      backend.fire("download-progress", { percent: 37.4 });
      backend.fire("update-downloaded", { version: "0.1.20" });
      expect(emitted).toEqual([
        { phase: "checking" },
        { phase: "downloading", version: "0.1.20", percent: 0 },
        { phase: "downloading", version: "0.1.20", percent: 37 },
        { phase: "ready", version: "0.1.20" },
      ]);
      expect(svc.getState()).toEqual({ phase: "ready", version: "0.1.20" });
    });

    it("update-not-available → idle with last check timestamp", () => {
      backend.fire("checking-for-update");
      backend.fire("update-not-available", { version: "0.1.19" });
      expect(svc.getState()).toEqual({
        phase: "idle",
        lastCheckedAt: 1_700_000_000_000,
      });
    });

    it("does not re-push identical integer percentages", () => {
      backend.fire("update-available", { version: "0.1.20" });
      emitted.length = 0;
      backend.fire("download-progress", { percent: 12.1 });
      backend.fire("download-progress", { percent: 12.4 });
      backend.fire("download-progress", { percent: 13.0 });
      expect(emitted).toEqual([
        { phase: "downloading", version: "0.1.20", percent: 12 },
        { phase: "downloading", version: "0.1.20", percent: 13 },
      ]);
    });

    it("error event only sets state, does not throw or open dialog", () => {
      expect(() =>
        backend.fire("error", new Error("net::ERR_CONNECTION_RESET")),
      ).not.toThrow();
      expect(svc.getState()).toEqual({
        phase: "error",
        message: "net::ERR_CONNECTION_RESET",
      });
    });
  });
  ```

  Event names match `AppUpdaterEvents` in `node_modules/electron-updater/out/AppUpdater.d.ts:14-24` (9 total, 6 mapped here). The other three are intentionally not listened to: `update-cancelled` (only emitted when download throws `CancellationError`; `autoDownload=true` and never cancelled), `login` (proxy auth), `appimage-filename-updated` (Linux only). Not listening to them does not throw.

- [ ] **Step 8: Run test to confirm failure** — Run: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`. Expected: `Tests  7 failed | 8 passed (15)`, all 7 failures reporting `TypeError: createUpdaterService is not a function`.

- [ ] **Step 9: Implement service skeleton + event wiring** — Append to `updater.ts`:

  ```ts
  /** The slice of electron-updater's AppUpdater this module uses. Declared
   * structurally so tests can inject a fake; the real `autoUpdater` satisfies it
   * (checked by the assignment in main/index.ts). */
  export interface UpdaterBackend {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowPrerelease: boolean;
    disableWebInstaller: boolean;
    setFeedURL(options: {
      provider: "github";
      owner: string;
      repo: string;
    }): void;
    on(event: "checking-for-update", listener: () => void): void;
    on(
      event: "update-not-available",
      listener: (info: { version: string }) => void,
    ): void;
    on(
      event: "update-available",
      listener: (info: { version: string }) => void,
    ): void;
    on(
      event: "download-progress",
      listener: (info: { percent: number }) => void,
    ): void;
    on(
      event: "update-downloaded",
      listener: (info: { version: string }) => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    checkForUpdates(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  }

  export interface UpdaterDeps {
    autoUpdater: UpdaterBackend;
    env: UpdaterEnv;
    now: () => number;
    emit: (state: UpdateState) => void;
    /** quitLifecycle.shutdown */
    shutdown: () => Promise<void>;
    isAutoCheckEnabled: () => boolean;
  }

  export interface UpdaterService {
    getState(): UpdateState;
    /** Manual check: ignores isAutoCheckEnabled. */
    check(): Promise<void>;
    /** Scheduled check: returns immediately when isAutoCheckEnabled() is false. */
    autoCheck(): Promise<void>;
    install(): Promise<void>;
    /** Stops the timers; called by tests and from before-quit. */
    dispose(): void;
  }

  /** First check is delayed so it does not compete with window creation, corpus
   * loading and the initial log scan for IO. Single source: the wiring in
   * main/index.ts must NOT declare its own copies of these numbers nor build a
   * second pair of timers -- the service owns both. */
  export const FIRST_CHECK_DELAY_MS = 30_000;
  export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

  export function createUpdaterService(deps: UpdaterDeps): UpdaterService {
    const gate = evaluateGate(deps.env);

    if (!gate.ok) {
      // Nothing on deps.autoUpdater is read or written on this path -- not even a
      // property assignment. Keeps mac/dev/portable runs completely inert.
      const state: UpdateState = { phase: "disabled", reason: gate.reason };
      return {
        getState: () => state,
        check: () => Promise.resolve(),
        autoCheck: () => Promise.resolve(),
        install: () => Promise.resolve(),
        dispose: () => {},
      };
    }

    const backend = deps.autoUpdater;
    let state: UpdateState = { phase: "idle", lastCheckedAt: null };
    let lastCheckedAt: number | null = null;
    let pendingVersion = "";

    function setState(next: UpdateState): void {
      state = next;
      deps.emit(next);
    }

    backend.autoDownload = true;
    // Backstop: if the user never clicks "restart now", the update is installed
    // on the next normal quit. It hooks electron's "quit" event
    // (BaseUpdater.js:69-90 addQuitHandler, via ElectronAppAdapter.js:37-39
    // `this.app.once("quit", ...)`), which fires AFTER before-quit -- i.e. after
    // quitLifecycle's cleanup chain is already done. Note BaseUpdater.js:83-86:
    // a non-zero exit code skips the auto install, so this really is a backstop
    // and not a guarantee.
    backend.autoInstallOnAppQuit = true;
    // Unconditional on purpose: the constructor sets
    // allowPrerelease = hasPrereleaseComponents(currentVersion)
    // (AppUpdater.js:218), so a build like 0.1.15-obs.6 would otherwise start
    // out with prereleases allowed. The user's call is: stable versions only.
    backend.allowPrerelease = false;
    // We ship a one-piece NSIS installer, not a web installer. Without this,
    // NsisUpdater.js:44-46 logs a misleading warning on every download.
    backend.disableWebInstaller = true;
    if (gate.feed) {
      backend.setFeedURL({ provider: "github", ...gate.feed });
    }

    // Every listener is attached before the first checkForUpdates(), for two
    // independent reasons:
    //   1. "error" MUST exist before anything can fail: AppUpdater extends
    //      EventEmitter, and an EventEmitter with no "error" listener rethrows
    //      as an uncaught exception -- the exact opposite of §4.2's "never
    //      disturb the user" (spec §4.2 implementation constraint 1).
    //   2. With autoDownload = true the download starts inside
    //      checkForUpdates(), and electron-updater snapshots
    //      listenerCount("download-progress") once when the download begins
    //      (AppUpdater.js:567-568) -- a progress listener added later receives
    //      nothing at all, with no error.
    backend.on("checking-for-update", () => {
      lastCheckedAt = deps.now();
      setState({ phase: "checking" });
    });
    backend.on("update-not-available", () => {
      setState({ phase: "idle", lastCheckedAt });
    });
    backend.on("update-available", (info) => {
      pendingVersion = info.version;
      setState({ phase: "downloading", version: info.version, percent: 0 });
    });
    backend.on("download-progress", (info) => {
      const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
      // Progress fires per chunk; only whole-percent changes are worth an IPC
      // push to the renderer.
      if (state.phase === "downloading" && state.percent === percent) return;
      setState({ phase: "downloading", version: pendingVersion, percent });
    });
    backend.on("update-downloaded", (info) => {
      setState({ phase: "ready", version: info.version });
    });
    // Errors never throw and never open a dialog: pulling ~110 MB from GitHub
    // fails routinely, and a failed update breaks no other feature.
    backend.on("error", (err) => {
      setState({ phase: "error", message: err.message });
    });

    return {
      getState: () => state,
      check: () => Promise.resolve(),
      autoCheck: () => Promise.resolve(),
      install: () => Promise.resolve(),
      dispose: () => {},
    };
  }
  ```

- [ ] **Step 10: Run test to confirm pass** — Run: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`. Expected: `Tests  15 passed (15)`.

- [ ] **Step 11: Write 4 check-timing tests (red)** — Append after `it("error event only sets state...")`:

  ```ts
  it("check() manual: ignores auto-check switch", async () => {
    autoCheckEnabled = false;
    await svc.check();
    expect(backend.calls).toContain("checkForUpdates");
  });

  it("autoCheck() scheduled: does not check when switch is disabled", async () => {
    autoCheckEnabled = false;
    await svc.autoCheck();
    expect(backend.calls).not.toContain("checkForUpdates");
  });

  it("checkForUpdates rejection does not bubble (promise branch in dual channels swallowed by catch)", async () => {
    backend.checkResult = Promise.reject(new Error("ENOTFOUND"));
    await expect(svc.check()).resolves.toBeUndefined();
  });

  it("checks after 30s initial delay on startup, then every 4h; stops checking after dispose", async () => {
    expect(backend.calls).not.toContain("checkForUpdates");
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.calls.filter((c) => c === "checkForUpdates")).toHaveLength(
      1,
    );
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.calls.filter((c) => c === "checkForUpdates")).toHaveLength(
      2,
    );
    svc.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(backend.calls.filter((c) => c === "checkForUpdates")).toHaveLength(
      2,
    );
  });
  ```

  Run to confirm failures: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`, Expected `Tests  2 failed | 17 passed (19)`. Additionally, an unhandled rejection block `Errors  1 error` (`Unhandled Rejection: Error: ENOTFOUND`) appears because placeholder `check` does not await backend promises; this resolves once Step 12 implements `runCheck`.

- [ ] **Step 12: Implement runCheck / autoCheck / timers** — In `updater.ts`, insert after `backend.on("error", ...)` and before `return {`:

  ```ts
  async function runCheck(): Promise<void> {
    // checkForUpdates() reports a failure twice: it emits "error" AND returns a
    // rejected promise (AppUpdater.js:269-272). The state comes from the event;
    // this catch exists only so the rejection is not an unhandled one.
    try {
      await backend.checkForUpdates();
    } catch {
      // Already reflected in the state by the "error" listener above.
    }
  }

  async function autoCheck(): Promise<void> {
    if (!deps.isAutoCheckEnabled()) return;
    await runCheck();
  }

  const firstCheckTimer = setTimeout(() => {
    void autoCheck();
  }, FIRST_CHECK_DELAY_MS);
  const pollTimer = setInterval(() => {
    void autoCheck();
  }, CHECK_INTERVAL_MS);
  ```

  And update the return object to:

  ```ts
  return {
    getState: () => state,
    check: runCheck,
    autoCheck,
    install: () => Promise.resolve(),
    dispose: () => {
      clearTimeout(firstCheckTimer);
      clearInterval(pollTimer);
    },
  };
  ```

- [ ] **Step 13: Run test to confirm pass** — Run: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`. Expected: `Tests  19 passed (19)`.

- [ ] **Step 14: Write 3 install() tests (red)** — Append to the state machine describe:

  ```ts
  it("install(): does nothing when not ready", async () => {
    await svc.install();
    expect(shutdown).not.toHaveBeenCalled();
    expect(backend.calls.some((c) => c.startsWith("quitAndInstall"))).toBe(
      false,
    );
  });

  it("install(): installer starts only after shutdown resolves (ordering assertion)", async () => {
    const order: string[] = [];
    let releaseShutdown!: () => void;
    const gated = createUpdaterService({
      autoUpdater: backend,
      env: winEnv(),
      now: () => 1,
      emit: () => {},
      shutdown: () =>
        new Promise<void>((res) => {
          order.push("shutdown-start");
          releaseShutdown = res;
        }),
      isAutoCheckEnabled: () => true,
    });
    backend.fire("update-downloaded", { version: "0.1.20" });
    const p = gated.install();
    await Promise.resolve();
    expect(order).toEqual(["shutdown-start"]);
    expect(backend.calls.some((c) => c.startsWith("quitAndInstall"))).toBe(
      false,
    );
    releaseShutdown();
    await p;
    expect(backend.calls).toContain("quitAndInstall:true:true");
    gated.dispose();
  });

  it("install(): repeated calls run only one chain", async () => {
    backend.fire("update-downloaded", { version: "0.1.20" });
    await Promise.all([svc.install(), svc.install()]);
    await svc.install();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(
      backend.calls.filter((c) => c.startsWith("quitAndInstall")),
    ).toHaveLength(1);
  });
  ```

  Run to confirm failure: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`, Expected `Tests  2 failed | 20 passed (22)`.

- [ ] **Step 15: Implement install()** — In `updater.ts`, insert after `const pollTimer = ...` and before `return {`:

  ```ts
  async function install(): Promise<void> {
    if (state.phase !== "ready" || installing) return;
    installing = true;
    // One cleanup chain, two entry points. quitAndInstall() spawns the NSIS
    // installer detached and only then calls app.quit()
    // (BaseUpdater.js:13-27), so the OBS/worker/AI teardown has to be finished
    // BEFORE it runs -- otherwise the installer races a recording that is
    // still being closed. deps.shutdown is quitLifecycle.shutdown, the exact
    // chain before-quit uses; there is no second copy of that logic here.
    //
    // Deliberately NOT wrapped in try/catch yet: making a failed teardown
    // still install is the next task's first increment (spec §4.3), and
    // adding it here would turn that task's red step green.
    await deps.shutdown();
    try {
      // isSilent = true, and only then is isForceRunAfter honoured
      // (BaseUpdater.js:16 falls back to autoRunAppAfterInstall otherwise).
      backend.quitAndInstall(true, true);
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // The "installer never took over" branch is handled by the install
    // watchdog added in the next task: quitAndInstall returns void and
    // swallows a failed spawn (BaseUpdater.js:16-25 -- when install() returns
    // false it just resets quitAndInstallCalled and never calls app.quit()),
    // so there is nothing to catch here. We watch the clock instead and
    // surface an error state. We deliberately do NOT force a quit from this
    // module: that would need a quit dependency the service does not have,
    // and opening a second exit path around quitLifecycle is worse than a
    // visible error state.
  }
  ```

  Add state variable under `let pendingVersion = "";`:

  ```ts
  let installing = false;
  ```

  (`installing` is intentionally never reset: once the installer takes over the process exits, and if it fails the next task's watchdog ensures no second installer spawns.)

  And replace `install: () => Promise.resolve(),` with `install,` in the return object.

- [ ] **Step 16: Run test to confirm pass** — Run: `npm test --workspace=packages/desktop -- src/main/updater.test.ts`. Expected: `Tests  22 passed (22)`.

- [ ] **Step 17: Commit** — Run:

  ```bash
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): updater state machine + check timing + install()

Six electron-updater events mapped unidirectionally to UpdateState; errors
set state without throwing or opening dialogs.
Listeners registered before first checkForUpdates: EventEmitter without error
listener rethrows as uncaught; autoDownload=true starts download inside
checkForUpdates where listenerCount('download-progress') is snapshotted
(AppUpdater.js:567), late listeners receive zero events.
allowPrerelease=false assigned unconditionally (constructor auto-sets true
based on current version in AppUpdater.js:218).
checkForUpdates dual failure channels (emit error + reject) handled, catch
swallows promise rejection.
30s/4h timers owned by service and cleared on dispose.
install() awaits shutdown() before quitAndInstall(true, true) with ordering
assertions. 22 unit tests added in this file."
  ```

- [ ] **Step 18: Write cross-package consistency gate for uninstaller predicate (red)** — Create `packages/desktop/src/main/updater.uninstallerName.test.ts`:

  ```ts
  import { readFileSync } from "fs";
  import { join } from "path";
  import { describe, expect, it } from "vitest";

  import { UNINSTALLER_PATTERN } from "./updater";

  /** Shared-predicate gate (CLAUDE.md). evaluateGate's portable-vs-installed
   * decision is a claim about a file name that app-builder-lib's NSIS template
   * produces; no other code re-derives it, so this test reconciles our regex
   * against the template literal itself. If electron-builder ever renames the
   * uninstaller, CI goes red here instead of the feature silently degrading into
   * "every install looks portable and never updates".
   *
   * Pinned to app-builder-lib 26.15.3. */
  const COMMON_NSH = join(
    __dirname,
    "../../../../node_modules/app-builder-lib/templates/nsis/common.nsh",
  );

  describe("uninstaller filename predicate consistent with app-builder-lib template", () => {
    it("UNINSTALL_FILENAME template rendered name must match UNINSTALLER_PATTERN", () => {
      const src = readFileSync(COMMON_NSH, "utf-8");
      const m = /!define\s+UNINSTALL_FILENAME\s+"([^"]+)"/.exec(src);
      expect(m).not.toBeNull();
      const template = m?.[1] ?? "";
      expect(template).toContain("${PRODUCT_FILENAME}");
      for (const productFilename of ["gladlog", "gladlog next", "GladLog-2"]) {
        const rendered = template.replace(
          "${PRODUCT_FILENAME}",
          productFilename,
        );
        expect(UNINSTALLER_PATTERN.test(rendered)).toBe(true);
      }
    });
  });
  ```

- [ ] **Step 19: Run test to confirm failure** — Run:

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.uninstallerName.test.ts
  ```

  Expected: `Tests  1 failed (1)`, error `TypeError: Cannot read properties of undefined (reading 'test')` — `UNINSTALLER_PATTERN` is not yet exported.

- [ ] **Step 20: Export predicate** — In `packages/desktop/src/main/updater.ts`, change:

  ```ts
  const UNINSTALLER_PATTERN = /^Uninstall .+\.exe$/;
  ```

  to:

  ```ts
  export const UNINSTALLER_PATTERN = /^Uninstall .+\.exe$/;
  ```

- [ ] **Step 21: Run test to confirm pass** — Run: `npm test --workspace=packages/desktop -- src/main/updater.uninstallerName.test.ts`. Expected: `Tests  1 passed (1)`.

- [ ] **Step 22: Full regression + typecheck + lint** — Run (sequentially):

  ```bash
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  Expected:
  - First command green, test count increases by **23** (22 + 1) relative to before this task. Baseline was `Test Files 136 passed (136)` / `Tests 938 passed (938)`.
  - Second command exits 0 across all six workspaces with no `error TS`.
  - Third command produces no output.

- [ ] **Step 23: Commit** — Run:

  ```bash
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.uninstallerName.test.ts
  git commit -m "test(desktop): uninstaller filename predicate consistency gate with app-builder-lib template

Reconciles /^Uninstall .+\\.exe\$/ against UNINSTALL_FILENAME in
templates/nsis/common.nsh:17 (app-builder-lib 26.15.3). If electron-builder
upgrades change uninstaller naming, CI fails here instead of silently
degrading into portable mode. Total 23 unit tests added in this task
(updater.test.ts 22 + this file 1)."
  ```

### Known Boundaries (do not report as bugs or modify out of turn)

1. **`install()` shutdown failure handling and watchdog are not in this task**. `await deps.shutdown();` is bare and `quitAndInstall` has no timeout protection — these two increments belong to Task 5.
2. **`quitAndInstall` arguments on macOS are ignored**. `quitAndInstall()` in `MacUpdater.js:240` takes no arguments, delegating to `this.nativeUpdater.quitAndInstall()` rather than spawn + `app.quit()`. Behavior observed on macOS under `GLADLOG_UPDATER_TEST_FEED` cannot serve as verification evidence for the §4.3 detached installer design.
3. **`autoInstallOnAppQuit = true` is only a backstop, not a guarantee**. `BaseUpdater.js:83-86`: non-zero exit codes skip auto-installation.
4. **Three unhandled events** (`update-cancelled` / `login` / `appimage-filename-updated`) do not throw and do not enter the state machine.
5. **Each check consists of three HTTP requests**: `GitHubProvider.js:43-46` pulls `.atom` feed unconditionally, plus `/releases/latest` and `latest.yml`. Failures converge into `error` events with zero side effects.

### What This Task Proves and Does Not Prove

**Proves**: `packages/desktop/src/main/updater*.test.ts` increases from 0 → 23 tests passing; `npm run typecheck` across six workspaces green; `npx eslint . --quiet` produces no output. Covers: triple activation gate branches, testFeed escape hatch rules/precedence, six event mappings to `UpdateState`, progress deduplication, non-throwing error handling, manual vs scheduled check switches, 30s/4h timers and dispose, install sequencing and idempotence.

**Does not prove**: Real electron-updater feed parsing, version resolution, download, and sha512 verification are not tested here — proven in spec §6.2 dummy release end-to-end (macOS) and §6.3 Windows real machine testing. `quitAndInstall` cannot run outside Electron (`BaseUpdater.js:20` calls `require("electron").autoUpdater`), so injecting a fake backend is the only testable path.

---

## Task 5: Two Increments for `install()` — shutdown Failure Fallback + Installer Watchdog (Design Doc §4.3)

> **This task is an increment on top of Task 4, not a rewrite.** The complete implementation of `install()` (ready gate, single-flight latch, `quitAndInstall(true, true)` only after `await deps.shutdown()`, ordering assertion tests) was landed and verified in Task 4 Steps 14-15. This task only adds the two items genuinely missing in Task 4:
>
> 1. `await deps.shutdown()` was called bare — a shutdown rejection would cause `install()` itself to reject and `quitAndInstall` to never execute, violating §4.3 "install even if cleanup fails";
> 2. In `BaseUpdater.js:16-25`: when `install()` returns false, `quitAndInstall` **does not call `app.quit()`**, only resetting its internal flag and returning `void` (preventing callers from reading the false return). By then `shutdown()` has already stopped recording, stopped workers, and killed AI, with `quitLifecycle` phase already set to `finishing` — the app is alive but non-functional, and the next `before-quit` would be let straight through without cleanup. The only solution is watching the clock.
>
> **Do not** create new harnesses, **do not** rewrite `install()`, and **do not** write a second `runInstall()`. New tests reuse existing `backend` / `svc` / `emitted` / `shutdown` from Task 4's `describe("createUpdaterService: state machine")`.

**Files:**

- Modify: `packages/desktop/src/main/updater.ts` — (a) Add non-exported constant `INSTALL_WATCHDOG_MS` after `CHECK_INTERVAL_MS` in module scope; (b) Add `installWatchdog` beside `let installing = false;` in `createUpdaterService`; (c) In `install()` body from Task 4 Step 15, wrap bare `await deps.shutdown();` in try/catch and arm watchdog after `backend.quitAndInstall(true, true);`; (d) Add two lines clearing watchdog at the top of `dispose()` in the return object.
- Test: `packages/desktop/src/main/updater.test.ts` — Append **2 tests** to existing `describe("createUpdaterService: state machine")` from Task 4.

**Interfaces:**

Consumes (all from the same file from Task 4, no cross-file imports):

```ts
// Produced by Task 4:
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
// Existing internal identifiers modified/reused by this task (names per Task 4):
//   let state: UpdateState;                 // Current state
//   function setState(next: UpdateState)    // Sets state and calls deps.emit(next)
//   let installing = false;                 // Single-flight latch from Task 4, never reset
//   async function install(): Promise<void> // Full implementation from Task 4 Step 15
//   const backend = deps.autoUpdater;
//   dispose: () => { clearTimeout(firstCheckTimer); clearInterval(pollTimer); }
```

Test-side reuse (established in Task 4 Steps 6/7, do not rewrite):

```ts
class FakeBackend implements UpdaterBackend { ... }
//   backend.calls              — quitAndInstall recorded as "quitAndInstall:true:true"
//   backend.fire(event, payload)
// describe("createUpdaterService: state machine") beforeEach already called vi.useFakeTimers()
// and constructed svc; afterEach already called svc.dispose() + vi.useRealTimers().
// shutdown is vi.fn(() => Promise.resolve()), customizable via mockImplementationOnce.
```

Produces (Task 6 IPC layer and Task 7 banner button depend on these **new** semantics; Task 4's four semantics remain unchanged):

```ts
install(): Promise<void>;
// 5. Calls quitAndInstall even when deps.shutdown() rejects, and install() itself never rejects
// 6. If process is still alive 10s after quitAndInstall → transitions to
//    { phase: "error", message: "Update installer failed to take over; please exit gladlog manually and reopen" }
//    and latch is not released: installer spawns at most once per lifecycle
dispose(): void;   // Additionally clears install watchdog
```

### Known Boundaries (do not modify out of turn)

1. **Watchdog only transitions to `error`, deliberately avoiding `app.quit()`.** updater holds no quit dependency; opening a second exit path bypassing `quitLifecycle` is worse than leaving a visible error state. Task 2 "Known Boundaries" item 2 and Task 4 Step 15 comments are unified under this rule.
2. **Watchdog error message text is not a cross-task contract; renderer should not string-match it.** `UpdateBanner` renders nothing for `phase: "error"` by default (§4.2 non-intrusiveness), except when "clicking restart now subsequently enters error" which must render in the top bar — but Task 7's criterion is the **local fact** "install requested in this session" (`installRequested`), **not** string matching: this copy is generated in `src/main/updater.ts`, and renderer can only `import type`. Changing this copy **does not** require modifying Task 7, but requires updating the expected string in Task 5 Step 6 test.
3. **Seeing this error on macOS is expected, not a regression.** `quitAndInstall()` in `MacUpdater.js:240` takes no parameters, delegating to `this.nativeUpdater.quitAndInstall()` (:233) instead of spawn + `app.quit()`. Under ad-hoc signatures it inevitably fails without exiting the process, so running to this step on macOS under `GLADLOG_UPDATER_TEST_FEED` in §6.2 will trigger the watchdog after 10s. **Observations on macOS cannot serve as verification evidence for the §4.3 design.**
4. **Real `quitAndInstall` cannot run outside Electron**: `BaseUpdater.js:20` calls `require("electron").autoUpdater.emit("before-quit-for-update")`. This task is tested entirely against injected `FakeBackend`; sequencing and watchdog are behavioral assertions, not integration verification.
5. **Timing between watchdog and `dispose()` is intentional.** On the success path, `app.quit()` inside `quitAndInstall` triggers `before-quit`, and Task 6's second listener immediately calls `dispose()`, clearing the watchdog — the process is exiting, so no alert is needed. It catches the **alternate** path: when `BaseUpdater.install()` returns false, `quitAndInstall` does not call `app.quit()`, so there is no `before-quit` or `dispose()`, and the watchdog enters `error` after 10s as intended. "Installer started but quit was vetoed by another listener" is **outside coverage scope**; do not add quit dependencies to updater for it.

### Steps

- [ ] **Step 1: Confirm baseline is green and locate three anchors**

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Tests  22 passed (22)` (Task 4 deliverables). **If not green, fix Task 4 first; do not proceed on a broken base.**

  Open `packages/desktop/src/main/updater.ts` and note three anchors: (a) module scope line `export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;`; (b) inside `createUpdaterService`, line `let installing = false;`; (c) `async function install()` body and `dispose` in the return object. Subsequent steps modify only these three locations.

- [ ] **Step 2: Write failing test — "install even if shutdown throws"**

  In `updater.test.ts`, append at the end of `describe("createUpdaterService: state machine")` (after the three install tests from Task 4 Step 14):

  ```ts
  /**
   * §4.3: a failed teardown must not strand the user on an old build. The
   * update is already downloaded and sha512-verified at this point; refusing
   * to install it because OBS would not close cleanly trades a small risk for
   * a permanent one.
   */
  it("install(): installs even if shutdown throws, and install() itself does not reject", async () => {
    shutdown.mockImplementationOnce(() =>
      Promise.reject(new Error("obs teardown failed")),
    );
    backend.fire("update-downloaded", { version: "0.1.20" });
    await expect(svc.install()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(backend.calls).toContain("quitAndInstall:true:true");
  });
  ```

  Uses `shutdown.mockImplementationOnce` instead of creating a new service: `shutdown` in this describe is already `vi.fn(() => Promise.resolve())`, overriding it once suffices.

- [ ] **Step 3: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Tests  1 failed | 22 passed (23)`. Failure details:

  ```
  AssertionError: promise rejected "Error: obs teardown failed" instead of resolving
  ```

  (If this test passes with `Tests 23 passed (23)`, someone previously wrapped `await deps.shutdown()` in try/catch in Task 4 — skip Step 4 and proceed to Step 6.)

- [ ] **Step 4: Minimal implementation — wrap shutdown in try/catch**

  In `updater.ts` inside `install()`, replace the bare call from Task 4:

  ```ts
  await deps.shutdown();
  ```

  with:

  ```ts
  try {
    await deps.shutdown();
  } catch {
    // Best effort, same philosophy as quitLifecycle's own internal catches:
    // a failed teardown must not strand the user on an old build. The update
    // is downloaded and sha512-verified already — go install it.
  }
  ```

  **Delete the obsolete comment directly above it** (from Task 4 Step 15):

  ```ts
  // Deliberately NOT wrapped in try/catch yet: making a failed teardown
  // still install is the next task's first increment (spec §4.3), and
  // adding it here would turn that task's red step green.
  ```

  Keep the preceding comment explaining `deps.shutdown` = `quitLifecycle.shutdown` (`// installer detached and only then calls app.quit()` …), which remains accurate.

  Leave all other parts of `install()` untouched.

- [ ] **Step 5: Run test to confirm pass + commit**

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Tests  23 passed (23)`.

  ```bash
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "fix(desktop): install() installs even if teardown fails — shutdown reject no longer swallows installer"
  ```

- [ ] **Step 6: Write failing test — installer watchdog**

  Append to the same describe (directly after Step 2 test):

  ```ts
  /**
   * BaseUpdater.js:16-25 — when install() returns false (nothing downloaded,
   * spawn failed) quitAndInstall skips its own app.quit() and just resets the
   * flag, returning void either way, so we cannot read the failure. By then
   * shutdown() has already stopped the recorder / worker / AI children and
   * quitLifecycle's phase is "finishing", meaning the next before-quit is let
   * straight through with no cleanup: the app is alive but gutted. Watch the
   * clock instead.
   */
  it("install(): installer does not take over (process still alive after 10s) → enters error, and does not spawn a second", async () => {
    backend.fire("update-downloaded", { version: "0.1.20" });
    await svc.install();
    expect(backend.calls).toContain("quitAndInstall:true:true");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.getState()).toEqual({
      phase: "error",
      message: "Update installer failed to take over; please exit gladlog manually and reopen",
    });
    expect(emitted.at(-1)).toEqual(svc.getState());

    // The latch stays shut on purpose: if the installer DID spawn and only the
    // quit got blocked, a retry would run two installers over one directory.
    await svc.install();
    expect(
      backend.calls.filter((c) => c.startsWith("quitAndInstall")),
    ).toHaveLength(1);
  });
  ```

- [ ] **Step 7: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Tests  1 failed | 23 passed (24)`. Failure details:

  ```
  AssertionError: expected { phase: 'ready', version: '0.1.20' } to deeply equal { phase: 'error', message: 'Update installer failed to take over; please exit gladlog manually and reopen' }
  ```

- [ ] **Step 8: Implement watchdog**

  (a) In module scope, below `export const CHECK_INTERVAL_MS = ...;`, add:

  ```ts
  /** How long quitAndInstall gets to actually take the process down before we
   *  declare the handover failed. Deliberately NOT exported: the test asserts
   *  against the literal 10_000, so silently stretching this window fails CI. */
  const INSTALL_WATCHDOG_MS = 10_000;
  ```

  (b) In `createUpdaterService`, below `let installing = false;`, add:

  ```ts
  let installWatchdog: ReturnType<typeof setTimeout> | null = null;
  ```

  (c) In `install()`, directly following `backend.quitAndInstall(true, true);` within the same `try` block, insert:

  ```ts
  // BaseUpdater.quitAndInstall (BaseUpdater.js:16-25) skips its own
  // app.quit() when install() returned false and returns void either way —
  // we cannot read that. So watch the clock: still breathing 10s later
  // means the installer never took over, and by now the recorder / worker /
  // AI children are already gone. Say so instead of leaving a silently
  // gutted app alive. Two deliberate non-actions: the `installing` latch is
  // NOT released (a retry could run two installers over one directory), and
  // we do NOT app.quit() from here (updater holds no quit dependency, and a
  // second exit path bypassing quitLifecycle is worse than a visible error).
  installWatchdog = setTimeout(() => {
    installWatchdog = null;
    setState({
      phase: "error",
      message: "Update installer failed to take over; please exit gladlog manually and reopen",
    });
  }, INSTALL_WATCHDOG_MS);
  ```

  (d) Clean up the comment at the end of `install()`: update "added in the next task" to "armed right above", or remove if redundant.

  (e) In the return object `dispose`, add lines at the top:

  ```ts
      dispose: () => {
        // The install watchdog is a live 10s timer; leaving it behind keeps a
        // vitest worker (and, in production, the process) awake after dispose.
        if (installWatchdog) clearTimeout(installWatchdog);
        installWatchdog = null;
        clearTimeout(firstCheckTimer);
        clearInterval(pollTimer);
      },
  ```

- [ ] **Step 9: Run test to confirm pass**

  ```bash
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Tests  24 passed (24)`.

- [ ] **Step 10: Full regression + commit**

  ```bash
  npm test --workspace=packages/desktop
  ```

  Baseline was **136 files / 938 tests passed** (verified on 2026-08-02). Running through this task end yields 938 + 6 (T1) + 5 (T2) + 3 (T3) + 23 (T4) + **2 (this task)** = **977**. Report only net delta +2 for this task.

  ```bash
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): install() watchdog — enters error when installer fails to take over instead of leaving hollow app"
  ```

---

## Task 6: IPC + preload + `main/index.ts` Wiring (Design Doc §4.4 / §4.2 Config Block / §4.7 lastSeenVersion)

> Wire Task 4/5 services to the process boundary: three `ipcMain.handle` endpoints + one `webContents.send` push channel, preload bridge, main process initialization with `autoUpdater.logger` wiring, plus a renderer-side consumer helper **immune to missing bridge surfaces** — without this error tolerance, Task 7 components would fail existing tests (whose bridge stubs lack update surfaces).
>
> **Timers do not belong to this task.** The 30s first check / 4h poll are single-sourced in `updater.ts` via `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS`, with `createUpdaterService` containing its own `setTimeout`/`setInterval` (Task 4 Step 12). The wiring **must not** re-declare these constants or construct a second set of timers — which would issue duplicate `checkForUpdates` per tick and duplicate the literal values (violating CLAUDE.md). This task is only responsible for calling `dispose()` on exit.
>
> This task touches no visible UI. After completion, `npm run dev` reports status `disabled/dev`, with zero pixel changes on the UI.

**Files:**

- Modify: `packages/desktop/src/main/ipc.ts` — add type import below `:21` (`import type { RecorderService } from "./recorder";`); add one line to `registerIpc` deps below `:41` (`recorder: RecorderService;`); insert three handles after `:147`
- Modify: `packages/desktop/src/preload/api.ts` — add type import below `:6`; insert `update` block after `:101` (closing `};` of `app: { … };` block)
- Modify: `packages/desktop/src/preload/index.ts` — insert `update` block after `:48-54` `app: { … },` block
- Modify: `packages/desktop/src/main/index.ts` — add `dirname` to `import { join } from "path";` at `:3`, add `fs` and updater imports after `:35`; insert wiring block after `:82`; add one line to `registerIpc({ … })` deps at `:270-290`; insert `initUpdater()` call after `:290` closing `});` and before `:291` `learning.init();`
- Create: `packages/desktop/src/renderer/src/update/updateBridge.ts`
- Test (Create): `packages/desktop/test/updateChannels.test.ts` (2 tests)
- Test (Create): `packages/desktop/test/updateBridge.test.ts` (7 tests)

(Line numbers verified on 2026-08-03 in this worktree. **`fixtureBridge.ts` is intentionally not in the list** — see "Known Boundaries" item 2.)

**Interfaces:**

Consumes:

```ts
// Task 2 (quitLifecycle.ts)
shutdown(): Promise<void>;
// Task 3 (settingsStore.ts) — Two new fields on GladlogSettings
autoCheckUpdates: boolean;      // DEFAULTS = true
lastSeenVersion: string | null; // DEFAULTS = null
// Task 4 (updater.ts)
export function evaluateGate(env: UpdaterEnv): GateResult;
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
export type UpdateState = ...; export interface UpdaterEnv { ... }
export const FIRST_CHECK_DELAY_MS; export const CHECK_INTERVAL_MS;
//   ↑ Timing intervals are single-sourced in updater.ts with built-in timers; wiring must not build a second set.
//     This task does not even need to import them.
// Task 5: install() watchdog + shutdown failure fallback
```

Produces (Task 7 banner and Task 8 settings page depend entirely on this layer):

```ts
// IPC Channels (string constants, verified across 3 locations by test/updateChannels.test.ts)
"gladlog:update:getState" | "gladlog:update:check" | "gladlog:update:install"
"gladlog:update:state"  // main → renderer push

// packages/desktop/src/preload/api.ts — GladlogApi adds a block
update: {
  getState(): Promise<UpdateState>;
  check(): Promise<void>;
  install(): Promise<void>;
  onState(cb: (s: UpdateState) => void): () => void;
};

// packages/desktop/src/renderer/src/update/updateBridge.ts — All immune to missing stubs
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateCheck(): Promise<void>;
export function requestUpdateInstall(): Promise<void>;
/** Whether stub/environment exposes the update surface (Task 8 settings uses this to render "Auto-update not available in this environment") */
export function hasUpdateSurface(): boolean;
/** Startup version ≠ last remembered version → returns current version (§4.7 trace); first launch / same version → null */
export function resolveVersionNotice(): Promise<string | null>;
/** User dismisses trace notice → writes back lastSeenVersion */
export function dismissVersionNotice(version: string): Promise<void>;
```

**The §4.7 trace predicate (fetch version / compare / silent write-back on null / dismiss write-back) exists solely in `resolveVersionNotice` + `dismissVersionNotice`.** Task 7's `UpdateBanner` must `import` them, and Task 8's `SettingsPanel` must use `fetchUpdateState` / `subscribeUpdateState` / `requestUpdateCheck` / `hasUpdateSurface`. They **must not** inline duplicate comparison logic or duplicate `surface()` fallback helpers in components.

### Known Boundaries (do not modify out of turn)

1. **IPC layer has no unit tests directly calling it.** `registerIpc` is defined in `ipc.ts:32-50`, whose sole call site is `index.ts:270-290`; no tests import it and `ipc.ts` has no `.test.ts`. Step 1's channel test performs **text reconciliation** (ensuring string literals across three unimported files have no typos). Behavioral correctness of the update surface relies on `updater.test.ts`.
2. **`fixtureBridge.ts` deliberately does not add an `update` surface**, synchronized with comments above `lastSeenVersion` in Task 7 **Step 20** ("This file also has NO `update` surface on purpose …") (Global Ruling 6). Desired outcomes: (a) UI under fixture preview and visual baselines does not render update UI, keeping Task 7/8 pixel baselines unchanged; (b) no `lastCheckedAt` rendered, preventing `settings.png` from drifting with wall-clock time. **Typecheck safety verified**: `fixtureBridge.ts:359` uses `window.__gladlogFixture = gladlogMock as any;`, so adding required fields to `GladlogApi` will not fail typecheck; while `preload/index.ts:17` `const api: GladlogApi = {` lacks `as any` and **must be updated** (Step 7).
3. **The second `before-quit` listener is intentional**: `preventDefault()` does not block subsequent listeners on the same event, and `quitLifecycle` dependencies have a fixed shape; do not add dependencies for `dispose()`.
4. **`evaluateGate` evaluates in module scope and throws on invalid `GLADLOG_UPDATER_TEST_FEED`**, before window creation. This is intentional per §4.2.1 (invalid values throw rather than silently falling back to production feeds); dev / E2E never reach it (`!isPackaged → dev` is checked before testFeed), and packaged users never set it unless debugging packaged builds with typos.

### Steps

- [ ] **Step 1: Write failing channel name consistency test**

  IPC channel names are string literals shared by three mutually unimported files: a single typo passes typecheck but produces a dead button at runtime. Create `packages/desktop/test/updateChannels.test.ts`:

  ```ts
  import { readFileSync } from "fs";
  import { join } from "path";
  import { describe, expect, it } from "vitest";

  /**
   * Drift guard, same shape as diagnosticLevel.test.ts's "upstream invariant
   * codes" test: an IPC channel name is a string literal shared by three files
   * that never import each other, so a typo type-checks fine and only shows up
   * at runtime as a button that does nothing.
   */
  const read = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf-8");

  describe("Auto-update IPC channel names match across three locations (design doc §4.4)", () => {
    const ipc = read("src/main/ipc.ts");
    const mainIndex = read("src/main/index.ts");
    const preload = read("src/preload/index.ts");

    it("main registers three handles, index pushes state and routes logs into electron-log", () => {
      for (const ch of [
        "gladlog:update:getState",
        "gladlog:update:check",
        "gladlog:update:install",
      ]) {
        expect(ipc).toContain(`ipcMain.handle("${ch}"`);
      }
      expect(mainIndex).toContain(`webContents.send("gladlog:update:state"`);
      // §4.2: without this line electron-updater keeps its default `console`
      // logger (AppUpdater.js:179) and the "Checking for update" / "Found
      // version X" lines never reach ~/Library/Logs/gladlog/main.log — which is
      // the only evidence channel the §6.2 dummy-release verification reads.
      // No trailing semicolon in the match: a structural-typing cast on the
      // right-hand side must still satisfy this guard.
      expect(mainIndex).toContain("autoUpdater.logger = log");
    });

    it("preload exposes all four channels", () => {
      for (const ch of [
        "gladlog:update:getState",
        "gladlog:update:check",
        "gladlog:update:install",
        "gladlog:update:state",
      ]) {
        expect(preload).toContain(`"${ch}"`);
      }
    });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateChannels.test.ts
  ```

  Expected: both tests fail, with message:

  ```
  AssertionError: expected 'import { writeFile } from "node:fs/pr…' to contain 'ipcMain.handle("gladlog:update:getState"'
  ```

- [ ] **Step 3: `ipc.ts` — add updater to deps**

  In `packages/desktop/src/main/ipc.ts:21` (below `import type { RecorderService } from "./recorder";`), add:

  ```ts
  import type { UpdaterService } from "./updater";
  ```

  In deps object type below `recorder: RecorderService;` (:41), add:

  ```ts
  /** Auto-update (§4.4). Only the three renderer-facing methods: the push
   *  channel is emitted by main/index.ts (which owns the window handle), same
   *  split as compare/analysis/learning. */
  updater: Pick<UpdaterService, "getState" | "check" | "install">;
  ```

- [ ] **Step 4: `ipc.ts` — three handles**

  Below `ipcMain.handle("gladlog:app:getVersion", () => app.getVersion());` (:147), insert:

  ```ts
  // Auto-update (2026-08-02, design doc §4.4). getState is the pull side: the
  // renderer mounts later than the first push, so a snapshot getter is
  // mandatory — same shape as logs:getStatus. check() deliberately ignores the
  // autoCheckUpdates toggle (§4.2: turning automatic checks off must still
  // leave a manual entry point, or that switch kills the feature outright).
  ipcMain.handle("gladlog:update:getState", () => deps.updater.getState());
  ipcMain.handle("gladlog:update:check", () => deps.updater.check());
  ipcMain.handle("gladlog:update:install", () => deps.updater.install());
  ```

- [ ] **Step 5: `preload/api.ts` — type surface**

  In `packages/desktop/src/preload/api.ts:6` (below `import type { RecorderStatus } from "../main/recorder";`), add (**must be `import type`**):

  ```ts
  import type { UpdateState } from "../main/updater";
  ```

  Below closing `};` of `app: { … };` block (:101), insert:

  ```ts
    /** Windows NSIS auto-update (2026-08-02). The surface exists on every
     * platform — elsewhere getState() is a constant `disabled`, so the renderer
     * never branches on process.platform. */
    update: {
      getState(): Promise<UpdateState>;
      /** Manual check; ignores the autoCheckUpdates setting on purpose. */
      check(): Promise<void>;
      /** Runs the whole quit chain and then hands over to the installer;
       * no-op unless the state is "ready" (§4.3). */
      install(): Promise<void>;
      onState(cb: (s: UpdateState) => void): () => void;
    };
  ```

- [ ] **Step 6: Run typecheck to confirm failure (two errors)**

  ```bash
  npm run typecheck --workspace=packages/desktop
  ```

  Expected: **exactly two** errors:

  ```
  src/main/index.ts(270,5): error TS2345: Argument of type '{ recorder: RecorderService; store: MatchStore; ... }' is not assignable to parameter of type '{ ... updater: Pick<UpdaterService, "getState" | "check" | "install">; ... }'.
    Property 'updater' is missing in type '{ recorder: ...; }' but required in type '{ ...; updater: Pick<UpdaterService, "getState" | "check" | "install">; ... }'.
  src/preload/index.ts(17,7): error TS2741: Property 'update' is missing in type '{ logs: { ... }' but required in type 'GladlogApi'.
  ```

- [ ] **Step 7: `preload/index.ts` — bridge implementation**

  Below `app: { … },` block (:48-54), insert:

  ```ts
    update: {
      getState: () => ipcRenderer.invoke("gladlog:update:getState"),
      check: () => ipcRenderer.invoke("gladlog:update:check"),
      install: () => ipcRenderer.invoke("gladlog:update:install"),
      onState: sub("gladlog:update:state"),
    },
  ```

- [ ] **Step 8: Run typecheck to confirm only one error remains**

  ```bash
  npm run typecheck --workspace=packages/desktop
  ```

  Expected: `src/preload/index.ts(17,7)` disappears, leaving only `src/main/index.ts(270,5)`.

- [ ] **Step 9: `main/index.ts` — imports and module-scope wiring**

  Change `import { join } from "path";` at :3 to:

  ```ts
  import { dirname, join } from "path";
  ```

  Below `import { e2eUserDataDir } from "./e2eEnv";` (:35), add:

  ```ts
  import { readdirSync } from "fs";
  import {
    createUpdaterService,
    evaluateGate,
    type UpdaterEnv,
    type UpdaterService,
    type UpdateState,
  } from "./updater";
  ```

  Below `app.on("before-quit", (event) => quitLifecycle.onBeforeQuit(event));` (:82), insert:

  ```ts
  // Auto-update wiring (design doc §4.2/§4.4). The gate is evaluated
  // synchronously right here so getState() can answer correctly from the very
  // first IPC call, but electron-updater itself is imported only after the gate
  // passes: it pulls in js-yaml + fs-extra + semver + lodash on EVERY start
  // otherwise, and cold start is budgeted at 2600ms (qa/budgets.ts:44).
  const updaterEnv: UpdaterEnv = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    execDir: dirname(process.execPath),
    readDir: (dir) => readdirSync(dir),
    // Passed straight through, with no GLADLOG_E2E special-casing: evaluateGate
    // checks `!isPackaged → dev` BEFORE it validates the test feed, so a dev or
    // E2E run can never throw on a stale value left in a developer's shell.
    // Zeroing it out under E2E would instead break §6.2 — the dummy-release
    // client is a PACKAGED build launched with both GLADLOG_E2E=1 (userData
    // isolation) and GLADLOG_UPDATER_TEST_FEED.
    testFeed: process.env["GLADLOG_UPDATER_TEST_FEED"],
  };
  // The same predicate on both sides: evaluateGate is exported precisely so this
  // call site cannot drift from the one inside createUpdaterService (CLAUDE.md —
  // one predicate, two importers).
  const updaterGate = evaluateGate(updaterEnv);
  let updaterService: UpdaterService | null = null;

  function pushUpdateState(state: UpdateState): void {
    win?.webContents.send("gladlog:update:state", state);
  }

  /** IPC-facing facade: valid before initUpdater() has finished loading
   *  electron-updater, and delegating forever after. */
  const updaterFacade = {
    getState: (): UpdateState =>
      updaterService?.getState() ??
      (updaterGate.ok
        ? { phase: "idle", lastCheckedAt: null }
        : { phase: "disabled", reason: updaterGate.reason }),
    check: async (): Promise<void> => {
      await updaterService?.check();
    },
    install: async (): Promise<void> => {
      await updaterService?.install();
    },
  };

  async function initUpdater(): Promise<void> {
    if (!updaterGate.ok) {
      log.info(`[updater] disabled: ${updaterGate.reason}`);
      pushUpdateState(updaterFacade.getState());
      return;
    }
    // electron-updater is CommonJS and exposes `autoUpdater` as an
    // Object.defineProperty getter, which cjs-module-lexer does NOT detect:
    // under node ESM `(await import("electron-updater")).autoUpdater` is
    // undefined (verified 2026-08-02 — the namespace keys are AppUpdater,
    // NsisUpdater, …, default). The value has to be read off module.exports,
    // which node exposes as `default`.
    const mod = await import("electron-updater");
    const autoUpdater = (mod as unknown as { default: typeof mod }).default
      .autoUpdater;
    // §4.2: route electron-updater's own logs into electron-log. Without this
    // the AppUpdater keeps its default `console` logger (AppUpdater.js:179) and
    // the "Checking for update" / "Found version X" lines never reach
    // ~/Library/Logs/gladlog/main.log — the evidence channel the §6.2
    // dummy-release verification reads. `log` is already imported at :2.
    autoUpdater.logger = log;
    updaterService = createUpdaterService({
      autoUpdater,
      env: updaterEnv,
      now: () => Date.now(),
      emit: pushUpdateState,
      // §4.3: exactly one cleanup chain — install() awaits this before the NSIS
      // installer is spawned.
      shutdown: () => quitLifecycle.shutdown(),
      isAutoCheckEnabled: () => settings.get().autoCheckUpdates,
    });
    log.info(
      `[updater] armed${
        updaterGate.feed
          ? ` (test feed ${updaterGate.feed.owner}/${updaterGate.feed.repo})`
          : ""
      }`,
    );
    // The 30s first check and the 4h poll are started by createUpdaterService
    // itself (updater.ts FIRST_CHECK_DELAY_MS / CHECK_INTERVAL_MS). Do NOT add
    // timers here: a second set would double every check and fork that interval
    // into two literals that drift silently.
    pushUpdateState(updaterService.getState());
  }

  // A second before-quit listener rather than a new quitLifecycle dependency:
  // its dependency shape is fixed, and preventDefault from the first listener
  // does not stop the remaining ones from running. dispose() stops the service's
  // own 30s/4h timers (without it the 4h setInterval keeps the process alive)
  // and cancels any armed install watchdog — on the success path the process is
  // going away anyway; the failure path (BaseUpdater.install() returned false,
  // so quitAndInstall never called app.quit()) never reaches before-quit at
  // all, which is exactly why the watchdog still fires there.
  app.on("before-quit", () => {
    updaterService?.dispose();
  });
  ```

  If typing error occurs on `autoUpdater.logger = log`, cast as: `autoUpdater.logger = log as unknown as typeof autoUpdater.logger;`.

- [ ] **Step 10: `main/index.ts` — wire up in whenReady**

  In `registerIpc({` deps (starting :270, below `recorder,`), add:

  ```ts
      updater: updaterFacade,
  ```

  Below `registerIpc({ … });` closing `});` (:290) and before `learning.init();` (:291), add:

  ```ts
  // Must come after registerIpc: pushUpdateState writes to win.webContents,
  // and win is created above in this same block.
  void initUpdater().catch((e) => log.error("[updater] init failed:", e));
  ```

- [ ] **Step 10b: Timer single-source self-check (Global Ruling 4 guard)** — Run (at worktree root):

  ```bash
  grep -nE "setTimeout|setInterval|30_000|4 \* 60 \* 60|FIRST_CHECK_DELAY_MS|CHECK_INTERVAL_MS" packages/desktop/src/main/index.ts
  ```

  Expected: **no output** (grep exit code 1). No timers or interval constants are allowed in the wiring.

- [ ] **Step 11: Channel test green + typecheck green + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateChannels.test.ts
  npm run typecheck --workspace=packages/desktop
  ```

  Expected: `Tests  2 passed (2)`; typecheck exit code 0.

  ```bash
  git add packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts packages/desktop/test/updateChannels.test.ts
  git commit -m "feat(desktop): auto-update IPC/preload/main process wiring — 3 handles + state push + electron-log takeover

Timers owned by updaterService (updater.ts FIRST_CHECK_DELAY_MS /
CHECK_INTERVAL_MS single source); wiring only disposes on before-quit.
GLADLOG_UPDATER_TEST_FEED passes through: gate order !isPackaged → dev runs
before testFeed validation so dev/E2E never hit validation, while §6.2 packaged
client activates correctly."
  ```

- [ ] **Step 12: Write failing renderer helper tests**

  Create `packages/desktop/test/updateBridge.test.ts`:

  ```ts
  // @vitest-environment jsdom
  import { beforeEach, describe, expect, it } from "vitest";

  import type { UpdateState } from "../src/main/updater";
  import {
    dismissVersionNotice,
    fetchUpdateState,
    hasUpdateSurface,
    requestUpdateCheck,
    requestUpdateInstall,
    resolveVersionNotice,
    subscribeUpdateState,
  } from "../src/renderer/src/update/updateBridge";

  function installStub(stub: Record<string, unknown>) {
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture =
      stub;
  }

  beforeEach(() => {
    installStub({});
  });

  describe("updateBridge is immune to missing bridge surfaces", () => {
    it("when stub lacks update surface: reading state returns null, subscribing returns a callable unsubscriber, check/install do not throw", async () => {
      expect(hasUpdateSurface()).toBe(false);
      expect(await fetchUpdateState()).toBe(null);
      const off = subscribeUpdateState(() => {});
      expect(() => off()).not.toThrow();
      await expect(requestUpdateCheck()).resolves.toBeUndefined();
      await expect(requestUpdateInstall()).resolves.toBeUndefined();
    });

    it("when stub has update surface: passes state through, forwards pushes, unsubscription reaches underlying listener", async () => {
      let pushed: ((s: UpdateState) => void) | null = null;
      let offCount = 0;
      let checked = 0;
      let installed = 0;
      installStub({
        update: {
          getState: async (): Promise<UpdateState> => ({
            phase: "ready",
            version: "0.1.20",
          }),
          check: async () => {
            checked += 1;
          },
          install: async () => {
            installed += 1;
          },
          onState: (cb: (s: UpdateState) => void) => {
            pushed = cb;
            return () => {
              offCount += 1;
            };
          },
        },
      });
      expect(hasUpdateSurface()).toBe(true);
      expect(await fetchUpdateState()).toEqual({
        phase: "ready",
        version: "0.1.20",
      });
      const seen: UpdateState[] = [];
      const off = subscribeUpdateState((s) => seen.push(s));
      pushed!({ phase: "checking" });
      expect(seen).toEqual([{ phase: "checking" }]);
      off();
      expect(offCount).toBe(1);
      await requestUpdateCheck();
      await requestUpdateInstall();
      expect([checked, installed]).toEqual([1, 1]);
    });
  });

  describe("§4.7 update trace: lastSeenVersion comparison", () => {
    function stubSettings(lastSeenVersion: string | null, version = "0.1.20") {
      const saved: Array<Record<string, unknown>> = [];
      installStub({
        app: { getVersion: async () => version },
        settings: {
          get: async () => ({ lastSeenVersion }),
          save: async (p: Record<string, unknown>) => {
            saved.push(p);
            return {};
          },
        },
      });
      return saved;
    }

    it("first launch (lastSeenVersion=null) does not announce, silently remembers current version", async () => {
      const saved = stubSettings(null);
      expect(await resolveVersionNotice()).toBe(null);
      expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
    });

    it("version changed → returns current version, and does not write back yet (writes only when dismissed by user)", async () => {
      const saved = stubSettings("0.1.19");
      expect(await resolveVersionNotice()).toBe("0.1.20");
      expect(saved).toEqual([]);
    });

    it("same version → null, does not write back", async () => {
      const saved = stubSettings("0.1.20");
      expect(await resolveVersionNotice()).toBe(null);
      expect(saved).toEqual([]);
    });

    it("dismissing trace notice → writes back lastSeenVersion", async () => {
      const saved = stubSettings("0.1.19");
      await dismissVersionNotice("0.1.20");
      expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
    });

    it("stub completely lacks settings/app surfaces → null, does not throw", async () => {
      expect(await resolveVersionNotice()).toBe(null);
      await expect(dismissVersionNotice("0.1.20")).resolves.toBeUndefined();
    });
  });
  ```

- [ ] **Step 13: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  Expected: failure due to missing file `../src/renderer/src/update/updateBridge`.

- [ ] **Step 14: Implement renderer helper**

  Create `packages/desktop/src/renderer/src/update/updateBridge.ts`:

  ```ts
  import type { UpdateState } from "../../../main/updater";
  import { bridge } from "../bridge";

  /**
   * Renderer-side entry point for auto-update, and the ONLY copy of the §4.7
   * lastSeenVersion predicate — UpdateBanner and SettingsPanel import from here
   * rather than re-deriving it (CLAUDE.md: one predicate, two importers).
   *
   * Every call is wrapped in try/catch for exactly one reason: the bridge stubs
   * used by the fixture preview and by ~40 component tests only implement the
   * surfaces they need, so `bridge().update` is frequently undefined and the
   * property access throws synchronously. Same precedent as App.tsx's settings
   * stub (App.tsx:45-55) and the auto-analyze listener (App.tsx:57-67) — a
   * missing surface degrades to "no update information", never to a crashed view.
   */
  export function subscribeUpdateState(
    cb: (s: UpdateState) => void,
  ): () => void {
    try {
      return bridge().update.onState(cb);
    } catch {
      return () => {};
    }
  }

  export async function fetchUpdateState(): Promise<UpdateState | null> {
    try {
      return await bridge().update.getState();
    } catch {
      return null;
    }
  }

  export async function requestUpdateCheck(): Promise<void> {
    try {
      await bridge().update.check();
    } catch {
      // Failures land in the pushed state (§4.2: never interrupt the user).
    }
  }

  export async function requestUpdateInstall(): Promise<void> {
    try {
      await bridge().update.install();
    } catch {
      // Same as above; install() is a no-op unless the state is "ready".
    }
  }

  /** Whether this environment exposes the update surface at all. The settings
   *  page renders "Auto-update not available in this environment" when it does not — which is the case
   *  under the fixture preview and in every component test stub. */
  export function hasUpdateSurface(): boolean {
    try {
      return typeof bridge().update?.getState === "function";
    } catch {
      return false;
    }
  }

  /**
   * §4.7: auto-update is invisible by design, so the first launch on a new build
   * leaves a trace. Returns the version to announce, or null when there is
   * nothing to say.
   */
  export async function resolveVersionNotice(): Promise<string | null> {
    try {
      const [version, settings] = await Promise.all([
        bridge().app.getVersion(),
        bridge().settings.get(),
      ]);
      const seen = settings.lastSeenVersion ?? null;
      if (seen === version) return null;
      if (seen === null) {
        // Fresh install (or a settings file predating this field): nothing to
        // announce. Record it now, otherwise the notice would fire on the next
        // launch of the very same build.
        await bridge().settings.save({ lastSeenVersion: version });
        return null;
      }
      return version;
    } catch {
      return null;
    }
  }

  export async function dismissVersionNotice(version: string): Promise<void> {
    try {
      await bridge().settings.save({ lastSeenVersion: version });
    } catch {
      // Nothing to do: worst case the notice shows once more next launch.
    }
  }
  ```

- [ ] **Step 15: Run test to confirm pass**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  Expected: `Tests  7 passed (7)`.

- [ ] **Step 16: Full regression + pre-push trio**

  ```bash
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  Expected: all tests pass. Baseline **136 files / 938 tests passed**; running to this task end yields 938 + 6 (T1) + 5 (T2) + 3 (T3) + 23 (T4) + 2 (T5) + **9 (this task)** = **986**. Report net delta +9. Typecheck and eslint exit code 0.

- [ ] **Step 17: Commit**

  ```bash
  git add packages/desktop/src/renderer/src/update/updateBridge.ts packages/desktop/test/updateBridge.test.ts
  git commit -m "feat(desktop): update surface renderer helper — single-sourced §4.7 trace predicate + fallback when update surface missing"
  ```

- [ ] **Step 18: dev smoke test (acceptance criteria for this task)**

  ```bash
  npm run dev --workspace=packages/desktop
  ```

  All three criteria must be satisfied:

  1. Terminal displays `[updater] disabled: dev` — **must be `dev`, not `platform`**.
  2. Terminal has **no** `electron-updater` errors or unhandled rejections.
  3. In DevTools console, executing `await window.gladlog.update.getState();` returns `{ phase: "disabled", reason: "dev" }`.

  UI remains pixel-for-pixel identical to before.

- [ ] **Step 19: Record before-and-after metrics**

  - Existing tests: 136 files / 938 tests → net increase **+9** (`updateChannels` 2 + `updateBridge` 7), all green.
  - Cold start: median of `coldStart.spec.ts` under `npm run test:e2e --workspace=packages/desktop` remains < 2600ms (`qa/budgets.ts:44`).

---

## Task 7: UpdateBanner Component + App Wiring (spec §4.5 / §4.7)

**Files:**

- Create: `packages/desktop/src/renderer/src/components/UpdateBanner.tsx`
- Create: `packages/desktop/test/updateBanner.test.tsx`
- Modify: `packages/desktop/src/renderer/src/App.tsx` (:1-19 import area; :180-193 `<header className="app-topbar">` block — verified in real file)
- Modify: `packages/desktop/src/renderer/src/styles.css` (insert after :111 — closing `}` of `.app-topbar h1::after` rule block — and before :112 long comment)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts` (`currentSettings` literal, previously :34-47; after Task 3 adds `autoCheckUpdates` / `lastSeenVersion` it becomes :34-49, this task only edits the `lastSeenVersion` line)
- Test: `packages/desktop/test/updateBanner.test.tsx` (new)
- Regressions (**two test nets**, neither modifies code, run only; verified on 2026-08-03):
  - `packages/desktop/test/app.backgroundload.test.tsx` (2 tests) — `render(<App />)` at :46, bridge stub at :33-45 (`window.__gladlogFixture`), contains only `matches` / `logs` / `settings`, no `update` / `recorder` / `app`
  - `packages/desktop/src/renderer/src/App.pagination.test.tsx` (3 tests) — `render(<App />)` at :48 / :70 / :88, using `vi.mock("./bridge")` (:7) module mock + `mockReturnValue({ matches, logs, settings })` (:39-43); the test case stub at :60 adds `app: { selectDirectory }` (:68) but **lacks `getVersion`**, pressing the exact path where `bridge().app.getVersion()` throws synchronously in `resolveVersionNotice()` — covering the secondary failure mode where `app` surface exists but methods are missing.
    These two nets have different stub shapes and jointly exercise the three error-tolerant paths in UpdateBanner (`updateBridge` internal try/catch, `recorderSurface()`, `resolveVersionNotice()` catch). **These are the only two files mounting `<App/>` across the entire repo** (criterion: `grep -rn "render(<App" packages/desktop/src packages/desktop/test`).

**Interfaces:**

Consumes:

```ts
// packages/desktop/src/main/updater.ts — Must be `import type`; value import pulls
// electron-updater into renderer bundle, breaking build:ui / visual regression webServer
export type UpdateState =
  | { phase: "disabled"; reason: "platform" | "dev" | "portable" }
  | { phase: "idle"; lastCheckedAt: number | null }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

// packages/desktop/src/renderer/src/update/updateBridge.ts — Created in Task 6,
// sole update surface entry for this component (immune to missing stubs, internal try/catch)
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateInstall(): Promise<void>;
/** Startup version ≠ last remembered version → returns current version (§4.7); first launch / same version → null */
export function resolveVersionNotice(): Promise<string | null>;
/** User dismisses trace notice → writes back lastSeenVersion */
export function dismissVersionNotice(version: string): Promise<void>;

// Existing, untouched:
// packages/desktop/src/main/recorder.ts:37-42
export interface RecorderStatus {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
}
// packages/desktop/src/preload/api.ts:319 — recorder.onStatus(cb: (s: RecorderStatus) => void): () => void
//                    api.ts:294-295 — recorder.getStatus(): Promise<RecorderStatus>
// packages/desktop/src/renderer/src/batch/batchAnalysis.ts:69/:73
export function getBatchStatus(): BatchStatus; // BatchStatus.running: boolean
export function subscribeBatch(cb: () => void): () => void;
// packages/desktop/src/preload/api.ts:94 — app.openExternal(url: string): Promise<void>
```

Produces:

```tsx
// packages/desktop/src/renderer/src/components/UpdateBanner.tsx
export function UpdateBanner(): JSX.Element | null; // No props; subscribes to update / recorder / batch internally
```

**Four design rationales that must be written into code comments:**

1. **Update surface and §4.7 trace logic must go through `update/updateBridge.ts`; no duplicate logic allowed in components** (Global Ruling 7). Error tolerance for `getState` / `onState` / `install` and the entire predicate chain ("fetch version → compare `lastSeenVersion` → silent write-back on null → dismiss write-back") are single-sourced in `updateBridge.ts` and locked down by `test/updateBridge.test.ts`. The component only renders the answer. Direct bridge calls remaining in the component are only two, neither being the update surface: `app.openExternal` (pure UI navigation) and `recorder` (updateBridge does not manage recording), both wrapped in try/catch.
2. **Busy predicates must not be reinvented (CLAUDE.md single source).** "Recording in progress" only checks `RecorderStatus.recording` (main-side sole fact source via `recorder.onStatus`); "Analysis in flight" only checks `getBatchStatus().running` (batch/auto-analysis driver singleton). The banner **must not** count running requests on its own.
   **Known hole, documented in comments**: Manual single-match analysis from AI reports goes through `bridge().analysis.run(...)` directly (`report/components/StructuredAnalysisPanel.tsx:687`) without passing through `batchAnalysis`, so manual analysis is not counted as busy. Rationale: main process only exposes `analysis.getState(matchId).running` per matchId without a global running snapshot; inventing one in the renderer would create a second drifting predicate. The cost is bounded: worst case is losing that single analysis round without affecting match data.
3. **Banner is mounted inside topbar, not as a sibling of `.app-container`.** Sibling banners are flex items that shrink by default under `.app-layout { flex: 1 }`; `.app-container` cannot be made flex directly per styles.css rules (the match list `.dash` relies on `margin: 0 auto` for width). Placing it inside `.app-topbar` (which is already `display: flex` and `flex: none`) avoids new layout rules across both view types.
4. **`error` is rendered only when "user just clicked restart now"**. Per §4.2, errors do not interrupt during normal background operations. However, Task 5's watchdog records `error` if the process remains alive 10s after `quitAndInstall`, after `shutdown()` has already stopped recording / workers / AI — leaving a dead app. The criterion uses the **local fact** "install requested in this session" rather than string-matching error messages.

**Known Boundaries:**

- This task **renders nothing under fixtures**, and **does not alter any pixels or visual baselines**. `fixtureBridge` does not include an `update` surface per Global Ruling 6, causing `updateBridge` to fall back to "no update info"; Step 20 pins `lastSeenVersion` to `"fixture"`, matching `getVersion()` ("fixture") so traces do not render. Pixel changes occur entirely in Task 8 (Settings "About" card).
- Accessible names (`Restart Now` / `Later` / `New version X ready` / `Updated to X · What's new` / `Dismiss update notice`) were cross-checked against existing E2E/test selectors with no collisions.
- `.upd-banner` with `role="status"` never renders under fixtures, avoiding axe scans in `qa/visual/scenes.spec.ts:88-99`; on real machines, `status` is a live region permitting interactive children without WCAG violations.

### Steps

- [ ] **Step 1: Write first batch of failing tests (3-state rendering + later/chip + push)**

  Create `packages/desktop/test/updateBanner.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { act, fireEvent, render, screen } from "@testing-library/react";
  import { vi } from "vitest";

  import type { UpdateState } from "../src/main/updater";
  import { UpdateBanner } from "../src/renderer/src/components/UpdateBanner";

  // The batch driver is a module singleton with no public setter; mock it whole
  // so "analysis in flight" is drivable from the test. Production code keeps
  // importing the real module — same approach as autoAnalyze.test.ts:10-27
  // (that file exposes a `__setRunning` knob inside the factory; here the state
  // is hoisted into the test scope instead, which is equivalent).
  const batch = vi.hoisted(() => ({
    running: false,
    subs: new Set<() => void>(),
  }));
  vi.mock("../src/renderer/src/batch/batchAnalysis", () => ({
    getBatchStatus: () => ({
      running: batch.running,
      total: 0,
      done: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      currentLabel: null,
      cancelled: false,
      finishedAt: null,
    }),
    subscribeBatch: (cb: () => void) => {
      batch.subs.add(cb);
      return () => batch.subs.delete(cb);
    },
  }));
  const setBatchRunning = (v: boolean) =>
    act(() => {
      batch.running = v;
      for (const cb of [...batch.subs]) cb();
    });

  type Stub = {
    state: UpdateState;
    recording?: boolean;
    version?: string;
    lastSeenVersion?: string | null;
    /** omit the whole update surface (old stubs / fixture preview) */
    noUpdateSurface?: boolean;
  };

  function mockBridge(s: Stub) {
    const install = vi.fn(async () => {});
    const check = vi.fn(async () => {});
    const openExternal = vi.fn(async (_url: string) => {});
    const save = vi.fn(async (p: Record<string, unknown>) => ({ ...p }));
    let pushState: ((u: UpdateState) => void) | null = null;
    let pushRecorder: ((r: { recording: boolean }) => void) | null = null;
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      ...(s.noUpdateSurface
        ? {}
        : {
            update: {
              getState: async () => s.state,
              check,
              install,
              onState: (cb: (u: UpdateState) => void) => {
                pushState = cb;
                return () => {
                  pushState = null;
                };
              },
            },
          }),
      recorder: {
        getStatus: async () => ({
          enabled: true,
          connected: true,
          recording: s.recording ?? false,
          lastError: null,
        }),
        onStatus: (cb: (r: { recording: boolean }) => void) => {
          pushRecorder = cb;
          return () => {
            pushRecorder = null;
          };
        },
      },
      app: {
        getVersion: async () => s.version ?? "0.1.20",
        openExternal,
      },
      settings: {
        get: async () => ({
          // NOT `??`: the tests must be able to pass null explicitly (a fresh
          // install), and `??` would fold null back into the default.
          lastSeenVersion:
            s.lastSeenVersion === undefined ? "0.1.20" : s.lastSeenVersion,
        }),
        save,
      },
    };
    return {
      install,
      check,
      openExternal,
      save,
      emit: (u: UpdateState) => act(() => pushState?.(u)),
      emitRecording: (recording: boolean) =>
        act(() => pushRecorder?.({ recording })),
    };
  }

  beforeEach(() => {
    batch.running = false;
    batch.subs.clear();
  });

  describe("UpdateBanner: 3-state rendering (spec §4.5)", () => {
    it("idle / checking / error / disabled → renders nothing", async () => {
      const silent: UpdateState[] = [
        { phase: "idle", lastCheckedAt: null },
        { phase: "checking" },
        { phase: "error", message: "net::ERR_TIMED_OUT" },
        { phase: "disabled", reason: "portable" },
      ];
      for (const state of silent) {
        mockBridge({ state });
        const { container, unmount } = render(<UpdateBanner />);
        await act(async () => {});
        expect(container.textContent).toBe("");
        unmount();
      }
    });

    it("downloading → thin line in navbar, no buttons", async () => {
      mockBridge({
        state: { phase: "downloading", version: "0.1.20", percent: 37.4 },
      });
      render(<UpdateBanner />);
      expect(await screen.findByText("Downloading 0.1.20 · 37%")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("ready → banner + Restart Now calls install once", async () => {
      const { install } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
      });
      render(<UpdateBanner />);
      expect(await screen.findByText("New version 0.1.20 ready")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Restart Now" }));
      expect(install).toHaveBeenCalledTimes(1);
    });

    it("Later → banner collapses into small persistent chip; clicking chip restores banner", async () => {
      mockBridge({ state: { phase: "ready", version: "0.1.20" } });
      render(<UpdateBanner />);
      fireEvent.click(await screen.findByRole("button", { name: "Later" }));
      expect(screen.queryByRole("button", { name: "Restart Now" })).toBeNull();
      const chip = screen.getByRole("button", { name: "New version 0.1.20 ready" });
      fireEvent.click(chip);
      expect(screen.getByRole("button", { name: "Restart Now" })).toBeTruthy();
    });

    it("receiving push after mount → empty to banner (no loss when reopening window / switching views late)", async () => {
      const { emit } = mockBridge({ state: { phase: "checking" } });
      const { container } = render(<UpdateBanner />);
      await act(async () => {});
      expect(container.textContent).toBe("");
      emit({ phase: "ready", version: "0.1.21" });
      expect(screen.getByText("New version 0.1.21 ready")).toBeTruthy();
    });

    it("stub has no update surface → does not crash, renders nothing", async () => {
      mockBridge({
        state: { phase: "ready", version: "0.1.20" },
        noUpdateSurface: true,
      });
      const { container } = render(<UpdateBanner />);
      await act(async () => {});
      expect(container.textContent).toBe("");
    });
  });
  ```

- [ ] **Step 2: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Error: Failed to load url ../src/renderer/src/components/UpdateBanner (resolved id: …). Does the file exist?`, `Test Files  1 failed (1)`.

- [ ] **Step 3: Write minimal UpdateBanner implementation (up to 3 states + Later)**

  Create `packages/desktop/src/renderer/src/components/UpdateBanner.tsx`:

  ```tsx
  import { useEffect, useState } from "react";

  import type { UpdateState } from "../../../main/updater";
  import {
    fetchUpdateState,
    requestUpdateInstall,
    subscribeUpdateState,
  } from "../update/updateBridge";

  /** The type-only import of UpdateState is mandatory: a value import of
   *  main/updater.ts would drag electron-updater into the renderer bundle and
   *  break both `npm run build:ui` (the visual-regression web server) and the
   *  production electron-vite build. Precedent: preload/api.ts:6 imports
   *  RecorderStatus the same way. */

  /**
   * Update indicator in the top bar (spec §4.5, the two stages the user signed
   * off on): downloading = one thin non-interactive line; ready = a dismissible
   * banner that degrades into a small always-there button after "Later".
   * idle / checking / disabled render nothing — a failed check must never nag
   * (network failure is the normal case when pulling 110 MB from GitHub, and it
   * breaks no feature). The one error worth interrupting for is handled further
   * down.
   *
   * Every update-side call goes through update/updateBridge.ts. That module owns
   * the defensive access to `bridge().update` (component tests and the fixture
   * preview routinely lack whole surfaces) and, further down, the §4.7
   * lastSeenVersion predicate. Re-implementing either here would be the
   * hand-copied predicate CLAUDE.md forbids.
   */
  export function UpdateBanner() {
    const [state, setState] = useState<UpdateState | null>(null);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
      void fetchUpdateState().then((s) => {
        if (s) setState(s);
      });
      // Both push and snapshot: mounting later than the event (window reopen /
      // view switch) would otherwise lose the state entirely.
      return subscribeUpdateState((s) => {
        setState(s);
        // A newly arrived "ready" reopens the banner even if an older one was
        // dismissed — a different version is a different piece of news.
        if (s.phase === "ready") setDismissed(false);
      });
    }, []);

    if (state?.phase === "downloading") {
      return (
        <div className="upd-slot">
          <span className="upd-line">
            Downloading {state.version} · {Math.round(state.percent)}%
          </span>
        </div>
      );
    }
    if (state?.phase === "ready") {
      return (
        <div className="upd-slot">
          {dismissed ? (
            <button className="upd-chip" onClick={() => setDismissed(false)}>
              New version {state.version} ready
            </button>
          ) : (
            <span className="upd-banner" role="status">
              <span>New version {state.version} ready</span>
              <button
                className="upd-primary"
                onClick={() => void requestUpdateInstall()}
              >
                Restart Now
              </button>
              <button onClick={() => setDismissed(true)}>Later</button>
            </span>
          )}
        </div>
      );
    }
    return null;
  }
  ```

- [ ] **Step 4: Run test to confirm pass**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Test Files  1 passed (1)` / `Tests  6 passed (6)`.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): update indicator component 3-state rendering — downloading text / ready banner + Later chip"
  ```

- [ ] **Step 6: Write failing tests for busy predicates**

  Append to `test/updateBanner.test.tsx`:

  ```tsx
  describe("UpdateBanner: disables restart when busy (spec §4.5, predicate not reinvented)", () => {
    it("recording in progress → Restart Now disabled + text updated, install unclickable", async () => {
      const { install } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
        recording: true,
      });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "Restart Now" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("Recording in progress, will update automatically on exit")).toBeTruthy();
      fireEvent.click(btn);
      expect(install).not.toHaveBeenCalled();
    });

    it("recording status push changes → Restart Now re-enabled after stopping recording", async () => {
      const { emitRecording } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
        recording: true,
      });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "Restart Now" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      emitRecording(false);
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    it("batch analysis in flight → Restart Now disabled + text updated; auto recovers when done", async () => {
      mockBridge({ state: { phase: "ready", version: "0.1.20" } });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "Restart Now" });
      setBatchRunning(true);
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("Analysis in progress, will update automatically on exit")).toBeTruthy();
      setBatchRunning(false);
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });
  ```

- [ ] **Step 7: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  3 failed | 6 passed (9)`.

- [ ] **Step 8: Implement busy predicates**

  Update import section in `UpdateBanner.tsx`:

  ```tsx
  import { useEffect, useState } from "react";

  import type { UpdateState } from "../../../main/updater";
  import type { GladlogApi } from "../../../preload/api";
  import { getBatchStatus, subscribeBatch } from "../batch/batchAnalysis";
  import { bridge } from "../bridge";
  import {
    fetchUpdateState,
    requestUpdateInstall,
    subscribeUpdateState,
  } from "../update/updateBridge";
  ```

  Insert recorder surface helper before `export function UpdateBanner()` JSDoc:

  ```tsx
  /** The recorder surface is read defensively for one concrete reason: this
   *  component is the very first renderer-side consumer of recorder.onStatus
   *  (preload/api.ts:319), so every pre-existing bridge stub — fixtureBridge.ts
   *  and the ~40 component tests — lacks it entirely and the property access
   *  itself throws. Update-side access is NOT done here; it lives in
   *  update/updateBridge.ts. */
  function recorderSurface(): GladlogApi["recorder"] | undefined {
    try {
      return bridge()?.recorder;
    } catch {
      return undefined;
    }
  }
  ```

  After `const [dismissed, setDismissed] = useState(false);`, insert:

  ```tsx
  const [recording, setRecording] = useState(false);
  const [analyzing, setAnalyzing] = useState(() => getBatchStatus().running);

  // CLAUDE.md's single-source rule applied to "is the app busy": both facts
  // are consumed from their existing owners, never re-derived here.
  //   recording  = RecorderStatus.recording (main is the sole owner)
  //   analyzing  = getBatchStatus().running (the batch/auto-analyze driver)
  // Known hole, deliberately left: a single match analysed by hand from the
  // report page goes through bridge().analysis.run directly
  // (report/components/StructuredAnalysisPanel.tsx:687) and never touches the
  // batch driver, so it does not count as busy. Covering it would mean
  // inventing a second "in flight" registry in the renderer — exactly the
  // hand-copied predicate the rule forbids (main only exposes a per-matchId
  // analysis.getState(id).running, no global snapshot). The cost is bounded:
  // the worst case is losing that one analysis round (its cache was never
  // written); no match data is at risk. Switch to a global running snapshot
  // the day main grows one.
  useEffect(() => {
    const rec = recorderSurface();
    if (!rec) return;
    void rec
      .getStatus()
      .then((s) => setRecording(s.recording))
      .catch(() => {});
    return rec.onStatus((s) => setRecording(s.recording));
  }, []);

  useEffect(
    () => subscribeBatch(() => setAnalyzing(getBatchStatus().running)),
    [],
  );

  const busyReason = recording
    ? "Recording in progress, will update automatically on exit"
    : analyzing
      ? "Analysis in progress, will update automatically on exit"
      : null;
  ```

  Update the "Restart Now" button in the ready branch:

  ```tsx
              <button
                className="upd-primary"
                disabled={busyReason != null}
                onClick={() => void requestUpdateInstall()}
              >
                Restart Now
              </button>
              <button onClick={() => setDismissed(true)}>Later</button>
              {busyReason && <span className="upd-note">{busyReason}</span>}
  ```

- [ ] **Step 9: Run test to confirm pass + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  9 passed (9)`.

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): disable Restart Now when recording/analyzing in flight — busy predicates reuse RecorderStatus.recording and getBatchStatus().running"
  ```

- [ ] **Step 10: Write failing tests for post-update trace (spec §4.7)**

  Append to `test/updateBanner.test.tsx`:

  ```tsx
  describe("UpdateBanner: post-update trace (spec §4.7, predicate in updateBridge)", () => {
    it("version ≠ lastSeenVersion → displays trace; clicking opens release page and writes back", async () => {
      const { openExternal, save } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: "0.1.20",
      });
      render(<UpdateBanner />);
      const link = await screen.findByRole("button", {
        name: "Updated to 0.1.21 · What's new",
      });
      fireEvent.click(link);
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/mingjianliu/gladlog/releases/tag/v0.1.21",
      );
      expect(save).toHaveBeenCalledWith({ lastSeenVersion: "0.1.21" });
      expect(
        screen.queryByRole("button", { name: "Updated to 0.1.21 · What's new" }),
      ).toBeNull();
    });

    it("dismissing trace also writes back lastSeenVersion", async () => {
      const { save, openExternal } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: "0.1.20",
      });
      render(<UpdateBanner />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Dismiss update notice" }),
      );
      expect(save).toHaveBeenCalledWith({ lastSeenVersion: "0.1.21" });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it("lastSeenVersion is null (fresh install / upgraded from older build) → silently writes back, does not show trace", async () => {
      const { save } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: null,
      });
      const { container } = render(<UpdateBanner />);
      await act(async () => {});
      expect(container.textContent).toBe("");
      expect(save).toHaveBeenCalledWith({ lastSeenVersion: "0.1.21" });
    });

    it("version matches lastSeenVersion → does not render, does not write to disk", async () => {
      const { save } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: "0.1.21",
      });
      const { container } = render(<UpdateBanner />);
      await act(async () => {});
      expect(container.textContent).toBe("");
      expect(save).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 11: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  3 failed | 10 passed (13)`.

- [ ] **Step 12: Implement post-update trace (consuming updateBridge)**

  Update `../update/updateBridge` imports in `UpdateBanner.tsx`:

  ```tsx
  import {
    dismissVersionNotice,
    fetchUpdateState,
    requestUpdateInstall,
    resolveVersionNotice,
    subscribeUpdateState,
  } from "../update/updateBridge";
  ```

  Add constant before `recorderSurface`:

  ```tsx
  const RELEASE_TAG_URL =
    "https://github.com/mingjianliu/gladlog/releases/tag/v";
  ```

  In component before `busyReason`, insert:

  ```tsx
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);

  // §4.7 post-update trace. The predicate ("is there anything to announce, and
  // when is lastSeenVersion written back") lives in
  // updateBridge.resolveVersionNotice — one copy, unit-tested in
  // test/updateBridge.test.ts. This component only renders the answer.
  useEffect(() => {
    let cancelled = false;
    void resolveVersionNotice().then((v) => {
      if (!cancelled) setUpdatedTo(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearUpdatedTo = () => {
    const v = updatedTo;
    setUpdatedTo(null);
    if (v) void dismissVersionNotice(v);
  };
  ```

  Replace return block with:

  ```tsx
  const trace = updatedTo && (
    <span className="upd-trace">
      <button
        className="upd-chip"
        onClick={() => {
          // Pure UI navigation, not a predicate — the only direct bridge call
          // left in this component. try/catch because a stub may ship
          // app.getVersion without app.openExternal.
          try {
            void bridge()
              .app.openExternal(`${RELEASE_TAG_URL}${updatedTo}`)
              .catch(() => {});
          } catch {
            // No app surface: dropping the navigation is the right degradation
          }
          clearUpdatedTo();
        }}
      >
        Updated to {updatedTo} · What's new
      </button>
      <button
        className="upd-x"
        aria-label="Dismiss update notice"
        onClick={clearUpdatedTo}
      >
        ✕
      </button>
    </span>
  );

  const live =
    state?.phase === "downloading" ? (
      <span className="upd-line">
        Downloading {state.version} · {Math.round(state.percent)}%
      </span>
    ) : state?.phase === "ready" ? (
      dismissed ? (
        <button className="upd-chip" onClick={() => setDismissed(false)}>
          New version {state.version} ready
        </button>
      ) : (
        <span className="upd-banner" role="status">
          <span>New version {state.version} ready</span>
          <button
            className="upd-primary"
            disabled={busyReason != null}
            onClick={() => void requestUpdateInstall()}
          >
            Restart Now
          </button>
          <button onClick={() => setDismissed(true)}>Later</button>
          {busyReason && <span className="upd-note">{busyReason}</span>}
        </span>
      )
    ) : null;

  // idle / checking / error / disabled with nothing to trace → render nothing
  if (!trace && !live) return null;
  return (
    <div className="upd-slot">
      {trace}
      {live}
    </div>
  );
  ```

- [ ] **Step 13: Run test to confirm pass + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  13 passed (13)`.

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): post-update trace connected to navbar — predicate single-sourced in updateBridge.resolveVersionNotice"
  ```

- [ ] **Step 14: Write failing test for install failure visibility (review minor-9)**

  Append to `test/updateBanner.test.tsx`:

  ```tsx
  describe("UpdateBanner: the only error that must interrupt the user (install watchdog)", () => {
    it("entering error after clicking Restart Now → displays reason in topbar", async () => {
      const { emit } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
      });
      render(<UpdateBanner />);
      fireEvent.click(await screen.findByRole("button", { name: "Restart Now" }));
      emit({
        phase: "error",
        message: "Update installer failed to take over, please quit gladlog manually and reopen",
      });
      expect(
        screen.getByText("Update installer failed to take over, please quit gladlog manually and reopen"),
      ).toBeTruthy();
    });
  });
  ```

- [ ] **Step 15: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  1 failed | 13 passed (14)`.

- [ ] **Step 16: Implement error branch after requested install**

  In `UpdateBanner.tsx`, insert before `const [updatedTo, setUpdatedTo] = useState<string | null>(null);`:

  ```tsx
  const [installRequested, setInstallRequested] = useState(false);
  ```

  Update `onClick` for `Restart Now`:

  ```tsx
              onClick={() => {
                setInstallRequested(true);
                void requestUpdateInstall();
              }}
  ```

  Update `live` ternary chain:

  ```tsx
        )
      ) : state?.phase === "error" && installRequested ? (
        // §4.2 says errors must not nag, and check/download failures indeed
        // render nothing. This is the one exception: after the user pressed
        // Restart Now, quitLifecycle.shutdown() has already stopped the recorder,
        // the worker and the AI child processes, so if the installer never took
        // over (Task 5's watchdog, 10 s) the window is alive but functionally
        // dead. Staying silent there leaves a "looks fine, does nothing" app.
        // The trigger is the local fact "we asked for an install", NOT a
        // string match on the message — that message is produced in
        // src/main/updater.ts, which the renderer may only `import type`, so
        // copying it here would be a hand-written predicate that rots silently
        // the first time main rewords it.
        <span className="upd-note" role="status">
          {state.message}
        </span>
      ) : null;
  ```

- [ ] **Step 17: Run test to confirm pass + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  Expected: `Tests  14 passed (14)`.

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): topbar displays error when installer fails to take over — triggered by local fact of requested install"
  ```

- [ ] **Step 18: App.tsx wiring**

  In `packages/desktop/src/renderer/src/App.tsx`, import `UpdateBanner`:

  ```tsx
  import { UpdateBanner } from "./components/UpdateBanner";
  ```

  Update header at :180-193:

  ```tsx
  <header className="app-topbar">
    <h1>gladlog</h1>
    <div className="rpt-view-tabs app-view-tabs">
      {(Object.keys(APP_VIEW_LABEL) as AppView[]).map((v) => (
        <button
          key={v}
          className={v === appView ? "active" : ""}
          onClick={() => setAppView(v)}
        >
          {APP_VIEW_LABEL[v]}
        </button>
      ))}
    </div>
    <UpdateBanner />
  </header>
  ```

- [ ] **Step 19: Add styles**

  In `packages/desktop/src/renderer/src/styles.css`, insert after :111:

  ```css
  /* Update indicator: mounted at topbar right end, not a sibling of .app-container. */
  .upd-slot {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-data);
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .upd-trace,
  .upd-banner {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .upd-banner {
    padding: 3px 10px;
    border: 1px solid var(--accent);
    border-radius: 3px;
    color: var(--ink);
  }
  .upd-slot button {
    font-family: var(--font-data);
    font-size: 11.5px;
  }
  .upd-banner .upd-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .upd-note,
  .upd-line {
    color: var(--ink-2);
  }
  ```

- [ ] **Step 20: Pin fixture version trace (visual baseline determinism)**

  In `packages/desktop/src/renderer/src/fixtureBridge.ts` inside `currentSettings`, update `lastSeenVersion`:

  ```ts
      // Pinned to whatever app.getVersion() returns further down in this file
      // ("fixture"): equal values mean UpdateBanner renders no post-update
      // trace, so the baselines never depend on the app version. This file also
      // has NO `update` surface on purpose — updateBridge then degrades to "no
      // update information" and every update-related element stays out of the
      // screenshots. If anyone ever adds one, lastCheckedAt must be a constant,
      // never Date.now(), or settings.png drifts with the wall clock.
      lastSeenVersion: "fixture",
  ```

- [ ] **Step 21: Regress existing App tests**

  ```bash
  npm test --workspace=packages/desktop -- test/app.backgroundload.test.tsx src/renderer/src/App.pagination.test.tsx
  ```

  Expected: `Test Files  2 passed (2)` / `Tests  5 passed (5)`.

- [ ] **Step 22: Full suite + typecheck + lint**

  ```bash
  npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet
  ```

  Expected: vitest all green; typecheck zero errors; eslint zero output.

- [ ] **Step 23: Visual smoke test**

  ```bash
  npm run test:visual:smoke --workspace=packages/desktop
  ```

  Expected: all scenes passed. **Never run `npm run test:visual` locally** (which pollutes Linux baseline with macOS images).

- [ ] **Step 24: Commit**

  ```bash
  git add packages/desktop/src/renderer/src/App.tsx packages/desktop/src/renderer/src/styles.css packages/desktop/src/renderer/src/fixtureBridge.ts
  git commit -m "feat(desktop): connect update indicators to navigation bar — topbar right widget + pinned fixture version for baseline determinism"
  ```

---

## Task 8: SettingsPanel "About" Section (spec §4.6)

**Files:**

- Modify: `packages/desktop/src/renderer/src/update/updateBridge.ts` — `hasUpdateSurface()` landed in Task 6; **under normal paths this task does not change its implementation**, only adding two contract tests (see attribution details in Step 1)
- Modify: `packages/desktop/test/updateBridge.test.ts` — append 2 tests
- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`
  - :1-17 (imports) + :19 (`type SettingsGroup`)
  - :36-39 (end of state declarations in component top, `const [saved, setSaved] = useState<…>(null);`)
  - :79-81 (append two effects before `if (!settings) return …` at :81 — hooks must precede early returns)
  - :101-108 (after `groupHead` definition and before :110 `return (`, add two derived values)
  - :508-509 (insert new section after final `</section>` at :508 and before `</div>` at :509)
- Modify: `packages/desktop/test/settingsPanel.test.tsx` (expand `mockBridge` at :8-28; add `act` to import at :2; append a describe block at end of file)
- Test: `packages/desktop/test/settingsPanel.test.tsx`, `packages/desktop/test/updateBridge.test.ts`
- Modify (Baseline, **generated in CI**): `packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png`

**Interfaces:**

Consumes:

```ts
// packages/desktop/src/main/settingsStore.ts — GladlogSettings new fields (Task 3)
//   autoCheckUpdates: boolean;    true in DEFAULTS
// packages/desktop/src/main/updater.ts
export type UpdateState = /* See Task 7 Consumes, verbatim; import type only */;
// packages/desktop/src/renderer/src/update/updateBridge.ts (Task 6)
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateCheck(): Promise<void>;
// Existing: bridge().app.getVersion(): Promise<string> (preload/api.ts:92)
//           save(partial, note, group) — Internal helper in SettingsPanel.tsx:83-92
```

Produces:

```ts
// packages/desktop/src/renderer/src/update/updateBridge.ts — Implementation from Task 6;
// this task adds two contract tests (implemented in Step 3 only if Task 6 missed it)
export function hasUpdateSurface(): boolean;
```

DOM contracts: button accessible names `Check for updates` / `Checking…`, switch `aria-label="Auto Check for Updates"`.

**Three design rationales that must be written into code comments:**

1. **"Check for updates" button is unaffected by "Auto Check for Updates" toggle** (spec §4.2). Users who disable automatic background checks still need a manual entry point. Only two disable conditions: currently `checking`, or the machine has no update surface.
2. **Last check time uses relative time** (`Just now / N minutes ago / N hours ago / N days ago`), not `toLocaleString()`: visual baselines pin `Date.now()` (`qa/visual/scenes.spec.ts:62` `page.clock.setFixedTime`, value in `dev/fixtures/fixedNow.ts`) but pin neither timezone nor locale. Absolute timestamps drift across environments, while relative times depend only on the pinned clock.
3. **Presence of update surface is determined synchronously via `hasUpdateSurface()` rather than async fetch resolving null**. Settings page must render the correct copy on first frame without flickering. The check remains single-sourced in `updateBridge`.

**Known Boundaries:**

- Under fixture preview (`fixtureBridge` lacks `update` surface per Global Ruling 6), `hasUpdateSurface()` is always false → "About" card displays "Auto-update not available in this environment" with **no** "Check for updates" button; version displays `fixture`; `autoCheckUpdates` defaults to true → toggle button displays "Disable". **These three rules form the entire visual review criteria for Step 18.**
- The switch button mirrors the "Auto analyze new matches" pattern (`SettingsPanel.tsx:336-346`: `aria-label` fixed accessible name + visible text Enable/Disable), passing WCAG axe scans in `qa/visual/scenes.spec.ts:88-99`.
- `settings` scene runs only in the default `visual` project (not `visual-1440` / `visual-1920`); among 19 baselines, **only `settings.png` requires updating**.
- The copy "checks 30s after startup, then every 4h" is interpolated from `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` in `packages/desktop/src/shared/updateSchedule.ts`, which is a pure leaf module imported by both main and renderer.
- **Manual synchronization remains needed in two markdown locations**: `CHANGELOG.md` + `CHANGELOG.zh-CN.md` (Task 10 bilingual release entries).

### Steps

- [ ] **Step 1: Write contract tests for `hasUpdateSurface()`**

  `hasUpdateSurface()` was landed in Task 6 in `updateBridge.ts`; **this task adds its two dedicated contract tests**.

  Confirm implementation before proceeding (**must include `-A 6`**):

  ```bash
  grep -n -A 6 "export function hasUpdateSurface" packages/desktop/src/renderer/src/update/updateBridge.ts
  ```

  Expected: outputs 7 lines matching `export function hasUpdateSurface(): boolean` and `try { return typeof bridge().update?.getState === "function"; } catch { return false; }`.

  Append to `packages/desktop/test/updateBridge.test.ts`:

  ```ts
  describe("hasUpdateSurface: synchronously determines whether this machine has an update surface", () => {
    it("stub has no update surface → false, does not throw", () => {
      installStub({});
      expect(hasUpdateSurface()).toBe(false);
    });

    it("stub has update surface → true", () => {
      installStub({
        update: {
          getState: async (): Promise<UpdateState> => ({
            phase: "idle",
            lastCheckedAt: null,
          }),
          check: async () => {},
          install: async () => {},
          onState: () => () => {},
        },
      });
      expect(hasUpdateSurface()).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm pass**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  Expected: `Tests  9 passed (9)`.

- [ ] **Step 3: Implement `hasUpdateSurface()` (fallback only — executed only if Step 2 failed)**

  Insert in `packages/desktop/src/renderer/src/update/updateBridge.ts` before `resolveVersionNotice`:

  ```ts
  /** Whether this environment exposes the update surface at all. The settings
   *  page renders "Auto-update not available in this environment" when it does not — which is the case
   *  under the fixture preview and in every component test stub. */
  export function hasUpdateSurface(): boolean {
    try {
      return typeof bridge().update?.getState === "function";
    } catch {
      return false;
    }
  }
  ```

- [ ] **Step 4: Run test to confirm pass + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  Expected: `Tests  9 passed (9)`.

  ```bash
  git add packages/desktop/src/renderer/src/update/updateBridge.ts packages/desktop/test/updateBridge.test.ts
  git commit -m "test(desktop): hasUpdateSurface contract test — settings page determines update surface on first frame"
  ```

- [ ] **Step 5: Expand existing mockBridge in test file**

  In `packages/desktop/test/settingsPanel.test.tsx`, update import at :2:

  ```tsx
  import { act, fireEvent, render, screen } from "@testing-library/react";
  ```

  Add type import after :6:

  ```tsx
  import type { UpdateState } from "../src/main/updater";
  ```

  Replace `mockBridge` at :8-28 with:

  ```tsx
  function mockBridge(
    over: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) {
    const state = {
      wowDirectory: null,
      anthropicApiKey: null,
      anthropicModel: null,
      aiBackend: "anthropic",
      aiBackendCommand: null,
      aiLanguage: "zh",
      autoAnalyzeNew: false,
      autoCheckUpdates: true,
      ...over,
    };
    const save = vi.fn(async (partial: Record<string, unknown>) => {
      Object.assign(state, partial);
      return { ...state };
    });
    (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
      settings: { get: async () => ({ ...state }), save },
      app: {
        selectDirectory: async () => "/wow",
        getVersion: async () => "9.9.9",
      },
      ...extra,
    };
    return { save };
  }

  /** update surface stub: goes into mockBridge's `extra`. The returned `emit`
   *  pushes a new state the same way main does. */
  function mockUpdate(initial: UpdateState) {
    const check = vi.fn(async () => {});
    const install = vi.fn(async () => {});
    let push: ((s: UpdateState) => void) | null = null;
    const update = {
      getState: async () => initial,
      check,
      install,
      onState: (cb: (s: UpdateState) => void) => {
        push = cb;
        return () => {
          push = null;
        };
      },
    };
    return {
      update,
      check,
      install,
      emit: (s: UpdateState) => act(() => push?.(s)),
    };
  }
  ```

- [ ] **Step 6: Run existing 4 tests to confirm no regressions**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  Expected: `Tests  4 passed (4)`.

- [ ] **Step 7: Write failing tests for "About" section**

  Append to `test/settingsPanel.test.tsx`:

  ```tsx
  describe("Settings page 'About' (spec §4.6)", () => {
    it("displays current version number", async () => {
      mockBridge();
      render(<SettingsPanel />);
      expect(await screen.findByText("9.9.9")).toBeTruthy();
    });

    it("auto check for updates defaults to on → button displays Deactivate, click writes back false", async () => {
      const { save } = mockBridge();
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "Auto Check for Updates" });
      expect(btn.textContent).toBe("Disable");
      fireEvent.click(btn);
      expect(save).toHaveBeenCalledWith({ autoCheckUpdates: false });
    });

    it("when auto check is disabled, 'Check for updates' button remains enabled and invokes check", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({ autoCheckUpdates: false }, { update: u.update });
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "Check for updates" });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(btn);
      expect(u.check).toHaveBeenCalledTimes(1);
    });

    it("checking → button disabled and displays Checking…", async () => {
      const u = mockUpdate({ phase: "checking" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "Checking…" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });

    it("manual check returns to idle → displays up to date + relative time", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
      u.emit({ phase: "idle", lastCheckedAt: Date.now() - 5 * 60_000 });
      expect(screen.getByText("Up to date · Last checked: 5 minutes ago")).toBeTruthy();
    });

    it("never checked → displays Never checked", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(await screen.findByText("Never checked")).toBeTruthy();
    });

    it("error → displays failure reason inline, no dialog", async () => {
      const u = mockUpdate({ phase: "error", message: "net::ERR_TIMED_OUT" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(
        await screen.findByText("Check failed: net::ERR_TIMED_OUT"),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
    });

    it("disabled (portable) → explains why not updating, no check button", async () => {
      const u = mockUpdate({ phase: "disabled", reason: "portable" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(
        await screen.findByText("Portable version (zip) does not auto-update, please use the installer"),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    });

    it("stub has no update surface → version still displayed, explains why, no check button, does not crash", async () => {
      mockBridge();
      render(<SettingsPanel />);
      expect(await screen.findByText("9.9.9")).toBeTruthy();
      expect(screen.getByText("Auto-update not available in this environment")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    });
  });
  ```

- [ ] **Step 8: Run test to confirm failure**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  Expected: `Tests  9 failed | 4 passed (13)`.

- [ ] **Step 9: Implement — types and imports**

  In `SettingsPanel.tsx:19`, update:

  ```tsx
  type SettingsGroup = "game" | "ai" | "recording" | "about";
  ```

  Add imports in :1-17:

  ```tsx
  import type { UpdateState } from "../../../main/updater";
  import {
    fetchUpdateState,
    hasUpdateSurface,
    requestUpdateCheck,
    subscribeUpdateState,
  } from "../update/updateBridge";
  ```

- [ ] **Step 10: Implement — helper functions**

  Before `export function SettingsPanel()` (:27), insert:

  ```tsx
  /** Relative wall-clock text. Deliberately NOT toLocaleString(): the visual
   *  baseline pins Date.now() (qa/visual/scenes.spec.ts:62 page.clock
   *  .setFixedTime) but pins neither the timezone nor the locale, so an absolute
   *  timestamp would drift between environments while a relative one only
   *  depends on the pinned clock. */
  function relTime(at: number, now: number): string {
    const d = Math.max(0, now - at);
    if (d < 60_000) return "Just now";
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} minutes ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} hours ago`;
    return `${Math.floor(d / 86_400_000)} days ago`;
  }

  /** One line of copy per update state. An exhaustive switch: a new phase in
   *  main/updater.ts fails typecheck here instead of silently rendering "". */
  function describeUpdate(
    s: UpdateState,
    checkedOnce: boolean,
    now: number,
  ): string {
    switch (s.phase) {
      case "disabled":
        return s.reason === "platform"
          ? "Auto-update is only supported on Windows installer builds"
          : s.reason === "portable"
            ? "Portable version (zip) does not auto-update, please use the installer"
            : "Development mode does not check for updates";
      case "checking":
        return "Checking…";
      case "downloading":
        return `Downloading ${s.version} · ${Math.round(s.percent)}%`;
      case "ready":
        return `New version ${s.version} ready, will install on exit`;
      case "error":
        return `Check failed: ${s.message}`;
      case "idle":
        return s.lastCheckedAt == null
          ? "Never checked"
          : `${checkedOnce ? "Up to date · " : ""}Last checked: ${relTime(s.lastCheckedAt, now)}`;
    }
  }
  ```

- [ ] **Step 11: Implement — state and effects**

  At end of state declarations :36-39, add:

  ```tsx
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checkedOnce, setCheckedOnce] = useState(false);
  ```

  Before `if (!settings) return …` at :81, insert:

  ```tsx
  useEffect(() => {
    // Old stubs have no app surface at all; the settings page must still open.
    try {
      void bridge()
        .app.getVersion()
        .then(setVersion)
        .catch(() => undefined);
    } catch {
      // No app surface: the version row keeps its "…" placeholder
    }
  }, []);

  // update/updateBridge.ts owns every defensive read of bridge().update — this
  // component never touches that surface directly (see Task 7's note).
  useEffect(() => {
    void fetchUpdateState().then((s) => {
      if (s) setUpdate(s);
    });
    return subscribeUpdateState(setUpdate);
  }, []);
  ```

- [ ] **Step 12: Implement — render "About" section**

  After `groupHead` definition and before `return (`, add:

  ```tsx
  const updateAvailable = hasUpdateSurface();
  const updateNote = !updateAvailable
    ? "Auto-update not available in this environment"
    : update == null
      ? "…"
      : describeUpdate(update, checkedOnce, Date.now());
  ```

  Insert after :508 `</section>` and before :509 `</div>`:

  ```tsx
  <section className="dash-card">
    {groupHead("About", "about")}
    <div className="settings-grid">
      <span className="settings-k">Version</span>
      <span className="settings-v">{version ?? "…"}</span>
      <span />

      <span className="settings-k">Update</span>
      <span className="settings-v">{updateNote}</span>
      <span className="settings-actions">
        {updateAvailable && update?.phase !== "disabled" && (
          <button
            // Deliberately NOT gated on autoCheckUpdates: a user who turns
            // the periodic check off still needs a way in, otherwise that
            // switch kills the whole feature (spec §4.2).
            disabled={update?.phase === "checking"}
            onClick={() => {
              setCheckedOnce(true);
              void requestUpdateCheck();
            }}
          >
            {update?.phase === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </span>

      <span className="settings-k">Auto Check for Updates</span>
      <span className="settings-v">
        Checks 30s after launch, then every 4 hours; downloads in background and installs on exit.
      </span>
      <span className="settings-actions">
        <button
          aria-label="Auto Check for Updates"
          onClick={() =>
            void save(
              { autoCheckUpdates: !settings.autoCheckUpdates },
              settings.autoCheckUpdates ? "Auto-check disabled" : "Auto-check enabled",
              "about",
            )
          }
        >
          {settings.autoCheckUpdates ? "Disable" : "Enable"}
        </button>
      </span>
    </div>
  </section>
  ```

- [ ] **Step 13: Run test to confirm pass**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  Expected: `Tests  13 passed (13)`.

- [ ] **Step 14: Typecheck + lint + full suite**

  ```bash
  npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet
  ```

  Expected: vitest all green; typecheck zero errors; eslint zero output.

- [ ] **Step 15: Commit**

  ```bash
  git add packages/desktop/src/renderer/src/components/SettingsPanel.tsx packages/desktop/test/settingsPanel.test.tsx
  git commit -m "feat(desktop): settings page About section — version / manual check for updates / auto-check toggle"
  ```

- [ ] **Step 16: Local visual smoke test (no baseline modification)**

  ```bash
  npm run test:visual:smoke --workspace=packages/desktop
  ```

  Expected: all scenes passed (`--ignore-snapshots`).

- [ ] **Step 17: Push branch and generate baseline in CI (Step 2 of 4-step workflow)**

  ```bash
  git push -u origin worktree-auto-update
  gh workflow run visual-baseline.yml --ref worktree-auto-update
  ```

  Expected: `✓ Created workflow_dispatch event for visual-baseline.yml at worktree-auto-update`.

- [ ] **Step 18: Download baseline artifacts and review screenshots (Step 3 of 4-step workflow)**

  ```bash
  gh run list --workflow=visual-baseline.yml --limit 1
  gh run download <run-id-from-above> -n visual-baselines -D /tmp/gladlog-baselines
  ls /tmp/gladlog-baselines/scenes.spec.ts/
  ```

  Expected: 19 PNG files. Manually inspect `/tmp/gladlog-baselines/scenes.spec.ts/settings.png`:
  1. Version row displays `fixture`
  2. Update row displays `Auto-update not available in this environment` with no button
  3. Auto-check row displays `Disable`
  All other 18 images remain byte-for-byte identical.

- [ ] **Step 19: Overwrite baseline and commit (Step 4 of 4-step workflow)**

  ```bash
  cp /tmp/gladlog-baselines/scenes.spec.ts/settings.png \
     packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png
  git add packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png
  git commit -m "test(desktop): update settings visual baseline — added 'About' section to settings page (CI Linux generated, manually reviewed)"
  git push
  ```

- [ ] **Step 20: Final verification — record metrics**

  ```bash
  npm test --workspace=packages/desktop 2>&1 | tail -5
  git log --oneline -8
  ```

  Confirm metrics: Task 7 (+14) and Task 8 (+11) contribute +25 net new tests; visual baselines 19 total with 1 updated (`settings.png`).

---

## Task 9: Dummy Release End-to-End Verification (spec §6.2)

**This is not a unit test.** This is a one-time, manually executed real end-to-end verification: real packaging, real GitHub Releases, real HTTP downloads. It is the sole means in this design to prove the complete chain of "feed parsing + version selection + skipping prereleases + sha512 verification + state machine transitions", covering roughly 80% of risk surfaces.

After execution, **no code changes remain in the repository** (only two text additions to the spec: appending live measurement results and correcting the sentence in §6.2 about "pushing only one README commit").

The user has approved creating this throwaway public repository.

**Files:**

**Create (all in scratchpad, not tracked in git):**

- `/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/` — working directory
- `…/scratchpad/updtest/repo/` — local clone of dummy repo
- `…/scratchpad/updtest/keep/0.0.1/`, `…/keep/0.0.2-beta.1/`, `…/keep/0.0.3/` — build artifacts staging for three versions
- `…/scratchpad/updtest/userdata/` — isolated userData for app under test
- `…/scratchpad/updtest/verify/` — downloaded `latest-mac.yml` from Release

**Modify (temporary changes, restored after run):**

- `packages/desktop/package.json:3` — `"version"` field (modified and reverted 3 times; Step 13 uses `git checkout` to restore clean status)

**Modify (sole permanent changes in Step 14):**

- `docs/superpowers/specs/2026-08-02-auto-update-design.md` §6.2 — update "push only one README commit" to "push a real commit for each version"
- `docs/superpowers/specs/2026-08-02-auto-update-design.md` — append `#### 6.2.1 Measured Results` at end of §6.2

**Test:** None. This task writes no vitest; it verifies what unit tests cannot reach (real network, real electron-updater, real GitHub API).

**Interfaces:**

**Consumes (all from Task 4):**

```ts
// Task 4 — packages/desktop/src/main/updater.ts
export function evaluateGate(env: UpdaterEnv): GateResult;
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
// Relies on evaluateGate behavior: when env.testFeed is set ("owner/repo"),
// bypasses platform and portable gates, returning { ok: true, feed: { owner, repo } };
// app.isPackaged gate is NOT bypassed.
// Relies on UpdateState 6 phases:
// disabled / idle / checking / downloading / ready / error
```

- **Task 1 (§3.1 / §3.2)**: `packages/desktop/package.json` `build.publish` already points to `{ "provider": "github", "owner": "mingjianliu", "repo": "gladlog" }`, `build.nsis.artifactName` is `"${productName}.Setup.${version}.${ext}"`. CLI `-c.publish.*` overrides publish without editing files.
- **Task 6 (§4.2 wiring)**: `autoUpdater.logger = log` in initUpdater; `updaterEnv.testFeed` passes through `process.env["GLADLOG_UPDATER_TEST_FEED"]`.
- **Task 7/8 (§4.5 / §4.6 UI)**: Settings "About" card provides "Check for updates" button, top bar displays downloading / ready copy.

**Hard constraint — must be satisfied in Task 6 wiring to allow data isolation:**

`updaterEnv.testFeed` must **pass through directly** from `process.env["GLADLOG_UPDATER_TEST_FEED"]`, with **no** `GLADLOG_E2E` check. Gate evaluation places `!isPackaged → dev` before testFeed validation, so unpackaged dev/E2E never hit validation errors; while the app under test here is a **packaged artifact** requiring both `GLADLOG_E2E=1` (userData isolation) and `GLADLOG_UPDATER_TEST_FEED`.

**Produces:** No downstream code consumption. Outputs recorded in spec §6.2.1 and checklist verification.

### Prerequisites

- Running on Apple Silicon Mac (`uname -m` should report `arm64`).
- `gh` logged in (`gh --version` ≥ 2.93.0). Deleting repos requires `delete_repo` scope (`gh auth refresh -h github.com -s delete_repo`).
- Tasks 1–8 completed and green.
- Worktree has its own `node_modules`.
- electron-builder builds take 3–6 minutes each. Specify `timeout: 600000`.
- **`dist-app/` must be `rm -rf` cleaned before every build — electron-builder does not empty it.**

### Steps

- [ ] **Step 1: Create staging directories and confirm prerequisites**

```bash
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/{keep,userdata,verify}
uname -m
gh auth status
ls -d /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/node_modules
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update status --porcelain
grep -n "autoUpdater.logger" /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/src/main/index.ts
grep -n "GLADLOG_UPDATER_TEST_FEED" /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/src/main/index.ts
```

Expected:
1. `arm64`
2. `gh auth status` shows logged in as mingjianliu
3. `node_modules` exists
4. `git status --porcelain` clean
5. First grep non-empty (`autoUpdater.logger = log;`)
6. Second grep shows direct pass-through without `GLADLOG_E2E` check

- [ ] **Step 2: Create dummy repo and push first commit**

```bash
gh repo create mingjianliu/gladlog-update-test --public --add-readme \
  --description "Throwaway repo for gladlog auto-update e2e verification. Delete after use."
git clone https://github.com/mingjianliu/gladlog-update-test.git \
  /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/repo
```

- [ ] **Step 3: Build 0.0.2-beta.1 (built first; clean `dist-app/` first)**

```bash
rm -rf /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.2-beta.1";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
```

- [ ] **Step 4: Verify CLI overrides took effect**

```bash
ls -d /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/mac*/
find /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app -maxdepth 5 -name app-update.yml
cat "$(find /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app -maxdepth 5 -name app-update.yml | head -1)"
```

Expected output includes:

```
provider: github
owner: mingjianliu
repo: gladlog-update-test
updaterCacheDirName: gladlog-updater
```

- [ ] **Step 5: Move 0.0.2-beta.1 artifacts to staging**

```bash
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/gladlog-0.0.2-beta.1-* \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1/
ls -1 /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1/
```

Expected files:

```
gladlog-0.0.2-beta.1-arm64-mac.zip
gladlog-0.0.2-beta.1-arm64-mac.zip.blockmap
gladlog-0.0.2-beta.1-arm64.dmg
latest-mac.yml
```

- [ ] **Step 6: Build 0.0.3 and move to staging (clean `dist-app/` first)**

```bash
rm -rf /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.3";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/gladlog-0.0.3-* \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3/
ls -1 /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3/
```

- [ ] **Step 7: Build 0.0.1 last (clean `dist-app/` first)**

```bash
rm -rf /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.1";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/gladlog-0.0.1-* \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1/
ls -1 /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1/
```

- [ ] **Step 8: Create three releases in order (0.0.1 → 0.0.2-beta.1 → 0.0.3), each with a dedicated commit**

```bash
REPO=/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/repo
KEEP=/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep

echo "v0.0.1" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.1" && git -C "$REPO" push
gh release create v0.0.1 --repo mingjianliu/gladlog-update-test --title v0.0.1 --notes "baseline for auto-update e2e" \
  "$KEEP/0.0.1/gladlog-0.0.1-arm64.dmg" \
  "$KEEP/0.0.1/gladlog-0.0.1-arm64-mac.zip" \
  "$KEEP/0.0.1/gladlog-0.0.1-arm64-mac.zip.blockmap" \
  "$KEEP/0.0.1/latest-mac.yml"

echo "v0.0.2-beta.1" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.2-beta.1" && git -C "$REPO" push
gh release create v0.0.2-beta.1 --repo mingjianliu/gladlog-update-test --prerelease --title v0.0.2-beta.1 --notes "prerelease, MUST be skipped" \
  "$KEEP/0.0.2-beta.1/gladlog-0.0.2-beta.1-arm64.dmg" \
  "$KEEP/0.0.2-beta.1/gladlog-0.0.2-beta.1-arm64-mac.zip" \
  "$KEEP/0.0.2-beta.1/gladlog-0.0.2-beta.1-arm64-mac.zip.blockmap" \
  "$KEEP/0.0.2-beta.1/latest-mac.yml"

echo "v0.0.3" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.3" && git -C "$REPO" push
gh release create v0.0.3 --repo mingjianliu/gladlog-update-test --latest --title v0.0.3 --notes "stable, client should land here" \
  "$KEEP/0.0.3/gladlog-0.0.3-arm64.dmg" \
  "$KEEP/0.0.3/gladlog-0.0.3-arm64-mac.zip" \
  "$KEEP/0.0.3/gladlog-0.0.3-arm64-mac.zip.blockmap" \
  "$KEEP/0.0.3/latest-mac.yml"
```

- [ ] **Step 9: Verify server-side state**

```bash
gh api repos/mingjianliu/gladlog-update-test/releases/latest -q .tag_name
gh release download v0.0.3 --repo mingjianliu/gladlog-update-test --pattern latest-mac.yml --dir /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/verify --clobber
cat /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/verify/latest-mac.yml
gh release view v0.0.3 --repo mingjianliu/gladlog-update-test --json assets -q '.assets[].name'
```

Expected:
1. `v0.0.3`
2. `latest-mac.yml` contains `version: 0.0.3`, `files[0].url: gladlog-0.0.3-arm64-mac.zip`, and `sha512:`
3. Asset list includes `gladlog-0.0.3-arm64-mac.zip`

- [ ] **Step 10: Launch client under test (0.0.1) in background**

```bash
GLADLOG_UPDATER_TEST_FEED=mingjianliu/gladlog-update-test \
GLADLOG_E2E=1 \
GLADLOG_E2E_USER_DATA=/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/userdata \
"/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/mac-arm64/gladlog.app/Contents/MacOS/gladlog"
```

- [ ] **Step 11: Observe state machine logs and UI**

```bash
tail -n 200 -f ~/Library/Logs/gladlog/main.log
```

Expected sequence:
`checking` → `downloading{version:"0.0.3", percent:0…100}` → `ready{version:"0.0.3"}` → `error{message: Squirrel signing failure}`

- [ ] **Step 12: Validate acceptance criteria**

**① `allowPrerelease = false` works**:
- [ ] main.log reports `Found version 0.0.3`
- [ ] **Not** `0.0.2-beta.1`
- [ ] UI displays version `0.0.3`

**② Download completes + sha512 passes + reaches ready**:
- [ ] Observed at least two different `percent` values
- [ ] Reached `ready`, version = 0.0.3
- [ ] `~/Library/Caches/gladlog-updater/` contains downloaded zip

**③ Clean error handling on macOS**:
- [ ] State transitions to `error` with readable Squirrel message
- [ ] Process does not crash
- [ ] No system modal dialogs opened
- [ ] UI not frozen on downloading 100%

- [ ] **Step 13: Restore version in package.json and confirm clean git status**

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update checkout -- packages/desktop/package.json
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update status --porcelain
grep '"version"' /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json
```

- [ ] **Step 14: Record measured results in spec and commit**

Append section `#### 6.2.1 Measured Results` in `docs/superpowers/specs/2026-08-02-auto-update-design.md` and commit:

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update add docs/superpowers/specs/2026-08-02-auto-update-design.md
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update commit -m "docs(desktop): record dummy release e2e test results — 0.0.1 checks 0.0.3, skips prereleases, reaches ready"
```

- [ ] **Step 15: Clean up scratchpad and dummy repository**

```bash
gh repo delete mingjianliu/gladlog-update-test --yes
rm -rf ~/Library/Caches/gladlog-updater
rm -rf /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest
rm -rf /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app
grep -rn "GLADLOG_UPDATER_TEST_FEED" ~/.zshrc ~/.zshenv ~/.zprofile 2>/dev/null
gh repo view mingjianliu/gladlog-update-test 2>&1 | head -2
```

- [ ] **Step 16: Present verification summary**

---

## Task 10: Bilingual CHANGELOG Entries (Committed Along with Release)

Auto-update is a user-visible behavioral change that must be recorded in the CHANGELOG. Per CLAUDE.md bilingual pair rule: `CHANGELOG.md` is the primary English version and `CHANGELOG.zh-CN.md` is the Chinese version. **Both versions must remain equivalent, modifying both files together.**

**Note that no installer filenames are renamed in this release.** `artifactName` in §3.2 uses dots (`gladlog.Setup.X.Y.Z.exe`), matching historical release asset names byte-for-byte; therefore do **not** write "installer renamed" in CHANGELOG.

**Files:**

**Modify:**

- `CHANGELOG.md:9` — insert new v0.1.20 section before `## v0.1.19 (2026-08-02)`
- `CHANGELOG.zh-CN.md:9` — insert equivalent Chinese section before `## v0.1.19(2026-08-02)`

**Test:** None (no bilingual consistency tests exist in the repo; verified via Step 3 manual review).

**Interfaces:**

**Consumes:** Short commit hashes from Tasks 1–8 (`git log --oneline v0.1.19..HEAD`), release date.
**Produces:** No code consumers; consumed during release by `.claude/skills/release/SKILL.md`.

### Steps

- [ ] **Step 1: Insert English section**

Insert before `CHANGELOG.md:9` (replace `<hash-a>`, `<hash-b>`, `<date>` with real values in Step 3):

```markdown
## v0.1.20 (<date>)

This release = **automatic updates for the Windows installer build**.

### Updates

- `<hash-a>` The Windows installer build now updates itself: it checks GitHub 30 seconds after launch and every 4 hours after that, downloads the new build in the background, and shows a "new version ready — restart now / later" banner in the top bar. The install happens on exit, so it can never interrupt a match that is being recorded; if you never click restart, the next ordinary exit installs it anyway. While a recording or a batch analysis is running, "restart now" is disabled. Settings → About gained the current version number, a manual "Check for updates" button, and an "Automatically check for updates" switch (on by default). A failed check is silent by design — pulling 110 MB from GitHub fails often enough that a popup would be noise, and nothing else in the app depends on it.
- `<hash-b>` After an update the top bar shows "Updated to 0.1.20 · What's new" once, linking to that release's notes. Automatic updates are otherwise invisible, and "which version am I on" is the first thing anyone needs when reporting a problem.

Not covered: macOS is unaffected (the build is ad-hoc signed, which Squirrel.Mac refuses, so the updater does not initialise there), and so is the Windows portable zip (there is no installer to hand the download to). **0.1.20 itself still has to be installed by hand** — 0.1.19 does not know how to update itself; the benefit starts with 0.1.21.
```

- [ ] **Step 2: Insert equivalent Chinese section**

Insert before `CHANGELOG.zh-CN.md:9`:

```markdown
## v0.1.20 (<date>)

This release = **Windows installer auto-update** (equivalent section for CHANGELOG.zh-CN.md).

### Updates

- `<hash-a>` The Windows installer build now updates itself: checks 30s after launch and every 4h, downloads in background, displays banner "New version ready — Restart now / Later". **Install happens on exit**, preventing recording interruptions. While recording or batch analysis is running, "Restart now" is disabled. Settings page adds "About" section: current version number, manual "Check for updates" button, "Auto Check for Updates" toggle (on by default). Check failure is intentionally silent.
- `<hash-b>` After an update, top bar displays "Updated to 0.1.20 · What's new" linking to release notes.

Not covered: macOS unaffected (ad-hoc signed); Windows portable zip not enabled (no installer). **0.1.20 itself still has to be installed manually**.
```

- [ ] **Step 3: Replace placeholders and cross-check both versions**

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update log --oneline v0.1.19..HEAD
```

Replace `<hash-a>` with the main feature commit short hash, `<hash-b>` with the §4.7 trace commit short hash, and `<date>` with the release date.

Self-check:

```bash
sed -n '/^## v0.1.20/,/^## v0.1.19/p' /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/CHANGELOG.md | grep -c '^- `'
sed -n '/^## v0.1.20/,/^## v0.1.19/p' /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/CHANGELOG.zh-CN.md | grep -c '^- `'
grep -n '<hash-\|<date>' /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/CHANGELOG.md /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/CHANGELOG.zh-CN.md
```

Expected: first two commands output `2`; third command produces no output.

- [ ] **Step 4: Commit**

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update add CHANGELOG.md CHANGELOG.zh-CN.md
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update commit -m "docs: CHANGELOG 0.1.20 — Windows installer auto-update (bilingual pair)"
```

---

## Closing Checklist (Not a Task, but items to verify one-by-one before merging/releasing)

### A. Pre-Push Must-Run

**Counting criteria:**

Baseline **136 files / 938 tests passed** (verified in this worktree on 2026-08-02). Net delta per task:

| Task | Net Delta | Content                                                                       |
| ---- | --------- | ----------------------------------------------------------------------------- |
| T1   | +6        | Release configuration gate                                                    |
| T2   | +5        | `quitLifecycle.shutdown()`                                                    |
| T3   | +3        | settingsStore two new fields                                                  |
| T4   | +23       | Triple gate + state machine + timers + `install()`                            |
| T5   | +2        | Two `install()` increments: install on shutdown error + watchdog              |
| T6   | +9        | IPC/preload wiring 2 + updateBridge 7                                         |
| T7   | +14       | UpdateBanner (including watchdog error topbar exception)                     |
| T8   | +11       | updateBridge hasUpdateSurface contract 2 + SettingsPanel "About" 9            |

Total **+73 → Target total `Tests 1011 passed`**. File count `136 → 142` (+6 test files: `releaseConfig`, `updater`, `updater.uninstallerName`, `updateChannels`, `updateBridge`, `updateBanner`).

Check current output:

```bash
npm test --workspace=packages/desktop 2>&1 | tail -5
```

**Four gates, run from worktree root `/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update`:**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet && npm run build --workspace=packages/desktop
```

- **`eslint .` scans the full repo, not just `packages/desktop/src`.**
- **`npm run typecheck`, never `tsc -b`**.
- **Fourth command `npm run build --workspace=packages/desktop` (electron-vite build) is mandatory** to catch any incorrect value imports of updater types.
- Ensure the worktree has its own `node_modules`.

If UI was touched (§4.5 topbar widget / §4.6 Settings "About" card), regenerate visual baselines following the 4-step CI workflow (spec §8):

1. Local smoke check: `npm run test:visual:smoke --workspace=packages/desktop`
2. Push branch and run CI: `gh workflow run visual-baseline.yml --ref worktree-auto-update`
3. Download artifacts: `gh run download <run-id> -n visual-baselines` and perform manual visual inspection
4. Overwrite modified PNGs into `packages/desktop/qa/__screenshots__/scenes.spec.ts/` and commit

Verify `qa/budgets.ts:44` `coldStart: 2600` budget by running `npm run test:e2e --workspace=packages/desktop`.

### B. Items NOT Covered in This Change (State clearly, do not let plan look broader than reality)

1. **Whether Windows `latest.yml` is truly produced by CI and captured by upload globs — only verified by real 0.1.20 build.** Local macOS packaging only proves `latest-mac.yml`.
   Verify after release:

   ```bash
   gh release view v0.1.20 --json assets -q '.assets[].name'
   curl -sL https://github.com/mingjianliu/gladlog/releases/download/v0.1.20/latest.yml
   ```

   Checklist:
   - [ ] Assets contain `latest.yml` (**missing it causes silent check failures on all Windows clients**)
   - [ ] Assets contain `latest-mac.yml`
   - [ ] Assets contain `.exe` `.blockmap`
   - [ ] **`path` / `files[0].url` in `latest.yml` match Release `.exe` asset name character-for-character (`gladlog.Setup.0.1.20.exe`)**
   - [ ] Downloaded exe sha512 matches `latest.yml`: `openssl dgst -sha512 -binary gladlog.Setup.0.1.20.exe | openssl base64 -A`
   - [ ] Assets do **not** contain `builder-effective-config.yaml` (strict `*.yml` glob)

2. **Real NSIS package replacement on Windows — only verified on real user Windows machines, lagging one version.**
   - **0.1.20 is released without live Windows auto-update verification** (verifying only that it does not crash or display rogue popups).
   - **0.1.21 will be the first live verification** (detected → background download → banner appears → install on restart → new version number after relaunch → match count under `%APPDATA%\gladlog\matches\` unchanged).

3. **§4.3 quit chaining cannot be verified on macOS.** Task 9 macOS observation uses `MacUpdater.quitAndInstall()` (no args, Squirrel). §4.3 is verified by Task 4/5 unit tests and future Windows real-machine testing.

4. **`install()` false return branch is only covered by unit tests; watchdog only triggered in unit tests.**
   When the installer fails to spawn, `quitAndInstall` does not call `app.quit()`, while `shutdown()` has already stopped services. Task 5's watchdog is the sole fallback (entering `error` after 10s).

   Self-check before merge:

   ```bash
   grep -n "installRequested" packages/desktop/src/renderer/src/components/UpdateBanner.tsx
   grep -rn "Update installer failed to take over" packages/desktop/src/main/updater.ts
   ```

5. **§4.5 busy predicate has a known gap: single-match AI analysis is not covered.**
   `getBatchStatus().running` covers only batch/auto analysis; manual single-match analysis in reports goes through `bridge().analysis.run(...)` directly. Interruption during manual analysis will abort that analysis run without match data loss.

6. **Differential download success rate under domestic networks cannot be quantified.** Falls back silently to full downloads on failure.

7. **`latest.yml` integrity relies on sha512, not code signatures.** Unsigned Windows binaries skip Authenticode verification (`publisherName == null`).

8. **Existing unversioned cross-version gaps remain untouched (spec §7).** `matchStore` `schemaVersion: 1` is not validated on read. §4.7 post-update trace does not fix this, but ensures users see "Updated to X" trace clues.

### C. Release

- **CHANGELOG per Task 10** (bilingual pair). Synchronize any documentation updates across bilingual pairs (`docs/BUILD-WINDOWS.md:45` + `docs/BUILD-WINDOWS.zh-CN.md:44` + `docs/commands/release-gladlog.md:48` already synchronized in Task 1 Step 6).
- Follow `.claude/skills/release/SKILL.md` workflow.
- **Never reuse version numbers.** Overwriting vX prevents clients on vX from receiving updates.
- Immediately execute B.1 checklist upon release; do not wait for user failure reports.
