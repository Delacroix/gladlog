# Defensive Counterfactual 17a+17b (Merged Cycle) Design

2026-07-30 · Origin: Bilibili warrior thread "I don't know if Spell Reflection's 20% is enough" + "You can't just judge that my Overpower was fine". Foundations are fully in place (School coverage 100% / DR table officialized / MITIGATION_TABLE 28 keys); for feasibility quantification see `docs/reports/2026-07-30-counterfactual-feasibility.md` — the original "usable but unpressed" primary form was overturned (5.6% opening rate), pivot is approved. 17c (timeline rearrangement) is deferred, not in this cycle.

## Decision Record (All User Approved)

1. **Slicing**: 17a+17b merged into one cycle (user approved, overturning the phased suggestion);
2. **17b Form**: A. Accounting of submitted defensive effects as primary (33.2% opening rate) + B. Teammate external usable but not given as secondary (23.0%) + Original "self usable but unpressed" downgraded to narrow gate (1.3%, almost certainly true);
3. **Mechanic class does not expand table**: High-frequency off-table skills like Blessing of Sacrifice (transfer) / Touch of Karma (reflect) will not have pct modeled this cycle; if form A encounters them, label truthfully "Special mechanic, does not participate in gap arithmetic";
4. **Output Surface**: 17b = Deterministic display on Death Recap card + [DEATH] prompt facts dual surface (same arithmetic, single source predicate); 17a = New candidate `questionable-external` + MISTAKE_RULES dual registration;
5. **Darkness positional does not enter 17b arithmetic** (Conditional checks are not modeled this cycle, keep comment for record).

## 17a: Unnecessary External Determination

### Criteria (All using existing predicates, zero new computation)

For each cast of the 14 whitelist externals (`externalDefensiveSpellIds`), if it simultaneously satisfies:

- **No Burst Alignment**: The cast time is not within any aligned burst window, and not within the PRE_WALL_SECONDS front window / LATE_WINDOW_SECONDS rear window (i.e., further subdividing the part that missed all existing 5 tiers and fell into Unknown);
- **No Damage Spike**: The damage curve for TIMING_DAMAGE_WINDOW_S around the cast has no Reactive level signal (reusing the reverse of the existing Reactive criteria);
- **Beneficiary Target High HP**: Target HP ≥ threshold at cast time (HP sampling uses `HP_SAMPLE_RADIUS_MS` single source; threshold determined by corpus empirics, a priori candidate 80%);

→ `annotateDefensiveTimings` marks a 6th tier **`Unnecessary`** (timingContext carries the three reasons).

### Landing Chain

`Unnecessary` cast → New candidate `questionable-external` (facts: t/spell/caster/target/targetHp/distance to nearest burst window, all rendered in fmtTime grid) → MISTAKE_RULES new entry (anti-corruption test forced registration) → Naturally citeable in AI findings menu.

### Whitelist Discipline (Pre-implementation)

Corpus empirical occurrence rate (arenacoach first batch same process, full db fixed seed): If occurrence rate ≈ 0 (criteria too strict, no signal) or > 50% (too loose, noise), stop and report back to tune thresholds; do not ship with disease.

## 17b-A (Primary): Submitted Defensive Effect Accounting

### Arithmetic

Whitelist defensives active on the deceased within the death window (10s before death, same basis as quantification report) (aura applied→removed interval overlaps with window, `buildAuraIntervals` single source predicate):

- **Arithmetic-capable Entries** (Hits MITIGATION_TABLE and non-positional, covers 71%):
  Amount Blocked = Total observed damage hitting schoolMask within (active interval ∩ window) × pct/(100−pct) — The observed value is post-discount, back-calculating the pre-discount blocked portion;
- **Immunity Entries** (pct=100): Do not back-calculate (division by zero), output truthfully "Immunity covered X.Xs, damage taken during this time 0";
- **Mechanic / Off-table Entries**: Truthfully label "Special mechanic (transfer/reflect), does not participate in gap arithmetic", do not invent numbers;
- **Gap** = Absolute HP at window start (i.e., net HP loss, healing is naturally factored in — same basis as quantification report);
  Output "<Skill> blocked X (≈N% max HP); window gap Y".

### Semantic Boundaries

Only state factual amounts (how much was blocked / what the gap is), **do not** make extrapolations like "if its pct were higher, they would have lived" (that is for 17c/future); multiple defensives in the same window will not have their stacking interactions modeled; calculate each independently and annotate "Independent basis, same-window stacking not modeled".

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
