# OBS 录像二期 · 第 1 段(托管 OBS 实例)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文是初稿经两轮对抗复核修订后的版本(第一轮 8B/16I/12M 全处置;第二轮
> 8 PARTIAL + 9 新缺陷,已照复核给的修法处置)。
>
> **三个对已拍板设计的有意偏离,开工前需用户确认(NEW-10 流程要求)**:
> ① 下载改为用户可见动作,非首次运行静默自动下(偏离设计 §0 拍板行与 §5.1);
> ② 非 win32 保留旁路能力(偏离设计 §8 的「强制 recordingEnabled=false」);
> ③ 编码器第 1 段钉死 x264,NVENC 挂第 2 段(§5.3 原文与 §2.5 自相矛盾,取 §2.5)。
> **三条偏离已于 2026-08-04 全部获用户确认**;Task 7 Step 5 回填设计文档 §0/§5.1/§8/§5.3。
>
> 本文是初稿经一轮对抗复核(8 blocker / 16 important / 12 minor)修订后的版本。
> 关键改动:补装配层(Task 5b)、`managedActive` 单源门、`RecordingsStore` 的
> open/close 分片能力、孤儿宽限期、编码器钉死 x264(websocket 无枚举 API,设计
> §2.5 早已写明)、日志就绪防旧日志假阳性、解压走 extractImpl 注入(ubuntu CI 的
> GNU tar 读不了 zip)、`shouldExtract` 归一反斜杠。

**Goal:** 把设计文档 §5–§8 落进产品:首次运行从 obsproject 官方下载便携 OBS、选择性
解压、生成独立配置、托管进程生命周期、连续录 + 定点分片、按含不含对局回收 ——
用户装了 gladlog 就自动录,不装配 OBS,录像不缺头。

**Architecture:** 设计见 `docs/plans/2026-08-02-obs-phase2-design.md`(下称"设计文档")
§5–§8。第 0 段已交付地基(`videoTime` 单源、索引 schema 2、双闸配额、状态上屏、
门测脚本)。本段新建五个 main 模块(资产 / 配置 / 进程 / websocket 薄壳 / backend),
重布 `recorder.ts` 驱动(进程检测管录制,日志事件管分片),旁路(用户自有 OBS)
完整保留一期状态机。

**门测已过(2026-08-04 真机)**:游戏采集出画面、录像可播、便携模式生效、
`--websocket_ipv4_only` 后 IPv4 通、x264 可用。真机教训进本计划:IPv4 显式锁定;
就绪读 OBS 日志非 TCP 探测(且要防上一轮旧日志假阳性);**编码器第 1 段钉死
`obs_x264`**(websocket 没有编码器枚举 API —— 设计 §2.5 的源码级事实,真机
"Available Encoders 为空"也来自日志而非 websocket;NVENC 选择挂第 2 段);
spawn 谜题未定位,Task 3 的真机实验**每次只改一个变量**。

**Tech Stack:** TypeScript monorepo;Electron 38.8.6;vitest;`obs-websocket-js@^5.0.8`
(已有);零新依赖。

## Global Constraints

- **vitest 必须在包目录里跑**:`(cd packages/desktop && npx vitest run <相对路径>)`。
- 类型检查只用 `npm run typecheck`(绝不 `tsc -b`);`scripts/` 不在 tsconfig include 内,
  门测脚本验收 = eslint + 实跑守卫。
- 没装 jest-dom;新 `.tsx` 测试第一行 `// @vitest-environment jsdom`;renderer 测试
  `vi.mock("./bridge")` 打桩。
- **改广泛构造的类型前,执行时现 grep 全部构造点**(含 `test/`、`dev/`、`qa/`;
  不要信本计划里的任何行号或计数 —— 第 0 段之后代码还在动)。
- 门禁链不加管道;复合命令用 `( cd … && … )` 子壳;本机绝不跑 `test:visual`。
- renderer/preload 从 `src/main/*` 只能 `import type`;跨界常量放 `src/shared/`。
- **单源**:回放换算 `shared/videoTime.ts`;OBS 资产常量(URL/SHA/bytes/**WS 端口**)
  `shared/obsAsset.ts`(Task 1),门测脚本与产品共用;两者都登记进
  `docs/predicate-index.md`(Task 7)。
- **`managedActive` 单源门**(本段核心不变量,Task 5 定义):
  `recordingEnabled && recordingMode==="managed" && process.platform==="win32"`。
  下载、spawn、进程轮询、websocket —— **一切托管副作用都由它守**。非 win32 或未启用:
  零子进程、零下载、零定时器。
- 录像失败只降级不上抛;托管实例录制期间绝不弹窗;gladlog 窗口不在录制期间主动
  `focus()`/`show()`。
- `<userData>/obs/**` 与 `<userData>/recordings/` 分开;录像绝不进 `matches/`。
- 每个 Task 一个 commit;分支 `worktree-obs-phase2`,不直推 main。
- **子代理工作目录纪律**:第一件事 `pwd` + `git -C <worktree> rev-parse --abbrev-ref HEAD`;
  全部 git 命令 `git -C` 绝对路径。

## 任务地图与依赖

```
Task 1  shared/obsAsset.ts + main/obsAssets.ts   (下载/校验/选择性解压)
Task 2  main/obsConfigWriter.ts                  (便携配置生成)
Task 3  main/managedObsProcess.ts + 门测收编      (spawn/日志就绪)← 真机往返,最多可能 4 次
Task 4  main/managedObsClient.ts + managedObsBackend.ts (连续录+分片+缩略图/黑帧)
Task 5  RecordingsStore 分片能力 + recorder 托管循环
Task 5b 装配层(index.ts 启动/退出序列)           ← 依赖 1-5
Task 6  设置 + UI(模式/下载进度/密码三件套)
Task 7  收尾(单源确认/§9.1 基线/predicate-index/删死 yml/文档)
```

Task 1、2 独立可先行;Task 3 真机往返期间做 Task 5/6。

---

### Task 1: OBS 资产获取 —— `shared/obsAsset.ts` + `main/obsAssets.ts`

设计文档 §5.1。

**Files:**

- Create: `packages/desktop/src/shared/obsAsset.ts`
- Create: `packages/desktop/src/main/obsAssets.ts`
- Test: `packages/desktop/src/shared/obsAsset.test.ts`
- Test: `packages/desktop/src/main/obsAssets.test.ts`(本地 http fixture,不碰真网)

**Interfaces(`shared/obsAsset.ts`,单源;门测脚本 Task 3/7 改为 import 这里):**

```ts
export const OBS_VERSION = "32.2.1";
export const OBS_ZIP_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/OBS-Studio-${OBS_VERSION}-Windows-x64.zip`;
export const OBS_ZIP_SHA256 =
  "db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de";
export const OBS_ZIP_BYTES = 187_817_017;
/** Managed instance's websocket port. 4466 (design doc 2.4): far from the
 * user's own OBS default 4455, verified free on the real machine. */
export const MANAGED_WS_PORT = 4466;

/** true = extract this zip entry. Blacklist style: default-extract, skip only
 * the known-big, known-unneeded payloads (CEF, pdb, scripting, extra locales).
 * ACCEPTS BOTH SEPARATORS — callers hand it paths from a directory walk, which
 * on win32 uses backslashes. */
export function shouldExtract(entryPath: string): boolean;
```

`shouldExtract` 实现(**第一行归一分隔符**,复核 B8):

```ts
export function shouldExtract(entryPath: string): boolean {
  const p = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/\.pdb$/i.test(p)) return false;
  if (/^obs-plugins\/64bit\/locales\//.test(p)) return false;
  if (
    /^obs-plugins\/64bit\/(libcef\.dll|chrome_elf\.dll|libEGL\.dll|libGLESv2\.dll|snapshot_blob\.bin|v8_context_snapshot\.bin|icudtl\.dat|vk_swiftshader.*|vulkan-1\.dll|.*\.pak)$/i.test(
      p,
    )
  )
    return false;
  if (/^obs-plugins\/64bit\/obs-browser/i.test(p)) return false;
  if (/^bin\/64bit\/obs-browser-page\.exe$/i.test(p)) return false;
  if (/^data\/obs-scripting\//.test(p)) return false;
  const loc = /^data\/obs-studio\/locale\/(.+)\.ini$/.exec(p);
  if (loc) return loc[1] === "en-US" || loc[1] === "zh-CN";
  return true;
}
```

**Interfaces(`main/obsAssets.ts`):**

```ts
export interface ObsInstallProgress {
  phase: "downloading" | "verifying" | "extracting" | "done";
  loaded?: number;
  total?: number;
}
export interface ObsAssets {
  root: string; // <userData>/obs/32.2.1
  installed(): boolean;
  /** win32 only — throws "managed recording is Windows-only" elsewhere (复核 M12)。
   * Download (Range resume), verify SHA-256, selectively extract, write
   * .complete marker, DELETE the zip on success (saves 179MB; a reinstall
   * re-downloads — acceptable, it is a rare path). Concurrent calls coalesce. */
  ensureInstalled(onProgress: (p: ObsInstallProgress) => void): Promise<void>;
}
export function createObsAssets(deps: {
  userDataDir: string;
  fetchImpl?: typeof fetch;
  /** injected for tests; default = spawnSync("tar", ["-xf", zip, "-C", dest])
   * with a 120s timeout. REASON it is injectable: ubuntu CI's GNU tar cannot
   * read zip (bsdtar on mac/win can) — unit tests stub this and assert the
   * args; the real path runs only on win32 (复核 B7)。 */
  extractImpl?: (zipPath: string, destDir: string) => void;
}): ObsAssets;
```

磁盘预检:zip 179MB + 全量临时树 ~489MB + 最终 ~115MB ⇒ 峰值 ~783MB(复核 M4),
`ensureInstalled` 开始前检查可用空间 ≥ 1GB。

- [ ] **Step 1: `shouldExtract` 失败测试** —— 提取:`bin/64bit/obs64.exe`、
      `obs-plugins/64bit/win-capture.dll`、`data/obs-plugins/win-capture/graphics-hook64.dll`、
      `bin/64bit/obs-ffmpeg-mux.exe`、`data/obs-studio/locale/zh-CN.ini`;
      跳过:`bin/64bit/obs64.pdb`、`obs-plugins/64bit/libcef.dll`、
      `obs-plugins/64bit/locales/af.pak`、`data/obs-scripting/obslua.dll`、
      `data/obs-studio/locale/fr-FR.ini`;
      **反斜杠输入**:`bin\\64bit\\obs64.exe` 提取、`obs-plugins\\64bit\\libcef.dll` 跳过。
- [ ] **Step 2: 跑失败 → 实现 shared/obsAsset.ts → 跑通过**
- [ ] **Step 3: `obsAssets` 失败测试**(fetchImpl 指本地 `node:http` fixture;
      extractImpl 用 stub:记录参数并往 dest 写一棵含混合命中/跳过条目的假树):
      ①全新下载→SHA 校验→extractImpl 收到 zip 与临时目录→最终目录只含
      `shouldExtract` 通过的文件→`.complete` 写出→zip 被删;
      ②哈希不符→抛用户可读错误且删坏文件;
      ③预置半截 `.part`→fixture 断言收到 `Range: bytes=<n>-`;
      ④并发两次 `ensureInstalled` 只触发一次下载;
      ⑤`installed()` = `.complete` 存在 **且** `bin/64bit/obs64.exe` 存在;
      ⑥非 win32 调 `ensureInstalled`(测试里注入 platform)→ 抛 Windows-only。
- [ ] **Step 4: 跑失败 → 实现 main/obsAssets.ts → 跑通过 + typecheck**
- [ ] **Step 5: Commit** `"feat(desktop): OBS 资产获取 —— 钉死版本下载/续传/SHA/选择性解压;extractImpl 注入避开 CI 的 GNU tar"`

---

### Task 2: 便携配置生成 —— `main/obsConfigWriter.ts`

设计文档 §5.2 表格 + 复核 I8/I9/M3。

**Files:**

- Create: `packages/desktop/src/main/obsConfigWriter.ts`
- Test: `packages/desktop/src/main/obsConfigWriter.test.ts`

**Interfaces:**

```ts
export interface ObsConfigSpec {
  obsRoot: string;
  recDir: string; // 先 mkdirSync 再写进 ini(真机 C:/ 根不可写的教训)
  wsPort: number; // MANAGED_WS_PORT
  wsPassword: string;
  bitrateKbps: number; // 默认 8000(U2)
}
export function writeObsConfig(spec: ObsConfigSpec): void; // 幂等,同 spec 同字节
export function clearSentinels(obsRoot: string): void; // 每次 spawn 前调
```

**文件与内容**(路径一律正斜杠写入 ini):

| 文件                                        | 内容                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `<obsRoot>/portable_mode.txt`               | 空                                                                                                                               |
| `config/obs-studio/user.ini`                | `[General] FirstRun=true`;`[Basic] Profile=gladlog / ProfileDir=gladlog / SceneCollection=gladlog / SceneCollectionFile=gladlog` |
| `config/obs-studio/global.ini`              | `[General] LastVersion=32.2.1`                                                                                                   |
| `plugin_config/obs-websocket/config.json`   | `{first_load:false, server_enabled:true, server_port, server_password, auth_required:true, alerts_enabled:false}`                |
| `basic/profiles/gladlog/basic.ini`          | 见下                                                                                                                             |
| `basic/profiles/gladlog/recordEncoder.json` | `{rate_control:"CBR", bitrate:<bitrateKbps>, keyint_sec:1}`                                                                      |
| `basic/scenes/gladlog.json`                 | 一个空场景 `gladlog`(采集源运行时经 websocket 建)                                                                                |

`basic.ini` 逐键(复核 I8:**两个自动阈值显式清零**;M3:Video 键名写全):

```ini
[General]
Name=gladlog

[Output]
Mode=Advanced

[AdvOut]
RecType=Standard
RecFilePath=<recDir 正斜杠>
RecFormat2=hybrid_mp4
RecEncoder=obs_x264
RecTracks=1
RecSplitFile=true
RecSplitFileType=Manual
RecSplitFileTime=0
RecSplitFileSize=0

[Video]
BaseCX=1920
BaseCY=1080
OutputCX=1920
OutputCY=1080
FPSType=0
FPSCommon=60
AutoRemux=false
```

> **音频(U4,复核 I9)**:默认只录桌面音、不录麦克风。OBS 的全局音频设备键在
> profile `basic.ini` 里,但**确切键名本计划不猜** —— 实现前用
> `gh api` 读 obs-studio 32.2.1 `frontend/widgets/OBSBasic.cpp` 的音频默认段
> (搜 `Desktop1`/`Mic1`/`AuxDevice`)确认"桌面音默认开、Mic/Aux 显式禁用"的
> 键与值,把出处(文件:行)写进代码注释。**验收(真机,Task 3 的门测顺带)**:
> OBS 日志的音频设备段只有 desktop 一路,无 Mic/Aux。麦克风开关 UI 挂第 2 段。
> **失败分支(复核 I9)**:源码查不到确切键 → 本段不写音频键,把「默认会带 Mic」
> 风险记 ledger 挂第 2 段 —— 宁可多录一路也不写猜的键。查到后回补 Step 1 断言。

- [ ] **Step 1: 失败测试** —— temp 目录调用后逐文件断言:websocket config.json 逐键;
      basic.ini 含 `Mode=Advanced`、`RecSplitFile=true`、`RecSplitFileType=Manual`、
      **`RecSplitFileTime=0`、`RecSplitFileSize=0`**、`RecEncoder=obs_x264`、
      `AutoRemux=false`、`RecFilePath` 为正斜杠 recDir、`[Video]` 六键;
      recordEncoder.json 的 `keyint_sec===1`;幂等(写两次字节相同);
      `clearSentinels` 只删 `.sentinel/run_*`;recDir 被创建。
- [ ] **Step 2: 跑失败 → 实现(含音频键的源码查证)→ 跑通过 + typecheck**
- [ ] **Step 3: Commit** `"feat(desktop): 托管 OBS 便携配置生成 —— 手动分片阈值清零 + 桌面音单路 + 哨兵清理"`

---

### Task 3: 进程托管 —— `main/managedObsProcess.ts`(+门测收编)

设计文档 §5.4/§5.6 + 真机教训 2、4 + 复核 B6/I5/I6/I7。**唯一需真机往返的任务,
最多可能 4 次往返(单变量实验),排期按此准备(复核 M11)。**

**Files:**

- Create: `packages/desktop/src/main/managedObsProcess.ts`
- Test: `packages/desktop/src/main/managedObsProcess.test.ts`
- Modify: `packages/desktop/scripts/obsGateCheck.ts`

**Interfaces:**

```ts
export interface ManagedObsHandle {
  /** resolves when the OBS LOG confirms readiness. NEVER a bare TCP probe.
   * Requires "Portable mode: true" AND a line matching
   * /obs-websocket.*erver started/ (tolerant regex; the literal line
   * "Server started successfully on port 4466" — 真机 2026-08-04 12:21 日志
   * 原文,已录入 stage0 ledger). */
  ready: Promise<{ wsUrl: string }>;
  onLogLine(cb: (line: string) => void): () => void;
  /** async graceful stop: 3s for clean exit then taskkill /pid /T /F */
  stop(): Promise<void>;
  /** SYNC kill for exit paths that cannot await (SIGINT handlers) — 复核 I5 */
  killSync(): void;
  exited(): { code: number | null; signal: string | null } | null;
  pid(): number | null;
}
export function spawnManagedObs(spec: {
  obsRoot: string;
  wsPort: number;
  spawnImpl?: typeof spawn;
  now?: () => number;
  readinessTimeoutMs?: number; // default 30_000
  /** GATE-SCRIPT ONLY (复核 I6 单变量纪律):第一次真机跑保留脚本原有的
   * --websocket_port/--websocket_password 两个 flag,经此传入;产品路径不用。 */
  extraArgs?: string[];
}): ManagedObsHandle;
```

**实现要点:**

1. spawn:exe 绝对路径,`cwd = <obsRoot>/bin/64bit`,argv 数组无 shell:
   `--portable --multi --only-bundled-plugins --minimize-to-tray
--disable-updater --disable-missing-files-check
--collection gladlog --profile gladlog --scene gladlog --websocket_ipv4_only`。
   密码不过命令行(在 config.json 里;也避免任务管理器可见)。
2. **就绪 = 只认 spawn 之后新出现的日志文件**(复核 B6):spawn 前快照
   `logs/` 文件名集合;500ms 轮询,只读**新文件**(或 mtime > spawnAt),按字节
   offset 增量读(UTF-8);见 `Portable mode: true` **且** 宽容正则的 websocket
   启动行 → resolve;见 `Portable mode: false` → reject("便携模式未生效");
   超时 → reject 附新日志尾 20 行(没有新文件 = "OBS 未产出日志",单列)。
   **测试里必须有:目录预置一份含全部关键字的旧日志 → 不得 resolve。**
3. 生命周期:`child.on("error")` 挂 handler;`process.on("exit")` 与 Electron
   `will-quit` 挂 `killSync`;`stop()` 先给 3s 再 `taskkill /pid <pid> /T /F`。
   (Windows job object 纯 Node 不可得;taskkill 树杀 + 退出钩子是可达近似,
   差距记 ledger。)
4. **门测收编 = 真机实验,单变量纪律(复核 I6)**:第一次真机跑**只**把脚本的
   spawn/就绪段换成本模块,**脚本原有的 `--websocket_port/--websocket_password`
   两个 flag 原样保留传入**(通过 spec 的可选 extraArgs,产品路径不用);密码来源
   切到 config.json 是**第二次**跑的变量。若 spawn 后 30s 无新日志,依次单变量
   实验:①去掉 `--minimize-to-tray` ②`stdio: ["ignore","pipe","pipe"]` 并打印
   ③`detached: true`。定位结果写模块注释 + ledger;**定位前不许把嫌疑写死**。
5. 脚本的 SIGINT 同步路径改用 `killSync()`;`exitCode` 归因保留(走 `exited()`)。

- [ ] **Step 1: 失败测试**(fake spawn + temp 日志目录):①新日志出现两关键行 →
      ready resolve,wsUrl=`ws://127.0.0.1:<port>`;②**旧日志含关键行、无新文件 →
      超时 reject 且信息为"未产出日志"**;③新日志只有 `Portable mode: false` →
      reject 含"便携";④增量读:同一行不重复回调;⑤stop() 走 killImpl;
      ⑥killSync 同步可调;⑦exited() 反映 fake child 退出。
- [ ] **Step 2: 跑失败 → 实现 → 跑通过 + typecheck**
- [ ] **Step 3: 门测脚本收编**(spawn/就绪段换本模块;常量 import 自
      `shared/obsAsset.ts`;配置生成段换 `writeObsConfig`(复核 M2);SIGINT 用
      killSync)。eslint + mac 守卫(打印 Windows-only、exit 2)。
- [ ] **Step 4: Commit** `"feat(desktop): 托管 OBS 进程 —— 仅认新日志的就绪信号 + 同步/异步双杀;门测收编单一实现"`
- [ ] **Step 5(真机,用户跑;结果回来前 Task 5b 不合入)**:
      `git pull && npm run recorder:gatecheck …`。预期:spawn 谜题当场定位或通过;
      顺带验:裁剪后的树能起(Task 1 的 SKIP 清单回退协议:起不来就缩清单,每缩
      一项记 ledger)、音频段无 Mic/Aux、`RecordFileChanged` 分片行、码率实测、
      **自动分片确已关闭**(录满超过 OBS 默认阈值的时长,断言零个未请求的
      `RecordFileChanged` —— 复核 I8:阈值键写错时对局会被中途切,文件断言测不出)。

---

### Task 4: websocket 薄壳 + 托管 backend

设计文档 §5.5/§6/§7.1-7.2 + 复核 I3/B5/M6/M9。

**Files:**

- Create: `packages/desktop/src/main/captureBackend.ts`(接口,设计 §6 修订版逐字)
- Create: `packages/desktop/src/main/managedObsClient.ts`(**新**,复核 I3)
- Create: `packages/desktop/src/main/managedObsBackend.ts`
- Create: `packages/desktop/src/shared/blackFrame.ts`(纯函数,黑帧判定)
- Test: `packages/desktop/src/main/managedObsBackend.test.ts`、
  `packages/desktop/src/shared/blackFrame.test.ts`

**Interfaces:**

```ts
// captureBackend.ts —— 设计 §6 修订版;本段接受单实现 seam(复核 I2):旁路保留
// 一期状态机不经此接口,双实现统一挂账第 2 段(旁路退役评估时一并做)。
export interface CaptureChunk {
  videoPath: string;
  startedAt: number;
  stoppedAt: number | null;
}
export interface BackendHealth {
  ready: boolean;
  encoder: string | null;
  sourceActive: boolean;
  lastError: string | null;
}
export interface CaptureBackend {
  startContinuous(): Promise<void>;
  stopContinuous(): Promise<CaptureChunk | null>;
  splitChunk(): Promise<CaptureChunk | null>;
  onChunkOpened(cb: (c: CaptureChunk) => void): () => void; // 返回退订(复核 M9)
  /** hybrid_mp4 章节标记,U3;失败静默(纯增强) */
  markChapter(name: string): Promise<void>;
  probe(): Promise<BackendHealth>;
  shutdown(): Promise<void>;
}

// managedObsClient.ts —— obs-websocket-js 的最小面,fake 按此写
export interface ManagedObsWs {
  connect(url: string, password: string): Promise<void>;
  call(
    req: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  on(event: string, cb: (data: Record<string, unknown>) => void): void;
  disconnect(): Promise<void>;
}
export function realManagedObsWs(): ManagedObsWs;

// managedObsBackend.ts
export function createManagedObsBackend(deps: {
  ensureProcess: () => Promise<{ wsUrl: string; wsPassword: string }>;
  recDir: string;
  clientFactory?: () => ManagedObsWs;
  now?: () => number;
}): CaptureBackend & {
  /** first-connect setup: create the game_capture input + take a probe
   * screenshot for black-frame detection. Encoder is PINNED obs_x264 in
   * stage 1 (no websocket enumeration API exists — design doc 2.5;
   * NVENC selection is a stage-2 item driven by Task 3's log tail). */
  configureSession(): Promise<void>;
  /** SaveSourceScreenshot → shared/blackFrame 判定;结果进 probe().sourceActive */
  captureProbe(): Promise<{ shotPath: string; black: boolean }>;
};
```

**实现要点(设计 §2.5 的源码级事实,一条都不能松):**

1. 事件监听在 `StartRecord` **之前**挂好;分片路径**只**从
   `RecordFileChanged.newOutputPath` 拿;首分片从 `RecordStateChanged`(STARTED
   带 outputPath,未文档化行为)拿,**兜底扫 recDir 取最新 mp4**;
   **绝不读 `StopRecord.outputPath`**(fake 里设毒值,读了就炸)。
2. `startedAt` = 分片开启事件到达墙钟;`stoppedAt` 在下一分片/停止时盖。
3. `splitChunk()`:`SplitRecordFile` → 等 `RecordFileChanged`(5s 超时)→ 返回
   被关闭分片。`markChapter` = `CreateRecordChapter {chapterName}`(仅 hybrid_mp4,
   正是我们的容器;失败吞)。
4. 所有调用包 15s 超时;失败进 `lastError`;`probe()` 上报。
5. `shared/blackFrame.ts`:输入 PNG buffer(或解码后的亮度数组 —— 实现者定,但
   必须纯函数可喂固定数据),输出 `black: boolean`(阈值:平均亮度 < 8/255 且
   高亮像素占比 < 0.5%);单测喂全黑/正常/暗场三组固定数据。
6. 缩略图/黑帧的 UI 展示挂第 2 段;本段产出能力 + probe 上报(设计 §7.1-7.2 的
   采集侧;§7.5 RDP 识别挂账 ledger)。

- [ ] **Step 1: blackFrame 失败测试 → 实现 → 通过**
- [ ] **Step 2: backend 失败测试**(fake ManagedObsWs 发假事件):监听先于
      StartRecord(fake 断言顺序);首分片 STARTED 事件路径 + 兜底扫描;split 等
      事件才 resolve、超时进 lastError;分片链条 stoppedAt 正确;StopRecord.outputPath
      毒值不被读;markChapter 失败静默;onChunkOpened 退订生效;captureProbe 调
      SaveSourceScreenshot 且黑帧判定进 sourceActive。
- [ ] **Step 3: 跑失败 → 实现 → 通过 + typecheck**
- [ ] **Step 4: Commit** `"feat(desktop): 托管 backend —— 连续录+定点分片+章节标记+黑帧探针;分片路径只信 RecordFileChanged"`

---

### Task 5: `RecordingsStore` 分片能力 + recorder 托管循环

设计 §5.5/§5.6 + 复核 B2/B3/B4/I1/I4/I16/M8。

**Files:**

- Modify: `packages/desktop/src/main/recordingsStore.ts` + `recordingsStore.test.ts`
- Create: `packages/desktop/src/main/wowProcessWatch.ts` + 测试
- Modify: `packages/desktop/src/main/recorder.ts` + `recorder.test.ts`
- Modify: `packages/desktop/src/main/workerMessageHandler.ts`(仅当签名真变;现有
  `Pick<…,"associate"|"onSegmentOpen"|"onSegmentClose">` 已复核确认够用)

**5a. RecordingsStore 增 open/close 分片(复核 B3 —— 现有 `add()` 是无去重
appendFileSync,没有按 videoPath 更新的能力;直接用会造出同路径双行,prune 双计
字节且驱逐时误删另一行还指着的文件):**

```ts
/** Upsert by videoPath: open writes {schema:2, videoPath, startedAt, stoppedAt:null,
 * matchIds:[]} — if a row with the same videoPath exists, it is REPLACED, never
 * duplicated. */
openChunk(videoPath: string, startedAt: number): void;
/** Sets stoppedAt on the row with this videoPath; missing row → create closed row
 * (crash-recovery path). */
closeChunk(videoPath: string, stoppedAt: number): void;
```

`prune` 孤儿分支加**宽限期**(复核 B4 —— 托管模式每场+每 10 分钟切刀,孤儿会瞬间
超过 `ORPHAN_KEEP_CAP=2`,meta 还在路上的分片会被删):

```ts
export const ORPHAN_GRACE_MS = 10 * 60_000; // 设计 §5.5 的 10 分钟宽限期
// 孤儿分支:stoppedAt !== null 且 (now - stoppedAt) < ORPHAN_GRACE_MS 的一律保留,
// 不占 ORPHAN_KEEP_CAP 名额;prune 签名加 now?: () => number 便于测试
```

测试:①openChunk 两次同路径不产生第二行;②open→close 单行闭合;③close 无行时
建闭合行;④宽限期内孤儿造 5 个全保留、期外的按 CAP 驱逐;⑤`stoppedAt:null` 行
仍不参与驱逐(既有语义回归)。

**5b(本 Task 内). wowProcessWatch:**

```ts
export function createWowProcessWatch(deps: {
  /** default: tasklist probe matching PROCESS_NAMES */
  probe?: () => Promise<boolean>;
  intervalMs?: number; // 2000(arenacoach 同款)
  onUp: () => void;
  onDown: () => void;
}): { start(): void; stop(): void };
export const WOW_PROCESS_NAMES = ["Wow.exe", "WowClassic.exe", "WowT.exe"]; // 复核 M8
```

抖动防护:连续 2 次 miss 才算 down;单次探测异常不触发状态变化。

**5c. recorder 托管循环:**

**`managedActive` 单源门(复核 B2)** —— recorder 内一处定义、一处消费:

```ts
// EXPORT 的单源谓词(复核 NEW-2):recorder 与 index.ts(Task 5b)都 import,
// 谁都不许手抄第二份三项与式 —— 那是 CLAUDE.md 点名的头号故障类。
export function isManagedActive(
  s: Pick<GladlogSettings, "recordingEnabled" | "recordingMode">,
): boolean {
  return (
    s.recordingEnabled &&
    s.recordingMode === "managed" &&
    process.platform === "win32"
  );
}
```

语义循环(全部由 `managedActive` 守;false 时 watcher 不启动、backend 不创建):

```
WoW up            → backend.startContinuous();onChunkOpened → recordings.openChunk
segmentOpen       → 暂停空闲分片定时器;backend.markChapter(`match ${bracket}`)(U3)
segmentClose 之后 → backend.markChapter(`match end`) → backend.splitChunk() → closeChunk(被关分片)+ 重启空闲定时器
空闲每 10 分钟     → backend.splitChunk()(斗内绝不切 —— open 后定时器是停的)
WoW down          → backend.stopContinuous() → closeChunk 尾分片
meta 到达          → recordings.associate(第 0 段多场逻辑,原样)
每次 closeChunk 后 → pruneNow()(双闸 + 新宽限期)
associate 命中后    → 若 meta.startTime < chunk.startedAt(负 headroom,两场间隔
                     小于日志滞后等例外)→ log.warn 一行含两个时刻(设计 §5.5
                     「如实记录不许静默」;复核 I16)——进 Step 3 测试
MAX_CHUNK_MS = 40min(复核 I4:一期 SAFETY_STOP_MS 的转世):分片开启时 arm,
  超时 → splitChunk + log.warn("单分片超 40 分钟,已强制分片");close 时 clear。
```

**旁路模式完整保留**(模式分流,不做统一抽象 —— 复核 I2 的声明:本段接受
CaptureBackend 单实现 seam,双实现挂第 2 段):`weStartedRecording` /
`reconcileWithReality` / `closeOrphanRecording` / `testConnection`(含
`client = null` 修复)全部原样;**`connectAtStartup` 在托管模式下 no-op**
(复核 I1 —— 否则每次启动去连用户的 4455 并把失败写进 lastError)。

**接线形状(复核 NEW-1,归属一次说死)**:watcher 由 **Task 5b 创建**,
recorder 只吃回调。`createRecorderService` 的 deps 扩展为:

```ts
deps: {
  …现有五项不动…
  /** managed mode only; injected by Task 5b. undefined = bypass-only (mac/CI). */
  managedBackend?: CaptureBackend;
}
// RecorderService 新增成员(5b 把 watch 回调接到这两个上):
onWowUp(): void;
onWowDown(): void;
```

5b 负责 `createWowProcessWatch({ onUp: () => recorder.onWowUp(), onDown: … })`
并 start;recorder **不**自建 watcher。5b Step 1 顺序断言里点名
「watcher 只被 start 一次」。

状态语义:托管模式 `connected` = 进程 ready 且 ws 活;`recording` =
startContinuous 生效中。第 0 段横幅谓词不变即正确。

- [ ] **Step 0: 执行时 grep** —— `RecorderService` 全部消费点、`RecorderSettings`
      全部构造点(**不要信计划里的计数**),列进报告。
- [ ] **Step 1: 5a 测试 → 实现 → 通过**
- [ ] **Step 2: watch 测试(up/down/抖动/stop)→ 实现 → 通过**
- [ ] **Step 3: 托管循环测试**(fake backend + fake watch + fake settings):
      ①managedActive=false(未启用 / external / 非 win32 三例)→ 零 watcher 零
      backend;②up→startContinuous、chunk 开启→openChunk;③segmentOpen 后空闲
      定时器停,期间**绝不** split;④close 后 split→closeChunk→pruneNow;
      ⑤空闲 10 分钟→split;⑥down→stopContinuous→尾分片 close;⑦MAX_CHUNK_MS
      超时→强制 split + warn;⑧backend 全程抛错→只 lastError,associate/入库
      不受影响;⑨托管模式下 connectAtStartup no-op;⑩旁路旧测试**零断言改动**。
- [ ] **Step 4: 实现 → 全绿(`npx vitest run src/ test/`)+ typecheck + Commit**
      `"feat(desktop): recorder 托管循环 —— managedActive 单源门 + 分片账本 upsert + 孤儿宽限期;旁路零改动"`

---

### Task 5b: 装配层 —— `main/index.ts` 启动/退出序列(复核 B1)

**Files:** Modify `packages/desktop/src/main/index.ts`、`quitLifecycle.ts`(如需)、
`ipc.ts` + `preload/api.ts` + `preload/index.ts`(安装触发与进度事件)

**启动序列(whenReady 内,现有 recorder 装配处扩展;全部由 `managedActive` 守):**

```ts
const assets = createObsAssets({ userDataDir: userData() });
// 1) 模式判定:!managedActive → 只装配旁路(现状),到此为止
// 2) 密码:settings.managedWsPassword ?? 生成 32 hex 随机 → save(加密,Task 6)
// 3) 已安装? assets.installed() 为 false 时【不自动下载】——
//    等 renderer 的「下载并启用」动作触发(设计 §5.1 是首次运行下载,但下载
//    179MB 必须是用户可见的动作,不是静默后台;进度经 IPC 推)
// 4) 已安装:writeObsConfig({obsRoot, recDir, wsPort: MANAGED_WS_PORT,
//    wsPassword, bitrateKbps: 8000}) → clearSentinels → handle = spawnManagedObs
// 5) backend = createManagedObsBackend({ ensureProcess: async () => {
//      await handle.ready; return { wsUrl, wsPassword }; }, recDir })
// 6) await backend.configureSession()(失败进 lastError,不阻塞 app)
// 7) 启动 wowProcessWatch(接 recorder 托管循环)
```

**退出序列(复核 NEW-4,三点写死)**:

1. 优雅序列一律走现有 `before-quit` 链的 `stopRecorder` 闭包 —— 托管拆解放进
   `recorder.stop()` 内部(托管模式:`backend.stopContinuous()` 落尾分片 →
   `backend.shutdown()` → `handle.stop()`;旁路:现状不动)。`will-quit` 与
   `process.on("exit")` **只挂同步 `handle.killSync()`** 兜底。
2. `QuitLifecycleDeps.timeoutMs` 类型改 `number | (() => number)`(现在是模块
   作用域构造时定死的静态值;按模式取值必须变 getter),托管 8s、旁路 4s;
   `quitLifecycle` 测试相应补例。
3. 装配层把 `handle`/`backend` 经 deps(5c 的 managedBackend 等)注入 recorder,
   供 `recorder.stop()` 使用。

**IPC 面:** `recorder:installObs`(触发 ensureInstalled,进度经
`gladlog:recorder:installProgress` 推);现有 status 事件扩展为**真正消费
`backend.probe()`**(复核 NEW-9:黑帧结果与 sourceActive 进 status 载荷,
第 0 段的设置页状态行就是接收方 —— 不留零消费者能力)。`onLogLine` 本段确实
无订阅者,按 I2 同款口径显式声明:数据源能力,第 2 段 NVENC 接线。

**运行时切换(复核 NEW-3 —— 否则「装了就自动录」要重启才成立)**:
`settings:save` 后比较新旧 `isManagedActive`:false→true 跑装配序列(3-7 步),
true→false 跑退出序列。装配序列必须幂等/防重入(已在跑则 no-op)。进 Step 1 测试矩阵。

- [ ] **Step 1: 失败测试**(index.ts 的装配逻辑抽成可测函数
      `assembleManagedRecording(deps)`,fake 全部依赖):①未安装 → 不 spawn、
      不下载,状态报"待安装";②已安装 → 配置写入→spawn→configureSession→watch
      启动的顺序;③configureSession 抛错 → app 不崩、lastError 置位;
      ④managedActive=false → 全程零调用;⑤退出序列的顺序与 8s 上限。
- [ ] **Step 2: 实现 → 全绿 + typecheck;ubuntu E2E 全绿(非 win32 零副作用的
      真实验证 —— CI 就是 ubuntu)**
- [ ] **Step 3: Commit** `"feat(desktop): 托管录像装配 —— 显式下载动作/启动退出序列/quitLifecycle 托管 8s"`

---

### Task 6: 设置 + UI

设计 §5.1/§5.7/§8 + 复核 I12/I13/I14/I15/M5。

**Files:** Modify `settingsStore.ts`、`settingsStore.recording.test.ts`、
`test/settingsStore.test.ts`、`recorder.test.ts`、`fixtureBridge.ts`、
`SettingsPanel.tsx`;Create `SettingsPanel.managed.test.tsx`

**设置字段:**

```ts
/** "managed"(默认)| "external"。非 win32 上 UI 禁用 managed 并说明,
 * 解析谓词(managedActive)恒判 external 语义 —— 即 mac 用户仍可用一期的
 * 自有 OBS 外控。这与设计 §8 的「非 win32 强制 recordingEnabled=false」是
 * 【有意偏离】:保留 mac 的旁路能力更合理,偏离在此声明(复核 I15)。 */
recordingMode: "managed" | "external";
managedWsPassword: string | null; // 默认 null,首次启用托管时生成
```

**`managedWsPassword` 三件套(复核 I14,一条都不能少):**

1. 进 `SECRET_FIELDS` 元组(否则明文落盘);
2. `redactSettings` 遮它(否则明文过 IPC 进 renderer);
3. `sanitizeSettingsPatch` 加哨兵剥离(照 `obsWebsocketPassword` 的既有形状)。

**UI:**

- 「对局录像」组:模式选择;managed 未安装时显示
  「下载 OBS(<从 OBS_ZIP_BYTES 推导的 MB 数>,来自 obsproject 官方,GPL-2.0,
  [链接])」按钮 + 进度条(吃 installProgress 事件)+ 失败重试;
  external 时一期表单原样。
- 非 win32:managed 选项**显示为禁用态并带说明**「托管录像仅支持 Windows」,
  实际选中态落在 external(复核 NEW-7 —— 否则 mac 首屏选中一个禁用项);
  `SettingsPanel.managed.test.tsx` 断言这一呈现。
- 配额文案修正(第 0 段挂账):「最近 N 场。设为 0 只关闭场数上限,总容量上限
  (默认 80GB)仍然生效,超限时连视频文件一并删除。」
- **fixtureBridge 补 `recorder` 面**(复核 I12:现在零命中,状态行/新 UI 进不了
  视觉基线):`getStatus/onStatus/installObs stub + 固定状态`,让 settings 场景
  渲染出状态行与模式选择。

- [ ] **Step 1: 执行时 grep 全部 settings/RecorderSettings 构造点 → 失败测试**
      (默认值与迁移;三件套各一断言:落盘密文、redact 后为哨兵、patch 哨兵剥离;
      SettingsPanel 两模式显隐 + 未安装态按钮 + 进度渲染;非 win32 禁用态)
- [ ] **Step 2: 实现 → 全绿 + typecheck → Commit**
      `"feat(desktop): 录像模式设置(托管默认/旁路保留)+ 下载进度 UI + 密码三件套 + fixture recorder 面"`

> 视觉基线必变:CI 重生成(第 0 段同款流程),本机绝不跑 test:visual。

---

### Task 7: 收尾

- [ ] **Step 1: 单源确认** —— 门测脚本的常量/配置/spawn 全部 import 产品模块,
      脚本内不残留第二份 URL/SHA/flag/端口/配置生成;eslint + mac 守卫。
- [ ] **Step 2: `docs/predicate-index.md` 登记** `shared/obsAsset.ts` 与
      `shared/videoTime.ts`(第 0 段漏登,复核 M10),按该文档既有格式;跑
      `packages/eval/test/predicateIndex.test.ts` 确认绿。
- [ ] **Step 3: §9.1 基线(复核 I11 的可算版)**:落成 `scripts/headroomBaseline.ts` **并留下**(复核 NEW-8:
      CLAUDE.md 明令不留一次性脚本;二期收官算「后」时复用同一判据):读 `<userData>/recordings/recordings.ndjson`,孤儿行跳过,有
      `matchIds` 的行经 matchStore 读 meta.startTime,
      `computeVideoWindow({matchStartMs: meta.startTime, …}).headroomS` 逐条算,
      报中位数/分布进 ledger;**本机无该文件则如实记"无一期数据,基线为空"**。
      同步更新 `videoTime.ts` 头部注释的消费者清单(别再留过期声明)。
- [ ] **Step 4: 删 `packages/desktop/electron-builder.yml`**(设计 §8 的雷,复核 M7)。
      「`npmRebuild`/`files` 故意留默认」写进 `docs/BUILD-WINDOWS.md` **及其
      `.zh-CN` 版**(JSON 加不了注释 —— 复核 NEW-5;该文件在双语成对清单里)。
- [ ] **Step 5: 设计文档回填**(含三个已获用户确认的偏离:§0 拍板表加修订行、
      §5.1 下载改用户可见动作、§8 非 win32 保留旁路)—— §3 门标注
      "2026-08-04 真机已过";§5.3 编码器段
      改为"第 1 段钉死 obs_x264,NVENC 挂第 2 段"(消除与 §2.5 的自相矛盾);
      完成定义的 headroom 措辞对齐 §5.5 原话(恒正,例外显式记录 —— 含复核 I16
      指出的第二类例外:两场间隔小于日志滞后时切刀晚于真实开场)。
- [ ] **Step 6: `npm run presubmit` 全绿 + Commit**
      `"chore(desktop): 第 1 段收尾 —— 单源/谓词索引/headroom 基线/删死 yml/文档回填"`

---

## 完成定义(全段)

1. **Windows 真机**:WoW 启动 → 自动连续录(零 OBS 安装/配置);打一场 → 录像 tab
   出现该场且 headroom 为正(例外按设计 §5.5 显式记录,含两场间隔小于日志滞后的
   情形);gladlog 退出 → OBS 进程消失,无孤儿;首次启用走可见的下载动作 + 进度。
2. **mac / CI**:全部单测绿;非 win32 零子进程、零下载、零定时器(ubuntu E2E 即
   验证);冷启动预算不受影响。
3. **已知余项(记 ledger,不阻塞)**:NVENC 选择(第 2 段,靠 Task 3 日志尾);
   缩略图/黑帧的 UI 展示;RDP 识别;麦克风开关;CaptureBackend 双实现统一;
   spawn 谜题定位结论(Task 3 真机实验产出);job object 与 taskkill 的差距;
   **杀软/SmartScreen 误报观察**(设计 §7.4 —— 注入 DLL 与 helper exe 首次由
   gladlog 触发;Task 3 真机跑时顺带记录有无拦截,系统性测试挂第 2 段)。
