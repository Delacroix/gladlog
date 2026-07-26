# 死亡回顾血量曲线(双栏)设计

2026-07-25 定稿(会话内评审通过)。

## 目标

回放的死亡回顾卡从纯文字表升级为 WoW 死亡摘要式双栏:左栏事件表(技能+数字),右栏死前 10s 血量曲线(掉血段红、回血段绿),CC/防御事件在曲线上画竖 tick。

## 数据层(packages/desktop/src/renderer/src/report/derive/deathRecap.ts)

- `DeathRecap` 新增字段 `hpSeries: Array<{ tS: number; pct: number }>`。
- 采样:`[deathS - DEATH_RECAP_WINDOW_S, deathS]` 区间逐秒,时刻先过 `toRenderSecond`,值取 `getHpPercentAtTime(unit, sec, matchStartMs)`——两者均为 `@gladlog/analysis` 公开导出(criticalMoments/timeline 同源谓词,谓词单源铁律,渲染层不重造 HP 采样)。
- `getHpPercentAtTime` 返回 null 的时刻跳过;全部为 null → `hpSeries: []`。
- 序列末尾追加死亡终点 `{ tS: deathS, pct: 0 }`(仅当序列非空)。
- 现有字段与判定一概不动。

## 组件层

- `DeathRecapCard.tsx`:卡内改两栏 grid;`hpSeries.length === 0` 时右栏不渲染,布局退回现状单栏(旧档/裁剪 fixture 优雅降级,不炸不空白)。
- 左栏事件表数字上色:`kind==="dmg"` 红(`var(--loss)`)、`kind==="heal"` 绿(`var(--win)`)。
- 新组件 `HpSparkline.tsx`(纯 SVG,零依赖):
  - 相邻采样点连线段;段色:pct 下降 `var(--loss)`、上升 `var(--win)`、持平 `var(--mute)`。
  - y 轴 0–100%,x 轴即 `[deathS-10, deathS]`,与左表共享同一时间区间(静态对齐,无 hover 联动)。
  - CC/防御事件(`kind==="cc" | "def_used"`)画竖 tick,`<title>` 提示技能名;终点 ☠。
  - 类名沿用 `rpt-` 前缀契约(新类:`rpt-recap-grid` / `rpt-hpspark` / `rpt-hpspark-seg-{down,up,flat}` / `rpt-hpspark-tick`)。

## 测试

- derive:克隆真实 fixture + 注入死亡 + 注入合成 `advancedActions` HP 序列 → 断言 `hpSeries` 采样值与网格时刻;无 advanced 数据 → `[]` 不抛。
- 组件:红/绿/灰段 class 数量与顺序、tick 数量、空序列右栏缺席。
- 视觉基线:现有场景 fixture 无玩家死亡,预期无 diff;CI 红则按重录配方处理。

## 明确不做(YAGNI)

hover/点击联动、逐行血条、吸收盾可视化、错题本处复用、绝对血量轴(只做百分比)。
