# gladlog desktop 自动更新 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows NSIS 安装版用户在退出 app 时自动装上新版,下次打开即最新。

**Architecture:** 发布端给 electron-builder 加 `publish` 配置与无空格的 NSIS `artifactName`,使构建产出 `latest.yml` 并把 `app-update.yml` 打进产物 resources —— 客户端靠它知道去哪查更新。客户端新增 `packages/desktop/src/main/updater.ts`,以依赖注入方式包住 electron-updater:三重生效门(win32 / packaged / 有 NSIS 卸载器)+ 六相状态机 + 复用 `quitLifecycle.shutdown()` 的安装链,整块脱离 electron 在 vitest 里可测。renderer 侧只经 `renderer/src/update/updateBridge.ts` 单源消费更新面与「更新后留痕」判据,可见 UI 只有顶栏挂件与设置页「关于」两处。

**Tech Stack:** electron-updater 6.8.9(GitHub provider,公开仓库免 token)· electron-builder / app-builder-lib 26.15.3(NSIS target)· electron-log · Electron + React 19 + TypeScript · vitest 2.1.9 · Playwright(视觉基线在 CI 生成)

## Global Constraints

**工作目录固定为 worktree 根 `/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update`,下文所有命令都从这里跑,不要 cd 到主 checkout `/Users/mingjianliu/code/gladlog`。**

以下 10 条是本计划的裁决,正文里凡是写「全局裁决 N」都指这里的第 N 条:

1. **安装包名用点,不用短横。** `build.nsis.artifactName` 恒等于 `"${productName}.Setup.${version}.${ext}"`,产出 `gladlog.Setup.0.1.20.exe` —— 与历史上每一个 release 的**资产名**逐字节相同,所以**用户可见的下载名与下载 URL 一个字都不用改**。唯一会过期的是写着**本地** `dist-app/` 产物名(带空格)的三行文档,由 Task 1 Step 6 同步。
2. **全量测试基线是 `136 files / 938 tests passed`**(2026-08-02 在本 worktree 实测,08-03 复测同值);所有「N + 增量」从这里算,跑之前一律以 `npm test --workspace=packages/desktop 2>&1 | tail -5` 的当场输出为准。
3. **`install()` 的唯一实现在 Task 4。** Task 5 是对它的增量(shutdown 抛错也照装 + 安装看门狗),不许重建 harness、不许重写 `install()`。
4. **定时器的唯一实现在 `updater.ts`(Task 4)。** `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` 由该模块单源持有、服务自带 `setTimeout` / `setInterval`;Task 6 的接线处只调 `dispose()`,不许再声明这两个常量、不许再建第二套 timer。
5. **`testFeed` 直通 `process.env["GLADLOG_UPDATER_TEST_FEED"]`,不加 `GLADLOG_E2E` 判断。** 门的判定顺序把 `!isPackaged → dev` 排在 testFeed 校验之前,dev / E2E 天然走不到校验;在接线处清零它会破坏 §6.2 的 dummy release 验证。
6. **`fixtureBridge.ts` 不加 `update` 面。** fixture 预览与视觉基线下不渲染任何更新相关 UI,Task 7 / Task 8 的像素判据直接依赖这一点。
7. **§4.7「更新后留痕」逻辑的唯一实现在 `renderer/src/update/updateBridge.ts`(Task 6)。** UpdateBanner(Task 7)与 SettingsPanel(Task 8)一律 import 它,不许在组件里内联第二份比对逻辑。
8. **`autoUpdater.logger = log`(electron-log)必须真的有人写**,位置在 Task 6 的 `initUpdater` 里、取到 `autoUpdater` 之后、`createUpdaterService(` 之前。不写这一行,§6.2 端到端验证的头号证据通道就断了。
9. **不要动 `docs/predicate-index.md`。** 自动更新不产生需要登记进谓词索引的行(那份索引只收 `analysis` / `eval` / `corpus-tools` 三个前缀),硬塞会白改三个文件并打红 eval 的一致性测试。
10. **视觉基线重生成走 CI 四步流程,绝不在本机跑 `npm run test:visual`**(会往单源基线里混进 mac 渲染的图):① 本机只跑 `test:visual:smoke` 自查不崩 → ② 推分支后 `gh workflow run visual-baseline.yml --ref <branch>` → ③ `gh run download` 取 artifact 人工审图 → ④ 把改动的 PNG 覆盖进 `packages/desktop/qa/__screenshots__/` 并提交。

其余全计划通用的硬约束:

- `electron-updater@6.8.9` 必须在 `packages/desktop/package.json` 的 **`dependencies`**(不是 devDependencies),且**不要**加进 `electron.vite.config.ts` 的 `externalizeDepsPlugin` exclude 列表 —— 那个列表只给 `@gladlog/*` 工作区包用(它们的 `main` 指向 TS 源码)。
- **三重生效门**:`process.platform === "win32" && app.isPackaged && isNsisInstalled()`;`isNsisInstalled()` = `dirname(process.execPath)` 下存在匹配 `/^Uninstall .+\.exe$/` 的文件(扫模式,**不**硬编码 `"Uninstall gladlog.exe"`)。
- **代码注释写英文**;计划文档 / commit message / 测试用例名写中文(与仓库既有风格一致)。
- **类型检查一律 `npm run typecheck`(内部是 `tsc --noEmit`),绝不 `tsc -b`** —— 会往 `src/` 吐 `.js`,污染树并遮蔽 `.ts`。
- **push 前三件套**:`npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet`。lint 必须在仓库根扫全仓(`eslint .`),只扫 `packages/desktop/src` 会漏掉 `test/`、`qa/`、`dev/`、`scripts/` —— 这个口子连挂过三次 CI。
- **跑测试统一用** `npm test --workspace=packages/desktop -- <文件路径>`(单文件)/ `npm test --workspace=packages/desktop`(全量)。
- **同一个事实两处判断必须共享同一个函数/常量**,做不到就写断言相等的单测(CLAUDE.md 头号红线)。
- **声称修好了要给同一判据下的前后数字**,给不出就明说给不出。
- worktree 必须有**自己的** `node_modules`,否则模块解析会爬到主 checkout(那是另一个分支的源码),typecheck 会假红;没有就先在 worktree 根 `npm install`。

---

## Task 1: 发布端配置 + 配置守卫测试

对应设计 spec §3 全节(`docs/superpowers/specs/2026-08-02-auto-update-design.md:24-100`,
其中 §3.2「NSIS artifactName」是 2026-08-03 核查轮新增的一节)。

**为什么这个 Task 排第一**:客户端代码写得再对,只要 Release 上没有 `latest.yml`、
或者 `latest.yml` 里写的文件名和 Release 上的资产名对不上,所有已安装的客户端都会
静默检查失败 —— 没有报错、没有弹窗、没有任何人会发现。发布端配置是整条链的地基。

**Files:**

- Create: `packages/desktop/test/releaseConfig.test.ts`
- Modify: `packages/desktop/package.json`
  - `:23-34` dependencies(`electron-updater` 已在 `:31`,本任务只确认并随本次提交入库)
  - `:54-91` `build` 字段 —— 在 `:55` 的 `"appId"` 之后新增 `publish`
  - `:86-90` `build.nsis` —— 新增 `artifactName`
- Modify: `.github/workflows/build.yml:50-54`(upload-artifact 的 `path` glob)
- Modify: `.github/workflows/build.yml:60-63`(softprops release 的 `files` glob)
- Delete: `packages/desktop/electron-builder.yml`(22 行,死配置)
- Modify: `.claude/skills/release/SKILL.md:70-72`(资产验收清单 4 → 7)、`:59`(覆盖版本警告)
- Modify: `docs/BUILD-WINDOWS.md:45` + `docs/BUILD-WINDOWS.zh-CN.md:44`(**双语成对,必须同改**)
  与 `docs/commands/release-gladlog.md:48` —— 这三行写的是**本地构建产物名**,
  改 `artifactName` 之后会过期(Step 6)

**用户可见的下载名一个字都不变**(见下文「坑 A」的结论):`gladlog.Setup.X.Y.Z.exe`
与历史上每一个 release 的资产名逐字节相同,所以 `docs/setup-windows-claude-cli*.md` /
`README*` / `docs/commands/release-gladlog.md:78`(下载 URL)全部不动。
**要动的只有上面那三行「本地产物名」**:`dist-app/` 里的文件名确实从
`gladlog Setup X.Y.Z.exe` 变成了 `gladlog.Setup.X.Y.Z.exe`。

**Interfaces:**

- Consumes: 无(本计划的第一个 Task)。
- Produces:
  - `packages/desktop/package.json` 的 `build.publish` 恒等于
    `{ "provider": "github", "owner": "mingjianliu", "repo": "gladlog" }` ——
    后续 Task 的 `updater.ts` 不读它,但 electron-builder 靠它把 `app-update.yml`
    写进打包产物的 resources,客户端运行时靠那个文件知道去哪查更新。
  - `build.nsis.artifactName` 恒等于 `"${productName}.Setup.${version}.${ext}"`,
    NSIS 安装包文件名形如 `gladlog.Setup.0.1.20.exe`(**无空格**),与 `latest.yml`
    里的 `path` / `files[0].url`、与 Release 上的资产名三方逐字节相同。
  - `.github/workflows/build.yml` 的两处 glob 都收 `dist-app/*.yml` 与 `dist-app/*.blockmap`。

### 背景:两个必须先讲清楚的坑

**坑 A —— NSIS 产物名必须去空格(最要命,不改则 §3 全套白做)。**

现状链路:NSIS 本地产物名是 `gladlog Setup 0.1.19.exe`(带空格,来自
`node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:100-104` 的
`installerFilenamePattern`,返回 `"${productName} " + "Setup " + "${version}" + archSuffix + ".${ext}"`);
`NsisTarget.js:303` 调 `computeSafeArtifactNameIfNeeded(installerFilename, …)` →
`platformPackager.js:690-703` 判定「含空格 = 不安全」→ 把空格换成短横 →
`safeArtifactName = gladlog-Setup-0.1.19.exe`;`updateInfoBuilder.js:100-107` 在
provider 是 github 时,就把这个**短横名**写进 `latest.yml` 的 `path` 与 `files[0].url`。

但 CI 走的是 `softprops/action-gh-release` 直传本地文件,GitHub 把文件名里的空格
规范化成**点** —— v0.1.19 的实际资产名(`gh release view v0.1.19 --json assets` 实测)是:

```
gladlog-0.1.19-arm64-mac.zip
gladlog-0.1.19-arm64.dmg
gladlog-0.1.19-win.zip
gladlog.Setup.0.1.19.exe      ← 点,不是短横
```

客户端侧 `electron-updater/out/providers/GitHubProvider.js:179-181` 的 `resolveFiles`
只做 `p.replace(/ /g, "-")`(注释原文 "still replace space to - due to backward
compatibility"),对已经是短横的 `path` 不做任何事,拼出的下载地址是
`.../download/v0.1.20/gladlog-Setup-0.1.20.exe` —— 与 GitHub 上的
`gladlog.Setup.0.1.20.exe` 不匹配,**404**。`.blockmap` 同理(URL 是在 exe URL 后
直接接 `.blockmap`)。

修法(本任务采用):给 `build.nsis` 加

```json
"artifactName": "${productName}.Setup.${version}.${ext}"
```

**用点,不用短横。** `isSafeGithubName` 是 `/^[0-9A-Za-z._-]+$/`
(`platformPackager.js:687-689`,已核源码),点是合法字符 —— 本地名
`gladlog.Setup.0.1.20.exe` 直接通过安全检查,`computeSafeArtifactNameIfNeeded` 在
`:693-695` 就 `return null`,不发生任何改写;GitHub 那边也没有空格可规范化。
本地名 = `latest.yml` 的 `path` = Release 资产名,三方逐字节一致。

选点而不是短横的**代价对比**:两种写法都能修好 404,但点号形式与历史上每一个
release 的资产名逐字节相同 —— 用户的收藏/直链不失效,README / setup 文档里的
下载名与下载 URL 一个字不用改(只有三行写「本地产物名」的说明要跟着改,见 Step 6)。
短横形式则是连用户可见的下载名一起改,白付一次改名的代价。
这一条是用户 2026-08-03 拍板,spec §3.2 已按此更正。

mac 侧不受影响:`gladlog-0.1.20-arm64.dmg` / `gladlog-0.1.20-arm64-mac.zip` 本来就满足
`/^[0-9A-Za-z._-]+$/`,`computeSafeArtifactNameIfNeeded` 返回 `null`(实测)。
**这正是为什么 mac 端到端会全绿而 Windows 照样 404** —— 后续的 dummy release 验证
抓不到这个坑,只能靠本任务的配置和守卫测试挡。

**坑 B —— glob 绝不能写成 `*.y*ml`。**

`node_modules/app-builder-lib/out/packager.js:298-300` 会往 `dist-app/` 写一份
`builder-effective-config.yaml`,内容含**本机绝对路径**与完整构建配置。
准确口径:那段外面套着 `if (!isCI && process.stdout.isTTY)` —— 在 GitHub Actions
上跑时 `isCI` 为真,这份文件**不会**生成,所以现网并没有正在泄漏。真正的暴露面是
「有人在本机 `npm run package:win` 之后手工上传 dist-app 里的东西」。
现有 glob `packages/desktop/dist-app/*.yml` 恰好不匹配 `.yaml`,新增两行时必须严格用
`*.yml`,图省事写成 `*.y*ml` 就把这道天然屏障拆了。守卫测试里有一条专门盯这个。

### 步骤

- [ ] **Step 1: 写守卫测试(此时应该是红的)** —— 新建
      `packages/desktop/test/releaseConfig.test.ts`,内容逐字如下
      (`describe`/`it`/`expect` 不用 import:`packages/desktop/vitest.config.ts` 里
      `globals: true`,同目录的 `diagnosticLevel.test.ts` 就是这么写的):

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

describe("发布端配置门规(自动更新的地基)", () => {
  it("build.publish 指向正式仓库 —— 没有它就没有 app-update.yml,客户端不知道去哪查", () => {
    expect(readPkg().build.publish).toEqual({
      provider: "github",
      owner: "mingjianliu",
      repo: "gladlog",
    });
  });

  it("NSIS artifactName 无空格且过 isSafeGithubName —— latest.yml 的 path 必须与 Release 资产名逐字节相同", () => {
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

  it("electron-updater 在 dependencies 而不是 devDependencies", () => {
    // What actually matters is which list it is in, not the exact patch level:
    // externalizeDepsPlugin externalizes `dependencies` only, and
    // electron-builder only ships `dependencies` into the packaged node_modules.
    // The major is still pinned — a 6→7 breaking change should go red.
    const pkg = readPkg();
    expect(pkg.dependencies["electron-updater"]).toMatch(/^\^6\./);
    expect(pkg.devDependencies["electron-updater"]).toBeUndefined();
  });

  it("死配置 electron-builder.yml 已删除", () => {
    // package.json's `build` field wins; a stray electron-builder.yml is never
    // read, so anything written into it silently does nothing.
    expect(existsSync(join(desktopDir, "electron-builder.yml"))).toBe(false);
  });

  it("build.yml 两处 glob 都收 latest.yml 与 .blockmap(upload-artifact + release 各一)", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.yml"),
    ).toBeGreaterThanOrEqual(2);
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.blockmap"),
    ).toBeGreaterThanOrEqual(2);
  });

  it("build.yml 不许出现 .yaml 形态的 glob —— 会把含本机绝对路径的 builder-effective-config.yaml 传上 Release", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(wf).not.toContain(".y*ml");
    expect(wf).not.toContain(".yaml");
  });
});
```

- [ ] **Step 2: 跑测试确认红** —— Run:
      `npm test --workspace=packages/desktop -- test/releaseConfig.test.ts`

      Expected: `Test Files 1 failed`,`Tests 4 failed | 2 passed (6)`。逐条:
        - 「build.publish 指向正式仓库」→ `AssertionError: expected undefined to deeply equal { provider: 'github', … }`
        - 「NSIS artifactName 无空格且过 isSafeGithubName」→
          `AssertionError: expected '' to be '${productName}.Setup.${version}.${ext}'`
          (`?? ""` 兜底把 undefined 变成空串,好让后面的 `.replace` 在类型上成立;
          断言仍然当场红)
        - 「死配置 electron-builder.yml 已删除」→ `AssertionError: expected true to be false`
        - 「build.yml 两处 glob」→ `AssertionError: expected +0 to be greater than or equal to 2`
        - 已经绿的两条:「electron-updater 在 dependencies」(核查阶段已装,见 Step 3)
          和「不许出现 .yaml 形态的 glob」(现状本来就没有)。

- [ ] **Step 3: 确认 electron-updater 已装并锁版本(不重复安装)** —— Run:

```bash
git diff HEAD -- packages/desktop/package.json
node -e "console.log(require('./node_modules/electron-updater/package.json').version)"
grep -n '"electron-updater"' package-lock.json | head -3
```

      Expected: diff 显示 `packages/desktop/package.json` 的 dependencies 里多了一行
      `"electron-updater": "^6.8.9",`;node 打印 `6.8.9`;package-lock.json 里有
      `node_modules/electron-updater` 条目。**不要再跑 `npm install`**,也**不要**把
      `electron-updater` 加进 `packages/desktop/electron.vite.config.ts:25-29` 或
      `:59-63` 的 `exclude` 列表 —— 那个列表只给 `@gladlog/*` 工作区包用(它们的
      `main` 指向 TS 源码);普通 npm 包被 externalize 成运行时 `require` 才是对的。
      `package-lock.json` 随本任务的 commit 一起入库。

- [ ] **Step 4: 加 publish 配置** —— 编辑 `packages/desktop/package.json`,
      在 `"build": {` 的 `"appId"` 之后插入一行(即 `:55` 之后):

```json
    "publish": {
      "provider": "github",
      "owner": "mingjianliu",
      "repo": "gladlog"
    },
```

      加完后 `build` 字段开头形如:

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

      这一行有两个作用:构建时在 `dist-app/` 写出 `latest.yml`(win)/ `latest-mac.yml`
      (mac)+ `.blockmap`;并把 `app-update.yml` 写进产物的 resources
      (Windows 是 `resources/app-update.yml`,mac 是 `<app>.app/Contents/Resources/app-update.yml`,
      见 `app-builder-lib/out/publish/PublishManager.js:75-91` 的 `onAfterPack`(写文件在 `:89`)
      与 `app-builder-lib/out/platformPackager.js:470-478` 的 `getResourcesDir`)。
      写 yml 的分支(`PublishManager.js:158-163` 的 `createUpdateInfoTasks`)在
      `if (this.isPublish)`(`:149-157`)**之外**,所以「electron-builder 只构建、
      softprops 负责上传」的现有流程完全不用动。

- [ ] **Step 5: 加 NSIS artifactName** —— 编辑 `packages/desktop/package.json` 的
      `build.nsis`(改前在 `:86-90`),改成:

```json
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "artifactName": "${productName}.Setup.${version}.${ext}"
    }
```

      理由见上文「坑 A」。三条注意:
      1. `${...}` 是 electron-builder 自己的模板语法,JSON 里必须原样保留,
         **不要**替换成真实值(守卫测试断言的就是这个字面模板)。
      2. **用点,不用短横** —— 这是用户拍板,产物名因此与历史 release 逐字节相同。
      3. 这个模板里没有 `${arch}`。当前 win 只出 x64 单架构(package.json `:69-85`),
         不会撞名;哪天加 win/arm64,两个架构会产出同名 exe,那时必须补 `${arch}`。

- [ ] **Step 6: 同步三处「本地构建产物名」文档** —— 上一步改了 `artifactName`,
      **本地** `dist-app/` 里的 exe 名字随之从 `gladlog Setup X.Y.Z.exe`(空格)变成
      `gladlog.Setup.X.Y.Z.exe`(点)。用户可见的**下载名**一个字没变(GitHub 一直
      把空格规范化成点),但下面这三行写的是**本地产物名 / 发版说明模板里的文件名**,
      不改就过期。`docs/BUILD-WINDOWS.md` 与 `docs/BUILD-WINDOWS.zh-CN.md` 是
      CLAUDE.md 规定的双语成对文档,**两版必须同改**。

      三处逐字替换(行号 2026-08-03 实测)。下面每组第一行是**改前**、第二行是**改后**;围栏标 `text` 是为了让内容原样保留:

```text
docs/BUILD-WINDOWS.md:45
- `gladlog Setup 0.0.1.exe` — the installer.
- `gladlog.Setup.0.0.1.exe` — the installer.

docs/BUILD-WINDOWS.zh-CN.md:44
- `gladlog Setup 0.0.1.exe` —— 安装包。
- `gladlog.Setup.0.0.1.exe` —— 安装包。

docs/commands/release-gladlog.md:48
- \`gladlog Setup X.Y.Z.exe\` — installer. SmartScreen → **More info → Run anyway**.
- \`gladlog.Setup.X.Y.Z.exe\` — installer. SmartScreen → **More info → Run anyway**.
```

      第三处在 `gh release create --notes "..."` 的模板里,反引号是转义的 `\``,
      替换时**保留转义**,只把空格换成点。

      **`docs/commands/release-gladlog.md:78` 那行不要动** —— 它写的是下载 URL
      (`.../download/vX.Y.Z/gladlog.Setup.X.Y.Z.exe`),本来就是点号形式,一直是对的。

      改完自查(**必须排掉 `docs/superpowers/`**:本计划与 spec 都逐字引用了带空格的
      旧名当「改前」对照,不排掉这条自查永远不可能变绿):

```bash
grep -n "gladlog Setup" docs/BUILD-WINDOWS.md docs/BUILD-WINDOWS.zh-CN.md docs/commands/release-gladlog.md
grep -rn "gladlog Setup" docs/ README.md README.zh-CN.md | grep -v "^docs/superpowers/"
```

      Expected:两条都**无输出**(2026-08-03 实测:改动前第一条命中 3 行、第二条命中
      同样这 3 行,全仓再无第四处)。

- [ ] **Step 7: 删掉死配置** —— Run:
      `git rm packages/desktop/electron-builder.yml`

      Expected: `rm 'packages/desktop/electron-builder.yml'`。
      它是死文件:electron-builder 的配置解析是 `package.json` 的 `build` 字段优先,
      有它就根本不读同目录的 yml。证据:yml 里写 `win: target: nsis`(只有 nsis),
      而实际发布产出了 `gladlog-0.1.19-win.zip` —— 那是 package.json 里的 zip target。
      全仓无任何代码/CI 引用它;提到它的只有三份历史 plan 文档
      (`docs/plans/2026-07-27-obs-recording-integration-eval.md:53`/`:88` 早就把删它
      列为前置动作,另有 `2026-07-12-sp-b2-compare-subsystem.md` 与
      `2026-07-10-desktop-shell.md`)—— 历史文档,**不改**。

- [ ] **Step 8: 改 build.yml 的两处 glob** —— 编辑 `.github/workflows/build.yml`。
      第一处(upload-artifact,改前 `:50-54`)。**缩进必须与原文一致**:`path: |`
      是 10 空格,条目是 12 空格(2026-08-03 实测 `:50-54`)—— 下面两个代码块已按
      真实缩进写,原样替换即可(围栏标的是 `text` 不是 `yaml`,防止编辑器/formatter
      把缩进「规范化」掉):

```text
          path: |
            packages/desktop/dist-app/*.exe
            packages/desktop/dist-app/*.dmg
            packages/desktop/dist-app/*.zip
            packages/desktop/dist-app/*.yml
            packages/desktop/dist-app/*.blockmap
          if-no-files-found: ignore
```

      第二处(softprops release,改前 `:60-63`),`files: |` 同样是 10 空格、
      条目 12 空格:

```text
          files: |
            packages/desktop/dist-app/*.exe
            packages/desktop/dist-app/*.dmg
            packages/desktop/dist-app/*.zip
            packages/desktop/dist-app/*.yml
            packages/desktop/dist-app/*.blockmap
```

      **严格用 `*.yml`,不要写 `*.y*ml`**(理由见上文「坑 B」)。

      改完自查(YAML 缩进错了本仓没有任何门能抓到 —— Step 1 的守卫测试只做
      `toContain` 字符串命中,缩进歪了照样绿,要到 CI 真跑 workflow 才炸):

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml'))" && echo YAML_OK
```

      Expected: `YAML_OK`。

- [ ] **Step 9: 跑测试确认绿** —— Run:
      `npm test --workspace=packages/desktop -- test/releaseConfig.test.ts`

      Expected: `Test Files 1 passed (1)` / `Tests 6 passed (6)`。

- [ ] **Step 10: 改 release skill —— 资产清单 4 → 7** —— 编辑
      `.claude/skills/release/SKILL.md`,把 `:70-72` 的整段:

```
必须见到 4 个资产:`gladlog.Setup.0.0.X.exe`、`gladlog-0.0.X-win.zip`、
`gladlog-0.0.X-arm64.dmg`、`gladlog-0.0.X-arm64-mac.zip`。少了 = 某平台
构建挂了,`gh run view $RUN --log-failed` 查。
```

      替换为下面这段。**注意围栏层数**:替换文本里本身含一个 bash 代码块(三反引号),
      所以下面用**四个反引号**把整段包住;贴进 SKILL.md 时只贴四反引号之间的内容,
      不要把四反引号那两行贴进去。

````
必须见到下列 7 个资产,逐字符核对:

- `gladlog.Setup.0.0.X.exe` —— 安装包
- `gladlog.Setup.0.0.X.exe.blockmap` —— 差分下载用
- `gladlog-0.0.X-win.zip` —— 免安装版
- `latest.yml` —— **自动更新的命门**,漏传的后果是所有 Windows 客户端静默检查失败
- `gladlog-0.0.X-arm64.dmg`
- `gladlog-0.0.X-arm64-mac.zip`
- `latest-mac.yml` —— mac 侧同款,当前 mac 不启用自动更新,留着以备将来买证书

少了 = 某平台构建挂了,`gh run view $RUN --log-failed` 查。
另外还会带上 mac 侧的 `*-arm64.dmg.blockmap` / `*-arm64-mac.zip.blockmap`,
有无都不影响(mac 不走自动更新),不作硬门。

**再加一条名字一致性核对**(比比对 sha512 更早暴露问题):

```bash
gh release download v0.0.X -p latest.yml -D /tmp/relcheck --clobber
grep -E '^\s*(path|url):' /tmp/relcheck/latest.yml
gh release view v0.0.X --json assets -q '.assets[].name'
```

`latest.yml` 里的 `path` / `files[].url` 必须与资产列表里的名字**逐字符相同**。
对不上就是 404:客户端能读到 latest.yml、能算出新版本、然后下载失败,
而这一切在 Release 页面上看起来完全正常。
````

      Expected(改完自查):
      `grep -c 'latest.yml' .claude/skills/release/SKILL.md` ≥ 2。

- [ ] **Step 11: 改 release skill —— 覆盖版本警告升级为硬规矩** —— 编辑
      `.claude/skills/release/SKILL.md:59`,把这一行:

```
提醒用户:已下载旧包的人手里会有同版本号不同内容的二进制;默认应走 +1。
```

      替换为:

```
**硬规矩:除非用户明说「覆盖 N」,一律走 +1,不许覆盖。** 0.1.20 起客户端带
自动更新,而更新判据是版本号 —— 覆盖 vN 之后,已装 vN 的机器版本号相同、
永远收不到这次修复,用户手里是旧内容却以为自己是最新版,且没有任何提示。
覆盖前必须先告诉用户这个后果并拿到确认。
```

      注意:`.claude/**` 在 `eslint.config.js:20` 的 ignores 里,改 SKILL.md
      **不过 lint** —— Step 12 的 eslint 绿不代表这两处改对了,得肉眼核一遍。

- [ ] **Step 12: 全量门规** —— Run(三条都要绿):

```bash
npm test --workspace=packages/desktop
npm run typecheck
npx eslint . --quiet
```

      Expected: vitest `Test Files 137 passed` / `Tests 944 passed`
      (基线 136/938 + 本任务新增 1 个文件 6 条);typecheck 退出码 0、
      日志里 `error TS` 计数为 0(六个 workspace:corpus-tools / desktop / eval /
      log-pipeline / parser / parser-compat 全绿);eslint 无输出。
      注意 eslint 必须扫全仓(`eslint .`),只扫 `packages/desktop/src` 会漏掉
      `test/`、`qa/`、`dev/`、`scripts/` —— 这一条连挂过三次 CI。

- [ ] **Step 13: commit** —— Run:

```bash
git add packages/desktop/package.json package-lock.json \
  packages/desktop/test/releaseConfig.test.ts \
  .github/workflows/build.yml \
  .claude/skills/release/SKILL.md \
  docs/BUILD-WINDOWS.md docs/BUILD-WINDOWS.zh-CN.md \
  docs/commands/release-gladlog.md
git rm --cached packages/desktop/electron-builder.yml 2>/dev/null || true
git status --short
git commit -m "feat(desktop): 自动更新发布端 —— publish 配置 + latest.yml/blockmap 上传 + NSIS 产物名去空格

electron-builder 的 build.publish 一加,构建时就会写出 latest.yml 并把
app-update.yml 打进产物 resources —— 这是客户端能查更新的前提。

build.nsis.artifactName 定为 \${productName}.Setup.\${version}.\${ext}:
默认产物名带空格,electron-builder 会把空格换成短横写进 latest.yml,
而 GitHub 上传时把空格规范化成点,客户端拼出的下载地址必 404。用点号后
本地名 / latest.yml 的 path / Release 资产名三方逐字节一致,且与历史上
每一个 release 的资产名完全相同 —— 用户下载到的名字一个字都没变。
本地产物名确实变了(带空格 → 带点),BUILD-WINDOWS 双语两版与
release-gladlog 的发版说明模板共三行随之同步。

build.yml 两处 glob 各加 *.yml 与 *.blockmap;严格用 *.yml 不用 *.y*ml,
后者会把含本机绝对路径的 builder-effective-config.yaml 传上 Release。

删掉 packages/desktop/electron-builder.yml:package.json 的 build 字段优先,
它从来没生效过(yml 里只写了 nsis,实际却产出了 zip)。

新增 test/releaseConfig.test.ts 守住以上全部:这些配置错了不会崩、不会报错,
只会让所有客户端静默检查失败,单测是唯一能挡住的地方。"
```

      Expected: `git status --short` 里 `packages/desktop/electron-builder.yml` 显示为 `D`,
      其余为 `M` / `A`;commit 成功。

### 已知边界(写进计划而不是靠注释)

- **用户可见的下载名一个字没变,变的是本地产物名**:GitHub 一直把资产名里的空格
  规范化成点,历史上每一个 release 的 Windows 资产都叫 `gladlog.Setup.X.Y.Z.exe`,
  所以收藏/直链/README 里的下载说明全部不受影响。**变的是本机 `dist-app/` 里的文件名**
  (`gladlog Setup 0.0.1.exe` → `gladlog.Setup.0.0.1.exe`),写着旧本地名的三行由
  Step 6 同步(`docs/BUILD-WINDOWS.md:45` / `docs/BUILD-WINDOWS.zh-CN.md:44` /
  `docs/commands/release-gladlog.md:48`)。`docs/commands/release-gladlog.md:78`
  那行是下载 URL、本来就是点号形式,**不动**。
- **`latest.yml` 里的 `path` 与 Release 资产名一致,本机无法验证** —— 需要一次真实的
  CI Windows 构建。它被写成 Step 10 里的 release skill 核对命令,由 0.1.20 那次发版执行。
- **`builder-effective-config.yaml` 现网并没有在泄漏**(`packager.js:298` 的
  `!isCI && process.stdout.isTTY` 挡住了),`*.yml` 的严格写法守的是「有人从本机
  dist-app 手工上传」这条路。别把守卫测试的那一条当成「修了一个线上漏洞」。

### 本任务的验证口径(诚实交代)

- 能给数字的:守卫测试 6 条,改动前 4 红 2 绿 → 改动后 6 绿;
  全量 `136 files / 938 tests` → `137 files / 944 tests`。
- **给不出数字的**:「latest.yml 的 path 与 Release 资产名逐字节相同」这条,在
  0.1.20 真实发版之前只有源码推演作为依据(`isSafeGithubName` 收点号 →
  `computeSafeArtifactNameIfNeeded` 在 `platformPackager.js:693-695` 返回 null →
  `updateInfoBuilder.js:100-107` 的改写分支不进入),**不算实测**。

---

## Task 2: quitLifecycle 抽出 shutdown()

对应设计 spec §4.3 的 quitLifecycle 那半(`docs/superpowers/specs/2026-08-02-auto-update-design.md:189-210`)。

**为什么需要它**:`autoUpdater.quitAndInstall()` 内部是「先 spawn NSIS 安装器
(detached、unref)、再 `setImmediate(() => app.quit())`」
(`node_modules/electron-updater/out/BaseUpdater.js:13-27` → `NsisUpdater.js:101-148`
→ `BaseUpdater.js:129-141` 的 `spawnLog`,`:133` 的 `detached: true` + `:138` 的 `p.unref()`)。
而 `quitLifecycle` 的第一次 `before-quit` 是 `preventDefault()` 挂起、去停 OBS 录像
(4 s 封顶)/ 停 worker / 收 AI 子进程。

裸调 `quitAndInstall()` 的后果:安装器已在外面跑,录像清理还在里面跑,谁先谁后不确定 ——
轻则录像文件没封好,重则安装器超时放弃或强杀进程。

修法是只保留**一条**清理链,把 `quitAndInstall` 挂在链尾:

```ts
await quitLifecycle.shutdown(); // 停录像/worker/AI,复用既有链
autoUpdater.quitAndInstall(true, true); // 清理已毕才起安装器
```

`quitAndInstall` 内部那个 `app.quit()` 再触发 `before-quit` 时,phase 已是 `finishing`,
`quitLifecycle` 直接放行 —— 两条链天然接上,不需要额外标志位。

这是 CLAUDE.md「谓词放一处 export,两边 import」在退出流程上的同款应用:
**清理逻辑一处,两个入口,不许抄第二份**。本任务唯一要保证的就是这件事。

**Files:**

- Modify: `packages/desktop/src/main/quitLifecycle.ts`
  - `:46-51` `QuitLifecycleHandler` 接口 —— 新增 `shutdown()`
  - `:60-90` `finish()` —— 拆成 `cleanup()` + `finish()`
  - `:92-104` 返回对象 —— 新增 `shutdown` 成员
- Modify(Test): `packages/desktop/src/main/quitLifecycle.test.ts`
  —— 在最后一条 `it(...)` 的收尾 `});`(`:178`)之后、`describe` 的 `});`(`:179`)
  之前追加 5 条(行号已核实)

**Interfaces:**

- Consumes: `createQuitLifecycleHandler(deps: QuitLifecycleDeps): QuitLifecycleHandler`
  (既有,签名不变);`QuitLifecycleDeps = { stopRecorder: () => Promise<void>;
stopHost: () => void; quit: () => void; stopAiActivity?: () => void; timeoutMs?: number }`。
- Produces:

```ts
export interface QuitLifecycleHandler {
  onBeforeQuit(event: { preventDefault(): void }): void;
  waitForIdle(): Promise<void>;
  /** 跑完清理链并把 phase 翻到 "finishing",但不调 deps.quit()。
   *  重复调用不重入,返回同一条在飞 Promise。 */
  shutdown(): Promise<void>;
}
```

**Task 4 的 `updater.ts`** 通过 `UpdaterDeps.shutdown: () => Promise<void>` 注入它;
`install()` 的唯一实现也在 Task 4(Task 5 只在它上面加两个增量)。

**硬约束:既有 `onBeforeQuit` 语义与既有 9 条测试一个字都不许改。**
本任务的改动只允许是「拆函数 + 加一个出口」,不允许调整既有行为。

### 步骤

- [ ] **Step 1: 先读既有测试的桩风格** —— Run:
      `sed -n '1,60p' packages/desktop/src/main/quitLifecycle.test.ts`

      Expected: 看到文件顶部的 `fakeEvent()` 工厂(返回带 `preventDefault` 与
      只读 `prevented` getter 的对象),以及每条 `it` 里用
      `createQuitLifecycleHandler({ stopRecorder, stopHost, quit, timeoutMs: 5000 })`
      + 一个 `calls: string[]` 数组记录调用顺序的写法。**新测试逐字照抄这个风格**:
      同一个 `fakeEvent()`、同一个 `calls` 数组、同样用 `toEqual` 断言顺序而不是
      「都调过」。

- [ ] **Step 2: 追加 5 条失败测试** —— 编辑
      `packages/desktop/src/main/quitLifecycle.test.ts`,在文件末尾最后一条
      `it("stopAiActivity 不参与 timeoutMs 封顶 race…")` 的收尾 `});`(`:178`)之后、
      `describe` 的 `});`(`:179`)之前,插入:

```ts
it("shutdown():跑完清理链(stopAiActivity + stopRecorder + stopHost)但不调 quit", async () => {
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

it("shutdown() 重复调用不重入:清理链只跑一次,返回同一条在飞 Promise", async () => {
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

it("shutdown() 之后再来 before-quit:phase 已是 finishing,直接放行不 preventDefault", async () => {
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

it("shutdown() 进行中来的 before-quit 仍被挂起,且不启第二条清理链", async () => {
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

it("before-quit 先行时 shutdown() 复用同一条链,不重跑清理(那条链照常 quit)", async () => {
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

- [ ] **Step 3: 跑测试确认红** —— Run:
      `npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts`

      Expected: `Test Files 1 failed (1)` / `Tests 5 failed | 9 passed (14)`,
      5 条新用例全部报 `TypeError: handler.shutdown is not a function`。
      既有 9 条必须**全绿** —— 只要有一条红,说明测试文件插错位置了,先修再继续。

- [ ] **Step 4: 拆 finish() 为 cleanup() + finish()** —— 编辑
      `packages/desktop/src/main/quitLifecycle.ts`,把 `:60-90` 的整个 `finish` 函数
      替换为下面两个函数(注意 `phase = "finishing"` 留在 `cleanup()` 里,
      `deps.quit()` 移到 `finish()` 里):

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

- [ ] **Step 5: 接口加 shutdown()** —— 编辑
      `packages/desktop/src/main/quitLifecycle.ts:46-51`,把 `QuitLifecycleHandler`
      替换为:

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

- [ ] **Step 6: 返回对象加 shutdown 成员** —— 编辑
      `packages/desktop/src/main/quitLifecycle.ts` 的返回对象(改前 `:92-104`),
      在 `waitForIdle` 那一行之后加:

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

      改完后返回对象形如:

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
    /* …如上… */
  },
};
```

- [ ] **Step 7: 跑测试确认绿** —— Run:
      `npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts`

      Expected: `Test Files 1 passed (1)` / `Tests 14 passed (14)` ——
      既有 9 条 + 新增 5 条。既有 9 条里只要有一条变红,就是拆函数时改动了语义,
      回退 Step 4 重做,**不许改既有测试来迁就实现**。

- [ ] **Step 8: 全量门规** —— Run(三条都要绿):

```bash
npm test --workspace=packages/desktop
npm run typecheck
npx eslint . --quiet
```

      Expected: vitest `Test Files 137 passed` / `Tests 949 passed`
      (Task 1 结束时的 137/944 + 本任务的 5 条,不新增文件);
      typecheck 退出码 0;eslint 无输出。

- [ ] **Step 9: commit** —— Run:

```bash
git add packages/desktop/src/main/quitLifecycle.ts \
  packages/desktop/src/main/quitLifecycle.test.ts
git commit -m "refactor(desktop): quitLifecycle 抽出 shutdown() —— 清理链一处、两个入口

autoUpdater.quitAndInstall() 内部是「先 spawn NSIS 安装器(detached),
再 app.quit()」。裸调它的后果是安装器已在外面跑、录像清理还在里面跑,
谁先谁后不确定 —— 轻则录像文件没封好,重则安装器被强杀。

把 finish() 拆成 cleanup() + quit():对外新增 shutdown(),跑完清理链、
phase 翻 finishing、但不调 deps.quit()。更新安装走
await shutdown() → quitAndInstall(),后者内部的 app.quit() 再触发
before-quit 时 phase 已是 finishing,直接放行,两条链天然接上。

清理逻辑仍只有一份:before-quit 与 shutdown() 共用同一个 cleanup(),
不许在 updater 里抄第二份(CLAUDE.md 谓词单源在退出流程上的同款应用)。

既有 onBeforeQuit 语义与 9 条测试一字未改;新增 5 条覆盖
不调 quit / 不重入(返回同一条 Promise)/ 之后 before-quit 放行 /
进行中 before-quit 仍挂起 / before-quit 先行时复用同一条链。"
```

### 已知边界(写进计划而不是靠注释)

- **shutdown() 期间到达的 `before-quit` 会被永久吞掉一次**:它被 `preventDefault()`
  拦下,而 `cleanup()` 自己不调 `quit()`。这一条在真实调用序里无害 ——
  `install()` 的下一步就是 `quitAndInstall()`,清理封顶 4 s 内必然退出;
  但如果将来有人单独调 `shutdown()` 而不接 quit,app 会停在「功能全停但窗口还在」
  的状态。**唯一的合法调用方是 Task 4 的 `install()`,且必须紧接一个 quit。**
- **`quitAndInstall()` 有一条不 quit 的失败分支**:`BaseUpdater.js:16-25`,
  `install()` 返回 `false` 时只复位 `quitAndInstallCalled`、**不调 `app.quit()`**。
  此时 `shutdown()` 已经停了录像、停了 worker、杀了 AI 子进程,phase 也已是
  `finishing` —— app 活着但功能全废,且下一次 `before-quit` 会被
  `if (phase === "finishing") return` 直接放行、不再清理。
  **这个分支由 Task 4/5 的 `install()` 安装看门狗兜底**:`quitAndInstall()` 之后
  10 s 进程还活着 → 落 `error` 状态并提示用户手动退出重开。刻意**不**在这里、
  也不在 updater 里调 `app.quit()`:updater 不持有 quit 依赖,再开一条绕过
  `quitLifecycle` 的退出路径,比留一个可见的错误状态更糟。本任务不实现它,
  但也**不要**因为这条边界去给 `QuitLifecycleDeps` 加新依赖。
- **`quitAndInstall(true, true)` 的第二个参数依赖第一个**:`BaseUpdater.js:16` 是
  `this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)` ——
  只有 `isSilent === true` 时第二个 `true`(装完自动重开)才被采纳。哪天有人把第一个
  参数改成 `false`,第二个参数会被 `autoRunAppAfterInstall` 顶掉,**静默失效**。
- **`autoInstallOnAppQuit = true` 的兜底与本任务不冲突,但依据不是「phase 已 finishing」**:
  `BaseUpdater.js:69-89` 的 `addQuitHandler()` 挂的是 `app.onQuit(...)`
  (electron 的 `quit` 事件,在 `before-quit` / `will-quit` **之后**才发),那时清理链
  早已跑完。另有一条容易忽略的短路:`:83-86` 的 `if (exitCode !== 0) return` ——
  非零退出码不会自动安装。
- **mac 上 `quitAndInstall()` 是另一套代码**:`MacUpdater.js:240` 的
  `quitAndInstall()` **不收参数**,走 `this.nativeUpdater.quitAndInstall()`
  (`:233`,在 `handleUpdateDownloaded()` 里)而不是 spawn + `app.quit()`。所以在
  mac 上观察到的行为**不能**当作本任务这条「安装器后于清理链启动」设计的验证证据。

### 本任务的验证口径

- 前:`npm test --workspace=packages/desktop -- src/main/quitLifecycle.test.ts` → 9 passed。
- 中(Step 3):9 passed / 5 failed(`handler.shutdown is not a function`)。
- 后(Step 7):14 passed / 0 failed;全量 `137 files / 944 tests` → `137 files / 949 tests`。
- **给不出数字的**:真实退出顺序(安装器 vs OBS 停录)只有 Windows 真机能验,
  本机与 CI 都跑不到。源码依据是 `BaseUpdater.js:13-27` 的
  `install()` 先于 `setImmediate(app.quit())`,属推演不属实测。

---

## Task 3: settingsStore 加 `autoCheckUpdates` / `lastSeenVersion`

对应 spec §4.6(设置页开关)与 §4.7(更新后留痕)的持久化部分。两个字段都是纯数据,不牵扯 electron。

**Files:**

- Modify: `packages/desktop/src/main/settingsStore.ts`(`GladlogSettings` interface :15-43 末尾追加;`DEFAULTS` :44-57 追加两行)
- Modify: `packages/desktop/test/settingsStore.test.ts`(**两处**全量字面量都要补:`:16-29` 的默认值快照断言、`:69-82` 的 `redactSettings` 用例里那份 `base`;另在 `:45` 之前插入三条新用例)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts`(:34-47 的 `GladlogSettings` 全量字面量追加两行)

**Interfaces:**

- Consumes: 无(本任务不依赖前序任务)
- Produces:
  - `GladlogSettings.autoCheckUpdates: boolean`,`DEFAULTS` 里为 `true`
  - `GladlogSettings.lastSeenVersion: string | null`,`DEFAULTS` 里为 `null`
  - 后续任务这样消费:updater 接线处(Task 6)`isAutoCheckEnabled: () => settings.get().autoCheckUpdates`;设置页「自动检查更新」开关 `save({ autoCheckUpdates })`;**§4.7 的留痕比对与写回逻辑只有一份**,住在 Task 6 的 `src/renderer/src/update/updateBridge.ts`(`resolveVersionNotice` / `dismissVersionNotice`),Task 7 的 UpdateBanner 与 Task 8 的 SettingsPanel 一律 import 它,**不许在组件里手抄第二份 `getVersion()` vs `lastSeenVersion` 的比对**

**先说清楚三件不用做的事**(免得实现者以为漏了):

1. `sanitizeSettingsPatch`(settingsStore.ts:98-143)**不需要改**。它是黑名单式校验器:只对 `anthropicApiKey` / `obsWebsocketPassword` / `deepseekApiKey` 的哨兵回写、`recordingKeepCount` 的数值范围、`aiBackend` / `aiLanguage` / `aiModels` 的枚举白名单做剔除,其余键原样透传。既有的两个 boolean(`DEFAULTS` 里的 `autoAnalyzeNew` :52、`recordingEnabled` :53)也都没有任何额外校验。本任务的 Step 1 会写一条测试把这个「透传」钉住。
2. `redactSettings`(settingsStore.ts:89-96)**不需要改**。它是 `{ ...s, 三个密钥字段: 哨兵 }` 的展开式,新增非密字段自动透传。同样在 Step 1 写测试钉住。
   **注意区分「实现不用改」和「测试里那份 `base` 字面量必须改」**:核查轮曾断言 `base` 是裸对象字面量所以不会红 —— 那句话只对了一半。它确实没有 `: GladlogSettings` 标注,但它被 `redactSettings(base)`(:83)当实参传进去,而形参类型是 `GladlogSettings`,少两个必填字段就是 `TS2345: Argument of type ... is missing the following properties from type 'GladlogSettings': autoCheckUpdates, lastSeenVersion`。所以 Step 1 的 (c) 不是可选项。spec §4.6 也逐字写了「两处,别只改前一处」。
3. **不要顺手给 `fixtureBridge.ts` 加 `update` 面。** 本任务对 fixtureBridge 的改动只有 settings 字面量补两行。fixture 预览刻意**不提供**更新面(全局裁决 6),Task 7/8 的像素判据「fixture 下不渲染任何更新相关 UI」直接依赖这一点;加了会让 settings 基线图多出「检查更新」按钮,人工审图当场判成 bug。

### 步骤

- [ ] **Step 1: 写失败的测试** — 编辑 `packages/desktop/test/settingsStore.test.ts`。三处改动 (a)(b)(c) 一次做完。

  (a) 把 :16-29 的全量默认值断言改成(在 `recordingKeepCount: 50,` 之后加两行):

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

  (b) 在 `it("损坏 JSON → 回退默认,不抛", ...)`(:45)这条之前插入三条:

  ```ts
  it("autoCheckUpdates:默认 true;lastSeenVersion:默认 null;两者 save 往返持久化", () => {
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
  it("sanitizeSettingsPatch 对这两个字段是透传(黑名单式校验器,无需改)", () => {
    expect(
      sanitizeSettingsPatch({
        autoCheckUpdates: false,
        lastSeenVersion: "1.2.3",
      }),
    ).toEqual({ autoCheckUpdates: false, lastSeenVersion: "1.2.3" });
  });
  it("redactSettings 不动这两个字段(非密字段展开式透传)", () => {
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

  (`sanitizeSettingsPatch` / `redactSettings` / `API_KEY_REDACTED` 已在文件 :4-9 导入,不用改 import。`describe` / `it` / `expect` 走 vitest 的 `globals: true`(`packages/desktop/vitest.config.ts:5`),这个文件本来就没有 vitest import,别加。)

  (c) 把同一文件 `describe("settings 脱敏(key 永不出主进程)")` 里 :69-82 的 `const base = { … }` 补两个字段 —— 把 :81-82 的

  ```ts
        recordingKeepCount: 50,
      };
  ```

  改成

  ```ts
        recordingKeepCount: 50,
        autoCheckUpdates: true,
        lastSeenVersion: null,
      };
  ```

  这一处不新增用例、也不改任何断言,纯粹是为了让 `redactSettings(base)`(:83)在 interface 加了必填字段之后仍然通过 `npm run typecheck`。

- [ ] **Step 2: 跑它确认失败** — Run(worktree 根):

  ```
  npm test --workspace=packages/desktop -- test/settingsStore.test.ts
  ```

  Expected: `Tests  2 failed | 10 passed (12)`(该文件改动前是 9 条,新增 3 条 → 12;(c) 只补字段不加用例),两条失败分别是

  ```
  × SettingsStore > 缺失文件 → 默认值
    → expected { wowDirectory: null, …(11) } to deeply equal { wowDirectory: null, …(13) }
  × SettingsStore > autoCheckUpdates:默认 true;lastSeenVersion:默认 null;两者 save 往返持久化
    → expected undefined to be true // Object.is equality
  ```

  另外两条(sanitize / redact)**前后都是绿**——这是刻意的:它们不验证新增行为,而是把「这两个函数不需要改」这个结论钉成回归门。别以为没红就是写错了。
  (c) 的类型问题在这一步**不会**表现出来:vitest 走 esbuild 只转译不做类型检查,它只在 Step 8 的 `npm run typecheck` 里才是红的 —— 这也是 (c) 必须现在就做完的原因,否则 Step 8 会以一个和本步毫无关联的报错炸出来。

- [ ] **Step 3: 加字段到 interface** — 编辑 `packages/desktop/src/main/settingsStore.ts`,把 :40-43 的

  ```ts
    /** Keep the most recent N recordings (anything beyond is deleted together
     * with its video file); 0 = never clean up. */
    recordingKeepCount: number;
  }
  ```

  改成

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

- [ ] **Step 4: 加默认值** — 同一文件,把 `DEFAULTS`(:44-57)里的

  ```ts
    recordingKeepCount: 50,
  };
  ```

  改成

  ```ts
    recordingKeepCount: 50,
    autoCheckUpdates: true,
    lastSeenVersion: null,
  };
  ```

- [ ] **Step 5: 补 fixtureBridge 的全量字面量** — 编辑 `packages/desktop/src/renderer/src/fixtureBridge.ts`,把 :45-47 的

  ```ts
      obsWebsocketPassword: null,
      recordingKeepCount: 50,
    };
  ```

  改成

  ```ts
      obsWebsocketPassword: null,
      recordingKeepCount: 50,
      autoCheckUpdates: true,
      lastSeenVersion: null,
    };
  ```

  这行不是可选项:`currentSettings` 带 `: GladlogSettings` 标注,interface 加必填字段后不补这里 typecheck 直接红。
  **本文件本任务只改这两行**,别加 `update` 面(理由见本任务开头第 3 条)。

- [ ] **Step 6: 跑测试确认通过** — Run(worktree 根):

  ```
  npm test --workspace=packages/desktop -- test/settingsStore.test.ts src/main/settingsStore.test.ts src/main/settingsStore.recording.test.ts
  ```

  Expected: `Tests  26 passed (26)`(三个文件:12 + 11 + 3)。改动前同一命令是 `23 passed (23)`(9 + 11 + 3,2026-08-03 实测)。

- [ ] **Step 7: grep 自查 —— 全仓还有没有第四处全量字面量** — Run(worktree 根):

  ```
  grep -rn "recordingKeepCount:" --include="*.ts" --include="*.tsx" packages/desktop | grep -v "src/main/settingsStore.ts"
  ```

  Expected(2026-08-03 实测):命中 11 行,其中**只有三处**是 `GladlogSettings` 全量字面量、必须带上新字段 ——
  `test/settingsStore.test.ts:28`、`test/settingsStore.test.ts:81`、`src/renderer/src/fixtureBridge.ts:46`(经 Step 1(a)(c) 与 Step 5 后行号会各下移)。
  其余命中都**不是** `GladlogSettings`,一律不动:`SettingsPanel.tsx:488` 是 `save({ recordingKeepCount: n })` 的 `Partial` 补丁;`recorder.test.ts:64/154/182` 与 `recorder.ts:66` 是 recorder 自己的配置形状(`recorder.ts:66` 声明的是另一个接口);`settingsStore.recording.test.ts:39/42/44/45` 是 `sanitizeSettingsPatch` 的 `Partial` 入参。
  这一步存在的理由:`GladlogSettings` 是必填字段接口,漏任何一处全量字面量都会在下一步 typecheck 里以一条与本功能毫无关系的报错炸出来。

- [ ] **Step 8: 三件套** — Run(worktree 根,三条依次):

  ```bash
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  Expected:第一条 `Test Files 137 passed` / `Tests 952 passed`(Task 2 结束时的 137/949 + 本任务净增 3 条,不新增文件);第二条六个 workspace 全绿、无 `error TS` 输出(**绝不用 `tsc -b`**,会往 src 吐 .js);第三条无输出。

  这一步不是走过场:本任务改了 `fixtureBridge.ts`(fixture 预览与视觉基线的数据源)和两处 `GladlogSettings` 全量字面量,而 Step 7 的 grep 只扫 `recordingKeepCount:` 这一种写法,扫不到用 spread 构造的全量断言 —— 只有全量跑才兜得住。不跑的话红会一直藏到 Task 4 Step 22 的全量里,那时报错会挂在一个跟 Task 4 毫无关系的文件上。lint 必须扫全仓(`eslint .`),只扫 `packages/desktop/src` 会漏掉 `test/`,这个口子连挂过三次 CI。

- [ ] **Step 9: commit** — Run(worktree 根):

  ```
  git add packages/desktop/src/main/settingsStore.ts packages/desktop/test/settingsStore.test.ts packages/desktop/src/renderer/src/fixtureBridge.ts
  git commit -m "feat(desktop): 设置项加 autoCheckUpdates / lastSeenVersion —— 自动更新开关与更新留痕

  autoCheckUpdates 只控制 30s/4h 后台轮询,设置页手动「检查更新」不受影响;
  lastSeenVersion 与 app.getVersion() 比对,给静默更新留痕(比对逻辑单源在
  renderer/src/update/updateBridge.ts,组件不许手抄)。
  sanitizeSettingsPatch / redactSettings 的实现经查无需改动(黑名单式 + 展开式),
  另加两条测试把这个结论钉成回归门;但 GladlogSettings 是必填接口,三处全量
  字面量(test 里两处 + fixtureBridge 一处)必须同步补,否则 typecheck 红。
  settingsStore 用例数 9 → 12(本任务净增 3 条)。"
  ```

---

## Task 4: `updater.ts` —— 三重生效门 + 状态机 + install() + 定时器

对应 spec §4.1 / §4.2 / §4.2.1 / §4.3 的客户端侧。本任务产出的模块**完全不 import electron、也不 import electron-updater**:真 `autoUpdater` 与它需要的一切(平台、packaged 标志、安装目录列表)全部注入,所以整个门 + 状态机 + install 顺序可以脱离 electron 在 vitest 里跑。理由同 `quitLifecycle.ts` 头部注释。

**Files:**

- Create: `packages/desktop/src/main/updater.ts`
- Create: `packages/desktop/src/main/updater.test.ts`(22 条)
- Create: `packages/desktop/src/main/updater.uninstallerName.test.ts`(1 条跨包一致性门)

(测试与源码同目录,照 `quitLifecycle.test.ts` / `e2eEnv.test.ts` 的既有惯例;`packages/desktop/test/` 那批是 renderer/集成向的。)

**Interfaces:**

- Consumes:
  - Task 3 的 `GladlogSettings.autoCheckUpdates` —— **不是 import 关系**,只经由 `UpdaterDeps.isAutoCheckEnabled: () => boolean` 注入,Task 6 的接线负责把两者接起来
  - Task 2 的 `quitLifecycle.shutdown()` —— 同样**不是 import 关系**,只经由 `UpdaterDeps.shutdown: () => Promise<void>` 注入
  - `electron-updater@6.8.9` 由 **Task 1** 随发布端配置一并提交进 `packages/desktop/package.json:31` 的 `dependencies`(轮到本任务时工作树已干净,**不要再改一遍 package.json**,也**不要**加进 `electron.vite.config.ts` 的 `externalizeDepsPlugin` exclude 列表 —— 那个列表只给 `@gladlog/*` 工作区包用,因为它们的 `main` 指向 TS 源码)。本模块**不 import 它**,只在类型上结构化声明 `UpdaterBackend`
- Produces(逐字,后续任务照此消费):

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

  /** 纯函数;testFeed 置位但非法时**抛错**,不返回 GateResult。 */
  export function evaluateGate(env: UpdaterEnv): GateResult;

  export interface UpdaterBackend {
    /* 见 Step 9 的完整定义 */
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

### 与 Task 5 / Task 6 的分工(已定,不要重复实现)

**`install()` 的唯一实现在本任务**(Step 14-15),包括「`await deps.shutdown()` resolve 之后才调 `quitAndInstall(true, true)`」的顺序和顺序断言测试。`deps.shutdown` 是注入进来的 `() => Promise<void>`,updater.ts 对 `quitLifecycle` 零依赖,所以这里能测全。

**定时节奏(30s 首检 / 4h 轮询)的唯一实现也在本任务**(Step 12):常量 `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` 由 updater.ts 单源持有,定时器由 `createUpdaterService` 自己起、自己在 `dispose()` 里清。**Task 6 的接线处不许再声明这两个常量、不许再建第二套 timer**,它在 `before-quit` 里只调 `updaterService?.dispose()`。

其余任务的归属,别搞错:

- **quitLifecycle 的 `shutdown()` 是 Task 2 的活**(已完成),不是 Task 5 的
- **main/index.ts 的接线是 Task 6 的活**(含 `autoUpdater.logger = log`、动态 import、`evaluateGate` 前置判断)
- **Task 5 只做 `install()` 的两个增量**,在本任务产出的 `updater.ts` 上做**增量编辑**,不重建 harness、不重写 `install()`:
  1. 把 Step 15 里那句裸的 `await deps.shutdown();` 包成 try/catch(「清理失败也照装」,spec §4.3)
  2. 加安装看门狗:`INSTALL_WATCHDOG_MS = 10_000`,`quitAndInstall` 之后 arm,超时未被安装器接管就落 `error` 状态

  Task 5 会用到本任务产出的三处锚点,本任务把它们留干净就行,**不要提前实现**:
  (i) 局部变量区 `let installing = false;` 那一行下面;(ii) `install()` 里 `backend.quitAndInstall(true, true)` 之后;(iii) `dispose()` 的首部。
  尤其注意:**本任务的 `await deps.shutdown();` 刻意不加 try/catch** —— 那是 Task 5 的第一个增量,提前加会让 Task 5 的「确认它红」步骤当场变绿,执行者会卡在「该红没红」上。

### 给 Task 6(接线)的交接说明(写在这里,免得散落)

1. `UpdaterEnv` 的生产实参:`platform: process.platform`、`isPackaged: app.isPackaged`、`execDir: dirname(process.execPath)`、`readDir: readdirSync`(`fs`)、`testFeed: process.env["GLADLOG_UPDATER_TEST_FEED"]`
2. **`autoUpdater.logger = log`(electron-log)必须由接线处真的写一行**,位置在 `initUpdater` 里、取到 `autoUpdater` 之后、`createUpdaterService(` 之前。不在 `UpdaterBackend` 接口里 —— updater.ts 保持零 electron 依赖。**不写这行整条证据链就断**:默认 logger 是 `console`(`AppUpdater.js:179` 实测 `this._logger = console;`),`Checking for update` / `Found version X` 永远不进 `~/Library/Logs/gladlog/main.log`,而那是 spec §6.2 dummy release 验证的头号证据通道
3. coldStart 预算 2600ms(`qa/budgets.ts:44` 实测):接线处先调 `evaluateGate(env)`,`ok` 时才 `await import("electron-updater")`,再 `createUpdaterService`。`evaluateGate` 是纯函数,被求值两次(接线一次、`createUpdaterService` 内部一次)结果一致,这是刻意的单源复用而不是抄第二份
4. **`testFeed` 直通,不要加 `GLADLOG_E2E` 判断**(全局裁决 5)。门的判定顺序把 `!isPackaged → dev` 排在 testFeed 校验之前,E2E/dev 下压根走不到校验(Step 3 的第一条测试就钉这个),所以开发机 shell 里残留的变量炸不到 E2E;反过来,在接线处把它清零会**破坏 spec §6.2** —— dummy release 的客户端是一个打包后的 app,启动时**同时**带着 `GLADLOG_E2E=1`(挪 userData 做数据隔离)和 `GLADLOG_UPDATER_TEST_FEED`
5. **定时器归本模块所有,接线处只调 `dispose()`**(全局裁决 4)。`dispose()` 由 main/index.ts **再注册一个 `app.on("before-quit", ...)` 监听来调**(`preventDefault()` 不阻止同事件的其余监听器,而 `QuitLifecycleDeps` 的依赖形状是固定的,不要为它新增依赖)。不调的话 4h 的 `setInterval` 会拖住退出。接线处**不许**声明 `UPDATE_FIRST_CHECK_MS` / `UPDATE_POLL_MS` 之类的第二份常量,也**不许**再 `setTimeout` / `setInterval` 调一遍 `autoCheck()` —— 那会让真机上每个节拍发两次 checkForUpdates,而且把 30s/4h 这两个数字手抄成两份(CLAUDE.md 头号红线,漂移方向没有任何报错)。**Task 6 Step 10b 有一条 grep 自查兜住这一条**(扫 `main/index.ts`,期望零输出)
6. renderer 若要用 `UpdateState`,必须 `import type`(先例 `src/preload/api.ts:6` `import type { RecorderStatus } from "../main/recorder";`)。写成值导入会把 electron-updater 拖进 renderer bundle,`electron-vite build` 与 `npm run build:ui` 双双炸

### 步骤

- [ ] **Step 1: 写测试骨架 + evaluateGate 的 8 条(红)** — 新建 `packages/desktop/src/main/updater.test.ts`:

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
    it("非 packaged → dev,且优先于其它门(非法 testFeed 也不抛)", () => {
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

    it("packaged + win32 + 有卸载器 → 放行,生产 feed", () => {
      expect(evaluateGate(winEnv())).toEqual({ ok: true, feed: null });
    });

    it("非 win32 → platform(mac ad-hoc 签名过不了 Squirrel 校验)", () => {
      expect(evaluateGate(winEnv({ platform: "darwin" }))).toEqual({
        ok: false,
        reason: "platform",
      });
    });

    it("win32 但目录里没有卸载器(zip 绿色版)→ portable", () => {
      expect(
        evaluateGate(winEnv({ readDir: () => ["gladlog.exe", "resources"] })),
      ).toEqual({ ok: false, reason: "portable" });
    });

    it("卸载器判据是扫模式:改了 productName 依然认得", () => {
      expect(
        evaluateGate(winEnv({ readDir: () => ["Uninstall gladlog-next.exe"] })),
      ).toEqual({ ok: true, feed: null });
      // 相近但不是 NSIS 卸载器的文件名不许误判为安装版
      expect(
        evaluateGate(
          winEnv({ readDir: () => ["Uninstaller.exe", "unins000.exe"] }),
        ),
      ).toEqual({ ok: false, reason: "portable" });
    });

    it("目录读不出来 → 按 portable 处理,不抛", () => {
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

    it("testFeed 合法 → 跳过 platform 与 portable 两道门,返回 feed", () => {
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

    it("testFeed 非法 → 抛错,绝不静默回落到生产 feed", () => {
      for (const bad of ["", "garbage", "owner/", "/repo", "a/b/c"]) {
        expect(() => evaluateGate(winEnv({ testFeed: bad }))).toThrow(
          /GLADLOG_UPDATER_TEST_FEED/,
        );
      }
    });
  });
  ```

  import 块一次写全(含后面几步才用到的 `createUpdaterService` / 两个常量):vitest(本仓 2.1.9)走 Vite 的 SSR transform,对 TS 模块里**不存在的具名导出不报解析错**,只会拿到 `undefined`(已用探针实测),所以提前写不影响本步的红色原因。

- [ ] **Step 2: 跑它确认失败** — Run(worktree 根):

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  Expected: `Test Files  1 failed (1)` / `Tests  no tests`,原因是模块不存在:

  ```
  Error: Failed to load url ./updater (resolved id: ./updater) in /.../packages/desktop/src/main/updater.test.ts. Does the file exist?
  ```

- [ ] **Step 3: 写 evaluateGate 的最小实现** — 新建 `packages/desktop/src/main/updater.ts`:

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
  ```

- [ ] **Step 4: 跑测试确认通过** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`。Expected: `Tests  8 passed (8)`。

- [ ] **Step 5: commit** — Run(worktree 根):

  ```
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): updater 三重生效门 evaluateGate

  判定顺序 !isPackaged → testFeed → platform → 卸载器,dev 门排第一是为了让
  开发机 shell 里残留的 GLADLOG_UPDATER_TEST_FEED 永远炸不到 E2E,同时不影响
  §6.2 的 dummy release 客户端(它是打包版,同时带 E2E 与 test feed 两个变量)。
  isPackaged 那道门的理由按核查轮更正:不是防抛错(未打包时 electron-updater
  自己就 resolve(null) no-op),而是让状态机能报 reason: 'dev' 而非停在 idle。
  testFeed 非法直接抛(照 e2eEnv.ts 的口径),静默回落生产 feed 会让 dummy
  release 验证看起来通过实际什么都没验。卸载器用扫模式而非硬编码文件名。"
  ```

- [ ] **Step 6: 写假 backend + 「门不通过」与状态机的 7 条(红)** — 在 `updater.test.ts` 的 `winEnv` 之后、`describe("evaluateGate")` 之前插入假 backend:

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

  三点说明:
  - 用 getter/setter 记录属性赋值,是为了让「门不通过时**从不碰** autoUpdater」这条断言连属性写入也覆盖到,而不只是方法调用
  - `_allowPrerelease` 的初值刻意是 `true`,复刻真实构造器的行为:`AppUpdater.js:218` `this.allowPrerelease = hasPrereleaseComponents(currentVersion)` —— 跑在 `0.1.15-obs.6` 这类包上时它会被自动置 true。所以 Step 9 里那行 `allowPrerelease = false` 必须**无条件**执行,而 `set:allowPrerelease=false` 出现在 `backend.calls` 里就是它真的被执行过的证据
  - `fire()` 直接调监听器,不走真 EventEmitter,所以「没有 error 监听器时 Node 会把错误抛成 uncaught」这条真实语义在单测里**验不到**;它靠 Step 9 的「所有监听器在任何 checkForUpdates 之前挂好」这一结构保证(spec §4.2 实现约束 1)

- [ ] **Step 7: 追加两个 describe(红)** — 在文件末尾追加:

  ```ts
  describe("createUpdaterService:门不通过", () => {
    it("disabled 状态带 reason,且从不碰 autoUpdater 的任何成员", () => {
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

    it("disabled 下 check/autoCheck/install 都是空操作", async () => {
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

  describe("createUpdaterService:状态机", () => {
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

    it("初始 idle,且配置按设计写死", () => {
      expect(svc.getState()).toEqual({ phase: "idle", lastCheckedAt: null });
      expect(backend.calls).toEqual([
        "set:autoDownload=true",
        "set:autoInstallOnAppQuit=true",
        "set:allowPrerelease=false",
        "set:disableWebInstaller=true",
      ]);
    });

    it("事件序列 → 状态快照", () => {
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

    it("update-not-available → idle 带上次检查时间", () => {
      backend.fire("checking-for-update");
      backend.fire("update-not-available", { version: "0.1.19" });
      expect(svc.getState()).toEqual({
        phase: "idle",
        lastCheckedAt: 1_700_000_000_000,
      });
    });

    it("同一整数百分比不重复推送", () => {
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

    it("error 事件只落状态,不抛、不弹窗", () => {
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

  事件名逐字来自 `node_modules/electron-updater/out/AppUpdater.d.ts:14-24` 的 `AppUpdaterEvents`(实测**共 9 个**,不是 6 个)。我们只映射其中 6 个,另外三个刻意不监听:`update-cancelled`(`AppUpdater.js:636`,只在下载抛 `CancellationError` 时发;我们 `autoDownload=true` 且从不主动 cancel,发不出来)、`login`(`:206`,代理认证)、`appimage-filename-updated`(只有 Linux 的 `AppImageUpdater` 发)。不监听它们不会崩 —— EventEmitter 只对 `error` 特殊,而 `error` 我们监听了。payload 字段名同样有据:`UpdateInfo.version`(`update-downloaded` 的 `UpdateDownloadedEvent extends UpdateInfo`,`types.d.ts:34-36`)、`ProgressInfo.percent`(`builder-util-runtime/out/ProgressCallbackTransform.d.ts:3-9`)。

- [ ] **Step 8: 跑它确认失败** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`。Expected: `Tests  7 failed | 8 passed (15)`,7 条失败的报错都是

  ```
  TypeError: createUpdaterService is not a function
  ```

  (状态机那个 describe 的 5 条是在 `beforeEach` 里炸的。vitest 2.1.9 的 SSR transform 把缺失的具名导出解析成 `undefined`,报错文本里**没有** `__vi_esm_0__.` 之类的前缀 —— 已用探针实测。)

- [ ] **Step 9: 实现 service 骨架 + 事件接线** — 在 `updater.ts` 末尾追加:

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

  返回对象里的 `check` / `autoCheck` / `install` / `dispose` 是本轮 TDD 的临时最小实现,Step 12 与 Step 15 会逐个换掉——不是留在成品里的占位符。

- [ ] **Step 10: 跑测试确认通过** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`。Expected: `Tests  15 passed (15)`。

- [ ] **Step 11: 写检查节奏的 4 条(红)** — 在 `it("error 事件只落状态...")` 之后追加:

  ```ts
  it("check() 手动:不看自动检查开关", async () => {
    autoCheckEnabled = false;
    await svc.check();
    expect(backend.calls).toContain("checkForUpdates");
  });

  it("autoCheck() 定时:开关关掉就不查", async () => {
    autoCheckEnabled = false;
    await svc.autoCheck();
    expect(backend.calls).not.toContain("checkForUpdates");
  });

  it("checkForUpdates reject 不冒泡(双通道里 promise 那半由 catch 吞掉)", async () => {
    backend.checkResult = Promise.reject(new Error("ENOTFOUND"));
    await expect(svc.check()).resolves.toBeUndefined();
  });

  it("启动后 30s 首检,之后每 4h 一次;dispose 后不再检查", async () => {
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

  最后一条把「定时器归 updater.ts 单源持有」钉成门规,但它只覆盖服务内部:如果有人在 main/index.ts 里**又**建一套 timer,这条测照样绿,真机上每个节拍会发两次请求。那一半由交接说明第 5 条(接线处不许再建)约束,并由 **Task 6 Step 10b 那条 grep 自查**(扫 `packages/desktop/src/main/index.ts` 有没有 `setTimeout` / `setInterval` / 节奏常量,期望零输出)兜住 —— 那是全局裁决 4 唯一的自动化守卫,别跳过。

  Run 确认失败(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`,Expected `Tests  2 failed | 17 passed (19)` ——「check() 手动」失败于 `expected [ … ] to include 'checkForUpdates'`,「30s 首检」失败于 `expected [] to have a length of 1 but got 0`。(另两条因为空实现恰好也是绿,属预期。)

- [ ] **Step 12: 实现 runCheck / autoCheck / 定时器** — 在 `updater.ts` 里,把 `backend.on("error", ...)` 那段之后、`return {` 之前插入:

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

  同时把返回对象改成:

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

- [ ] **Step 13: 跑测试确认通过** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`。Expected: `Tests  19 passed (19)`。

- [ ] **Step 14: 写 install() 的 3 条(红)** — 在状态机 describe 末尾追加:

  ```ts
  it("install():未 ready 时什么都不做", async () => {
    await svc.install();
    expect(shutdown).not.toHaveBeenCalled();
    expect(backend.calls.some((c) => c.startsWith("quitAndInstall"))).toBe(
      false,
    );
  });

  it("install():shutdown 必须 resolve 之后才起安装器(顺序断言)", async () => {
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

  it("install():重复调用只跑一条链", async () => {
    backend.fire("update-downloaded", { version: "0.1.20" });
    await Promise.all([svc.install(), svc.install()]);
    await svc.install();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(
      backend.calls.filter((c) => c.startsWith("quitAndInstall")),
    ).toHaveLength(1);
  });
  ```

  两点说明:
  - 第二条是**顺序断言**而不是「都调了」断言:`quitAndInstall` 内部先 spawn detached 的 NSIS 安装器、**再**在 `setImmediate` 里 `app.quit()`(`BaseUpdater.js:13-27` 实测),所以清理链必须先跑完,否则安装器与停录像/停 worker 抢时序
  - 第二条里的 `gated` 与 `svc` 共用同一个 `backend`(刻意的:省一套 harness)。后果是 `backend.fire("update-downloaded")` 会同时喂给两个服务、`gated` 的构造也会往 `backend.calls` 里多推 4 条 `set:*` —— 这些都不影响本条的三个断言(它们只看 `quitAndInstall` 前缀和 `order`)。`gated` 必须自己 `dispose()`,`afterEach` 只管 `svc`

  Run 确认失败(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`,Expected `Tests  2 failed | 20 passed (22)`——两条失败分别是 `expected [] to deeply equal [ 'shutdown-start' ]` 与 `expected "spy" to be called 1 times, but got 0 times`。(「未 ready 时什么都不做」因为空实现恰好绿。)

- [ ] **Step 15: 实现 install()** — 在 `updater.ts` 的 `const pollTimer = ...` 之后、`return {` 之前插入:

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

  把 `let pendingVersion = "";` 那行下面补一行状态变量:

  ```ts
  let installing = false;
  ```

  (`installing` 一旦置位就**永不复位**,这是刻意的:安装器接管后进程即将消失,而没接管时下一任务的看门狗要保证不会 spawn 第二个安装器。)

  并把返回对象里的 `install: () => Promise.resolve(),` 换成 `install,`。

- [ ] **Step 16: 跑测试确认通过** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.test.ts`。Expected: `Tests  22 passed (22)`。

- [ ] **Step 17: commit** — Run(worktree 根):

  ```
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): updater 状态机 + 检查节奏 + install()

  六个 electron-updater 事件单向映射到 UpdateState;error 只落状态不抛不弹窗。
  监听器全部在首次 checkForUpdates 之前挂好,两个理由:EventEmitter 无 error
  监听器会把错误抛成 uncaught;autoDownload=true 时下载在 checkForUpdates 内部
  就开始,electron-updater 只在下载启动那一刻快照 listenerCount
  (\"download-progress\")(AppUpdater.js:567),晚挂等于零事件且不报错。
  allowPrerelease=false 无条件赋值 —— 构造器会按当前版本号自动置 true
  (AppUpdater.js:218),跑在 -obs.6 这类包上时不覆盖就漏。
  checkForUpdates 失败是 emit error + reject 双通道,catch 只吞 promise 那半。
  30s/4h 定时器由 service 自己持有并在 dispose 清掉(接线处不许再建第二套)。
  install() 先 await shutdown() 再 quitAndInstall(true,true),顺序有断言。
  本文件新增 22 条单测。"
  ```

- [ ] **Step 18: 写卸载器谓词的跨包一致性门(红)** — 新建 `packages/desktop/src/main/updater.uninstallerName.test.ts`:

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

  describe("卸载器文件名谓词与 app-builder-lib 模板一致", () => {
    it("UNINSTALL_FILENAME 模板渲染出来的名字必须被 UNINSTALLER_PATTERN 命中", () => {
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

  两点校对过的事实:`node_modules/app-builder-lib/templates/nsis/common.nsh:17` 逐字是 `!define UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"`;`__dirname` 从 `packages/desktop/src/main/` 上溯四级正是 worktree 根的 `node_modules/`(依赖在根部 hoist,已实测存在)。`__dirname` 在 `"type": "module"` 的包里依然可用 —— vitest 注入它,先例是 `packages/desktop/test/diagnosticLevel.test.ts:41-44` 用同一招读 parser 包源码。

  这是 CLAUDE.md「谓词放一处 export,两边 import」在跨包场景下的做法。注意本功能**不进** `docs/predicate-index.md`(全局裁决 9)——那份索引只登记 `analysis`/`eval`/`corpus-tools` 三个前缀的谓词(`packages/eval/test/predicateIndex.test.ts:24-56` 的 import 清单 + `:72-74` 的三个路径前缀常量 `A`/`E`/`C`,实测无 desktop 前缀),desktop 一直只以 "Consumed by" 身份出现,硬塞会让那条一致性测试打红。

- [ ] **Step 19: 跑它确认失败** — Run(worktree 根):

  ```
  npm test --workspace=packages/desktop -- src/main/updater.uninstallerName.test.ts
  ```

  Expected: `Tests  1 failed (1)`,报错 `TypeError: Cannot read properties of undefined (reading 'test')` —— `UNINSTALLER_PATTERN` 此刻还是模块私有常量,没导出,SSR transform 把它解析成 `undefined`。

- [ ] **Step 20: 导出谓词** — 编辑 `packages/desktop/src/main/updater.ts`,把

  ```ts
  const UNINSTALLER_PATTERN = /^Uninstall .+\.exe$/;
  ```

  改成

  ```ts
  export const UNINSTALLER_PATTERN = /^Uninstall .+\.exe$/;
  ```

- [ ] **Step 21: 跑测试确认通过** — Run(worktree 根):`npm test --workspace=packages/desktop -- src/main/updater.uninstallerName.test.ts`。Expected: `Tests  1 passed (1)`。

- [ ] **Step 22: 全量回归 + typecheck + lint** — Run(worktree 根,三条依次):

  ```
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  Expected:

  - 第一条全绿,且用例数比**本任务开始前**多 **23** 条(22 + 1)。全量基线是 `Test Files 136 passed (136)` / `Tests 938 passed (938)`(2026-08-02 本 worktree 实测,2026-08-03 复测同值)。**本步只报本任务的净增量,不报绝对总数** —— 绝对总数取决于 T1/T2/T3 是否已落地,汇总表在文末的收尾清单 A;跑之前一律以 `npm test --workspace=packages/desktop 2>&1 | tail -5` 的当场输出为准
  - 第二条六个 workspace 无 `error TS`
  - 第三条无输出。**lint 必须扫全仓**(`eslint .`),只扫 `packages/desktop/src` 会漏掉 `test/`、`qa/`、`dev/`、`scripts/`——这个口子连挂过三次 CI。**别等 `simple-import-sort/imports` 报错**:它在 `eslint.config.js:33` 是 **warn**(2026-08-03 实测),而门跑的是 `--quiet`(只报 error)—— import 顺序**没有硬门**,新文件的 import 块按字母序自己写对即可;想核一眼就跑不带 `--quiet` 的 `npx eslint packages/desktop/src/main/updater.ts`

- [ ] **Step 23: commit** — Run(worktree 根):

  ```
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.uninstallerName.test.ts
  git commit -m "test(desktop): 卸载器文件名谓词与 app-builder-lib 模板做一致性门

  /^Uninstall .+\\.exe\$/ 与 templates/nsis/common.nsh:17 的 UNINSTALL_FILENAME
  对账(app-builder-lib 26.15.3)。electron-builder 升级改了卸载器命名会打红 CI,
  而不是静默退化成「所有安装版都被判成绿色版、永不更新」—— 这类失效方向没有
  任何报错,只能靠门挡。
  本任务合计新增 23 条单测(updater.test.ts 22 + 本文件 1)。"
  ```

### 已知边界(实现时别当 bug 报,也别顺手"修")

1. **`install()` 的 shutdown 失败与看门狗都不在本任务**。本任务的 `await deps.shutdown();` 裸着、`quitAndInstall` 之后没有超时保护 —— 这两个增量属于 Task 5(见「与 Task 5 / Task 6 的分工」),提前做会让下一任务的红步骤失效。
2. **mac 上 `quitAndInstall` 的两个参数会被忽略**。`MacUpdater.js:240` 的签名是 `quitAndInstall()`(无参),与 `BaseUpdater.js:13` 的 `(isSilent, isForceRunAfter)` 不同;它走 `this.nativeUpdater.quitAndInstall()` 而不是 spawn + `app.quit()`。也就是说 spec §6.2 用 `GLADLOG_UPDATER_TEST_FEED` 在 mac 上跑到 `install()` 时,**观察到的行为不能当作 §4.3 那条「detached 安装器先跑」设计的验证证据**。
3. **`autoInstallOnAppQuit = true` 只是兜底,不是保证**。`BaseUpdater.js:83-86`:退出码非 0 时不自动安装。
4. **三个未监听的事件**(`update-cancelled` / `login` / `appimage-filename-updated`)见 Step 7 的说明,均不会崩,也不进状态机。
5. **每次检查其实是三个 HTTP 请求**:`GitHubProvider.js:43-46` 在 `allowPrerelease` 的两个分支之前无条件拉一次 `.atom` feed,再加 `/releases/latest` 与 `latest.yml`。国内网络下失败面比预想宽,但全部收敛到 `error` 事件,无副作用 —— 这是 `error` 设计成「只落状态、不打扰」的现实理由之一。

### 本任务能证明什么、不能证明什么

**能**(同判据前后数字):`packages/desktop/src/main/updater*.test.ts` 从 0 条 → 23 条全绿;`npm run typecheck` 六 workspace 绿;`npx eslint . --quiet` 无输出。覆盖:三重门的四个分支 + 逃生口的合法/非法/优先级、六个事件到 `UpdateState` 的映射、进度去重、error 不抛、手动 vs 定时检查的开关语义、30s/4h 定时与 dispose、install 的顺序与幂等。

**不能**:真 electron-updater 的 feed 解析、选版、下载、sha512 校验一条都没验——那是 spec §6.2 的 dummy release 端到端(mac 本机)和 §6.3 的 Windows 真机才能证明的。特别是 `quitAndInstall` 无法脱离 electron 跑(`BaseUpdater.js:20` 会去 `require("electron").autoUpdater`),注入假 backend 是唯一可测路径,所以「安装器真的被拉起来」这件事本任务给不出数字。另外「没有 `error` 监听器时 EventEmitter 会抛 uncaught」这条真实语义也验不到 —— `FakeBackend.fire()` 直接调监听器数组,不是真 EventEmitter;那条约束靠 Step 9 的结构(所有监听器在构造期一次挂全)保证,不靠断言。
---

## Task 5: `install()` 的两个增量 —— shutdown 失败兜底 + 安装器未接管看门狗(设计文档 §4.3)

> **本任务是对 Task 4 的增量,不是重写。** `install()` 的完整实现(ready 门、单飞闩锁、`await deps.shutdown()` 之后才 `quitAndInstall(true, true)`、顺序断言测试)已经在 Task 4 的 Step 14-15 落地并绿掉了。本任务只补 Task 4 确实缺的两件事:
>
> 1. `await deps.shutdown()` 是裸调的 —— shutdown reject 会让 `install()` 自己 reject 且 `quitAndInstall` 永不执行,违反 §4.3 的「清理失败也照装」;
> 2. `BaseUpdater.js:16-25`:`install()` 返回 false 时 `quitAndInstall` **不调 `app.quit()`**,只把内部标志复位,而且返回 `void`,拿不到那个 false。那时 `shutdown()` 已经停了录像、停了 worker、杀了 AI,`quitLifecycle` 的 phase 也已翻成 `finishing` —— app 活着但功能全废,且下一次 `before-quit` 会被直接放行、不再清理。只能看钟。
>
> **不要**新建 harness、**不要**重写 `install()`、**不要**再写第二份 `runInstall()`。新测试直接复用 Task 4 的 `describe("createUpdaterService:状态机")` 里已有的 `backend` / `svc` / `emitted` / `shutdown`。

**Files:**

- Modify: `packages/desktop/src/main/updater.ts` —— (a) 模块作用域 `CHECK_INTERVAL_MS` 之后加一个非导出常量 `INSTALL_WATCHDOG_MS`;(b) `createUpdaterService` 内 `let installing = false;` 旁边加 `installWatchdog`;(c) Task 4 Step 15 的 `install()` 函数体里把裸 `await deps.shutdown();` 包进 try/catch,并在 `backend.quitAndInstall(true, true);` 之后 arm 看门狗;(d) 返回对象 `dispose()` 首部加两行清看门狗
- Test: `packages/desktop/src/main/updater.test.ts` —— 在 Task 4 已建的 `describe("createUpdaterService:状态机")` 末尾追加 **2 条**

**Interfaces:**

Consumes(全部来自 Task 4 的同一个文件,不跨文件 import):

```ts
// Task 4 已产出:
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
// 文件内部已有、本任务改写/复用的标识符(名字以 Task 4 落地的为准):
//   let state: UpdateState;                 // 当前状态
//   function setState(next: UpdateState)    // 赋值 state 并调 deps.emit(next)
//   let installing = false;                 // Task 4 的单飞闩锁,永不复位
//   async function install(): Promise<void> // Task 4 Step 15 的完整实现
//   const backend = deps.autoUpdater;
//   dispose: () => { clearTimeout(firstCheckTimer); clearInterval(pollTimer); }
```

测试侧复用(Task 4 Step 6/7 已建,不重写):

```ts
class FakeBackend implements UpdaterBackend { ... }
//   backend.calls              —— quitAndInstall 记作 "quitAndInstall:true:true"
//   backend.fire(event, payload)
// describe("createUpdaterService:状态机") 的 beforeEach 已 vi.useFakeTimers()
// 并构造 svc;afterEach 已 svc.dispose() + vi.useRealTimers()。
// shutdown 是 vi.fn(() => Promise.resolve()),可用 mockImplementationOnce 改写。
```

Produces(Task 6 的 IPC 层与 Task 7 的横幅按钮依赖这两条**新增**语义;Task 4 的四条语义不变):

```ts
install(): Promise<void>;
// 5. deps.shutdown() reject 时照样调 quitAndInstall,且 install() 自己永不 reject
// 6. quitAndInstall 之后 10 s 进程还活着 → 落
//    { phase: "error", message: "更新安装器未能接管,请手动退出 gladlog 后重新打开" }
//    并且闩锁不释放:安装器全生命周期最多 spawn 一次
dispose(): void;   // 额外清掉 install 看门狗
```

### 已知边界(执行时不许自作主张改掉)

1. **看门狗只落 `error`,刻意不 `app.quit()`。** updater 不持有 quit 依赖;为这个分支新开一条绕过 `quitLifecycle` 的退出路径,比留一个可见的错误状态更糟。Task 2「已知边界」第 2 条与 Task 4 Step 15 的注释都已统一到这个口径(审查清单 important-2 / minor-5),看到「至少:检测到没真装成就 app.quit()」那种旧说法一律以本条为准。
2. **看门狗的 message 文案不是跨 Task 的契约,不要让 renderer 去匹配它。** `UpdateBanner` 默认对 `phase: "error"` 什么都不渲染(§4.2 不打扰),唯独「点过立即重启之后落 error」这一路要在顶栏渲染 —— 但 Task 7 的判据是**本地事实**「本次会话点过安装」(`installRequested`),**不是**字符串匹配:这条文案产在 `src/main/updater.ts`,renderer 只能 `import type`,抄成字符串常量就是一份会静默腐烂的手抄谓词。所以改这句文案**不需要**同改 Task 7;但改了要同步 Task 5 Step 6 那条测试里的期望字符串。
3. **mac 上看到这条 error 是预期,不是回归。** `MacUpdater.js:240` 的 `quitAndInstall()` **不收参数**,走 `this.nativeUpdater.quitAndInstall()`(:233)而不是 spawn + `app.quit()`,没有 §4.3 那条「detached 安装器先跑」的性质;ad-hoc 签名下它必然失败且进程不退,§6.2 用 `GLADLOG_UPDATER_TEST_FEED` 在 mac 上跑到这一步时看门狗 10 s 后必然落 error。**mac 上的观察结果不能当作 §4.3 设计的验证证据。**
4. **真 `quitAndInstall` 无法脱离 electron 跑**:`BaseUpdater.js:20` 会 `require("electron").autoUpdater.emit("before-quit-for-update")`,碰的是 Electron 内置的 autoUpdater 模块。所以本任务只能靠注入的 `FakeBackend` 测,顺序与看门狗都是行为级断言,不是集成验证。
5. **看门狗与 `dispose()` 的时序是刻意的。** 成功路径上 `quitAndInstall` 内部的 `app.quit()` 会触发 `before-quit`,Task 6 接线处的第二个监听器随即 `dispose()`,把看门狗一并清掉 —— 进程正在消失,不需要它再报警。它兜的是**另一条**路:`BaseUpdater.install()` 返回 false 时 `quitAndInstall` 压根不调 `app.quit()`,于是没有 `before-quit`、没有 `dispose()`,10 s 后看门狗照常落 `error`。「安装器起来了但 quit 被别的监听器否决」这一路**不在覆盖范围内**(看门狗已被 dispose 清掉),**不要**为它给 updater 加 quit 依赖 —— 那是 Task 2 / Task 4 / Task 5 三处都禁止的第二条退出路径。

### 步骤

- [ ] **Step 1: 确认地基是绿的,并定位三处锚点**

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  期望 `Tests  22 passed (22)`(Task 4 的成品)。**不绿就先修 Task 4,不要在红的地基上继续。**

  然后打开 `packages/desktop/src/main/updater.ts`,记下三处锚点:(a) 模块作用域 `export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;` 那一行;(b) `createUpdaterService` 内部 `let installing = false;` 那一行;(c) `async function install()` 函数体,以及返回对象里的 `dispose`。后面每一步都只改这三处。

- [ ] **Step 2: 写失败测试 ——「shutdown 抛错也照装」**

  在 `updater.test.ts` 的 `describe("createUpdaterService:状态机")` 末尾(Task 4 Step 14 那三条 install 测试之后)追加:

  ```ts
  /**
   * §4.3: a failed teardown must not strand the user on an old build. The
   * update is already downloaded and sha512-verified at this point; refusing
   * to install it because OBS would not close cleanly trades a small risk for
   * a permanent one.
   */
  it("install():shutdown 抛错也照装,且 install() 自己不 reject", async () => {
    shutdown.mockImplementationOnce(() =>
      Promise.reject(new Error("obs teardown failed")),
    );
    backend.fire("update-downloaded", { version: "0.1.20" });
    await expect(svc.install()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(backend.calls).toContain("quitAndInstall:true:true");
  });
  ```

  用 `shutdown.mockImplementationOnce` 而不是新建一个 service:这个 describe 的 `shutdown` 就是 `vi.fn(() => Promise.resolve())`,改一次实现即可,`svc` / `backend` / `afterEach` 的清理全部照旧。

- [ ] **Step 3: 跑测试,确认它红**

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  期望 `Tests  1 failed | 22 passed (23)`,失败信息形如:

  ```
  AssertionError: promise rejected "Error: obs teardown failed" instead of resolving
  ```

  (vitest 版本不同措辞可能微调,关键是**这一条**红、其余 22 条绿。若报错变成 `expected [ … ] to include 'quitAndInstall:true:true'`,说明 Task 4 的 `await deps.shutdown()` 已经被谁包过 try/catch 了 —— 那就跳过 Step 4,直接进 Step 6。)

- [ ] **Step 4: 最小实现 —— 给 shutdown 包 try/catch**

  在 `updater.ts` 的 `install()` 里,把 Task 4 那行裸调:

  ```ts
  await deps.shutdown();
  ```

  换成:

  ```ts
  try {
    await deps.shutdown();
  } catch {
    // Best effort, same philosophy as quitLifecycle's own internal catches:
    // a failed teardown must not strand the user on an old build. The update
    // is downloaded and sha512-verified already — go install it.
  }
  ```

  **同时删掉紧贴它上方那段已经作废的注释**(Task 4 Step 15 落地的原文):

  ```ts
  // Deliberately NOT wrapped in try/catch yet: making a failed teardown
  // still install is the next task's first increment (spec §4.3), and
  // adding it here would turn that task's red step green.
  ```

  留着就是一条当场自相矛盾的注释(它说「还没包 try/catch」,而下一行就是 try/catch),
  和 Step 8(d) 那条「added in the next task」是同一类:本任务**就是**那个 “next task”。
  它上面讲 `deps.shutdown` = `quitLifecycle.shutdown` 的那段(`// installer detached and only then calls app.quit()` …)**保留**,那部分仍然成立。

  除此之外**只改这一处**,`install()` 的其余部分(ready 门、`installing` 闩锁、`quitAndInstall(true, true)`、外层的 try/catch)一个字不动。

- [ ] **Step 5: 跑测试确认绿 + commit**

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  期望 `Tests  23 passed (23)`。

  ```
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "fix(desktop): install() 清理失败也照装 —— shutdown reject 不再吞掉安装器"
  ```

- [ ] **Step 6: 写失败测试 —— 安装器未接管看门狗**

  追加进同一个 describe(紧接 Step 2 那条之后):

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
  it("install():安装器没接管(10s 后进程还活着)→ 落 error,且不会 spawn 第二个", async () => {
    backend.fire("update-downloaded", { version: "0.1.20" });
    await svc.install();
    expect(backend.calls).toContain("quitAndInstall:true:true");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.getState()).toEqual({
      phase: "error",
      message: "更新安装器未能接管,请手动退出 gladlog 后重新打开",
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

  这条不需要额外的 `vi.useFakeTimers()` / `svc.dispose()`:Task 4 的 `beforeEach` 已经开了假时钟,`afterEach` 已经 dispose + 还原真时钟。10 s 也远小于 `FIRST_CHECK_DELAY_MS`(30 s),推进时钟不会顺带触发首检。

- [ ] **Step 7: 跑测试,确认它红**

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  期望 `Tests  1 failed | 23 passed (24)`,失败信息:

  ```
  AssertionError: expected { phase: 'ready', version: '0.1.20' } to deeply equal { phase: 'error', message: '更新安装器未能接管,请手动退出 gladlog 后重新打开' }
  ```

- [ ] **Step 8: 实现看门狗**

  (a) 模块作用域,`export const CHECK_INTERVAL_MS = ...;` 那一行下面加:

  ```ts
  /** How long quitAndInstall gets to actually take the process down before we
   *  declare the handover failed. Deliberately NOT exported: the test asserts
   *  against the literal 10_000, so silently stretching this window fails CI. */
  const INSTALL_WATCHDOG_MS = 10_000;
  ```

  (b) `createUpdaterService` 内,`let installing = false;` 下面加:

  ```ts
  let installWatchdog: ReturnType<typeof setTimeout> | null = null;
  ```

  (c) `install()` 里,把 `backend.quitAndInstall(true, true);` 之后**紧贴着**、仍在同一个 `try` 块内插入(放在 try 内是刻意的:`quitAndInstall` 自己抛的话已经由 catch 落了 error 状态,不该再 arm 一个 10 s 后覆盖它的定时器):

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
      message: "更新安装器未能接管,请手动退出 gladlog 后重新打开",
    });
  }, INSTALL_WATCHDOG_MS);
  ```

  (d) 收尾 `install()` 函数体末尾那段 `// Known gap: when BaseUpdater.install() returns false …` 注释:若 Task 4 落地时已按审查清单 important-2 改写成「Handled by the install watchdog added in the next task…」,把 `added in the next task` 改成 `armed right above` —— 看门狗此刻已经在同一个函数体里了,再说「下一个任务会加」就成了假话,下一个读代码的人会去找一个不存在的后续改动;其余文字不动。若还是原始的 `// Known gap: … acceptable, because the alternative (forcing a quit from here) needs a quit dependency this service deliberately does not have.` 版本,把整段删掉 —— 它描述的缺口正是 (c) 补上的,留着就是一条自相矛盾的注释。

  (e) 返回对象的 `dispose` 首部加两行:

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

- [ ] **Step 9: 跑测试确认绿**

  ```
  npm test --workspace=packages/desktop -- src/main/updater.test.ts
  ```

  期望 `Tests  24 passed (24)`。

- [ ] **Step 10: 全量回归 + commit**

  ```
  npm test --workspace=packages/desktop
  ```

  基线是 **136 files / 938 tests passed**(2026-08-02 在本 worktree 实测)。按收尾清单 A 的计数口径表,跑到本任务收尾时累计应为 938 + 6(T1)+ 5(T2)+ 3(T3)+ 23(T4)+ **2(本任务)** = **977**。**报数只报本任务的净增量 +2**,总数以收尾清单 A 的表为准;当场输出对不上先查是不是哪个 Task 重复实现了,不要改那张表。

  ```
  git add packages/desktop/src/main/updater.ts packages/desktop/src/main/updater.test.ts
  git commit -m "feat(desktop): install() 看门狗 —— 安装器没接管时落 error,而不是留一个空壳 app"
  ```

---

## Task 6: IPC + preload + `main/index.ts` 接线(设计文档 §4.4 / §4.2 配置块 / §4.7 lastSeenVersion)

> 把 Task 4/5 的服务接到进程边界上:三个 `ipcMain.handle` + 一条 `webContents.send` 推送、preload 桥、主进程构造与 `autoUpdater.logger` 接线,外加 renderer 侧一个**对缺失 bridge 面免疫**的消费助手 —— 不做这层容错,Task 7 的组件会把既有测试打红(它们的 bridge 桩里没有 update 面)。
>
> **定时器不归本任务。** 30 s 首检 / 4 h 轮询由 `updater.ts` 的 `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` 单源持有,`createUpdaterService` 构造时自带 `setTimeout`/`setInterval`(Task 4 Step 12)。接线处**不许**再声明这两个常量、不许再建第二套定时器 —— 那会让每个节拍发两次 `checkForUpdates`,而且把同一个事实抄成两份字面量,正是 CLAUDE.md 头号红线。这里只负责在退出时 `dispose()`。
>
> 本任务不碰任何可见 UI,做完之后 `npm run dev` 里状态是 `disabled/dev`,界面一个像素都不变。

**Files:**

- Modify: `packages/desktop/src/main/ipc.ts` —— :21(`import type { RecorderService } from "./recorder";`)下面加 type import;:41(`recorder: RecorderService;`)下面给 `registerIpc` 的 deps 加一行;:147 之后插三个 handle
- Modify: `packages/desktop/src/preload/api.ts` —— :6 下面加 type import;:101(`app: { … };` 块的收尾 `};`)之后插 `update` 块
- Modify: `packages/desktop/src/preload/index.ts` —— :48-54 的 `app: { … },` 块之后插 `update` 块
- Modify: `packages/desktop/src/main/index.ts` —— :3 的 `import { join } from "path";` 加 `dirname`、:35 之后新增 `fs` 与 updater 的 import;:82 之后插接线块;:270-290 的 `registerIpc({ … })` deps 加一行;:290 的 `});` 之后、:291 的 `learning.init();` 之前插 `initUpdater()` 调用
- Create: `packages/desktop/src/renderer/src/update/updateBridge.ts`
- Test(Create): `packages/desktop/test/updateChannels.test.ts`(2 条)
- Test(Create): `packages/desktop/test/updateBridge.test.ts`(7 条)

（以上行号 2026-08-03 在本 worktree 逐条核过。**`fixtureBridge.ts` 不在清单里** —— 见「已知边界」第 2 条。)

**Interfaces:**

Consumes:

```ts
// Task 2 (quitLifecycle.ts)
shutdown(): Promise<void>;
// Task 3 (settingsStore.ts) —— GladlogSettings 上的两个新字段
autoCheckUpdates: boolean;      // DEFAULTS = true
lastSeenVersion: string | null; // DEFAULTS = null
// Task 4 (updater.ts)
export function evaluateGate(env: UpdaterEnv): GateResult;
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
export type UpdateState = ...; export interface UpdaterEnv { ... }
export const FIRST_CHECK_DELAY_MS; export const CHECK_INTERVAL_MS;
//   ↑ 检查节奏由 updater.ts 单源持有并自带定时器,接线处不许再建第二套。
//     本任务连 import 都不需要 import 它们。
// Task 5:install() 的看门狗 + shutdown 失败兜底
```

Produces(Task 7 的横幅与 Task 8 的设置页全靠这一层):

```ts
// IPC 频道(字符串常量,三处一致由 test/updateChannels.test.ts 钉死)
"gladlog:update:getState" | "gladlog:update:check" | "gladlog:update:install"
"gladlog:update:state"  // main → renderer 推送

// packages/desktop/src/preload/api.ts —— GladlogApi 新增一块
update: {
  getState(): Promise<UpdateState>;
  check(): Promise<void>;
  install(): Promise<void>;
  onState(cb: (s: UpdateState) => void): () => void;
};

// packages/desktop/src/renderer/src/update/updateBridge.ts —— 全部对缺失桩免疫
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateCheck(): Promise<void>;
export function requestUpdateInstall(): Promise<void>;
/** 桩/环境里到底有没有 update 面(Task 8 的设置页据此决定渲染「此环境不提供自动更新」) */
export function hasUpdateSurface(): boolean;
/** 本次启动的版本号 ≠ 上次记住的 → 返回当前版本号(§4.7 留痕);首启/同版 → null */
export function resolveVersionNotice(): Promise<string | null>;
/** 用户点掉留痕 → 写回 lastSeenVersion */
export function dismissVersionNotice(version: string): Promise<void>;
```

**§4.7 的留痕判据(取版本 / 比对 / null 时静默写回 / 点掉写回)只有 `resolveVersionNotice` + `dismissVersionNotice` 这一份实现。** Task 7 的 `UpdateBanner` 必须 `import` 它们,Task 8 的 `SettingsPanel` 必须用 `fetchUpdateState` / `subscribeUpdateState` / `requestUpdateCheck` / `hasUpdateSurface`,**不许**在组件里内联第二份比对逻辑或第二份 `surface()` 容错助手。

### 已知边界(执行时不许自作主张改掉)

1. **ipc 这一层没有任何测试覆盖。** `registerIpc` 定义在 `ipc.ts:32-50`,全仓唯一调用点是 `index.ts:270-290`,没有任何测试 import 它,`ipc.ts` 也没有 `.test.ts`。所以 Step 1 的频道测试只是**文本对账**(防止三个互不 import 的文件里的字符串字面量打错一个字母),update 面的行为正确性全靠 `updater.test.ts`,别指望 ipc 层有网。
2. **`fixtureBridge.ts` 刻意不加 `update` 面**,与 Task 7 **Step 20** 将要写进该文件 `lastSeenVersion` 上方的注释(“This file also has NO `update` surface on purpose …”)同步(审查清单 blocking-6 采纳方案 a / 全局裁决 6)。两个后果都是想要的:(a) fixture 预览与视觉基线下更新相关 UI 全不渲染,Task 7/8 的像素判据不变;(b) 没有 `lastCheckedAt` 可渲染,`settings.png` 不会随墙上时间漂。**typecheck 安全性已核实**:`fixtureBridge.ts:359` 是 `window.__gladlogFixture = gladlogMock as any;`,给 `GladlogApi` 加必填面不会打红它;而 `preload/index.ts:17` 的 `const api: GladlogApi = {` 没有 `as any`,**那一处必须补**(Step 7)—— Step 6 期望的两条红里,`preload/index.ts(17,7)` 那条就是它。全仓只有这一处是 `GladlogApi` 的强类型构造点(实测 `grep -rn ": GladlogApi" src/ test/ dev/ qa/` 只有 `bridge.ts:5` 的可选声明、`bridge.ts:9` 的返回类型、`preload/index.ts:17`、`api.ts:347` 的 `window.gladlog` 声明)。
3. **第二个 `before-quit` 监听是刻意的**,不是漏挂:`preventDefault()` 不阻止同一事件的其余监听器,而 `quitLifecycle` 的依赖形状是固定的,不要为 `dispose()` 给它新增依赖。(Task 4 交接说明第 4 条写的是「`quitLifecycle` 的 cleanup 是自然挂点」,结论相同、说法不同 —— 以本条为准,别去 `QuitLifecycleDeps` 里找不存在的挂点。)
4. **`evaluateGate` 在模块作用域求值,`GLADLOG_UPDATER_TEST_FEED` 非法时会抛**,而且抛在窗口创建之前。这是 §4.2.1 刻意要的(置位但值不合法时抛错而不是静默回落成生产 feed);dev / E2E 走不到(门序里 `!isPackaged → dev` 排在 testFeed 校验之前),打包用户不会置这个变量,只有「开发机上跑打包产物且变量写错」这一种情况会撞上 —— 那正是需要吵醒你的时候。

### 步骤

- [ ] **Step 1: 写失败的频道名一致性测试**

  IPC 频道名是三个互不 import 的文件共享的字符串字面量:打错一个字母 typecheck 全绿,只在运行时变成一个死按钮。照 `test/diagnosticLevel.test.ts:40-49` 的「读源码文本对账」先例写一条漂移守卫。新建 `packages/desktop/test/updateChannels.test.ts`:

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

  describe("自动更新 IPC 频道名三处一致(设计文档 §4.4)", () => {
    const ipc = read("src/main/ipc.ts");
    const mainIndex = read("src/main/index.ts");
    const preload = read("src/preload/index.ts");

    it("main 侧注册三个 handle、index 侧推送 state 并把日志接进 electron-log", () => {
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

    it("preload 把四个频道全部接出去", () => {
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

- [ ] **Step 2: 跑它,确认红**

  ```
  npm test --workspace=packages/desktop -- test/updateChannels.test.ts
  ```

  期望两条全红,第一条的信息形如:

  ```
  AssertionError: expected 'import { writeFile } from "node:fs/pr…' to contain 'ipcMain.handle("gladlog:update:getState"'
  ```

- [ ] **Step 3: `ipc.ts` —— deps 加 updater**

  在 `packages/desktop/src/main/ipc.ts:21`(`import type { RecorderService } from "./recorder";`)下面加:

  ```ts
  import type { UpdaterService } from "./updater";
  ```

  在 deps 对象类型里 `recorder: RecorderService;`(:41)下面加:

  ```ts
  /** Auto-update (§4.4). Only the three renderer-facing methods: the push
   *  channel is emitted by main/index.ts (which owns the window handle), same
   *  split as compare/analysis/learning. */
  updater: Pick<UpdaterService, "getState" | "check" | "install">;
  ```

- [ ] **Step 4: `ipc.ts` —— 三个 handle**

  在 `ipcMain.handle("gladlog:app:getVersion", () => app.getVersion());`(:147)下面插:

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

- [ ] **Step 5: `preload/api.ts` —— 类型面**

  在 `packages/desktop/src/preload/api.ts:6`(`import type { RecorderStatus } from "../main/recorder";`)下面加 —— **必须是 `import type`**,写成值导入会把 electron-updater 拖进 renderer bundle,CI 的 `Production bundle (electron-vite build)` 与视觉回归的 `build:ui` 会双双炸:

  ```ts
  import type { UpdateState } from "../main/updater";
  ```

  在 `app: { … };` 块闭合的 `};`(:101)下面插:

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

- [ ] **Step 6: 跑 typecheck,确认它红(两条)**

  ```
  npm run typecheck --workspace=packages/desktop
  ```

  期望**恰好两条**错误,分别对应还没接的两端:

  ```
  src/main/index.ts(270,5): error TS2345: Argument of type '{ recorder: RecorderService; store: MatchStore; ... }' is not assignable to parameter of type '{ ... updater: Pick<UpdaterService, "getState" | "check" | "install">; ... }'.
    Property 'updater' is missing in type '{ recorder: ...; }' but required in type '{ ...; updater: Pick<UpdaterService, "getState" | "check" | "install">; ... }'.
  src/preload/index.ts(17,7): error TS2741: Property 'update' is missing in type '{ logs: { ... }' but required in type 'GladlogApi'.
  ```

  (`index.ts:270` 是 `registerIpc({` —— Step 3 把 `updater` 加成了必填 deps;`preload/index.ts:17` 是 `const api: GladlogApi = {` —— Step 5 把 `update` 加成了必填面。两条行号 2026-08-03 实测。)

  **只有这两处红是正确的**:`fixtureBridge.ts:359` 的 `window.__gladlogFixture = gladlogMock as any;` 兜住了那份 mock(见「已知边界」第 2 条),其余 bridge 桩全是 `as unknown` / `as any` 强转。若还冒出别的文件,说明有人把某个桩改成了强类型,先看清楚再动。

- [ ] **Step 7: `preload/index.ts` —— 桥实现**

  在 `app: { … },` 块(:48-54)下面插:

  ```ts
    update: {
      getState: () => ipcRenderer.invoke("gladlog:update:getState"),
      check: () => ipcRenderer.invoke("gladlog:update:check"),
      install: () => ipcRenderer.invoke("gladlog:update:install"),
      onState: sub("gladlog:update:state"),
    },
  ```

- [ ] **Step 8: 跑 typecheck,确认只剩一条**

  ```
  npm run typecheck --workspace=packages/desktop
  ```

  期望 `src/preload/index.ts(17,7)` 那条消失,只剩 `src/main/index.ts(270,5)` 的 `Property 'updater' is missing` —— 证明 preload 的类型面与实现面已经对上。剩下这条由 Step 9-10 的接线消掉,不要在这里图省事往 `registerIpc` 塞一个假 updater。

- [ ] **Step 9: `main/index.ts` —— import 与模块作用域接线**

  改 :3 的 `import { join } from "path";` 为:

  ```ts
  import { dirname, join } from "path";
  ```

  在 :35(`import { e2eUserDataDir } from "./e2eEnv";`)下面加:

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

  在 `app.on("before-quit", (event) => quitLifecycle.onBeforeQuit(event));`(:82)下面插整块:

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
  // own 30s/4h timers plus any armed install watchdog — without it the 4h
  // setInterval keeps the process alive. This also cancels any armed install
  // watchdog — on the success path the process is going away anyway; the
  // failure path (BaseUpdater.install() returned false, so quitAndInstall never
  // called app.quit()) never reaches before-quit at all, which is exactly why
  // the watchdog still fires there.
  app.on("before-quit", () => {
    updaterService?.dispose();
  });
  ```

  `autoUpdater.logger = log` 一行的类型:electron-log 的 `MainLogger` 结构上满足 electron-updater 的 `Logger`(`info` / `warn` / `error` / `debug` 四个方法都在),正常应当直接过。若 Step 11 的 typecheck 在这一行报结构不匹配,写成

  ```ts
  autoUpdater.logger = log as unknown as typeof autoUpdater.logger;
  ```

  Step 1 的守卫断言匹配的是不带分号的 `"autoUpdater.logger = log"`,这种写法照样过。**不要**因为一行类型摩擦就把它删掉 —— 删了 §6.2 的证据通道就断了。

- [ ] **Step 10: `main/index.ts` —— whenReady 里接上**

  在 `registerIpc({` 的 deps 里(:270 起,`recorder,` 那一行下面)加:

  ```ts
      updater: updaterFacade,
  ```

  在 `registerIpc({ … });` 闭合的 `});`(:290)之后、`learning.init();`(:291)之前加:

  ```ts
  // Must come after registerIpc: pushUpdateState writes to win.webContents,
  // and win is created above in this same block.
  void initUpdater().catch((e) => log.error("[updater] init failed:", e));
  ```

- [ ] **Step 10b: 定时器单源自查(全局裁决 4 的守卫)** —— Run(worktree 根):

  ```bash
  grep -nE "setTimeout|setInterval|30_000|4 \* 60 \* 60|FIRST_CHECK_DELAY_MS|CHECK_INTERVAL_MS" packages/desktop/src/main/index.ts
  ```

  Expected:**无输出**(grep 退出码 1)。接线处一个定时器、一个节奏常量都不许有 —— 2026-08-03 实测本任务改动前该文件对这条 grep 零命中,所以任何一行命中都是本任务新引入的。命中就删掉:检查节奏由 `updater.ts` 的 `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` 单源持有、服务自带 timer,这里只在 `before-quit` 里 `dispose()`。

  **`updater.test.ts` 的定时器测试挡不住这一条**(它只看服务内部:接线处再建一套,那些测照样全绿,而真机上每个节拍会发两次 `checkForUpdates`,30s/4h 两个数字也变成了两份会静默漂移的字面量)。这条 grep 是全局裁决 4 唯一的自动化守卫,Task 4 Step 11 与 Task 4「给 Task 6 的交接说明」第 5 条都指着它,别跳过。

- [ ] **Step 11: 频道测试转绿 + typecheck 转绿 + commit**

  ```
  npm test --workspace=packages/desktop -- test/updateChannels.test.ts
  npm run typecheck --workspace=packages/desktop
  ```

  期望 `Tests  2 passed (2)`;typecheck 无输出、退出码 0(Step 6 的两条到这里全部消掉)。

  ```
  git add packages/desktop/src/main/ipc.ts packages/desktop/src/main/index.ts packages/desktop/src/preload/api.ts packages/desktop/src/preload/index.ts packages/desktop/test/updateChannels.test.ts
  git commit -m "feat(desktop): 自动更新 IPC/preload/主进程接线 —— 三 handle + state 推送 + electron-log 接管

  定时器归 updaterService 自己所有(updater.ts 的 FIRST_CHECK_DELAY_MS /
  CHECK_INTERVAL_MS 单源),接线处只在 before-quit 里 dispose,不建第二套。
  GLADLOG_UPDATER_TEST_FEED 直通:门序里 !isPackaged → dev 排在 testFeed 校验
  之前,dev/E2E 走不到校验,而 §6.2 的打包客户端需要它生效。"
  ```

- [ ] **Step 12: 写失败的 renderer 助手测试**

  新建 `packages/desktop/test/updateBridge.test.ts`:

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

  describe("updateBridge 对缺失 bridge 面免疫", () => {
    it("桩里没有 update 面时:读状态给 null,订阅给一个能调的退订,check/install 不抛", async () => {
      expect(hasUpdateSurface()).toBe(false);
      expect(await fetchUpdateState()).toBe(null);
      const off = subscribeUpdateState(() => {});
      expect(() => off()).not.toThrow();
      await expect(requestUpdateCheck()).resolves.toBeUndefined();
      await expect(requestUpdateInstall()).resolves.toBeUndefined();
    });

    it("桩里有 update 面时:透传状态、转发推送、退订能落到底层", async () => {
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

  describe("§4.7 更新留痕:lastSeenVersion 比对", () => {
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

    it("首次启动(lastSeenVersion=null)不报喜,静默记住当前版本", async () => {
      const saved = stubSettings(null);
      expect(await resolveVersionNotice()).toBe(null);
      expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
    });

    it("版本变了 → 返回当前版本,且此时不写回(等用户点掉才写)", async () => {
      const saved = stubSettings("0.1.19");
      expect(await resolveVersionNotice()).toBe("0.1.20");
      expect(saved).toEqual([]);
    });

    it("同版本 → null,不写回", async () => {
      const saved = stubSettings("0.1.20");
      expect(await resolveVersionNotice()).toBe(null);
      expect(saved).toEqual([]);
    });

    it("点掉留痕 → 写回 lastSeenVersion", async () => {
      const saved = stubSettings("0.1.19");
      await dismissVersionNotice("0.1.20");
      expect(saved).toEqual([{ lastSeenVersion: "0.1.20" }]);
    });

    it("桩里连 settings/app 面都没有 → null,不抛", async () => {
      expect(await resolveVersionNotice()).toBe(null);
      await expect(dismissVersionNotice("0.1.20")).resolves.toBeUndefined();
    });
  });
  ```

- [ ] **Step 13: 跑它,确认红**

  ```
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  期望:

  ```
  Error: Failed to load url ../src/renderer/src/update/updateBridge (resolved id: …) . Does the file exist?
  ```

- [ ] **Step 14: 写 renderer 助手**

  新建 `packages/desktop/src/renderer/src/update/updateBridge.ts`:

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
   *  page renders "此环境不提供自动更新" when it does not — which is the case
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

- [ ] **Step 15: 跑测试,确认绿**

  ```
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  期望 `Tests  7 passed (7)`。

- [ ] **Step 16: 全量回归 + 三件套**

  ```
  npm test --workspace=packages/desktop
  npm run typecheck
  npx eslint . --quiet
  ```

  期望:测试全绿。基线 **136 files / 938 tests passed**(2026-08-02 在本 worktree 实测);按收尾清单 A 的计数口径表,跑到本任务收尾时累计应为 938 + 6(T1)+ 5(T2)+ 3(T3)+ 23(T4)+ 2(T5)+ **9(本任务)** = **986**。本任务自己新增 2 个测试文件(`test/updateChannels.test.ts`、`test/updateBridge.test.ts`)。**报数只报本任务的净增量 +9**,总数以收尾清单 A 的表为准,当场输出对不上先查是不是哪个 Task 重复实现了。

  typecheck 与 eslint 均退出码 0。lint 必须在**仓库根**跑 `eslint .`(CI 是全仓扫描,只扫 `packages/desktop/src` 会漏掉 `test/`、`qa/`、`dev/`、`scripts/`,历史上连挂过三次)。

- [ ] **Step 17: commit**

  ```
  git add packages/desktop/src/renderer/src/update/updateBridge.ts packages/desktop/test/updateBridge.test.ts
  git commit -m "feat(desktop): 更新面 renderer 助手 —— §4.7 留痕判据单源 + 缺 update 面时降级为无更新信息"
  ```

- [ ] **Step 18: dev 冒烟(本任务的验收判据)**

  ```
  npm run dev --workspace=packages/desktop
  ```

  三条都要满足,缺一条就是没做完:

  1. 终端里出现 `[updater] disabled: dev`(mac 上先撞 platform 门还是先撞 dev 门取决于 Task 4 的判定顺序,`disabled: platform` 同样算过)
  2. 终端里**没有**任何 `electron-updater` 相关报错、没有 `unhandled rejection`
  3. 在渲染进程 DevTools 控制台里执行

     ```js
     await window.gladlog.update.getState();
     ```

     返回 `{ phase: "disabled", reason: "dev" }`(或 `"platform"`),而**不是** `undefined`、不是抛错

  界面此时应当与改动前逐像素一致(本任务不加任何可见元素,fixtureBridge 也没有 update 面)。

- [ ] **Step 19: 记录前后数字**

  在最终的 commit message 或 PR 描述里写清楚同判据下的数字,别只写「接好了」:

  - 既有测试:136 files / 938 tests → 本任务净增 **+9**(`updateChannels` 2 条 + `updateBridge` 7 条),全绿
  - 冷启动:`npm run test:e2e --workspace=packages/desktop` 里 `coldStart.spec.ts` 的中位数仍 < 2600 ms(`qa/budgets.ts:44`)。这条是本任务唯一可能踩到的预算 —— 非 win / 非 packaged 路径上 `electron-updater` 一个字节都没加载,数字理应不动;**若真涨了,说明 `await import` 被谁改成了顶层 import**

---

## Task 7: UpdateBanner 组件 + App 接线(spec §4.5 / §4.7)

**Files:**

- Create: `packages/desktop/src/renderer/src/components/UpdateBanner.tsx`
- Create: `packages/desktop/test/updateBanner.test.tsx`
- Modify: `packages/desktop/src/renderer/src/App.tsx`(:1-19 import 区;:180-193 `<header className="app-topbar">` 块 —— 已在真文件核过)
- Modify: `packages/desktop/src/renderer/src/styles.css`(在 :111 —— `.app-topbar h1::after` 规则块的收尾 `}` —— 之后、:112 那条长注释之前插入。**审查 minor-6 更正:原计划写的 :110/:111 差一,实测是 :111/:112**)
- Modify: `packages/desktop/src/renderer/src/fixtureBridge.ts`(`currentSettings` 字面量,当前 :34-47;Task 3 补完 `autoCheckUpdates` / `lastSeenVersion` 两行后是 :34-49,本任务只改其中 `lastSeenVersion` 一行)
- Test: `packages/desktop/test/updateBanner.test.tsx`(新建)
- 回归(**两张网**,都不改代码、只跑;2026-08-03 在真文件逐条核过):
  - `packages/desktop/test/app.backgroundload.test.tsx`(2 条)—— `render(<App />)` 在 :46,bridge 桩在 :33-45(`window.__gladlogFixture`),只有 `matches` / `logs` / `settings`,没有 `update` / `recorder` / `app`
  - `packages/desktop/src/renderer/src/App.pagination.test.tsx`(3 条)—— `render(<App />)` 在 :48 / :70 / :88,走的是 `vi.mock("./bridge")`(:7)模块级 mock + `mockReturnValue({ matches, logs, settings })`(:39-43);:60 那个用例的桩多给了一个 `app: { selectDirectory }`(:68)却**没有 `getVersion`**,正好压到 `resolveVersionNotice()` 里 `bridge().app.getVersion()` 同步抛的那条路径 —— 那是「连 `app` 面都没有」的第一张网覆盖不到的第二种失效形态
    两张网的桩形状不同,合起来对 UpdateBanner 的三条容错路径(`updateBridge` 内部 try/catch、`recorderSurface()`、`resolveVersionNotice()` 的 catch)同时施压。**全仓挂载 `<App/>` 的就这两个文件**(判据:`grep -rn "render(<App" packages/desktop/src packages/desktop/test`)。
    (`report.app.test.tsx` / `matchListRow.test.tsx` 核过**不**渲染 `<App />`:前者只渲染 `MatchReport` / `ShuffleReport`,后者只渲染行组件,都不挂载 `UpdateBanner`,对本任务没有回归意义,不列。)

**Interfaces:**

Consumes(均已在 spec 的共享契约里逐字固定,不要改名):

```ts
// packages/desktop/src/main/updater.ts —— 只准 `import type`,值导入会把
// electron-updater 拖进 renderer bundle,build:ui / 视觉回归 webServer 当场炸
export type UpdateState =
  | { phase: "disabled"; reason: "platform" | "dev" | "portable" }
  | { phase: "idle"; lastCheckedAt: number | null }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

// packages/desktop/src/renderer/src/update/updateBridge.ts —— Task 6 建的,
// 本组件唯一的更新面入口(全部对缺失桩免疫,内部 try/catch)
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateInstall(): Promise<void>;
/** 本次启动的版本号 ≠ 上次记住的 → 返回当前版本号(§4.7);首启/同版 → null */
export function resolveVersionNotice(): Promise<string | null>;
/** 用户点掉留痕 → 写回 lastSeenVersion */
export function dismissVersionNotice(version: string): Promise<void>;

// 既有、不改:
// packages/desktop/src/main/recorder.ts:37-42
export interface RecorderStatus {
  enabled: boolean;
  connected: boolean;
  recording: boolean;
  lastError: string | null;
}
// packages/desktop/src/preload/api.ts:319 —— recorder.onStatus(cb: (s: RecorderStatus) => void): () => void
//                    api.ts:294-295 —— recorder.getStatus(): Promise<RecorderStatus>
// packages/desktop/src/renderer/src/batch/batchAnalysis.ts:69/:73
export function getBatchStatus(): BatchStatus; // BatchStatus.running: boolean
export function subscribeBatch(cb: () => void): () => void;
// packages/desktop/src/preload/api.ts:94 —— app.openExternal(url: string): Promise<void>
```

Produces:

```tsx
// packages/desktop/src/renderer/src/components/UpdateBanner.tsx
export function UpdateBanner(): JSX.Element | null; // 无 props;自己订阅 update / recorder / batch
```

**四条必须写进代码注释、不许省的设计理由:**

1. **更新面与 §4.7 留痕逻辑一律走 `update/updateBridge.ts`,组件里不许有第二份**(审查 blocking-5 / important-4;全局裁决 7)。`getState` / `onState` / `install` 的容错、以及「取版本 → 比 `lastSeenVersion` → null 时静默写回 → 点掉写回」这整套判据,单源在 `updateBridge.ts`,并由 `test/updateBridge.test.ts` 钉死(Task 6 落地时 7 条,Task 8 再加 2 条)。组件只渲染答案。留在组件里的 bridge 直调只剩两处,都不是更新面:`app.openExternal`(纯 UI 导航,不是判据)与 `recorder`(updateBridge 不管录像),两者照样各自包 try/catch。
2. **忙判据不许新造(CLAUDE.md 谓词单源)。** 「正在录像」只认 `RecorderStatus.recording`(main 侧唯一事实源,经 `recorder.onStatus` 推送);「分析在飞」只认 `getBatchStatus().running`(批量/自动分析驱动的单例)。横幅**不许**自己数「有没有请求在跑」——那就是第二份会漂的谓词。
   **已知洞,写进注释而不是假装没有**:报告页 AI 视图的单场分析走 `report/components/StructuredAnalysisPanel.tsx:687` 的 `bridge().analysis.run(...)`,不经过 `batchAnalysis`,所以「用户手点一场分析」这一路漏判。不补的理由:main 侧只有 `analysis.getState(matchId).running`(按 matchId 查),没有全局 running 快照,现在造一个就是新开第二个谓词;代价有界——最坏情况是用户在单场分析途中点了重启,丢的是那一次分析结果(缓存没写成),对局数据一个字节不动。哪天 main 侧出了全局快照,这里直接换过去。
3. **横幅挂在 topbar 里,不做成 `.app-container` 的兄弟元素。** 兄弟横幅是 flex item,默认 `flex-shrink: 1` 会被 `.app-layout { flex: 1 }` 挤扁,得额外补 `flex: none`;而 `.app-container` 按 styles.css 里 `.app-container:has(.app-layout)` 上方那条注释铁律(:112-121)**不能**直接变 flex(战绩页 `.dash` 靠 `margin: 0 auto` 撑宽,父级变 flex 会当场缩窄)。留在 `.app-topbar`(:86-94 它自身已是 `display: flex`,且 :129-132 的既有 `:has` 规则已保证它 `flex: none`)里,「有 .app-layout」和「没有」两种视图都不用加新规则。
4. **`error` 只在「用户刚点过立即重启」时才渲染**(审查 minor-9)。§4.2 定的是 error 不打扰:检查/下载失败是常态,静默回 idle 即可。但 Task 5 的安装看门狗会把「`quitAndInstall` 之后 10 s 进程还活着」也落成 `error`,而那时 `shutdown()` 已经停了录像 / worker / AI 子进程 —— app 活着但功能全废,顶栏一片空白是最坏结果。判据用**本地事实**「本次会话点过安装」,**不是**去 `startsWith("更新安装器未能接管")` 匹配文案:那条文案的产地在 `src/main/updater.ts`,renderer 只能 `import type`,抄成字符串就是一份会静默腐烂的手抄谓词(main 改一版文案,横幅当场哑火且没有任何报错)。

**已知边界(写进计划,不假装没有):**

- 本任务在 fixture 下**不渲染任何东西**,因此**不动任何像素、不动视觉基线**。`fixtureBridge` 按全局裁决 6 **不加 `update` 面**(Task 6 原本要加的那一步已删),`updateBridge` 于是降级成「无更新信息」;Step 20 再把 `lastSeenVersion` 钉成 `"fixture"`,与 `fixtureBridge.ts:235-237` 的 `getVersion()`(返回 `"fixture"`)相等 → 留痕也不渲染。pixel 变化全部发生在 Task 8(设置页「关于」卡片)。
- 新增的可及名(`立即重启` / `稍后` / `新版 X 已就绪` / `已更新到 X · 更新内容` / `关闭更新提示`)与既有 e2e、单测的选择器串逐条比过,**无子串冲突**:`qa/e2e/coachLoop.spec.ts:51` 的「战绩」、`import.spec.ts:42` 的「导入历史日志…」/:55「回放」/:65「AI 分析」、`exportImage.spec.ts:50`,以及 settingsPanel 单测里的「保存」「清除」。注意 **Playwright 的 `getByRole` name 默认是子串匹配**(`import.spec.ts:55` 之所以写 `exact: true` 就是被这个咬过),以后加 topbar 文案时要重查这张表。
- `.upd-banner` 上的 `role="status"` 在 fixture 下永不渲染,不进 `qa/visual/scenes.spec.ts:88-99` 的 axe 扫描面;真机上 `status` 是 live region,允许交互子元素,不触发 wcag2a/2aa/21a/21aa 任何规则。

### 步骤

- [ ] **Step 1: 写第一批失败测试(三态渲染 + 稍后/小按钮 + 推送)**

  新建 `packages/desktop/test/updateBanner.test.tsx`:

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

  describe("UpdateBanner:三态渲染(spec §4.5)", () => {
    it("idle / checking / error / disabled → 什么都不渲染", async () => {
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

    it("downloading → 导航条一行细字,不出按钮", async () => {
      mockBridge({
        state: { phase: "downloading", version: "0.1.20", percent: 37.4 },
      });
      render(<UpdateBanner />);
      expect(await screen.findByText("正在下载 0.1.20 · 37%")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("ready → 横幅 + 立即重启调 install 一次", async () => {
      const { install } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
      });
      render(<UpdateBanner />);
      expect(await screen.findByText("新版 0.1.20 已就绪")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
      expect(install).toHaveBeenCalledTimes(1);
    });

    it("稍后 → 横幅收起、退化成常驻小按钮;点小按钮横幅回来", async () => {
      mockBridge({ state: { phase: "ready", version: "0.1.20" } });
      render(<UpdateBanner />);
      fireEvent.click(await screen.findByRole("button", { name: "稍后" }));
      expect(screen.queryByRole("button", { name: "立即重启" })).toBeNull();
      const chip = screen.getByRole("button", { name: "新版 0.1.20 已就绪" });
      fireEvent.click(chip);
      expect(screen.getByRole("button", { name: "立即重启" })).toBeTruthy();
    });

    it("挂载后收到推送 → 从空到横幅(重开窗口/切页面晚于事件也不丢)", async () => {
      const { emit } = mockBridge({ state: { phase: "checking" } });
      const { container } = render(<UpdateBanner />);
      await act(async () => {});
      expect(container.textContent).toBe("");
      emit({ phase: "ready", version: "0.1.21" });
      expect(screen.getByText("新版 0.1.21 已就绪")).toBeTruthy();
    });

    it("桩没有 update 面 → 不崩、不渲染", async () => {
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

- [ ] **Step 2: 跑测试确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Error: Failed to load url ../src/renderer/src/components/UpdateBanner (resolved id: …). Does the file exist?`,`Test Files  1 failed (1)`。

- [ ] **Step 3: 写 UpdateBanner 最小实现(只到三态 + 稍后)**

  新建 `packages/desktop/src/renderer/src/components/UpdateBanner.tsx`:

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
   * banner that degrades into a small always-there button after "稍后".
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
            正在下载 {state.version} · {Math.round(state.percent)}%
          </span>
        </div>
      );
    }
    if (state?.phase === "ready") {
      return (
        <div className="upd-slot">
          {dismissed ? (
            <button className="upd-chip" onClick={() => setDismissed(false)}>
              新版 {state.version} 已就绪
            </button>
          ) : (
            <span className="upd-banner" role="status">
              <span>新版 {state.version} 已就绪</span>
              <button
                className="upd-primary"
                onClick={() => void requestUpdateInstall()}
              >
                立即重启
              </button>
              <button onClick={() => setDismissed(true)}>稍后</button>
            </span>
          )}
        </div>
      );
    }
    return null;
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Test Files  1 passed (1)` / `Tests  6 passed (6)`。

- [ ] **Step 5: commit**

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): 更新提示组件三态渲染 —— downloading 细字 / ready 横幅 + 稍后退化成小按钮"
  ```

- [ ] **Step 6: 写忙判据的失败测试**

  在 `test/updateBanner.test.tsx` 末尾追加:

  ```tsx
  describe("UpdateBanner:忙时禁用重启(spec §4.5,判据不新造)", () => {
    it("正在录像 → 立即重启禁用 + 换文案,点不动 install", async () => {
      const { install } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
        recording: true,
      });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "立即重启" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("正在录制,退出时会自动更新")).toBeTruthy();
      fireEvent.click(btn);
      expect(install).not.toHaveBeenCalled();
    });

    it("录像状态推送变化 → 停录后立即重启恢复可用", async () => {
      const { emitRecording } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
        recording: true,
      });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "立即重启" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      emitRecording(false);
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    it("批量分析在飞 → 立即重启禁用 + 换文案;跑完自动恢复", async () => {
      mockBridge({ state: { phase: "ready", version: "0.1.20" } });
      render(<UpdateBanner />);
      const btn = await screen.findByRole("button", { name: "立即重启" });
      setBatchRunning(true);
      expect((btn as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("正在分析,退出时会自动更新")).toBeTruthy();
      setBatchRunning(false);
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
  });
  ```

- [ ] **Step 7: 跑测试确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  3 failed | 6 passed (9)`,失败信息形如 `expected false to be true`(按钮没被禁用)与 `Unable to find an element with the text: 正在录制,退出时会自动更新`。

- [ ] **Step 8: 实现忙判据**

  把 `UpdateBanner.tsx` 的 import 区整体换成(新增三行:`GladlogApi` 类型、batch 两个函数、`bridge`;顺序按 simple-import-sort):

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

  插入 recorder 的容错取面助手 —— 位置在 Step 3 那条 `/** The type-only import … */` 说明之后、组件那段 `/** Update indicator in the top bar … */` JSDoc **之前**(别插进 JSDoc 和 `export function UpdateBanner()` 中间,那会把文档注释和函数拆散):

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

  在 `const [dismissed, setDismissed] = useState(false);` 之后插入:

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
    ? "正在录制,退出时会自动更新"
    : analyzing
      ? "正在分析,退出时会自动更新"
      : null;
  ```

  再把 ready 分支里的「立即重启」按钮及其后一行改成:

  ```tsx
              <button
                className="upd-primary"
                disabled={busyReason != null}
                onClick={() => void requestUpdateInstall()}
              >
                立即重启
              </button>
              <button onClick={() => setDismissed(true)}>稍后</button>
              {busyReason && <span className="upd-note">{busyReason}</span>}
  ```

- [ ] **Step 9: 跑测试确认通过 + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  9 passed (9)`。

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): 录像/分析在飞时禁用立即重启 —— 忙判据复用 RecorderStatus.recording 与 getBatchStatus().running"
  ```

- [ ] **Step 10: 写更新后留痕的失败测试(spec §4.7)**

  在 `test/updateBanner.test.tsx` 末尾追加。四条断言与 `updateBridge.resolveVersionNotice` 的三分支语义逐条对应 —— 本组件只负责把答案渲染出来:

  ```tsx
  describe("UpdateBanner:更新后留痕(spec §4.7,判据在 updateBridge)", () => {
    it("版本与 lastSeenVersion 不等 → 显示留痕;点开跳 release 页并写回", async () => {
      const { openExternal, save } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: "0.1.20",
      });
      render(<UpdateBanner />);
      const link = await screen.findByRole("button", {
        name: "已更新到 0.1.21 · 更新内容",
      });
      fireEvent.click(link);
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/mingjianliu/gladlog/releases/tag/v0.1.21",
      );
      expect(save).toHaveBeenCalledWith({ lastSeenVersion: "0.1.21" });
      expect(
        screen.queryByRole("button", { name: "已更新到 0.1.21 · 更新内容" }),
      ).toBeNull();
    });

    it("关掉留痕也写回 lastSeenVersion", async () => {
      const { save, openExternal } = mockBridge({
        state: { phase: "idle", lastCheckedAt: null },
        version: "0.1.21",
        lastSeenVersion: "0.1.20",
      });
      render(<UpdateBanner />);
      fireEvent.click(
        await screen.findByRole("button", { name: "关闭更新提示" }),
      );
      expect(save).toHaveBeenCalledWith({ lastSeenVersion: "0.1.21" });
      expect(openExternal).not.toHaveBeenCalled();
    });

    it("lastSeenVersion 为 null(首次安装/旧版升上来)→ 静默写回,不显示留痕", async () => {
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

    it("版本与 lastSeenVersion 相同 → 不渲染、不写盘", async () => {
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

- [ ] **Step 11: 跑测试确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  3 failed | 10 passed (13)`,失败信息形如 `Unable to find an accessible element with the role "button" and name "已更新到 0.1.21 · 更新内容"`,以及第三条的 `expected "spy" to be called with arguments: [ { lastSeenVersion: '0.1.21' } ]`(组件还没调 `resolveVersionNotice`,所以 null 分支的静默写回也没发生)。第 4 条「相同版本」会先天通过,因为现在压根不渲染留痕 —— 这条是防回归的锚。

- [ ] **Step 12: 实现更新后留痕(消费 updateBridge,不内联判据)**

  `UpdateBanner.tsx` 的 `../update/updateBridge` import 补两个名字(按字母序):

  ```tsx
  import {
    dismissVersionNotice,
    fetchUpdateState,
    requestUpdateInstall,
    resolveVersionNotice,
    subscribeUpdateState,
  } from "../update/updateBridge";
  ```

  在 import 之后、Step 8 加的 `recorderSurface` 之前加常量:

  ```tsx
  const RELEASE_TAG_URL =
    "https://github.com/mingjianliu/gladlog/releases/tag/v";
  ```

  在组件内 `busyReason` 之前插入:

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

  用下面这段整体替换 `if (state?.phase === "downloading") { … } … return null;` —— 先算出留痕片段,再与三态拼一起:

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
        已更新到 {updatedTo} · 更新内容
      </button>
      <button
        className="upd-x"
        aria-label="关闭更新提示"
        onClick={clearUpdatedTo}
      >
        ✕
      </button>
    </span>
  );

  const live =
    state?.phase === "downloading" ? (
      <span className="upd-line">
        正在下载 {state.version} · {Math.round(state.percent)}%
      </span>
    ) : state?.phase === "ready" ? (
      dismissed ? (
        <button className="upd-chip" onClick={() => setDismissed(false)}>
          新版 {state.version} 已就绪
        </button>
      ) : (
        <span className="upd-banner" role="status">
          <span>新版 {state.version} 已就绪</span>
          <button
            className="upd-primary"
            disabled={busyReason != null}
            onClick={() => void requestUpdateInstall()}
          >
            立即重启
          </button>
          <button onClick={() => setDismissed(true)}>稍后</button>
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

- [ ] **Step 13: 跑测试确认通过 + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  13 passed (13)`。

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): 更新后留痕接进导航条 —— 判据单源在 updateBridge.resolveVersionNotice,组件只渲染"
  ```

- [ ] **Step 14: 写「安装失败必须可见」的失败测试(审查 minor-9)**

  在 `test/updateBanner.test.tsx` 末尾追加:

  ```tsx
  describe("UpdateBanner:唯一要打扰用户的 error(安装看门狗)", () => {
    it("点过立即重启之后落 error → 顶栏显示原因", async () => {
      const { emit } = mockBridge({
        state: { phase: "ready", version: "0.1.20" },
      });
      render(<UpdateBanner />);
      fireEvent.click(await screen.findByRole("button", { name: "立即重启" }));
      emit({
        phase: "error",
        message: "更新安装器未能接管,请手动退出 gladlog 后重新打开",
      });
      // 判据是「本次会话点过安装」,不是匹配文案:换一条 message 也照样显示
      expect(
        screen.getByText("更新安装器未能接管,请手动退出 gladlog 后重新打开"),
      ).toBeTruthy();
    });
  });
  ```

  (「没点过重启的普通 error 不渲染」已由 Step 1 第一条的四态循环覆盖,不重复写。)

- [ ] **Step 15: 跑测试确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  1 failed | 13 passed (14)`,失败信息 `Unable to find an element with the text: 更新安装器未能接管,请手动退出 gladlog 后重新打开`。

- [ ] **Step 16: 实现 —— 点过安装之后的 error 分支**

  在 `const [updatedTo, setUpdatedTo] = useState<string | null>(null);` 之前插入:

  ```tsx
  const [installRequested, setInstallRequested] = useState(false);
  ```

  把「立即重启」的 onClick 改成:

  ```tsx
              onClick={() => {
                setInstallRequested(true);
                void requestUpdateInstall();
              }}
  ```

  把 `live` 三元链的收尾两行 —— 即

  ```tsx
        )
      ) : null;
  ```

  —— 改成(在 ready 分支和 `: null` 之间多一段):

  ```tsx
        )
      ) : state?.phase === "error" && installRequested ? (
        // §4.2 says errors must not nag, and check/download failures indeed
        // render nothing. This is the one exception: after the user pressed
        // 立即重启, quitLifecycle.shutdown() has already stopped the recorder,
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

- [ ] **Step 17: 跑测试确认通过 + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBanner.test.tsx
  ```

  期望:`Tests  14 passed (14)`。

  ```bash
  git add packages/desktop/src/renderer/src/components/UpdateBanner.tsx packages/desktop/test/updateBanner.test.tsx
  git commit -m "feat(desktop): 安装未接管时顶栏必须可见 —— 判据是本次会话点过重启,不匹配 main 侧文案"
  ```

- [ ] **Step 18: App.tsx 接线**

  `packages/desktop/src/renderer/src/App.tsx` 的 import 区(:1-19)加一行,插在 `import { StatsDashboard } from "./components/StatsDashboard";`(:5)之后:

  ```tsx
  import { UpdateBanner } from "./components/UpdateBanner";
  ```

  把 :180-193 的 header 改成(唯一改动是 `</div>` 之后多一行 `<UpdateBanner />`):

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

- [ ] **Step 19: 加样式**

  `packages/desktop/src/renderer/src/styles.css`,在 :111(`.app-topbar h1::after` 规则块的收尾 `}`)之后、:112 的长注释之前插入。**注释里只引选择器名不引行号** —— 插入本身会把下方所有行号推移:

  ```css
  /* 更新提示位:挂在 topbar 右端,不做成 .app-container 的兄弟横幅。
   *
   * 兄弟横幅是 flex item,默认 flex-shrink:1 会被 .app-layout(flex:1)挤扁,
   * 得额外补 flex:none;而下面 `.app-container:has(.app-layout)` 上方那条铁律
   * 又规定 .app-container 不能直接变 flex(战绩页 .dash 靠 margin:0 auto 撑宽,
   * 父级变 flex 会当场缩窄)。留在 .app-topbar 里(它自身已是 flex,且既有的
   * `.app-container:has(.app-layout) > .app-topbar` 规则已给它 flex:none),
   * 「有 .app-layout」与「没有」两种视图都不需要新规则。 */
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

- [ ] **Step 20: 钉死 fixture 的版本留痕(视觉基线确定性)**

  `packages/desktop/src/renderer/src/fixtureBridge.ts` 的 `currentSettings`(Task 3 补完两个字段后是 :34-49)里,把 `lastSeenVersion: null,` 一行改成:

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

  **与 Task 6 已同步**:按全局裁决 6(= 审查 blocking-6 的方案 a),Task 6 里「给 fixtureBridge 加 update 面」的那一步已删,两边不再打架。
  推论:`fixtureBridge` 没有 `update` 面 → `fetchUpdateState()` 返回 `null` → 三态全不渲染;`lastSeenVersion === getVersion()` → 留痕也不渲染。**结论:本任务不改任何像素,视觉基线不动**,pixel 变化在 Task 8。

- [ ] **Step 21: 回归既有 App 测试(证明缺面的桩不崩)**

  ```bash
  npm test --workspace=packages/desktop -- test/app.backgroundload.test.tsx src/renderer/src/App.pagination.test.tsx
  ```

  期望:`Test Files  2 passed (2)` / `Tests  5 passed (5)`(2 + 3,2026-08-03 实测改动前即为此值)。

  **这两个是全仓仅有的挂载 `<App/>` 的测试**(判据 `grep -rn "render(<App" packages/desktop/src packages/desktop/test`,命中 4 行:`test/app.backgroundload.test.tsx:46`、`src/renderer/src/App.pagination.test.tsx:48/:70/:88`),而且两者的桩形状**不同**、各覆盖一类缺面:
  - `app.backgroundload.test.tsx` 的桩(:33-45,`window.__gladlogFixture`)只有 `matches` / `logs` / `settings` —— 连 `app` 面都没有,压的是 `bridge().app` 为 undefined 那条路
  - `App.pagination.test.tsx` 走 `vi.mock("./bridge")`(:7)+ `mockReturnValue`(:39-43),其中 :60 那个用例给了 `app: { selectDirectory }`(:68)却**没有 `getVersion`** —— 压的是「有 `app` 面但方法缺失」那条路,`resolveVersionNotice()` 里 `bridge().app.getVersion()` 会同步抛

  UpdateBanner 的三条容错路径(`updateBridge` 的 try/catch、`recorderSurface()`、`resolveVersionNotice()` 的 catch)在这两张网下同时受检。

- [ ] **Step 22: 全量 + 类型 + lint**

  ```bash
  npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet
  ```

  期望:vitest 全绿;`typecheck` 六个 workspace 无 `error TS`;eslint 无输出。
  (lint 必须跑 `eslint .` 全仓,只扫 `packages/desktop/src` 会漏掉 `test/` —— 已经连挂过三次。)

- [ ] **Step 23: 视觉冒烟(只证明渲染不崩,不比图不写图)**

  ```bash
  npm run test:visual:smoke --workspace=packages/desktop
  ```

  期望:全部场景 passed。**绝不能跑 `npm run test:visual`** —— 它会在本机(mac)往缺图的位置写基线,污染 linux 单源基线(见 `qa/playwright.config.ts:1-6` 的顶部注释)。

- [ ] **Step 24: commit**

  ```bash
  git add packages/desktop/src/renderer/src/App.tsx packages/desktop/src/renderer/src/styles.css packages/desktop/src/renderer/src/fixtureBridge.ts
  git commit -m "feat(desktop): 更新提示接进导航条 —— topbar 右端挂件 + fixture 版本钉死保基线确定性"
  ```

---

## Task 8: SettingsPanel「关于」小节(spec §4.6)

**Files:**

- Modify: `packages/desktop/src/renderer/src/update/updateBridge.ts` —— `hasUpdateSurface()` 已由 Task 6 随该文件一并落地,**正常路径下本任务不改它的实现**,只补两条契约测试(详见 Step 1 的归属说明)
- Modify: `packages/desktop/test/updateBridge.test.ts` —— 追加 2 条
- Modify: `packages/desktop/src/renderer/src/components/SettingsPanel.tsx`
  - :1-17(import 区)+ :19(`type SettingsGroup`)
  - :36-39(组件顶部 state 段的末尾,`const [saved, setSaved] = useState<…>(null);`)
  - :79-81(在 `if (!settings) return …`(:81)之前追加两个 effect —— hooks 必须在早返回之前)
  - :101-108(`groupHead` 定义之后、:110 `return (` 之前追加两个派生值)
  - :508-509(在最后一个 `</section>`(:508)之后、`</div>`(:509)之前插入新 section)
- Modify: `packages/desktop/test/settingsPanel.test.tsx`(:8-28 `mockBridge` 扩容;:2 的 import 补 `act`;文件末尾追加一个 describe)
- Test: `packages/desktop/test/settingsPanel.test.tsx`、`packages/desktop/test/updateBridge.test.ts`
- Modify(基线,**走 CI 生成**):`packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png`

(以上行号已在真文件逐条核对:`SettingsPanel.tsx` 共 511 行,`</section>` 在 :508、`</div>` 在 :509;`type SettingsGroup` 在 :19;`if (!settings) return` 在 :81;`groupHead` 在 :101-108。)

**Interfaces:**

Consumes:

```ts
// packages/desktop/src/main/settingsStore.ts —— GladlogSettings 新增字段(Task 3)
//   autoCheckUpdates: boolean;    DEFAULTS 里为 true
// packages/desktop/src/main/updater.ts
export type UpdateState = /* 见 Task 7 的 Consumes,逐字相同;只准 import type */;
// packages/desktop/src/renderer/src/update/updateBridge.ts(Task 6)
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void;
export function fetchUpdateState(): Promise<UpdateState | null>;
export function requestUpdateCheck(): Promise<void>;
// 既有:bridge().app.getVersion(): Promise<string>(preload/api.ts:92)
//       save(partial, note, group) —— SettingsPanel.tsx:83-92 的内部助手
```

Produces:

```ts
// packages/desktop/src/renderer/src/update/updateBridge.ts —— 实现来自 Task 6,
// 本任务只补两条契约测试(Task 6 若漏了,才由本任务 Step 3 补上实现)
export function hasUpdateSurface(): boolean;
```

其余无新导出(全部落在 `SettingsPanel` 内部);对外可见的只有 DOM 契约:按钮可及名 `检查更新` / `检查中…`,开关 `aria-label="自动检查更新"`。

**必须写进代码注释的三条理由:**

1. **「检查更新」按钮不受「自动检查更新」开关影响**(spec §4.2 末段)。关掉自动检查的用户仍需要一个手动入口,否则那个开关等于把整个功能关死。禁用条件只有两个:正在 `checking`,或这台机器压根没有 update 面。
2. **上次检查时间用相对时间**(`刚刚 / N 分钟前 / N 小时前 / N 天前`),不用 `toLocaleString()`:视觉基线用 `page.clock.setFixedTime`(`qa/visual/scenes.spec.ts:62`,值见 `dev/fixtures/fixedNow.ts`)钉住了 `Date.now()`,但没钉时区/locale,绝对时间会随环境漂;相对时间只依赖被钉住的 `Date.now()`。
3. **「有没有更新面」用 `hasUpdateSurface()` 同步判定,不用「异步取回来是不是 null」**。设置页要在第一帧就给出正确文案:异步判定会让首帧显示占位、随后翻转,而 `settings.png` 是本仓唯一会截到这块 UI 的基线 —— 一个依赖微任务时序的首帧就是一颗定时炸弹。判定本身仍单源在 `updateBridge`(和 `fetchUpdateState` 同一个 `bridge().update` 读法),不在组件里重写第二份。

**已知边界:**

- fixture 下(`fixtureBridge` 无 `update` 面,按全局裁决 6)`hasUpdateSurface()` 恒为 false → 「关于」卡片显示「此环境不提供自动更新」且**不出**「检查更新」按钮;版本显示 `fixture`(`fixtureBridge.ts:235-237`);`autoCheckUpdates` 默认 true → 开关按钮显示「停用」。**这三条就是 Step 18 审图的全部判据。**
- 开关按钮沿用「自动分析新对局」的同款形态(`SettingsPanel.tsx:336-346`:`aria-label` 固定可及名 + 可见文案 启用/停用)。这个形态在现有 `settings` 基线下已经通过 `qa/visual/scenes.spec.ts:88-99` 的 wcag2a/2aa/21a/21aa 扫描,**照抄即可,别自创新形态**,否则可能撞上 `label-content-name-mismatch`。
- RTL 的 `getByRole(name: "检查更新")` 是**精确**匹配,不会撞上「自动检查更新」;但 **Playwright 的 `getByRole` name 默认是子串匹配** —— 以后若给设置页写 e2e,查「检查更新」必须带 `exact: true`(先例:`qa/e2e/import.spec.ts:55`)。
- `settings` 场景只在默认 `visual` project 跑:`visual-1440` / `visual-1920` 的 grep 是 `/(report-battle|dashboard|video|dev) /`(`qa/playwright.config.ts:85` 与 :95),所以 19 张基线里**只有 `settings.png` 一张**需要更新。
- **设置页那句「启动 30 秒后检查一次,之后每 4 小时一次」(Step 12)是散文,不是谓词**:它与 `updater.ts` 的 `FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS` 没有任何代码关联,改常量必须**手动**同改三处 —— 这句 UI 文案 + `CHANGELOG.md` + `CHANGELOG.zh-CN.md`(Task 10 的双语条目里也写了这两个数字)。刻意不做成模板插值:renderer 只能 `import type` `main/updater`,值导入会把 electron-updater 拖进 renderer bundle(`build:ui` 与视觉回归当场炸)。代价是三份散文会漂且漂了没有任何报错,收益是 bundle 干净 —— **改这两个常量的人请从这条起**。

### 步骤

- [ ] **Step 1: 写 `hasUpdateSurface()` 的契约测试**

  归属说明:`hasUpdateSurface()` 已列在 Task 6 的 Produces 里、并随 `updateBridge.ts` 一并落地,**本任务默认只补它的两条契约测试**。开工前确认一次:

  ```bash
  grep -n "hasUpdateSurface" packages/desktop/src/renderer/src/update/updateBridge.ts
  ```

  **有输出 = 正常路径**:签名必须逐字是 `export function hasUpdateSurface(): boolean`,**函数体也必须是 `typeof bridge().update?.getState === "function"`** —— 是 `bridge().update != null` 之类的别的写法就按兜底路径(Step 3)改回来:两种写法对 `{ update: {} }` 这类半截桩给相反答案,而下面两条契约测试对两种写法都绿,测不出来。签名与函数体都对,Step 2 会直接绿,跳过 Step 3 直接进 Step 4 —— 测试照补,这两条断言正是它的契约。
  **无输出 = 兜底路径**(Task 6 执行时被漏掉):按 Step 2 → Step 3 的红→绿顺序把实现补上。

  在 `packages/desktop/test/updateBridge.test.ts` 末尾追加:

  ```ts
  describe("hasUpdateSurface:同步判定这台机器有没有更新面", () => {
    it("桩里没有 update 面 → false,不抛", () => {
      installStub({});
      expect(hasUpdateSurface()).toBe(false);
    });

    it("桩里有 update 面 → true", () => {
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

  并把该文件顶部的 import 补上这个名字(按字母序插在 `fetchUpdateState` 之后):

  ```ts
    hasUpdateSurface,
  ```

- [ ] **Step 2: 跑它确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  期望(正常路径,Task 6 已落地实现):`Tests  9 passed (9)` —— 两条新测试直接绿,跳过 Step 3 进 Step 4。
  期望(兜底路径):`Tests  2 failed | 7 passed (9)`,失败信息 `TypeError: hasUpdateSurface is not a function`;此时按 Step 3 补实现。
  (已实测:本仓 vite 5.4.21 / vitest 2.1.9 的 SSR transform **不校验** importedNames,缺失的具名导出解析成 `undefined` 而不是抛 `does not provide an export named` —— 所以红在调用点,不在 import 点。)

- [ ] **Step 3: 实现 `hasUpdateSurface()`(兜底路径 —— Step 2 红了、或 Step 1 查出函数体写法与 Task 6 不一致时才做)**

  **逐字照抄 Task 6 Step 14 的那一份,一个字都不许改**(不是「等价写法」)—— 上面两条契约测试(空桩 → false / 完整桩 → true)对 `bridge().update != null` 这种写法**同样是绿的**,两种写法只在 `{ update: {} }` 这类半截桩上给出相反答案,漂移在这里测不出来。同一个事实两份手抄正是 CLAUDE.md 头号红线。

  在 `packages/desktop/src/renderer/src/update/updateBridge.ts` 的 `resolveVersionNotice` 之前插入(与 Task 6 Step 14 的落点一致):

  ```ts
  /** Whether this environment exposes the update surface at all. The settings
   *  page renders "此环境不提供自动更新" when it does not — which is the case
   *  under the fixture preview and in every component test stub. */
  export function hasUpdateSurface(): boolean {
    try {
      return typeof bridge().update?.getState === "function";
    } catch {
      return false;
    }
  }
  ```

- [ ] **Step 4: 跑测试确认通过 + commit**

  ```bash
  npm test --workspace=packages/desktop -- test/updateBridge.test.ts
  ```

  期望:`Tests  9 passed (9)`。

  ```bash
  git add packages/desktop/src/renderer/src/update/updateBridge.ts packages/desktop/test/updateBridge.test.ts
  # 正常路径(实现来自 Task 6,本任务只加了两条测试;git add 源码文件是空操作):
  git commit -m "test(desktop): hasUpdateSurface 契约测试 —— 设置页首帧就要能判定有没有更新面"
  # 兜底路径(走过 Step 3 补了实现)改用这条:
  # git commit -m "feat(desktop): updateBridge 补同步的 hasUpdateSurface —— 设置页首帧就要能判定有没有更新面"
  ```

- [ ] **Step 5: 扩容既有 mockBridge(为新测试铺路,不改既有断言)**

  `packages/desktop/test/settingsPanel.test.tsx` 的首行 import(:2)改成(补 `act`):

  ```tsx
  import { act, fireEvent, render, screen } from "@testing-library/react";
  ```

  在 :6 的 import 之后补一行:

  ```tsx
  import type { UpdateState } from "../src/main/updater";
  ```

  把 :8-28 的 `mockBridge` 整体替换为:

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

- [ ] **Step 6: 跑既有 4 条确认没被扩容打红**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  期望:`Tests  4 passed (4)`(仅扩容,行为未变)。

- [ ] **Step 7: 写「关于」小节的失败测试**

  在 `test/settingsPanel.test.tsx` 末尾追加:

  ```tsx
  describe("设置页「关于」(spec §4.6)", () => {
    it("显示当前版本号", async () => {
      mockBridge();
      render(<SettingsPanel />);
      expect(await screen.findByText("9.9.9")).toBeTruthy();
    });

    it("自动检查更新默认开 → 按钮显示停用,点击写回 false", async () => {
      const { save } = mockBridge();
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "自动检查更新" });
      expect(btn.textContent).toBe("停用");
      fireEvent.click(btn);
      expect(save).toHaveBeenCalledWith({ autoCheckUpdates: false });
    });

    // 本小节的重点:开关只管定时检查,不许连手动入口一起关死
    it("自动检查关掉时,「检查更新」按钮仍可用且真的调 check", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({ autoCheckUpdates: false }, { update: u.update });
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "检查更新" });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(btn);
      expect(u.check).toHaveBeenCalledTimes(1);
    });

    it("checking → 按钮禁用并显示检查中…", async () => {
      const u = mockUpdate({ phase: "checking" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      const btn = await screen.findByRole("button", { name: "检查中…" });
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });

    it("手动查完回到 idle → 显示已是最新 + 相对时间", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));
      u.emit({ phase: "idle", lastCheckedAt: Date.now() - 5 * 60_000 });
      expect(screen.getByText("已是最新 · 上次检查:5 分钟前")).toBeTruthy();
    });

    it("从未检查 → 显示从未检查", async () => {
      const u = mockUpdate({ phase: "idle", lastCheckedAt: null });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(await screen.findByText("从未检查")).toBeTruthy();
    });

    it("error → 就地显示失败原因,不弹窗", async () => {
      const u = mockUpdate({ phase: "error", message: "net::ERR_TIMED_OUT" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(
        await screen.findByText("检查失败:net::ERR_TIMED_OUT"),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    });

    it("disabled(绿色版)→ 说明为什么不更新,且不出检查按钮", async () => {
      const u = mockUpdate({ phase: "disabled", reason: "portable" });
      mockBridge({}, { update: u.update });
      render(<SettingsPanel />);
      expect(
        await screen.findByText("绿色版(zip)不自动更新,请改用安装版"),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    });

    it("桩没有 update 面 → 版本号照显、说明为什么,不出检查按钮、不崩", async () => {
      mockBridge();
      render(<SettingsPanel />);
      expect(await screen.findByText("9.9.9")).toBeTruthy();
      expect(screen.getByText("此环境不提供自动更新")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    });
  });
  ```

- [ ] **Step 8: 跑测试确认失败**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  期望:`Tests  9 failed | 4 passed (13)`,首条失败信息形如 `Unable to find an element with the text: 9.9.9`。

- [ ] **Step 9: 实现 —— 类型与 import**

  `SettingsPanel.tsx` :19 改成:

  ```tsx
  type SettingsGroup = "game" | "ai" | "recording" | "about";
  ```

  import 区(:1-17)追加两处,位置按 simple-import-sort:

  ```tsx
  // 插在 :3 的 settingsStore 那行之后("main/settingsStore" < "main/updater")
  import type { UpdateState } from "../../../main/updater";
  // 插在 :16 的 `import { bridge } from "../bridge";` 之后、:17 的 ImportButton 之前
  import {
    fetchUpdateState,
    hasUpdateSurface,
    requestUpdateCheck,
    subscribeUpdateState,
  } from "../update/updateBridge";
  ```

  (`UpdateState` 必须是 `import type` —— 值导入会把 electron-updater 拖进 renderer bundle。**不要**为此 import `GladlogApi`:更新面的取法全在 `updateBridge` 里,组件不再自己 cast。)

- [ ] **Step 10: 实现 —— 两个纯函数**

  在 `SettingsPanel.tsx` 的 `export function SettingsPanel()`(:27)之前插入:

  ```tsx
  /** Relative wall-clock text. Deliberately NOT toLocaleString(): the visual
   *  baseline pins Date.now() (qa/visual/scenes.spec.ts:62 page.clock
   *  .setFixedTime) but pins neither the timezone nor the locale, so an absolute
   *  timestamp would drift between environments while a relative one only
   *  depends on the pinned clock. */
  function relTime(at: number, now: number): string {
    const d = Math.max(0, now - at);
    if (d < 60_000) return "刚刚";
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
    return `${Math.floor(d / 86_400_000)} 天前`;
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
          ? "仅 Windows 安装版支持自动更新"
          : s.reason === "portable"
            ? "绿色版(zip)不自动更新,请改用安装版"
            : "开发模式不检查更新";
      case "checking":
        return "正在检查…";
      case "downloading":
        return `正在下载 ${s.version} · ${Math.round(s.percent)}%`;
      case "ready":
        return `新版 ${s.version} 已就绪,退出时安装`;
      case "error":
        return `检查失败:${s.message}`;
      case "idle":
        return s.lastCheckedAt == null
          ? "从未检查"
          : `${checkedOnce ? "已是最新 · " : ""}上次检查:${relTime(s.lastCheckedAt, now)}`;
    }
  }
  ```

- [ ] **Step 11: 实现 —— state 与 effect**

  在 :36-39 的 state 声明段末尾(`const [saved, setSaved] = useState<…>(null);` 那个块的 `} | null>(null);` 之后)追加:

  ```tsx
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checkedOnce, setCheckedOnce] = useState(false);
  ```

  在 :62-79 那个 `useEffect`(CLI 自动检测)的收尾 `}, [backend, cmdSaved]);`(:79)之后、:81 `if (!settings) return …` 之前插入(**必须在早返回之前** —— hooks 规则):

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

- [ ] **Step 12: 实现 —— 渲染「关于」小节**

  在早返回之后、`return (`(:110)之前,即 `groupHead` 定义(:101-108)那段之后追加:

  ```tsx
  const updateAvailable = hasUpdateSurface();
  const updateNote = !updateAvailable
    ? "此环境不提供自动更新"
    : update == null
      ? "…"
      : describeUpdate(update, checkedOnce, Date.now());
  ```

  在 :508 最后一个 `</section>` 之后、:509 `</div>` 之前插入:

  ```tsx
  <section className="dash-card">
    {groupHead("关于", "about")}
    <div className="settings-grid">
      <span className="settings-k">版本</span>
      <span className="settings-v">{version ?? "…"}</span>
      <span />

      <span className="settings-k">更新</span>
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
            {update?.phase === "checking" ? "检查中…" : "检查更新"}
          </button>
        )}
      </span>

      <span className="settings-k">自动检查更新</span>
      <span className="settings-v">
        启动 30 秒后检查一次,之后每 4 小时一次;下载在后台进行,退出时安装。
      </span>
      <span className="settings-actions">
        <button
          aria-label="自动检查更新"
          onClick={() =>
            void save(
              { autoCheckUpdates: !settings.autoCheckUpdates },
              settings.autoCheckUpdates ? "已停用自动检查" : "已启用自动检查",
              "about",
            )
          }
        >
          {settings.autoCheckUpdates ? "停用" : "启用"}
        </button>
      </span>
    </div>
  </section>
  ```

  注:开关按钮的可及名由 `aria-label` 固定成「自动检查更新」,可见文案是 启用/停用 —— 与既有「自动分析新对局」(`SettingsPanel.tsx:336-346`)逐字同款,别自创。

- [ ] **Step 13: 跑测试确认通过**

  ```bash
  npm test --workspace=packages/desktop -- test/settingsPanel.test.tsx
  ```

  期望:`Tests  13 passed (13)`(既有 4 + 新增 9)。

- [ ] **Step 14: 类型 + lint + 全量**

  ```bash
  npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet
  ```

  期望:vitest 全绿;`typecheck` 无 `error TS`(若 `describeUpdate` 的 switch 漏了某个 phase,这里会以「函数缺少结束 return 语句」报红 —— 这正是 exhaustive switch 的用处);eslint 无输出。

- [ ] **Step 15: commit**

  ```bash
  git add packages/desktop/src/renderer/src/components/SettingsPanel.tsx packages/desktop/test/settingsPanel.test.tsx
  git commit -m "feat(desktop): 设置页关于小节 —— 版本号 / 手动检查更新 / 自动检查开关(手动入口不受开关影响)"
  ```

- [ ] **Step 16: 本机视觉冒烟(只证明不崩)**

  ```bash
  npm run test:visual:smoke --workspace=packages/desktop
  ```

  期望:全部场景 passed(`--ignore-snapshots`,既不比图也不写图)。
  **绝不能跑 `npm run test:visual`** —— 那会把 mac 渲染的图写进 linux 单源基线(`qa/playwright.config.ts:1-6`)。这是基线重生成四步流程(spec §8 末尾)的第 1 步。

- [ ] **Step 17: 推分支并在 CI 生成基线(四步流程第 2 步)**

  ```bash
  git push -u origin worktree-auto-update
  gh workflow run visual-baseline.yml --ref worktree-auto-update
  ```

  期望:`gh` 回 `✓ Created workflow_dispatch event for visual-baseline.yml at worktree-auto-update`。
  (该 workflow 是 `workflow_dispatch`,**只能从默认分支触发** —— 文件本身已在 main 上(`10a7d47`),所以 `--ref` 指别的分支可用。它跑的是 `npm -w @gladlog/desktop run test:visual -- --update-snapshots`,产物以 `visual-baselines` 名字上传整个 `packages/desktop/qa/__screenshots__/`。)

- [ ] **Step 18: 取回基线产物并审图(四步流程第 3 步)**

  ```bash
  gh run list --workflow=visual-baseline.yml --limit 1
  gh run download <上一步拿到的 run-id> -n visual-baselines -D /tmp/gladlog-baselines
  ls /tmp/gladlog-baselines/scenes.spec.ts/
  ```

  期望 `ls` 出 19 张 PNG。人工比对 `/tmp/gladlog-baselines/scenes.spec.ts/settings.png` 与仓库里的 `packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png`:

  **唯一应有的差异是设置页底部多出「关于」卡片**,且卡片内容必须逐条对上(判据来自「已知边界」第一条):

  1. 版本一行显示 `fixture`
  2. 更新一行显示「此环境不提供自动更新」,右侧**没有**任何按钮
  3. 自动检查更新一行右侧按钮显示「停用」

  其它 18 张(matchlist / dashboard / dev / report-\* / video 及三档 1440/1920)必须**逐字节不变** —— fixtureBridge 没有 update 面且 `lastSeenVersion === getVersion()`,Task 7 的挂件在 fixture 下不渲染任何东西。
  若第 2 条实际显示的是「从未检查」+ 一枚「检查更新」按钮,说明有人往 `fixtureBridge` 补了 `update` 面(全局裁决 6 已否决这件事),**先回去删掉那一步,不要改判据也不要直接覆盖**。
  若别的图也变了,两种可能按顺序排查:(a) fixtureBridge 被改出了非确定性(墙上时间、随机、版本号);(b) CI 镜像 / chromium 版本自上次生成基线以来变过,导致全局重绘。是 (b) 就把全部 19 张一起覆盖并在 commit message 里写明「CI 镜像变更导致整体重绘」;**在没排清之前不要覆盖**。

- [ ] **Step 19: 覆盖基线并提交(四步流程第 4 步)**

  ```bash
  cp /tmp/gladlog-baselines/scenes.spec.ts/settings.png \
     packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png
  git add packages/desktop/qa/__screenshots__/scenes.spec.ts/settings.png
  git commit -m "test(desktop): 更新 settings 视觉基线 —— 设置页新增「关于」小节(CI linux 单源生成,已人工审图)"
  ```

  (只需覆盖这一张:`settings` 场景不在 `visual-1440` / `visual-1920` 的 grep 里,见「已知边界」末条。)

- [ ] **Step 20: 收尾核对 —— 给出前后数字**

  ```bash
  npm test --workspace=packages/desktop 2>&1 | tail -5
  git log --oneline -8
  ```

  **计数口径**(全局裁决 2:基线是 **136 files / 938 tests passed**,2026-08-02 在本 worktree 实测;计划里凡是写 138/964 的都已作废):

  - Task 7 与 Task 8 的净增量:**Task 7 +14**(新建 `test/updateBanner.test.tsx`,files +1)、**Task 8 +11**(`test/updateBridge.test.ts` +2、`test/settingsPanel.test.tsx` +9,files +0)= **+25**
  - 前序 Task 的增量与全计划合计以文末「收尾清单 A」的计数表为准;**本步只报这两个任务的增量**,总数一律以上面那条命令的当场输出为准,不要照抄任何写死的总数

  在收尾说明里写清同判据的前后数字(CLAUDE.md 的验证规矩),形如:
  「desktop 单测 `Tests 938 passed` → `Tests <当场输出> passed`,其中 Task 7/8 贡献 +25(14 条 UpdateBanner + 2 条 hasUpdateSurface + 9 条 SettingsPanel 关于);视觉基线 19 张 → 19 张,变更 1 张(settings.png,CI linux 单源生成并人工审过);`typecheck` 的 `error TS` 计数 0 → 0;`eslint .` 输出 0 行 → 0 行。真机 Windows 的自动更新链路本机无法验,按 spec §6.3 只能等 0.1.21 —— 这一条**给不出数字,明说给不出**。」

---

## Task 9: dummy release 端到端验证(spec §6.2)

**这不是单元测试。** 这是一次一次性的、手工执行的真实端到端验证:真打包、真发 GitHub
Release、真跑 HTTP 下载。它是本设计里唯一能证明「feed 解析 + 选版逻辑 + prerelease 跳过 +
sha512 + 状态机流转」这条链真的通的手段,约覆盖八成风险面。

跑完之后仓库里**不留任何代码改动**(只往 spec 写两处文字:追加一段实测结果、更正 §6.2
里「只推一个 README commit」那句)。

用户已批准建这个丢弃用的公开仓库。

**Files:**

**Create(全部在 scratchpad,不进 git):**

- `/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/` —— 工作目录
- `…/scratchpad/updtest/repo/` —— dummy 仓库的本地 clone
- `…/scratchpad/updtest/keep/0.0.1/`、`…/keep/0.0.2-beta.1/`、`…/keep/0.0.3/` —— 三个版本的产物暂存
- `…/scratchpad/updtest/userdata/` —— 被测 app 的隔离 userData
- `…/scratchpad/updtest/verify/` —— 从 Release 下回来的 `latest-mac.yml`

**Modify(临时改、跑完必须还原):**

- `packages/desktop/package.json:3` —— `"version"` 字段(实测 :3 就是 `"version": "0.1.19"`),
  三次改三次还原(Step 13 用 `git checkout` 兜底,`git status` 必须干净)

**Modify(唯一的永久改动,都在 Step 14):**

- `docs/superpowers/specs/2026-08-02-auto-update-design.md:286` —— §6.2 那句「只推一个
  README commit」改成「每个版本各推一个真 commit」
- `docs/superpowers/specs/2026-08-02-auto-update-design.md` —— 在 §6.2 末尾(「**不覆盖**」
  那个列表之后、`## 7 已知缺口与风险` 之前)追加 `#### 6.2.1 实测结果` 小节

**Test:** 无。本任务不写 vitest;它验证的是 vitest 摸不到的那一层(真网络、真
electron-updater、真 GitHub API)。单测那半边在 Task 4(`updater.test.ts`)。

**Interfaces:**

**Consumes(全部来自 Task 4,签名逐字使用):**

```ts
// Task 4 —— packages/desktop/src/main/updater.ts
export function evaluateGate(env: UpdaterEnv): GateResult;
export function createUpdaterService(deps: UpdaterDeps): UpdaterService;
//   本任务依赖 evaluateGate 的行为:env.testFeed 置位("owner/repo" 形式)时,
//   跳过 platform 门与 portable 门,返回 { ok: true, feed: { owner, repo } };
//   app.isPackaged 那道门不跳。
//   本任务依赖 UpdateState 的六个 phase 逐字不变:
//   disabled / idle / checking / downloading / ready / error
```

- **Task 1(§3.1 / §3.2)**:`packages/desktop/package.json` 的 `build.publish` 已经是
  `{ "provider": "github", "owner": "mingjianliu", "repo": "gladlog" }`,`build.nsis.artifactName`
  已经是 `"${productName}.Setup.${version}.${ext}"`(点号,§3.2)。本任务用 CLI
  `-c.publish.*` 覆盖 publish,**不改文件**;`artifactName` 只作用于 NSIS target,
  mac 打包完全不受影响(mac 产物名本来就满足 `/^[0-9A-Za-z._-]+$/`)。
- **Task 6(§4.2 接线)**:`autoUpdater.logger = electronLog` 已写在 initUpdater 里;
  `updaterEnv.testFeed` 直通 `process.env["GLADLOG_UPDATER_TEST_FEED"]`。这两条是本任务
  能不能跑的前提,Step 1 各有一条 grep 自查。
- **Task 7/8(§4.5 / §4.6 UI)**:设置页「关于」小节有「检查更新」按钮(不受
  `autoCheckUpdates` 开关影响),顶栏在 downloading / ready 时有可见文案。没有它们
  这个任务只能靠日志观察,能跑但证据弱一档。

**硬约束 —— 必须在 Task 6 接线时满足,否则本任务无法隔离数据:**

`updaterEnv.testFeed` 必须**直通** `process.env["GLADLOG_UPDATER_TEST_FEED"]`,**不许**加
`GLADLOG_E2E` 判断。理由是门序:`evaluateGate` 把 `!isPackaged → dev` 排在 testFeed 校验
之前,所以开发机 shell 里残留的变量在未打包运行下压根走不到校验,E2E 不会被它炸;而本任务
的被测 app 是**打包产物**,要靠 `GLADLOG_E2E=1` + `GLADLOG_E2E_USER_DATA` 把 userData 挪到
临时目录,同时还要 test feed 生效 —— 两个逃生口必须能叠。

Step 1 有一条显式 grep。**不成立就回 Task 6 把它改成直通再回来**,不许在本任务里绕(尤其
不许去备份/还原用户真实的 `~/Library/Application Support/gladlog/settings.json` —— 那个
兜底方案已按裁决删除,拿真数据目录冒险不值)。

**Produces:** 无后续任务消费。产出是写进 spec §6.2.1 的一份实测记录
(版本号 + 状态序列 + 时间戳),以及「收尾清单」里那几条能不能划掉的依据。

### 执行前提

- 本机是 Apple Silicon Mac(产物名带 `arm64`)。`uname -m` 应为 `arm64`。
- `gh` 已登录(`gh --version` → 2.93.0 实测可用)。删仓库需要 `delete_repo` scope,
  没有的话 Step 15 会失败 —— 提前 `gh auth refresh -h github.com -s delete_repo`。
- Task 1–8 已全部完成并在当前 worktree 分支上,`npm test --workspace=packages/desktop` 绿。
- worktree 必须有**自己的** `node_modules`,否则 `electron-vite build` 的模块解析会爬到主
  checkout(那是另一个分支的源码),打出来的包不是你要验的那份。Step 1 有检查。
- 每次 electron-builder 打包 3–6 分钟。**Bash 调用必须显式 `timeout: 600000`**,
  否则 120 s 默认超时会把它甩到后台、看起来像卡住。
- 后面所有命令里的两个路径:
  - 仓库 = `/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update`
  - 暂存 = `/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest`

  shell 变量在 Bash 调用之间不保留,所以下面每条命令都写全绝对路径。**也不要用 `cd A && B` 这种复合命令**:代理线程每次 Bash 调用都会重置 cwd,而复合 `cd` 还会触发权限提示。需要在别的目录里跑 git 就用 `git -C <路径> ...`;需要在某个 workspace 里跑 npm 脚本就用 `npm run <脚本> --workspace=packages/desktop`(`npm run` 自己会把 cwd 切到那个 workspace)。

- **执行者划分(本任务是全计划唯一需要人的任务)**:Step 1–9(建仓、三次打包、发 release、服务端侧校验)与 Step 13–16(还原版本号、写 spec、清理、交报告)是纯 Bash,agent 可全自动跑。**Step 10–12 需要一个人坐在这台 mac 前看 GUI**:被测 app 是一个 Electron 窗口,「设置 → 关于 → 点检查更新」和顶栏文案的观察没有任何命令行替代。agent 跑完 Step 9 后**必须停下来,把 Step 10 的启动命令、Step 11 的观察表和 Step 12 的判据清单原样交给用户**,拿到用户回填的观察值再继续 Step 13。**绝不允许**为了「跑通」而跳过 Step 10–12 直接进 Step 13 —— 那样这个任务什么都没验,还白建了一个公开仓库。

- **中途放弃的清理**:只要 Step 2 跑过,无论后面停在哪一步(包括停下来等人观察 GUI 而人一时不在),都必须先执行 **Step 13**(还原 `packages/desktop/package.json` 的版本号)与 **Step 15**(`gh repo delete` + `rm -rf`),再报告停在哪。**公开仓库和被改脏的版本号不许过夜。**

### 步骤

- [ ] **Step 1: 建暂存目录、确认前提(含两条决定成败的 grep)**

```bash
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/{keep,userdata,verify}
uname -m
gh auth status
ls -d /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/node_modules
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update status --porcelain
grep -n "autoUpdater.logger" /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/src/main/index.ts
grep -n "GLADLOG_UPDATER_TEST_FEED" /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/src/main/index.ts
```

期望:

1. `arm64`
2. `gh auth status` 显示已登录 mingjianliu
3. `node_modules` 存在(不存在就先在 worktree 根 `npm install`)
4. `git status --porcelain` 空(有未提交改动就先 commit,否则 Step 13 的 `git checkout`
   会连带抹掉别的东西)
5. **第一条 grep 非空** —— Task 6 的 initUpdater 里有 `autoUpdater.logger = log;`。
   为空就先补上再开始:`AppUpdater.js:179` 默认 `this._logger = console`,不设的话
   `Checking for update` / `Found version 0.0.3` 永远不进 `~/Library/Logs/gladlog/main.log`,
   而那是 Step 11 的头号证据通道,判据 ① 的第一条打勾项直接没得看。
6. **第二条 grep 打印的那行不含 `GLADLOG_E2E`** —— 即 `testFeed: process.env["GLADLOG_UPDATER_TEST_FEED"],`
   直通。含 `GLADLOG_E2E` 三元表达式的话,Step 10 100% 落到 `disabled`;回 Task 6 改直通,
   别在这里绕。

- [ ] **Step 2: 建 dummy 仓库并推第一个 commit**

```bash
gh repo create mingjianliu/gladlog-update-test --public --add-readme \
  --description "Throwaway repo for gladlog auto-update e2e verification. Delete after use."
git clone https://github.com/mingjianliu/gladlog-update-test.git \
  /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/repo
```

期望:`gh repo create` 打印新仓库 URL;clone 出一个只有 `README.md` 的目录。

> **为什么后面每个版本还要各推一个 commit:** electron-updater 在
> `allowPrerelease = false` 时走 `GitHubProvider.js:93` 的 `getLatestTagName()`
> (定义在 `:158`,打 GitHub 的 `/releases/latest`),而 GitHub 对 "latest" 的定义是
> 「最近的非 draft 非 prerelease release,按底层 git commit 的 `created_at` 排序」。
> 三个 tag 指向同一个 commit → `created_at` 完全相同 → 排序并列 → 选中谁不受控,
> 「跳到 0.0.3 而不是 0.0.1」这条判据可能假通过也可能假失败。
> (spec §6.2 原文写的「只推一个 README commit」是错的,Step 14 顺手改掉。)

- [ ] **Step 3: 打 0.0.2-beta.1(第一个打,因为 dist-app 会被后面的构建覆盖)**

```bash
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.2-beta.1";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
```

(Bash `timeout: 600000`;从 worktree 根跑,**不要写 `cd ... && ...`** —— `npm run --workspace=` 自己会把 cwd 切到那个 workspace,而复合 `cd` 会触发权限提示。)

期望:结尾 `building        target=macOS zip` / `target=DMG`,退出码 0。

参数逐个的理由:

| 参数                         | 理由                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--publish never`            | 显式关掉隐式发布。`PublishManager.js:64` 的 `isPublish` 在 `publish === "never"` 时为 false,而 `app-update.yml`(写在 `onAfterPack` 里,`PublishManager.js:75-91`,落笔那行是 `:89`)与 `latest-mac.yml`(`:158-163` 的 `createUpdateInfoTasks`,条件里只有 `event.isWriteUpdateInfo` / target 判定)两处写文件**都在 isPublish 判断之外**,所以关掉发布不影响产物。不加这个参数的话,`ci-info` 检测到 CI 环境会触发隐式 `onTagOrDraft`。 |
| `-c.publish.owner/repo`      | 覆盖 package.json 里指向正式仓库的 publish 配置。它影响的是打进 app 的 `app-update.yml`(`PublishManager.js:89` 写进 `<app>.app/Contents/Resources/`),不影响 `latest-mac.yml` 的内容(那里面只有版本/文件名/sha512)。**保留它的真实理由是安全兜底**:即使 Step 10 的环境变量没生效,这份被测 app 也绝不可能去问正式仓库要更新。                                                                                                      |
| `-c.publish.provider=github` | 三个键一起给,让 `deepAssign` 后的 publish 对象里没有正式仓库的残留字段。                                                                                                                                                                                                                                                                                                                                                         |

- [ ] **Step 4: 验证 CLI 覆盖真的生效了(不验就等于没覆盖)**

**先探路径,再断言 —— 不要硬编码。** 产物目录名由 electron-builder 的**默认值**决定:
`packages/desktop/package.json` 的 `build` 字段**没有 `mac` 小节**(实测只有 appId /
productName / electronVersion / directories / afterSign / extraResources / win / nsis),
target 与 arch 全走默认。Apple Silicon 上通常是 `dist-app/mac-arm64/gladlog.app`
(`.app` 名来自 `build.productName` = `gladlog`),但这只是「通常」,真打一次才知道:

```bash
ls -d /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/mac*/
find /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app -maxdepth 5 -name app-update.yml
cat "$(find /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app -maxdepth 5 -name app-update.yml | head -1)"
```

**把 `find` 打印出来的那条真实路径记下来,Step 10 起 app 时要用它**(把其中的
`/Contents/Resources/app-update.yml` 换成 `/Contents/MacOS/gladlog`)。

期望输出含:

```
provider: github
owner: mingjianliu
repo: gladlog-update-test
updaterCacheDirName: gladlog-updater
```

出现 `repo: gladlog` 就说明 `-c.publish.*` 语法没被 electron-builder 吃进去,**停下来**,
先解决语法再继续 —— 不然后面全在验错东西。

`updaterCacheDirName` 那行也要在:它由 `PublishManager.js:193-200` 的
`getAppUpdatePublishConfiguration` 塞进同一份 yml(值 = `appInfo.js:126-128` 的
`sanitizedName.toLowerCase() + "-updater"`),`AppUpdater.js:545` 下载时会读它,缺了会打
error 日志(`:548`)。

- [ ] **Step 5: 把 0.0.2-beta.1 的产物挪去暂存**

```bash
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.dmg \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.zip \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.blockmap \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1/
ls -1 /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1/
```

期望列出:`gladlog-0.0.2-beta.1-arm64.dmg`、`gladlog-0.0.2-beta.1-arm64-mac.zip`、
对应的 `.blockmap`(1–2 个)、`latest-mac.yml`。

**注意 `latest-mac.yml` 是逐个文件名列出来的,不是 `*.yml` 通配。** `dist-app/` 里可能还有一份
`builder-effective-config.yaml`(`app-builder-lib/out/packager.js:298-301`,只在
`!isCI && process.stdout.isTTY` 时写 —— 代理 shell 非 TTY 时可能压根没有这份文件,
但人工在终端里跑就会有),内含本机绝对路径与完整配置,**绝不能传上公开 Release**。
同一个坑在 `.github/workflows/build.yml` 的 glob 里也要守住(见收尾清单 B.1 最后一条)。

- [ ] **Step 6: 打 0.0.3,同样挪走**

```bash
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.3";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.dmg \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.zip \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.blockmap \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3/
```

(Bash `timeout: 600000`)

期望:`keep/0.0.3/` 里是 `gladlog-0.0.3-arm64.dmg` / `gladlog-0.0.3-arm64-mac.zip` /
`.blockmap` / `latest-mac.yml`。

- [ ] **Step 7: 最后打 0.0.1 —— 顺序是故意的**

```bash
node -e 'const p="/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json";const fs=require("fs");const j=JSON.parse(fs.readFileSync(p,"utf8"));j.version="0.0.1";fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");'
npm run package:mac --workspace=packages/desktop -- --publish never -c.publish.provider=github -c.publish.owner=mingjianliu -c.publish.repo=gladlog-update-test
mkdir -p /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1
cp /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.dmg \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.zip \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/*.blockmap \
   /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/latest-mac.yml \
   /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1/
```

(Bash `timeout: 600000`)

**0.0.1 放最后打**,是为了让 `dist-app/mac-arm64/gladlog.app` 原地就是 0.0.1 那份 —— 后面
Step 10 直接跑它,省掉「把 .app bundle 拷到别处」这一步。ad-hoc 签名的 .app 用 `cp -R`
拷贝会掉扩展属性、`codesign -v` 可能报废,`ditto` 才对;干脆不拷。

`.dmg` / `.zip` / `.yml` / `.blockmap` 是普通文件,`cp` 没问题。

- [ ] **Step 8: 三个 release 按 0.0.1 → 0.0.2-beta.1 → 0.0.3 顺序创建,每个各带一个真 commit**

```bash
REPO=/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/repo

echo "v0.0.1" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.1" && git -C "$REPO" push
gh release create v0.0.1 --repo mingjianliu/gladlog-update-test --title v0.0.1 --notes "baseline for auto-update e2e" /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.1/*

echo "v0.0.2-beta.1" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.2-beta.1" && git -C "$REPO" push
gh release create v0.0.2-beta.1 --repo mingjianliu/gladlog-update-test --prerelease --title v0.0.2-beta.1 --notes "prerelease, MUST be skipped" /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.2-beta.1/*

echo "v0.0.3" >> "$REPO/versions.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -m "v0.0.3" && git -C "$REPO" push
gh release create v0.0.3 --repo mingjianliu/gladlog-update-test --title v0.0.3 --notes "stable, client should land here" /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3/*
```

(`$REPO` 只在**这一次** Bash 调用内有效 —— shell 状态不跨调用保留;上面整块要么一次跑完,要么把 `$REPO` 换成绝对路径。用 `git -C` 而不是 `cd A && git ...`。)

期望:三条 `gh release create` 各打印一个 release URL。tag 名必须**逐字**是
`v0.0.1` / `v0.0.2-beta.1` / `v0.0.3` —— electron-updater 拼 `latest-mac.yml` 的下载 URL 时
直接用 tag(`GitHubProvider.js:118` 的 `getBaseDownloadPath(String(tag), channelFile)`),
产物 URL 也走同一个函数(`:181` 的 `resolveFiles`),tag 写错就 404。

`--prerelease` 只加在中间那条。

- [ ] **Step 9: 发请求前先把服务端状态验一遍(三条判据里的两条在这一步就能定生死)**

```bash
gh api repos/mingjianliu/gladlog-update-test/releases/latest -q .tag_name
gh release download v0.0.3 --repo mingjianliu/gladlog-update-test --pattern latest-mac.yml --dir /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/verify --clobber
cat /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/verify/latest-mac.yml
gh release view v0.0.3 --repo mingjianliu/gladlog-update-test --json assets -q '.assets[].name'
```

期望:

1. 第一条输出**逐字** `v0.0.3`。输出 `v0.0.1` 说明 commit 顺序没起效;输出
   `v0.0.2-beta.1` 说明 `--prerelease` 没打上 —— 两种都要修完重来。
2. `latest-mac.yml` 里 `version: 0.0.3`,`files[0].url` = `gladlog-0.0.3-arm64-mac.zip`,
   有 `sha512:` 字段。
3. 第四条列出的资产名里,**必须逐字符包含** `latest-mac.yml` 里写的那个 url。
   这一条是 §3.2 那条头号坑的 mac 侧对照组:mac 的名字本来就满足
   `isSafeGithubName` 的 `/^[0-9A-Za-z._-]+$/`(`platformPackager.js:687-689`),
   `computeSafeArtifactNameIfNeeded` 返回 null、不发生改写,**所以这里一定会过**。
   Windows 侧靠的是另一件事 —— Task 1 给 `build.nsis` 加的
   `"artifactName": "${productName}.Setup.${version}.${ext}"`(点号)让本地名同样直接过
   该正则,本地名 = `latest.yml` 的 `path` = Release 资产名三方一致。那条**只有真实 CI
   构建能证**,所以**本步的绿不能拿来给 Windows 侧背书**,收尾清单 B.1 里 Windows 那条
   必须单独打勾。

- [ ] **Step 10: 起被测客户端(0.0.1),后台跑** —— ⚠️ **从这一步起需要人坐在 mac 前看 GUI**,见「执行前提」的执行者划分。

先确认可执行文件在(路径用 **Step 4 记下的那条真实路径**,把
`/Contents/Resources/app-update.yml` 换成 `/Contents/MacOS/gladlog`;下面这条是最常见的
形态,不是保证):

```bash
ls /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/mac-arm64/gladlog.app/Contents/MacOS/gladlog
```

`ls` 报 `No such file` 就**回 Step 4 重新 `find` 真实路径,不要猜目录名**
(mac-arm64 / mac / mac-universal 都可能,取决于 electron-builder 的默认 arch 解析)。

然后后台启动(Bash `run_in_background: true`,可执行文件路径同上替换):

```bash
GLADLOG_UPDATER_TEST_FEED=mingjianliu/gladlog-update-test \
GLADLOG_E2E=1 \
GLADLOG_E2E_USER_DATA=/private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/userdata \
"/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app/mac-arm64/gladlog.app/Contents/MacOS/gladlog"
```

`GLADLOG_E2E=1` + `GLADLOG_E2E_USER_DATA` 把 userData 挪到临时目录
(`src/main/e2eEnv.ts:11-20`,变量缺失或非绝对路径会**抛错**而不是回落),**这不是可选项**:
被测 app 的 appId(`com.gladlog.desktop`)与 productName(`gladlog`)与用户日常在用的完全
相同,不隔离就会往 `~/Library/Application Support/gladlog/` 里写 `settings.json`
(含 §4.6 的 `autoCheckUpdates`、§4.7 的 `lastSeenVersion="0.0.1"`),污染真数据。
`GLADLOG_E2E=1` 在主进程里只有两个作用:挪 userData(`e2eEnv.ts`),以及把 iconCache 置
`offline`(`src/main/index.ts:256-257`)—— 都不碰 updater 的网络路径。

**若状态落到 `disabled`:** 看 `main.log` 里的 `reason`。
`platform` / `portable` = test feed 没生效(Step 1 的第二条 grep 漏了,回 Task 6 改直通);
`dev` = 跑的不是打包产物(检查是不是误跑了 `npm run dev`)。
**不要改产品代码来迁就测试,也不要去动用户真实的 settings.json 换隔离方式。**

- [ ] **Step 11: 观察状态机** —— ⚠️ 需要人看 GUI(见「执行前提」的执行者划分)

三路证据同时收:

```bash
tail -n 200 -f ~/Library/Logs/gladlog/main.log
```

(`app.setName("gladlog")` 在 `src/main/index.ts:37`,electron-log 的 mac 默认路径就是
`~/Library/Logs/<appName>/main.log`;`autoUpdater.logger = electronLog` 是 §4.2 配的,
Step 1 已 grep 确认。文件不在就 `ls -la ~/Library/Logs/gladlog/` 看一眼。)

**首选(需要人)**:让人在 app 里点 **设置 → 关于 → 检查更新** —— 时间上可控,
且顺带验了 §4.2 那句「手动检查不受 `autoCheckUpdates` 开关影响」。

**若一时找不到人**:什么都不点,app 起来后等 40 秒,`updater.ts` 的
`FIRST_CHECK_DELAY_MS`(30 s)会自己触发一次检查,`main.log` 里同样能看到
`Checking for update` / `Found version 0.0.3`。**这条退路只够打勾判据①和判据②里的
`ready`**;判据②的「percent 至少两个不同值」和判据③的顶栏状态**拿不到** ——
报告里必须逐字写「**给不出:无人观察 GUI,percent 事件不进 main.log**」。
按 CLAUDE.md 的规矩,给不出就明说给不出,**不许**用「按源码 progress 应该在流」顶替。

**逐条记下来(报告里要原样贴;标「UI 顶栏」的两行只有人看得到):**

| 时刻 | 来源     | 观察到的内容                                                       |
| ---- | -------- | ------------------------------------------------------------------ |
|      | main.log | `Checking for update`                                              |
|      | main.log | `Found version 0.0.3 (url: gladlog-0.0.3-arm64-mac.zip)`           |
|      | UI 顶栏  | `正在下载 0.0.3 · N%`(至少记两个不同的 N,证明 progress 事件真在流) |
|      | UI 顶栏  | `新版 0.0.3 已就绪`                                                |
|      | main.log | Squirrel 的签名校验报错原文(见下)                                  |

从源码推出的**预期序列**(实测对不上就是发现了 bug,照实记):

`checking` → `downloading{version:"0.0.3", percent:0…100}` → `ready{version:"0.0.3"}`
→ `error{message: Squirrel 的签名校验失败原文}`

最后那个 `error` 是**预期**,不是 bug:`MacUpdater.js:219` 在 sha512 校验通过、
本地代理服务器起好之后**先** `dispatchUpdateDownloaded(event)`(→ 我们的 `ready`),
**再**因为 `autoInstallOnAppQuit = true` 调 `nativeUpdater.checkForUpdates()`
(`:223`)让 Squirrel.Mac 去取包校验;ad-hoc 签名(`build/afterSign.cjs` 的
`codesign --sign -`)没有稳定 designated requirement,Squirrel 校验必败 →
`MacUpdater.js:20` 把 native 的 error 转发成我们的 `error` 事件。

**「percent 至少两个不同值」这条别省。** `AppUpdater.js:567-568`
`if (this.listenerCount(DOWNLOAD_PROGRESS) > 0)` 是在 `executeDownload` 进入时取的
一次性快照 —— 监听器挂晚了就一个 progress 事件都收不到,**而且不报错**。这条观察是
那个坑的唯一探针。

两条排障预案(遇到才用,别当失败):

- **一次检查是三个 HTTP 请求。** `GitHubProvider.js:43-46` 在 `allowPrerelease` 的两个分支
  之前**无条件**先拉 `<basePath>.atom`,再打 `/releases/latest`(`:93`),最后取
  `latest-mac.yml`(`:118`)。atom 拉不下来会抛
  `ERR_UPDATER_INVALID_RELEASE_FEED`(`:108`)→ 落 `error`。国内网络下这属于环境问题,
  重试即可;但要在报告里写明重试了几次,别把它记成产品 bug。
- **日志里若出现 `UnhandledPromiseRejection` / 未捕获的 `ERR_UPDATER_*` 堆栈**,说明 Task 4/6
  漏了 `checkForUpdates().catch(() => {})`(`AppUpdater.js:269-272` 是 emit + rethrow 双通道)。
  照实记进报告并回填给对应 Task,**不要在本任务里顺手改产品代码** —— 改了就得重打包重跑。

- [ ] **Step 12: 对判据打勾** —— ⚠️ 判据②的 percent 与判据③整条都要人看 GUI

**哪些能从 main.log 拿到、哪些必须靠人**(照实分,别混):判据①三条里前两条在 log 里,
第三条「UI 上的版本号」要人看;判据②的 `ready` 与缓存目录在 log / 文件系统里,
**`percent` 至少两个不同值拿不到** —— electron-updater **不**逐块打进度日志;
判据③四条全部要人看 GUI。没有人时,这些条目一律写「**给不出:无人观察 GUI**」,
不许用源码推演顶替。

**① `allowPrerelease = false` 真的生效 —— 本次验证的头号目标**

- [ ] main.log 里 `Found version` 后面是 **0.0.3**
- [ ] **不是** 0.0.2-beta.1
- [ ] UI 上出现的版本号也是 0.0.3(两处一致,排除「日志对了 UI 手抄错了」)

机制:`GitHubProvider.js:93` 在 `allowPrerelease` 为 false 时走
`getLatestTagName()`(`:158`)→ GitHub 的 `/releases/latest`,该端点按定义排除 prerelease 与 draft。
Step 9 已经在服务端侧独立确认过 `/releases/latest` = `v0.0.3`,这里确认的是**客户端**
确实用了那条路径而不是从 atom feed 里抓第一条(那条是 v0.0.3 还是 v0.0.2-beta.1
取决于发布顺序,会掩盖 bug)。

**② 下载完成 + sha512 通过 + 状态机走到 ready**

- [ ] 观察到至少两个不同的 `percent` 值
- [ ] 观察到 `ready`,version = 0.0.3
- [ ] `~/Library/Caches/gladlog-updater/` 下出现下载好的 zip
      (路径 = `AppAdapter.js` 的 `getAppCacheDir()`(mac → `~/Library/Caches`) + `app-update.yml` 里的 `updaterCacheDirName`,两者都已在 Step 4 见过)

**`ready` 本身就是 sha512 通过的证据**,不需要另外手算:`AppUpdater.js:562-565` 把
`sha512: fileInfo.info.sha512` 传给 `httpExecutor.download`,校验不过直接抛 →
走 error 分支,永远到不了 `update-downloaded`。想额外自证可以跑:

```bash
openssl dgst -sha512 -binary /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/keep/0.0.3/gladlog-0.0.3-arm64-mac.zip | openssl base64 -A
grep -A3 'files:' /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest/verify/latest-mac.yml
```

两个 base64 字符串应逐字符相同(electron-builder 写进 yml 的就是 base64 raw digest,不是 hex)。

**③ mac 上安装失败是预期,但必须失败得干净**

- [ ] 状态落到 `error`,message 里是 Squirrel 的原文(可读、不是 `undefined`)
- [ ] **进程没崩** —— app 窗口还在,`ps` 里还有它
- [ ] **没弹任何系统模态框**(§4.2:error 不弹窗、不打扰)
- [ ] 顶栏/横幅没有卡在「正在下载 100%」这种半死状态
- [ ] 若 UI 上还能点「立即重启」,点一次:app 要么干净退出、要么落回 `error`,
      **不能出现「窗口没了但进程还在」**

**③ 的证据边界(必须写进报告,别越界):** mac 上点「立即重启」走的是
`MacUpdater.js:233` 的 `this.nativeUpdater.quitAndInstall()`(且 `MacUpdater.js:240`
的签名**不收参数**,§4.3 里那两个 `true` 在 mac 上被完全忽略),而不是
`BaseUpdater.js:13-27` 的「spawn detached 安装器 → `setImmediate` 里 `app.quit()`」。
**所以 mac 上的观察结果不能当作 §4.3「清理链跑完才起安装器」的验证证据**,也不能当作
Task 5 那个安装看门狗的验证证据(mac 这条路径根本不 spawn 安装器)。
§4.3 只有 Task 4/5 的单测(顺序断言)和 Windows 真机能证。

- [ ] **Step 13: 还原版本号,确认工作树干净**

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update checkout -- packages/desktop/package.json
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update status --porcelain
grep '"version"' /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/package.json
```

期望:`git status --porcelain` 空;version 回到 `0.1.19`(除非发版任务已经 bump 过)。
`checkout` 恢复的是 Task 1 提交后的那份,`build.publish` 与 `build.nsis.artifactName` 都还在。
**这一步不能跳** —— 把 `"version": "0.0.1"` commit 进 main 会让下一次发版的 tag 与包内版本
对不上,而且没人会注意到。

- [ ] **Step 14: 把实测结果写进 spec,顺手改掉 §6.2 那句错的前提,commit**

**(a) 改 §6.2 的开头一句**(现文在 `docs/superpowers/specs/2026-08-02-auto-update-design.md:286`):

原文:

```
开一个丢弃用的公开仓库 `mingjianliu/gladlog-update-test`(只推一个 README commit),本地出三个版本,`gh release create` 挂上去。
```

改成:

```
开一个丢弃用的公开仓库 `mingjianliu/gladlog-update-test`(**每个版本各推一个真 commit 再打 tag** —— 三个 tag 指向同一个 commit 时,GitHub `/releases/latest` 按底层 commit 的 `created_at` 排序会并列,选中谁不受控,「跳到 0.0.3」这条判据会假通过或假失败),本地出三个版本,`gh release create` 挂上去。
```

**(b) 在 §6.2 末尾**(「**不覆盖**」那个列表之后、`## 7 已知缺口与风险` 之前)追加:

```markdown
#### 6.2.1 实测结果(2026-08-0X)

dummy 仓 `mingjianliu/gladlog-update-test`(已删)。客户端 = 本地打的 0.0.1 mac arm64 包,
`GLADLOG_UPDATER_TEST_FEED=mingjianliu/gladlog-update-test`,
`GLADLOG_E2E=1` + `GLADLOG_E2E_USER_DATA` 隔离 userData。

服务端侧:`/releases/latest` → `v0.0.3`;`latest-mac.yml` 的
`files[0].url` = `gladlog-0.0.3-arm64-mac.zip`,与 Release 资产名逐字符一致。

客户端观察到的状态序列:

1. `checking`
2. `downloading` version=0.0.3 percent=<实测值1> → <实测值2> → 100
3. `ready` version=0.0.3
4. `error` message=<Squirrel 原文>

判据:① 检测到 0.0.3 而不是 0.0.2-beta.1 —— <通过/不通过>;
② 下载完成 + sha512 通过 + 走到 ready —— <通过/不通过>;
③ mac 安装失败得干净(不崩、不弹窗)—— <通过/不通过>。

未由本次验证覆盖:§4.3 的退出链接法与 Task 5 的安装看门狗(mac 走
`MacUpdater.quitAndInstall()`,不 spawn 安装器,机制不同);Windows 侧 `latest.yml` 的
产出、`path` 与资产名一致性(§3.2 的 `artifactName` 点号写法)。
```

**把 `<实测值>` / `<通过/不通过>` 全部替换成真实观察到的内容再提交。**
判据没跑到、或者观察不到,就写「给不出:<原因>」—— CLAUDE.md 的验证规矩是
「给不出就明说给不出」,不是填一个好看的值。

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update add docs/superpowers/specs/2026-08-02-auto-update-design.md
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update commit -m "docs(desktop): 自动更新 dummy release 端到端实测结果 —— 0.0.1 检出 0.0.3、跳过 prerelease、走到 ready"
```

- [ ] **Step 15: 清理**

```bash
gh repo delete mingjianliu/gladlog-update-test --yes
rm -rf ~/Library/Caches/gladlog-updater
rm -rf /private/tmp/claude-501/-Users-mingjianliu-code-gladlog/e44a9e70-6f00-4a08-9184-2716a6db2559/scratchpad/updtest
rm -rf /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/packages/desktop/dist-app
grep -rn "GLADLOG_UPDATER_TEST_FEED" ~/.zshrc ~/.zshenv ~/.zprofile 2>/dev/null
gh repo view mingjianliu/gladlog-update-test 2>&1 | head -2
```

期望:倒数第二条**无输出**;最后一条报 `Could not resolve to a Repository`(仓库已删)。

- `gh repo delete` 需要 `delete_repo` scope,报权限错就
  `gh auth refresh -h github.com -s delete_repo` 后重试。
- `~/Library/Caches/gladlog-updater`:updater 下载缓存目录,里面躺着 ~100 MB 的
  `update.zip`,不删会让**下次真更新走差分路径**(`MacUpdater.js:93-101`
  `canDifferentialDownload` 就看这个文件在不在),污染后续观察。
- `dist-app/` 删掉是因为它里面是 0.0.1 版本号的产物,留着容易被误当成正式包。
- 那条 `grep` 是防呆:本任务的环境变量是命令行内联的,不该留进 shell 配置。
  一旦被 export,`qa/support/launch.ts:30` 的 `env: { ...process.env, ... }` 会让全部
  E2E 继承它 —— 值写错时的失败面很难查。

- [ ] **Step 16: 交报告**

按 CLAUDE.md 的验证规矩,报告里必须有**实际观察到的版本号和状态序列**,
不是「跑通了」三个字。最小可接受形态:

```
服务端:/releases/latest = v0.0.3(gh api 输出原文)
客户端:checking → downloading 0.0.3 @ 3% / 47% / 100% → ready 0.0.3 → error "…"
判据 ① 通过(检出 0.0.3,非 0.0.2-beta.1)
判据 ② 通过(percent 观察到 3 个不同值;ready 到达 ⇒ sha512 通过)
判据 ③ 通过(error 有可读 message;进程存活;无模态框)
```

任何一条观察不到,写「给不出:<原因>」。**不允许**用「按源码应该是 X」代替实测值 ——
2026-07-20 那次的代价就是这么来的(`3cd5342` 根因写得头头是道,实测 26/50 → 26/50)。

---

## Task 10: CHANGELOG 双语条目(随发版提交)

自动更新是用户可感知的行为变化,必须进 CHANGELOG。CLAUDE.md 的双语成对规矩:
`CHANGELOG.md` 是正名、`CHANGELOG.zh-CN.md` 是中文版,**两版内容必须等价,一次改两个文件**。

**注意本次不改任何安装包文件名。** §3.2 的 `artifactName` 用的是点号
(`gladlog.Setup.X.Y.Z.exe`),与历史上每个 release 的资产名逐字节相同,所以 CHANGELOG 里
**不要**写「安装包改名」——那是被推翻的旧方案。

**Files:**

**Modify:**

- `CHANGELOG.md:9` —— 在 `## v0.1.19 (2026-08-02)` 这一行**之前**插入新的 v0.1.20 节
- `CHANGELOG.zh-CN.md:9` —— 在 `## v0.1.19(2026-08-02)` 这一行**之前**插入等价的中文节

**Test:** 无(仓库没有双语一致性测试,靠 Step 3 的人工对照)。

**Interfaces:**

**Consumes:** Task 1–8 的 commit 短哈希(`git log --oneline v0.1.19..HEAD`)、发版日期。
**Produces:** 无代码消费者;发版时 `.claude/skills/release/SKILL.md` 的流程会用到。

### 步骤

- [ ] **Step 1: 插入英文节**

在 `CHANGELOG.md:9` 之前插入(`<hash-a>` / `<hash-b>` / `<date>` 在 Step 3 替换成真值):

```markdown
## v0.1.20 (<date>)

This release = **automatic updates for the Windows installer build**.

### Updates

- `<hash-a>` The Windows installer build now updates itself: it checks GitHub 30 seconds after launch and every 4 hours after that, downloads the new build in the background, and shows a "new version ready — restart now / later" banner in the top bar. The install happens on exit, so it can never interrupt a match that is being recorded; if you never click restart, the next ordinary exit installs it anyway. While a recording or a batch analysis is running, "restart now" is disabled. Settings → About gained the current version number, a manual "Check for updates" button, and an "Automatically check for updates" switch (on by default). A failed check is silent by design — pulling 110 MB from GitHub fails often enough that a popup would be noise, and nothing else in the app depends on it.
- `<hash-b>` After an update the top bar shows "Updated to 0.1.20 · What's new" once, linking to that release's notes. Automatic updates are otherwise invisible, and "which version am I on" is the first thing anyone needs when reporting a problem.

Not covered: macOS is unaffected (the build is ad-hoc signed, which Squirrel.Mac refuses, so the updater does not initialise there), and so is the Windows portable zip (there is no installer to hand the download to). **0.1.20 itself still has to be installed by hand** — 0.1.19 does not know how to update itself; the benefit starts with 0.1.21.
```

- [ ] **Step 2: 插入等价的中文节**

在 `CHANGELOG.zh-CN.md:9` 之前插入:

```markdown
## v0.1.20(<date>)

这版=**Windows 安装版自动更新**。

### 更新

- `<hash-a>` Windows 安装版现在会自己更新:启动 30 秒后查一次、之后每 4 小时查一次,后台下载新版,顶栏出「新版已就绪 —— 立即重启 / 稍后」的横幅。**安装发生在退出时**,所以物理上不可能打断正在录制的对局;就算一直不点重启,下次正常退出也会装上。正在录像或正在跑批量分析时,「立即重启」是禁用的。设置页新增「关于」小节:当前版本号、手动「检查更新」按钮、「自动检查更新」开关(默认开)。检查失败是**刻意静默**的 —— 从 GitHub 拉 110 MB 失败是常态,弹窗只会变成噪声,而且失败不影响 app 的任何其他功能。
- `<hash-b>` 更新之后,顶栏会出现一次「已更新到 0.1.20 · 更新内容」,点开是该版本的发布说明。自动更新本身是无感的,而「我现在是哪一版」恰恰是报问题时第一个要知道的。

不覆盖:macOS 不受影响(本机包走 ad-hoc 签名,Squirrel.Mac 不认,updater 在 mac 上根本不初始化);Windows 绿色版(zip 解压版)同样不启用,因为它没有可以接管的安装器。**0.1.20 本身仍需手动安装** —— 0.1.19 里没有 updater,收益从 0.1.21 起兑现。
```

- [ ] **Step 3: 替换占位并对照两版**

```bash
cd /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update
git log --oneline v0.1.19..HEAD
```

把 `<hash-a>` 换成主功能(updater 模块 + 接线 + IPC)那条 commit 的短哈希,
`<hash-b>` 换成 §4.7 留痕那条(若两件事在同一个 commit 里,就两处写同一个哈希);
`<date>` 换成发版当天日期(英文版 `2026-08-0X`、中文版同一天)。

对照自查:

```bash
grep -c '^- `' <(sed -n '/^## v0.1.20/,/^## v0.1.19/p' CHANGELOG.md)
grep -c '^- `' <(sed -n '/^## v0.1.20/,/^## v0.1.19/p' CHANGELOG.zh-CN.md)
grep -n '<hash-\|<date>' CHANGELOG.md CHANGELOG.zh-CN.md
```

期望:前两条输出同一个数字(都是 `2`);第三条**无输出**(占位符已全部替换)。

- [ ] **Step 4: commit**

```bash
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update add CHANGELOG.md CHANGELOG.zh-CN.md
git -C /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update commit -m "docs: CHANGELOG 0.1.20 —— Windows 安装版自动更新(双语成对)"
```

(CHANGELOG 是 markdown,不进 `eslint` / `tsc` 的扫描面,不需要额外跑门。)

---

## 收尾清单(不是 Task,是合并/发版前逐条过一遍)

### A. push 前必跑

**计数口径(先立规矩,免得各 Task 各报各的):**

基线 **136 files / 938 tests passed**(2026-08-02 在本 worktree 实测)。各 Task 的净增量:

| Task | 净增量 | 内容                                                                   |
| ---- | ------ | ---------------------------------------------------------------------- |
| T1   | +6     | 发布端配置守卫                                                         |
| T2   | +5     | `quitLifecycle.shutdown()`                                             |
| T3   | +3     | settingsStore 两个新字段                                               |
| T4   | +23    | 三重门 + 状态机 + 定时器 + `install()`                                 |
| T5   | +2     | `install()` 的两个增量:shutdown 抛错也照装、安装看门狗                 |
| T6   | +9     | ipc/preload 接线 2 条 + updateBridge 7 条                              |
| T7   | +14    | UpdateBanner(含「安装器未接管」那条顶栏例外分支)                       |
| T8   | +11    | updateBridge 的 hasUpdateSurface 契约 2 条 + SettingsPanel「关于」9 条 |

合计 **+73 → 收官应为 `Tests 1011 passed`**。文件数 `136 → 142`,新增六个 `.test` 文件
(`releaseConfig` / `updater` / `updater.uninstallerName` / `updateChannels` / `updateBridge` /
`updateBanner`),不做硬断言 —— **硬口径是用例数**。
**每个 Task 的 Step 里只报本任务的净增量,总数以本表为准**;实际跑出来对不上,先查是不是
同一件事被实现了两遍(install()、定时器、§4.7 留痕这三处历史上各差点被写两份),不要改这张表。
逐 Task 的累计落点(中途对表用):T1 后 `137 / 944`、T2 后 `137 / 949`、T3 后 `137 / 952`、
T4 后 `139 / 975`、T5 后 `139 / 977`、T6 后 `141 / 986`、T7 后 `142 / 1000`、
T8 后 `142 / 1011`。

跑之前一律以当场输出为准:

```bash
npm test --workspace=packages/desktop 2>&1 | tail -5
```

**四条门,全部从 worktree 根目录 `/Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update` 跑:**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint . --quiet && npm run build --workspace=packages/desktop
```

- **`eslint .` 是全仓,不是 `packages/desktop/src`。** CI 跑的是全仓,只扫 src 会漏掉
  `test/`、`qa/`、`dev/`、`scripts/` —— 这一条连挂过三次。
- **`npm run typecheck`,绝不 `tsc -b`**(会往 src 里吐 `.js`,污染树并遮蔽 `.ts`)。
- **第四条 `npm run build --workspace=packages/desktop`(electron-vite build)不是可选的**:它对应
  CI `.github/workflows/test.yml:53-54` 的 `Production bundle` 步骤。本功能有一个专属的炸法 ——
  renderer 侧若把 `UpdateState` 写成**值导入** `src/main/updater.ts`(而不是 `import type`,
  先例见 `src/preload/api.ts` 对 `RecorderStatus` 的写法),`electron-updater` 会被拖进
  renderer bundle,这一步和视觉回归的 `build:ui` 双双炸,而单测/typecheck 都拦不住。
- 跑之前确认 worktree 有**自己的** `node_modules`:
  `ls -d /Users/mingjianliu/code/gladlog/.claude/worktrees/auto-update/node_modules`。
  没有的话模块解析会爬到主 checkout(那是另一个分支的源码),typecheck 会假红。
  没有就先在 worktree 根 `npm install`。

如果动过 UI(§4.5 顶栏挂件 / §4.6 设置页「关于」小节),视觉基线要重生成,
**且不能在本机直接跑 `npm run test:visual`**(会把 mac 渲染的图写进单源基线)。
四步流程(spec §8 末尾):

1. 本机只跑自查:`npm run test:visual:smoke --workspace=packages/desktop`(它带 `--ignore-snapshots`)
2. 分支推上去后:`gh workflow run visual-baseline.yml --ref worktree-auto-update`
   (`workflow_dispatch` 只能从默认分支触发,即 `.github/workflows/visual-baseline.yml`
   本身要已在 main 上)
3. `gh run download <run-id> -n visual-baselines` 取产物,**人工审图**
4. 把改动的 PNG 覆盖进 `packages/desktop/qa/__screenshots__/scenes.spec.ts/` 并提交

另外 `qa/budgets.ts:44` 的 `coldStart: 2600` 是硬预算(`qa/e2e/coldStart.spec.ts`
取 3 次中位数):如果 updater 是顶层 `import` 而不是三重门通过后的动态
`await import("electron-updater")`,`electron-updater` 连同 js-yaml / fs-extra /
semver / lodash.* / builder-util-runtime 会在**每次启动**(含 mac、含 E2E)被加载,
这个预算可能被吃穿。跑一次 `npm run test:e2e --workspace=packages/desktop` 确认。

### B. 本次改动**没有**覆盖的东西(明写,别让计划看起来比实际能证明的多)

1. **Windows 侧 `latest.yml` 是否真被 CI 产出并被上传 glob 收走 —— 只有 0.1.20 那次
   真实构建能证。** 本机 mac 打包只证明 `latest-mac.yml` 生成正常。
   发版后必须做:

   ```bash
   gh release view v0.1.20 --json assets -q '.assets[].name'
   curl -sL https://github.com/mingjianliu/gladlog/releases/download/v0.1.20/latest.yml
   ```

   逐条对:

   - [ ] 资产里有 `latest.yml`(**漏它的后果是所有 Windows 客户端静默检查失败**,
         而且没有任何报错)
   - [ ] 资产里有 `latest-mac.yml`
   - [ ] 资产里有 `.exe` 的 `.blockmap`
   - [ ] **`latest.yml` 里的 `path` / `files[0].url` 与 Release 上的 `.exe` 资产名
         逐字符相同,三者都应是 `gladlog.Setup.0.1.20.exe`** ← 这一条比 sha512 更早暴露
         问题,也是核查阶段挖出的头号坑:NSIS 本地文件名默认带空格
         (`gladlog Setup 0.1.20.exe`,`NsisTarget.js:100-104`),electron-builder 会把
         yml 里的名字改写成短横(`gladlog-Setup-0.1.20.exe`,`platformPackager.js` 的
         `computeSafeArtifactNameIfNeeded`),而 softprops 直传给 GitHub 后 GitHub 把空格
         规范化成**点**(`gladlog.Setup.0.1.19.exe`,v0.1.19 实测),客户端侧
         `GitHubProvider.js:181` 只做 `replace(/ /g, "-")` → 拼出短横名 → **404,自动更新
         彻底不工作,且静默**。§3.2 的修法是给 `build.nsis` 加
         `"artifactName": "${productName}.Setup.${version}.${ext}"`(**点号,不是短横**):
         本地名直接过 `isSafeGithubName` 的 `/^[0-9A-Za-z._-]+$/`
         (`platformPackager.js:687-689`),`computeSafeArtifactNameIfNeeded` 返回 `null`、
         不发生任何改写,GitHub 也无空格可规范化 —— 三方逐字节一致,而且这个名字与历史
         每个 release 的资产名相同,**用户可见的下载名与下载 URL 一个字都不用改**
         (只有三行写「本地 `dist-app/` 产物名」的文档随 Task 1 Step 6 同步)。
         对不上就是 Task 1 那条没落地。
   - [ ] 下载回来的 exe 的 sha512 与 `latest.yml` 里的相同:
         `openssl dgst -sha512 -binary gladlog.Setup.0.1.20.exe | openssl base64 -A`
   - [ ] 资产里**没有** `builder-effective-config.yaml`(它含本机绝对路径和完整配置;
         由 `app-builder-lib/out/packager.js:298-301` 在 `!isCI && process.stdout.isTTY`
         时写出 —— CI 上通常不写,但**别指望这个**)。
         `.github/workflows/build.yml` 的两处 glob(`:51-53` 与 `:61-63`)严格写 `*.yml`,
         **不要写成 `*.y*ml`**。

   注:spec §3.2 说资产「4 个变 7 个」。实际数量取决于 electron-builder 为 mac 的
   dmg / zip 各生成几个 `.blockmap`,可能是 7~9 个。**按名字核对,别按数字核对** ——
   `.claude/skills/release/SKILL.md:70-72` 那份清单也照名字写。

2. **NSIS 真正的换包动作 —— 只有用户的 Windows 真机能证明,且时间线上滞后一个版本。**
   要验「从 A 自动更新到 B」,前提是 A 已装在机器上,而 A 里得先有 updater。所以:

   - **0.1.20 发出去时,自动更新处于未经真机验证的状态** —— 能证明的只有「它没崩、
     没乱弹窗」(mac 用户 updater 根本不初始化,0.1.19 及以前的包不知道有这回事)
   - **0.1.21 才是第一次真正验证**。真机验收判据:检测到 → 后台下载 → 提示条出现 →
     点重启装上 → 重开后版本号是新的 → `%APPDATA%\gladlog\matches\` 下对局数不变

3. **§4.3 的退出链接法在 mac 上验不了。** Task 9 的 mac 观察走的是
   `MacUpdater.quitAndInstall()`(`MacUpdater.js:240`,不收参数、走 Squirrel、没有 spawn
   detached 安装器),与 Windows 的 `BaseUpdater.js:13-27` 机制不同。§4.3 目前的证据只有
   Task 4/5 的顺序断言单测 + 将来的 Windows 真机。

4. **`install()` 返回 false 的分支只有单测覆盖,看门狗也只在单测里被触发过。**
   `BaseUpdater.js:16-25`:安装器起不来时 `quitAndInstall` **不调** `app.quit()`,而此时
   `shutdown()` 已经停了录像/worker/AI 子进程并把 phase 翻成 `finishing` —— app 活着但功能
   全废,且下一次 `before-quit` 会被 `quitLifecycle.ts:94` 的
   `if (phase === "finishing") return` 直接放行、不再清理。
   Task 5 的**安装看门狗**是这条的唯一兜底:`quitAndInstall` 之后 10 s 进程还活着就落
   `error`(文案「更新安装器未能接管,请手动退出 gladlog 后重新打开」)。它**刻意不调
   `app.quit()`** —— updater 不持有 quit 依赖,再开一条绕过 `quitLifecycle` 的退出路径
   比留一个可见的错误状态更糟。真机上这个分支怎么触发(磁盘满?杀软拦截?)没有验证手段。

   合并前自查这条 error 用户到底看不看得见:

   ```bash
   grep -n "installRequested" packages/desktop/src/renderer/src/components/UpdateBanner.tsx
   grep -rn "更新安装器未能接管" packages/desktop/src/main/updater.ts
   ```

   §4.2 的「error 不打扰」让顶栏对普通 error 什么都不渲染,而这一条是唯一必须打扰用户的
   error(录像/worker/AI 都已停掉)。判读:

   - 第一条必须命中 **≥2 处**(`setInstallRequested(true)` 在「立即重启」的 onClick 里、
     `state?.phase === "error" && installRequested` 在 `live` 三元链里)—— 命中即说明顶栏
     对「点过重启之后的 error」开了例外分支,用户看得见。
   - 第二条命中 **1 处**(文案单源在 main)。
   - **renderer 侧不该出现这句文案**。这里刻意不 grep renderer 找它:Task 7 渲染的是
     `{state.message}`(变量)、Task 8 渲染的是 `检查失败:${s.message}`,按本计划落地后
     renderer 里根本没有这个字面量。真在 renderer 里搜到了,反而是有人把 main 侧的文案
     手抄成了字符串常量 —— 那是会静默腐烂的手抄谓词,要删掉改回渲染 `state.message`。
   - 若第一条**零命中** = Task 7 Step 14-16 没落地,顶栏不会渲染这条 error,用户只有主动
     翻到设置页「关于」才看得见 —— 那就把「安装器未接管只有设置页可见」写进发版说明的
     已知限制,别当没这回事。

5. **§4.5「忙」判据有一个已知洞:单场 AI 分析不在内。**
   `getBatchStatus().running`(`src/renderer/src/batch/batchAnalysis.ts:69`)只覆盖
   批量/自动分析;报告页 AI 视图的单场分析走
   `src/renderer/src/report/components/StructuredAnalysisPanel.tsx:687` 的
   `bridge().analysis.run(...)`,**完全不经过 batchAnalysis**。所以「用户正在单场跑分析」
   时「立即重启」不会被禁用。这是已知洞,不是没想到 —— main 侧
   `analysis.getState(matchId).running` 才是权威,但没有全局 running 快照,补它要新开
   一份全局在飞集合,而那正是 §4.5 明令禁止的「为这个横幅新开一份判断」。
   代价:用户在单场分析途中点重启会中断那次分析(下次重跑即可,无数据损失)。

6. **国内网络下差分下载的实际成功率给不出数。** blockmap 差分理论上只传变化块
   (110 MB 里约 100 MB 是版本间不变的 Electron 运行时),但 NSIS 压缩边界一移动差分即
   失效、回退全量。失败无后果(静默回 idle)。需要真机跑过若干个版本才知道。
   另注:一次检查其实是**三个** HTTP 请求(`GitHubProvider.js:43` 的 atom feed +
   `/releases/latest` + `latest.yml`),国内失败面比「一次请求」的直觉宽,但都收敛到
   `error` 事件,无副作用。

7. **`latest.yml` 的完整性只靠 sha512,不靠签名。** `NsisUpdater.js:84-100` 的
   `verifySignature()` 在 `publisherName == null` 时直接 `return null` —— gladlog 的
   Windows 包没有代码签名,`app-update.yml` 里不会有 `publisherName`,整个 Authenticode
   校验被跳过。所以「sha512 校验通过」是真的,**「签名校验通过」不是** —— 别在
   CHANGELOG 或 release notes 里这么写。

8. **无感跨版本的既有缺口没被本功能修掉(spec §7)。** `matchStore` 写 `match.json` 时带的
   `schemaVersion: 1` **读取侧无任何地方检查**,对局文档结构若变更,旧文档会被静默按新结构
   读。这是既有缺口、非本功能引入,但自动更新把它**放大**了:以前手动升级用户知道自己换了
   版本,现在是无感的。§4.7 的留痕**不修它**,只保证出问题时用户能看到「已更新到 X」这条
   线索。真要修得在读取侧加 `schemaVersion` 判定,不在本次范围。
   (分析缓存那半边已被 `src/shared/promptVersion.ts` 的 `PROMPT_VERSION` 兜住,不属于此洞。)

### C. 发版

- **CHANGELOG 见 Task 10**(双语成对,一次改两个文件)。如果还动了
  `docs/user-guide.md` / `docs/FAQ.md` / `packages/desktop/README.md` 里跟更新有关的段落,
  对应的 `.zh-CN` 那份要同步 —— 双语成对规矩管的是**全部 12 篇 + 包级 README**。
  **不需要**改任何文档里用户可见的**下载名 / 下载 URL**:§3.2 的 `artifactName` 用点号,
  产出的 `gladlog.Setup.X.Y.Z.exe` 与历史每个 release 的资产名逐字节相同。
  写「本地 `dist-app/` 产物名」的三行(`docs/BUILD-WINDOWS.md:45` +
  `docs/BUILD-WINDOWS.zh-CN.md:44` + `docs/commands/release-gladlog.md:48`)
  已由 Task 1 Step 6 同步,发版时不用再动。
- 发版流程走 `.claude/skills/release/SKILL.md`。本次改动会连带改它两处(按 spec §3.5):
  `:70-72` 的「必须见到 4 个资产」清单 → 改成按名字列的新清单(含 `latest.yml`,
  并写明漏传的后果是所有 Windows 客户端静默检查失败);`:59` 的「提醒用户……默认应走 +1」
  → 从建议升级为硬规矩。该目录被 `eslint.config.js:20` 的 `.claude/**` 忽略,
  改它不过 lint,别指望 lint 兜底。
- **版本号绝不复用。** 覆盖 vX 之后,已装 vX 的客户端版本号相同、收不到更新,手里是旧内容
  却以为最新 —— 有了自动更新之后这从「建议」升级为**硬规矩**。
- 发完立刻做 B.1 的那一串核对,**不要等用户报「更新没反应」**:更新检查失败是完全静默的
  (§4.2 error 不弹窗),没人会主动告诉你。
