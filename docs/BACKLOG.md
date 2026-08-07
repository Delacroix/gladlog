# gladlog feature backlog

Ideas not yet scheduled. Each is a starting point for a future brainstorm → spec →
plan cycle, not a committed design. Compliance: where an item references the old
fork (`/Users/mingjianliu/code/wowarenalogs`, CC BY-NC-ND) it's for the _concept_
only — any port is clean-room (controller extracts audit-CLEAN files; the app's
data is already gladlog-native).

---
> 已完成条目(#2-13、#15、#16、#20、多模型、spellNames 等)已移至
> [BACKLOG-archive.md](BACKLOG-archive.md),保留原编号与落地注记。

## 1. OBS / video recording integration

Record arena matches (video) and sync playback to the combat-log timeline — click
a death / finding / burst window and jump to that moment in the video.

> **2026-07-27 评估完成(未拍板)**:三路线(外控 obs-websocket / 内嵌 noobs /
> 两阶段)+ 接缝逐点核实 + 风险清单见
> `docs/plans/2026-07-27-obs-recording-integration-eval.md`,倾向两阶段先外控。
>
> **2026-07-28 一期开工(路线 C 拍板)**:外控 obs-websocket,`feature/obs-recording`
> 分支;计划 `docs/plans/2026-07-28-obs-recording-phase1-plan.md`。单测全绿;
> 真机(Windows + OBS)端到端待用户实测。

- **Old-fork reference:** `packages/recorder` (OBS bindings — `manager.ts`,
  `noobs.d.ts`, `activity.ts`, config schema) and the playback UI in
  `packages/shared/src/components/CombatReport/CombatVideo/VideoPlayerTimeline.tsx`
  - `CombatReplay/`. The roadmap explicitly deferred the recorder ("第一版不做"),
    so this is net-new work in gladlog.
- **Scope signals:** largest item here — a recorder subsystem (native OBS/noobs
  integration, Windows-first), on-disk video↔match association, and a
  video-timeline component. Likely its own multi-task sub-project. Decide first:
  drive OBS externally vs. embed a capture lib; how video files map to stored
  matches (by timestamp window).
- **gladlog seam:** the desktop app already stores matches with `startTime`/
  `endTime`; a recording started around a match window can be associated by time.
## Session follow-ups & hardening (smaller, not full features)

- **SP-A.1** — LLM-judge causal audit + digit/constant refinement (deferred from
  the SP-A honesty gate; causal/qualitative claims can't be verified
  deterministically).

- **Timeline-prompt token compression** — the timeline-variant prompt is ~76%
  larger than the sparse one; compress it (also helps the slow `claude -p` local
  backend).

- **CI code-signing / notarization** — wire macOS notarization + Windows signing
  secrets into `.github/workflows/build.yml` when certs exist, for zero-warning
  installs. See [[gladlog-packaging-gotchas]].

- **MatchStore hardening (accepted-low-risk today)** — `safeName` id collision →
  phantom duplicates; out-of-band `meta.json` edits go stale (index is a cache).
  Fine for the app-private store now; revisit if the store ever lives in a synced
  folder.


- **已归档条目的顺手遗留(正文见 BACKLOG-archive.md 对应节)**:#10 三条非阻塞 minor(dampening 泳道死区/panic 谓词拼写/resolveOwner 收敛)、#16 真模型 filler smoke 待真机、多模型对比的旧槽占位态状态行与 Export 撕裂。
## 17. 减伤数值反事实三件套(2026-07-27 记入,B站用户反馈同一线程)

用户诉求(战士视角原话大意):盾反后有 20% 魔法减伤,「20% 够不够我不知道」——
想要 AI 从数值角度反推验证他从控制角度得出的经验(吃满递减后盾反可以不给压制;
没吃过控则不够);以及既定事实不变、只重排技能时机/顺序的「可能性提示」(徽章
早交 → 盾反覆盖 2 发而非 1 发),不要求 100% 正确,试错闭环用户自己走。
「不是单纯 checklist 看还有什么没开」。

三个子件,按依赖排序:

1. **无必要外置判定**(可先行,小):敌方爆发 CD 都在很远、无伤害尖峰、目标满血
   时交的压制/外置 → 新候选「questionable external」。判据现成(敌方 CD 台账 +
   伤害曲线 + `annotateDefensiveTimings`),现状 Early 只定义为「爆发窗口前 N 秒」,
   无窗口无压力的施放落 Unknown 不被点名 —— 补一档即可。回应用户「总不能判定我
   压制没问题吧」。
   ✅ 落地(2026-07-30:`questionable-external` 候选 + MISTAKE_RULES 双注册,spec
   `docs/superpowers/specs/2026-07-30-counterfactual-design.md`;全库固定种子语料
   实证发生率 0.52%(cast 级,25/4780 外置施放命中三条件全否决),不落「判据过严
   ≈0」或「过宽 >50%」两个停手区间,按预案带阈值上线;
   `UNNECESSARY_TARGET_HP_PCT=80` 为先验值,待用户实测调优)
2. **减伤百分比表 + 分学派伤害拆分**(1、3 的共同地基):每个主要减伤的
   {百分比, 作用学派}(盾反 20% 仅魔法、铁木 20% 全、压制 40%…)。按
   [[official-data-over-heuristics]] 走 DB2 官方字段,但要实测覆盖率(与 DR 表
   同病)。学派字段日志本来就有(`spellSchoolId`,parser-compat 已解析,分析层
   未消费)。
   ✅ 表层地基(2026-07-30:MITIGATION_TABLE 双层 35 条无第三态,spec
   `docs/superpowers/specs/2026-07-30-mitigation-table-design.md`;学派覆盖率
   已量化 148/148 窗口 ≥90% 可归因;分学派伤害拆分消费留 #17 主体。含
   `positional?: true` 契约——条件减伤(196718 黑暗)给值时下放站位判定
   责任给 #17 消费方,不判定不得计入,详见 spec 决策记录第 4 条)
   ✅ 消费方已落地(2026-07-30,见子件 3 注记):A/B/窄门三形态算术全部按
   `schoolMask` 过滤窗内命中伤害,分学派拆分不再是待办。
3. **死亡窗口算术反事实 + 时序重排枚举**(大)⚠ 2026-07-30 全库量化(1310 死亡):「可用未按」开口率仅 5.6%(粗算 79.7% 系 kit-coverage 口径错觉,差 13 倍),主形态待转向——「已交减伤核算」开口 33.2%/「外置可用未给」23.0%,见 docs/reports/2026-07-30-counterfactual-feasibility.md;顺带发现 deathOutcome 外置白名单 7≠14 与 deathRecap zoneId 形状疑似 bug:死亡前 N 秒实际伤害流 × 假设减伤
   × 分学派,对比(最大血量 + 实际治疗量),输出三档 —— 明显能活 / 边缘 / 仍然死;
   只有「明显能活」(余量 > 15% 最大血量之类的硬门)才开口。重排枚举收窄为
   「窗口内每个 CC 解除点 × 徽章/未用防御」的十来个组合,只报明显更优的一个。
   ✅ A/B/窄门算术落地(2026-07-30,spec
   `docs/superpowers/specs/2026-07-30-counterfactual-design.md`):三档谓词单源
   (`counterfactualTier`,量化报告同口径)+ 三形态(`computeMitigationAudit`
   已交减伤核算 / `computeMissedExternalCounterfactuals` 外置可用未给 /
   `computeUnusedSelfCounterfactuals` 自己可用未按窄门)落到死亡回顾卡确定性
   显示 + `[DEATH]` prompt facts 双面输出(同一份算术,facts 先 floor 到渲染
   秒再进文本)。B 两条前置修复(外置白名单 7→14 收敛 + deathRecap zoneId 双点)
   随本轮一并修复,见 Task 2 提交(`ff8243e`)同判据前后数字。**17c(时序重排
   枚举)本期未做,仍是开放项**——决策记录已拍板 17c 后置,不在本期范围内。

注(挂账,未解决):Task 2 白名单收敛核实时顺带发现 `cooldowns.ts` 的
`FORBEARANCE_GATED_IDS` 含 `633`(Lay on Hands),但该 id 不在
`spellIdLists.externalDefensiveSpellIds`/`bigDefensiveSpellIds`/
`externalOrBigDefensiveSpellIds` 任一主白名单内(`ff8243e` 同期从
deathOutcomeAnalysis 的表外白名单里移除了同一个 633,理由是「不在主白名单
内」)——两处对 633 的取舍疑似不一致,尚未判定孰对孰错(LoH 本身是纯治疗、
排除出减伤/自保墙白名单可能是对的,但 Forbearance 门控又依赖它触发同一个
id),需要单独复核后再决定是否改动,见 git history(`ff8243e` 及其讨论)。
措辞走可能性框架(「若同窗叠加 X,该段伤害约降至致死线下」),与 causalLint
的因果断定禁令兼容,不用改门。**算术可行、模拟不可行**:治疗行为会变、对面会
换目标这类不建模,靠档位表达置信度。动手前先在语料量两件事:死亡窗口学派字段
覆盖率;「明显能活」档在真实死亡里的命中率 —— 若 90% 落「边缘」档,开口率
撑不起产品形态。

causalLint 正则仅英文,zh 产出为盲区(agy 300 盘模拟发现)——待补中文因果模式。

---
## 18. arenacoach 规则吸收第二批 + 第一批遗留(2026-07-27 记入)

第一批(DEATH-001/003 + TRINKET-001)已并入(计划 `docs/plans/2026-07-27-arenacoach-rules-batch1.md`,
语料发生率 63.6%/14.1%/15.6%,n=1245)。规则目录全景与吸收评估见当日会话结论;
第二批候选按白名单成本排序:

1. **DEATH-002 死时无敌可用**:需无敌子表 + Hypothermia 类共享 debuff 台账
   (Forbearance 已有先例 `FORBEARANCE_GATED_IDS`/`selfForbearanceActiveAt`)。
2. **COOLDOWN-001 CC 压手 >60/90s**:cd-waste 的进攻版;判据现成(availableWindows),
   需 CC 技能子表口径(Control tag 已有)。
3. **DEFENSIVE-001/002 治疗吃满 CC(有规避手段)/低血不循环小减伤**:需规避手段表、
   小减伤表 —— 按白名单纪律先语料实证。
4. **DISPEL late/failed 分层**:missed-cleanse 加时延维度,信息量升级。
5. **OFFENSIVE-001/002 锥形打空 / 打进大减伤且该切目标**:需锥形技能表 + 几何判定。

> **2026-08-06 挂钩 `#22`**:上面第 2/4 条(CC 压手、DISPEL 分层)不只是"锦上添花的新
> 候选"——它们正是 `#22` 那道 per-round 硬上限阀门的**取消条件**。`#22` 记录的是
> `cc-locked`/`missed-purge`/`missed-cleanse`/`wasted-trinket` 四类占候选菜单 64% 的
> 止血闸(硬顶,不是根治),根治要等这批新候选类型落地把菜单话题分摊开。

第一批遗留(终审/复审 defer 项):

- ✅「死亡时可用未按」三份异源实现收敛(2026-07-29):matchTimelineSections 的
  [DEATH] Unused(原手算 availableWindows 命中)、timelineHelpers 的
  [DEFENSIVE AVAILABLE](原手算 readyAt)改为直接 import 并调用 `cdAvailableAt`;
  candidateFindings 的 death-unused-defensive/external-unused 确认本就消费它。
  语义差异地图:timelineHelpers 那份写法与 cdAvailableAt 逐字等价(零语义差),
  matchTimelineSections 那份唯一差异是 availableWindows 表的 GRACE_SECONDS=3s
  短窗裁剪(该裁剪是为"更廉价替代品"建议设计的,不适用于死亡时点查询)——
  边界差仅在窗口<3s 的边缘场景触发,不构成"收敛必改输出且哪边对不自明"的停止
  条款。本机库固定种子(20260729)抽 60 场 timeline 变体 buildMatchContext 前后
  对比(33 个有相关行的 combat):[DEFENSIVE AVAILABLE] 0 场变化;[DEATH] Unused
  1 场变化、2 行(1 组 diff,同一行从 "(Unused: Spirit Walk)" 变
  "(Unused: Astral Shift, Spirit Walk)")。实锤验证方向:该场 Astral Shift 于
  88.226s 施放、cooldown 60s、readyAt=148.226s,死亡在 148.583s——技能确实已转好
  0.357s,旧版因 availableWindows 该窗口仅 2.357s(< GRACE_SECONDS)被整段裁掉而
  漏报,新版正确捕获,方向确认"旧实现是假阴性,新版是纠正"。防漂移单测
  `packages/analysis/test/cdAvailablePredicateConvergence.test.ts`:构造 4 组
  合成台账(从未用/刚用未转好/已转好/两次施放取最近一次),同时调用三个消费点
  与 `cdAvailableAt` 本身断言函数级一致。
- ✅ 追加轮(2026-07-29,同日):上条记的"范围外同类重复"审查复核后确认
  criticalMoments.ts 三处(`buildKillMomentFields` 的 mechanicalAvailability
  「on CD」文案判定 / interpretation 的 spentCDs / tieredOptions.unavailable
  的 allDefensivesSpent)与 matchNarrative.ts 的 `spentAtEnd`(`buildMatchFlow`
  Final Burst/Phase 段)共 4 处,均是 `!cdAvailableAt(cd, t)` 的单时点等价式
  ——机械替换为直接调用 `cdAvailableAt`,删本地 readyAt 手算。
  **liveness 更正(上条"是活代码"表述不准,一并修正)**:`identifyCriticalMoments`
  (内部调 `buildKillMomentFields`/`getOwnerCDsAvailable`/`buildDeathRootCauseTrace`)
  在 `buildMatchContext` 里确实无条件计算,但其渲染文本(CRITICAL MOMENTS 段、
  含本轮改的三处)只在 `useTimelinePrompt: false`(旧 sparse 变体)分支才写进
  `lines`——timeline 分支在渲染这段代码前已 `return`(代码注释原话:"timeline
  分支在此 return 前从不渲染,E2E 实测旧 139 场→新 0")。生产侧 `analysisInput.ts`
  与 `buildCorpus.ts` 默认都传 `useTimelinePrompt: true`,即当前产线从不渲染这
  一段——**本轮 4 处收敛的是仍存在于代码里、但当前默认链路不渲染的 sparse 变体**
  (`buildMatchFlow` 更进一步:全仓 grep 确认无任何调用点,纯粹是
  `@deprecated`/`@internal` 死代码)。用同一 60 场种子(20260729)以
  `useTimelinePrompt: false` 重建 prompt 前后对比:60 个目录里仅 1 个 combat
  的 CRITICAL MOMENTS 段命中本轮判定相关的文案模式(样本量小,因为多数
  moment 的 tieredOptions/mechanicalAvailability 分支本就为空);该 1 例前后
  0 行变化。真正的确信来自防漂移单测(同一
  `cdAvailablePredicateConvergence.test.ts`,扩到 5 个消费点、4 组合成台账
  全过)——4 处改动前的公式与 `cdAvailableAt` 逐字代数等价(无 GRACE_SECONDS
  类边界差),零漂移是可推导的必然结果,不是巧合。
  **matchNarrative.ts 的 `ownerDefsAvailableInWindow`(`buildMatchFlow`
  Post-Trade Window 段,约行 122-127)不属于此类——它是"窗口起点
  `firstBurst.toSeconds` 之前的施放 vs 窗口终点 `midEnd` 是否转好"的双时点
  检查(取 t1 时刻的最近施放,拿它去跟 t2 时刻比较是否转好),机械换成单时点
  `cdAvailableAt` 会丢失"t1→t2 之间又有新施放"这类信息、改变行为,故未动。**
  留待将来把 cdAvailableAt 泛化成双时点谓词,或确认现状(该函数本身
  `@deprecated`/`@internal`,已被 `buildMatchArc` 取代,仅为测试覆盖保留)即为
  最终形态——不当作本次遗留继续追踪。
  另,审查范围外新发现 criticalMoments.ts 的 `getOwnerCDsAvailable`(约行
  108-138)与 `buildDeathRootCauseTrace`(约行 218-249)也各自手算同一
  readyAt 公式;和本轮 4 处同属只在 sparse 变体渲染的代码,非本轮收敛范围
  ——留作下一次同类收敛候选(若届时 sparse 变体仍不在产线路径上,建议连带
  评估这整条 `identifyCriticalMoments` 分支是否该整体退休,而不是逐个补齐
  谓词)。
- victimCDs 的 Pick 缺 isThroughput(类型收紧);reconstructEnemyCDTimeline 在
  extractCandidateFindings 内两份重建(perf);扫描脚本内层 try/catch 无失败计数。
## 19. 自建 PvP log 采集与统一存储(训练语料)(2026-07-29 记入) —— 第一步(采集归档)已落地 2026-08-01

愿景:做一个**平均化采集**他人 PvP combat log 并**统一长期存储**的产品/管线,
作为模型训练资料——不是按需过滤式捞取,而是按 spec × bracket × 评分档的配额矩阵
均衡采样,消除"只采了热门专精/高分段/某几天"的语料偏差。

**现状与约束(2026-07-29 调研实证,细节见 `.claude/skills/fetch-pvp-logs`)**:

- 全生态唯一公开源 = wowarenalogs.com feed(**第三方志愿者项目,非自有**——我们只
  fork 过其代码;此前本仓合规注记写"自有产品"有误,已更正)。采集必须克制:
  分页 cap 50、别翻空页、频率礼貌,重度依赖前宜与维护者沟通。
- feed 检索窗口仅 ~7 天(GCS 对象 ~30 天)——想积累必须**定时轮询 + 自储**,
  错过即永久丢失。`fetchPvpLogs.ts` 的断点续传 + manifest 已是种子实现。
- log 时间戳无年份且为上传者时区,绝对时间在 GCS meta header;matchId = log 前
  16KB 的 md5,可做全局去重键。

**可能形态(未拍板,起 brainstorm 用)**:

1. **轮询归档器**:cron 跑 fetchPvpLogs 的配额矩阵版(每档每专精 N 场/天),
   落自己的存储(本地盘/对象存储),manifest 汇总成可查询索引。

   **✅ 已实现**(`scripts/archivePvpLogs.ts`,设计见
   `docs/superpowers/specs/2026-08-01-pvp-log-archive-design.md`)。范围收敛为
   只采集不加工;配额矩阵按用户拍板取消,改为全量收(一场 6 人 = 6 个专精观测,
   按专精筛反而更费对方 Firestore 且砍掉 5/6 样本)。

2. **自有上传端**:长期看做自己的采集客户端(gladlog log-pipeline 的跨机字节精确
   中继已是现成基础),玩家知情上传,才真正拥有数据主权与留存策略。
3. **训练资料化**:去重(matchId)、按 parser 可解析性过滤、脱敏策略(玩家名)、
   与现有 794 场自有库和 eval 语料的统一 schema。

合规注意:WAL 的 log 是玩家自愿公开上传,但**代码** fork 是 CC BY-NC-ND;
拿数据训练/商用前要单独过一遍数据侧合规,别混同代码许可。
## 21. 2026-07-31 全周审计 P2 挂账

本周全库审计(desktop 服务/main/IPC + analysis + corpus-tools)已修的 Important
另见对应提交;以下是审计中一并发现、判定为 P2(低危/低发生率/需真机验证)的
挂账项,记账不排期:

1. **DeathRecapCard 未接内联图标**:`packages/desktop/src/renderer/src/report/components/DeathRecapCard.tsx`
   未使用 `#15` 的 `ChipIcon`/`inlineRich`,纯文本渲染技能名。且
   `packages/desktop/src/renderer/src/report/derive/deathRecap.ts` 的
   `DeathRecapEvent`(L22-31)导出类型只有 `spell: string`(已转显示名),内部
   构造时用过的 `spellId`(如 L167/181/196/210 `d.spellId`)在类型层被丢弃——
   要接图标须先在 `DeathRecapEvent` 上补 `spellId` 管道再接 `ChipIcon`。死亡回顾
   是「该按没按」最高价值面,是 `#15` 唯一漏接的面。
2. **`isAvailableAt` 是第三个冷却可用性谓词**:`packages/analysis/src/utils/deathOutcomeAnalysis.ts:229`
   带 `resetSpellIds` 参数、读 raw `unit.spellCastEvents`,与 `cooldowns.ts` 的
   `cdAvailableAt` 语义相邻但数据源/口径不同(第三个,`FORBEARANCE_GATED_IDS`
   一类的重置技能是既有第二处)。若 `cdAvailableAt` 未来支持 reset 类技能,须
   同步收敛,防止三处冷却可用性判据继续漂移。
3. **`DMG_SPIKE_THRESHOLD`(`packages/analysis/src/context/timelineHelpers.ts:475`,
   300k,prompt/泳道尖峰)与 `DAMAGE_SPIKE_THRESHOLD`(`packages/analysis/src/utils/cooldowns.ts:917`,
   50k,timing 判定)同名近义不同值**——确属不同概念(承压泳道尖峰 vs 单次
   timing 判定阈值)但命名互撞,建议重命名其一(如 `TIMING_SPIKE_THRESHOLD`)
   防未来误用/误改错常量。
4. **`corpusLoader.ts` 损坏 override 静默回退无日志**:`packages/desktop/src/main/corpusLoader.ts`
   L44-58 逐路径 try/catch,`JSON.parse`/形状粗验失败一律 `continue` 到下一候选,
   全部失败才是 `null`——用户放坏文件(如手改语料 JSON 打错)时不知道为什么没
   生效,应在 `catch` 分支补一行 warn(经 `onLoaded` 同款回调模式,不引入
   electron-log 依赖)。
5. **`obsAutoConfig.ts:55`** `authRequired: raw.auth_required !== false` 把缺失的
   `auth_required` 字段当"需要密码"处理——OBS 配置文件 schema 漂移(字段改名/
   缺失)时会误报"需要密码"而非诚实地报"不确定",应改三态
   (`true`/`false`/`undefined` 各自处理)。
6. **本地 CLI 后端(claude/agy)无版本探测**:`#12` 已做零配置检测,但检测到的
   二进制若与预期协议不兼容(旧版 CLI),失败时是裸 stderr 直出,无版本号/
   友好提示。加轻量 `--version` 探测 + 版本不兼容时的可读报错。
7. **OBS 密码/API key 均明文存 `settings.json`**——评估升级到 Electron
   `safeStorage`。生态一致性:OBS 自己的 profile 也是明文存密码,非紧急,
   记账评估。
8. **shuffle 中途日志轮转丢弃已完成轮的 `shuffleCallback`**(`packages/parser/src/l2/segmenter.ts`
   既有行为,非本次引入):录像关联面(`#1`)依赖按局分段的 callback,轮转丢弃
   会在该面产生永久孤儿录像段。若真机报出具体案例再动手,当前发生率未知。
9. **`quitLifecycle`(`packages/desktop/src/main/index.ts` / `quitLifecycle.test.ts`)
   退出时只停了录像**,AI 分析流(DeepSeek fetch / CLI 子进程)未主动 abort。
   低危(宿主进程退出后连接自然断开),完整性起见挂账,不算 bug。
10. **`fetch-pvp-logs`(`packages/corpus-tools/scripts/fetchPvpLogs.ts:24`)`BRACKET`
    无校验**(拼错值 silent 空结果,不报错)**+ happy-path 无节流 sleep**(仅
    错误/退避路径有延迟)。属于对第三方 feed 的礼貌性加固,非功能 bug。

11. **#16 诚实空结果不缓存,重开同窗重付模型调用**:`packages/desktop/src/main/analysis.ts`
    的 `analyzeWindow` 对 `audit-empty`(模型诚实答 `[]`)不写盘缓存——headless 模拟
    (2026-07-31,79 窗)中约 22% 可运行窗口落此路径,同窗重点一次「AI 分析此段」会
    再打一次模型。可考虑缓存空终态(带版本戳)或 UI 侧提示。
## 22. 临时压频:驱散/徽章类候选 per-round 上限(2026-08-06 记入,TEMPORARY)

**动机**:200 场候选菜单实测(治疗视角默认 owner——`extractCandidateFindings` 缺省回退
友方治疗),`cc-locked`/`missed-purge`/`missed-cleanse`/`wasted-trinket` 四类合计占全部
候选事件的 **64.0%**(3351/5233;`cc-locked` 1629、`missed-purge` 1062、`missed-cleanse`
569、`wasted-trinket` 91),把治疗视角教练输出淹没成"全是驱散/饰品",挤掉 `death-setup`/
`external-unused`/`questionable-external` 等其余九类的曝光。用户拍板:先用硬性 per-round
上限止血,**不做信号扩容的完整修复**,登本条待第 18 条第二批落地后撤销。

**上限值**(`packages/analysis/src/analysis/candidateFindings.ts`,截断前先按各自严重度
字段降序排——`missed-cleanse`/`cc-locked` 按承伤、`missed-purge` 按(是否在击杀窗,时长)、
`wasted-trinket` 按 `teamMinHpPct`,保住最重的实例):

- `cc-locked`:3 → **2**
- `missed-purge`:3 → **2**
- `missed-cleanse`:3 → **2**
- `wasted-trinket`:无上限 → **1**(此前唯一没有 per-round 上限的类型)

**实测前后数字**(同判据,同一 200 场/899 源快照,先测后改):

|      | cc-locked | missed-purge | missed-cleanse | wasted-trinket | 四类合计  | 占比      |
| ---- | --------- | ------------ | -------------- | -------------- | --------- | --------- |
| 改前 | 1629      | 1062         | 569            | 91             | 3351/5233 | 64.0%     |
| 改后 | 1253      | 817          | 500            | 89             | 2659/4541 | **58.6%** |

**诚实说明**:改前预期"~40% 上下",实测只降到 58.6% ——低于预期,因为大多数单局/单轮本就
远低于旧上限(cc-locked 场均 1.81 条,旧上限 3 早已很少触顶),per-round 硬顶对"分布本就
集中在低计数"的类型天花板效应有限。这条止血阀是**真实但有限**的缓解,不是这四类占比过高
问题的完整解;完整解仍是本条标题所指的信号扩容(见下)。

**取消条件**:待 **#18 arenacoach 规则吸收第二批**(治疗空窗 / 走位信号 / CC 压手 /
驱散分层等新候选类型)落地、菜单有足够多其余话题分摊曝光后,移除
`candidateFindings.ts` 里标注 `TEMPORARY, BACKLOG #22` 的那一个 const 块(四个上限常量 +
注释),`MISSED_CLEANSE_CAP`/`MISSED_PURGE_CAP`/`CC_LOCKED_CAP` 复原为 3,
`WASTED_TRINKET_CAP` 整个移除(恢复无上限)。

- **回链**:见 `#18` 条目开头"第二批候选"清单——本条止血阀正是在等它落地。
## 14. eval / QA 体系遗留(2026-07-20 记入)

> **2026-07-22 收尾轮补记**:
>
> - **d243f4b 三修复的 judge 层复评已做**(同一 35 个 layerb flagged 场,HEAD 重建 prompt →
>   sonnet 重新回复 + 判分,35/35 provenance 绿):accuracy 均值 **1.89 → 4.14**、flagged
>   **35 → 2**、捏造级 **4 → 0**、DMG SPIKE 起止混淆类 **~13 → 1**、单位归属类 **~11 → 3**。
>   口径限制(回归均值 / 端到端不可拆解归因)与逐条证据见
>   `gladlog-eval-private/runs/2026-07-22-recheck/recheck-report.md`。
> - **✅ noise 重锚定副作用已修(2026-07-22 拍板走 (a) 单独定档)**:`templateDuplicateRatio`
>   在 eval-baseline.md 里单独定档(≤45% 不扣;45–60% → 3;>60% → 1,阈值取自 1245 场
>   自然分布 p50=31.2%/p90=40.7%/p99=49.1% 之外)。规则规定分全语料 3.03 → 4.92
>   (旧规则 1207/1245 场压 3 档;新规则仅 49 场真尾部落 3 档、0 场落 1)。校准不受影响
>   ——校准件无 quality-report,判官本就跳过一致性规则。
> - **✅ §7ter 已启用(2026-07-22 拍板)**:sufficiency(det-gate 维)移出其他维的特异性
>   判定。同一批 `scores-det3` 分数:accuracy 90→100、inferenceScaffolding 90→100、
>   outcomeAlignment 90→100、labelBias 80→90、noise 90 不变、focusCalibration 100 不变
>   ——**7/7 全过且最低 90%**,压线维清零。
> - 14.3 维持 monitor(本轮是 flagged 子集复评,不构成新 baseline,不作观察点)。

这四项来自 2026-07-20 的 prompt 缺陷修复轮 + 盲评 A/B 收官。14.1 已修,
14.2–14.4 未做,按处理顺序排。三项余下的**都在 `packages/eval` 内**(评测体系
自身),不进产品包,不阻塞发版。背景见
`docs/reports/2026-07-20-prompt-defects-and-blind-ab.md`。

### 14.1 `report-replay` 视觉测试 flaky ✅(2026-07-20 已修)

**症状**:CI 在 `0eeabb2` 上失败于 `场景 report-replay 与基线一致`,
1871 px(全图 0.01 比例)不一致。该 commit 只改 `packages/eval/src/quality/`
两个文件、零 renderer 代码;下一个 commit(`258dcdc`)跑同一测试为绿。

**根因不是渲染时序**(本条最初写的「有时间轴/动画,怀疑渲染未静止」是错的,
`playing` 初始为 false,rAF 循环压根没跑)。真根因是**基线里嵌了一张公网图**:
`ReplayView.tsx` 的竞技场底图 `<image href={arenaMapUrl(zoneId)}>` 指向
`images.wowarenalogs.com`,运行时现拉。真底图是「透明背景 + 不透明碰撞体」的
形状图,所以拉到了就多画几块灰色障碍、没拉到就少画 —— 同一份代码两种像素。

从失败产物取的硬证据:差异框死在 x174-279 / y196-272,**actual 侧每个差异像素
都是同一个背景色 `[26,27,40]`**,expected 侧是中性灰 `[98,99,105]`/`[120,121,128]`
—— 不是抖动,是「那一层整个没画」。

**修法**:`qa/support/stubExternal.ts` —— 已知外部资源用就地生成的固定桩 PNG
fulfill,其余一律 abort 并记进**泄漏账本**,由用例断言账本为空。新加 CDN 依赖
会指名打红,而不是留一颗随机红灯。顺带把 Inter 从 Google Fonts 换成
`@fontsource` 自托管(同一类隐患,且产品离线时全 UI 会掉回系统字体)。

**验证**(同一次构建,外网通 vs 断,整页像素比对):

|                     | 差异像素                                        |
| ------------------- | ----------------------------------------------- |
| 修前 · 页面层       | 33192(bbox x16-1261 y28-936,几乎满页)           |
| 修后 · 页面层       | 2286(只剩底图;产品仍从 CDN 取,离线降级为无底图) |
| 修后 · 基线层(打桩) | **0**                                           |

修后页面层的 bbox 与线上那次失败的 x174-279 y196-272 逐像素吻合,即本机完整
复现了故障。基线重生成后七张里只有 report-replay 变动,另外六张字节级一致。

**遗留**:产品侧底图仍走 CDN(vendoring 涉版权+体积,见 `arenaMaps.ts` 注释),
离线用户看到的是无底图降级。此为刻意保留。

### 14.2 sufficiency 判官盲区(校准检出率 20%)✅ 结案(2026-07-22,走确定性覆盖门裁决;rubric 锚点方向五测否定)

**实测**(2026-07-20 校准,40 件合成缺陷):删掉某场 prompt 里**全部**死亡相关
行后,5 件里 4 件 judge 给的 sufficiency 分数持平甚至更高(源 002 删 18 行,5→5)。
其余六维检出率 80–100%。

**含义**:judge 只看得见 prompt 里有什么,看不见构建器**没放进来**什么。
这是结构性的,不是提示词能修好的。

**方向**(二选一,未定):

- 改 rubric,给 judge 显式的覆盖清单当锚点;或
- 干脆放弃该维的盲评分,让 `qualityCheck` 的确定性覆盖门直接给分。
  现行 `eval-ab.md` 已规定该维由确定性指标裁决,盲评分无裁决权 —— 那是绕过,不是修复。

**订正(2026-07-20 全语料轮)**:原文记的「检出率 20%」把**套件缺陷**算进了判官头上。
`removed-deaths` 删的是 prompt 里的死亡行而 response 不动,回复中关于该死亡的主张
于是真的不再被 prompt 支持,accuracy 本就该掉 —— 判官在正确地做事,却被特异性规则
判违规。修掉这个前提错误后(`751f6bc`,构造性耦合豁免),该维检出率 20% → 60%。

**定稿(n=10 套件,80 件,同日晚)**:盲区是真的,而且比订正稿估的**更严重** ——
10 例里 **6 例 `5→5`**(死亡行全部删光、判官一分不扣),纯敏感性失败。检出率 40%。
n=5 两轮 + n=10 一轮三次独立测量,这一条始终复现。上面两个修法方向仍然成立。

**n=5 不可信,已实证**:同一 rubric 下,focusCalibration 从 40% 变 80%、noise 从
80% 变 50% —— 两维在样本翻倍后几乎对调。除 inferenceScaffolding(n=5 与 n=10 都是
100%)外,任何基于 n=5 的维度级结论都不成立。**校准套件一律 `--source-count ≥10`。**

**终稿(2026-07-21,全 80 件在最新 rubric 下重评,`scores-det3`)**:盲区**第五次复现,
且更深** —— 检出率 40% → 30% → **20%**,10 对里 8 对未检出且**全部零反应**
(`5→5` 五次、`4→4` 两次、`3→3` 一次)。三轮 rubric 改动(`cca541c` / `3d92ba3` /
审计集上限 `d39b34b`)对它**一点作用都没有**,这与「结构性、提示词修不好」的判断一致。

**结论:走第二个方向,别再试第一个。** 交给 `qualityCheck` 的确定性覆盖门,
`eval-ab.md` 本来就是这么规定的。这是绕过,不是修复 —— 但五次测量之后,
「改 rubric 加覆盖清单锚点」这条路没有证据支持继续投入。

**✅ 结案(2026-07-22):覆盖门已落地。** `checkCalibration` 对 removed-deaths 对子改由
确定性覆盖门裁决(`checkFriendlyDeaths` × ground-truth manifest,与生产 `qualityCheck`
同一谓词;`removeDeaths` 扰动也改为 import 同一个 `DEATH_KEYWORDS`,谓词单源)。判官
盲分照常记录,仅无裁决权。同一套件、同一批判官分数(`scores-det3`)前后:**检出
2/10 (20%) FAIL → 6/6 (100%) PASS**(4 对源场无友方死亡,门无管辖权记 unscored,不算
检出也不算漏检);**校准总账 6/7 → 7/7,exit 0**。manifests 被清理过的老 run 需用同一
日志清单重建后按 matchId 对齐拷回(2026-07-20-smoke 已做)。§7ter 的「sufficiency 移出
特异性检查」仍待人拍板 —— 但其前提(该维确由确定性门独立裁决)现已成立。

**附带发现,已于 2026-07-22 拍板采纳**:sufficiency 现在也是**最大的泄漏源** ——
其余六维一共 6 件未检出全是特异性漂移 2,其中 **4 件的漂移维就是 sufficiency**。
把它移出特异性检查,六维会升到 90–100%。当时判断这只在 sufficiency 确实由确定性门
独立裁决时才成立而非「调门规直到变绿」——该前提已于同日成立,遂将 sufficiency
移出特异性检查已落地:`packages/eval/src/judge/checkCalibration.ts`(~332-337 行,
`DET_GATE_DIMENSIONS` 跳过特异性判定,注释标注「2026-07-22 拍板启用」)。详见
`docs/reports/2026-07-21-judge-variance-v3.md` §7ter。

### 14.5 accuracy 判官间方差 ±2 —— factAudit 的 3 条主张应当固定而非判官自选 ✅ 结案(2026-07-21,查表锚点:锚点噪声 0/30;残余 errCount 分歧属判断力噪声)

**实测**(2026-07-20,n=10 套件):`noise` 与 `labelBias` 的失败**全是特异性**,
敏感性都很好(5→3、5→1),渗漏维一律是 `accuracy` 且 drift=2。

**根因不是套件**。逐案查了 case-06/13/49 被判 refuted 的主张 —— 分别是「Hammer of
Justice 认错人」「Life Cocoon 冷却状态误判」「41% 血量差一秒」,这些错误**在回复
原文里本来就存在**。而 `duplicated-noise` 只改 prompt、不碰 response,对照组与扰动组
判官看的是同一份回复,一个给 accuracy=5、一个给 3。

真机制:rubric(`eval-baseline.md` PASS 1)让判官**自选**"最承重的 3 条主张"做事实
审计。不同判官抽到不同的 3 条 —— 抽中含错的就扣分,没抽中就满分。于是 accuracy 的
判官间方差达 ±2,而特异性容差是 ±1,结构性打不过。

**已试并测量(`cca541c`,同日):把审计集改为规则确定** —— 取回复里全部含 `M:SS`
时间戳的断言句(上限 12,不足 3 补齐),且 accuracy **只按该集合打分**。重评那 30 件
(10 源 × {none, severity-labels, duplicated-noise},即回复与可查证内容完全相同的三类):

| 判据               | 修前(自选 3 条) | 修后(规则集) |
| ------------------ | --------------- | ------------ |
| accuracy 极差 均值 | 1.00            | 0.80         |
| 最大极差           | 2               | 2            |
| 极差 ≥2 的源数     | 4               | 3            |
| 完全一致的源数     | 4               | 5            |

**效果未证实。** 幅度 −20%,n=10 下与噪声不可分;且是位移不是收缩(源 3 从 2 降到 0,
源 1 反而从 0 升到 2)。改动本身是有原则的(消掉一个任意自由度、审计变得可复核),
故保留,但**不得当作已解决**。

---

**结案(2026-07-21)** —— 详见 `docs/reports/2026-07-21-judge-variance-v3.md`。

后续两轮改动把这一条做完了,但**赢的地方跟标题写的不是同一件事**:

| 判据(尺度无关)                      | 自选 3 条 | 规则集 `cca541c` | 查表锚点 `3d92ba3` |
| ----------------------------------- | --------- | ---------------- | ------------------ |
| **errCount 极差均值**(判官实质分歧) | 0.50      | **0.30**         | 0.50               |
| 锚点应用噪声(accuracy ≠ 5−errCount) | 9/30      | 8/30             | **0/30**           |
| 查证检出总数(30 件)                 | 6         | 11               | **21**             |

- **真正修好的是「同一个发现给不同分」**:v2 里 errCount=1 的 11 件,accuracy 给了
  8 次 3 分、3 次 4 分;v3 的 16 件**全是 4 分**,30/30 零例外。这一项是纯噪声、零信号,
  消掉是净收益。
- **判官间实质分歧没降**:errCount 极差回到 0.50,与最初持平。剩余方差**全是查证漏检** ——
  三个判官读完全相同的 response,找到的错误集合可以是 {A} / {A,B,C} / {C}(源 001 实例)。
- **⚠ 登记判据(accuracy 极差 1.00 → 0.80 → 0.50)看着连降两轮,但换不来 A/B 判别力**:
  查表把「1 个错」的扣分由 2 分改成 1 分,噪声与信号同比例缩小。教训已单独记录 ——
  比较评分类指标前,必须换算到不随锚点变化的底层计数。

**锚点这条路已见底**(0/30 违规,无剩余空间)。若还要压方差,方向是**查证漏检**:
可考虑要求判官对每条主张写出它在 prompt 里的**行号**,把「查过了」变成可核对的痕迹。

**校准总账:4/7 → 5/7 → 6/7**(见 14.2 终稿),门槛 5/7 已过,Layer B 不再被挡。

~~**剩余方差在别处**:修后判官审计的是同一批主张,仍能差 2 分 —— 说明分歧在「同一条
主张判 verified 还是 refuted」以及「n 个错映射到哪个锚点分」,即**锚点校准**,不是抽样。
下一步该往这个方向查,而不是继续动审计集。~~
**(2026-07-21 推翻:这条猜对了一半。)** 当时把两个机制混在一起写了。实测拆开是 ——
「n 个错映射到哪个锚点分」确实是问题,而且**已被查表锚点彻底解决**(违规 9/30 → 0/30);
但「同一条主张判 verified 还是 refuted」**不是锚点问题,是查证漏检**,查表对它零作用
(errCount 极差 0.30 → 0.50)。剩余方差全在后者,见上方结案表。

**连带修的自伤**:改 PASS 1 时没同步 `factAudit` 长度约定,格式段与
`checkScoreProvenance.ts` 都还锁着「恰 3 条」,导致重评的 30 件里条数从 3 到 12 都有
(子代理各自解释不同)。已把 validator 放宽为 [3,12] 并要求记录完整规则集(截断等于
丢掉可复核性,而可复核性正是这次改动的目的)。教训:改判官流程时,凡有脚本在
校验该流程产物的,必须同一提交里一起改。

**同一个自伤 2026-07-21 又来了一次**(上限 12 → 20 时,`provenance.test.ts` 两个用例
写死 12,88 个测试里红了 1 个)。这次连带修了,并把常量导出成 `FACT_AUDIT_MIN/MAX`、
用例改为从常量推导,另加 `factAuditBounds.test.ts` **解析 rubric 文档、断言文档里的
数字等于校验器常量**(把常量改回 12 验过,3/3 失败,不是空过)。**同类漂移到此为止。**

**曾走过的弯路**(勿重蹈):一度假设 `duplicated-noise` 构造性耦合 accuracy(复制
改变计数、rubric 要求重新计数),打算加进 `COUPLED_BY_CONSTRUCTION`。逐案验证后
**证伪**。连续放宽豁免表直到门变绿,正是该表注释里警告过的失败模式。

### 14.3 两个 accuracy 代理指标轻微指向 treatment 更差(monitor)

2026-07-20 A/B(50 对)两个独立指标同向:

| 指标                 | Δ      | 95% CI            | n=50 的 MDE |
| -------------------- | ------ | ----------------- | ----------- |
| accuracy(1–5)        | −0.30  | [−0.66, +0.06]    | 0.36        |
| factAudit refuted 率 | +5.3pp | [−2.4pp, +13.1pp] | —           |

**都不显著**,且都在该样本量的可测门槛以下。

**已排除的解释**:不是「prompt 变长 5% / 新增 86 条 DR 标注给了更多可引用的料」——
实测两臂被驳回主张里,claim 原文提及新标注面的**都是 0 条**。

**无进一步动作**;下一轮 baseline 顺带观察。若同向再现且 n 更大,再查。

### 14.4 `blindPool` 盲件缺 matchId 占位约定 ✅(2026-07-22 结案)

本轮盲件不含 `MATCHID:` 头(按设计剥离),但 judge 指令要求 score JSON 写 `matchId`,
于是子代理各自编了 `null` / `"unknown"` / `"NO_MATCHID_HEADER_FOUND"` 三种写法。
不影响本轮统计(`abStats` 按 blindId 关联),但会给后续按 matchId 聚合的分析添堵。

**修法**:占位约定固化为 `matchId = 盲件 id(item-NN)`——盲件目录名本身就是稳定且不
泄漏臂别的 id,真实 matchId 聚合一律经 `blind/mapping.json` 换算。两处落地:
`eval-ab.md` 判官模板明确写「set matchId to exactly ITEMID,不许编、不许找」;
`abCompareStats` 解盲时核对该字段——不合规记警告,**等于真实 matchId 按破盲嫌疑
单独告警**(盲件里没有这个信息,判官只可能越权读文件得到)。
