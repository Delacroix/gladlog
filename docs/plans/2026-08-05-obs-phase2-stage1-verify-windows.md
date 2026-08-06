# OBS 二期 Stage 1 —— Windows 真机验收清单

分支 `worktree-obs-phase2`(未并 main)。目标:证明**托管录像产品链路**在真机上端到端成立,
而不只是底层机件能动。分两层跑,A 是机件、B 是产品,**A 全绿再跑 B**(A 挂了 B 一定挂,且 A 的报错更好读)。

前置:在 Windows 上把本分支 checkout 出来,`npm install` 过一遍(worktree 里若没有自己的
node_modules,模块解析会爬到别的 checkout)。**全程开着 WoW**,并进一局真排(2v2/3v3/solo shuffle 都行)。

---

## Layer A —— 机件门测(自包含,不用打包)

一条命令,把设计文档 §3 要真机确认的每件事一次跑完(下载→解压→写配置→spawn→连 websocket→
game_capture 出画面→录+切片→码率):

```powershell
npm run recorder:gatecheck --workspace=packages/desktop
```

它是**一次性探针**:写临时目录、不碰 app 代码,但 spawn/配置生成走的是产品同一套
`spawnManagedObs` / `writeObsConfig`,所以顺带就是这些模块的首次真机实跑。逐行验收:

| 行            | 通过长这样                                                                          | 挂了说明                                                                  |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `download`    | `OK (187817017B)`                                                                   | 哈希不符 → 会自删重下,连着两次不符是网络/镜像问题                         |
| `extract`     | `OK (…MB,全量未裁剪)`                                                               | `tar -xf 失败` → 系统 bsdtar 解不了这个 zip(§3 推断被推翻,得换解压路径)   |
| `gpu`         | 单卡:`(单卡,无适配器不匹配风险)`;多卡:记下 WoW 的 GPU 偏好                          | 多卡且截图黑,回来对 OBS 日志 `Loading up D3D11 on adapter` 那行是否同一块 |
| `integrity`   | `WoW 进程:运行中且句柄可访问(提权对等)`                                             | `ACCESS_DENIED` → WoW 提权而脚本没有,钩取会失败;**用同样权限重跑**        |
| `hooks`       | `无已知冲突覆盖层`                                                                  | 列出 RTSS/Afterburner 等 → 先关掉再判截图黑不黑                           |
| `spawn`       | `OK(OBS 日志确认就绪:portable + websocket started, ws://…)`                         | `未就绪` → 看它带的子进程状态;屏幕上有弹窗就是模态框没被 sentinel 压住    |
| `websocket`   | `OK obs-websocket 5.x`                                                              | 连不上但 spawn OK → IPv4/IPv6 绑定问题(脚本已双试,仍挂要看日志)           |
| `profile`     | `OK 生效的是 gladlog(便携路径 cwd 假设成立)`                                        | `静默回退了` → 便携 cwd 假设不成立,配置没被读进去                         |
| `encoders`    | `game_capture 在`                                                                   | 不在 → 便携包缺插件,截图/录像都免谈                                       |
| **`capture`** | `截图已存 …shot.png —— 打开看是不是黑的` → **人工打开 shot.png,必须能看到游戏画面** | **黑屏 = 托盘态 game_capture 钩不上,这是整个方案的生死项**(§3 头号风险)   |
| `split`       | `拿到 ≥2 个分片路径`                                                                | 0 个 → SplitRecordFile 没触发 `RecordFileChanged`,产品的逐场切片会失效    |
| `bitrate`     | 一个 Mbps 数字(用来定 §10 U2)                                                       | ——                                                                        |

产物目录会打印在最后一行(`gladlog-obs-gate`),截图和录像都在里面,自己看完再删。

**A 的验收线**:`capture` 非黑 + `split` ≥2 分片 + `profile` 是 gladlog。这三条过了,机件成立。

---

## Layer B —— 产品端到端(打包安装后)

A 验的是机件,B 验的是**装好的 app 里,开一局 → 自动录 → 那一场的分片被留下 → 点死亡跳到画面且不缺头**。

### B0. 出一个测试包(从本分支)

```powershell
npm run package:win --workspace=packages/desktop
```

装出来的 exe/zip 在 `packages/desktop/dist`。appId 是 `app.gladlog.desktop`(与已发布 v0.1.20-obs2.1
一致,所以是**就地升级**旧安装,不会并装出第二份)。装上、开 app。

### B1. 开托管模式 + 下 OBS

设置页 → 录像 → 录像模式选**托管**(默认就是它)。未安装会显示带 MB 数的**下载按钮**,点它下 OBS
(约 115MB,选择性解压后)。看进度条走完、状态变「已安装」。

> 注:`settings:save` 现在**不阻塞**在装配上 —— 存盘立即返回,状态由推送驱动,所以点保存不会转圈卡住。

### B2. 打一局真排

保持 app 开着,进 WoW 打一局。期间**不要**去动 app。要观察:

- 主界面应出现录像状态(在录 / 已就绪),**且不应出现「这段不会被录下」的横幅**。
- OBS 是托管的,录制时**不弹窗、不抢焦点**(弹了就是模态框没压住,回 A 的 spawn 行对)。

### B3. 打完看留存

对局结束、导入分析后,去 userData 的 `recordings` 目录(默认
`%APPDATA%\<app>\recordings`,`recordings.ndjson` 是索引):

- 含这一场的分片 `.mp4` **在**,纯挂机的分片被回收(不会无限涨,80GB 双闸)。
- `recordings.ndjson` 里这条记录的 `matchIds` 数组**含这一场的 id**(schema 2:一段素材可对多场,
  背靠背两局不会丢第二场)。

### B4. 验对齐 + 缺头(核心)

进这场的战报 → 回放/录像 tab:

- 视频能播、是这一场。
- **点任意一条死亡 / finding 的时刻 → 视频跳到那个事件本身**,不是晚了整个日志滞后量(2~20s+)。
  这是 stage 0 修的那个已发布 bug(offsetS 被 clamp 成 0),真机要确认没回归。
- **开场不缺头**:跳到最早的战斗时刻,前面还有画面(pre-roll 3s),不是从半路开始。

### B5. headroom 基线数(§9.1 的前后对)

跑一到几局、留下带对局的分片后:

```powershell
npm run recorder:headroom --workspace=packages/desktop
```

打印 `headroomS`(= 素材起点 − 对局开场)的中位数与分布,走的是渲染器同一套 `computeVideoWindow`。

- **stage 1 目标:大体为正、例外显式**(为正 = 录像起点早于开场 = 不缺头)。
- 若仍普遍为负,就是「录像总晚于开场」还没根治,记下中位数,这就是 stage 2 的「修前」数。

---

## 交回来我需要的

1. Layer A 那张表(整段贴回),重点 `capture` 是不是黑的。
2. B4 的结论:点死亡跳得准不准、缺不缺头(一句话 + 有条件的话截个图/录个 gif)。
3. B5 的 headroom 中位数一行。

这三样齐了,stage 1 就从「代码写完、本地全绿」升到「真机验过」,可以走发布或并 main。
其中任何一条挂了都不要自己硬扛 —— 把那一行/那个现象贴回来,大概率是 §3 里某条推断在真机被推翻,得改实现而不是改验收。
