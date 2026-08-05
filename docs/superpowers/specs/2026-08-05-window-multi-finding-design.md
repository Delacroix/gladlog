# 窗口深挖多条化(方案 1)设计

日期:2026-08-05 · 前作:`2026-08-05-moment-deep-dive-design.md`(密集快照 N=20 盲评
35.7% 未跑赢被弃用;本设计是其复盘指向的形态修正,用户拍板方案 1)。

## 动机(数据驱动)

弃用轮的结构性结论:窗口深挖「每锚点一段解说」形态下,(a)「审计后条数」是二元
存活指标,量不到深度;(b) 一条格式失误 = 整个锚点归零,长 prompt 的 B 臂存活率被
系统性压低(70% vs 57.9%);(c) 手工实验里 B 的优势形态正是「多条独立问题」。
方案 1 把窗口/时刻深挖的输出契约改为 **1~4 条独立 finding**,每条独立过审计——
单条阵亡只损失一条。

## 契约变更(仅 window 模式;deepen 自动轮契约不动)

- 模型输出:`[{ "findingIndex": 0, "title": string, "deepDive": string, "citedKeys": string[] }]`,
  1~4 条,同一 findingIndex 允许多条(仅 window 模式;deepen 模式仍每 findingIndex
  至多一条,多余丢弃并计入 dropped)。
- title:≤20 字、无数字(裸数字审计同样覆盖 title;占位符不进 title)。
- prompt 尾部(window 模式变体):明示「找出 1 到 4 条相互独立的技能使用问题;
  没把握的宁可少写,只有 1 条甚至 0 条也可接受(输出 []);每条聚焦一个单位/一个
  决策」。防凑条数:审计不变 + 措辞不奖励条数。
- `auditDeepDives`:window 模式逐条独立裁决(现状即逐条,只放开同 index 多条);
  每条各自 interpolate + chips。`DeepDiveResult` 增加可选 `title?: string`。
- `PROMPT_VERSION` 17→18(输出契约变了,窗口缓存作废;例行语义)。

## main / 缓存 / UI

- `analyzeWindow` 结果 `status:"ok"` 从 `{text, chips}` 改为
  `{entries: Array<{title: string|null, text, chips}>}`;缓存条目同形
  (schemaVersion 随 PROMPT_VERSION 18 自然失效,不需迁移)。
- `WindowAnalysisCard`:单段 → 列表渲染(标题行 + 正文 + chips,复用现有
  finding 卡样式);0 条仍是既有 audit-empty 文案。
- preload 类型同步。

## 验收

- momentDiveAb 适配 entries[](两臂同用新契约;判优喂「该锚点全部条目拼接」,
  盲配对法与防污染机制不变)。
- 复测 N=20:主判据仍是盲配对 B(密集快照)胜率;次判据 条数/存活率/citedKeys。
  **决策规则沿用用户判据:B 胜率 > 50% 才翻转 deepDiveSnapshot 默认值,否则
  维持弃用现状**(多条化本身是独立于 A/B 的产品改进,无论结果都保留)。
- 回归:deepen 自动轮契约字节级不变(既有测试钉);单条窗口输出(模型只给 1 条)
  渲染与旧版等价可读。
