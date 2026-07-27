# OBS 录像集成评估报告(未拍板)

2026-07-27。对应 backlog #1。本文只评估,不做路线决定。材料来源:老 fork
(`~/code/wowarenalogs`,CC BY-NC-ND,**概念参考、落地必须 clean-room**)recorder
子系统通读 + gladlog 六个接缝逐点核实(均有 file:line 佐证)+ npm 生态现状。

## 0. 目标

自动录制竞技场对局视频,并与战斗日志时间轴同步回放——点死亡/finding/爆发窗
跳到视频对应时刻。

## 1. 老 fork 是怎么做的(概念提炼)

老 fork 用 `noobs`(Warcraft Recorder 作者的 libobs 原生 Node 绑定)**内嵌**了一个
OBS 引擎,核心设计五条:

1. **持续 buffer 录制 + 事后裁剪,而非事件触发起停**。根因:WoW 战斗日志不是实时
   写盘的,`ARENA_MATCH_START` 可能在实际开场 20 秒后才被观测到。所以 WoW 进程一
   跑就持续录 mkv 到 buffer 目录;开场事件到来时"提升"录制并回溯
   (`StartRecording(offset)`);结束后 ffmpeg 无重编码 stream-copy 裁出 mp4
   (`keyint_sec: 1` 保证关键帧吸附误差 ≤1s)。
2. **两个检测职责正交**:进程检测(tasklist 轮询,管 buffer 开关)vs 日志事件
   (管对局边界)。对局边界 100% 来自战斗日志解析器,recorder 本身不 tail 日志。
3. **录制时写墙钟锚点、播放时纯查表**:元数据记 `recordingBufferStartWallClockMs`、
   裁剪偏移等,播放端一对纯函数做 combatTime↔videoTime 双向换算。
4. **同名三件套关联**:`<name>.mp4/.json/.png`,json 内嵌 matchId;查找是全目录
   线性扫 json 子串匹配(作者自注 hacky)。
5. **`vod://` 特权自定义协议**播放本地视频:bypassCSP + 完整 HTTP Range(拖进度条
   的前提),base64 编路径避开 Chrome domain 小写规范化。

规模:recorder 包 3,910 行(17 文件,核心 `recorder.ts` 1,233 行)加播放组件
526 行、桥接 ~300 行,合计 ≈ **4,750 行**。且有三块"设计给出、落地烂尾":磁盘配额
SizeMonitor 未接线、视频处理真队列被注释、uiohook PTT 因打包冲突全部停用。

`noobs` 现状(npm 实测):v0.0.204,LGPL-2.0,解包 **85MB**,install 阶段
`node-gyp rebuild`(消费方需原生工具链/electron-rebuild),脚本用 Windows 路径写法,
**实质 Windows-only**(老 fork 里非 win32 直接 throw,包为 optionalDependency)。

## 2. gladlog 现有接缝(逐点核实)

| 接缝                      | 评级              | 落点                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「当前在对局中」布尔量    | **现成可用**      | `worker/pipeline.ts:77` 已消费 `hasOpenSegment()`(checkpoint 不推进),`parser/src/l2/segmenter.ts:139`                                                                                                                                                                                                         |
| 对局开场/结束**实时事件** | **需小改**        | 今天不存在——parser 只在 `ARENA_MATCH_END` 发 `match`,开场对 main 进程完全不可见。方案 A:pipeline 检测 `hasOpenSegment` 翻转(~8 行,拿不到 bracket/精确时刻);方案 B:segmenter 加 `segmentOpen` 回调(~25 行跨 2 包,带 bracket/zone/时间戳,更干净)。注意文件轮转 `createParser()` 会静默清掉 open 状态,需补 close |
| 开场检测延迟              | **硬约束 ~2s 起** | watcher 是批式 flush(`flushIntervalMs: 2000`,`main/index.ts:71`),叠加 WoW 自身日志写盘滞后(可达数秒~20s+)                                                                                                                                                                                                     |
| 时间域                    | **现成可用**      | `StoredMatchMeta.startTime/endTime` 是 epoch ms(`matchStore.ts:188`),与 `Date.now()` 同域,视频时间窗直接比对                                                                                                                                                                                                  |
| 视频↔match 关联存储       | **需新建**        | 🔴 **绝不能放 `<matches>/<id>/` 目录内**——re-store 自愈路径 `rmSync` 整目录(`matchStore.ts:443`),视频会被静默删。应独立 `<userData>/recordings/` + `recordings.ndjson` 索引,落库钩子在 `main/index.ts:77-80`(`r.meta` 在手,零额外 IO 回填 matchId)                                                            |
| 统一 seek 管线            | **现成可用**      | `SeekRequest{tMs,nonce}`(`ReplayView.tsx:60`)已被 10+ 组件复用(KeyMomentAxis/MistakesCard/KickDashboard/EventsPanel/StatsTable…),签名统一 `onSeek(tSeconds, unitNames)`                                                                                                                                       |
| 视频播放器挂载            | **需小改**        | 必须挂 ReplayView 内部,video 元素做回放时钟 `t` 的**从动件**——两处注释明写回放时钟刻意局部化防三视图热重渲(`MatchReport.tsx:66`、`ReplayView.tsx:120`)。这样 10+ 处 seek 入口零改动全部生效                                                                                                                   |
| 设置/IPC                  | 大半**现成可用**  | `settings:get/save` 泛型透传,preload 类型自动跟随;需加字段+默认值+**密码掩码**(`redactSettings`,照 `anthropicApiKey`)+ SettingsPanel 新 group;目录选择器硬绑 wowDirectory 需泛化(`ipc.ts:92-102`)                                                                                                             |
| recorderService           | **需新建**        | `main/recorder.ts`,照 analysis/compare 的 `createXService({getSettings, emit, …})` 工厂形状,创建于 `main/index.ts:164` 附近;退出钩子补 `:189-192`(否则留未闭合视频文件)。**不要放 worker 进程**——utilityProcess 崩溃隔离会连带杀录制连接                                                                      |
| 打包 extraResources 先例  | **现成可用**      | `reference_vectors.json`(`package.json:57-62` + `process.resourcesPath` 分支)                                                                                                                                                                                                                                 |
| 打包隐患                  | **需清理**        | 仓库有一份 **stale 的 `electron-builder.yml`**(`files` 白名单 + `npmRebuild:false`,与实际生效的 package.json `build` 块矛盾)——现在无害,但一旦内嵌原生模块后有人"修一下 yml"会同时炸掉原生模块两条命脉。内嵌路线的前置动作:删掉它                                                                              |
| macOS                     | **硬阻塞**        | 屏幕/游戏采集需 TCC 权限 + entitlements,现状是 ad-hoc 签名无公证(`build/afterSign.cjs`)。mac 录像不建议排期,Windows-first(backlog 原文一致)                                                                                                                                                                   |

## 3. 三条路线

### 路线 A:外控用户自装的 OBS(obs-websocket)

OBS 28+ 内置 websocket v5 服务;`obs-websocket-js@5.0.8` 是现成客户端。
recorderService 连 `ws://127.0.0.1:4455`,开场事件 → `StartRecord`,结束(或落库)
→ `StopRecord`(返回 outputPath)→ 按时间窗回填 matchId。

- **工程量**:开场/结束事件(8–25 行)+ recorderService(~300–500 行)+ 关联索引
  (~150 行)+ 设置(~100 行)+ `vod://` 协议(~70 行)+ ReplayView 内 video 从动件
  (~150 行)≈ **1–1.5k 行,天级**。零原生依赖、零包体增量、打包不动。
- **代价**:用户须自装 OBS、开 websocket、配好采集场景(游戏捕获源/分辨率/编码器)
  ——门槛转嫁给用户;与 FAQ 引流新用户的方向有张力。
- **开头缺失问题**:外控没有 buffer 回溯,开场检测延迟(2s flush + 日志滞后)意味着
  视频**开头缺几秒到几十秒**。三个应对(待选):
  1. 接受缺头(死亡/finding 极少发生在开场 10s 内,回放同步价值基本不损);
  2. 用 OBS Replay Buffer:对局结束时 `SaveReplayBuffer` 拿"最后 N 秒"覆盖整场
     ——N 须 ≥ 最长对局(长 lobby 内存/磁盘压力大),且拿到的是单文件无需拼接;
  3. 提前起录:检测到日志文件有写入活动(WoW 在打)就 `StartRecord`,结束后自己
     ffmpeg 裁剪——这就开始重新发明 buffer 模型,裁剪链的复杂度会往路线 B 滑。
- **健壮性**:OBS 没开/断连/用户手动停录都要降级为"这场没录",不能影响分析主链路。

### 路线 B:内嵌录制引擎(noobs,clean-room 复刻老 fork 概念)

用户零配置,开着 gladlog 就自动录(Warcraft Recorder 体验)。

- **工程量**:老 fork 等价物 ≈ 4,750 行,其中 `recorder.ts`(OBS 状态机、信号桥接、
  源属性协商、预览)是难度核心;加上 CC BY-NC-ND 约束下**必须 clean-room 重写**、
  buffer+ffmpeg 裁剪管线、墙钟锚点元数据。估 **4–6k 行,数周级**。
- **原生集成成本**(真正的大头,不在行数里):noobs 85MB + electron 38.8.6 ABI 的
  node-gyp rebuild(monorepo hoisting 下 CI 需实测)、OBS 运行时 DLL/插件目录走
  extraResources、asar unpacked 路径修正、noobs 版本间信号/属性名漂移(老 fork 里
  大量双名兼容防御)。前置:删 stale `electron-builder.yml`。
- **平台**:Windows-only(noobs 实质如此;mac 另有签名硬阻塞)。包体 +100~200MB。
- **许可**:noobs 是 LGPL-2.0,作为动态链接的 npm 依赖使用无碍;老 fork 代码一行
  不能抄,概念清单见 §1。

### 路线 C:两阶段(先 A 后 B,接口不变)

第一版走 A 打通"自动起停 + 关联 + 同步回放"全链路,`IActivity` 式的 9 行数据契约
(时间窗 + 命名 + 元数据)作为采集端抽象;价值验证后把采集端换成内嵌引擎,播放/
关联/seek 层零改动。老 fork 的"检测与录制正交"设计天然支持这个替换。

## 4. 与路线无关、无论如何都要做的部分(约 60% 工程量重叠)

1. 开场/结束实时事件(§2 方案 A 或 B);
2. `recordings/` 独立存储 + ndjson 索引 + 时间窗关联(带容差;Solo Shuffle 整
   lobby 一段视频对应 6 个 round,seek 按 round `startTime` 偏移即可,粒度正确。
   注意 shuffle 单轮 `endTime` 被夹到决胜死亡时刻,`compose.ts:153-163`);
3. `vod://` 特权协议(Range 支持);
4. ReplayView 内 video 从动件 + 墙钟换算(视频起点 epoch ms − match `startTime`);
5. 录像设置组(开关、目录、保留策略;A 路线加 websocket 地址/密码,密码走掩码);
6. 磁盘保留策略:15Mbps × 10min ≈ 1.1GB/场,当前库 794 场——**必须有配额+滚动
   删除**(老 fork 的 SizeMonitor 恰好是烂尾的,引以为戒:配额要从第一版就接线,
   且受保护标记要过删除过滤)。

## 5. 部署模型的坑(gladlog 特有,老 fork 没有)

gladlog 支持跨机日志中继(streamer→Google Drive→collector)。**视频只会存在于
游戏机本地**——1GB/场不可能走 Drive 中继。若分析/回放发生在 collector 机,视频
关联与播放整条链路失效。评估结论:录像功能定位为**游戏机本机特性**,跨机场景明确
降级(索引里 matchId 关联仍写,播放入口检测文件不存在则隐藏),第一版不做视频搬运。

## 6. 风险清单(浓缩)

| 风险                           | 路线 | 应对                                                     |
| ------------------------------ | ---- | -------------------------------------------------------- |
| 日志滞后 → 视频缺头            | A    | §3A 三选一,倾向先接受缺头                                |
| 视频被 matchStore 自愈路径误删 | 全部 | 存储物理隔离(§2 红线)                                    |
| OBS 断连/没开 → 静默漏录       | A    | 状态上报到 UI(照 `watching` 状态条模式),漏录不碰分析链路 |
| 原生模块 × electron-builder    | B    | 删 stale yml;extraResources;CI win runner 实测 rebuild   |
| mac 权限/公证                  | B    | 不排期 mac,Windows-first                                 |
| 磁盘吃满                       | 全部 | 配额第一版接线                                           |
| 许可(CC BY-NC-ND / LGPL)       | B    | clean-room + noobs 仅作依赖                              |

## 7. 倾向(供拍板,非决定)

**路线 C(先 A 后 B)**。理由:①两条路线 60% 工程重叠且全在 gladlog 侧,先做的部分
无论如何不白费;②"回放同步"的产品价值可用 1–1.5k 行、零打包风险先验证;③内嵌引擎
的原生集成是全项目未见过的风险类别(85MB 原生依赖 + ABI + OBS 运行时布局),值得在
链路已通、价值已证之后单独攻。触发升级 B 的信号:自己/用户实际用回放同步,且"要装
OBS"成为反馈里的真实门槛。
