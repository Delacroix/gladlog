# 多模型 AI 分析对比(分槽存储 + tab 切换 + 模型选择入口)设计

2026-08-01 · 用户需求原文:同一场游戏用不同 AI agent 分析,要能 tab 切换对比、
互不覆盖;「AI 分析/重新分析」按钮加小扩展箭头「选用其他模型分析」可临时换模型。
设计已用户拍板(嗯,2026-08-01)。

## 1. 存储:analysis-v2 分槽

- `analysis-v2.<lang>.json` 文档结构升级:顶层从单结果改为
  `{ slots: { "<backend>:<model>": AnalysisSlot }, lastSlotKey: string }`;
  `AnalysisSlot` = 现有单结果全部字段(text/chips/promptVersion/deepDive/
  追问历史/finding 标记等)原样下沉一层。
- **槽键 = `${backend}:${model}`**,与 #16 窗口缓存(analyzeWindow)同构口径;
  键值来源与实际调用同源(settings.aiBackend + resolveAiModel,单点计算)。
- **迁移**:读到旧格式(顶层直接是结果对象)时包装成单槽
  `{ slots: { "<legacy>": old }, lastSlotKey: "<legacy>" }`,legacy 键取
  当前设置的 backend:model(尽力归属;写回时自然固化)。不做一次性批量迁移,
  读时懒迁移。
- **写入**:分析完成只 upsert 当前槽 + 更新 lastSlotKey;其他槽字节不动。
  promptVersion 戳按槽存;槽内版本不匹配时该槽按 miss 处理(重分析覆盖该槽),
  不影响其他槽。
- deepDive/追问/finding 标记全部槽内隔离——各模型各自的完整会话。

## 2. 下游消费口径(工程风险点,正面处理)

- `listAnalyzed`/战绩聚合/自学习(distillRules)等单结果消费方:一律读
  **`lastSlotKey` 指向的槽**(= 该场最近一次分析)。行为与改造前完全一致,
  对比槽只是额外保留物。此口径写成共享 helper(`resolveActiveSlot(doc)`),
  所有消费方 import,不许各自摸 slots。
- 批量分析驱动器写槽 = 当前全局设置的 backend:model(与单场一致)。

## 3. UI:对比 tab

- `StructuredAnalysisPanel` 顶部:`slots` 数量 ≥2 时渲染小 tab 条;标签用
  模型短名(映射自 aiModels 表的 label,过长截断;同后端多模型时含模型名)。
- 点击切换 = 纯前端换显示槽,零请求;当前槽高亮;切换不影响 lastSlotKey
  (lastSlotKey 只在真实分析完成时更新)。
- 单槽时不渲染 tab(零噪音,现状观感不变)。
- 删除单槽不做(YAGNI;真要清理可重新分析覆盖)。

## 4. UI:按钮扩展箭头(split button)

- 「AI 分析/重新分析」右侧小箭头,菜单标题「选用其他模型分析」,列出:
  检测到的本地 CLI 后端(claude/agy/codex,已有 cliDetect 结果)+ 已配 key
  的 API 后端(anthropic/deepseek)各自的可选模型(aiModels 表)。
- 选中即以该 backend:model 发起分析,写它的槽;**临时选择,不改全局设置**
  (设置页默认不动)。菜单里标注当前全局默认项。
- 不可用后端(未检测到/无 key)不出现在菜单(而不是灰显——菜单短一点)。

## 5. 边界(刻意不做)

- 同屏并排 diff 视图;跨模型自动评分/裁决;槽删除管理;窗口分析(#16)的
  多槽 tab(它已有 backend:model 键缓存,UI 对比留待需求真出现);
  全局默认切换入口(仍在设置页)。

## 6. 测试与验证

- 存储层:旧格式懒迁移(读旧写新)、槽隔离(写 A 槽不动 B 槽字节)、
  lastSlotKey 更新时机、槽内 promptVersion miss 只影响本槽——单测全覆盖,
  红→绿。
- 消费口径:`resolveActiveSlot` 单源 helper + 各消费方走它的防腐断言。
- UI:单槽无 tab / 双槽有 tab 且切换正确 / split 菜单只列可用项 /
  临时选择不写全局设置——组件测试。
- 视觉基线:split 箭头会改 report-ai 场景(按钮外观)→ CI 重生成人审;
  tab 条在基线 fixture(单槽)下不出现,不额外影响。
- 真机点验交接:双模型真实分析一场 → tab 对比 → 临时切换菜单。
