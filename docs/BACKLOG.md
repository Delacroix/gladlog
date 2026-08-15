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
2. ✅ **COOLDOWN-001 CC 压手 >90s**:cd-waste 的进攻版,判据现成(`availableWindows` ×
   `ccSpellIds`)。2026-08-06 信号扩容第一批并入(候选类型 `cc-held`,门槛按语料实证从
   「60/90s 二选一」定为 90s——60s 门槛下 23% 的全部 CC 可用窗口本就超线,混入太多
   正常施放节奏空当)。设计见
   `docs/superpowers/specs/2026-08-07-signal-expansion-batch1-design.md`。
3. ✅ **DEFENSIVE-001 治疗吃满 CC(有规避手段)**:2026-08-07 并入(候选类型
   `cc-avoidable`,表 100% 复用既有 `ccTrinketAnalysis.ts` 的
   `CC_AVOIDANCE_BUFF_SPELLS`/`REPOSITIONING_SPELL_IDS`,零新表),排除与
   `trinketState=available_unused` 重叠(64.3%,已由 `cc-locked`/`wasted-trinket`
   覆盖)后语料复扫 96 条(cap 前)/78 条(cap 2/轮后)/命中轮 9.3%(59/635)。
   设计见 `docs/superpowers/specs/2026-08-07-defensive-001-design.md`。
   ❌ **DEFENSIVE-002 低血不循环小减伤:2026-08-07 数据否决**(同一份设计文档)——
   最宽阈值(HP<50%)命中率仅 1.1%(3/264 可判定轮),低于第一批 `healing-gap`
   5.3% 先例线;Discipline Priest(194/194 轮)与 Holy Priest(60/60 轮)在
   `MITIGATION_TABLE` 小减伤子集下结构性 100% 零适用;Discipline 名义上唯一
   适用的 Power Word: Barrier 全局 808 场仅 8 场有人成功施放,形同虚设。不新增
   类型,不做字段升维,不再等用户拍板门槛。
   ✅ **DEFENSIVE-003 敌方开大应对迟缓**:2026-08-11 并入(候选类型
   `slow-defensive-response`,治疗 owner 专属)。承压门实证选型:绝对伤害门
   300k 在窗口尺度无区分度(95.7% 的爆发窗全过,窗口跨度 p50=21.6s),改用窗口
   自带的 `damageRatio >= 1.5`(率口径,20.2% 窗口过门);反应集合 =
   `MAJOR_DEFENSIVE_IDS` ∪ 饰品 ∪ `REPOSITIONING_SPELL_IDS` ∪ 对敌硬控
   (destUnitId 归因),零新表;阈值 8s 按语料分布定档(承压+有工具+未被控轮的
   反应延迟 p50=6.9s/p75=12.1s,3s/5s 档会把中位数行为定为失误——cc-held 弃
   60s 档同一逻辑);豁免门 = pre-wall(共享 `PRE_WALL_SECONDS`)+ 窗口起点
   无工具可用(`cdAvailableAt`)+ owner 被控(归 cc-locked)+ 渲染跨度不足
   8s 的窗口不欠反应;±10s 去重门(200 场实证重叠 70.8%,高于 DEFENSIVE-001
   装门的 64.3% 先例线)。判定全部在渲染网格上做(agy flash 复核 5 条同族
   发现全采纳:delay/pre-wall/窗口跨度/去重边界原始小数秒 vs 渲染秒漂移)。
   全库复扫(810 场/2621 轮,真实现口径):**76 条(40 无反应/36 迟缓,迟缓
   delayS p50=15s/p90=19s),命中轮 2.9%(76/2621),菜单占比 0.48%**。
   200 场实证脚本 `packages/desktop/scripts/tmp-slowdef-rates.mts`——评估后已删除。
4. ✅ **DISPEL late/failed 分层**:2026-08-06 并入,但形态与原设想不同——实证发现晚驱
   (≥3s)只占已驱散总量 7.1%(69/972),体量撑不起独立候选类型,改做 `missed-cleanse`
   的字段升维(`latencySeconds`,仅晚驱条目携带),不新增类型、不改 cap。同批同一份设计文档。
5. **OFFENSIVE-001 锥形打空**:需锥形技能表 + 几何判定,仍是开放项。
   ✅ **OFFENSIVE-002 打进大减伤且该切目标**:2026-08-11 并入(候选类型
   `burst-into-mitigation`,复用 `MITIGATION_TABLE`(#17)+ `analyzeBurstLedger`
   的 dominantTarget.defensivesHit(非免疫)+ `analyzeKillWindowTargetSelection`
   的 betterTargetExists——后者的 `windows` 形参窄化为 `Pick<...>`,喂给它一个
   由爆发窗口自身时间跨度/目标现拼的合成窗口,复用同一软度比较谓词而非另起一套。
   `positional: true` 条目(黑暗 196718)按 #17 spec 决策记录第 4 条契约排除
   (未实现坐标判定,判不了就不计入,与 `counterfactual.ts` 现有取舍一致)。生产
   单 owner 口径(`resolveOwner`)下本机语料 898/899 为治疗录制,DPS-owner 轮
   0/0——语料结构使然,非信号本身;改走 `deriveMistakes.ts` 实际使用的「每个
   非治疗友方各自为 owner」口径复扫(1794 DPS-owner 轮):225/1794 轮
   (**12.5%**)命中 ≥1 条,263 条合格窗口,减伤技能不由单一技能主导(11 种,
   最高 Pain Suppression 占原始命中 34.4%)。200 场/899 源零模型确定性扫描,
   临时脚本 `packages/desktop/scripts/tmp-off002-rates.mts`——评估后已删除。

**2026-08-06 追加(未在上面 5 项原始清单里,系当日语料实证报告一并挖出)**:

- ✅ **HEAL-001 治疗空窗**:复用既有 `detectHealingGaps`,加 `freeCastSeconds>=4` 且
  `mostDamagedAmount>0` 两道门。候选类型 `healing-gap`。
- ✅ **POSITION-001 走位失误**:复用既有 `computeOwnerPositionEvents` +
  `stayedInHadRealCost`(与 deepDive.ts 同一谓词,三态纪律照旧)。候选类型
  `position-mistake`。MISSED_PUSH/CD_OUT_OF_RANGE 在本机语料(治疗视角为主)发生率为
  0,保留判定不砍(面向未来 DPS 视角语料)。

> **2026-08-06 `#22` 挂钩收官,但未达撤销线**:上面第 2/4 条(CC 压手、DISPEL 分层)
> 加上追加的 HEAL-001/POSITION-001 共三个新候选类型已落地,`#22` 记录的
> `cc-locked`/`missed-purge`/`missed-cleanse`/`wasted-trinket` 四类占比从 58.6% 降到
> **50.0%**(200 场/899 源复扫,同判据,`extractCandidateFindings` 直接调用;
> `healing-gap` 53 条、`position-mistake` 115 条、`cc-held` 250 条,与设计预期
> 54/118/259 高度吻合;`missed-cleanse` 因 DISPEL-002 时延字段升维从 500 增到 570
> 条,增量 70 与实证「69 条晚驱」基本对上)。三新类型合计占菜单 **7.7%**(418/5453)
> ——不到当初设想的 15-25%,原因是三个信号本身语料发生率就不高(HEAL-001 受
> detectHealingGaps 自身三层门 + 4s 二次过滤;POSITION-001 的 MISSED_PUSH/
> CD_OUT_OF_RANGE 在治疗视角语料上是死信号)。**`#22` 的止血阀不随本批撤销**——
> 第一批扩容占比不足以撤闸,待第二波(DEATH-002/OFFENSIVE 类)落地后再评估。

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

1. ~~**DeathRecapCard 未接内联图标**~~ ✅ 已修(2026-07-31,`6d36798`,本条记账文本当时未同步划掉,2026-08-11 复核补记):`DeathRecapEvent` 已补 `spellId?: string` 管道(事件五处构造点 + `availableImmunities`/`missedExternals`),`DeathRecapCard.tsx` 五处展示技能名的位置(事件表格行/免疫可用 pill/队友漏给 pill/减伤核算行/反事实行)均已接 `ChipIcon`。测试见 `packages/desktop/test/report.deathrecap.test.tsx`(spellId 透传断言 + 已知/未知 id 图标渲染断言)。
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

**取消条件(2026-08-06 更新)**:第一批扩容(治疗空窗 HEAL-001 / 走位信号 POSITION-001 /
CC 压手 COOLDOWN-001 三新候选类型 + 驱散 DISPEL-002 时延字段升维)已落地,占比从 58.6%
降到 **50.0%**(200 场/899 源复扫,同判据),但三新类型合计仅占菜单 **7.7%**(418/5453)——
**不足以撤闸**。本条 caps 保留不动,待第二波(`#18` 的 DEATH-002 / DEFENSIVE-001/002 /
OFFENSIVE-001/002 类)落地后再评估是否移除
`candidateFindings.ts` 里标注 `TEMPORARY, BACKLOG #22` 的那一个 const 块(四个上限常量 +
注释),`MISSED_CLEANSE_CAP`/`MISSED_PURGE_CAP`/`CC_LOCKED_CAP` 复原为 3,
`WASTED_TRINKET_CAP` 整个移除(恢复无上限)。

- **回链**:见 `#18` 条目"2026-08-06 追加"与 COOLDOWN-001/DISPEL late/failed 两行——
  本条止血阀等的就是它们,现已落地但未达撤销线。

**撤闸预演(2026-08-11,DEFENSIVE-001 + OFFENSIVE-002 落地后,临时改常量实测后已还原)**:
最近 200 场/898 轮,同判据双跑菜单层 + agy 真实挑选 smoke(n=12,同
`smokeFindingsBackends.ts` 口径):

|                      | 现状(caps 2/2/2/1) | 撤闸(3/3/3/无)    |
| -------------------- | ------------------ | ----------------- |
| 菜单四族占比         | 53.7%(2729/5083)   | 59.3%(3436/5790)  |
| 四族过半的轮         | 47.3%(425/898)     | 57.9%(520/898)    |
| 平均菜单条数         | 5.7                | 6.4               |
| agy 挑选存活四族占比 | 42.5%(此前 n=12)   | 46.8%(22/47,n=11) |

涨幅几乎全来自 `cc-locked`(1253→1629)与 `missed-purge`(817→1062)。挑选层双保险
(prompt 限选句 + `auditFindings` 确定性兜底)把报告仍压在 ~1.9 条四族/场(≤2 硬约束
未破),新类型进菜单照旧被挑(healing-gap 1/1、position-mistake 2/2、cc-held 3/4)。
**结论:不撤**——撤闸零收益(报告端只歪不正,菜单端四族回涨 +5.6pt),新类型合计菜单
占比仍仅 ~8.5%,撤销线维持原判:等第二波扩容(DEATH-002 / OFFENSIVE-001)落地后再评。
n=12 的挑选层差异(+4.3pt)在判官噪声底附近,不作为独立证据,方向与菜单层一致仅作旁证。

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

---

## 23. GitHub issues 第一批(2026-08-11 记入,用户在 GH 上开的 4 个 issue)

按嫌疑根因归类;做完当前在跑的 #3(敌方大招响应延迟候选)后开工。

1. **[#8](https://github.com/mingjianliu/gladlog/issues/8) 未用技能包括没有的技能
   → 天赋感知(2026-08-11 用户更正根因)**:真言术障(Power Word: Barrier)**确实
   存在**,但它是天赋 2 选 1 节点且绝大多数人不选——问题不是表腐烂,是**分析层
   不知道玩家选了什么天赋**,把「职业理论上有」当成「这个玩家有」,对没点的技能
   说「未用 CD」。旁证同向:DEFENSIVE-002 否决时测得 PW:Barrier 全库 808 场仅
   8 场施放,与「冷门天赋选项」完全吻合。
   **数据现状**:parser 已解析 `COMBATANT_INFO` 的 `talents: number[][]`(天赋树
   节点条目)与 `pvpTalents`(`packages/parser/src/l1/combatantInfo.ts`),挂在
   `u.info` 上,分析层零消费。缺两块:
   (a) **天赋条目 → 授予技能** 映射表(DB2 trait 系表,走
   [[official-data-over-heuristics]],官方表也要实测覆盖率);
   (b) **能力门消费**:凡是「你有 X 没用」类判定(unused-CD / loadout [UNUSED] /
   死亡回顾 availableImmunities / missedExternals 等)先过「该玩家天赋里真有 X」。
   门要装在**候选层**且配富上下文守护注(missed-cleanse 类能力门 8fba412 与
   [[gladlog-context-bypasses-candidate-gate]] 两个先例:只挡菜单会被 loadout
   裸事实绕过)。谓词单源(canDefensiveCleanse 模式)进 predicate-index。
   动工前先量:全库有天赋数据的场次覆盖率 + 受影响白名单条目清单(哪些 kit 技能
   实为天赋择一)。**检查点:瘦身迁移是否保留了 info.talents**(doc 瘦身动过
   params,若 talents 被裁需要先补回存储层)。
   **✅ 完成(2026-08-11,含「精准:既不漏也不错」验收批)**。盘点结论:kit 主
   路径 `extractMajorCooldowns` 及其全部下游(loadout/[UNUSED]、cd-waste、
   cc-held、slow-defensive-response、death-unused-defensive、external-unused、
   computeUnusedSelfCounterfactuals、matchNarrative/criticalMoments/
   momentSnapshot)**早已天赋感知**(择一过滤 + pvpTalents + 替换表 + 动态发现;
   300 场实测 29900 条 kit 记录 0 幽灵);真正的缺口是 `deathOutcomeAnalysis` 的
   IMMUNITY_SPELLS / EXTERNAL_DEFENSIVE_SPELLS 两张 spec 表(只按 spec 门,喂
   prompt 的 DEATHS WITH MISSED OPTIONS、deepDive 免疫/外减事实、desktop
   DeathRecapCard 三处)。修法:三态单源谓词 `talentOwnershipOf`
   (analysis/src/utils/talentOwnership.ts,已进 predicate-index),拥有集覆盖
   四来源:职业/专精/英雄树(择一只算选中支)+ **官方 PvP 天赋池**
   (新 datagen `genPvpTalentPool.ts` → pvpTalentPoolGenerated,DB2 PvpTalent,
   含 ActionBar 载体 215982→215769;COMBATANT_INFO pvpTalents=SpellID 语义经
   全库实证 110/111)+ 替换关系 + 排除法基线;两道防误杀降级:free/entry 自动
   授予节点缺席→unknown(链闪 214/214 施法者 loadout 均无该节点)、loadout 含
   当前树不可解析节点(老 build 轮/宠物树行)时树判 no→unknown。两张表的列出
   循环各加「确证 no 才过滤、unknown 放行」门 + `<player_loadout>` 头部守护注。
   **前后数字**:(a) 幽灵扫描(同判据,最近 200+抽样 100 场=1172 轮):
   missedExternals 幽灵 517/918(56.3%,PWB 330/Zephyr 109/BoP 75)→ **0/404**;
   availableImmunities 149→149 零误杀;kit 0 幽灵不变。(b) **全库矛盾复核**
   (810 场 2622 轮 345,942 施法对,判据=表判「no」但该轮实际施放,常驻脚本
   `packages/desktop/scripts/auditTalentOwnership.ts`):**235 → 7**(0.002%),
   残余 7 条逐一查明=开门前/轮界施法时序边缘(毒药/武器附魔/圣礼/被 PvP 天赋
   替换的 BoP,pvp 天赋场外休眠)与老 build node-id 漂移不可见残余,生产谓词
   均有施法证据兜底免疫。(c) 白名单判定 17747 单位次:unknown 47(0.26%,全为
   老 build 轮),数据在手时 0;PWB= yes 12/no 1542/unknown 0(99.2% Disc 轮
   没点,issue #8 实锤)。白名单 36 个 (spellId,spec) 对逐条官方来源分类钉进
   `talentWhitelistClassification.test.ts`(数据刷新漂移即打红)。覆盖率
   15650/15650 单位天赋可解析(瘦身完好保留 info.talents)。Solo Shuffle 轮级
   粒度实证:171/186 场 shuffle 有玩家轮间改天赋、361/1099 多轮玩家(32.8%)——
   谓词按轮取 unit.info、绝不跨轮缓存。
   **顺带发现(未处置,挂账)**:Netherwalk(196555)12.1 树/池皆无 + 全库
   808+ 场 0 施法 + 414 Havoc 单位——疑似已从游戏移除,IMMUNITY_SPELLS 该条
   属白名单腐烂([[gladlog-aura-id-rot]] 族),会继续产「had Netherwalk
   available」可疑 claim,待赛季数据确认后摘除。
   数值修正(talentModifiers 冷却缩减类)不在本条范围。
2. **[#9](https://github.com/mingjianliu/gladlog/issues/9) 心控导致小地图模式敌我
   人数错误**:精神控制(Mind Control)期间单位 reaction 翻转,回放小地图的敌我
   计数被带歪。嫌疑在 parser/回放层的 reaction 快照口径(取 COMBATANT_INFO 静态
   派系还是逐事件动态 reaction)。先复现:找一场有心控的对局定位计数来源。
   **✅ 完成(2026-08-11,两修复各自独立 commit)**。根因两层:
   (a) **回放链路是全应用最后一个拿 reaction flags 判敌我的门面**(谓词分裂,
   其余门面全走 `sideOfUnit`)——`ReplayTrack.reaction` → `side`,由 `sideOfUnit`
   (锚定 COMBATANT_INFO teamId)推导,unknown 才回退 reaction;地图两侧血条框/
   圆点描边/泳道分组/两队 chip 四门面一处改动全修。实测存档 fb672a41 round 5:
   Hiyâkun(reaction=Hostile、teamId=我方)修前敌列→修后我列,人数 2v4→3v3。
   (b) **perf commit 1c9c05d 给 flagsSeen 去重时无声把 reaction 投票从
   「按事件出现次数」改成「按 distinct 值个数」**(平票偏 Friendly),被心控
   碰过一下的单位 1-1 平票整场翻转——已恢复出现次数投票(flagCounts 计数 Map,
   保留去重的性能收益)。前后数字(全库 280 场含 605 语料,1325 段/7941 玩家
   单位,判据=voted reaction 与 COMBATANT_INFO teamId 严格矛盾):distinct 值
   投票 **1459 处/230 场** → 出现次数投票 **1 处/1 场**(残余 1 处=fb672a41
   round 5 的持续性机制翻转,由 (a) 兜住;调研预估 59 处/8 场,实测爆炸半径
   大 25 倍)。顺带发现:oracle parity gate 在 1c9c05d 后就没跑过,已有
   pre-existing 红(ENEMY HARD CAST old=0 new=8,旧 fork 结构性无
   castStartEvents);(c) 使其 8→13,新增 5 处逐条核实均为改判正确
   (caster teamId 确为敌方),baseline 未动,待单独裁定。
3. **[#10](https://github.com/mingjianliu/gladlog/issues/10) agy 过多的驱散结论**
   (无正文):即话题霸屏主诉,已有整条治理线在跑——#22 压频(保持不撤,见撤闸
   预演记档)+ 挑选层多样性(LEGACY_TOPIC_TYPES 双保险,agy 61.3%→42.5%)+ #18
   信号扩容。本 issue 挂在这条线上跟踪,扩容第二波后如仍不满意再加码。
4. **[#11](https://github.com/mingjianliu/gladlog/issues/11) 死亡回顾 UX**:过滤
   小伤害,只保留 GCD 相关/较大的伤害和驱散。纯 renderer/derive 层
   (deathRecap derive + DeathRecapCard),注意阈值别做成第二套谓词——若分析层
   已有「显著伤害」判据(如 timing 的 DAMAGE_SPIKE_THRESHOLD 一带)先查
   predicate-index 评估复用还是独立 UI 展示阈值,取舍写进实现注释。
   **✅ 完成(2026-08-11)**:分型处理落地——直击(SPELL_DAMAGE)/直疗按
   `DEATH_RECAP_MIN_EVENT_PCT`(2% maxHp,derive 层独立 UI 展示阈值,maxHp 与
   hpRangeAt 同源 advancedActions;DAMAGE_SPIKE_THRESHOLD 是窗口累计伤害判据,
   不是单事件事实,评估后不复用)保留/折叠;DoT/平砍等非 SPELL_DAMAGE 按
   (法术×来源)小计;HoT tick 进折叠桶(实测折叠中位 24 行 vs 小计 26 行,取少
   者);驱散行消费 reconstructDispelSummary 双向无条件保留;折叠行可展开 +
   「显示全部」toggle。前后数字(50 场/176 次死亡同一语料):每次回顾行数中位
   114→24、p90 245→36、max 607→46;金额守恒 0/176 违规;新增驱散行 158 条
   (原先 0——驱散此前不在事件流)。顺带:死前 10s 双写统一为
   COUNTERFACTUAL_WINDOW_S 单源(criticalMoments 10_000 与 desktop
   DEATH_RECAP_WINDOW_S 均改别名消费,predicate-index 双语已记)。

---

## 24. 12.1/S2 数据收尾批(2026-08-11 记入)

12.1 数据刷新(526a3fb,build 12.1.0.69273)与 DR 时代分界(5856ee0,
`drResetMsAt` 16s/20s,切点 2026-08-11T22:00Z)已入 main;以下为剩余数据项,
**全部依赖 S2(2026-08-18 开赛)语料落地**,攒够量再动:

1. ~~DR 20s 切点实证复核~~ **已实证 2026-08-12(开服首日)**:wowarenalogs
   下 30 场 12.1 US 对局(全部晚于切点),`drWindowVerify.mts` 判决——晕类
   16.5–19.5s 间隔桶时长 med 1.5s(n=5)≈ 8–15.5s 桶(两代规则都 50%,
   n=25)的 1.5s,远离 25–60s 新鲜桶(n=155)的 3.0s → **20s 规则生效**,
   切点无需动。全类目同向(n=14/43/317)。顺带:parser 30 场 0 错、
   1673 个观测 id 名表 0 缺失。A 桶 n 小,语料攒多后可复跑同脚本加固。
2. **spellEffectOverrides 分歧复核**——2026-08-11 当日大半已结,剩一条真依赖
   12.1 语料:
   - ~~Shadow Dance 185313~~ **已裁决删除**:12.0 全库实测双向证伪覆盖
     (60/8)——施法间隔 n=1996 min 6.1s/中位 18.5s ≈ generated 的 20s 充能;
     buff 185422 时长 n=2261 中位 6.5s ≈ generated 的 6s。覆盖两个值在
     12.0 就都错,generated 直接对。测量教训:buff 光环是 185422 不是施法
     id 185313(aura-id-rot 族,量时长得用光环 id)。
   - ~~Malevolence/Soul Rot/Coordinated Assault~~ **已删冗余**(DB2 与覆盖
     字节一致;Soul Rot 反而解锁被覆盖遮蔽的 dispelType:Magic)。
   - **Fel Barrage 258925(唯一残留)**:覆盖 dur=3 vs DB2 8,但 808 场
     12.0 语料 **0 次施法**(92 场字符串命中全是 loadout 天赋 id),双向
     不可证伪。12.1 语料出现首例施法后按实测定;若始终无样本,采官方 8s。
3. **rotScan 白名单腐烂检查**(update-wow-data 步骤 7 口径):按专精
   none-tracked 率 + `[DR: spell:<id>` 回退扫描;~20 个重做专精是重灾区,
   预期缺口(惩戒 Radiant Glory/增强 Doom Winds)勿误报。#23 挂账的
   Netherwalk 摘除也在此批确认。
   > 2026-08-12 首日初筛(`noneTrackedScan.mts`,30 场):22 专精 179 个
   > cooldowns 块 none-tracked **全 0%**、DR 回退 0——无 2026-07 式整专精
   > 塌方。但 18 个专精首日未现身(敏锐/狂徒贼、鸟德/守护德、奥法/火法、
   > 神牧/暗牧、毁灭/恶魔术、酒仙/织雾、防战/防骑、血 DK、增辉等),
   > 且在场专精部分 n≤3——结论性检查仍待一周语料。
4. **benchmarks.json 重建**:现基准 2026-07-20 出自 12.0 语料(2100+),
   治疗/伤害数值大调后失真;S2 语料够量后重跑,注意
   [[metric-scale-vs-agreement]]——先比尺度无关计数再下结论。
5. **dispelObservedGenerated 回填**:`confidenceAudit --emit-table`,
   观察型表「没发生过≠发不出来」,新语料逐条喂回。
6. **eval 基线/候选发生率全线重校**:63.6/14.1/15.6 等旧数字 12.1 后视为
   过期;`/eval-baseline` 重跑,压频类(#22 临时闸)阈值随发生率重看。
7. ~~observedSpellIds +7 新 id 进 icons/offGcd 宇宙~~ **已做 2026-08-11**
   (管线修复 ac3a6a2f 当日顺手落账:观测 3346→3353、icons 41729→41734、
   offGcd 295→296,validateCatalogs 绿)——本不依赖 S2 语料,误归此批。

8. **Ring of Fire 新 id 追踪**(2026-08-13 补丁说明审读发现):官方 12.1
   notes 明写「Ring of Fire duration increased to 4 seconds (was 3)」——技能
   还活着;而 363405 在 SpellName@69273 已删(526a3fb 按孤儿行除册)。两者
   同时为真只有一种解释:法师重做换了新 id(aura-id-rot 族)。S2 语料里按
   "Ring of Fire" 名字反查新 id,登记 DR 分类 + 观测宇宙;除册裁决本身不动
   (历史日志仍需旧 id)。
9. **Ancient of Lore(473909)的 20% 减伤未入减伤表**:cc_immunity 侧已随
   2026-08-13 补丁审读批登记进 talentBehaviors(语料实证 7d74b373),但其
   变身期间 20% 减伤还没有 DB2 aura87 证据链——S2 语料 + DB2 复核后再进
   mitigationData,勿凭补丁说明文字直接填数。

新赛季日志采集/归档(launchd 装载等)见 #19,用户自理,不在本条。

## 24. `dr` 反向查询恒空 —— `analyzeOutgoingCCChains` 目标方硬编码 Hostile

`packages/eval/src/explore/matchExplore.ts` 的 `dr` 查询按计划正反各调一次
`analyzeOutgoingCCChains`,但该谓词内部把目标方过滤成
`e.reaction === CombatUnitReaction.Hostile`(drAnalysis.ts ~:454),反向调用
`(enemies, friends)` 时友方目标全被滤掉——敌方施放的 CC 恒为 0 行。深挖上限实验
第一盘(2026-08-12,match 60ab1e8f)真实使用当场暴露:敌方锤逼出 owner 5 次勋章,
`dr` 却 0 条敌方 CC。产品侧不受影响(敌方 CC 走 `analyzePlayerCCAndTrinket`
owner 侧谓词)。

修法方向:把谓词的目标过滤从硬编码 Hostile 改成「属于传入的第二参数集合」
(语义上更对,产品现有调用 `(friends, enemies)` 行为不变),配平价测试 + 产品
callsite 回归;或 `dr` 查询敌方向改走 `analyzePlayerCCAndTrinket` 逐 owner 聚合。
动手前查 predicate-index(涉及 DR 链单源)。

> **2026-08-14 技能事实地基项目收尾注记**:本项目(`usableWhileCcGenerated.ts`/
> `usableWhileStunned`/签字册)不覆盖本条——`analyzeOutgoingCCChains` 的目标方过滤
> 与「被控能按什么」是两个不同的事实面(前者是 CC 施放归因方向,后者是被 CC 后自身
> 技能可用性),互不相关,仍是独立开放项。

## 25. 产品建议机制性误用两例(深挖实验第一盘盲评揪出,match 60ab1e8f)

评审人(奶骑本人)在 2026-08-12 盲评中判两类 baseline 建议「根基错误」:

1. **BoS 自施回归疑似**:「倒地时牺牲祝福仍在待用」暗示垂死者可用牺牲自救——牺牲
   不能对自己施放。此类 2026-08-01 已修过(12→0,见 backlog #10 收官注记),
   promptVersion 24 复现,需 prod-triage 确认是同路径回归还是新生成路径。
2. **无敌挡晕类反制建议**(2026-08-14 更正):圣盾术机制上**任何被控状态都能按**
   (用户澄清+旗标佐证,原「按不出」判断有误)——问题不在机制层而在**代价规范层**:
   5 分钟大技能不该被推荐为常规挡控手段(寒冰屏障同款)。修法=候选层挂 cost-norm
   守护注(签字册条目),而非机制门;「被控可用」机制事实由技能事实地基项目官方化。

复现材料:`gladlog-eval-private/review-sessions/2026-08-12-60ab1e8f.*`(session 含
逐卡标注,answers 含评审人备注原文)。

> **2026-08-14 技能事实地基项目收尾注记**:
>
> 1. **BoS 自施回归疑似**:本项目未覆盖,不相关(牵涉 candidate 生成路径回归,不是
>    技能事实断言问题)——仍需按原文 prod-triage 单独定位。
> 2. **无敌挡晕类反制建议**:机制层已官方化——`usableWhileStunned` 确认圣盾术
>    (642)/寒冰屏障(45438)**晕中**可施放,官方 DB2 `SpellMisc.Attributes` 位标志
>    (`usableWhileCcGenerated.ts`)只证明这一点;"机制上任意被控状态都能按"这个更宽
>    的表述出自用户签字锚点(Task 2,2026-08-14)而非该官方位本身——官方位与用户裁决
>    结论一致,但证据来源要分清,不能笼统归给"官方 DB2 位标志"(finding #5,2026-08-14
>    终审修正)。不存在"按不出"这回事,原判断有误的结论已定案。**代价规范层的签字册
>    条目已落地**:642/45438 两条 `cost_norm` 已登记进
>    `curatedAbilityFacts.ts`(Task 6,2026-08-14 user 签字:「机制上任何被控状态可
>    施放,但代价过高,不得推荐为常规挡控手段,仅致死威胁下的最后手段」)。**候选层
>    的守护注消费方尚未接线**——签字册当前没有任何 consumer import 它来过滤/降权
>    候选建议(全仓检索确认),即"不该被推荐为常规挡控手段"这条规范目前只是记录在
>    案,还没有代码真正挡住模型把 642/45438 推成常规建议;这段候选层接线留给下一批
>    任务。

## 26. 原始日志两条被解析层丢弃的高价值流:法力值 + SPELL_CAST_FAILED

深挖实验自由臂(2026-08-14,match 60ab1e8f)实证:parser 的 `advancedActorPowers`
恒空是**解析层选择,不是日志缺失**——raw.txt 的 advanced 参数含逐事件法力值,
SPELL_CAST_FAILED 流(933 条/场)含玩家按键意图(技能名+拒绝原因)。两条流解锁的
分析能力已被实证:

- 治疗法力战争重建(该场死因被重定性为**法力死亡**:终局 10 秒神圣震击被拒 15 次,
  蓝 545/273000;此前四轮约束深挖全部归因保命轮转,漏了根因);
- 敌治疗喝水检测与骚扰处方(三次坐地偷回 144k 蓝、一跳伤害即断水实证);
- 治疗法术蓝效审计(圣光术 29% 耗蓝只买 11% 有效治疗);
- 「无响应」类结论的意图区分(按了被拒 vs 真没按)。
  另:饰品(336126)施放同样只在 raw 可见(此前已发现)。
  方向:parser 采集这两条流(或最小化:analysis 侧建 raw.txt 辅助谓词),下游喂
  候选层(法力压力候选/喝水骚扰候选)与深挖工具。评估解析成本与 slim 迁移影响后拍板。
  复现脚本:gladlog-eval-private/review-sessions/freeform-60ab-scripts/。

> **2026-08-14 技能事实地基项目收尾注记**:本项目未覆盖,仍是开放项——法力值/
> `SPELL_CAST_FAILED` 是**解析层(parser)** 丢弃的原始日志流,不是 DB2 官方数据表的
> 未挖字段,与本项目的 A2 普查(`docs/ability-fact-inventory.md`「A2. 官方效果面
> 普查」一节,`dumpTableColumns.ts` 对 `SpellMisc`/`SpellAuraOptions` 等 7 张候选表的
> 逐列已挖/未挖盘点)不是同一类敞口——A2 候选池里没有能替代这两条流的字段。若日后要
> 系统化处理"解析层丢弃了什么",应作为独立于 A2 的普查维度,而不是往 A2 池子里找。

## 27. `aurasActiveAt` 的 slice(0,10) 截断会藏掉关键光环(硬控被化妆品光环挤出)

`packages/analysis/src/analysis/momentSnapshot.ts:76` 对时刻光环列表硬截 10 条,无优先级
排序——2026-08-14 自由臂实证(match 76ea5f90):owner 2:48-2:53 被冰冻陷阱冻结贯穿队友
整个死亡滑坡,但陷阱光环被挤出前 10 条,导致约束臂两轮(R1「2:51 BoP 可救」、R2「治疗
断档 5 秒」)全部建立在「他能动」的错误前提上,连评审人自己都误判采纳。修法方向:
截断前按光环类别排序(硬控/免疫/大 CD 光环恒进前列,化妆品垫底),或上限提高+标注截断。
涉及 auras 查询与 moment snapshot pack 双消费方,改前查谓词索引。

> **2026-08-14 技能事实地基项目收尾注记**:本条描述的截断 bug 本身**仍未修,仍是
> 开放项**(`momentSnapshot.ts:76` 的 `slice(0, 10)` 未动)。但本项目从另一条路径缓解
> 了同一错误前提家族的一部分:本条案例的核心失误是"以为 owner 能动"(光环列表没显示
> 冻结),而不是"知道被控但不知道能不能按技能"——`usableWhileStunned` 官方化
> (Task 3/5,`usableWhileCcGenerated.ts` 官方 468 集 ∪ 签字册缺口/条件层,共 471)
> 解决的是后一类误判(如 #25 的圣盾术「按不出」),对本条这种"CC 状态本身未被看见"的
> 截断问题没有帮助——**两者是同一大类错误前提下的不同环节,#27 仍需独立修复**。

> **已修(2026-08-14,详见 commit)**:`aurasActiveAt` 截断前按 `auraPriority` 排序——硬控
> (`spellId` ∈ `drAnalysis.ts` 的 `DR_CATEGORY_MAP`)> 大 CD/免疫(`spellId` ∈
> `cooldowns.ts` 的 `MAJOR_DEFENSIVE_IDS`,已含全部 `IMMUNITY_SPELLS` id)> 其余原序,
> 上限仍是 10。回放验收(match 76ea5f90,`auras --t 170`,2:48-2:53 冰冻陷阱窗口内):
> 修前 Minilay 光环列表无冰冻陷阱,修后出现「冰冻陷阱、冰冻陷阱、…」。两个消费方
> (`auras` CLI 查询、moment snapshot pack)测试均绿;谓词索引双语已同步注记。
