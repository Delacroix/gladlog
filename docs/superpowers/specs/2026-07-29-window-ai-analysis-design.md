# 选定时间段 →【AI 分析】(backlog #16)设计

2026-07-29 · 来源:B站用户反馈(与 #15 同线程)——「读完整场分析后,在时间轴上
框选一段,点 AI 分析,看这一段有没有其他可能性」。

## 目标与判据

战报视图已有时间窗选择(`TimeRangeBar` 下拉 + HP 曲线拖选,`timeRange {fromS,toS}`)。
窗口激活时出现【AI 分析此段】按钮;点击后对该窗口按需深挖,结果以内联卡显示在
TimeRangeBar 下方(finding 卡样式 + #15 内联图标 + chips 跳回放)。三种终态:

1. 审计通过的选段观察文本 + 证据 chips;
2. 窗口无可教信号 → **不调模型**,零成本显示确定性文案「这段未检出可教信号
   (无受控/防御施放/敌方爆发/HP 骤降等)」;
3. 模型输出全部未过审计 → 「模型输出未通过审计」+ 重试按钮。

空结果是合法输出——不为点击强产建议。

## 决策记录(brainstorm 拍板)

1. **结果位置**:战报视图内联卡(不进 StructuredAnalysisPanel,不弹层)。
2. **无信号路径**:构包判门在 renderer 完成,门不过根本不发 IPC、不调模型。
3. **缓存**:**落盘**旁路文件(用户拍板),不碰 `analysis-v2` 文档。
4. **路线**:方案 A——合成锚点 + 复用深挖全链路(pack → prompt → audit)。
   否决:独立新 prompt/审计(重复建审计设施);伪装初轮 finding 走两轮(绕远)。

## 方案 A 缺点的三层弥补(已拍板)

框架文案为「追问既有结论」而写,选段模式无结论,直接套用会引导模型硬找问题:

- **Prompt 层(治语气)**:合成锚点 finding 的 title/explanation 由 pack 统计
  确定性生成、纯中性事实描述(「用户选段 0:36–0:59:窗口内 X 次受控、Y 次防御
  施放…」),无「问题/失误」措辞;`buildDeepDivePrompt` 加 `mode: "window"`,
  注入显式空输出契约——不预设窗口有问题、只讲窗口内证据支持的观察、无值得指出
  的决策点时返回空数组。
- **审计层(治事实,结构性兜底)**:占位符纪律/裸数字/chips 校验原封不动继承,
  框架带偏的最坏结果是措辞,不可能编造窗口外事实。
- **验证层(治盲区)**:占位符纪律类 feature 单测是盲区([[gladlog-deepdive-eval]]
  教训),落地后真模型 smoke ~10 窗口(有信号/无信号/进攻型),人审 filler 率。
  超标再上第二档(「clean」升级为显式结构化输出)——先不做,等数字。

## 架构

### 分析层(packages/analysis · deepDive.ts)

- 现 `buildDeepDivePack` 的 item 收集体重构为私有 `collectPackItems(combat,
anchorFrom, anchorTo, candidates, ownerName)`;`buildDeepDivePack`(finding
  锚点,窗口 [minT-30, maxT+10])与新导出 `buildWindowPack(combat, fromS, toS,
candidates, ownerName)`(用户窗口**原样**,不加 padding——用户框的就是想看的)
  共用它,谓词单源。`buildWindowPack` 的 `findingIndex` 固定 0。
- **信号门分级**(新导出 `windowPackGate(pack)`):先 `hasCoachableSignal`
  (生存),不过再 `hasOffensiveCoachableSignal`(进攻窗口「打了没打死」也可教);
  都不过 → `"none"`,调用方走无信号文案。
- `buildDeepDivePrompt(packs, findings, spec, ownerName, mode?)`:
  `mode: "window"` 时替换指令头(选段模式契约,见上),其余渲染(facts/占位符
  说明)不变。
- 合成锚点构造器 `buildWindowAnchorFinding(pack, fromS, toS)`:确定性生成中性
  title/explanation(fmtTime 渲染网格,遵守门规谓词即规范——时间先 floor 到
  渲染秒再进文本)。

### 主进程 + IPC(packages/desktop main)

- 新 IPC `gladlog:analysis:analyzeWindow`:输入
  `{matchId, fromS, toS, pack, spec, ownerName}`(pack 由 renderer 构好,同
  deepen 模式);`invoke` 直接返回结果(单请求-响应,不走 emit 频道——与 deepen
  的「合并进缓存再 emit」不同,窗口结果不进 findings)。
- 流程:查落盘缓存命中 → 直接返回;未命中 → 单次 LLM(`buildDeepDivePrompt`
  window 模式,max_tokens 2048,单 pack 单 finding)→ `parseModelJsonArray` →
  `auditDeepDives` → 取 findingIndex 0 的 `{text, chips}`;空/全丢 →
  返回 `{status:"audit-empty"}`。
- **落盘旁路文件** `windowAnalysis.<lang>.json`(每场一个,位于该场 matches
  目录):`{ [windowKey]: {fromS, toS, text, chips, at} }`,
  `windowKey = "${floor(fromS)}-${floor(toS)}"`;**上限 20 条,LRU 按 `at`
  驱逐**。原子写(tmp+rename,同 analysis-v2 先例)。audit-empty 不落盘
  (允许重试)。
- 幂等守卫:同场同 windowKey 在飞时重复调用直接丢弃(deepening 集合同款,
  必须在主进程,renderer 判定是 TOCTOU)。

### 渲染层(packages/desktop renderer)

- `MatchReport`:`timeRange` 激活时 TimeRangeBar 行尾出【AI 分析此段】按钮。
  点击 → `buildWindowPack`(经 `toLegacySafe`,构包/判门全在 renderer,复用
  `buildAnalysisInput` 的 owner 解析口径)→ 门不过直接落无信号卡(不发 IPC);
  过门 → IPC,loading 态(「分析中,约 10–30s」)→ 终态卡。
- 结果卡 `WindowAnalysisCard`:finding 卡样式;文本经 #15 `rich()` 内联图标;
  chips 复用既有 chip 按钮 + `onJumpT` 跳回放;卡与当前选区绑定——`timeRange`
  变化即收起(缓存命中时切回同窗口即时回显)。
- 前置契约:构包前 `await ensureAnalysisData()`(prompt 法术名不许降级,
  panel/批量同款)。

## 边界(刻意不做)

- 多窗口对比、结果进 StructuredAnalysisPanel/跨场聚合、回放视图入口。
- 「clean」显式结构化输出(第二档,等 smoke 数字)。
- EN 模式无特殊处理(aiLanguage 链路本来就支持,系统提示词随设置)。

## 测试

- 分析层:`buildWindowPack` 与 `buildDeepDivePack` 同窗口等价断言(重构不变性);
  `windowPackGate` 分级(生存过/仅进攻过/全不过);`buildWindowAnchorFinding`
  渲染网格取整;window 模式 prompt 含空输出契约、不含追问框架文案的断言。
- 主进程:缓存命中不调 client(mock client 计数)、LRU 驱逐、audit-empty 不落盘、
  幂等守卫、原子写。
- 渲染层:按钮出现条件(有 timeRange 才出)、三终态渲染、窗口切换收卡、
  无信号路径不发 IPC(bridge mock 计数)。
- 真模型 smoke(落地后、真机):~10 窗口 filler 率人审——单测盲区的唯一补法。
- push 前 `npm run presubmit`;视觉基线若动走 CI 配方。

## 风险

| 风险                  | 处置                                                       |
| --------------------- | ---------------------------------------------------------- |
| 模型硬找问题(filler)  | 三层弥补(中性锚点+空输出契约+审计);smoke 量化,超标上第二档 |
| 任意窗口缓存堆积      | 每场 20 条 LRU + 旁路文件,不污染 analysis-v2               |
| 重复点击白烧 token    | 主进程幂等守卫 + 落盘缓存命中短路                          |
| 窗口极短(<2s)构包近空 | 门自然不过 → 无信号文案,无需特判                           |
