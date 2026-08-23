# 12.1 时代 PvP 插件与外部软件的日志采集 / 实时反馈机制调研(2026-08-22)

> 目的:看清当前(Midnight 12.1)最流行的竞技场插件与游戏外软件**怎么拿数据、怎么反馈**,对照 gladlog 找可借鉴项。
> 方法:三路并行调研(游戏内插件 / 游戏外软件 / gladlog 自身链路),结论均附来源;查不到的明确标「未查到」,不补编。

## 0. 一句话结论

**12.0 起 Blizzard 把「插件读战斗事件做实时推理」这条路整条切断了**,而**磁盘 `WoWCombatLog.txt` 与 advanced combat logging 完全没动**。整个 PvP 生态被迫分成两层:

| 层           | 还能做什么                                                                                              | 代表                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 游戏内(实时) | 只能把官方已公开的东西「转显」:自己的 DR、Loss-of-Control、施法条、敌方名字/职业;敌方冷却/DR/光环为密值 | sArena Reloaded、MiniAuras、ArenaDR Nameplates、TrufiGCD            |
| 游戏外(赛后) | 事件级全量分析、录像、错误检测、AI 教练                                                                 | WoW Arena Logs、Warcraft Recorder、ArenaCoach.gg、Whisp / Ultima AI |

gladlog 已经站在第二层,而且是第二层里分析深度最深的(事件级 + 官方 DB2 + AI)。**真正缺的不是分析,是采集端的「零操作」体验和赛后→下一场之间的反馈闭环**。

## 1. 游戏内插件(实时层)

### 1.1 官方限制(决定一切的前提)

- **CLEU 对插件不可用**:12.0.0 起注册 `COMBAT_LOG_EVENT(_UNFILTERED)` 直接 `ADDON_ACTION_FORBIDDEN`;聊天框战斗日志改为 KString 不可解析。[wiki 12.0.0 API changes](https://warcraft.wiki.gg/wiki/Patch_12.0.0/API_changes) · [Planned API changes](https://warcraft.wiki.gg/wiki/Patch_12.0.0/Planned_API_changes)
- **Secret values**:冷却、光环、血量/能量、施法信息在「PvP 对局进行中 / M+ / 首领战 / 在战斗中」任一条件下变密值——可显示、不可读取。官方原话:addons "can't 'know' with certainty whether you or your target have a specific debuff currently active, or what the cooldown of a given ability is"。[Blizzard 2025-11 Combat Philosophy and Addon Disarmament](https://news.blizzard.com/en-us/article/24246290/combat-philosophy-and-addon-disarmament-in-midnight) · [wiki Secret values](https://warcraft.wiki.gg/wiki/Secret_values)
- **PvP 专项收紧(12.0.1)**:修掉了「读他人 CC spellId/时长」「读他人竞技场饰品冷却」两个漏洞;对局中 addon 通讯锁死。[wiki 12.0.1 API changes](https://warcraft.wiki.gg/wiki/Patch_12.0.1/API_changes)
- **唯一放宽**:PvP 里敌方**玩家**的名字/GUID/职业不是密值。
- 后续松绑(2025-12-17 白名单技能、治疗预测、施法条)**无一条涉及敌方冷却/DR**。[Wowhead](https://www.wowhead.com/news/blizzard-continues-to-loosen-addon-api-restrictions-and-whitelist-select-spells-379691)
- **磁盘日志不受影响**:`WoWCombatLog.txt` + `advancedCombatLogging` 照旧。[wowcoach](https://wowcoach.gg/blog/how-to-enable-combat-logging-wow)

> 坑:大量代练站文章声称「OmniBar 读 combat log 所以合规」,与官方 API 文档直接矛盾,且这些插件根本没有 12.x 版本。勿引用。

### 1.2 逐插件状态

| 插件                | ≤11.x 数据源与反馈                                                                                              | 12.x 状态                                                                                                                                                                                           | 热度              |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Gladius / GladiusEx | arena1-5 单位 + UNIT_AURA + CLEU 做 DR/冷却/饰品                                                                | 停更(最后 11.1 / 11.2),无 12.x                                                                                                                                                                      | 15.0M+5.4M / 4.9M |
| **sArena Reloaded** | 竞技场框体:施法条、光环优先级、DR 指示、饰品着色、驱散图标                                                      | **唯一活跃的 Midnight 竞技场框体**(v2.6.1c,2026-08-20,12.1.0)[CF](https://www.curseforge.com/wow/addons/sarena-reloaded)                                                                            | 2.2M              |
| OmniBar             | CLEU `SPELL_CAST_SUCCESS/AURA_APPLIED` + `GetArenaOpponentSpec` 定专精,本地冷却表计时,图标 `SetCooldown` + 发光 | 最后 v34 2025-08(11.2),无 12.x 提交                                                                                                                                                                 | 18.3M             |
| OmniCC              | 钩 Cooldown 框体画数字                                                                                          | 作者:只支持 Classic,Midnight 用 tullaCTC                                                                                                                                                            | 65.7M             |
| BigDebuffs          | UNIT_AURA + 手工优先级表                                                                                        | v68 2026-07-16 标 12.0.1+;PvP 内能否显示敌方 CC 未查到                                                                                                                                              | 23.8M             |
| Details!            | 旧版解析 CLEU                                                                                                   | 12.x 改为 `C_DamageMeter`(服务端校验的内置伤害统计)的皮肤;PvP 内可用性未查到                                                                                                                        | 366.5M            |
| Plater              | 姓名板 + UNIT_AURA + 脚本                                                                                       | 持续更新,但姓名板不能按光环染色、不能算可否打断 [Xepheris](https://gerritalex.de/blog/nameplates-in-midnight)                                                                                       | 100M              |
| WeakAuras           | 万能触发器                                                                                                      | **宣布不出 Midnight 版**:"tracking your own combat state [is] the core functionality" [Icy Veins](https://www.icy-veins.com/wow/news/weakauras-responds-to-addon-limitation-loosening-in-midnight/) | —                 |
| Diminish / DRList   | CLEU `SPELL_AURA_REMOVED/REFRESH`                                                                               | 2026-02-27 "remove retail toc",停在 11.2.7                                                                                                                                                          | 3.4M              |
| GladiatorlosSA2     | CLEU 事件 → `PlaySoundFile` 语音播报,50ms 节流                                                                  | 最后 2024-11(11.0.5),无 12.x                                                                                                                                                                        | 5.4M              |
| OmniCD              | 本地冷却表 + addon 通讯 Sync                                                                                    | 2026-07 更新但 12.x 下战斗中通讯锁死,Sync 应失效                                                                                                                                                    | 33.7M             |
| TrufiGCD            | `UNIT_SPELLCAST_SUCCEEDED` 显示最近施放                                                                         | 2026-04,12.0.1 有 Midnight 兼容更新                                                                                                                                                                 | 1.2M              |
| NameplateCooldowns  | CLEU + 冷却表                                                                                                   | 作者声明无法适配,停止开发                                                                                                                                                                           | —                 |
| BattleGroundEnemies | 战斗日志扫描敌方冷却/DR                                                                                         | 最后 2025-08,无 12.x                                                                                                                                                                                | 8.0M              |

**Midnight 新生态**(填补断档的新插件):

- **MiniAuras**(原 MiniCC,4.7M,2026-08-20,12.1):敌方 CC/减伤/踢/饰品 + 声音提示。[CF](https://www.curseforge.com/wow/addons/miniauras)
- **ArenaDR Nameplates**(29.7K,2026-08-22):把官方原生 DR 信息镜像到姓名板。[CF](https://www.curseforge.com/wow/addons/arena-dr-nameplates)
- **MyDRs**(27.8K):读 Loss of Control,只追踪**自己**的 DR。[CF](https://www.curseforge.com/wow/addons/mydrs)
- 官方自带 DR 显示"只追踪你自己能施加的 CC 类别"。Skill Capped / Venruki 的 Midnight UI 指南统一推荐 **sArena Reloaded + MiniAuras + BetterBlizzPlates/Frames**。[Skill Capped](https://www.skill-capped.com/wowarticles/general/pvp-addons-ui-guide/)
- 主播使用率数字:未查到。

### 1.3 赛后复盘类插件(记分板级,非事件级)

- **REFlex**:监听 `PVP_MATCH_COMPLETE`,调 `GetBattlefieldScore/GetBattlefieldTeamInfo` 等记分板 API,存 SavedVariables;胜率、常见/难打/好打阵容。12.x 正常(记分板 API 不属密值)。[GitHub](https://github.com/AcidWeb/REFlex)
- **ArenaAnalytics**(185.9K,1.3.6,2026-08-21,12.1.0):按场记录日期/时长/双方阵容/分数/MMR/首死,记分板每人击杀/死亡/伤害/治疗,Solo Shuffle 逐轮;过滤按 bracket/阵容/赛季/地图,支持否定搜索;闭源。[CF](https://www.curseforge.com/wow/addons/arena-analytics)
- **PvPLogs**(beta,2026-03):记分板写 SavedVariables,`/pl export` JSON 到网站(网站「in development」)。[CF](https://www.curseforge.com/wow/addons/pvplogs-beta)

## 2. 游戏外软件(赛后层)

### 2.1 共同地基:Blizzard 原生日志边界事件

`ARENA_MATCH_START,instanceID,unk,matchType,teamId` / `ARENA_MATCH_END,winningTeam,matchDuration,newRatingTeam1,newRatingTeam2` / `ZONE_CHANGE` / `COMBATANT_INFO`(天赋、PvP 天赋、装备、分数)。坐标/HP 需 CVar `advancedCombatLogging`。[wiki COMBAT_LOG_EVENT](https://warcraft.wiki.gg/wiki/COMBAT_LOG_EVENT)

### 2.2 逐产品

| 产品                                           | 采集                                                                                                                                   | 边界                                                                                                                 | 实时性                    | 产出                                                                                                                                                                                                                               | 商业/开源                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **WoW Arena Logs**                             | Electron 常驻;Win `fs.watch` 目录 / mac chokidar;字节 offset 增量读;读超时检测 + 磁盘空间告警;**配套自动 /combatlog 插件 2021 起失修** | START/END;shuffle = 连续 6 个参数相同的 START 聚合,`validateRounds` 要求恰 6 轮                                      | 赛后,场结束即上传         | 公开对局搜索、个人历史、CombatReport、统计页;另有 `packages/recorder`(noobs)                                                                                                                                                       | 免费;[GitHub](https://github.com/wowarenalogs/wowarenalogs) CC BY-NC-ND 4.0(非 OSI);最近推送 2026-06-27                   |
| **Warcraft Logs**                              | Companion(Overwolf)/ Uploader;live logging = tail 文件见新事件即上传                                                                   | —                                                                                                                    | 实时上传                  | PvE 为主;**PvP 报告类型未查到**(help/pvp 403);社区把 WAL 当 PvP 替代                                                                                                                                                               | 免费+订阅;闭源                                                                                                            |
| **Warcraft Recorder**                          | 要求 **SimpleCombatLogger** 插件 + advanced;`fs.watch(logDir)` + 增量 `fs.read`                                                        | START 开录、END 停录;shuffle 整场一个 activity 逐轮 `startRound()`;`ZONE_CHANGE` 出竞技场强制收尾;`UNIT_DIED` 做标记 | 实时录像                  | 赛后按场回放、死亡标记                                                                                                                                                                                                             | 免费 + Pro $5/月(云存储/多视角/分享);[GitHub](https://github.com/aza547/wow-recorder) 7.12.0(2026-08-18)                  |
| **ArenaCoach.gg**                              | 桌面端 `MatchLogWatcher`:`fs.watch` + 每文件字节位置 + 半行缓冲;切出 log chunk 上传,SSE 回传分析;内嵌 OBS(obs-studio-node)录 MP4       | START 起,END 或 zone change 止;最少 200 行防误判                                                                     | 赛后                      | **六类 mistake 时间线**:死时有减伤未用 / DR 重叠 / 有打断未打 / 减伤晚于致死伤害 / 错过击杀窗 / 浪费 CD;点击跳同步 VoD;宣称 185k 场 / 266 万条 mistake;排行榜、builds;自称「proprietary simulator engine 重建游戏状态」,无 AI 字样 | 免费层 + Premium;桌面端 [GitHub](https://github.com/brz456/arenacoach-desktop) GPL-2.0(检测逻辑在服务端,桌面端只切分上传) |
| **Whisp**(whisp.gg)                            | 桌面端后台自动录                                                                                                                       | —                                                                                                                    | 赛后                      | 「AI-powered coach」报告 + tips;beta 限额                                                                                                                                                                                          | 站点 DNS 不通,细节未查到                                                                                                  |
| **Ultima AI**(PVPQ.NET)                        | 未查到                                                                                                                                 | —                                                                                                                    | 赛后                      | 0–100 评分 + 加权拆解 + AI 追问聊天;宣称 20+ AWC/R1 选手标注 1000+ 场                                                                                                                                                              | waitlist;[站点](https://ai.pvpq.net/)                                                                                     |
| **WowCoach.gg**                                | 桌面端 watch log,每次 encounter 结束即上传                                                                                             | —                                                                                                                    | Pro 有 per-pull live 分析 | PvE 为主;AI 问答「Coach Clutch」                                                                                                                                                                                                   | $5.99(50 问)/ $12.99(200 问)每月                                                                                          |
| Check-PvP / Drustvar / Murlok / PvPLeaderboard | **Blizzard Profile API,不碰 log**                                                                                                      | —                                                                                                                    | —                         | 排行、tier list、top build                                                                                                                                                                                                         | —                                                                                                                         |

### 2.3 12.x 对外部工具的影响

- 磁盘日志格式与 advanced logging **未变**;AutoCombatLogger 已出 12.0.0 版。
- **外部报告的缺陷(已核查排除)**:论坛称 Midnight advanced log 的治疗量低于游戏内(奶骑 32M vs 40.2M),Blizzard 无回应。[EU 论坛 2026-03-23](https://eu.forums.blizzard.com/en/wow/t/healing-data-mismatch-in-game-uiaddons-vs-advanced-combat-log-in-midnight/612267)。**2026-08-23 用 HP 对账在 1092 + 150 回合上核查:治疗侧残差 2.6–2.9%,不高于伤害侧对照 3.0–3.5%,竞技场日志无治疗独有缺口**,见 `docs/coaching-grounding-audit.md` D8。核查过程顺带抓出一个真缺陷:`absorbsIn` 键是攻击者而非受害者,五处消费者用反(D7)。
- 12.1 对 combat log 格式的专门改动:未查到。12.1 新增 Training Grounds AI 对手竞技场。

## 3. gladlog 现状对照

| 维度           | gladlog                                                                                                                   | 同赛道最佳                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 找日志         | 仅 Windows 自动探测两处安装路径(`packages/desktop/src/main/detectWowDir.ts`),否则手选                                     | 同级                                                                                                                  |
| 实时 tail      | `fs.watch` 事件驱动 + offset/首行 sha1 断点续读 + rotate 检测(`worker/watcher.ts`、`tailReader.ts`)                       | **同级或更好**(三家都是 fs.watch + offset;gladlog 多了 rotate 校验)                                                   |
| 边界           | `ARENA_MATCH_START/END` 状态机,shuffle 分轮,`DOUBLE_START` 诊断(`parser/src/l2/segmenter.ts`)                             | 缺 **`ZONE_CHANGE` 兜底**(Recorder/ArenaCoach 都有);缺「6 轮完整性校验」(WAL)                                         |
| 自动开日志     | **无自研插件**,靠用户 `/combatlog` + 文档建议第三方;「忘记开日志」待办在 `docs/plans/app-feature-backlog.md:170-175` 未做 | Recorder 绑定 SimpleCombatLogger;WAL 自家插件已死                                                                     |
| 对局中实时动作 | 仅 OBS 录像起停(`main/recorder.ts`)                                                                                       | 同级(没人能做更多,见 §1.1)                                                                                            |
| 赛后分析       | 事件级 + 官方 DB2 + 候选门 + AI 教练 + 问教练 + 自学习 + 高手对比 + 视频双向跳转                                          | **领先**:ArenaCoach 六类 mistake 是 gladlog 的子集(减伤反事实 #17、DR/CC 链、kick、击杀窗、cd-waste 均已有且带谓词门) |
| 语料           | 794 场本地库 + 12.1 首周 10,682 场归档                                                                                    | ArenaCoach 宣称 185k 场                                                                                               |

## 4. 可借鉴项(按性价比排序)

1. **采集端零操作 —— 自研极简 addon 自动 `/combatlog` + advanced**(高)
   依据:所有成熟工具都卡在这一步,WAL 自家插件死了、Recorder 靠第三方 SimpleCombatLogger。12.x 下这个插件**不受任何限制**(只调 `LoggingCombat()` / 设 CVar,不读战斗事件),进竞技场自动开、出来自动关。顺带解决 backlog「忘记开日志」。可附带把 `advancedCombatLogging` CVar 检查结果写 SavedVariables,app 读到后在状态条提示。

2. **`ZONE_CHANGE` 出竞技场兜底收尾 + shuffle 6 轮完整性校验**(高,小改)
   依据:Recorder/ArenaCoach 用 zone change 防掉线/强退没有 END;WAL `validateRounds` 恰 6 轮。gladlog 目前异常只打 `DOUBLE_START`。可量化:扫归档里「有 START 无 END」的场次数作为前后数字。

3. ~~治疗量低估缺陷入谓词体检~~ —— **已做(2026-08-23)**:核查结论是不成立,已登记为排除项(审计台账 D8);真正需要修的是核查中发现的 `absorbsIn` 语义错位(D7,18.7% 回合判错「承伤最多的队友」,未修)。

4. **Mistake → VoD 点击跳转的体验对齐 ArenaCoach**(中)
   gladlog 已有 `VideoBattleTimeline` 双向跳转;差的是**从 finding 卡片一键跳到录像该秒**的直达路径(查 `FindingsList.tsx` 是否已接 vod 跳转;若无是小改)。

5. **上一场 → 下一场的「带着走」反馈**(中,替代不存在的实时层)
   游戏内实时已不可能,但可以做「排队时看上一场的 1–3 条要点」:app 在 `matchStored` 后推系统通知 / 小浮窗(Electron 原生,无需进游戏);自学习 `rules.json` 里的个人反复问题正好是素材。MiniAuras 的声音提示思路可借为「开打前语音念一句上一场的要点」——纯 app 侧,不违规。

6. **mac / Linux 日志目录自动探测**(低)
   WAL 在 mac 用 chokidar 匹配;gladlog 只探 Windows 路径。mac 用户(含作者自己)目前手选。

7. **Training Grounds(12.1 AI 对手)场次识别**(低,待实证)
   `ARENA_MATCH_START` 的 matchType 字段会不会出现新值,需从 12.1 归档语料实测;若混进 rated 统计会污染 bracket 分段。

### 不借鉴 / 无法借鉴

- 游戏内实时 overlay / 敌方冷却播报:12.x 官方封死,连 WeakAuras 都退出;**不要投入**。
- ArenaCoach 的「simulator engine」:宣传词,检测逻辑在服务端不可见,gladlog 已有更细的谓词体系。
- 云端排行/公开对局库(WAL):与 `docs/DATA-COMPLIANCE.md` 的本地优先定位冲突,且非核心。

## 5. 来源清单(主要)

- Blizzard 官方:[Combat Philosophy and Addon Disarmament](https://news.blizzard.com/en-us/article/24246290/combat-philosophy-and-addon-disarmament-in-midnight) · [How Midnight's changes impact combat addons](https://news.blizzard.com/en-us/article/24244638/how-midnights-upcoming-game-changes-will-impact-combat-addons)
- wiki:[12.0.0 API changes](https://warcraft.wiki.gg/wiki/Patch_12.0.0/API_changes) · [12.0.1](https://warcraft.wiki.gg/wiki/Patch_12.0.1/API_changes) · [12.0.5](https://warcraft.wiki.gg/wiki/Patch_12.0.5/API_changes) · [Secret values](https://warcraft.wiki.gg/wiki/Secret_values) · [COMBAT_LOG_EVENT](https://warcraft.wiki.gg/wiki/COMBAT_LOG_EVENT) · [Damage Meter](https://warcraft.wiki.gg/wiki/Damage_Meter)
- 开源仓库:[wowarenalogs](https://github.com/wowarenalogs/wowarenalogs) · [wow-recorder](https://github.com/aza547/wow-recorder) · [arenacoach-desktop](https://github.com/brz456/arenacoach-desktop) · [omnibar](https://github.com/jordonwow/omnibar) · [Diminish](https://github.com/wardz/Diminish) · [GladiatorlosSA2](https://github.com/immortalhz/GladiatorlosSA2) · [REFlex](https://github.com/AcidWeb/REFlex) · [sArena_Reloaded](https://github.com/Bodify/sArena_Reloaded)
- 产品页:[arenacoach.gg](https://arenacoach.gg/) · [warcraftrecorder.com](https://www.warcraftrecorder.com/) · [ai.pvpq.net](https://ai.pvpq.net/) · [wowcoach.gg](https://wowcoach.gg/blog/warcraftlogs-vs-wowanalyzer-vs-wowcoach)
- 缺陷:[Midnight advanced log 治疗量偏低](https://eu.forums.blizzard.com/en/wow/t/healing-data-mismatch-in-game-uiaddons-vs-advanced-combat-log-in-midnight/612267)
