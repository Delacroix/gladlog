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

### 4.3 退出链合并 ← 本设计的核心风险点

`autoUpdater.quitAndInstall()` 内部是「先 spawn NSIS 安装器(detached),再 `app.quit()`」。

而 `quitLifecycle.ts` 第一次 `before-quit` 是 `preventDefault()` 挂起去停 OBS 录像(4 s 封顶)/ 停 worker / 收 AI 子进程。

裸调 `quitAndInstall()` 的后果:**安装器已在外面跑,录像清理还在里面跑**,谁先谁后不确定 —— 轻则录像文件没封好,重则安装器超时放弃或强杀进程。

修法是只保留一条清理链,把 `quitAndInstall` 挂在链尾:

```ts
async function installNow() {
  await quitLifecycle.shutdown(); // 停录像/worker/AI,复用既有链
  autoUpdater.quitAndInstall(true, true); // 清理已毕才起安装器;第二个 true = 装完自动重开
}
```

`quitAndInstall` 内部那个 `app.quit()` 触发 `before-quit` 时,phase 已是 `finishing`,`quitLifecycle` 直接放行 —— 两条链天然接上,不需要额外标志位。

**安装器未接管的兜底(看门狗)。** `BaseUpdater.js:16-25`:内部 `install()` 返回 false 时 `quitAndInstall` **不调** `app.quit()`,只复位标志,而且它返回 `void`,拿不到那个 false。此时 `shutdown()` 已经停了录像 / worker / AI 子进程,`quitLifecycle` 的 phase 也已翻成 `finishing` —— **app 还活着,但功能全废**,而用户什么都看不到。

所以 `quitAndInstall` 之后 arm 一个 10 s 定时器(`INSTALL_WATCHDOG_MS`),超时未被接管就落 `{ phase: "error", message: "更新安装器未能接管,请手动退出 gladlog 后重新打开" }`,并且**不释放单飞闩锁**(放开会让两个安装器同时操作一个目录)。

刻意**不**从 updater 里调 `app.quit()` 自救:它不持有 quit 依赖,再开一条绕过 `quitLifecycle` 的退出路径,比留一个可见的错误状态更糟。

`quitLifecycle.ts` 的改动:把 `finish()` 拆成 `cleanup()` + `quit()`,对外多导出 `shutdown(): Promise<void>`(跑 cleanup、phase 翻 `finishing`、不调 quit)。既有 `onBeforeQuit` 语义与 9 条测试不变。

这是 CLAUDE.md「谓词放一处 export,两边 import」在退出流程上的同款应用:清理逻辑一处,两个入口,不许抄第二份。

### 4.4 IPC 面

沿用仓库既有命名:

- `gladlog:update:getState` → `UpdateState`
- `gladlog:update:check` → 手动触发
- `gladlog:update:install` → 走 §4.3 的 `installNow()`
- 推送 `gladlog:update:state`(main → renderer)

preload 加 `update: { getState, check, install, onState }`,订阅同 `logs.onMatchStored` 模式。

### 4.5 UI

**下载中**:顶部导航条(`对局/战绩/设置/开发者` 那行)右侧一行细字「正在下载 0.1.20 · 37%」,不可点、不打扰。

**就绪后**:顶部出可关闭横幅「新版 0.1.20 已就绪 —— 立即重启 / 稍后」。点「稍后」横幅收起,退化成导航条上一枚常驻小按钮,随时可点。

不用全程横幅的理由:横幅一直挂着会持续挤掉对局列表可视高度,而列表密度是这个 app 的主要价值。只在 ready 时出现且可关,兼顾"明显"与"不占地方"。

**正在录像或正在跑分析时,「立即重启」禁用**,文案换成「正在录制,退出时会自动更新」。

"忙"的判据不新造:直接消费 renderer 已有的两个来源 —— 录像状态取 `recorder` 既有的状态推送,分析在飞取 `BatchAnalyzeBar` / `autoAnalyze` 已有的在飞集合。**不许为这个横幅新开一份"是否在忙"的判断**,否则就是又一处会和真状态漂移的手抄谓词。

**唯一要打扰用户的 error。** §4.2 的「error 不打扰」只管检查 / 下载失败(网络失败是常态,静默回 idle)。有一个例外:**用户点过「立即重启」之后**落的 error —— 那时清理链已经跑完、录像 / worker / AI 全停,顶栏一片空白就是一个「看着正常、其实功能全废」的窗口(触发路径见 §4.3 的看门狗)。

这一路要在顶栏渲染。判据用 renderer 的**本地事实**「本次会话点过安装」,**不是**去匹配 main 侧的 message 文案 —— 那条文案产在 `src/main/updater.ts`,renderer 只能 `import type`,抄成字符串常量就是一份会静默腐烂的手抄谓词。

这条挡的是本功能引入的**唯一新风险**:提示条会勾引用户在打游戏中途点重启。安装本身发生在退出时,物理上不可能打断进行中的对局记录 —— 但提示条制造了一个"在不该退出时退出"的诱因,必须由 UI 挡住。

### 4.6 设置页「关于」小节

`SettingsPanel.tsx` 末尾新增:

- 当前版本号 —— 现在设置页压根不显示版本,报 bug 时无从得知自己在哪版
- 「检查更新」按钮 + 上次检查时间
- 「自动检查更新」开关,默认开(存 `settingsStore`)

开关是逃生口,成本一个 boolean。

**但「加一个字段」比看上去贵**(2026-08-03 核查轮):`GladlogSettings` 是必填字段接口,加字段会连带打红三处全量字面量 ——
`src/main/settingsStore.ts` 的 interface + `DEFAULTS`、
`test/settingsStore.test.ts` 的默认值快照断言**和** `redactSettings` 用例里那份 `base` 字面量(两处,别只改前一处)、
`src/renderer/src/fixtureBridge.ts` 的 `GladlogSettings` 全量字面量。
漏任何一处 `npm run typecheck` 直接红。`sanitizeSettingsPatch` 与 `redactSettings` 的**实现**不用改(它是黑名单式校验器,既有 boolean 字段也都没有额外校验)。

### 4.7 更新后留痕

装上新版首次启动,导航条留一条「已更新到 0.1.20 · 更新内容」,点开 `shell.openExternal` 到该 tag 的 GitHub Release 页。`settingsStore` 存 `lastSeenVersion`,与 `app.getVersion()` 比对,点过或关掉即写回。

理由见 §7 的「无感跨版本」。

## 5. 用户数据安全性(源码级结论)

程序装在 `%LOCALAPPDATA%\Programs\gladlog\`;全部用户数据在 `%APPDATA%\gladlog\`(`app.getPath("userData")`,见 `src/main/index.ts`):`matches/`、`learning/`、`recordings/`、`icons/`、`settings.json`、`window-state.json`、`checkpoints.json`。两个目录互不相干。

NSIS 升级流程不进数据目录,**三重独立守卫**:

1. `deleteAppDataOnUninstall` 未配置 → `DELETE_APP_DATA_ON_UNINSTALL` 未 define
2. 升级时调旧卸载器带 `/S /KEEP_APP_DATA`(`installUtil.nsh:224`);源码注释原文:「always pass `--updated` flag - to ensure that if `DELETE_APP_DATA_ON_UNINSTALL` is defined, user data will be not removed」
3. 删数据那段还套 `${ifNot} ${isUpdated}`(`uninstaller.nsh:223-224`),升级时该条件为假

WoW 战斗日志在游戏目录,app 只读不写,不受影响。

**分析缓存**:`src/shared/promptVersion.ts` 的 `PROMPT_VERSION`(当前 15)是写缓存与读缓存共用的版本键,口径变了就 bump,旧缓存被 `getCached` 丢弃并重算 —— 不会出现「用新版逻辑读旧版缓存」的错配。`analysisSlots.ts` 另有 v1→v2 真迁移路径。这块已被兜住。

## 6. 验证方案

### 6.1 单元测试(`updater.test.ts`)

- 三重门:非 win32 / 非 packaged / 无卸载器 → `disabled`,且**从不调用** `checkForUpdates`
- 状态机:事件序列 → 状态快照
- `installNow()` 调用顺序:`shutdown()` 必须 resolve 之后才调 `quitAndInstall`(顺序断言,不是"都调了"断言)
- `error` 事件不抛、不弹窗,只落状态

`quitLifecycle.test.ts` 新增三条:`shutdown()` 后录像停了 / phase 翻 `finishing` / 重复调用不重入。

### 6.2 dummy release 端到端(本机 Mac,用户拍板采用)

开一个丢弃用的公开仓库 `mingjianliu/gladlog-update-test`(只推一个 README commit),本地出三个版本,`gh release create` 挂上去。

打包时用 CLI 覆盖 publish 目标,**不改 `package.json`** —— 免得测试用的仓库名不小心跟着 commit 进正式配置:

```
electron-builder --mac -c.publish.provider=github \
  -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
```

每个版本改一次 `packages/desktop/package.json` 的 `version` 再打,三份产物(`.dmg` / `-mac.zip` / `latest-mac.yml` / `.blockmap`)全传。跑完 `git checkout` 掉版本号改动。

客户端侧用 §4.2.1 的 `GLADLOG_UPDATER_TEST_FEED=mingjianliu/gladlog-update-test` 起 0.0.1 那份打好的 app。

| 版本            | 角色                         |
| --------------- | ---------------------------- |
| `v0.0.1`        | 客户端基线                   |
| `v0.0.2-beta.1` | 标 prerelease,**必须被跳过** |
| `v0.0.3`        | 正式版,客户端应直接跳到这里  |

判据:客户端从 0.0.1 检测出 0.0.3(**不是** 0.0.2-beta.1)→ 下载完成 → sha512 校验通过 → 状态机走到 `ready`。

**为什么不发到正式仓库**:GitHub 的 "Latest" 徽章认发布时间不认版本号,发一个 v0.0.3 会把 v0.1.19 顶下去,别人进仓库看到的最新版变成测试包;而测「跳过 prerelease」又必须有非 prerelease 的 dummy,躲不开。测完 `gh repo delete` 清掉。

覆盖:feed 解析、选版逻辑、prerelease 跳过、下载、sha512、状态机流转。约八成风险面,且恰好是最容易配错的那部分。

**不覆盖**:

- mac 上会因 ad-hoc 签名失败 —— 预期行为,非 bug。**2026-08-04 实测更正**:失败发生在 `update-downloaded` **之前**,不是之后。Squirrel.Mac 在下载一完成就立刻暂存(staging),当场撞上签名校验,所以 `update-downloaded` 事件**压根不发**,状态从 `downloading` 直接跳 `error`,顶栏永远不会出现「已就绪 / 立即重启」横幅。也就是说 mac 上验不到 `ready` 态和安装路径,只能验到「检测 → 下载 → sha512 → 失败得干净」
- 本地 mac 打包只证明 `latest-mac.yml` 生成正常。**Windows 侧的 `latest.yml` 是否真被 CI 产出并被上传 glob 收走,只有 0.1.20 那次真实构建能证明** —— 发版后必须核对 Release 资产是 7 个,并 `curl` 下 `latest.yml` 确认里面的 `path` / `sha512` 与实际 exe 对得上(`shasum -a 512` 比对)。这条进 §3.5 的 release skill 清单

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
