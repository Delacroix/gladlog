# 死亡回顾血量可视化设计(v2 —— 逐行血条)

2026-07-26 v2:用户否决 v1 双栏曲线方案(已随 v0.1.10 发布,本版撤除),
改为 WoW 原版式逐行血条:每行「技能 + 数字 + 血条」,血条画该技能作用
**前→后**的血量区间,红=掉血、绿=回血。

## 数据层(derive/deathRecap.ts)

- **撤除** v1 的 `hpSeries` 字段与逐秒采样。
- `DeathRecapEvent` 新增 `hpBeforePct?: number; hpAfterPct?: number`(仅 dmg/heal 行)。
- 来源(不重造解析,消费 parser 已解析的数据):目标单位 `advancedActions`
  里**同时间戳**(logLine.timestamp 精确相等)的样本即该事件落地后的
  HP/maxHp → `hpAfterPct`;`hpBeforePct` = after + |amount|/maxHp(dmg)
  或 after − amount/maxHp(heal),clamp 到 [0,100]。
- 找不到同时间戳样本(非高级日志行/旧档)→ 两字段 undefined,该行不出血条。
- cc/def_used 行不带这两个字段。

## 组件层

- **撤除** `HpSparkline.tsx`、`rpt-recap-grid` 双栏与相关样式;卡片回到单栏表。
- 事件表新增一列血条 cell(class `rpt-recap-hpbar`,在数字列之后):
  - 0–100% 横向轨道(`rpt-recap-hpbar-track`);
  - 中性底 fill 到 min(before, after)(`rpt-recap-hpbar-base`);
  - 差值段 [min, max]:dmg 红 `var(--loss)`(`rpt-recap-hpbar-delta-dmg`)、
    heal 绿 `var(--win)`(`rpt-recap-hpbar-delta-heal`);
  - cell `title="82% → 61%"`(整数百分比);
  - 无前后值的行 cell 留空。
- v1 保留项:数字上色(`rpt-recap-amt-dmg`/`rpt-recap-amt-heal`)。

## 测试

- derive:fixture 注入死亡 + 注入与 damageIn/healIn **同时间戳**的合成
  advancedActions → 断言 hpBefore/hpAfterPct 具体值;无匹配样本 → undefined。
- 组件:bar 的 delta 段 class 与宽度/位置(style 断言)、title 文本、
  cc 行无 bar;HpSparkline/rpt-recap-grid 不再存在。
- 视觉基线 report-synth 重录(v1→v2 外观变化,人审)。

## 明确不做(YAGNI)

吸收盾段、逐行小曲线、hover 联动、绝对血量轴。
