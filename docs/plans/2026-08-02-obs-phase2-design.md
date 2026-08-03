# OBS 录像二期(托管 OBS 实例)设计

2026-08-02。对应 backlog #1 的二期。前置文档:评估
`docs/plans/2026-07-27-obs-recording-integration-eval.md`、一期计划
`docs/plans/2026-07-28-obs-recording-phase1-plan.md`。

**本文是设计,不是实施计划**;实施计划另出。

---

## 0. 拍板记录

| 问题                    | 用户决定                                                 |
| ----------------------- | -------------------------------------------------------- |
| 二期要解决的痛点        | **零配置**(不想再装配 OBS)+ **缺头**(开场前几十秒没录到) |
| 采集端路线              | **D:托管一个 OBS 便携实例,仍走 obs-websocket 控制**      |
| OBS 怎么到用户机器上    | **首次运行时自动下载**(不打进安装包)                     |
| `recordingMaxBytes`     | **80GB**,定位是纯保险丝(见 §4.2)                         |
| 第 0 段做完是否单独发版 | 否,整个二期做完一起发                                    |
| 真机验证方式            | Windows 自检命令 + 少数几次人工跑                        |
| 录像默认画质            | **1080p60 / 8Mbps**(80GB 配额下约 22 小时素材)           |

### 路线曾经是 B(内嵌 noobs),中途改的

先按内嵌 noobs 定过一轮,用户当时接受了「发行安装包变 GPL-2.0 衍生作品」。随后改选 D。
两条路线的完整对比与实测数字见附录 A —— 那里也是**本设计万一在 §3 的门前倒下时的退路**。

---

## 1. 目标与非目标

**目标**

1. 用户装了 gladlog 就自动录竞技场,**不需要自己安装或配置 OBS**。
2. 录像**覆盖开场之前**,消除缺头。
3. 回放里点死亡 / finding / 爆发窗,视频跳到的是**该事件本身**,不是它之后几秒。
4. gladlog 的分发物里**零 GPL 代码**,源码与安装包都保持 MIT。

**非目标(本期明确不做)**

- macOS 录像(OBS 的便携模式在 macOS 上根本没编进去 —— `ALLOW_PORTABLE_MODE` 仅
  Windows 与自定义构建的 Linux;mac 另有 TCC 权限 + 公证硬阻塞)。
- 跨机视频搬运(录像仍是游戏机本机特性,与一期一致)。
- 转码 / 裁剪 / 剪辑导出 —— **本设计一次转码或裁剪都不做**(见 §5.5)。
- 托管实例的画面预览窗。

用户自有 OBS 的外控路径**保留**为旁路,见 §5.7。

---

## 2. 已实测的前置事实

本节每条都是本次实地验证的结果。凡标注**推断**的,必须在 §3 的门或 §9 的自检里
落实成实测 —— 不许当既成事实用。

### 2.1 OBS 便携包的真实载荷(下载解包实测)

`OBS-Studio-32.2.1-Windows-x64.zip`:187,817,017 字节,
SHA-256 `db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de`。

- **解压后 466 MiB / 磁盘占用 473MB**,2,112 个文件 —— 不是 179MB,膨胀 2.6 倍。
- 大头:`libcef.dll` **204MB**(浏览器源)、CEF 语言包 39.8MB、
  **50 个 `.pdb` 调试符号共 76.3MB**、`avcodec-62.dll` 36MB、Qt6 三件套 24MB、
  `obs-scripting` 6.1MB、OBS 界面语言包 6.0MB。
- 结论:约 **350MB 可以选择性不解压**(我们只要游戏采集 + WASAPI + 硬件编码 +
  本地录制),落地约 115MB。
- **游戏采集钩子齐全**:`graphics-hook{32,64}.dll`、`inject-helper{32,64}.exe`、
  `get-graphics-offsets{32,64}.exe`、`compatibility.json`、Vulkan 层清单。
- **obs-websocket 内置**(`obs-websocket.dll` 1.2MB),版本 **5.7.4**,RPC version 1。
  仓库已有的 `obs-websocket-js ^5.0.8` 能对上(它把服务端广播的 rpcVersion 原样回传,
  不会误协商)。

### 2.2 便携包里**没有** ffmpeg —— 这条推翻了原先的方案前提

整棵树只有 10 个 exe。唯一沾 ffmpeg 的是 `obs-ffmpeg-mux.exe`(33KB),而它的导入表里
**一个解复用 / seek 符号都没有** —— 没有 `avformat_open_input`、`av_read_frame`、
`avformat_find_stream_info`、`av_seek_frame`。它的全部 avformat 面都是输出侧
(`avformat_alloc_output_context2` / `av_interleaved_write_frame` / `av_write_trailer`),
是 OBS 用 `os_process_pipe_*` 通过 stdin 喂包的**只写复用器**;参数面也不是 ffmpeg 风格
CLI,而是一串固定位置的编码器 / 流描述符。

随包的 `avformat-62.dll` / `avcodec-62.dll` **是完整构建**,确实导出了解复用与 seek,
所以理论上可以自己写个小 remuxer 去驱动它们 —— 但那是要我们写并分发原生代码,
正好是选 D 想避开的东西。

**所以:本设计不做任何裁剪。** 解法见 §5.5。

### 2.3 无人值守启动的五个坑(全部源码级确认,tag 32.2.1)

1. **`--disable-shutdown-check` 不存在。** 32.x 的参数解析已从 `UI/obs-app.cpp` 搬到
   `frontend/obs-main.cpp:963-1067`,全仓搜索该开关零命中。网上所有推荐它的答案都是
   以讹传讹。
2. 但它想解决的问题是**真的**:`checkForUncleanShutdown()` 会弹一个模态
   `QMessageBox`(安全模式 / 正常启动),**阻塞事件循环直到有人点**。
   机制纯文件式:OBS 启动时写 `<config>/obs-studio/.sentinel/run_<uuid>`,干净退出时删。
   **对策:每次拉起前删掉 `.sentinel/run_*`**,确定性地压掉这个框。
3. **首次运行会弹自动配置向导**,条件是 `!first_run && !has_last_version && !Active()`。
   **对策:启动前预写 `user.ini` 的 `[General] FirstRun=true`。**
4. **`--safe-mode` 会禁用 obs-websocket**(它被硬编码在 `unsafe_modules` 集合里),
   用了就等于把控制面砍了。**要用 `--only-bundled-plugins`** —— 它挡掉第三方插件
   (顺带隔离用户装的 OBS 插件),但保留 obs-websocket。
5. **便携模式的路径是相对的,而 OBS 从不 `chdir()`。** `BASE_PATH` 在 Windows 上是
   `"../.."`,`CONFIG_PATH` 是 `BASE_PATH "/config"`,`GetAppConfigPath` 原样返回。
   **对策:spawn 时 cwd 必须设成 `<obs-root>/bin/64bit`**,否则配置会落到别处。
   (此条为**推断**:依据是相对字符串字面量 + `CheckIfAlreadyRunning` 需要显式
   `os_get_abs_path` + 全仓无 `chdir` 调用点;真机必须实测。)

### 2.4 与用户自己的 OBS 共存

- **单实例锁按便携配置路径做了命名空间隔离**:普通模式用互斥体 `"OBSStudioCore"`,
  便携模式用 `"OBSStudioPortable" + 配置绝对路径`(非字母数字换成 `_`)。
  所以我们的便携实例**不会**和用户装的 OBS 撞锁。`--multi` 仍然带上兜底 ——
  万一撞上,那个模态框的**默认按钮是取消**,无人值守会直接退出。
- **真正会撞的是 websocket 端口**:它按配置存,人人默认 4455。我们用 **4466**(离 4455 够远,又不撞常见服务)。

### 2.5 websocket 控制面的能力与陷阱(obs-websocket 5.7.4)

- `--websocket_port` / `--websocket_password` / `--websocket_ipv4_only` 存在,
  由插件而非 OBS 核心解析(Qt 解析器,`=` 和空格两种写法都吃;而 OBS 核心的
  `--profile` 等是 `strcmp` 精确匹配,**只能用空格分隔**)。
  密码用命令行给时**明确不落盘**(`PasswordOverridden` 时 `Config::Save()` 跳过)。
- **但没有任何开关能启用 websocket 服务器。** `ServerEnabled` 默认 false,
  只从 `<config>/obs-studio/plugin_config/obs-websocket/config.json` 读。
  **必须预写这个文件**(键是 snake_case:`first_load` / `server_enabled` /
  `server_port` / `server_password` / `auth_required` / `alerts_enabled`)。
  把 `first_load` 写成 `false` 还能顺带阻止 OBS 自动生成一个随机密码落盘。
- **`SplitRecordFile`** 需要 **Advanced 输出模式** + `AdvOut/RecSplitFile=true`
  (Simple 模式压根没有这组键,必失败);它**不返回文件名**,新路径只能从
  `RecordFileChanged.newOutputPath` 事件拿。
  **`StopRecord.outputPath` 在分片之后仍返回第一个分片** —— 这是 obs-websocket
  的实现缺陷(它读 output 的 settings,而两个复用器都不把新路径写回 settings)。
- `RecordStateChanged` 在 **STARTED 时也带 `outputPath`**,与它自己的文档相反
  (文档说只有停止时有)。这是 5.7.4 源码里确认的**未文档化行为**,可用但
  **不能作为唯一依赖**,兜底见 §5.5。
- **`Video/AutoRemux` 陷阱**:若为真,OBS 会在事后异步把文件重命名成另一个容器,
  **且没有任何完成事件**。它对普通录制、每次分片、回放缓冲保存都生效。它没有
  `config_set_default`,未设时为 false,但用户勾过就会把路径追踪打乱。
  **防御性写成 `"false"`。**
- 编码器与关键帧间隔(`keyint_sec`)**不在 basic.ini**,在 profile 目录下的
  `recordEncoder.json`,而 websocket **没有任何编码器请求**。所以这些必须在启动前
  写文件,不能在运行时改。
- `CreateRecordChapter` 可以往录制中的文件里插命名章节标记(仅 hybrid_mp4 支持,
  而 OBS 32 在 Windows 上的**默认容器就是 hybrid_mp4**)。列为可选增强,见 §10 U3。

### 2.6 一期留下一个已发布的对齐 bug

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

### 2.7 现有回放层已经支持「长文件里只播一段」

这是本设计能免掉裁剪的关键。`VideoTab` 已有完整机制:`offsetS`/`endS` 定位本场窗口、
`timeupdate` 越界回弹(起点留 0.25s 松弛)、scrubber 的 min/max 卡在本场窗口、
"本轮超出录像末尾"在 `onReady` 里同步判定并渲染空态(这是为了避免朴素实现的
seek↔clamp 无限循环把 CPU 打满)。

它当初是为 **Solo Shuffle 六轮共用一段 lobby 录像**建的,换轮**刻意不重挂** video
元素(无 React key),只重新 seek。

### 2.8 索引与回收的现状

- `RecordingEntry` 四字段 `{ videoPath, startedAt, stoppedAt, matchId }`,
  `matchId` 是**标量**;`associate()` 只考虑 `matchId === null` 的行。背靠背两场共用
  一段录像时,第一个到达的 meta 认领走,第二场什么都拿不到。
- **全仓没有体积配额**,只有 `prune(keepCount)` 计数(默认 50)+ 固定
  `ORPHAN_KEEP_CAP = 2`。评估文档 §4.6 点名要求"配额从第一版就接线",一期没做。
- `prune()` **只在成功停录路径调用一次**(`recorder.ts:305` 是唯一调用点,已核实)。
  一串失败就永不回收。
- 索引外的文件只报告不删除(刻意的"绝不毁用户数据"策略,**保留**)。
- 现成可抄的先例:`matchStore.ts` 已有 `totalBytes()` + `LRU_MAX_BYTES` 的体积驱逐。

### 2.9 状态面已铺好但零消费者

`recorder:status` 从 main emit、经 IPC、到 preload 全部接好,**渲染层一个消费者都没有**
(已核实:renderer 只用了 `autoConfig()` / `testConnection()` / `getForMatch()`)。
今天 OBS 没开 = 完全静默地不录。

### 2.10 采集端从来没有抽象

评估文档与一期计划都写了「`IActivity` 式的 9 行数据契约作为采集端抽象」,
**代码里不存在**。唯一的间接层是 `ObsClientLike`(6 个方法),动词就是 obs-websocket
的动词。`recorder.ts` 423 行里约 129 行(`weStartedRecording` 及其 28 行论证注释、
`closeOrphanRecording`、`reconcileWithReality`、doClose 的"重连收账"分支)
**纯粹是"采集端是个有独立生命的外部进程"留下的疤**。

注意:走 D 之后采集端**仍然**是个有独立生命的外部进程,所以这批疤**大部分要留着**,
只是主体从"用户的 OBS"变成"我们托管的 OBS"。见 §5.6。

### 2.11 仓库里没有下载器可抄

main 进程零 `fetch` / `createWriteStream` / `https.get`。首次运行下载器是净新工作。
解压不需要引入依赖:`tar -xf` 可解 zip(本机 bsdtar 3.5.3 实测通过;Windows 10 1803+
自带的 `tar.exe` 就是 bsdtar —— **此条 Windows 侧待实测**)。

---

### 2.12 竞品实证:arenacoach.gg 已经把这件事做完了

arenacoach.gg(gladlog 规则吸收的来源,见 `docs/plans/2026-07-27-arenacoach-rules-batch1.md`)
**不是只做日志分析** —— 它有一个 Electron 桌面端,做的事和本设计几乎重合:

- 轮询 `tasklist` 找 WoW 进程(**2 秒一次**)→ `fs.watch` 盯日志 → 实时解析 → 按场切块上传。
- **录像用 obs-studio-node 内嵌**(自托管构建 `osn-0.25.34-release-win64.tar.gz`),
  game_capture / window_capture / monitor_capture 都支持。
- **视频与战斗日志时间轴同步**:事件轨道叠在进度条上,同一 2% 时长内的事件聚类,
  **点击事件 seek 到该事件前 3 秒**(`EVENT_PRE_ROLL_SEC = 3`)。事件分类
  death / cc / interrupt / dispel / defensive / offensive / cooldown —— 就是规则 ID 前缀。
- **Solo Shuffle:一个 lobby 一段录像,客户端按轮切分,轮时间戳是相对 shuffle 起点的
  毫秒偏移** —— 与 gladlog 的 `videoMatchId` 做法同构,互为旁证。
- **视频只留本地,绝不上传**(隐私政策里 "video" 零次出现,只上传日志)。

对本设计的三点意义:

1. **"一段素材 + 每场一个窗口"的产品形态被独立验证过**(§4.3 的索引改动方向正确)。
2. **前置回滚(pre-roll)是它们的既定做法** —— gladlog 现在是精确 seek 到事件时刻,
   吸收进 §4.1。
3. **它选的是内嵌路线(obs-studio-node),并因此是 GPL-2.0-or-later。** 我们选 D 正是
   为了不付这个代价。它无所谓是因为它本来就开源。

> **纪律**:`github.com/brz456/arenacoach-desktop` 是 GPL-2.0-or-later。
> **读设计可以,抄实现不行** —— 与老 fork(CC BY-NC-ND)同样的纪律。
> 另注:该仓库停在 0.1.52(2026-04),线上已 0.2.15(2026-07-30),内部实现只作参考不作依据。

**一处数字存疑,不要照抄**:它的 README 称一场竞技场录像 5–20MB。按 5 分钟一场折算
只有约 0.5 Mbps,与本设计 §10 U2 的量级差两个数量级。可能是低画质默认值,也可能是
陈旧文案。**保留我们自己的估算,不采信这个数字**,真机实测后再定。

---

## 3. 分期与那道门

### 第 0 段:与采集端无关的地基(全部 mac 可验)

五项,见 §4。每项都有确定性前后数字。做完**不单独发版**,但要跑一轮基线测量,
拿到一期 headroom 的真实分布。

### 第 1 段:托管 OBS 实例

见 §5–§8。

### 门:第 1 段开工前的真机确认

> **本节 2026-08-02 二次调查后降级。** 原先把"托盘态能不能钩上 WoW"列为全案生死项;
> 补查后它是**高置信度(~95%)可行**,证据链见下。它仍然要真机确认一次,但已经
> 从"过不了就换路线"降级成"顺手验一下,顺便验掉几个真正的风险项"。

**为什么降级 —— 源码级因果链**:

- libobs 的图形设备从**适配器索引**创建(`gs_create(&video->graphics, ovi->graphics_module,
ovi->adapter)`),**全程没有 HWND**;窗口只用于创建**可选的**预览 display。
- 渲染循环里 `output_frames()` **无条件**执行,`render_displays()` 遍历的链表在没有预览时
  **是空的** —— 编码器喂帧与预览是完全不相干的两条路径。
- `game_capture` 唯一依赖的是 `obs_source_showing()`,而那是**场景图引用计数**
  (`show_refs != 0`),不是窗口属性。`obs_set_output_source(0, scene)` 一次即永久满足。
- `game-capture.c` 里所有 `GetForegroundWindow()` 都在看**游戏**,不是看 OBS;
  其中一处只用来决定要不要**隐藏鼠标指针**。
- **OBS 自己的托盘路径主动关掉预览却继续输出**(`EnablePreviewDisplay(false)`)——
  官方就把预览当装饰。

**自然实验**:Warcraft Recorder 根本没有 OBS 窗口(libobs 直连,无 Qt);noobs 仓库里有一个
**完全无窗口的 `game_capture` 测试脚本**;WCR 800+ issue 里**零**"窗口隐藏导致黑屏"的报告。

**设计反转(已并入 §5.4)**:**显示窗口只会有害,不会有益。** 游戏在独占全屏时,任何抢
焦点的动作都会让游戏最小化并停止渲染 —— 那是官方 KB 里唯一记载的 game_capture 黑屏成因。
待在托盘里**严格更安全**。所以本设计不提供"显示 OBS 窗口"选项。

**残留的不确定性**(为什么仍要验一次):没人公开发表过"跑 `--minimize-to-tray` +
game_capture,文件不是黑的"这句话;而 WCR 的默认采集模式其实是 **window_capture(WGC)
而非 game_capture**,所以群众实验对 game_capture 的说服力弱一档。

**真机确认要验的,按重要性排序**(前三条现在比"托盘态"更值得担心):

1. **混合 GPU 适配器不匹配** —— OBS 与游戏必须在同一块 GPU 上。笔记本上这是头号黑屏成因。
2. **完整性级别不匹配** —— 游戏提权而我们没提权时钩不进去。
3. **钩子冲突** —— RTSS / MSI Afterburner 等覆盖层软件。
4. 托盘态 game_capture 出图不黑(上面那 95%)。
5. 三个**推断**:便携路径的 cwd 依赖(§2.3.5)、删 sentinel 能否压掉崩溃框(§2.3.2)、
   `tar -xf` 在 Windows 上解 zip(§2.11)。

这些全部由 §9.4 的自检命令覆盖,不需要手工搭环境。

---

## 4. 第 0 段:五项地基

### 4.1 修 offsetS 对齐

```ts
const offsetS = (source.startTime - startedAt) / 1000; // 允许为负
const battleS = v.currentTime - offsetS; // 视频 → 战斗
const videoS = battleS + offsetS; // 战斗 → 视频
```

`offsetS < 0` 意味着战斗的前 `−offsetS` 秒没有画面。这段**要显式表达**,不是静默跳过:

- scrubber 下限取 `max(0, offsetS)`;
- 标记条 / moment 列表里落在不可达区的条目标灰并提示("该时刻在录像开始之前"),
  点击 seek 到视频 0 而不是算出负数;
- 录像 tab 顶部显示"缺头 N 秒"。

**同时改跳转语义 —— 前置回滚(pre-roll)**:现在点一个死亡 / finding 是**精确 seek 到
事件时刻**,看到的是事件本身发生的那一帧,前因已经过去了。改成 seek 到**事件前
`PRE_ROLL_S` 秒**(arenacoach 用 3 秒,§2.12),让人看得到起手。落在不可达区
(`videoS < 0`)时退化到视频 0。

**验收**:补 `startedAt > source.startTime` 的用例(现在零覆盖);
判据 = 给定 `lag`,`videoS(battleS)` 必须等于 `battleS − lag`;
pre-roll 判据 = 点击战斗秒 `b` 后 `video.currentTime === max(0, videoS(b) − PRE_ROLL_S)`。

### 4.2 体积配额

`prune` 从"只按数量"改成"数量 + 字节"双闸,照抄 `matchStore.ts` 的
`totalBytes()` / `LRU_MAX_BYTES` 形状。

- `recordingKeepCount`(默认 50)按**对局**计:"保留最近 N 场的录像"。
- `recordingMaxBytes` **默认 80GB**,定位是**纯保险丝** —— 它比 `keepCount=50` 的
  最坏值(15Mbps × 10min ≈ 1.1GB/场 → ~55GB)宽,所以正常情况下计数闸先触发,
  体积闸只在分片特别大(长 lobby、高码率、含挂机段)时兜底。用户拍板。
- 删除单位是**分片文件**:一个分片只有在它承载的**所有**对局都掉出保留集时才删。

调用点从一处扩到三处:成功停录后(现状)、**失败路径后**、**启动时扫一次**。

"索引外的文件只报告不删除"的策略**保留**。

**验收**:确定性单测 —— 造 N 条不同大小、不同对局归属的行,断言驱逐顺序与残留总字节;
断言"分片里还有一场在保留集内就不删";失败路径也触发驱逐。

### 4.3 索引改成「一段素材 ↔ 多场对局」

**这是本设计最承重的结构改动**,§5.5 的整个录制策略依赖它。

```ts
export interface RecordingEntry {
  schema: 2;
  videoPath: string;
  /** 该分片第一帧的墙钟时刻 —— 回放对齐锚点 */
  startedAt: number;
  stoppedAt: number | null; // 仍在录时为 null
  matchIds: string[]; // 原 matchId: string | null
}
```

- `associate(meta)`:窗口重叠且 `matchIds` 里还没有它 → 追加。**不再**要求
  `matchId === null` —— 背靠背两场共用一个分片从此正确。
- `getForMatch(id)`:找 `matchIds.includes(id)` 的行。
- 迁移:老行 `{matchId: X}` → `{schema: 2, matchIds: X ? [X] : []}`,读时惰性升级、
  写时落 schema 2。老行的 `startedAt` 语义没变(仍是第一帧时刻),只是恒晚于开场 ——
  由 §4.1 修好的算术正确渲染成"缺头"。

**验收**:单测覆盖背靠背两场认领同一分片、老 schema 读入、重复 associate 幂等。

### 4.4 `CaptureBackend` 接口

见 §6。**2026-08-03 修订:整体挪到第 1 段。** 原打算第 0 段先定义接口并让现有
obs-websocket 实现去适配它,理由是「让接口被一个真实现验证过」;但复核逐条证明让
`recorder.ts` 改路由过去必然改变行为(`probe()` 回答的不是 `getRecordStatus()` 的问题、
backend 吞错误会让 `lastError` 断言全灭、`isAlreadyActiveError` 的重试与「绝不停用户
自己的录制」保证会变成死码、`withTimeout` 被绕过、`testConnection` 无处安放),
于是接线被取消 —— 而不接线的接口就是零消费者的抽象,那条理由随之失效。
放到第 1 段与托管 backend、旁路 backend 两个实现一起写,接口才有真实约束。

**因此第 0 段是四项地基**:§4.1 对齐、§4.2 配额、§4.3 索引、§4.5 状态上屏。

### 4.5 状态上屏

- 设置页「对局录像」组显示实时状态(引擎就绪 / 正在录 / 上次错误)。
- 主界面用现有 `watching` 状态条的模式,在"应该在录但没在录"时给一条可见提示。

**验收**:fixture 测试 —— 给定 status 各组合,断言渲染出的文案。

---

## 5. 第 1 段:托管 OBS 实例

### 5.1 获取:首次运行下载

- **钉死版本与哈希**,不解析 release 正文(那个格式会漂):
  URL `https://github.com/obsproject/obs-studio/releases/download/32.2.1/OBS-Studio-32.2.1-Windows-x64.zip`,
  大小 187,817,017,SHA-256
  `db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de`。
- 下载到 `<userData>/obs/download/`,校验哈希,**选择性解压**到
  `<userData>/obs/32.2.1/`:跳过 `**/*.pdb`、`obs-plugins/64bit/locales/**`、
  `libcef.dll` 与 CEF 附属、`data/obs-scripting/**`,以及 `data/obs-studio/locale/**`
  中除简中与英文外的部分。落地约 115MB。
- 解压用 `tar -xf`(见 §2.11)。要有进度、断点重试、磁盘空间预检、失败可重来。
- **gladlog 自己不分发任何 OBS 字节** —— 用户是从 obsproject 官方 release 拿到的,
  我们只是把这个动作自动化了。§1 目标 4 由此成立。

### 5.2 配置:我们写自己的,永不碰用户的

配置根 `<userData>/obs/32.2.1/config/obs-studio/`(便携模式布局)。

> **与 `obsAutoConfig.ts` 的"只读不写"铁律不冲突。** 那条铁律针对的是**用户自己的**
> OBS 配置(OBS 退出会回写整文件,外部写入会被静默 clobber)。这里写的是**我们托管
> 实例的**配置,而且只在它没在跑的时候写。这个区分要在代码注释里写死,免得后人
> 按铁律把它删了。

| 文件                                        | 关键内容                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<obs-root>/portable_mode.txt`              | 便携标记(四个可接受文件名之一)                                                                                                                            |
| `config/obs-studio/user.ini`                | `[General] FirstRun=true`(压掉自动配置向导);`[Basic] Profile/ProfileDir/SceneCollection/SceneCollectionFile`                                              |
| `config/obs-studio/global.ini`              | `[General] LastVersion`                                                                                                                                   |
| `plugin_config/obs-websocket/config.json`   | `{first_load:false, server_enabled:true, server_port:4466, server_password:<每机随机>, auth_required:true}`                                               |
| `basic/profiles/gladlog/basic.ini`          | `[Output] Mode=Advanced`;`[AdvOut] RecFilePath / RecFormat2=hybrid_mp4 / RecEncoder / RecSplitFile=true`;`[Video] AutoRemux=false`;`[Video]` 分辨率与帧率 |
| `basic/profiles/gladlog/recordEncoder.json` | `rate_control` / `bitrate` / `keyint_sec` —— **只能在这里设,websocket 改不了**                                                                            |
| `basic/scenes/gladlog.json`                 | 最小场景集合(采集源不写死在这里,见 §5.4)                                                                                                                  |

**每次拉起前**删掉 `config/obs-studio/.sentinel/run_*`(§2.3.2)。

密码走命令行传(不落盘),但 `config.json` 里仍要写一个 —— 因为 `server_enabled`
只能从文件读;写进去的那个会被命令行覆盖。

### 5.3 编码器选择

`AdvOut/RecEncoder` 的合法 id 是硬件相关的(`obs_x264` / `jim_nvenc` / `obs_qsv11` /
`h264_texture_amf` …),**不能硬编码**。首次配置时:先写 `obs_x264` 保底 → 拉起 OBS →
用 websocket 枚举可用编码器 → 挑最优 → 写回 `basic.ini` → 下次拉起生效(编码器选择
要输出处理器重建,不能热改)。枚举结果缓存进设置,避免每次启动都探测。

### 5.4 启动

```
obs64.exe --portable --multi --only-bundled-plugins --minimize-to-tray
          --disable-updater --disable-missing-files-check
          --collection gladlog --profile gladlog --scene gladlog
          --websocket_port <port> --websocket_password <pw>
```

cwd **必须**是 `<obs-root>/bin/64bit`(§2.3.5)。

核心开关的值必须是**独立的 argv 元素**(`--profile gladlog`,不能 `--profile=gladlog`);
`--websocket_*` 两种写法都行。`--profile` 匹配的是**显示名**,拼错会**静默回退**到
当前 profile —— 所以启动后要用 websocket 核对生效的 profile 名。

刻意**不用** `--safe-mode`(会杀掉 obs-websocket)和 `--startrecording`(宁可用
websocket 显式起录,拿得到回执、控得住时机)。

**窗口永不显示,也不提供显示选项。** 理由不是"隐形好看",是**显示会主动制造黑屏**:
游戏在独占全屏时,任何抢焦点的动作都会让它最小化并停止渲染,这是官方 KB 里唯一记载的
game_capture 黑屏成因(§3)。推论有两条硬约束 —— 托管实例**绝不能**在录制期间弹任何
窗口或对话框(§2.3 的两个模态框因此不只是"卡住无人值守",而是**会毁掉这一场录像**);
gladlog 自己的窗口也不该在录制期间主动 `focus()` / `show()`。

**采集源不写进场景 JSON。** `game_capture` 的 `window` 值是 `title:class:exe` 且有
转义规则(`#`→`#22`、`:`→`#3A`),手写极易出错,而且要等 WoW 真的在跑才知道。
所以场景集合里只放一个空场景,采集源在连上 websocket 后创建:
`CreateInput(game_capture, {capture_mode:"any_fullscreen", priority:2, anti_cheat_hook:true})`。
`any_fullscreen` 不需要窗口串;需要精确匹配时再
`GetInputPropertiesListPropertyItems(propertyName:"window")` 枚举后 `SetInputSettings`
(该请求要求 input 已存在,所以顺序是**先建后查**)。

`priority` 的坑:存的是枚举值 `CLASS=0, TITLE=1, EXE=2`,而 UI 列表顺序是
Title/Class/Exe —— 照下拉框位置写会错。按 exe 匹配就是 `2`(也是插件默认)。

### 5.5 录制策略:连续录 + 定点分片 + 按含不含对局回收

**核心决定:一次裁剪都不做。**

进程检测:轮询 `tasklist` 找 WoW,**2 秒一次**(arenacoach 同款间隔,§2.12;
探针注入,mac 上可测)。

```
WoW 进程出现            → StartRecord(连续录)
每次 segmentClose 之后  → SplitRecordFile(切一刀)
空闲期每 N 分钟         → SplitRecordFile(把挂机段隔离出去)
WoW 进程消失            → StopRecord
```

- **绝不在对局进行中分片** —— 一场对局必须完整落在一个分片里,否则索引行没法指向
  单个文件。因此 `RecSplitFileType` 设成**既非 `Time` 也非 `Size`**(纯手动分片,
  两个自动阈值都变 0),分片时机完全由 gladlog 掌握。
  代价是失去了 OBS 自带的体积上限:一个分片能长到多大完全取决于 gladlog 还在不在
  发分片指令。兜底是 §5.6 的 job object —— gladlog 死了 OBS 跟着死,不会留下一个
  无人管的进程一直往硬盘里写。
- **缺头天然解决**:分片是在上一场结束或空闲时切的,它的起点必然**早于**下一场开场,
  所以 `headroom = source.startTime − chunk.startedAt > 0` 恒成立。唯一例外是 WoW 刚
  启动就直接进场(`StartRecord` 与开场几乎同时),这种情况 headroom 可能为负 ——
  **如实记录,不许静默**。
- **磁盘**:含对局的分片留,不含的删。空闲期定期切正是为了把长挂机段隔离成独立分片
  好删掉。删除有 **10 分钟宽限期**(对局 meta 可能还没落库;取值远大于解析入库的秒级延迟,
  又远小于空闲分片间隔的量级),见 §4.2。
- **分片账本**:每次 `RecordFileChanged` 记 `{path, startedAt = 事件到达墙钟}`。
  首个分片的路径从 `RecordStateChanged`(STARTED 也带 `outputPath`)拿;因为这是
  未文档化行为,**兜底 = 扫录制目录取最新文件**(该目录只有我们写,安全)。
  **绝不用 `StopRecord.outputPath`** —— 分片后它返回的是第一个分片(§2.5)。
- `stoppedAt`:分片被下一次分片或 `StopRecord` 关闭时盖。仍在录的分片
  `stoppedAt = null`,`vod://` 照样能供片(Range 读到多少算多少),但**正在写的文件
  不参与驱逐**。

### 5.6 进程生命周期

- 子进程用 Windows job object 绑定,gladlog 崩了不留孤儿 OBS。
- OBS 意外退出 → 有限次退避重启;连续失败则降级为"这段没录",**绝不影响解析入库
  与分析主链路**(一期铁律,继续适用)。
- 退出时:`StopRecord` → 等 `RecordStateChanged(STOPPED)` → 关 OBS → 超时强杀。
  现有 `quitLifecycle.ts` 的 4s 上限要重新论证 —— 等一个 GUI 进程优雅退出比等一次
  websocket 往返慢。
- 一期那批"外部进程有独立生命"的疤(`weStartedRecording` / `reconcileWithReality` /
  `closeOrphanRecording`)**大部分留着** —— 采集端仍是外部进程。但语义收紧了:
  托管实例的录制**一定**是我们起的,所以 `weStartedRecording` 在托管模式下恒真;
  它继续保护的是**旁路模式**下用户自己手动开的录制。

### 5.7 用户自有 OBS 作为旁路

设置里保留"使用我自己的 OBS"开关(默认关)。开了就是一期的行为:连用户的 websocket、
不托管进程、不分片(用户的 profile 我们不改)、缺头照旧。`obsAutoConfig.ts` 只在这条
旁路上使用,**继续只读不写**。

这条旁路同时是托管模式的兜底:下载失败、钩不上、用户机器上跑不起来时的出路。

---

## 6. `CaptureBackend` 契约

```ts
/** 一个分片(可能承载多场对局)。 */
export interface CaptureChunk {
  videoPath: string;
  startedAt: number;
  stoppedAt: number | null;
}

export interface BackendHealth {
  ready: boolean;
  encoder: string | null;
  /** 采集源是否真的挂上(黑帧检测的结果之一) */
  sourceActive: boolean;
  lastError: string | null;
}

export interface CaptureBackend {
  /** WoW 在跑 → 开始连续录。幂等。 */
  startContinuous(): Promise<void>;
  /** 返回刚关闭的分片 —— 调用方要拿它落索引,返回 void 会逼它再查一次。 */
  stopContinuous(): Promise<CaptureChunk | null>;
  /** 切一刀。返回刚被关闭的分片(还没有分片时为 null)。 */
  splitChunk(): Promise<CaptureChunk | null>;
  /** 订阅分片开启(RecordFileChanged / 首个分片)。 */
  onChunkOpened(cb: (c: CaptureChunk) => void): void;
  probe(): Promise<BackendHealth>;
  shutdown(): Promise<void>;
}
```

- 按**连续录 + 分片**语义定义,不按"一场一起停"。
- `startedAt` 由 backend 给准,recorder 不再自己盖时间戳 —— 这正是 §2.6 那个 bug 的根。
- 旁路实现(用户自有 OBS):`splitChunk()` 退化成 `StopRecord` + `StartRecord`
  (拿得到 `outputPath`,因为没开分片);缺头照旧,`headroom` 为负如实记录。

---

## 7. 失败面与可观测性

零配置的代价是失败更隐蔽:用户不再看得见 OBS 的预览窗,**钩不上游戏 = 一片黑,
而且完全无声**。

1. **静态缩略图自检**:每个分片关闭后抽一帧存进索引,设置页与录像 tab 显示
   "最近一次录制"。**抽帧不能用 ffmpeg(没有)** —— 用 websocket 的
   `SaveSourceScreenshot` 直接从源截图,不碰视频文件,比解码还省事。
2. **全黑帧检测**:截图近乎全黑 → 明确报"没钩上游戏画面",而不是黑屏。
3. **补 `<video>` 的 `onError`** —— 删 VideoDock 时把那句"建议 Hybrid MP4"一起删了
   (commit 3754c31),现在解不了的容器就是一块静默黑屏。
4. **杀软 / SmartScreen**:`graphics-hook64.dll` 注入 + 三个 helper exe 现在由 gladlog
   触发,而今天这些风险由用户自装、已被信任的 OBS 承担。要测误报。
5. **RDP 下必失效**:Windows 在 RDP 会话断开时会移除虚拟 GPU,采集与录制随之死掉。
   这是 Windows 行为不是 OBS bug。要识别并明确报错,别让用户以为是我们坏了。
6. **磁盘预检**:下载 179MB + 解压 115MB + 录像配额 80GB,启用前先查可用空间。

---

## 8. 打包与平台守卫

比内嵌路线轻得多 —— **没有原生模块**,`package.json` 的 `build` 块几乎不用动。

| 项            | 做法                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 新依赖        | 无。下载 / 解压 / spawn 全用 Node 内置 + 系统 `tar`                                                                             |
| 安装包体积    | **不变**                                                                                                                        |
| 平台守卫      | 托管模式仅 win32。非 win32 上设置项禁用并说明;`recordingEnabled` 强制 false                                                     |
| 死配置        | 仍然**删掉 `packages/desktop/electron-builder.yml`** —— 它的 `files` 白名单会丢 node_modules,是颗独立于本路线的雷,顺手拆        |
| userData 布局 | `<userData>/obs/{download,32.2.1/}` 与 `<userData>/recordings/` 分开;录像**绝不**进 `matches/`(matchStore 自愈会 rmSync 整目录) |
| CI            | ubuntu E2E 断言非 win32 下不拉起任何子进程、不下载;Windows 侧靠 §9.4 的自检命令,不进 CI(要下 179MB)                             |
| 许可物料      | 无 —— 我们不分发 OBS 字节。但要在设置页与文档里写明"将从 obsproject 官方下载 OBS Studio(GPL-2.0-or-later)",并给出链接           |

---

## 9. 验收判据与测试策略

### 9.1 缺头(确定性,可固化进门规)

`headroomMs = source.startTime − chunk.startedAt`,直接从 `recordings.ndjson` 算。

- **一期基线**:恒为负。第 0 段修完对齐后先测一轮拿真实分布。
- **二期目标**:恒为正(唯一例外见 §5.5,且必须被显式记录而不是静默)。

### 9.2 对齐

确定性单测:给定 `lag`,断言 `videoS(battleS) === battleS − lag`;覆盖
`startedAt > source.startTime`(今天零覆盖)、`<`、`===` 三侧。

### 9.3 mac 上能验的(本设计的大部分)

配置文件生成(basic.ini / user.ini / global.ini / config.json / 场景 JSON,逐键断言)、
命令行组装、sentinel 清理、分片账本与对局归属、索引 schema 迁移、双闸配额与
"分片里还有一场就不删"、下载器(哈希校验 / 断点 / 空间预检,用本地 fixture 服务器)、
选择性解压清单、状态上屏、黑帧判定(喂固定像素)、`CaptureBackend` 契约(fake backend)。

### 9.4 Windows 自检命令(用户拍板的验证方式)

`npm run recorder:gatecheck --workspace=packages/desktop`,一发命令打印一张表:

| 列                | 含义                                                              |
| ----------------- | ----------------------------------------------------------------- |
| download / verify | 下载与哈希校验(已下过则跳过)                                      |
| extract           | `tar -xf` 是否可用、选择性解压后落地大小                          |
| spawn             | OBS 是否起来、**有没有弹模态框**、cwd 假设对不对                  |
| websocket         | 能否连上、协商到的 obs-websocket 版本                             |
| profile           | 生效的 profile / collection 名是否是我们要的(防静默回退)          |
| encoders          | 枚举到的可用编码器,选中哪个                                       |
| **gpu**           | **OBS 与 WoW 是否在同一块 GPU 上(混合 GPU 笔记本的头号黑屏成因)** |
| **integrity**     | **WoW 是否提权而我们没有(第二号成因)**                            |
| **hooks**         | **RTSS / MSI Afterburner 等冲突覆盖层是否在场**                   |
| **capture**       | **截图是否全黑(托盘态钩取确认)**                                  |
| split             | `SplitRecordFile` 是否成功、`RecordFileChanged` 是否带新路径      |
| bitrate           | 实测一分钟录像的字节数 → 反推真实码率,用来定 §10 U2               |

(headroom 列 2026-08-03 复审后已从脚本删除 —— 那一格模拟的是对局边界,和这个脚本
实际探测的 Windows 硬件/权限/驱动问题不是一类判据;这里同步删除,不留一列
「文档说有、脚本没有」的幽灵列。)

### 9.5 CI

- ubuntu:现有 E2E 全绿(证明非 win32 守卫有效)。
- 本机绝不直跑 `test:visual`(视觉基线由 CI 生成)。

---

## 10. 风险与未决

### 已定(2026-08-02)

U2 由用户拍板;其余按设计倾向定,用户未否决。全部可在自检实测后回调。

| 编号   | 决定                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------ |
| **U1** | 空闲期分片间隔 = **10 分钟**。自检实测分片碎片度与挂机段占盘后可回调                             |
| **U2** | **1080p60 / 8Mbps**(用户拍板)。§9.4 的 bitrate 列实测真实码率与 CPU 占用后可回调                 |
| **U3** | **做** `CreateRecordChapter` 章节标记(开场 / 结束)。只有 hybrid_mp4 支持,正是我们的容器          |
| **U4** | **默认只录桌面音,不录麦克风**(隐私默认关);麦克风做成设置开关                                     |
| **U5** | **钉死 OBS 32.2.1**,gladlog 发版时手动升,不做自动更新(`--disable-updater` 已关掉 OBS 自更新)     |
| **U6** | `PRE_ROLL_S` = **3 秒**(与 arenacoach 一致)。先全局一个值,真机看下来若不同事件类型需求不同再分档 |

**存疑待实测**:arenacoach 自称一场 5–20MB,折算约 0.5 Mbps,与 U2 差两个数量级
(§2.12)。不采信该数字,但它说明「回放复盘够用」的码率可能远低于直觉 ——
§9.4 的 bitrate 列拿到真实数字后,U2 有下调空间。

### 风险

| 风险                                                                                                                                                    | 应对                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **混合 GPU 适配器不匹配**(OBS 与游戏不在同一块 GPU)—— 笔记本上的头号黑屏成因                                                                            | §9.4 自检的 gpu 列;检测到就明确报错并给出「高性能 GPU」设置指引                             |
| **完整性级别不匹配**(游戏提权而我们没有)—— 第二号黑屏成因                                                                                               | §9.4 自检的 integrity 列;检测到就提示以管理员身份运行                                       |
| RTSS / MSI Afterburner 等覆盖层钩子冲突                                                                                                                 | §9.4 自检的 hooks 列                                                                        |
| 托盘态 game_capture 钩不上 —— **已降级**,源码级因果链 + 自然实验支持可行(~95%)                                                                          | §3;仍由 §9.4 确认一次                                                                       |
| 便携路径的 cwd 依赖是**推断**                                                                                                                           | 同上,一并实测                                                                               |
| 无人值守启动被模态框卡死(崩溃哨兵 / 首次向导)—— **危害被低估了**:模态框抢焦点会让独占全屏的游戏停止渲染,所以它不只是卡住启动,**还会毁掉正在录的这一场** | §5.2 删 sentinel + 预写 FirstRun;§5.4 的「窗口永不显示」;自检命令里「有没有弹框」是独立一列 |
| `RecordStateChanged` 在 STARTED 带 outputPath 是**未文档化行为**,可能回归                                                                               | §5.5 兜底扫目录;绝不依赖 `StopRecord.outputPath`                                            |
| `Video/AutoRemux` 静默改名                                                                                                                              | 防御性写 `"false"`                                                                          |
| 与用户自有 OBS 撞车                                                                                                                                     | 便携模式锁天然隔离 + `--multi` + 非默认端口(§2.4)                                           |
| 179MB 首次下载失败 / 国内慢                                                                                                                             | 断点重试 + 明确进度 + 失败可退回 §5.7 的自有 OBS 旁路                                       |
| 磁盘吃满                                                                                                                                                | §4.2 双闸配额第 0 段就接线;含挂机段的分片主动删                                             |
| RDP 下静默失效                                                                                                                                          | §7.5 识别并明确报错                                                                         |
| 杀软 / SmartScreen 误报                                                                                                                                 | §7.4,进计划测                                                                               |
| OBS 是 GPL-2.0-or-later                                                                                                                                 | 独立进程 + websocket = 聚合;且**我们不分发它的字节**,首次运行从官方下                       |

---

## 11. 与既有文档的关系

- 本文**修正**评估文档 §3A 关于"用 OBS Replay Buffer 或自己 ffmpeg 裁剪"的设想 ——
  **OBS 便携包里没有 ffmpeg**(§2.2),裁剪路线不成立;本设计改用分片 + 长文件窗口
  播放(§5.5),而这依赖 §2.7 那套当初为 shuffle 建的现成机制。
- 本文**修正**评估文档 §2「打包隐患」一节(补上 `npmRebuild` / `files` 两个隐形默认值)。
- 本文**承接**评估文档 §4「与路线无关、无论如何都要做的部分」—— 其中"配额从第一版
  就接线"一期未兑现,在 §4.2 补上。
- 一期计划文档保持原样(它是已完成工作的记录)。

---

## 附录 A:路线对比与退路

2026-08-02 用两轮并行调查(共 7 个代理)得出。用户先选 B、后改 D。留档是为了两件事:
§3 的门若没过要知道退路;免得日后重新论证一遍。

|              | **D. 托管 OBS 便携实例**(已选)                  | **B. 内嵌 noobs**                                         | **E. 不换采集端** |
| ------------ | ----------------------------------------------- | --------------------------------------------------------- | ----------------- |
| 零配置       | ✅ 首次运行自动下并配好                         | ✅ 装了就有                                               | ⚠️ 引导式         |
| 缺头         | ✅ 连续录 + 定点分片,头天然全                   | ✅ 原生 buffer 回溯转档,一次调用出一个含头的文件          | ✅ 但要自己解决   |
| 需要裁剪工具 | ❌ **不需要**(长文件窗口播放)                   | ❌ 不需要(引擎内建)                                       | ⚠️ 需要           |
| 体积         | 安装包不变;用户机 +115MB(选择性解压后)          | 安装包 +35MB 下载 / +84MB 磁盘                            | 0                 |
| 许可         | ✅ 不分发 GPL 字节;独立进程 + socket            | ❌ 发行安装包变 GPL-2.0 衍生作品                          | ✅ 不变           |
| mac 可验证性 | ✅ 配置 / 账本 / 索引 / 下载器全可验,采集要真机 | ❌ 原生层完全验不了(mac 上 `npm install` 直接失败,已实测) | ✅ ~90%           |
| 主要代价     | 净新下载器;无人值守启动五个坑;托盘态钩取未验证  | GPL;注入 DLL 的杀软面;依赖 3 star、单作者、0.0.x          | 不是真零配置      |

**竞品数据点(2026-08-02 补)**:arenacoach.gg 的桌面端选的是**内嵌路线**
(obs-studio-node),并因此是 GPL-2.0-or-later(§2.12)。它无所谓,因为本来就开源;
gladlog 选 D 正是为了不付这个代价。所以「竞品选了 B」不构成改选 B 的理由 ——
两边的约束不一样。

**退路**:§3 的门若没过(托盘态钩不上),按以下顺序考虑 ——
① 让 OBS 显示但置于后台(牺牲一点"隐形"体验);② 回到 B(用户已表态接受 GPL);
③ 回到 E,只交付第 0 段 + 引导式安装。

三条路线**共用第 0 段的全部地基**,所以第 0 段的工作无论最后走哪条都不白费。
