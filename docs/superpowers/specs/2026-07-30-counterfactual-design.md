# 减伤反事实 17a+17b(合并周期)设计

2026-07-30 · 源头:B站战士线程「盾反 20% 够不够我不知道」+「总不能判定我
压制没问题吧」。地基全齐(学派覆盖率 100% / DR 表官方化 / MITIGATION_TABLE
28 键);可行性量化见 `docs/reports/2026-07-30-counterfactual-feasibility.md`
——原「可用未按」主形态被推翻(开口 5.6%),转向已拍板。17c(时序重排)
后置,不在本期。

## 决策记录(全部已用户拍板)

1. **切分**:17a+17b 合并一个周期(用户拍板,推翻分期建议);
2. **17b 形态**:A 已交减伤效果核算为主(开口 33.2%)+ B 队友外置可用未给
   为辅(23.0%)+ 原「自己可用未按」降窄门(1.3%,几乎必真);
3. **机制类不扩表**:牺牲祝福(转移)/业报之触(反弹)等表外高频技能本期
   不塑 pct,A 形态遇到如实标「机制特殊,不参与缺口算术」;
4. **输出面**:17b = 死亡回顾卡确定性显示 + [DEATH] prompt facts 双面
   (同一份算术,谓词单源);17a = 新候选 `questionable-external` +
   MISTAKE_RULES 双注册;
5. **黑暗 positional 不进 17b 算术**(条件判定本期不建模,注释留档)。

## 17a:无必要外置判定

### 判据(全用现成谓词,零新计算)

外置白名单 14 条(`externalDefensiveSpellIds`)的每次施放,若同时满足:

- **无爆发对齐**:施放时刻不在任何 aligned burst window 内,且不在
  PRE_WALL_SECONDS 前窗/LATE_WINDOW_SECONDS 后窗内(即现有五档全都不命中、
  落 Unknown 的那部分再细分);
- **无伤害尖峰**:施放前后 TIMING_DAMAGE_WINDOW_S 的 damage curve 无
  Reactive 级信号(复用现有 Reactive 判据的反向);
- **受益目标高血**:施放时刻目标 HP ≥ 阈值(HP 采样走 `HP_SAMPLE_RADIUS_MS`
  单源;阈值由语料实证定,先验候选 80%);

→ `annotateDefensiveTimings` 打第六档 **`Unnecessary`**(timingContext 带
三条依据)。

### 落地链

`Unnecessary` 施放 → 新候选 `questionable-external`(facts:t/spell/
caster/target/targetHp/最近爆发窗距离,全 fmtTime 渲染网格)→
MISTAKE_RULES 新条目(防腐测试强制注册)→ AI findings 菜单自然可引用。

### 白名单纪律(动手前置)

语料实证发生率(arenacoach 第一批同流程,全库固定种子):发生率 ≈0(判据
过严无信号)或 >50%(过宽噪音)即停下回报调阈值,不带病上线。

## 17b-A(主):已交减伤效果核算

### 算术

死亡窗口(死亡前 10s,与量化报告同口径)内死者身上激活的白名单减伤
(aura applied→removed 区间与窗口交叠,`buildAuraIntervals` 谓词单源):

- **可算术条目**(MITIGATION_TABLE 命中且非 positional,覆盖 71%):
  挡掉量 = 激活区间∩窗口内、命中 schoolMask 的观测伤害合计 ×
  pct/(100−pct)——观测值是打折后的,反推折前被挡部分;
- **免疫条目**(pct=100):不反推(除数为零),如实输出「免疫覆盖 X.Xs,
  期间承伤 0」;
- **机制类/表外条目**:如实标「机制特殊(转移/反弹),不参与缺口算术」,
  不编数字;
- **缺口** = 窗口起点绝对 HP(即净掉血,治疗已天然网入——量化报告同口径);
  输出「<技能> 挡了 X(≈N% 最大血量);窗口缺口 Y」。

### 语义边界

只陈述事实量(挡了多少/缺口多少),**不做**「如果它 pct 更高就能活」类
外推(那是 17c/后续);多减伤同窗不建模叠加交互,逐条独立计算并注明
「独立口径,同窗叠加未建模」。

## 17b-B(辅):队友外置可用未给

### 两条前置修复(量化时发现,挡在 B 的正确性路上)

1. **白名单收敛**:`buildDeathOutcomeSummary` 内置 7 条外置表收敛到
   `externalDefensiveSpellIds` 14 条(串联白名单腐烂修复;语料前后数字:
   missedExternals 发生率 7 条口径 vs 14 条口径);
2. **zoneId 形状 bug 核实并修**:`deathRecap.ts` 构造 combatLike 只设
   `startInfo.zoneId` 而消费方读顶层 `zoneId` → 生产路径外置 LoS 过滤疑似
   恒直通。先复现确认,修后给同判据前后数字(LoS 过滤生效前后
   missedExternals 条数变化)。

### 算术

每条 missedExternal(可算术的,80% 覆盖):省下量 = 窗口内命中该外置
schoolMask 的伤害 × pct% → 三档判定;**只有「明显能活」开口**,其余静默
(边缘/仍死不显示——诚实伦理:不确定的不说)。

## 17b-窄门:自己可用未按

量化脚本的框架产品化(候选 = `extractMajorCooldowns` × `cdAvailableAt` ×
表内非 positional,CC 死锁剔除走 `wasLockedOutThroughWindow`);同三档门,
仅「明显能活」开口。已知局限如实接受:候选池有职业偏斜
(extractMajorCooldowns 零施放剔除),开口 ~1.3% 但几乎必真。

## 三档谓词(单源)

```
明显能活: 省下量 > 净掉血 + 15% maxHp
边缘:     省下量 ∈ (0.5 × 净掉血, 明显线]
仍然死:   其余
```

单处 export(`counterfactualTiers`),量化报告同口径;死亡回顾卡、prompt
facts、B/窄门共用。CC 死锁死亡(5.2%)整体不开口。

## 输出面

- **死亡回顾卡**(`DeathRecapCard`):A 的核算行(每个激活减伤一行:挡了
  X/N% maxHp;免疫/机制类各自的如实形态)+ B/窄门的「明显能活」行(若开
  口);全部确定性数字,不经 LLM;
- **[DEATH] prompt facts**:同一份算术结果以 facts 形式进 [DEATH] 块
  (fmtTime 渲染网格,门规谓词即规范——facts 值先 floor 再进文本);措辞
  可能性框架(「若同窗叠加 X,该段伤害约降至致死线下」),与 causalLint
  因果断定禁令兼容,不改门。

## 边界(刻意不做)

- 17c 时序重排枚举;机制类扩表;positional 判定(黑暗不进算术);
- 「pct 更高就能活」类参数外推;多减伤叠加交互建模;
- 治疗行为变化/敌方换目标等行为反事实(算术可行、模拟不可行——backlog
  原文,靠三档表达置信度);
- 跨场聚合。

## 测试与验证

- 算术纯函数单测:反推公式(观测×pct/(100−pct))、免疫零除保护、schoolMask
  过滤、机制类跳过、独立口径多条目;
- 三档谓词与量化报告同口径断言(同一合成输入两边同判);
- 17a:Unnecessary 档判定单测(三条件各自独立否决)+ 发生率语料实证
  (动手前置)+ MISTAKE_RULES 注册防腐;
- B 前置修复:白名单收敛与 zoneId 修复各给语料前后数字;
- prompt facts 是新面:落地后真模型 smoke(deepdive 教训,占位符纪律类
  单测盲区);
- push 前 presubmit;死亡回顾卡变化 → 视觉基线 CI 配方。

## 风险

| 风险                                   | 处置                                                             |
| -------------------------------------- | ---------------------------------------------------------------- |
| 反推公式对部分吸收/护甲混杂的高估      | 输出措辞标「按表值反推」;sanity 已验方向(PS 3/3 同向);不追求精确 |
| 17a 阈值拍脑袋                         | 语料实证前置,发生率异常即停                                      |
| zoneId bug 修复改变 missedExternals 面 | 前后数字 + deathRecap 既有测试回归锚                             |
| prompt facts 引入新审计面              | facts 全确定性数值,走既有占位符纪律;真模型 smoke 收口            |
