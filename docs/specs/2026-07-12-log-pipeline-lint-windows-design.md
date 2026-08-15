# Cross-Machine Log Relay + Lint + Windows Build Design

Date: 2026-07-12
Status: Pending User Review

## Background and Objectives

Port three pieces of **user-owned** infrastructure from the old fork (`/Users/mingjianliu/code/wowarenalogs`, now CC BY-NC-ND) into gladlog, and produce a Windows build of the main analysis app:

1. **windows-agent** (log streaming upload agent) + **wal-pilot** (streamer/collector orchestration) → Combine into a single `packages/log-pipeline` package.
2. **lint** (gladlog currently lacks ESLint) → Root-level flat config.
3. **Windows binary**: electron-builder Windows build of the main gladlog desktop application.

**Deployment Topology (User Confirmed)**: Cross-machine Windows → Mac. Run the streamer on the Windows gaming PC and the collector on the Mac for post-match analysis. The old design used a GCS bucket as an intermediate layer; gladlog is cloudless, so it switches to a **Google Drive (Drive for Desktop) shared folder** for transfer (both ends set to "available offline/mirrored").

**Collector Responsibility (User Confirmed)**: Reconstruct-only — reconstruct segments into complete `.txt` logs written to a regular output folder, with no analysis. The user will manually open this folder with gladlog.

## Compliance Conclusion

`windows-agent` (18 commits) and `pipeline-app` (19 commits) were **100% written by the user (Mingjian Liu) personally**, are owned assets post-fork, and are not upstream expressions. The Subproject 0 audit's only hits on these three packages were 7 instances of **trivial configuration boilerplate** (`.eslintrc.js`/`jest.config.js`/`.eslintignore`, 1–5 lines, matching similar configs in other packages within the same fork), plus a 1-line coincidence in `cli.ts` — none of which are copyrightable expressions. Per the roadmap rule "Files that pass audit → direct copy", these user-owned files can be ported into gladlog almost verbatim. The ported trivial configs would have been rewritten anyway for the gladlog toolchain (vitest, flat ESLint). **Not a single line of upstream (original wowarenalogs author) code is touched**; controller extraction, subagents/agy do not read the old fork.

## Out of Scope

- Electron pilot tray GUI + setup wizard (`main.ts`/`preload.js`/`wizard.html`) — user opted not to package pilot. Its orchestration logic (role resolution, config) is reused as a CLI.
- The Collector's batch analysis chain (`localBatchAnalysis`, `claudeCli`, analysis steps in `collectLogs`) — reconstruct-only.
- GCS adapter + `@google-cloud/storage` dependency — cloudless.
- Code signing, actual Windows machine installation acceptance — user barrier items.

---

## Component One: `packages/log-pipeline`

### Package Structure and Reuse/Discard

Single package, two bin commands. **Verbatim reuse** (user-owned CLEAN files, only changing import paths + ESM + vitest):

- `protocol/{identity,segments,reconstruct}` (see "Protocol Hardening" below — segments/reconstruct have targeted modifications)
- `storage/{StorageAdapter,adapterContract,createAdapter,LocalDirStorageAdapter,MemoryStorageAdapter}`
- `config` (`AgentConfig` + `loadAgentConfig` validation)
- `watcher`, `flusher`, `state`, `initialScan`, `heartbeat`, agent `index` (`flushBatch`)
- streamer/collector service logic, `pilotConfig`, `detect`, `cleanup`
- `collectLogs.runCollection` (reconstruction loop) + `collect/{collectorConfig,statusFile}`

**Discard**: `GcsStorageAdapter` + `@google-cloud/storage`; collector analysis calls; pilot Electron shell.

De-Windowsification of naming: the `stream`/`collect` commands can run on either OS; only the "run streamer" step happens to be on the Windows side.

### Data Flow

1. **Windows streamer** — `startLogWatcher` monitors the WoW `Logs` directory. File by file, it uses `firstLineChecksum` → `gen8` (content identity, a reconstructed log with the same name is treated as a new stream) and records the uploaded byte offset in a local `state`. Every flush reads incremental bytes, `put`s them into the Drive folder as **immutable segments**, and writes a `status/<host>.json` heartbeat.
2. **Google Drive** mirrors whole files Win → Mac.
3. **Mac collector** — `runCollection` lists segments, groups them by (host, logfile, gen8), precisely reconstructs bytes, appends them to `.txt` files in the output directory, deletes fully applied segments with `cleanupAppliedSegments`, and writes the runtime status file.

### Protocol Hardening (From agy debate — see bottom)

The original scheme keyed segments solely by starting offset (`<startOffset>.seg`) and read the delta to the current EOF (non-deterministic length). A silent corruption path **independent of the transport layer** was discovered: if the process is killed between `adapter.put` and `saveState`, restarting will re-flush a **longer** delta with the **same offset key**; if the collector has already consumed and cleaned up the shorter one, the longer segment is treated as a duplicate and discarded because `offset < currentSize` → silent byte drop + permanent stall. This flaw was equally latent in the original GCS design; Drive doesn't introduce it.

**Adopted Fix** (agy steelman, refined):

- Segment keys are changed to `raw/<host>/<logfile>/<gen8>/<startOffset>_<length>.seg` (encoding uncompressed delta length); content remains `gzip(delta)`. Two different-length re-flushes at the same offset (e.g., `100_50.seg` and `100_200.seg`) become **coexisting distinct files**.
- Collector reconstruction is changed to be **overlap-aware**, processing candidate segments in ascending startOffset order:
  - `startOffset + length ≤ currentSize`: Entirely within the reconstructed area → duplicate, skip.
  - `startOffset ≤ currentSize < startOffset + length`: **gunzip first**; if it fails (Drive partial materialization/in-flight corruption — gzip has built-in CRC32 + length tail) → treat as not ready, **do not advance**, try again next poll; if successful, seek to `(currentSize - startOffset)` to append the remaining bytes, and advance `currentSize` **by the actual number of decompressed bytes appended** (never advance by the length claimed in the filename).
  - `startOffset > currentSize`: gap → wait.
- **gzip's CRC32 doubles as an integrity check**: partially synced or corrupted `.seg` files fail decompression → safely deferred, no need to add a crc to the filename. WoW logs strictly append; re-reading source bytes at the same offset is identical, so there's no "overlap content divergence" scenario.

This fix completely eliminates both the silent byte drop and permanent stall failures. It's a **targeted hardening** of the user's own code during the porting phase, with changes concentrated in `segments.ts` (building/parsing keys with length), `reconstruct.ts` (`nextAction` → overlap awareness), `flusher.ts` (passing length to `buildSegmentKey`), and the collector application loop (gunzip validation + actual advancement).

### CLI 与配置

两显式命令,JSON 配置驱动(复用 `loadAgentConfig`/`pilotConfig`/`collectorConfig` 校验):

- **Windows** `gladlog-stream --config stream.json`
  ```json
  {
    "wowDirectory": "C:\\...\\World of Warcraft\\_retail_\\Logs",
    "hostname": "gaming-pc",
    "flushIntervalMs": 60000,
    "storage": {
      "provider": "localDir",
      "directory": "G:\\My Drive\\gladlog-relay"
    }
  }
  ```
- **Mac** `gladlog-collect --config collect.json`
  ```json
  {
    "segmentsDir": "/Users/you/Google Drive/gladlog-relay",
    "outputDir": "/Users/you/gladlog-logs",
    "pollIntervalMs": 15000,
    "cleanup": true
  }
  ```

两端在 Node 下运行(`npm run stream`/`npm run collect` 或 bin 名)。`pilotConfig` 的 `resolveRole`/`detect` 保留在树内,便于日后加一个按平台自动派发的 `gladlog-pilot` 薄包装(复用而非删除,非主入口)。配置错误快速失败并给清晰信息;Drive 目录不存在按「暂无 segment」处理——等待轮询。

### Drive 设置要求(非代码)

Drive 文件夹在**两端**须设为「镜像/离线可用」,而非仅在线占位,否则读取返回占位而非字节。文档说明。同步延迟仅延长 gap 等待;心跳文件让 collector 能标记 streamer 陈旧。Drive 冲突副本(`… (1).seg`)因键解析不匹配被忽略。

### 隐私提示(非阻断)

Drive 传输意味着用户自己的战斗日志途经 Google 云。此为用户对自有数据、自有两台机器的个人选择,非产品默认、非旧 fork 的社区上传。文档如实标注。

---

## 组件二:Lint(根级 flat config)

新增单一根 `eslint.config.js`(ESLint 9 + `typescript-eslint`),覆盖所有包。复用旧 `linter/index.js` 的有效规则,丢弃 Next.js 专属部分:

- 复用:`@typescript-eslint` recommended、`simple-import-sort`(warn)、`no-console`(允许 `warn`/`error`)、`no-unused-vars`(`^_` 忽略)、`react/react-in-jsx-scope: off`。
- 为 gladlog 栈新增:`eslint-plugin-react-hooks`(rules-of-hooks + exhaustive-deps,面向 desktop renderer);`eslint-config-prettier`(格式交给既有 Prettier)。
- 忽略:`node_modules`、`dist`、`out`、`coverage`、构建产物。
- 脚本:根 `lint`(`eslint .`)+ `lint:fix`。根级 devDeps。

**严重度策略**:真 bug 类(`no-unused-vars`、rules-of-hooks)为 `error` 必修;风格类(`simple-import-sort`)起始为 `warn`。lint 任务含把 `npm run lint` 跑绿:修真实问题,不大规模改写无关代码。若违规量大,先报数字与用户定范围,不静默 churn。

---

## 组件三:Windows 构建(主 gladlog 桌面应用)

现状:`package:win` 脚本已在,electron-builder 26 已装,但**无 `build` 配置、无应用图标、本机无 Wine**(从 macOS 交叉构建 NSIS 需 Wine)。

- **加 electron-builder `build` 配置**(`packages/desktop/package.json`):`appId` `com.gladlog.desktop`、`productName` `gladlog`、输出 `release/`、`files` 覆盖 `out/**` + `package.json`、`win.target` = `nsis` + `zip`、`nsis` 选项(per-user、允许改安装目录)、`win.icon`。
- **原创应用图标**(`build/` 下 256px `.ico`):简单原创标记,不含上游/魔兽图像(合规)。
- **本机可产**:`--win zip`/`dir` 不需 Wine → 从 Mac 产出可运行的未打包 Windows 应用以端到端验证配置。
- **真 `.exe` NSIS 安装器**需二选一:本机 `brew install --cask wine-stable`,或在用户 Windows 机跑 `npm run package:win`。仓库**无 git remote**,故 CI 不在无远端下可用。
- **用户门槛**:代码签名(需证书;未签 → SmartScreen 警告)、真 Windows 机装-启动冒烟。

**推荐**:先完整配置 + 图标 + 从 Mac 产 win-zip 构建证明打包链路;NSIS 安装器经 Wine(本机)或 Windows 机产出作为验收步。安装器路线在实现计划中定。

---

## 错误处理

- **Streamer**:单文件失败隔离(一个坏文件不饿死整批);ENOENT(文件消失)丢出队列非重试;心跳写失败去重告警不阻断。
- **Reconstruct**:gap → 等待;gunzip 失败(部分同步/损坏)→ 推迟;重复 segment → 跳过;冲突副本 → 键解析忽略。
- **Config**:校验失败快速退出并给清晰信息。
- **Collector 输出**:原子写(tmp→rename)避免下游读到半文件。

## 测试策略(vitest)

- **协议单测**:`segments`(键构建/解析含 length,拒绝非法/冲突名)、`reconstruct` 重叠感知(重复 no-op、gap、部分重叠追加、按实推进)、`identity`(CRLF 首行校验)。
- **端到端往返**(`MemoryStorageAdapter`,无 Drive):写日志 → streamer flush → collector 重建 → 字节精确等于原日志。
- **回归/加固用例**(直击 agy 缺陷):模拟「put 后、saveState 前崩溃」→ 同 offset 更长 re-flush → 断言重建无丢字节、无 stall;模拟部分物化(截断 gzip 的 `.seg`)→ 断言 collector 推迟且后续补齐。
- **Lint**:`npm run lint` 跑绿作为门。
- **Windows 构建**:从 Mac 产 win-zip 成功、含图标、`out/**` 齐全作为验收(安装器 + 真机启动为用户门槛)。

## 子项目分解与顺序

三块松耦合,建议顺序(各自可独立测):

1. **Lint**(小、独立)——先做,后续新包一落地即受 lint 约束。
2. **log-pipeline**(主体)——协议加固 + streamer/collector CLI + 往返测试。
3. **Windows 构建**(小-中)——electron-builder 配置 + 图标 + win-zip 验证。

三者可置于一份实现计划(lint 与构建是小书挡,pipeline 是主体)。

## 设计决策辩论记录(agy 仪式)

2026-07-12 对「Google Drive 作字节精确日志重建传输」跑 debate-open/reply(conversation `10aa57bb`,OPPOSE → PARTIAL)。

- **surfaced(已修正设计)**:原 `<offset>.seg` 键 + 读到 EOF 的非确定分块,在「put 与 saveState 之间崩溃 + 文件已增长」时可静默丢字节并永久 stall。**与传输无关**,原 GCS 设计同样潜伏。采纳「length 编码键 + 重叠感知重建」修复。
- **PARTIAL(二次精化)**:agy 指出「按文件名声称 length 推进」在 Drive 部分物化下仍会蒸发在途尾字节。修正为**先 gunzip 校验、按实际解压字节推进**;gzip 内建 CRC32 兼作在途损坏检测,无需文件名加 crc。WoW 追加语义 → 无重叠区内容分歧。
- **辩护成立**:Drive 的最终一致性、同步延迟、冲突副本本身不致损坏——不可变+offset 键 + 严格键解析 + gap 等待已覆盖;真正的风险在 (put, saveState) 非原子 + 分块非确定,已由加固关闭。

## 未决事项

- Windows NSIS 安装器路线:本机 Wine vs 用户 Windows 机(实现计划中定)。
- 是否日后加 `gladlog-pilot` 单命令自动派发(保留 `resolveRole`/`detect`,非本次范围)。
