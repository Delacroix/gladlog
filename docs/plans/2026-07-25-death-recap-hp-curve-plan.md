# 死亡回顾血量曲线 实现计划

> 规格:docs/specs/2026-07-25-death-recap-hp-curve.md。执行模式:agy exec 实现 → Claude 审查(diff + 门禁 + 断言质量)→ commit。

**Goal:** DeathRecapCard 双栏化:左事件表(数字红/绿)+ 右 HpSparkline 血量曲线。

## Global Constraints

- HP 采样只许调 `@gladlog/analysis` 的 `getHpPercentAtTime` + `toRenderSecond`(公开导出已核实),渲染层禁止重造采样逻辑。
- 类名 `rpt-` 前缀;不加新依赖;不加文件级 eslint-disable;tsc 含 test 文件必须过;lint 全仓 `--quiet` 必须过。
- 收尾门禁:`npm run presubmit`(含 verify:vision 与 electron-vite build)。

### Task A: derive 层 hpSeries

**Files:** Modify `packages/desktop/src/renderer/src/report/derive/deathRecap.ts`;Modify `packages/desktop/test/report.deathrecap.test.tsx`(追加 describe)。

- [ ] `DeathRecap` 加 `hpSeries` 字段,按 spec 采样(逐秒 toRenderSecond 网格、null 跳过、非空补 `{deathS, 0}` 终点)。
- [ ] 测试:注入死亡 + 合成 advancedActions(HP 已知序列)→ 断言 hpSeries 具体值;剥掉 advanced 数据 → `[]`。
- [ ] 门禁 + commit:`feat(desktop): 死亡回顾 hpSeries —— analysis 谓词逐秒采样`

### Task B: HpSparkline 组件 + 卡片双栏

**Files:** Create `packages/desktop/src/renderer/src/report/components/HpSparkline.tsx`;Modify `DeathRecapCard.tsx`、`styles.css`;Create/Modify 组件测试(追加到 report.deathrecap.test.tsx)。

- [ ] HpSparkline:SVG 段色 down/up/flat、cc/def 竖 tick(title=技能名)、☠ 终点,类名按 spec。
- [ ] DeathRecapCard:`rpt-recap-grid` 双栏;`hpSeries` 空 → 右栏缺席;左表数字红/绿。
- [ ] 测试:段 class 数量与顺序、tick 数、空序列单栏。
- [ ] presubmit + commit:`feat(desktop): 死亡回顾双栏 —— HpSparkline 血量曲线(红掉血/绿回血)+ 数字上色`
