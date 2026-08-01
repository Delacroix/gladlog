# 自动分析新对局设计

2026-08-01 · 用户拍板:设置开关打开后,每拿到一盘新对局自动用当前全局默认模型分析。
设计四点已口头确认;探明后补两条工程处理(live/import 判别、忙时排队)。

## 1. 设置

- `GladlogSettings` 增 `autoAnalyzeNew: boolean`(AI 块,`aiLanguage` 后;DEFAULTS false;
  settingsStore get() 的 `{...DEFAULTS, ...raw}` 天然兼容旧文件,无迁移)。
- SettingsPanel AI 分组末行(教练回复语言行之后、:326 之前)加「自动分析新对局」行,
  沿用「启用/停用」按钮先例(recordingEnabled :332-351 样式),描述文案:
  「实时监听到新对局入库后,自动用当前默认模型分析(历史导入不触发)」。

## 2. live/import 判别(主进程)

- `gladlog:logs:matchStored` 事件 payload 从裸 `StoredMatchMeta` 扩为
  `StoredMatchMeta & { live?: boolean }`:main/index.ts:112 实时路径带 `live: true`;
  importLogs.ts:57 导入路径不带(undefined)。旧订阅方(App/DevPanel/StatsDashboard)
  只读 meta 字段,新增字段无感。
- 判别铁律:只有 `live === true` 触发自动分析——导入洪峰绝不触发。

## 3. 渲染层 autoAnalyze 队列模块

- 新文件 `packages/desktop/src/renderer/src/batch/autoAnalyze.ts`:模块级
  `pending: string[]`(meta.id,去重)+ `startAutoAnalyzeListener()`(App 挂载时调一次,
  返回退订)。
- 事件到达 → `bridge().settings.get()` 现读开关(recorder 每事件现读先例,绝不缓存)
  → 开着且 `live` → 入队 → `drain()`。
- `drain()`:`getBatchStatus().running` 为真则挂 `subscribeBatch` 等空闲;空闲即
  `startBatch(pending.splice(0).map(id → {id, label}))`——排队/串行/skip-if-cached/
  自动深挖全部复用批量驱动器,零新分析逻辑。label 用 meta 缓存的 bracket/时间拼
  (与 BatchAnalyzeBar labelFor 同风格;拿不到 meta 就用 id 前八位)。
- shuffle:meta.id=首轮 id,startBatch 的现有 shuffle 展开逻辑(matches.get →
  rounds 逐轮)天然正确。
- 失败不重试不弹窗(战报页可手动重试);app 关闭期间不补(用现有批量分析补)。

## 4. 测试

- settingsStore:autoAnalyzeNew 默认 false/save 往返。
- 主进程:live 标志——实时路径带、导入路径不带(emit payload 断言)。
- autoAnalyze 模块(桩 bridge):开关关→不入队;开→入队且 startBatch 收到 id;
  批量运行中→挂起,批量结束后 drain;import(无 live)→不触发;重复 id 去重。
- SettingsPanel:开关行渲染与保存调用。
- 视觉基线:settings 场景会多一行 → CI 重生成人审。

## 边界(不做)

- 关机期间补漏;bracket 过滤;自动分析用非默认模型;并发多开。
