# 承压/暴露泳道(backlog #4)设计

2026-07-29 · 战报 Timeline(HP 曲线)已有「我方击杀尝试/敌方脆弱」全高色带
(vulnBands);本设计补**反向**:我方承压(DMG SPIKE)与治疗暴露
(HEALER EXPOSURE)的可视化,并与 #16 选段分析闭环。

## 目标与判据

战报 Timeline 曲线区底部新增一条细泳道(~8px):

1. **DMG SPIKE 承压段**:红系半透明块,hover 原生 title
   「0:36–0:46 Player2 承压 1.2M(120k DPS)」;
2. **HEALER EXPOSURE 标记**:同一泳道上竖线/菱形,hover
   「治疗暴露:被拉远 N 码/断 LoS」;无高级日志坐标时优雅缺席(spike 不依赖
   坐标,始终可用);
3. **点击承压段 = 设置时间窗**(`setTimeRange({fromS, toS})`)——与 #16 的
   【AI 分析此段】按钮串成动线:看到承压段 → 一点选窗 → 按需深挖。

判据一致性:prompt 里出现 [DMG SPIKE] 的段,泳道上必然有,反之亦然
(同一 `DMG_SPIKE_THRESHOLD` 门,谓词单源)。

## 决策记录(brainstorm 拍板)

1. **落点**:战报 Timeline 为主;TimelineStrip 同步留后续小尾巴,不在本期。
2. **范围**:DMG SPIKE + HEALER EXPOSURE 都做;[OFFENSIVE WINDOW] 与现有
   进攻色带重复,不做。
3. **路线**:方案 A——renderer 纯 derive + analysis 补两个单源出口。
   否决:结构化事件上浮(#10 主题,牵 prompt/审计链);Timeline 内联计算
   (违反谓词单源)。
4. **泳道形态**:底部细泳道而非全高背景——与进攻色带同层会混色,分层后
   攻(背景)/防(底条)一眼可辨。

## 架构

### 分析层(packages/analysis)

- **`DMG_SPIKE_THRESHOLD` 提为共享导出**:现只在 `matchTimelineSections`
  内部 import 消费;挪到/re-export 至单源位置(与 `computePressureWindows`
  同处 `utils/cooldowns.ts` 或其常量源),`matchTimelineSections` 与新 derive
  两个消费者 import 同一常量。窗口参数(windowSeconds=10, topN=5)同理——
  emitDmgSpikeEntries 用什么参数调 computePressureWindows,derive 就用什么
  (提成共享常量,两边 import)。
- **新 orchestrator `computeHealerExposureEvents(combat, ownerName?)`**:
  封装 `analyzeHealerExposureAtBurst` 的全部编排(burstWindows/enemies/
  healer/CC summaries/zoneId,镜像 `buildMatchContext` 的调用点,提取而非
  复刻——buildMatchContext 改为消费同一 orchestrator,谓词单源)。输出带
  相对秒时刻与暴露类型(拉远/断 LoS)、距离等展示字段。

### 渲染层(packages/desktop renderer)

- `report/derive/pressureLanes.ts`:
  `derivePressureLanes(source) → { spikes: PressureBand[]; exposures: ExposureMark[] }`
  - `toLegacySafe` 进入;spike = `computePressureWindows(...)` 过
    `DMG_SPIKE_THRESHOLD` 门;exposure = `computeHealerExposureEvents(...)`;
  - 全部**相对秒**;try/catch 兜底空数组(fixture 剥数组不抛)。
- `Timeline.tsx`:曲线 SVG 底部加泳道层;spike 块可点(onClick →
  `onRangeSelect(fromS, toS)`,复用现有拖选回调,MatchReport 零新 prop);
  exposure 标记不可点(纯信息)。样式进 `styles.css`。

## 边界(刻意不做)

- TimelineStrip(AI 视图)同步——独立小尾巴,视本期效果再排。
- [OFFENSIVE WINDOW] 泳道(与 vulnBands 重复)。
- 跨场聚合、承压榜单。
- 泳道图例/开关(先常显;真挤了再说)。

## 测试

- derive 单测:阈值门(低于门的窗口不出)、无位置数据 exposure 空但 spike
  仍在、相对秒口径、fixture 剥数组不抛。
- 谓词单源防漂移:断言 derive 与 `emitDmgSpikeEntries` 消费同一
  `DMG_SPIKE_THRESHOLD` 与窗口参数(import 同一符号即结构保证;若参数
  以字面量出现则加相等断言测试)。
- Timeline 组件测试:泳道渲染(有 spikes 出块)、点击块调 `onRangeSelect`
  且参数为该段起止、exposure 标记出现。
- 视觉基线:`report-battle`/`report-window`(可能还有 report-synth)会动——
  CI 生成人审配方。
- push 前 `npm run presubmit`。

## 风险

| 风险                                    | 处置                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| 承压带与进攻背景带视觉打架              | 分层(背景 vs 底条)+ 色系分离(金/灰红 vs 红)                                  |
| exposure 编排提取碰坏 buildMatchContext | 提取式重构(buildMatchContext 消费同一 orchestrator)+ 既有 context 测试回归锚 |
| 底部泳道挤占曲线高度                    | 泳道加在 SVG 高度内的保留条(不缩曲线);实现时若需增高容器,视觉基线人审把关    |
| 短窗口(<1s)块太窄点不中                 | 最小宽度 0.4%(bands 先例同款)                                                |
