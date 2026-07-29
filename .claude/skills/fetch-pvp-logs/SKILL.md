---
name: fetch-pvp-logs
description: 按专精/分数过滤,批量下载其他玩家的 WoW PvP 原始 combat log(wowarenalogs feed)。Use when asked to 下载他人对局/拉外部 log/按专精分数攒语料/找某专精高分场次样本。
---

# 下载他人 PvP combat log(按专精/分数过滤)

数据源:wowarenalogs.com 公共 feed(用户自有旧产品,数据主权在用户,匿名可查)。
2026-07 全渠道普查结论:**这是全生态唯一**收集并公开分发他人 PvP 原始 combat log
的渠道——Warcraft Logs 无 PvP 且不提供原文,Blizzard API 只有排行榜,其余社区站
(Murlok/Drustvar/check-pvp/RatedTracker/PvPLogs/REFlex)全是记分板元数据。

下载物 = 标准 WoWCombatLog 单场片段(`ARENA_MATCH_START` → `ARENA_MATCH_END`),
gladlog parser 直接可解析。

## 用法

```bash
cd packages/corpus-tools
SPEC=Shaman_Restoration MIN_RATING=2100 LIMIT=20 npx tsx scripts/fetchPvpLogs.ts
```

| 环境变量     | 默认                                                      | 说明                                                                                                              |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BRACKET`    | `3v3`                                                     | `2v2` / `3v3` / `Rated Solo Shuffle`                                                                              |
| `MIN_RATING` | 0(不过滤)                                                 | **只有 1400/1800/2100/2400 四档生效**(服务端按场均 MMR 分档;传 2700 等效 2400)                                    |
| `SPEC`       | 空(不过滤)                                                | 逗号分隔,数字 specId 或 `CombatUnitSpec` 枚举名(如 `Shaman_Restoration,105`)。多 spec = 同一队同时含这些专精      |
| `SPEC_ROLE`  | `recorder`                                                | `recorder`=上传者本人是该专精(advanced logging 视角最优,做该专精分析用这个);`any`=场上任意玩家(敌我不限,样本量大) |
| `LIMIT`      | 20                                                        | 本次运行**新下**的场数(断点续传自动跳过已下载)                                                                    |
| `OUT_DIR`    | `$GLADLOG_EVAL_HOME/downloads/<bracket>-<rating>-<spec>/` | 落盘目录                                                                                                          |
| `MAX_PAGES`  | 40                                                        | 翻页兜底(spec 的 recorder 细筛在客户端,冷门条件别无限翻——深翻页读费记在志愿者项目账上)                            |

产物:每场 `<matchId>.txt` + `manifest.json`(bracket、`playerTeamRating`、双方 MMR、
胜负、时长、记录者与全员的 spec/个人 CR、GCS meta 时区/年份——log 内时间戳无年份
且为上传者本地时区,重建绝对时间必须用 manifest 里的 `gcsMeta`)。

专精 id 速查(治疗):105 奶德 / 270 奶僧 / 65 奶骑 / 256 戒律 / 257 神牧 / 264 奶萨 / 1468 奶龙。
全表见 `packages/parser-compat/src/enums.ts` 的 `CombatUnitSpec`。

## 已知坑(全部 2026-07-29 实证)

- **feed 只覆盖最近约 7 天**(服务端 stub 7 天过期;GCS log 对象约 30 天)。攒语料
  要隔几天重跑同一命令——断点续传保证只增不重。没凑满 LIMIT ≠ 出错,是近期就这么多。
- `MIN_RATING` 必须与 `BRACKET` 同传(裸 minRating → Firestore FAILED_PRECONDITION);
  脚本已处理,手写 GraphQL 时注意。
- comp 索引是 specId **字符串字典序**(`["263","1468"]` → `"1468_263"`),不是数值序;
  用 `buildCompQueryString`,别手拼。
- Solo Shuffle 一场 6 轮共用一个 log 文件,脚本按 `logObjectUrl` 去重,一场只下一份。
- 单场 log 可达 ~30MB(SS 整场);大批量下载注意磁盘与时长,参考 corpus-tools
  README 的产线经验。
- 评分语义:过滤档位按**场均 MMR**;manifest 里 `playerTeamRating` 是上传者队伍分、
  `players[].personalRating` 是个人 CR——三者可能略有出入(如 minRating=2100 会出现
  teamRating 2097 的场次),按需自行二次过滤 manifest。
- 礼貌频率:对方无限流,但这是志愿者项目的 Firestore/GCS 账单,别并发轰、别翻空页。

## 直接查 feed(不落盘)

GraphQL endpoint `https://wowarenalogs.com/api/graphql`,匿名 POST,introspection 开放。
复用 `packages/corpus-tools/src/feedClient.ts` 的 `fetchDetailedStubs`(服务端
bracket/minRating/compQueryString 过滤,分页 cap 50)+ `src/pvpLogFetch.ts` 的纯函数
(`parseSpecArg` / `matchesSpecFilter` / `dedupeByLogObject`)。别绕开它们手写谓词。

## 替代渠道(均已核实,别再调研)

- Blizzard PvP leaderboard API:只有名字/rating/胜负,无 log;可当「按 spec/rating
  圈定目标玩家」的筛选器用。
- wowarenalogs GitHub 仓库 `packages/parser/test/testlogs/`:个位数真实样本,无评分元数据。
- Warcraft Logs / Murlok / Drustvar / check-pvp / RatedTracker / PvPLogs / REFlex /
  SquadOV(已关站):拿不到原始 log,不用再看。
