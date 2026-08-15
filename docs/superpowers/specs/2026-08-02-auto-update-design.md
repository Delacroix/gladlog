# gladlog desktop Auto-Update — Design

Date: 2026-08-02 · Branch: `worktree-auto-update` · Status: To be implemented

## 1. Background and Goals

Current state: For every release, users manually download `gladlog.Setup.X.Y.Z.exe` from GitHub Release to reinstall.

Goal: Windows installer users automatically install the new version when exiting the app, so the next launch is up-to-date.

## 2. Scope

**In scope**: Full auto-update for Windows NSIS installer versions (check → background download → prompt → install).

**Out of scope**:

| Excluded Item | Reason |
| --- | --- |
| macOS auto-update | `build/afterSign.cjs` uses ad-hoc signing (`codesign --sign -`). Squirrel.Mac requires the update package signature to match the running app's designated requirement. Ad-hoc has no stable identity, so validation will definitely fail. Doing this requires an Apple Developer ID (99 USD/year) |
| Windows zip portable auto-update | electron-updater only supports NSIS formats. See guards in §4.1 |
| Prerelease (`-obs.6` / `-ds.1`) pushes | User decision: Only auto-update stable releases. `allowPrerelease = false` |
| Self-hosted update feed | Repository is public, GitHub provider works without a token |

## 3. Publisher Side

### 3.1 Add publish configuration

Added to the `build` field in `packages/desktop/package.json`:

```json
"publish": { "provider": "github", "owner": "mingjianliu", "repo": "gladlog" }
```

This line serves two purposes, the second of which is a prerequisite for the client to work:

1. During build, it writes `latest.yml` (Windows) / `latest-mac.yml` (mac) + `.blockmap` to `dist-app/`.
2. It bundles `app-update.yml` into the app's resources (for Windows, it is `resources/app-update.yml`, which is `process.resourcesPath` at runtime) — the installed app relies on this to know where to check for updates.

The failure mode of a missing `app-update.yml` occurs **during the first `checkForUpdates()`** as a `readFile` ENOENT, bubbling up through both an `error` event + rejected promise (`AppUpdater.js`'s `loadUpdateConfig` → :271 `this.emit("error", e); throw e`). It does **not** throw immediately on startup. This brings two implementation constraints, see §4.2.

### 3.2 NSIS artifactName must remove spaces — otherwise auto-update will always 404

**This is a defect found in the 2026-08-03 verification round. If not fixed, all other changes in this section are in vain.**

Mismatch chain:

1. The default NSIS local artifact name is `gladlog Setup 0.1.19.exe`, **with spaces** (`installerFilenamePattern` in `app-builder-lib/out/targets/nsis/NsisTarget.js:100-104`).
2. When electron-builder writes `latest.yml`, it goes through `computeSafeArtifactNameIfNeeded` (`platformPackager.js:690-703`), determines spaces are unsafe → replaces spaces with **dashes** → the `path` in yml becomes `gladlog-Setup-0.1.19.exe`.
3. However, CI uses softprops to directly upload the local file, and **GitHub normalizes spaces in the filename to dots** → The actual asset name on the Release is `gladlog.Setup.0.1.19.exe` (verified in v0.1.19).
4. The client's `resolveFiles` in `GitHubProvider.js:179-181` only does `p.replace(/ /g, "-")`, so the constructed download URL uses dashes → **404**. The same applies to `.blockmap` (URL directly appends `.blockmap` to the exe URL).

Fix: Add to `build.nsis`

```json
"artifactName": "${productName}.Setup.${version}.${ext}"
```

**Use dots, not dashes.** `isSafeGithubName` is `/^[0-9A-Za-z._-]+$/` (`platformPackager.js:687-689`), dots are valid characters, so the local name `gladlog.Setup.0.1.20.exe` directly passes the safety check, `computeSafeArtifactNameIfNeeded` returns `null`, and no rewriting occurs; GitHub also has no spaces to normalize. Local name = `path` in `latest.yml` = Release asset name, the three are byte-for-byte identical.

Reason for choosing dots over dashes: This name is **byte-for-byte identical** to the asset name of every historical release. Users won't notice a change, and we don't need to change a single word in 5 documents like `README` / `user-guide` / `release-gladlog`. The dash solution would also fix the 404, but we'd pay the price of renaming for nothing.

macOS side is unaffected: `gladlog-0.1.20-arm64.dmg` / `-arm64-mac.zip` already satisfy the regex.

#### 3.2.1 Why the existing "build only, no publish" workflow needs no changes

**Verified**: The `createUpdateInfoTasks` branch in `app-builder-lib/out/publish/PublishManager.js:158-163` is outside of `if (this.isPublish)` — as long as there is a publish configuration, it writes the yml, regardless of whether it's actually publishing. So the existing "electron-builder only builds, softprops handles upload" workflow needs no changes.

Windows zip targets do not generate `latest.yml` (`isSuitableWindowsTarget` only recognizes nsis), so they are unaffected.

### 3.3 workflow upload glob

Add two lines to the upload-artifact and Release globs in `.github/workflows/build.yml`:

```
packages/desktop/dist-app/*.yml
packages/desktop/dist-app/*.blockmap
```

Assets increased from 4 to 7:

| File | Purpose |
| --- | --- |
| `latest.yml` | The only thing the client reads: version, exe filename, sha512 (~300 B). |
| `gladlog.Setup.X.Y.Z.exe.blockmap` | Block hash, used for differential download. |
| `latest-mac.yml` | macOS equivalent. Currently unused (macOS does not enable updater), keeping it in case we buy a certificate in the future. |

### 3.4 Delete `packages/desktop/electron-builder.yml`

**It's dead configuration.** electron-builder's configuration parsing prioritizes the `build` field in `package.json`; if it exists, it doesn't read the yml at all (`read-config-file`'s `getConfig`: first checks `packageMetadata[packageKey]`, returns if found, stops looking for config files).

Evidence: The yml says `win: target: nsis` (only nsis), but the actual release produced `gladlog-0.1.19-win.zip` — that's the zip target from package.json.

The cost of keeping it is that the next person will write configurations in it and they will silently fail to apply. Delete it.

### 3.5 Corresponding changes to release skill

Two places in `.claude/skills/release/SKILL.md`:

- Asset acceptance checklist 4 → 7. **Missing `latest.yml` results in silent update check failures for all clients**, it must be in the checklist.
- The warning in the "Overwriting existing version" section is upgraded: After overwriting vX, clients that have already installed vX have the same version number and will not receive the update, leaving them with old content while thinking they are up-to-date. The original "default should bump +1" is changed from a suggestion to a hard rule.

## 4. Client

New module `packages/desktop/src/main/updater.ts`. Dependency injects `autoUpdater` / `app` / `quitLifecycle`, reasoning is the same as the header comment in `quitLifecycle.ts` — real electron cannot be instantiated lightly in vitest, and this layer can be tested completely independently of electron after injection.

### 4.1 Three-fold activation gate

```ts
process.platform === "win32" && // mac ad-hoc signature fails Squirrel validation
  app.isPackaged && // see note below — not to prevent throwing errors
  isNsisInstalled(); // zip portable version guard
```

`isNsisInstalled()` = A file matching `/^Uninstall .+\.exe$/` exists under `dirname(process.execPath)`.

Basis: `app-builder-lib/templates/nsis/common.nsh:17` defines `UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"`, and `include/installer.nsh:100` writes it to `$INSTDIR`. The installer version will definitely have it, while the zip extracted version will not. If the user changes the installation directory, it's also unaffected (the uninstaller is always in the same directory as the exe).

**Scan by pattern instead of hardcoding `"Uninstall gladlog.exe"`** — If `productName` is changed, hardcoding will silently fail, and the failure direction is "falsely judged as portable version, silently not updating", without any errors.

Why the zip portable version must be blocked: The extracted running app also has `app.isPackaged === true` and `app-update.yml` in its resources. electron-updater cannot distinguish them, so it will download Setup.exe as usual and run the installer — resulting in an extra copy installed in `%LOCALAPPDATA%\Programs\gladlog` on the machine, while the original extracted directory remains, turning into two copies.

The three-fold gate also conveniently solves the test environment: vitest and E2E are not packaged, so they naturally won't make real network requests.

The reason for the `app.isPackaged` gate **is not "preventing thrown errors"** (corrected in 2026-08-03 verification round): When not packaged, electron-updater itself is a no-op — `checkForUpdates()` silently `resolve(null)`s and logs an info message, it doesn't throw. This gate is kept so the state machine can directly report `reason: "dev"` instead of staying in `idle`, conveniently suppressing log noise under dev.

### 4.2 State Machine

Main process holds the single source of truth:

```ts
type UpdateState =
  | { phase: "disabled"; reason: "platform" | "dev" | "portable" }
  | { phase: "idle"; lastCheckedAt: number | null }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };
```

Renderer both subscribes to pushes and can fetch via `getState()` — when windows reopen or pages switch, mounting might happen after events, so relying solely on pushes drops states. This follows the existing `getStatus()` snapshot pattern in the repo.

electron-updater events → state mapping:

| Event | State |
| --- | --- |
| `checking-for-update` | `checking` |
| `update-available` | `downloading` (autoDownload=true, enters download directly) |
| `download-progress` | `downloading` + percent |
| `update-downloaded` | `ready` |
| `update-not-available` | `idle` |
| `error` | `error` |

electron-updater actually emits **9** events, not 6 (`AppUpdater.d.ts:14-24`). The three outside the table above: `update-cancelled` (only emitted when download throws `CancellationError`; we have `autoDownload=true` and never actively cancel, so it's practically impossible to emit, but the state machine should explicitly ignore it if using an exhaustive switch), `login` (proxy authentication), `appimage-filename-updated` (Linux AppImage only, win/mac never trigger). Not listening to them won't crash — EventEmitter is only special regarding `error`.

**`error` does not popup or disturb**, it only logs to electron-log (existing repo dependency) + updates state. Pulling 110 MB from GitHub means network failures are common, and we shouldn't harass the user; failure does not affect any log collection or analysis functions.

Two **implementation constraints** derived from this (2026-08-03 verification round):

1. `autoUpdater.on("error", ...)` must be registered before **any** `checkForUpdates()`. When EventEmitter has no `error` listener, it throws the error as uncaught, which is the exact opposite of the "do not disturb" goal.
2. `checkForUpdates()`'s returned promise must have a `.catch` — on failure, it **both emits and rethrows**, we need to catch both paths.

Configuration:

```ts
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true; // Fallback: if user doesn't click restart, install on next normal quit
autoUpdater.allowPrerelease = false; // User decision
autoUpdater.disableWebInstaller = true; // We distribute a standalone installer, not a web installer
autoUpdater.logger = electronLog;
```

`disableWebInstaller` defaults to false, `NsisUpdater.js:44-46` logs a warning "you should set it to true" during every download. We use standard NSIS standalone installers, setting it to true reduces noise and locks the behavior against future default value flips.

The `allowPrerelease = false` line has a pitfall: the constructor has `this.allowPrerelease = hasPrereleaseComponents(currentVersion)` (`AppUpdater.js:217-218`) — when running on a package like `0.1.15-obs.6`, it will be **automatically set to true**. Therefore, this assignment must be executed **unconditionally** after construction and before `checkForUpdates`, and cannot just be in some conditional branch.

`autoUpdater.logger = electronLog` is equally indispensable: the default logger is `console` (`AppUpdater.js:179`). Without setting it, lines like `Checking for update` / `Found version X` will never go into `~/Library/Logs/gladlog/main.log`, which is the primary evidence channel for the end-to-end verification in §6.2.

Checking cadence: Once 30 seconds after startup (avoids competing for IO with window creation / corpus loading / log scanning), then once every 4 hours.

Automatic checking is controlled by the `autoCheckUpdates` switch in §4.6; **the "Check for Updates" button on the settings page is not affected by this switch** — users who turn off automatic checking still need an entry to check manually, otherwise the switch completely kills the feature.

### 4.2.1 Test escape hatch

The dummy release verification in §6.2 needs to run the updater on macOS, which conflicts with the `win32` gate in §4.1. Following the precedent set by `src/main/e2eEnv.ts` (E2E uses environment variables to move userData to a temporary path), we open a similar hatch:

`GLADLOG_UPDATER_TEST_FEED=<owner>/<repo>` — When set, it skips the `win32` and `isNsisInstalled()` gates (but **does not skip** `app.isPackaged`), and points the feed to the given repository.

Constraint, copying the approach from `e2eEnv.ts`: If set but the value is invalid, **throw an error instead of silently falling back**. Silently falling back to the production feed would make the test look like it passed while actually verifying nothing.

`updater.test.ts` must have a test: When this variable is not set, the three-fold gate behavior perfectly matches the description in this section.

### 4.3 Merging the quit chain ← The core risk point of this design

Internally, `autoUpdater.quitAndInstall()` does "first spawn NSIS installer (detached), then `app.quit()`".

However, the first `before-quit` in `quitLifecycle.ts` uses `preventDefault()` to suspend and stop OBS recording (4s cap) / stop workers / reap AI subprocesses.

The consequence of a naked call to `quitAndInstall()`: **The installer is already running outside, while recording cleanup is still running inside**. Which finishes first is uncertain — at best the recording file isn't finalized, at worst the installer times out and gives up, or force-kills the process.

The fix is to keep only one cleanup chain, and append `quitAndInstall` to the end of it:

```ts
async function installNow() {
  await quitLifecycle.shutdown(); // Stop recording/worker/AI, reuse existing chain
  autoUpdater.quitAndInstall(true, true); // Start installer only after cleanup is done; second true = auto-restart after install
}
```

When the `app.quit()` inside `quitAndInstall` triggers `before-quit`, the phase is already `finishing`, so `quitLifecycle` directly lets it through — the two chains naturally connect, no extra flags needed.

**Fallback for installer failing to take over (Watchdog).** `BaseUpdater.js:16-25`: When the internal `install()` returns false, `quitAndInstall` **does not** call `app.quit()`, it only resets the flag, and it returns `void`, so we can't get that false. At this point, `shutdown()` has already stopped recording / workers / AI subprocesses, and `quitLifecycle`'s phase has flipped to `finishing` — **the app is still alive, but all functionality is dead**, and the user sees nothing.

Therefore, after `quitAndInstall`, we arm a 10s timer (`INSTALL_WATCHDOG_MS`). If it's not taken over by the timeout, we drop into `{ phase: "error", message: "Update installer failed to take over, please manually exit gladlog and reopen" }`, and **do not release the single instance lock** (releasing it would let two installers operate on the same directory simultaneously).

We deliberately do **not** call `app.quit()` from the updater to self-rescue: it doesn't own the quit dependencies, opening another quit path bypassing `quitLifecycle` is worse than leaving a visible error state.

Changes to `quitLifecycle.ts`: split `finish()` into `cleanup()` + `quit()`, export an additional `shutdown(): Promise<void>` (runs cleanup, flips phase to `finishing`, doesn't call quit). The existing `onBeforeQuit` semantics and 9 tests remain unchanged.

This is the same application of the CLAUDE.md rule "predicates exported from one place, imported by both sides" to the quit process: one place for cleanup logic, two entry points, no copying a second instance.

### 4.4 IPC surface

Keep existing naming conventions in the repository:

- `gladlog:update:getState` → `UpdateState`
- `gladlog:update:check` → Manual trigger
- `gladlog:update:install` → Triggers `installNow()` from §4.3
- Push `gladlog:update:state` (main → renderer)

Add to preload: `update: { getState, check, install, onState }`, subscription follows the `logs.onMatchStored` pattern.

### 4.5 UI

**Downloading**: A line of small text on the right side of the top navigation bar (`Matches/Stats/Settings/Developer` row) saying "Downloading 0.1.20 · 37%", not clickable, not disturbing.

**Ready**: A closable banner appears at the top "New version 0.1.20 is ready — Restart Now / Later". Clicking "Later" collapses the banner, degrading it into a persistent small button on the navigation bar that can be clicked anytime.

Reason for not using a permanent banner: A persistent banner would continuously squeeze the visible height of the match list, and list density is the primary value of this app. Only showing it when ready and making it closable balances being "noticeable" and "not taking up space".

**When recording or running analysis, "Restart Now" is disabled**, and the text changes to "Recording in progress, will automatically update on exit".

The criterion for "busy" is not newly created: directly consume the two existing sources in the renderer — recording state takes the existing state push from `recorder`, and in-flight analysis takes the existing in-flight set from `BatchAnalyzeBar` / `autoAnalyze`. **Do not create a new "is busy" judgment just for this banner**, otherwise it becomes another manually copied predicate that will drift from the true state.

**The only error that must disturb the user.** The "error does not disturb" in §4.2 only covers check / download failures (network failure is the norm, silently returns to idle). There is one exception: an error that occurs **after the user clicks "Restart Now"** — at that time, the cleanup chain has finished, recording / workers / AI are all stopped, and a blank top bar would just be a "looks normal, but functionality is totally dead" window (trigger path is the watchdog in §4.3).

This path must be rendered in the top bar. The criterion uses the renderer's **local fact** "installation was clicked during this session", **not** matching the message text from the main side — that text is produced in `src/main/updater.ts`, the renderer can only `import type`, copying it as a string constant creates a manually copied predicate that will silently rot.

This blocks the **only new risk** introduced by this feature: the prompt banner might tempt users to click restart in the middle of playing a game. The installation itself happens on exit, so it's physically impossible to interrupt an ongoing match recording — but the banner creates an incentive to "exit when you shouldn't", which must be blocked by the UI.

### 4.6 Settings page "About" section

Appended to `SettingsPanel.tsx`:

- Current version number — currently the settings page doesn't show the version at all, making it impossible to know which version you're on when reporting bugs
- "Check for Updates" button + last checked time
- "Automatically check for updates" switch, default on (saved in `settingsStore`)

The switch is an escape hatch, costing one boolean.

**But "adding one field" is more expensive than it looks** (2026-08-03 verification round): `GladlogSettings` is an interface with all required fields. Adding a field will immediately turn three full-object literals red —
`interface` + `DEFAULTS` in `src/main/settingsStore.ts`,
The default value snapshot assertion **and** the `base` literal in the `redactSettings` test case in `test/settingsStore.test.ts` (two places, don't just change the first one),
The `GladlogSettings` full-object literal in `src/renderer/src/fixtureBridge.ts`.
Missing any of them will immediately turn `npm run typecheck` red. The **implementations** of `sanitizeSettingsPatch` and `redactSettings` don't need changes (it's a blacklist validator, existing boolean fields don't have extra validation either).

### 4.7 Post-update trace

Upon first launch after installing a new version, the navigation bar leaves a trace "Updated to 0.1.20 · What's new", clicking it does `shell.openExternal` to that tag's GitHub Release page. `settingsStore` stores `lastSeenVersion`, compares it with `app.getVersion()`, and writes it back when clicked or dismissed.

For the reason, see "Invisible cross-version upgrades" in §7.

## 5. User Data Security (Source-level conclusions)

The program is installed in `%LOCALAPPDATA%\Programs\gladlog\`; all user data is in `%APPDATA%\gladlog\` (`app.getPath("userData")`, see `src/main/index.ts`): `matches/`, `learning/`, `recordings/`, `icons/`, `settings.json`, `window-state.json`, `checkpoints.json`. The two directories are independent of each other.

The NSIS upgrade process does not enter the data directory, **three independent guards**:

1. `deleteAppDataOnUninstall` is not configured → `DELETE_APP_DATA_ON_UNINSTALL` is not defined
2. During upgrade, it calls the old uninstaller with `/S /KEEP_APP_DATA` (`installUtil.nsh:224`); original source comment: "always pass `--updated` flag - to ensure that if `DELETE_APP_DATA_ON_UNINSTALL` is defined, user data will be not removed"
3. The data deletion block is also wrapped in `${ifNot} ${isUpdated}` (`uninstaller.nsh:223-224`), which is false during upgrades

WoW combat logs are in the game directory, the app only reads and does not write, unaffected.

**Analysis cache**: `PROMPT_VERSION` (currently 15) in `src/shared/promptVersion.ts` is the version key shared by cache writing and reading. If the schema changes, we bump it, and the old cache is discarded and recalculated by `getCached` — there will be no mismatch of "reading old cache with new version logic". `analysisSlots.ts` has a separate v1→v2 real migration path. This part is already covered.

## 6. Verification Plan

### 6.1 Unit tests (`updater.test.ts`)

- Three-fold gate: not win32 / not packaged / no uninstaller → `disabled`, and **never calls** `checkForUpdates`
- State machine: Event sequence → state snapshot
- `installNow()` call order: `shutdown()` must resolve before calling `quitAndInstall` (order assertion, not just "both were called" assertion)
- `error` events don't throw, don't popup, only update state

Added three tests to `quitLifecycle.test.ts`: recording stopped after `shutdown()` / phase flipped to `finishing` / repeated calls are not reentrant.

### 6.2 dummy release end-to-end (Local Mac, user decided to adopt)

Create a throwaway public repository `mingjianliu/gladlog-update-test` (only push one README commit), build three local versions, and hook them up with `gh release create`.

Override publish targets via CLI during packaging, **do not change `package.json`** — to prevent the test repo name from accidentally being committed into the formal config:

```
electron-builder --mac -c.publish.provider=github \
  -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
```

Change the `version` in `packages/desktop/package.json` once for each version and then build. Upload all three artifacts (`.dmg` / `-mac.zip` / `latest-mac.yml` / `.blockmap`). Run `git checkout` to drop the version number changes when done.

On the client side, start the packaged 0.0.1 app using `GLADLOG_UPDATER_TEST_FEED=mingjianliu/gladlog-update-test` from §4.2.1.

| Version | Role |
| --- | --- |
| `v0.0.1` | Client baseline |
| `v0.0.2-beta.1` | Marked prerelease, **must be skipped** |
| `v0.0.3` | Stable version, client should jump directly here |

Criterion: The client running 0.0.1 detects 0.0.3 (**not** 0.0.2-beta.1) → download finishes → sha512 validation passes → state machine advances to `ready`.

**Why not publish to the official repo**: GitHub's "Latest" badge goes by publish time, not version number. Publishing a v0.0.3 would bump v0.1.19 down, and visitors would see a test package as the latest version; meanwhile, testing "skip prerelease" requires a non-prerelease dummy, which is unavoidable. After testing, clear it with `gh repo delete`.

Coverage: feed parsing, version selection logic, prerelease skipping, downloading, sha512, state machine transitions. Covers about 80% of the risk surface, precisely the parts easiest to misconfigure.

**Not covered**:

- macOS will fail due to ad-hoc signing — expected behavior, not a bug. **2026-08-04 empirical correction**: the failure happens **before** `update-downloaded`, not after. Squirrel.Mac stages immediately upon download completion, hitting the signature check on the spot, so the `update-downloaded` event is **never emitted**. The state jumps directly from `downloading` to `error`, and the "Ready / Restart Now" banner never appears in the top bar. This means `ready` state and installation paths cannot be tested on mac, it only proves "detect → download → sha512 → fails cleanly".
- Local mac packaging only proves `latest-mac.yml` generates normally. **Whether the Windows side `latest.yml` is actually produced by CI and caught by the upload glob can only be proven by the 0.1.20 real build** — post-release, we must verify there are 7 Release assets, and `curl` the `latest.yml` to confirm its `path` / `sha512` match the actual exe (`shasum -a 512` comparison). This goes into the release skill checklist in §3.5.

### 6.2.1 实测记录(2026-08-04)

跑法:丢弃仓库 `mingjianliu/gladlog-update-test`,三个 dummy release(v0.0.1 正式 / v0.0.2-beta.1 **prerelease** / v0.0.3 正式),本机启动打包好的 0.0.1 版 `.app`,`GLADLOG_UPDATER_TEST_FEED` 指向该仓库,userData 经 `GLADLOG_E2E_USER_DATA` 隔离。

**判据①(头号目标)`allowPrerelease = false` 真的生效 —— 通过**

`~/Library/Logs/gladlog/main.log` 原文:

```
13:13:03  [updater] armed (test feed mingjianliu/gladlog-update-test)
13:13:33  Checking for update
13:13:34  Found version 0.0.3 (url: gladlog-0.0.3-arm64-mac.zip, gladlog-0.0.3-arm64.dmg)
```

- ①-1 `Found version` = **0.0.3** —— 通过
- ①-2 **不是** 0.0.2-beta.1 —— 通过
- ①-3 UI 上的版本号也是 0.0.3 —— **给不出(结构性,非无人观察)**:mac 上到不了 `ready` 态,顶栏永远不渲染检测到的版本号(见 §6.2「不覆盖」第一条)

服务端侧独立佐证:`gh api repos/mingjianliu/gladlog-update-test/releases/latest -q .tag_name` → `v0.0.3`。

**判据② 下载与校验 —— 部分通过**

- ②-1 下载完成 + sha512 通过 —— 通过。`13:18:31 New version 0.0.3 has been downloaded to .../pending/gladlog-0.0.3-arm64-mac.zip`(137 MB,约 5 分钟)。electron-updater 校验不过不会写进 `pending/`
- ②-2 走到 `ready` —— **给不出(结构性)**,同上
- ②-percent 至少两个不同的 percent 值 —— **给不出**:percent 事件不进 `main.log`;用户目视确认过进度在动,但没记录具体值
- 差分下载按预期回退全量(`Unable to locate previous update.zip ... falling back to full download`)—— 首次安装无旧包可差分,正常路径

**判据③ mac 失败得干净 —— 通过**

```
13:18:31  Creating proxy server for native Squirrel.Mac
13:18:32  Error: Code signature at URL file:///.../ShipIt/update.KaWTGKU/gladlog.app/
          did not pass validation: code failed to satisfy specified code requirement(s)
```

- ③-1 error message 是 Squirrel 原文、可读非 `undefined` —— 通过。用户在设置页「关于 → 更新」一行**原样看到了这句**
- ③-2 进程存活 + 窗口还在 —— 通过(主进程 pid 存活,用户持续在界面上操作)
- ③-3 无模态框 / 无崩溃 —— 通过。`~/Library/Logs/DiagnosticReports/` 无 gladlog 崩溃报告
- ③-4 顶栏没卡在「正在下载 100%」—— 通过。截图确认顶栏**完全为空**,符合 §4.2「error 不打扰」(用户没点过「立即重启」,§4.5 那条例外不触发)
- ③-5 点得动「立即重启」—— **N/A**:mac 到不了 `ready`,没有这个按钮

**新发现的缺陷(真机截图才暴露)**:设置页「更新」那一行把 error message **截断**了,显示成
`Code signature at URL file:///Users/mingjianliu/Library/Caches/com.gla…` —— 恰好截在**原因之前**,用户看得到一段路径、看不到 `did not pass validation`。
这削弱了「把错误暴露给用户」本身的意义。生产影响有限(mac 在生产里根本不启用 updater;Windows 侧的典型错误是 `net::ERR_TIMED_OUT` 这类短文本,不会截),但值得修 —— 最小修法是给那一行加 `title` 属性支持悬停看全文。

**额外发现(实测才知道的)**

1. 重试**不重新下载**:用户手点了 6 次「检查更新」,6 次都失败在签名校验,但缓存目录始终只有那一个 137 MB 的 zip(mtime 不变)。Squirrel 走本地代理从缓存喂,带宽安全
2. ShipIt 暂存目录**零残留**:6 次失败各建一个 `update.XXXXXXX`,跑完 `~/Library/Caches/com.gladlog.desktop.ShipIt` 是 0 B —— Squirrel 失败后自己清了,不会堆盘
3. `FIRST_CHECK_DELAY_MS` 实测生效:armed 到 Checking 正好 30 秒,且是**自动触发**的,不需要点按钮
4. updater 缓存目录实为 `~/Library/Caches/@gladlogdesktop-updater/`(计划里假设的 `gladlog-updater` 是错的)

### 6.3 Windows 真机(只有用户能做)

NSIS 真正的换包动作需要 Windows GUI 会话,本机无法验证。

时间线上这一步天然滞后一个版本:要验证"从 A 版自动更新到 B 版",前提是 A 版已装在机器上。所以:

- **0.1.20 发出去时,自动更新处于未经真机验证的状态** —— 只能证明它没崩、没乱弹
- 0.1.21 才是第一次真正验证

真机验收判据:检测到 → 后台下载 → 提示条出现 → 点重启装上 → `%APPDATA%\gladlog\matches\` 下对局数不变。

## 7. 已知缺口与风险

| 项                               | 说明                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本次改动救不了下一次手动下载** | 0.1.19 里没有 updater,不会因为 Release 多了个 `latest.yml` 就学会自检查。0.1.20 仍需手动装,收益从 0.1.21 起兑现                                                                                                                                                                           |
| **国内从 GitHub 下 110 MB**      | 本功能最大的不确定性。blockmap 差分理论上只传变化块(110 MB 里约 100 MB 是版本间不变的 Electron 运行时),顺利时降到几 MB~几十 MB,但 NSIS 压缩边界一移动差分即失效、回退全量。失败无后果(静默回 idle)。实际成功率**现在给不出数**,需真机跑过才知道                                           |
| **无感跨版本**                   | 手动下载时用户知道自己升级了;自动更新是无感的。分析缓存已被 `PROMPT_VERSION` 兜住,但 `matchStore` 写 `match.json` 时带的 `schemaVersion: 1` **读取侧无任何地方检查** —— 对局文档结构若变更,旧文档会被静默按新结构读。这是既有缺口,非本功能引入;§4.7 的留痕不修它,只保证出问题时用户有线索 |
| **旧版本用户零影响**             | 0.1.19 及以前的包不知道有这回事,不会突然弹东西                                                                                                                                                                                                                                            |
| **mac 用户零影响**               | updater 不初始化                                                                                                                                                                                                                                                                          |

## 8. 文件清单

新增:

- `packages/desktop/src/main/updater.ts`
- `packages/desktop/src/main/updater.test.ts`
- `packages/desktop/src/main/updater.uninstallerName.test.ts` —— §4.1 的卸载器谓词与 app-builder-lib 的 NSIS 模板之间的跨包一致性门
- `packages/desktop/src/renderer/src/update/updateBridge.ts` —— renderer 侧唯一的更新面入口,**且是 §4.7 留痕判据(取版本 / 比对 `lastSeenVersion` / null 时静默写回 / 点掉写回)的唯一实现**。`UpdateBanner` 与 `SettingsPanel` 一律 import 它,不许在组件里内联第二份
- `packages/desktop/test/updateBridge.test.ts`
- `packages/desktop/test/updateChannels.test.ts` —— IPC 频道名三处一致的文本对账
- `packages/desktop/test/releaseConfig.test.ts` —— §3 发布端配置的守卫(publish / artifactName / build.yml glob / 死配置已删)
- `packages/desktop/src/renderer/src/components/UpdateBanner.tsx`(+ 测试)

修改:

- `packages/desktop/package.json` —— `publish` 配置、`build.nsis.artifactName`(§3.2)、`electron-updater` 进 `dependencies`
- `packages/desktop/src/main/quitLifecycle.ts` —— 抽 `shutdown()`
- `packages/desktop/src/main/quitLifecycle.test.ts` —— +3 条
- `packages/desktop/src/main/index.ts` —— 接线(插在 `registerIpc({...})` 之后、`learning.init()` 之前;推送要用 `win?.webContents.send`,而窗口比模块作用域的 `quitLifecycle` 晚创建)
- `packages/desktop/src/main/ipc.ts` —— update 面
- `packages/desktop/src/main/settingsStore.ts` —— `autoCheckUpdates` / `lastSeenVersion`
- `packages/desktop/test/settingsStore.test.ts` —— 两处全量字面量补字段(见 §4.6)
- `packages/desktop/src/renderer/src/fixtureBridge.ts` —— `GladlogSettings` 全量字面量补字段
- `packages/desktop/src/preload/index.ts` + `src/preload/api.ts` —— bridge
- `packages/desktop/src/renderer/src/App.tsx` —— 导航条挂件
- `packages/desktop/src/renderer/src/components/SettingsPanel.tsx` —— 关于小节
- `packages/desktop/src/renderer/src/styles.css` —— topbar 更新位样式
- `packages/desktop/test/settingsPanel.test.tsx` —— mockBridge 扩容 +「关于」小节用例
- `packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png` —— 设置页多出「关于」卡片,基线按本节末尾的四步流程在 CI 重生成
- `docs/BUILD-WINDOWS.md` + `docs/BUILD-WINDOWS.zh-CN.md` —— 本地构建产物名随 §3.2 的 `artifactName` 从 `gladlog Setup X.Y.Z.exe` 变成 `gladlog.Setup.X.Y.Z.exe`(双语成对,必须同改)
- `docs/commands/release-gladlog.md` —— 同上一条(只改 :48 的产物名;:78 是下载 URL,本来就是点号形式,**不动**)
- `.github/workflows/build.yml` —— 上传 glob
- `.claude/skills/release/SKILL.md` —— 资产清单 + 覆盖版本警告
- `CHANGELOG.md` + `CHANGELOG.zh-CN.md` —— 双语成对,随发版提交

删除:

- `packages/desktop/electron-builder.yml`

注:`electron-updater` 必须进 `dependencies` 而非 `devDependencies` —— `electron.vite.config.ts` 的 `externalizeDepsPlugin` 按 `dependencies` 外部化,且打包时要被 electron-builder 收进 app 的 `node_modules`。同时**不要**加进 `exclude` 列表(那个列表是给 `@gladlog/*` 工作区包用的,因为它们的 `main` 指向 TS 源码)。

代码注释按仓库惯例写英文。

**不要**动 `docs/predicate-index.md`(2026-08-03 核查轮的结论):自动更新不产生需要登记进谓词索引的行。真正适用「谓词单源」那条规矩的是 §4.3(清理链一处、两个入口)和 §4.5(忙判据不许新造),这两条靠单测保,登记进索引反而会白改三个文件并打红 eval 的一致性测试。

**视觉基线**:顶部横幅会改动 `app-topbar`,可能打红视觉基线。重生成基线**不能在本机跑** `npm run test:visual`(会往单源基线里混进 mac 渲染的图)。正确流程四步:本机只跑 `test:visual:smoke` 自查不崩 → 推分支后 `gh workflow run visual-baseline.yml --ref <branch>` → `gh run download` 取 artifact 人工审图 → 把改动的 PNG 覆盖进 `packages/desktop/qa/__screenshots__/` 并提交。
