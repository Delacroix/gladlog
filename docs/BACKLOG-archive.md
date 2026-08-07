# BACKLOG 归档(已完成条目)

从 [BACKLOG.md](BACKLOG.md) 迁来的**已完成**条目,保留原编号与全部落地注记
(完成时间/commit/spec 指针见各节标题与正文)。个别节内标注的非阻塞顺手遗留
已在 BACKLOG.md 的 Session follow-ups 节留有指针。2026-08-06 建档。

## 2. Interrupt (kick) dashboard ✅(2026-07-22 与 #3 打包落地,f145aaf:KickDashboard 两队聚合 + 逐条审计 + seek;与爆发账本同谓词 analyzeKickAudit)

A per-match (and maybe cross-match) view of interrupts: kicks landed vs. missed,
by player, interrupt availability windows, locked schools, wasted kicks.

- **Already have the data:** `packages/analysis/src/utils/enemyInterrupts.ts`
  (`computeEnemyInterruptAvailability`) + the `[KICK]` timeline events in
  `buildMatchContext`. This is mostly an **aggregation + renderer** on top of
  existing analysis, not new parsing.
- **Scope signals:** small–medium. A new report tab/panel in the desktop
  renderer + a small aggregator in `analysis` (kicks by caster/target, hit/miss,
  interrupt uptime). Reuse the report UI patterns (FindingsList/TimelineStrip).

## 3. Purge / dispel dashboard ✅(2026-07-22 与 #2 打包落地,f145aaf:DispelDashboard 账目双向 + 漏 purge/漏解列表 + CC 解除率;reconstructDispelSummary 同谓词)

A view of offensive purges and dispels: purges done, **missed purge
opportunities** (an enemy buff left up), by player, plus friendly dispels.

- **Already have the data:** `packages/analysis/src/utils/dispelAnalysis.ts` +
  the `[MISSED PURGE OPPORTUNITY]` / `[CLEANSE]` / `[MINOR DISPELS]` timeline
  events in `buildMatchContext`. Again mostly **aggregation + renderer**.
- **Scope signals:** small–medium, parallel to #2 (same shape: aggregator in
  `analysis` + a report panel). Could ship #2 and #3 together as a "utility
  dashboards" sub-project since they share structure.

## 4. Burst-window analysis timeline (visual) ✅(2026-07-29 落地:战报 Timeline 底部承压泳道 DMG SPIKE 点击设窗接 #16 + HEALER EXPOSURE 标记;TimelineStrip 同步项作废——经查该组件产品中无实例化点(KeyMomentAxis 已取代,仅存于 faithfulness 测试面),2026-07-29 勘定;spec docs/superpowers/specs/2026-07-29-pressure-lanes-design.md)

A visual timeline of offensive/burst windows, damage spikes, and healer-exposure
moments — the "bursting window" timeline from the old repo's analysis view.
Today gladlog only renders _deaths_ on `TimelineStrip`; this adds the burst/
pressure lane.

- **Already have the data:** `buildMatchContext` emits `[OFFENSIVE WINDOW]`,
  `[DMG SPIKE]`, `[HEALER EXPOSURE]` via `computePressureWindows`
  (`packages/analysis/src/utils/healerMetrics.ts` / `context/*`). The candidate
  data exists; this is a **timeline visualization** on top.
- **Old-fork reference (concept):**
  `packages/shared/src/components/CombatReport/CombatAIAnalysis/matchTimeline.ts`
  - `TimelineStrip.tsx` (the burst/offensive-window timeline strip) and
    `CombatReplay/` for the scrubbable timeline. gladlog's own `context/matchTimeline*`
    already ports much of the _data_ side.
- **Scope signals:** medium — extend the existing `TimelineStrip` (currently
  deaths-only, `packages/desktop/src/renderer/src/report/components/TimelineStrip.tsx`)
  to render burst/pressure/exposure lanes with hover detail. Ties in with #1
  (video sync) if that ships — the same timeline could scrub the recording.

## 5. Settings UI (Anthropic API key + model) ✅(实为已完成、状态未更新:设置页含 API key/后端/模型/语言等已随 2026-07-18 UI 三阶段上线,后续多轮扩充;2026-08-06 归档补记)

There is currently **no GUI to enter the Anthropic API key** — only the DevPanel
AI-backend dropdown. That's why the app shows `NO_API_KEY`. Add a real settings
panel: API key (write-only, redacted like the main-process store already does),
model, WoW dir, AI backend. Small; the IPC (`settings.get/save`, `redactSettings`)
already exists — this is renderer UI.

## 6. 2D positional replay ✅(实为已完成、状态未更新:ReplayView 地图+GCD 泳道+倍速+深挖此刻已上线,2026-07 起多轮迭代;2026-08-06 归档补记)

A scrubbable top-down arena replay (positions, HP, casts, dampening over time) —
distinct from #1's video. Old-fork reference: `CombatReport/CombatReplay/` (Pixi.js
— `ReplayCharacter`, `ReplayHealthBar`, `ReplayCastBar`, `ReplayDampeningTracker`,
speed control). gladlog already parses advanced-logging coordinates (positioning
section in `buildMatchContext`), so the data exists. Medium–large; shares the
timeline seam with #4.

## 7. Competitive stats / trends ✅(实为已完成、状态未更新:StatsDashboard 胜率/分专精/分地图聚合已随 2026-07-18 UI 三阶段上线;2026-08-06 归档补记)

Cross-match aggregation: win rate over time, per-spec/per-comp performance, a tier
list. Old-fork reference: `CompetitiveStats/` (`SpecStats`, `CompStats`,
`TierList`). gladlog stores every match locally, so this is aggregation + a new
view — no cloud needed (unlike the old fork's server-backed version).

## 8. Deterministic mistake detection ✅ v1(2026-07-23 落地于 release/0.1 分支,c59ba8c:MISTAKE_RULES 8 条三档规则 + 防腐测试 + MistakesCard/时间轴 ⚠;全部消费既有确定性谓词,不经 LLM。扩规则时在 MISTAKE_RULES 表态即可)

A rules-based "mistakes" engine that flags concrete errors (trinket held through a
full-DR CC, defensive wasted, kick missed) **without an LLM** — complements the AI
findings with cheap, always-available, fully-verifiable output. Old-fork reference:
`CombatReport/CombatMistakes/` (`analyzeMistakes` + `mistakeKnowledgeBase`). Fits
gladlog's honesty ethos (deterministic, grounded) and reuses the existing
`candidateFindings` / analysis utils. Medium.

## 9. Match search / filter ✅(2026-07-22 收尾,fc2c73b:原有 胜负/赛制/单专精 基础上补 comp(专精 chips 同队全含)与日期范围;#12 全量 meta 常驻后纯客户端过滤即覆盖全集,未动 MatchStore)

Filter the (now paginated) match list by spec, bracket, comp, result, date. Natural
follow-on to the windowed list — extend `MatchStore.page` with predicates and add
filter controls to the sidebar. Small–medium.

---

## 10. Surface the structured analysis (currently LLM-text-only) ✅ 收账 (2026-08-01)

gladlog computes a deep per-match analysis (~40 signals) inside `buildMatchContext`
but feeds _all_ of it to the LLM as text — the UI surfaces only the 6 healer
metrics + deaths/cd-waste. The rest is invisible to the user. Items #2 (interrupts),
#3 (purge), #4 (burst timeline) are subsets of this. Other computed-but-unshown
signals worth their own panels/lanes:

- **Diminishing returns / dampening** — `computeIncomingDR`, `computeDampeningTimeline`, `buildDampeningEvents`。✅
  (2026-08-01:Timeline 新增 `dampening?` 泳道,`dampeningSeries.ts` 改消费
  `buildDampeningEvents`+`getInitialDampening` 事件级前向填充)。
- **CC chains** — `analyzeOutgoingCCChains`, `extractAoeCCEvents`, healer-CC-received. ✅
  (2026-08-01:新 `CCChainPanel` 消费 `analyzeOutgoingCCChains` 未过滤全链,行展开逐条施放+DR 档位;
  `dr-clipped-cc` 子集早进 `MistakesCard`;healer-CC-received 聚合属基线 6 指标,逐条 CC 受控在
  `KeyMomentAxis`;`extractAoeCCEvents` 仍纯文本,判定为与 CC 链面板信息重叠,未单独立项)。
- **Kill windows / target selection** — `analyzeKillWindowTargetSelection`, `buildKillSequenceBlock`, contested-trade facts. ✅
  (2026-08-01:`BurstLedgerCard`「窗口目标纪律」节接入 `analyzeKillWindowTargetSelection`,
  `betterTargetExists` 标红提示应打目标)。
- **Positioning / LoS** — `computeOwnerPositionEvents`, `analyzeHealerExposureAtBurst`. ✅
  (2026-08-01:`computeOwnerPositionEvents` 入 barrel,STAYED_IN(需 `stayedInHadRealCost` 判过真代价)
  /MISSED_PUSH/CD_OUT_OF_RANGE 三类进 `KeyMomentAxis`;`analyzeHealerExposureAtBurst` 此前已
  经 `computeHealerExposureEvents` 单源接入 #4 承压泳道)。
- **Defensive management** — `detectFriendlyCDOverlaps`(**死代码,已删**,连同 `IOverlapCast`/
  `IFriendlyCDOverlapGroup`/`formatFriendlyCDOverlapsForContext`,全仓零调用已证)、
  `detectOverlappedDefensives`、`detectPanicDefensives`、`findCheaperDefensiveAlternatives`、
  `computeCDResponseLatency`。✅(2026-08-01:`detectPanicDefensives` 接入 `DeathRecapCard`/
  `KeyMomentAxis` defensive 条目「恐慌性使用」注记;`findCheaperDefensiveAlternatives` 的更省替代
  文案接入死亡回顾;聚合比例/延迟早属基线 6 指标,单次施放 Early/Optimal/Reactive 标签早进
  `KeyMomentAxis`)。
- **Healing gaps** — `detectHealingGaps`, `computeSlackSegments`, `computeHealingInWindow`。✅
  (2026-08-01:`detectHealingGaps` 进 `KeyMomentAxis`(`heal-gap` kind)+ `healerMetrics` 新增
  `healingGapSeconds`/`healingGapCount` 标量,贯通 ProComparison/corpus-tools/preload)。
- **Trinket usage** — `analyzePlayerCCAndTrinket`, `detectTrinketType`。✅(2026-08-01 代码核对:
  该谓词已是 `DeathRecapCard`/`KeyMomentAxis`/承压泳道/`healerMetrics` 的共享输入,
  饰品状态逐处结构化可见,无需再单独立项)。
- **Death root-cause** — `buildDeathRootCauseTrace`, `findContributingDeath`。✅(2026-08-01 代码核对:
  这两个函数本身在 UI 路径已是死代码,但同类"为什么死"结构化拆解已由 #17b 的
  `computeMitigationAudit` + counterfactual 系列取代,`DeathRecapCard` 逐条渲染,
  不再是"死亡时刻可见、原因纯文本")。
- **Match arc / flow** — `buildMatchArc`, `buildMatchFlow`, `extractMatchDynamics`。✅
  (2026-08-01:新 `buildMatchArcStructured` 单源结构化早/中/晚相位+转折点,`buildMatchArc` 改为
  纯格式化其输出、prose 逐字节不变;渲染层新战报头部行 `MatchArcLine` 三相位可点转折跳转;
  `buildMatchFlow`/`extractMatchDynamics` 为 deprecated/internal 附属,未消费,不在本轮范围)。

Approach: promote these from `buildMatchContext` text into structured events (like
`extractCandidateFindings` does for deaths/cd-waste) so both the UI _and_ the
findings pipeline can use them — and so #8 (deterministic mistakes) has grounded
inputs. Big theme; slice into panels/lanes over several sub-projects.

Note: `extractRotations` is computed but only consumed by offline `corpus-tools`,
not the app — either surface it or leave it corpus-only by design.

**2026-08-01 收官**(plan `.superpowers/sdd/2026-08-01-backlog10-surfacing/`,5 任务
9 commits,`60441ad..2a85724`):八项信号全部出面,逐条见上方 ✅ 注记。全部消费既有 analysis
谓词零新计算(唯一新函数 `buildMatchArcStructured`,结构化既有内部丢弃值,prose 输出逐字节
防腐测试保);presubmit 全绿(lint/typecheck/test/verify:vision/build)。

留 3 条顺手 minor(均已 ride 入账,非阻塞,待顺手):

- Timeline dampening 泳道存在 pointer-events 死区(悬浮 title 覆盖不全新泳道区域)。
- `detectPanicDefensives` 的 enemy 侧调用点与 friend 侧谓词命名存在第二种拼写不统一。
- `keyMoments.ts` 与 `ProComparison` 的 owner 回退链应共享一个 `resolveOwner`,目前各自实现
  (今日不可达,POV 选择器落地前需要收敛)。

## 11. 战报明细 breakdown(wowarenalogs 原版 detail 级)✅(2026-07-18 已完成:meters 行内展开,输出/治疗/承伤三模式;承疗按来源与打断/驱散清单未做——用户未选)

用户提出(2026-07-18):当前战报 meters 只有每人总量(伤害/治疗一条),
信息量不如老 wowarenalogs 的 detail 视图。目标:点开一个玩家 → 具体分解:

- **输出按技能分解**:每个技能的总伤害/占比/次数/暴击率/最大一击;
- **治疗按技能分解**(含过量治疗占比);
- **承伤按来源分解**:谁的什么技能打了你多少(死亡分析的常备需求);
- **承疗按来源**;可选:打断/驱散/控制的逐条清单。

数据全在 unit 事件数组里(damageOut/healOut/damageIn 按 spellId 聚合即可),
纯 derive + 展开式 UI(meters 行点击展开或独立 detail tab)。与 #10 的
结构化面板方向互补:这是"原始账目",#10 是"分析结论"。

## 12. 懒加载后台补载 + 战绩动态更新 ✅(2026-07-18 已完成,见 App.tsx 后台补载循环 + StatsDashboard matchStored 订阅)

用户反馈(2026-07-18):当前懒加载(首屏只 parse 最近 N 场)加载确实快了,
但有两个残缺:

1. **没有后台补载**:首屏之后剩余对局不会在空闲时继续 parse,列表往下翻/
   搜索旧场次仍然缺;应在首屏渲染完成后用空闲队列(逐场、可中断)把剩余
   对局补进内存缓存。
2. **战绩仪表盘不随补载更新**:统计页仍然只算最初 load 的那几盘——补载
   完成一批后应增量重算聚合(或至少提供"已统计 X/Y 场"提示 + 手动刷新),
   否则胜率/分角色统计对老玩家是错的。

关联:docs/plans/2026-07-19-large-match-load-optimization.md(方案 A 的
workerHost 异步 parse + LRU 已设计,可作为后台补载的执行载体)。

## 13. 深挖全局锚点 / 非击杀失误独立发现(2026-07-19 记入)✅(2026-08-01 收官:自动滑窗版,见文末)

现状:深挖是**放大镜**——只在初轮已标记 finding 的时刻窗口 `[-30s,+10s]` 内收
证据(含走位),不做全局扫描。若某时段初轮没标 finding,即使那里有走位失误/其他
证据也**不会**进深挖(见 [[gladlog-deepdive-value]])。

方向:让非击杀失误当**独立锚点 / 新 finding**,而非只作现有 finding 窗口内的补充。
raw 信号大多已有(`candidateFindings.ts` 的 `unconverted-burst` / `burst-into-immunity`
/ `off-target-in-window` / `juked-kick` / `dr-clipped-cc` / `cd-waste`,加 `computeOwnerPositionEvents`
的走位失误)。权衡:这把深挖从「把已知死亡讲透」变成「发现初轮漏掉的新问题」,
必须配同款信号门(hasCoachableSignal 精神)+ 审计,否则重引噪音/填充风险。
与 #8(确定性 mistake 引擎)、#10(结构化信号上浮)方向重叠——三者应一起想清楚
「非击杀时段帮助」的产品形态再动手。本条是那次 brainstorm 的一个候选实现路径。

> **2026-08-01 代码级审计核对**:2026-07-23 后 #8 确定性失误引擎已让 9 类非击杀候选独立成
> 清单条目,不依赖初轮 finding;round-1 prompt 自 2026-07-18 起已有非死亡覆盖硬规则
> (`buildFindingsPrompt.ts:47`),证据菜单三时段覆盖 0/17→11/17(07-24)。#16 windowOverride
> (`buildWindowPack`, `deepDive.ts:999`)证明了"任意窗口+同款信号门"机制可行,但仍是用户手选
> 触发。真正剩下的只是自动化:让这套机制自动滑窗覆盖全场,而不是等用户点或等初轮 finding
> 命中——`analysisInput.ts:97-134` 的自动深挖路径依旧严格锚定在 `finding.eventIds`,零全局扫描。

**2026-08-01 收官**(spec `docs/superpowers/specs/2026-08-01-backlog13-autosweep-design.md`):
自动化的那一半补上了——全场 20s 窗、10s 步进跑 #16 现成信号门
(`buildWindowAnalysisRequest`,零重新实现),与既有锚点(初轮 findings 时间锚
∪ 确定性失误清单 `deriveMistakes` 的 `tS`)±5s 容差重叠即丢弃,命中窗合并取
并集边界,按信号密度(pack.items 数)降序取 top 3。AI 分析视图 findings 区
下方新增「未覆盖亮点」卡(零亮点不渲染),点击【AI 分析此段】直接复用 #16 的
`runWindowAi`(设窗+触发,零新 IPC,享缓存/force 语义)。

滑窗本身全确定性(不调模型),只有用户点了卡片按钮才会真正发起一次模型调用
——延续 #16 的成本纪律。落地:`derive/uncoveredHighlights.ts`(纯几何,mock
信号门单测命中/去重容差边界/合并分岛/排名裁剪)+
`components/UncoveredHighlightsCard.tsx` + `MatchReport.tsx`/
`StructuredAnalysisPanel.tsx` 接线(`onFindingsAnchors` 回调把初轮 findings
时间锚喂给父级)。真实 fixture 集成测试确认了这条链路真复用 gate(90s/9 窗
<30ms,不是伪装成通过的假绿)。

边界(v1 不做,见 spec):不自动把亮点升级为 finding;不进批量分析;不出面在
非 AI 视图;窗宽/步进不可配置。

## ~~spellNames 12MB 顶层 await 阻塞首屏~~ ✅ 已修(2026-07-19)

**症状**:首屏(报表渲染 / 应用冷启动)固定要等 ~22-25 秒。

**根因不是「文件大」,是「编译成了源码」**:`spellNames.json` 有 41 万个键,
Vite 5 默认把 JSON 转成 **JS 对象字面量**,V8 必须把它当源码解析。同一份数据
`JSON.parse` 只要 **42ms** —— 差了三个数量级。

**修法**:三个构建目标(main/preload/renderer)与试验台配置都打开
`json: { stringify: true }`,让 Vite 产出 `JSON.parse("…")`。一行配置,
不动任何 API、不改 40+ 个 `getEnglishSpellName` 调用点。

**效果**(CI 实测):

| 指标           | 修前       | 修后       |
| -------------- | ---------- | ---------- |
| 应用冷启动     | 18.7–24.0s | 1.59–1.72s |
| 报表首渲       | 21.9–27.0s | 2.12–2.19s |
| 视觉套件总耗时 | 3.0 分钟   | 22 秒      |
| E2E 套件总耗时 | 1.3 分钟   | 14.5 秒    |

`qa/budgets.ts` 的三个预算随之从 5100/41000/36000 收紧到 4900/3300/2600。

**留给后来者的教训**:大 JSON 进 bundle 之前先确认它走的是 `JSON.parse` 而不是
对象字面量。这个坑没有任何报错,只表现为「启动很慢」,而且大到一定程度才显形。
质检体系的性能预算就是为了让这类回退不再靠人肉察觉 —— 它是被
`[budget] coldStart` 量出来的,不是被谁「觉得有点慢」发现的。

## 15. AI 分析文本内联图标(技能/职业名 → 图标+中文名)✅(2026-07-28 落地:渲染层后处理 inlineRich + zhCN 词典生成物;spec docs/superpowers/specs/2026-07-28-inline-spell-icons-design.md)

用户原话:「log 分析里技能名、角色职业换成图标更直观,你前面的页面用图标,分析的
时候咋不用了。AI 说你一个正常宁静没用,我还是猜的英文。」

现状:战报其他视图(泳道/meters/明细/mistake 卡)都经 `SPELL_ICONS_GENERATED`
渲染图标,但 AI 产出的叙事/findings/深挖正文是纯文本,技能名以英文出现;深挖
chips 已带 `spellId`(仅图标用),正文没有。中文用户读英文技能名要靠猜。

方向:**渲染层后处理**,不动 prompt/审计链路(裸数字审计、claimChecker 都作用于
文本,必须先插值、后替换)。findings/深挖/叙事文本里的已知技能名用「英文名→id」
反查表替换为内联组件(图标 + 本地化名);职业/专精名同理(`classMetadata`)。
反查歧义(同名多 id)取有图标的/语料高频的;替换不改存储文本,纯展示。
Scope:小-中,纯 renderer + 一个共享 `<SpellInline>` 组件。

## 16. 选定时间段 →【AI 分析】(任意窗口按需深挖)(2026-07-27 记入,B站用户反馈) ✅(2026-07-29 落地:TimeRangeBar 选段→windowOverride 构包→window 模式深挖→WindowAnalysisCard;无信号零成本路径;windowAnalysis.<lang>.json LRU 缓存;spec docs/superpowers/specs/2026-07-29-window-ai-analysis-design.md;真模型 filler smoke 待真机)

用户场景:读完整场分析后,在时间轴上框选一段,点【AI 分析】,看这一段
「有没有其他可能性」。

现状地基:深挖包本来就是窗口化的 —— `buildDeepDivePack` 收任意
`[minT-30, maxT+10]` 窗口的证据(CC/防御/敌方 CD/HP/驱散/走位/可用未用),不
依赖初轮 finding 的具体类型。把窗口换成用户框选的 `[from, to]`、造一个合成
finding 锚点,即可复用全链路(pack → prompt → audit → chips 跳回放)。

与 #13(深挖全局锚点)同方向:#13 是系统自动找非击杀锚点,本条是**用户手动指定
窗口**,实现更简单、产品上更直觉,可作 #13 的先行验证版。注意:窗口内无可教信号
时要如实输出「这段没看出问题」(hasCoachableSignal 门保留,空结果是合法输出,
别为点击强产建议);一次模型调用的延迟/费用要有 UI 预期管理。
Scope:中 —— renderer 框选交互 + IPC + analysisService 复用深挖管线。

## 多模型分析对比 ✅ 已落地(2026-08-01,spec/plan 见 `.superpowers/sdd/2026-08-01-multi-model-analysis/`)

分析缓存改分槽存储(`AnalysisSlot`/`AnalysisCacheDocV2`,槽键
`${backend}:${model}`)+ 面板 tab 切换(≥2 槽才显示)+ 分析按钮旁「选用其他
模型分析」split 箭头(临时切换后端/模型跑一次,不写全局默认设置)。终审复核
另修一处 renderer 生产构建卫生:`shared/analysisCache.ts` 顶层 `import "path"`
被 renderer 侧 `slotLabel.ts` 间接拉进浏览器 bundle 导致 `electron-vite build`
必现失败(vitest/tsc 测不出,只有生产构建能抓)——拆出零 fs/path 依赖的
`shared/analysisSlots.ts` 装全部纯槽逻辑,`analysisCache.ts` 只留 Node 专用的
`analysisCachePath` + 废弃 v1 信封,`export *` 保持 main 侧旧 import 路径不用改。

**终审残留挂账(交接项,下次触达 `StructuredAnalysisPanel.tsx` 顺手处理)**:
旧槽 tab 若缓存已失效(prompt 版本升级等)会正确显示占位提示且不清空底层
`result`,但顶部状态行(「已缓存 · N 条 findings」)与 Export 仍读的是底层旧
`result`——占位态下这两处会显示跟占位说明对不上的旧槽数字/内容,不会
crash,只是观感撕裂,同批一并禁用或隐藏即可。

## 20. AI 分析聊天框(2026-07-30 记入,用户提出) ✅(实为已完成、状态未更新:问教练 2026-08-02 落地,spec docs/superpowers/specs/2026-08-02-coach-chat-design.md,CLI 三后端 resume 会话;2026-08-06 归档补记)

在 AI 分析视图加一个**对话框**:用户可以就本场分析追问("为什么说我墙交早了?"
"2:08 那波换我怎么打?"),AI 带着已有上下文(分析缓存 findings/深挖证据包/
匹配数据)连续对话,而不是只读单向报告。

- **现成地基**:analysis 服务已有完整 prompt 构建(buildMatchContext/深挖证据包/
  window 模式)、流式 emit 通道(`gladlog:analysis:delta`)、按场缓存;聊天 =
  在这些之上加多轮 message 历史 + 一个输入框 UI。
- **要想清楚再动**:上下文策略(每轮全量重发匹配上下文很贵,考虑首轮 system +
  历史增量)、与深挖/选段分析(#16)的关系(聊天可能取代"预制追问"的一部分)、
  聊天历史落盘与否、成本护栏(本地后端 vs API 计费)。
- **状态**:先记账,不排期。

## Session follow-ups(已完成项,自 BACKLOG 同名节迁出)

- ~~**SP-B2.1**~~ ✅(2026-07-29 落地:userData/reference_vectors.json 覆盖路径,
  坏文件回退内置;换新语料=把新 json 丢进用户数据目录重启)— CDN corpus refresh
  (ship an updated `reference_vectors.json` without a full rebuild).

- ~~**zh/EN analysis-language toggle**~~ ✅(实为已完成、状态未更新:settingsStore.aiLanguage + buildCoachSystemPrompt 语言注入 + 按语言分缓存 + SettingsPanel 开关 + 面板跟随,全部 LLM 出口——叙事/深挖/findings/对比解说——均消费该设置;2026-07-22 核实)— the prompts/output are zh-leaning; a
  language switch for findings + narrative.

- ~~**F170 `[ENEMY HARD CAST]` narrower than old (A1 oracle finding, 2026-07-13)**~~
  ✅(2026-07-29 root-caused + fixed: wiring bug, not intentional narrowing — F170
  read `enemy.spellCastEvents` filtered for `SPELL_CAST_START`, but the new L3
  parser split that stream so `spellCastEvents` is SUCCESS-only and START events
  live in the sibling `castStartEvents` field; the filter was empty-set-by-construction.
  Fix: point F170 at `enemy.castStartEvents`. Same-sample before/after on 60 seeded
  matches / 208 combats: 0/208 combats emitting → 28/208 (10/60 matches). Regression
  test added (`matchTimeline.hardCast.test.ts`). Oracle allowlist entry retired.

- **Tolerant JSON extraction for local models** — the analysis service does
  `JSON.parse(raw.trim())`; agy/Claude returned clean JSON in testing, but other
  local models may wrap it in ```json fences → parse fails → silent fallback.
  Strip fences / extract the first `[...]` before parsing so local backends are
  robust. (Surfaced by the MODE=local e2e.)
  ✅(实为已完成、状态未更新:2026-07-31 `parseModelJsonArray` 单源容错落地——剥 ```json 围栏/提取首个数组,claude -p 实测形态回归测试钉住;2026-08-06 归档补记)
