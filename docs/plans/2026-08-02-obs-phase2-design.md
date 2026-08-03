# OBS 录像二期(内嵌 noobs)设计

2026-08-02。对应 backlog #1 的二期。前置文档:评估
`docs/plans/2026-07-27-obs-recording-integration-eval.md`、一期计划
`docs/plans/2026-07-28-obs-recording-phase1-plan.md`。

**本文是设计,不是实施计划**;实施计划另出。

---

## 0. 拍板记录

| 问题                                          | 用户决定                                                 |
| --------------------------------------------- | -------------------------------------------------------- |
| 二期要解决的痛点                              | **零配置**(不想再装配 OBS)+ **缺头**(开场前几十秒没录到) |
| 许可(内嵌 libobs = 发行二进制受 GPL-2.0 约束) | 接受 —— gladlog 本来就开源公开                           |
| 采集端路线                                    | **B:内嵌 noobs**                                         |
| 第 0 段做完是否单独发版                       | 否,整个二期做完一起发                                    |
| 真机验证方式                                  | Windows 自检命令 + 少数几次人工跑;不走一期那种多轮测试包 |

---

## 1. 目标与非目标

**目标**

1. 用户装了 gladlog 就自动录竞技场,**不需要安装或配置 OBS**。
2. 录像**覆盖开场之前**若干秒(默认 5s),消除缺头。
3. 回放里点死亡 / finding / 爆发窗,视频跳到的是**该事件本身**,不是它之后几秒。

**非目标(本期明确不做)**

- macOS 录像(noobs 实质 Windows-only;mac 另有 TCC 权限 + 公证硬阻塞)。
- 跨机视频搬运(录像仍是游戏机本机特性,与一期一致)。
- noobs 的原生预览窗(`InitPreview`,理由见 §7)。
- 转码/压制/剪辑导出。

obs-websocket 外控的去留**不在非目标里,是待定项** —— 见 §10 U1。

---

## 2. 已实测的前置事实

这一节的每条都是本次实地验证的结果,**与评估文档(2026-07-27)所写不同**,是本设计的地基。

### 2.1 noobs 是 GPL-2.0,不是 LGPL-2.0

npm 元数据写 `LGPL-2.0`,但包里 `COPYING` 是 GNU GPL v2 全文,README 的 License
一节写 `GPL-2.0`,GitHub licensee 识别为 GPL-2.0,它链接的 libobs
(`aza547/warcraft-recorder-obs-studio`,fork 自 `obsproject/obs-studio`)也是 GPL-2.0。

评估文档 §3B 据 npm 字符串写下的「作为动态链接的 npm 依赖使用无碍」**前提不成立**。
gladlog 源码是 MIT(`LICENSE`,`README.md:46-48`)。MIT 与 GPL 兼容,因此可以在保持
源码 MIT 的同时,把**分发的安装包**按 GPL-2.0 发布。义务:随包附 GPL 文本与
libobs/noobs 的来源与源码指引。代价:只要还捆着 libobs,就不能转闭源/商业分发。
**用户已拍板接受。**

### 2.2 noobs 自带预编译 Node-API 二进制,但 `npm install` 仍会在 mac 上硬失败

- `dist/noobs.node`(411,136 B,PE32+ x64)是 **Node-API** 插件,导出
  `napi_register_module_v1`,只 import `KERNEL32/USER32/obs.dll`,delay-import
  `node.exe`(node-gyp 的 `win_delay_load_hook`,加载时解析到 `electron.exe`)。
  理论上**跨 Electron ABI 免重编**;`index.js` 加载的就是 `dist/noobs.node`,
  从不看 `build/Release/`。
- 但包根有 `binding.gyp` → npm 依 `gypfile: true` **合成** `install: node-gyp rebuild`
  (registry manifest 里有,tarball 自己的 package.json 里没有 —— 只读 tarball
  会得出相反结论)。本机实测:`npm install noobs` 在 macOS 上
  `fatal error: 'windows.h' file not found`,npm 回滚,`node_modules` 不存在。
  **这会拖垮整个 workspace 的 install,不只 desktop 包。**
- 逃生路径实测可行:声明为 `optionalDependencies` → mac 上 `npm install` 退出码 0,
  noobs 静默缺席(lock 记 `optional: true`)。

### 2.3 打包侧靠两个「看不见的默认值」活着

- 生效配置是 `packages/desktop/package.json` 的 `build` 块,**不是**
  `packages/desktop/electron-builder.yml`(app-builder-lib 优先读 packageKey,
  读到就不再找文件配置)。
- `npmRebuild` 缺省为 **true**,`files` 缺省为 **全量匹配**(无白名单)—— 原生模块能活
  全靠这两个默认值,而它们在仓库里**一个字都看不到**。
- 那份 git 追踪着的死 yml 里恰好写着 `npmRebuild: false` 和
  `files: [out/**, package.json]` —— **两个都是原生模块的单独致命开关**。
  它今天无害(electron-builder 默认忽略 `electron-builder.yml` 不打进包),
  危险全在人:谁"把配置统一到 yml"或从里面抄一行,CI 全绿、用户机上死。
- electron-vite 的 `externalizeDepsPlugin` **只外部化 `dependencies`**,不认
  `optionalDependencies`。
- main bundle 是 ESM(`"type": "module"`),**不能 `import` 一个 .node**;
  electron-vite 已注入 `createRequire` 但仓库里零处使用。
- ubuntu CI(`test.yml`)跑全套 E2E,直接拉起真 Electron 加载 `out/main/index.js`。
  顶层 import 一个 Windows-only 原生模块会一次打死四个 spec 和冷启动预算。

### 2.4 一期留下一个已发布的对齐 bug

`VideoTab.tsx:121`:

```ts
const offsetS = Math.max(0, (source.startTime - startedAt) / 1000);
```

`startedAt` 在 `startRecord()` 返回**之后**才盖(`recorder.ts:333`),而日志侧有
≥2s 批式 flush(`index.ts:148`)叠加 WoW 自身写盘滞后(评估文档记录可达 20s+)。
所以普通对局与 shuffle 首轮**恒有** `startedAt > source.startTime`,原始 offset 为负,
被 clamp 成 0。

推导:设 `lag = startedAt − source.startTime > 0`。真实换算是
`战斗秒 = 视频秒 + lag`;代码按 `战斗秒 = 视频秒` 换算。**结果是点任何战斗时刻
跳过去,看到的画面都比事件晚了整个 `lag`。** shuffle 的第 2~6 轮反而正确(那时
`source.startTime > startedAt`,offset 真为正)。

`VideoTab.test.tsx` 三个用例分别是 `offsetS = 0`、`startedAt = startTime − OFFSET_S`、
`startedAt = startTime − 1_000_000` —— **全部落在 offset ≥ 0 那侧,clamp 分支零覆盖**。

这是"缺头"里更难受的一半:不是没录到,是**录到了但对不齐**。与走哪条路线无关。

### 2.5 索引与回收的现状

- `RecordingEntry` 四字段 `{ videoPath, startedAt, stoppedAt, matchId }`,
  `matchId` 是**标量**;`associate()` 只考虑 `matchId === null` 的行。
  背靠背两场共用一段录像时,第一个到达的 meta 认领走,第二场什么都拿不到
  (代码注释里写明是一期接受的损失)。
- **全仓没有体积配额**,只有 `prune(keepCount)` 计数(默认 50)+ 固定
  `ORPHAN_KEEP_CAP = 2`。评估文档 §4.6 点名要求"配额从第一版就接线",一期没做。
- `prune()` **只在成功停录路径调用一次**(`recorder.ts:305` 是唯一调用点)。
  一串失败就永不回收。
- 索引外的文件(崩溃孤儿、用户自己的录像)**只报告不删除**,占的盘永不回收
  (刻意的"绝不毁用户数据"策略,保留)。
- 现成可抄的先例:`matchStore.ts` 已有 `totalBytes()` + `LRU_MAX_BYTES` 的体积驱逐。

### 2.6 状态面已铺好但零消费者

`recorder:status`(`enabled/connected/recording/lastError`)从 main emit、经 IPC、
到 preload 全部接好,**渲染层一个消费者都没有**(renderer 只用了
`recorder.autoConfig()` / `testConnection()` / `getForMatch()`)。
今天 OBS 没开 = 完全静默地不录。评估文档把"状态上报到 UI"列为该风险的应对,没做。

### 2.7 采集端从来没有抽象

评估文档与一期计划都写了「`IActivity` 式的 9 行数据契约作为采集端抽象」,
**代码里不存在**。唯一的间接层是 `ObsClientLike`(6 个方法),而它的动词就是
obs-websocket 的动词(`connect(url, password)` / `startRecord` / `stopRecord` /
`getRecordStatus`),不是通用采集动词。`recorder.ts` 直接按名字喊
`client.startRecord()`。

`recorder.ts` 423 行里约 129 行(`weStartedRecording` 及其 28 行论证注释、
`closeOrphanRecording`、`reconcileWithReality`、doClose 的"重连收账"分支)
**纯粹是"采集端是个有独立生命的外部进程"留下的疤**。

---

## 3. 分期

### 第 0 段:与采集端无关的地基(全部 mac 可验)

五项,见 §4。每项都有确定性前后数字。做完**不单独发版**(用户拍板),
但要跑一轮基线测量,拿到一期 headroom 的真实分布。

### 第 1 段:采集端换 noobs

落在第 0 段建好的 `CaptureBackend` 接口后面。见 §5–§8。

**这么切的理由**:第 0 段的三项(对齐、配额、状态上屏)是**已发布版本里的真问题**,
与路线无关;另两项(接口、索引承载力)是换引擎的前提。全部能在 mac 上验完,
真机只在第 1 段需要。

### 门:Windows 加载性验证必须排在第 1 段第一步

"noobs 的预编译在 Electron 38 下能直接用"是**推断,不是实测**(见 §10 风险表第二行)。
实施计划必须把这一步排在第 1 段的**最前面**,在写任何 backend 代码之前:

Windows 上 `--ignore-scripts` 装、不跑 electron-rebuild、在 Electron 38 里
`require("noobs")` 并调一次 `Init`,报告能不能加载。

**加载不了 → 整条路线要重估**(要么回到 electron-rebuild 且承担 ABI 与工具链成本,
要么退回附录 A 的路线 D)。这一步花几分钟,能挡掉数周的返工。

---

## 4. 第 0 段:五项地基

### 4.1 修 offsetS 对齐

**改法**:`offsetS` 允许为负:

```ts
const offsetS = (source.startTime - startedAt) / 1000; // 可负
const battleS = v.currentTime - offsetS; // 视频 → 战斗
const videoS = battleS + offsetS; // 战斗 → 视频
```

`offsetS < 0` 意味着战斗的前 `−offsetS` 秒没有画面。这段**要显式表达**,不是静默跳过:

- scrubber 下限取 `max(0, offsetS)`;
- 标记条 / moment 列表里落在不可达区的条目标灰并给出提示("该时刻在录像开始之前"),
  点击 seek 到视频 0 而不是算出负数;
- 录像 tab 顶部显示"缺头 N 秒"。

**验收**:补 `startedAt > source.startTime` 的用例(现在零覆盖);
判据 = 给定 `lag`,`videoS(battleS)` 必须等于 `battleS − lag`。

### 4.2 体积配额

**改法**:`prune` 从"只按数量"改成"数量 + 字节"双闸,照抄 `matchStore.ts` 的
`totalBytes()`/`LRU_MAX_BYTES` 形状。新增设置 `recordingMaxBytes`,
默认 **40GB**(理由见 §10 U2)。两个闸任一触发就驱逐,取更严的那个。

调用点从一处扩到三处:成功停录后(现状)、**失败路径后**、**启动时扫一次**。

"索引外的文件只报告不删除"的策略**保留**。

**验收**:确定性单测 —— 造 N 条不同大小的行,断言驱逐顺序与残留总字节;
失败路径也触发驱逐。

### 4.3 `CaptureBackend` 接口

见 §6。第 0 段先定义接口,并让**现有的 obs-websocket 实现去适配它**
(而不是反过来)—— 这样第 0 段结束时,一期功能仍然完全可用,且接口已被一个真实现验证过。

### 4.4 状态上屏

把 `recorder:status` 接进渲染层:

- 设置页「对局录像」组显示实时状态(启用 / 引擎就绪 / 正在录 / 上次错误)。
- 主界面用现有 `watching` 状态条的模式,在"应该在录但没在录"时给一条可见提示。

**验收**:fixture 测试 —— 给定 status 各组合,断言渲染出的文案。

### 4.5 索引承载力

- `associate()` 的"一段素材只认领一场"**不改** —— 二期一场一文件,背靠背损失
  不再发生;现有那条注释里的挂账保留,免得后人以为修过了。
  改的是配额与孤儿回收要能正确处理"同一目录下既有 buffer 中间产物又有成品"。
- `vodProtocol` 的 `isServable` 现在用**裸字符串相等**比 `videoPath`,而 store 自己的
  孤儿扫描用 `resolve()` 归一。换后端后路径拼法一变就会 403。统一走 `resolve()`。
- `isServable` 每个 Range 请求都重读重解析整个 ndjson。二期会更热,加缓存(索引写入时失效)。

---

## 5. 第 1 段:noobs 接入

### 5.1 引擎语义

noobs 的模型不是"起停",是"常驻 buffer + 回溯转档":

```
Init(distPath, logPath, cb)  →  SetBuffering(true) / SetFragmentation(true)
→ StartBuffer()                    // 内存环形缓冲,与对局无关
→ StartRecording(offsetSeconds)    // 把缓冲转成真文件,含最近 offset 秒
→ StopRecording()                  // 落盘;'converted' 信号带路径
→ GetLastRecording()               // 路径
```

产物是分片 MP4(二进制里可见 `movflags=frag_keyframe+empty_moov+delay_moov`)。
**一段对局一个文件** —— 这一点很关键:它天然保住了 `RecordingEntry.matchId` 是标量的
现有契约,不需要"一个大文件切多场"。

### 5.2 buffer 由进程检测驱动,不是日志

两个检测职责正交(评估文档 §1.2 的老 fork 设计):

- **进程检测管 buffer**:轮询 `Wow.exe` 是否在跑 → `StartBuffer()` / 停。
  探针以依赖注入形式提供,mac 上可测。
- **日志事件管对局边界**:沿用现有 `segmentOpen` / `segmentClose`,
  100% 来自战斗日志解析器。

### 5.3 回溯量与 `startedAt` 的精度

**两个量,别混**:

- `preRollS`(默认 **5**)= 想在开场**之前**多留几秒画面。
- `bufferLenS`(默认 **30**)= 内存环形缓冲能存多久。它是回溯量的**物理上限**。

```
offset = (now − source.startTime) / 1000 + preRollS      // 滞后 + 想多留的
capped = min(offset, bufferLenS)                          // 缓冲存不下就截断
StartRecording(Math.round(capped))                        // noobs 只吃整秒
startedAt = tStartCall − round(capped) * 1000
```

`bufferLenS` 必须**大于**"最坏滞后 + preRollS"才不会截断。评估文档记录的滞后可达
20s+,故默认 30s。发生截断时(`offset > bufferLenS`)记一条日志并在索引里标记 ——
这就是 §9.1 里 headroom 达不到 `preRollS` 的那种场次,不能静默。

三重保障:

1. 编码器设 `keyint_sec: 1`(老 fork 的做法,评估文档 §1.1 已记录),把关键帧吸附
   误差压到 ≤1s;
2. 落盘后用 noobs 自带的 `ffprobe.exe` 量真实时长,交叉校验
   `startedAt ≈ stoppedAt − duration`;
3. 偏差 > 2s 时以 ffprobe 推出的值为准,并记日志(这条偏差本身就是自检命令的一列)。

### 5.4 不搬的东西

一期 `recorder.ts` 里的 `connect` / `reconcileWithReality` / `weStartedRecording` /
`closeOrphanRecording`(~129 行)**不往新 backend 搬** —— 它们全是"外部进程有独立生命"
的疤。进程内引擎不存在"用户手动开了个我们不知道的录制"。

`SAFETY_STOP_MS = 40min` 不再是安全阀(进程内 buffer 不会失控),降级为**单段时长上限**,
阈值需重新论证。

### 5.5 要保留的东西

三条合成 close 路径**保留**:日志文件轮转(`pipeline.ts:84-95`)、worker teardown
(`:109-122`)、3 分钟静默阀(`runtime.ts:35`,2026-08-02 真机"录像停不下来"事故后加的)。
它们仍是"别再往这段里累积了"的唯一信号,但阈值当年是按 OBS 的失败模式调的,
需要重新论证而不是照搬。

---

## 6. `CaptureBackend` 契约

```ts
/** 一段录像的物理产物。startedAt 是第一帧的墙钟时刻,由 backend 负责给准。 */
export interface CapturedSegment {
  videoPath: string;
  startedAt: number;
  stoppedAt: number;
}

export interface BackendHealth {
  ready: boolean;
  /** 选中的视频编码器 id(诊断用) */
  encoder: string | null;
  /** 采集源是否真的挂上(游戏钩子) */
  sourceActive: boolean;
  lastError: string | null;
}

export interface CaptureBackend {
  /** WoW 在跑 → 开始向缓冲写。与对局边界无关,幂等。 */
  armBuffer(): Promise<void>;
  disarmBuffer(): Promise<void>;
  /** 开场:把缓冲转成真文件,回溯 preRollS 秒。 */
  beginSegment(preRollS: number): Promise<void>;
  /** 结束:落盘并返回产物。 */
  endSegment(): Promise<CapturedSegment>;
  probe(): Promise<BackendHealth>;
  shutdown(): Promise<void>;
}
```

**设计要点**

- 按 **buffer 语义**定义,不按起停语义 —— 否则内嵌引擎的能力会被外控的形状卡住。
- `startedAt` 由 backend 给,recorder 不再自己盖时间戳(这正是 §2.4 那个 bug 的根)。
- 第 0 段用它包住现有 obs-websocket 实现:`armBuffer`/`disarmBuffer` 为 no-op,
  `beginSegment(preRoll)` 忽略 preRoll 直接 `StartRecord`,`startedAt` 仍是调用时刻。
  一期行为不变,但接口被真实现验证过。

---

## 7. 失败面与可观测性

零配置的代价是失败更隐蔽:用户不再配 OBS,也就再看不见 OBS 的预览窗 ——
**钩不上游戏 = 一片黑,且完全无声**。

**不做原生预览**。`InitPreview` 拿 `getNativeWindowHandle()` 往 Electron 窗口里直接画
libobs 输出,是 Chromium 渲染器之外的原生面,会跟 z-order、DPI 缩放、窗口 resize
和现有布局打架,而且在这个仓库赖以回归的 fixture 测试与视觉基线里**完全不可见**。

替代方案:

1. **静态缩略图自检** —— 每段录完用自带 ffmpeg 抽一帧存进索引;录像 tab 与设置页
   显示"最近一次录制"。
2. **全黑帧检测** —— 抽出的帧近乎全黑 → 明确报"没钩上游戏画面",而不是黑屏。
3. **补 `<video>` 的 `onError`** —— 删 VideoDock 时把那句"建议 Hybrid MP4"一起删了
   (commit 3754c31),现在解不了的容器就是一块静默黑屏。
4. **杀软 / 反作弊面** —— noobs 带的是 OBS 的 `graphics-hook{32,64}.dll` 注入栈加
   `inject-helper*.exe` / `get-graphics-offsets*.exe`。今天这些风险由用户自装的、
   已被信任的 OBS 承担,内嵌后归 gladlog。签名与 SmartScreen / AV 误报要进计划。

---

## 8. 打包与平台守卫

| 项            | 做法                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 声明          | `optionalDependencies: { "noobs": "0.0.204" }`,**精确锁版本**(0.0.x、无 changelog、单作者、3 star)                                                                        |
| 加载          | `createRequire(import.meta.url)("noobs")`,放在 `process.platform === "win32"` 守卫内、**首次使用**时解析。绝不顶层 import                                                 |
| 类型          | **自写 `.d.ts`**,不 `import type` 自 noobs —— mac 上包不存在,否则 typecheck 直接红。顺带精确记录依赖了哪几个方法                                                          |
| electron-vite | main 块 `externalizeDepsPlugin({ include: ["noobs"] })` 兜底(它只认 `dependencies`)                                                                                       |
| 死配置        | **第 0 步删掉 `packages/desktop/electron-builder.yml`**,并在 `package.json` 的 `build` 块加注释写明 `npmRebuild` / `files` 是故意留默认值                                 |
| 重编          | `npmRebuild` **保持默认 true**。noobs 的 Node-API 预编译不需要它,但关掉会给未来任何真正需要重编的原生模块埋雷;代价只是打包机上多跑一遍无用的 node-gyp                     |
| CI 断言       | Windows 打包 job 断言 `node_modules/noobs/dist/noobs.node` 存在,且 `ELECTRON_RUN_AS_NODE=1` 下 `require` 得动。否则 Windows 上构建失败会静默退化成"包缺席",到用户机上才炸 |
| 非 win 守卫   | mac/ubuntu CI 断言 recorder 不加载 noobs、E2E 与冷启动预算不受影响                                                                                                        |
| 体积          | +35MB 下载 / +84MB 磁盘。整个模块目录被 electron-builder 自动 unpack 出 asar(`.node/.dll/.exe` 触发),**没法裁** —— `Init()` 指着那个目录,插件/data 布局是承重的           |
| 许可物料      | 随包附 GPL-2.0 文本 + noobs/libobs 来源与源码指引;`docs/DATA-COMPLIANCE.md` 或新增 `THIRD-PARTY-LICENSES` 里登记                                                          |

---

## 9. 验收判据与测试策略

### 9.1 缺头(确定性,可固化进门规)

`headroomMs = source.startTime − startedAt`,直接从 `recordings.ndjson` 算,
不需要人眼判断。

- **一期基线**:恒为负(≥2s flush + WoW 写盘滞后)。第 0 段完工后先测一轮拿真实分布。
- **二期目标**:恒为正,且 ≥ `preRollS`。

### 9.2 对齐

确定性单测:给定 `lag`,断言 `videoS(battleS) === battleS − lag`;
覆盖 `startedAt > source.startTime`(今天零覆盖)、`< `、`===` 三侧。

### 9.3 mac 上能验的

offsetS 纯函数、`RecordingsStore` 双闸配额、`CaptureBackend` 契约(fake backend)、
WoW 进程探测(注入 prober)、设置与掩码、状态上屏(fixture)、缩略图/黑帧判定
(喂固定像素)。

### 9.4 Windows 自检命令(用户拍板的验证方式)

`npm run recorder:selfcheck --workspace=packages/desktop`,headless,在 Windows 上跑:

起 buffer → 模拟一次开场事件 → 回溯转档 → `StopRecording` → 用自带 `ffprobe` 量,
打印一张表:

| 列                | 含义                                     |
| ----------------- | ---------------------------------------- |
| encoder           | 实际选中的编码器 id                      |
| duration          | ffprobe 量到的真实时长                   |
| keyframe interval | 实测关键帧间隔(应 ≈1s)                   |
| startedAt 误差    | 算出的 `startedAt` 与 ffprobe 反推值之差 |
| first frame       | 首帧是否全黑(钩没钩上)                   |
| headroom          | 实际拿到的回溯秒数 vs 请求的 `preRollS`  |

用户跑一发命令贴输出即可,不需要实打一场。

### 9.5 CI

- Windows:§8 的两条断言。
- ubuntu:现有 E2E 全绿(证明非 win32 守卫有效)。
- 本机绝不直跑 `test:visual`(视觉基线由 CI 生成)。

---

## 10. 风险与未决

### 未决事项(需在实施计划前或过程中定)

| 编号   | 事项                                                                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** | 是否保留 obs-websocket 外控作为可选后端?保留 = 多一条维护线 + 设置页更复杂;删掉 = 已有用户的既有配置失效。倾向:**第 0 段保留(它就是验证接口的那个实现),第 1 段上线后作为"高级"选项保留一版再删**               |
| **U2** | `recordingMaxBytes` 默认值。15Mbps × 10min ≈ 1.1GB/场;`keepCount` 默认 50 意味着最坏 ~55GB。**倾向 40GB** —— 比 `keepCount=50` 的最坏值略紧,所以体积闸是实际生效的那个,而不是永远不触发的装饰;同时留得下几十场 |
| **U3** | `bufferLenS` 的内存占用。noobs 的缓冲是内存环形,越长占越多。**倾向默认 30s**(§5.3 的推导:要盖住最坏滞后 20s+ 再加 preRoll 5s),15Mbps 下约 56MB。自检命令实测真实占用后再定死                                   |
| **U4** | 音频轨。**倾向:默认只录桌面音,不录麦克风**(隐私默认关);麦克风做成设置开关                                                                                                                                      |
| **U5** | 一期已产出的录像与索引行的迁移(`startedAt` 语义变了,老行的 headroom 恒负)。倾向:不迁移,老行按老语义渲染,索引里加 `schema` 标记                                                                                 |

### 风险

| 风险                                                                                                                                                                                                                                 | 应对                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖 bus factor:noobs 3 star、单作者、0.0.204、README 开头写"你八成不该用它"、Requirements 一节是 TODO、CI 只有一个 Windows job 无 Electron 矩阵                                                                                     | 精确锁版本;自写 `.d.ts` 把依赖面收敛到最小;`CaptureBackend` 让替换成本可控                                                                                           |
| "预编译在 Electron 38 下能用"是**推断,不是实测** —— 机制查清了(Node-API + delay-import),但本机无 Windows 环境验不了。Warcraft Recorder 自己仍在跑 `electron-rebuild -v 38.1.2`,虽然那份产物没被加载,但"看着像残留"不等于"验过不需要" | **第 1 段第一个动作就是这个**:Windows 上 `--ignore-scripts` 装、不跑 electron-rebuild、在 Electron 38 里 `require('noobs')`,报告能不能加载。加载不了则整条路线要重估 |
| 独占全屏采集                                                                                                                                                                                                                         | noobs 带的游戏钩子注入是所有候选里唯一能绕开 DWM 合成限制的;但仍需真机确认 WoW 的实际窗口模式                                                                        |
| 杀软 / 反作弊误报                                                                                                                                                                                                                    | §7.4;签名与误报测试进计划                                                                                                                                            |
| 磁盘吃满                                                                                                                                                                                                                             | §4.2 双闸配额,第 0 段就接线(不重蹈一期只做计数的覆辙)                                                                                                                |
| 打包配置被"顺手统一"                                                                                                                                                                                                                 | §8 删死 yml + 加注释 + CI 断言,三重                                                                                                                                  |
| 许可物料遗漏                                                                                                                                                                                                                         | §8 最后一行                                                                                                                                                          |

---

## 11. 与既有文档的关系

- 本文**修正**评估文档 §3B 的许可结论(LGPL → GPL)与 §2「打包隐患」一节
  (补上 `npmRebuild`/`files` 默认值这两个隐形开关)。
- 本文**承接**评估文档 §4「与路线无关、无论如何都要做的部分」——
  其中"配额从第一版就接线"一期未兑现,在本设计 §4.2 补上。
- 一期计划文档保持原样(它是已完成工作的记录)。

---

## 附录 A:三条路线的对比(拍板依据)

2026-08-02 用四路并行调查后给出,用户据此选了 B。留档是为了两件事:一是 §3 的
Windows 加载性门若不过,需要知道退路是什么;二是免得日后重新论证一遍。

|              | **B. 内嵌 noobs**(已选)                       | **D. 随包带便携版 OBS,仍走 websocket**                             | **E. 不换采集端,只解痛点**  |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| 零配置       | ✅ 真零配置                                   | ✅ 真零配置                                                        | ⚠️ 引导式(仍要点几下装 OBS) |
| 缺头         | ✅ 原生 buffer 回溯转档                       | ✅ WoW 在跑就连续录 + ffmpeg 无重编码裁剪                          | ✅ 同 D,但用用户自己的 OBS  |
| 独占全屏采集 | ✅ 自带 OBS 游戏钩子注入(唯一)                | ✅ 真 OBS                                                          | ✅ 真 OBS                   |
| 体积         | +35MB 下载 / +84MB 磁盘                       | **+179MB 下载**(官方 Windows x64 zip,实测)                         | 0                           |
| 许可         | ❌ 发行安装包变 GPL-2.0 衍生作品              | ✅ 独立进程 + socket = 聚合,gladlog 保持 MIT                       | ✅ 不变                     |
| mac 可验证性 | ❌ 原生层完全验不了                           | ✅ 配置生成/裁剪/索引全可验,只有子进程拉起要真机                   | ✅ ~90% 可验                |
| 其它代价     | 注入 DLL 的杀软/反作弊面;依赖 bus factor 极低 | 要生成 OBS profile/scene JSON、管子进程生命周期、CI 构建期下载 OBS | 不是真零配置                |

三条路线**共用第 0 段的全部地基**,所以第 0 段的工作无论最后走哪条都不白费。
