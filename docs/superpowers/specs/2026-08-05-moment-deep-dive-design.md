# 时刻级深挖(深挖此刻)设计

日期:2026-08-05 · 状态:待用户审阅
用户拍板:直接做「深挖此刻」入口;自动 deepen 轮与密集快照并行,设置开关选择。

## 背景与实证

现有深挖(deepDive/windowAnalysis)偏 general:pack ≤14 项、只有 8+6 类已判定事件,
**没有**时刻冷却台账、DR 档位、光环、坐标距离、施法流水——而这些谓词在 analysis 包全部现成。

对照实验(2026-08-05,match 6c663a46,死亡时刻 2:13 ±10s,同 sonnet):

|      | A:现有选段管线                           | B:密集时刻快照                                                                                      |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 产出 | 1 条 461 字,泛泛(「外置没交、早点喊话」) | 4 条 1327 字                                                                                        |
| 深度 | —                                        | 治疗 14s 零治疗施法;盗贼保命全转 CD 时切入开控;满档 DR 凿击 1s 被友方伤害打断;Rallying Cry 可用未按 |
| 核查 | 过审计                                   | 3/4 完全有数据行支撑;1/4 核心成立但含时序错误的因果推断(死后事件被说成死因)                         |

结论:数据密度决定深度;B 的幻觉形态(时序/因果越界)恰是现有占位符+审计纪律要拦的
——所以落地必须在现有管线内做,不另起炉灶。

## 目标 / 非目标

**目标**

1. 「深挖此刻」入口:回放/时间轴选定时刻 t → t±10s 窗口 → 密集快照 pack → 同管线深挖。
2. 密集快照 pack:新增快照类 PackItem,承载冷却台账/DR/光环/距离 LoS/预计算流水信号。
3. 自动 deepen 轮可选用密集 pack:设置开关 `deepDiveSnapshot`(默认关,现状不变);
   手动「深挖此刻」恒用密集 pack(这是它存在的意义,不受开关影响)。

**非目标**

- 法力/资源字段(parser 不采集 `advancedActorPowers`,恒空,死路)。
- 光环「剩余时长」(实验实锤 inferredEnd 语义在 close 缺失时不可靠——样本里几乎全是 3s;
  一期只列在身光环名,剩余时长等谓词修好再说)。
- API 对话式追问(用户明确要独立密集 prompt,不是 resume 会话)。

## 架构:全部复用现有 deepDive 管线

`windowOverride` 已支持任意窗口;真正的增量是**新增 pack item kinds** + 一个入口。

### 1. 快照 item kinds(packages/analysis,新文件 `momentSnapshot.ts`,被 `buildDeepDivePack` 按 flag 调用)

| kind           | 每条粒度             | facts(全过 fmtFactNum,时刻先 floor 到渲染网格) | 来源谓词(全部既有 export,见 predicate-index)                                                                                              |
| -------------- | -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cd-ledger`    | 每单位               | `t, unit, role, ready, onCd`(技能名列表串)     | `extractMajorCooldowns` + `cdAvailableAt`                                                                                                 |
| `aura-snap`    | 每单位               | `t, unit, role, auras`(名字列表,无剩余秒)      | `buildAuraIntervals`(utils/auraIntervals.ts 版!注意与 utils/utils.ts 同名函数的碰撞)+ 新谓词 `aurasActiveAt(unit, combat, t)` 单源 export |
| `pos-snap`     | owner↔每单位         | `t, unit, role, dist, los`(los=有/被挡/未知)   | `getUnitPositionAtTime`(INTERP_MAX_GAP_MS)/ LoS 走 `getUnitRawPositionAtTime` + `hasLineOfSight`(null→"未知",绝不当 false)                |
| `dr-state`     | 窗口内每次落地 CC    | `t, caster, target, spell, drLevel, durationS` | `analyzeOutgoingCCChains`(我方→敌方)+ owner 承受侧复用 `analyzePlayerCCAndTrinket` 既有 cc item                                           |
| `healing-gap`  | 每个我方治疗空窗     | `unit, fromT, toT, gapS`                       | 复用 #10 的 healingGap 谓词(healerMetrics 同源,不重写)                                                                                    |
| `activity-gap` | 每单位最大无施法空窗 | `unit, fromT, toT, gapS`                       | 新谓词 `largestCastGap(unit, fromS, toS)` 单源 export(spellCastEvents 相邻间隔取最大);debate 采纳项,覆盖非治疗位空窗(DPS 被风筝/未拆火)   |
| `hp-snap`      | 每单位               | `t0, t1, hpStart, hpEnd, hpMin`                | `getHpPercentAtTime` / `getLowestHpPercentInWindow`(显式 HP_SAMPLE_RADIUS_MS)                                                             |

原始施法流水:作为 prompt 的**上下文段落**(每行 `M:SS 施法者 → 技能`,时刻走 fmtTime),
新增 HARD RULE:「流水仅供理解时序;正文引用任何数字仍必须用 {{pN.field}} 占位符」。
模型想说「X 秒没治疗」→ 数字由 `healing-gap` item 承载。审计纪律零放松。

### 1b. Debate 结论(agy Gemini 3.1 Pro,2026-08-05,一轮)

对方 OPPOSE,三个反例逐条处置:

- **采纳**:枚举 kinds 会静音非治疗位的空窗洞察(「DPS 被风筝 9s」)→ 新增
  `activity-gap`(全员最大无施法空窗,上表)。聚合计数类(「浪费 3 个 GCD」)一期不做,
  验收时统计「模型想说但没占位符可用」的静音率,数据说话再补 kind。
- **驳回**(对方反例失实):「满档 DR 凿击 1s 无法表达」——`dr-state` facts 本就含
  `durationS`(实验里 1.0s 正来自 `analyzeOutgoingCCChains` 的 durationSeconds);
  「被友方伤害打断」的因果归因本来就该被 causalLint 拦,不是要放行的东西。
- **拒绝其替代方案**(动态引用/推导校验 `{{timeline_delta|a|b}}`):那是第二套验证引擎,
  与门规谓词纪律(一个事实一个谓词、确定性文本检查)正面冲突,且「简单加减法推导放行」
  本身就是新的幻觉攻击面。若验收静音率高,优先补确定性 kind,不开动态推导口子。

### 2. Pack 上限

`PACK_MAX_ITEMS=14` 不动(自动轮默认路径零变化)。快照模式用独立上限
`MOMENT_PACK_MAX = 32`,按 kind 配额截断(cd-ledger/aura-snap/hp-snap/activity-gap
每单位 1 条,pos-snap ≤5,dr-state/healing-gap 按时间距锚点排序取余额),
超限丢弃要 log 进 pack 元数据。

### 3. main / IPC / 设置

- 复用 `analyzeWindow` 通道:input 加 `snapshot?: boolean`;缓存 key 追加 `:snap` 段;
  PROMPT_VERSION 例行 +1(pack 形状变了)。
- 设置:`deepDiveSnapshot: boolean`(默认 false)→ deepen 自动轮的 `buildDeepenPacks`
  按开关选 pack 构建;SettingsPanel AI 区加开关,文案注明 token 成本约 2-4 倍。
- max_tokens:快照模式 window 调用 2048 → 3072(facts 多、findings 3-6 条)。

### 4. UI 入口

- ReplayView 控制条 +「深挖此刻」按钮:取当前回放时钟 t(绝对 ms → 相对秒边界换算只在
  MatchReport 边界做,沿用既定规则),窗口 [t-10, t+10] clamp,走
  `buildWindowAnalysisRequest`(snapshot: true)→ 结果复用 WindowAnalysisCard 展示。
- TimeRangeBar 已有框选入口顺带获得 snapshot 开关能力(同一请求构建函数)。

### 5. 审计与门规(谓词即规范)

- 输出侧:`auditDeepDives` 原样(占位符 key 校验/claimChecker/裸数字/repairSpellNameZh/causalLint)。
- 新谓词 `aurasActiveAt` 一处 export、prompt 与任何未来门规同源;登记 predicate-index。
- utils/utils.ts 与 utils/auraIntervals.ts 的同名 `buildAuraIntervals` 是存量谓词重复,
  登记进 predicate-index「尚未统一」节(本设计只消费 auraIntervals.ts 版,不顺手合并)。
- eval 补第 6 类 hardFailure:解析深挖 prompt 的快照 facts,复算同秒一致性
  (`hp-snap` 与既有 `hp` item 同渲染秒同单位必须一致;`cd-ledger` 与
  `immunity/external-available` 不得矛盾)——现有五类只扫全场 timeline 格式,
  深挖 prompt 一直无人把守,这条堵上。

### 6. 验收(前后数字)

- 固定锚点集:最近对局取 20 个死亡锚点,快照模式 vs 现状各跑一遍(sonnet):
  比较 平均 findings 数 / 审计通过率 / 人工抽评深度(实验基线:1 条泛化 vs 4 条具体)。
- 静音率(debate 遗留判据):抽查被审计丢弃的条目,统计「模型引用了流水里真实存在
  但无占位符可用的数字」占比;高则补确定性 kind(优先聚合计数类),不开动态推导。
- 确定性:快照 items 生成覆盖率(20 锚点全部 ≥ 预期 kind 配额)、
  eval 第 6 类 hardFailure 0 触发。
- 自动轮开关:开 vs 关各跑同一批,确认关=字节级现状不变(pack 构建走原路径)。

## 分期

1. **P1**:momentSnapshot.ts + kinds + prompt 段落 + 审计/eval 第 6 类 + `analyzeWindow` snapshot flag(TimeRangeBar 即可触发,验收跑数)。
2. **P2**:ReplayView「深挖此刻」按钮 + 设置开关接通自动轮 + SettingsPanel + 视觉基线。
