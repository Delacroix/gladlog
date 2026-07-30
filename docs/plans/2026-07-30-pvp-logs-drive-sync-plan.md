# fetch-pvp-logs → Google Drive 归档(rclone)实施计划

2026-07-30 用户拍板:**方案 1(rclone)**、手动命令零调度、**不进产品包/release**
(纯 corpus-tools 层)。背景:wowarenalogs feed 只留 ~7 天,下载的他人对局语料
要长期存 Google Drive。

## 设计(brainstorm 定稿)

- 通道:rclone(自带 OAuth client,`rclone config` 一次交互授权;断点/重试/限速
  内建,30MB SS 大文件稳)。
- 结构镜像:本地 `$GLADLOG_EVAL_HOME/downloads/<slug>/` ↔ Drive
  `<remote>:gladlog-pvp-logs/<slug>/`。
- 增量语义:**裸 `rclone copy`**(size+modtime 跳过未变文件)——比 `--ignore-existing`
  正确:log 文件不可变天然跳过,`manifest.json` 每次 fetch 会长大,必须重传。
- 脚本形态:`packages/corpus-tools/scripts/syncPvpLogsToDrive.ts`,env:
  `REMOTE`(默认 `gdrive`)/`SRC`(默认 `$GLADLOG_EVAL_HOME/downloads`)/
  `DEST`(默认 `gladlog-pvp-logs`)/`DRY_RUN=1`。
  前置检查:rclone 存在(缺 → 装法提示)、remote 已配置(缺 → `rclone config`
  步骤提示);结束打印 `rclone size` 汇总。
- 纯逻辑(args 构建/listremotes 解析)进 `src/driveSync.ts` 配单测;spawn 壳不测。
- skill `.claude/skills/fetch-pvp-logs/SKILL.md` 补「归档到 Google Drive」一节
  (一次性 rclone 配置 + 日常两条命令 + 7 天节奏提醒)。

## 验收口径(诚实)

单测:args/解析纯函数。**真机上传本机验不了**(mac 无 rclone)——用户在装了
rclone 的机器上 `DRY_RUN=1` 先看清单、再实传一次;脚本对可预见失败(未装/未配/
拷贝非零退出)给可读指引而非堆栈。
