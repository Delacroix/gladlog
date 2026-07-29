# AI 分析文本内联图标(backlog #15)设计

2026-07-28 · 来源:B站用户反馈(「AI 说你一个正常宁静没用,我还是猜的英文」)。
战报其他视图全走图标,唯独 AI 产出的叙事/findings/深挖正文是纯文本英文技能名,
中文用户靠猜。

## 目标与判据

zh 回复模式下,finding 卡(title/explanation/深挖正文)与对比解说里的已知英文
技能名渲染为「图标 + 中文名」内联组件,hover 露英文原名;职业/专精名同理。
en 回复模式只插图标、不换名(已拍板)。存储文本/prompt/审计链路/导出零改动。

## 决策记录(brainstorm 拍板)

1. **词典范围**:有图标的技能全集(与 `SPELL_ICONS_GENERATED` 同集,~4.2 万条)。
2. **EN 模式**:只加图标,不换名。
3. **替换出口**:finding 卡三字段(FindingsList + KeyMomentAxis 两渲染器)、
   对比解说 `result.report`、职业/专精名,顺手给 KeyMomentAxis chips 补图标。
4. **路线**:渲染层后处理(方案 A)。否决:写回存储(缓存分叉、断审计信任链)、
   prompt 直出中文(审计链按英文名锚定,全链改)。

## 架构

### 数据层(packages/analysis)

- **新 datagen 产物 `spellNamesZhGenerated.json`**:wago.tools `SpellName` 表
  zhCN locale,过滤到有图标的 id 集,估 1-2MB。构建配置沿用
  `json: { stringify: true }`(大 JSON 教训,见 backlog 已结案项)。
  `datagen-manifest.json` 登记条数与字节数;`writeManifest.ts` 同步。
  ⚠ 实现第一步先实测 wago CSV 接口的 zhCN locale 参数;不支持则改走
  `Name_lang` 多 locale 下载方式,再不行降级为「仅主 CD 手表」并回报。
- **英文名→id 倒排表**:运行时惰性构建(不落盘),从既有 `spellNames.json`
  倒排,仅收有图标的 id。同名多 id 消解顺序:**本场出现过的 spellId >
  `observedSpellIdsGenerated` > 最小 id**。
- **职业/专精共享表**:`SPEC_NAMES_ZH` 从 `ProComparisonVerified.tsx` 上浮到
  共享模块,补「英文 spec 短语 → specId + 中文名」;图标用现成
  `specIconUrl(specId)`(CDN 先例同竞技场小地图,视觉测试由 stubExternal 兜)。

### 渲染层(packages/desktop renderer)

- `report/derive/inlineRich.tsx`:纯函数
  `renderRichText(text, { matchSpellIds, lang }) → ReactNode[]`。
  - 最长匹配优先(名字按长度降序编译一次的交替模式),避免 "Ice Block" 被
    "Block" 截胡;JS `\b` 对 CJK/拉丁邻接天然成边界。
  - zh 模式:命中 → `<SpellInline>`(图标 + 显示名);显示名优先级
    **本场日志名 > zh 词典 > 英文原样**(「本场没放过的技能」正是词典的存在
    理由,如宁静没用)。
  - en 模式:命中 → 图标 + 英文原文,不换名。
- `<SpellInline>` 组件:复用 `SpellIcon`(IPC + 磁盘缓存,size 14),
  `title` = 英文原名(对账锚点)。
- 接入点(6 处):`FindingsList` 与 `KeyMomentAxis` 的 title/explanation/
  deepDive.text;`ProComparisonVerified` 的 `result.report`。
  顺手:KeyMomentAxis 深挖 chips 补 `ChipIcon`(对齐 FindingsList,含空 label
  防兜底字符重复的既有注释约定)。

## 边界(刻意不做)

- 不动存储/导出/审计/faithfulness 门 —— 替换纯展示,hover 英文名保证可与
  原始事件、导出 Markdown 对账。
- 不做点击跳转、技能 tooltip 详情(YAGNI)。
- `candidateShortLabel` 等确定性短标签、MistakesCard 文本不在本期(它们不是
  模型产出;若也要换,复用同一 `renderRichText` 即可,另立小项)。

## 测试

- `inlineRich` 纯函数单测:多词名("Power Word: Shield")、同名多 id 消解
  (本场优先)、zh/en 两模式、词典缺失兜底(日志名/英文)、CJK 邻接、
  无命中原样返回。
- 组件 fixture 测试:finding 卡与对比解说渲染出 `SpellInline`;KeyMomentAxis
  chips 出图标。
- datagen:transform 函数单测(过滤到图标集、条目下限断言);manifest 一致性。
- 视觉基线会动:**CI 生成,本机绝不直跑 test:visual**。
- push 前:`npm test --workspace=packages/desktop && npm run typecheck &&
npx eslint packages/desktop/src --quiet`。

## 风险

| 风险                     | 处置                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| wago zhCN locale 不可用  | 实现第一步验证;退路见数据层 ⚠                                              |
| 误替换(英文短语撞技能名) | 只收有图标 id 的名字集 + 最长匹配;真误伤个案可加停用词表                   |
| 词典体积回归首屏         | stringify 载入 + 惰性 import(沿 spellEffectData 先例);性能预算门在 CI 兜底 |
| 视觉基线批量变动         | 预期内,CI 生成人审                                                         |
