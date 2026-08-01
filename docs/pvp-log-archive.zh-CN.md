# PvP log 长期归档

[English](pvp-log-archive.md) · **中文**

`packages/corpus-tools` 下的 `scripts/archivePvpLogs.ts` 每 6 小时扫一次
wowarenalogs.com 公共 feed,把新出现的公开对局以**原始 gzip 字节**下载并归档到
Google Drive,按天分目录存放。只采集不加工——不解析、不算指标、不改动原始字节。
合规依据(数据源、条款、采集自律)见 [DATA-COMPLIANCE.zh-CN.md](DATA-COMPLIANCE.zh-CN.md);
设计与每个参数背后的实测数字见
`docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`。

## 启用前的前置条件

归档器当前用的 `gdrive:` rclone remote 配置的是 **rclone 内置的共享 Google Drive
client_id**。每次调用 rclone 都会打印一条提示,说这个共享 client_id 即将退役、
2026 年内会停止工作。在把归档器打开做长期无人值守运行之前,应先建自己的
client_id:https://rclone.org/drive/#making-your-own-client-id

如果跳过这一步、共享 client_id 之后真的被停用,归档器这边的表现是**静默失败**:
`rclone copy` 返回非零,本次运行保留本地暂存并等下次重试,于是暂存目录只涨不清。
下面的 20GB 剩余空间保护最终会让进程停下来,但那是**停机**,不是**告警**——没人会
知道原因。

## 怎么跑

```bash
cd packages/corpus-tools
npx tsx scripts/archivePvpLogs.ts
```

需要 `PATH` 上有 `rclone` 且已配置好 `gdrive` remote(或用 `RCLONE_REMOTE` 指向
其他已配置的 remote 名)。

## 环境变量

| 变量                | 默认                                      | 说明                                     |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| `ARCHIVE_ROOT`      | `$HOME/code/gladlog-eval-private/archive` | 暂存与账本根目录                         |
| `RCLONE_REMOTE`     | `gdrive`                                  | rclone remote 名                         |
| `DOWNLOAD_SLEEP_MS` | `2000`                                    | 下载间隔,**别调成 0**(上游是志愿者项目)  |
| `MAX_PAGES`         | `2000`                                    | 每 bracket 每次运行的翻页上限            |
| `DRY_RUN`           | 空                                        | `1` = rclone 带 `--dry-run`,本地暂存不删 |

`DOWNLOAD_SLEEP_MS` 与 `MAX_PAGES` 经 `parseThrottleEnv`(`src/archivePlan.ts`)
处理,带**硬下限**,但两类「无效」待遇不同。**空串或压根没设**会被当成
「这个变量没配置」,静默退回默认值、不打印任何东西——这是变量单纯没设的正常
情况。**非数字、或低于下限的取值**待遇不同:同样退回默认值,但脚本会打印一条
`console.warn` 点名具体是哪个变量、什么取值,因为这种情况通常意味着变量被
设成了错的东西,而不是单纯没设。`DOWNLOAD_SLEEP_MS` 的下限是 250ms
(`MIN_DOWNLOAD_SLEEP_MS`);`MAX_PAGES` 的下限是 1。两种情况都不能静默变成
`0` 的原因:`Number("")` 是 `0`、`Number("2s")` 是 `NaN`,而
`setTimeout(r, NaN)` 表现等价 `0ms`——不拦截的话,两者都会静默取消对上游
feed 的礼貌节流。

## 为什么存压缩字节

GCS 侧每份日志本就以 gzip 存储(`content-encoding: gzip`)。下载并直接落盘压缩
字节、而不是先解压再存,实测在同一批对象上小 **11.4 倍**。这让一块 5TB 的
Google Drive 的可用时长从解压存的约 **27 周** 变成压缩存的约 **6 年**——是本设计
里收益最大的单点决定。背后的实测数字(feed 深度、单场体积、增速)见设计文档
「实测底数」一节。

## 装成定时任务(launchd)

plist 文件在 `packages/corpus-tools/ops/app.gladlog.pvp-archive.plist`,
**不会自动装载**——把它提交进仓库本身什么都不会发生。**什么时候启用由使用者
决定**,这篇文档不替你拍板。当前计划是等 2026 年 8 月下旬新赛季开始时再启用:
基线本就该反映当前赛季的 meta,赛季初开始攒是干净的起点。

装载:

```bash
sed 's|<仓库路径>|/绝对路径/到/gladlog|' \
  packages/corpus-tools/ops/app.gladlog.pvp-archive.plist \
  > ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
launchctl load ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
```

停用:

```bash
launchctl unload ~/Library/LaunchAgents/app.gladlog.pvp-archive.plist
```

一天跑 4 次(本机时间 01:00 / 07:00 / 13:00 / 19:00),日志写到
`/tmp/gladlog-pvp-archive.log` / `.err`。用 launchd 而不是 cron 是刻意选择:
合盖错过的任务 cron 直接跳过不补,而 launchd 的 `StartCalendarInterval`
会在唤醒后补跑。

## 运维注意

1. **新增 0 场要当故障看,不是「今天正好没有」。** 正常每次运行都该有上千场
   新增。0 说明 feed 挂了或查询失效(如上游改了 schema)——脚本会打一行明确的
   警告,但不会主动通知任何人。feed 检索窗口仅约 7 天,这种故障静默持续一周就是
   **永久**丢一周数据。
2. **启用时机由使用者决定,plist 不会自己动。** 当前计划见上面「装成定时任务」
   一节的说明与装载/停用命令。

## 已验证到什么程度

**已真机验证**(完整数字见
`.superpowers/sdd/2026-08-01-pvp-log-archive/task-6-report.md`):对活 feed 单页
扫描、下载并暂存压缩字节、上传到 Drive、账本只在上传确认成功后才写入、以及连续
两次运行间的账本去重(首轮:114 场确认上传,之后本地暂存清空,`rclone ls` 在
Drive 上看到 115 个文件 = 114 个 `.txt.gz` + 1 个 `index.jsonl`)。

**尚未真机验证**:一次完整的首次全量跑,预计约 22 小时(见设计文档「首次运行」
一节)。只有跑这么久才会触发的四条分支目前只有单测覆盖、无真机证据:每 200
场/500MB 的分批冲刷、200 连续已知的停止翻页阈值、20GB 剩余空间保护、以及冲刷
上一次运行遗留的暂存。

**下次真机冒烟第一件事该核实的风险**:`classifyIndexFetch`
(`src/archiveUpload.ts`)靠一个匹配 `rclone` stderr 文本的正则,判断
`rclone cat` 失败的原因是「当日云端索引本就还不存在」(正常情况,按空索引继续)
还是「真的读失败」(必须放弃本次冲刷、保留本地暂存)。这个正则从未在真机上对过
`rclone cat` 的实际输出。两种误判后果**不对称**:把「不存在」误判为「读失败」
只是少赚一次冲刷机会,下轮还能重试,代价小;而把「读失败」误判为「不存在」会
用本地这一批**覆盖掉云端当天完整的索引**——这是不可逆的。下次真机冒烟应最先
核实这一条。

下次冒烟也应该改用 `MAX_PAGES=3` 或更多,并且**按 `logObjectUrl` 计重,不是按
match `id`**。Solo Shuffle 一场打 6 轮,6 轮共享同一个 GCS 日志对象但各有不同
的 id——按 id 计重对这整类重复是失明的。
