# Handoff: gladlog UI Redesign (Report 1c Scheme + Full Module Optimization)

## Overview
Implementation instructions for the UI redesign of six modules in gladlog (WoW arena log analysis desktop app, Electron + React, renderer located in
`packages/desktop/src/renderer/src/`):

- **Report** → Use the "Timeline Spine" scheme (Design draft ID 1c)
- **Match List** → 1e, **Replay** → 1f, **AI Analysis** → 1g, **Stats** → 1h, **Settings** → 1i
- A new set of global design tokens (see Design Tokens section), replacing the existing slate black + gold scheme

## About the Design Files
The `模块优化设计稿.dc.html` in this package is an **HTML design reference draft** (static mockup, including a side-by-side comparison of the current reproduction and the improved draft).
It is not production code that can be copied directly. The task is to **reproduce these designs** within gladlog's existing environment (React + TypeScript, single
`styles.css`, no CSS-in-JS): modify the tokens and classes in `styles.css`,
and refactor the structure of the corresponding `.tsx` components. Continue using existing conventions: class name prefixes `rpt-`/`mlr-`/`mlf-`/`dash-`,
and all styles are centralized in `packages/desktop/src/renderer/src/styles.css`.

## Fidelity
**High-fidelity**. The colors, font sizes, spacing, and border radii in the design drafts are final values and should be reproduced pixel by pixel.
The "Problem → Solution" comments below each module in the design draft explain the design intent; the implementation should be based on the visual mockup.

## Design Tokens (Step 1: Modify `:root` in `styles.css`)

Replace/Add (Keep variable names, change values; add accent family):

```css
:root {
  --bg: #161826;            /* was #0d0f12 */
  --surface: #1b1e2c;       /* was #14171c; card background */
  --surface-2: #12141f;     /* was #1a1e25; input background / bar track / inset background */
  --hairline: #3f424d;      /* was #262b34; control border */
  --hairline-soft: #292b31; /* was #1d2129; card outer frame, row separator */
  --ink: #e9e9ed;
  --ink-2: #b2b6ca;         /* secondary text (was #98a1b0) */
  --mute: #75798c;          /* weak text (was #626b7a); for even weaker use #595d6c */
  --accent: #9184d9;        /* new: interaction / active / link / time cursor */
  --accent-text: #d2cefd;   /* text on accent / active text color */
  --accent-soft: #b5abfc;   /* one shade lighter (rating ↑, ultimate chip dot) */
  --accent-fill: #2b2741;   /* active segmented control background, chip background */
  --accent-line: #5d5294;   /* accent element border */
  --gold: #d9a842;          /* only kept for data semantics: ultimate border, kill window, defensive unused */
  --win: #7ac9a3;           /* was #4ade80, desaturated */
  --loss: #e08585;          /* was #f87171, desaturated */
  --font-ui: "Inter", system-ui, sans-serif;  /* needs import Inter 400/500/600/700 */
}
```

Rules (applied globally, not listed one by one):
1. **Numbers no longer use monospace fonts**: The usage of `--font-data` is completely replaced by
   `font-variant-numeric: tabular-nums` (supported by Inter), unifying the font to Inter.
2. **Active/interactive elements all use accent**, the gold color `--gold` only appears in: ultimate CD, kill window color band,
   "available but unused" data determinations. All buttons/tabs/timestamps with `color: var(--gold)` should be changed one by one.
3. **Two-level control forms**: Page-level tab = underline style (2px accent underline); intra-card switch = capsule segmented control
   (active state `background: var(--accent-fill); color: var(--accent-text)`).
   Existing `.rpt-view-tabs` (filled gold) should be changed to underline style; the active state of `.rpt-mode-seg` should be changed from
   `--gold-dim` fill to accent-fill.
4. **Font sizes converge to three tiers**: 11px (auxiliary) / 12.5px (body, tables) / 14px (headings).
   Remove usages of 9/10/10.5/11.5px (10px for badge corners can be retained).
5. **Intra-card dividers use fade-out at both ends**:
   `background: linear-gradient(90deg, transparent, var(--hairline) 48px, var(--hairline) calc(100% - 48px), transparent); height: 1px;`
6. Class colors (`gameConstants.ts CLASS_COLORS`) remain unchanged — data layer identity colors.
7. Focus state: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`

## Screens / Views

### 1. Report (Scheme 1c "Timeline Spine") — Largest change
Involves: `MatchReport.tsx`, `ReportHeader.tsx`, `Timeline.tsx`, `Meters.tsx`,
`DeathRecapCard.tsx`, `BurstLedgerCard.tsx` (remove standalone card), `vulnWindows.ts` (existing data).

**Layout (Top to Bottom):**
1. **Header Row** (replaces current `ReportHeader` 3-column score header + separate `.rpt-view-tabs` in 2 segments):
   Left: `Victory` (16px/600, --win) + `3v3 · Nagrand Arena · 4:52` (12px --mute);
   Right: Underline style 3 tabs "Report / Replay / AI Analysis" (13.5px, active 500 weight + 2px accent underline,
   inactive --mute). Player names/ratings no longer appear in the header (they are in the leaderboard).
2. **Main Card: Health Curve** (Full width, `--surface` card, padding 14px 16px):
   - SVG height 240, y-axis 100%/50%/0% grid lines (--hairline-soft), x-axis time ticks
     0:00/1:00/… (10px, #595d6c);
   - Kill window color band `rgba(217,168,66,.16)`, vulnerability window `rgba(224,133,133,.14)`;
   - Curve stroke-width 2, class color; death point: 5px circle (--surface bg, --loss stroke, inner ✕)
     + 9px name time label above;
   - **Replay cursor projection**: Draw an accent dashed line (3 3) here at the current moment of the replay view + time label;
   - **Window List** (Below SVG, one row per vulnBand):
     `3px vertical color bar (Gold/Red) | 0:42–0:55 | Kill Attempt → Zhaoming | Team Damage 812k · Mitigated by Penance Shield | ▶ Replay`
     Row styles: `--bg` background, --hairline-soft border, 7px border radius, 12px text, 6px line spacing, entire row clickable to jump to replay.
     Data source `deriveVulnBands` + outcome determination from `burstLedger`.
3. **Bottom two-column grid (1fr 1fr, gap 16px)**:
   - Left: **Leaderboard Card** (Keep `Meters` four-mode segmented control; row: 17px class glyph square
     (radius 4, class color bg, #10121c text) + name 12.5px + 8px high radius 4 progress bar + right-aligned value;
     line spacing 8px; enemy names --ink-2; filtering curve by clicking names behavior kept, hidden row = opacity .45 +
     strikethrough + glyph outline border);
   - Right: **Death Recap Persistent Column** (replaces current popover `DeathRecapCard`): When no deaths/unselected, show
     placeholder "Click ✕ on the curve to view death recap"; when content exists: card border
     `1px solid rgba(224,133,133,.33)`, title row + judgement capsule ("Unused: Guardian Spirit" gold text gold border,
     "Teammate could give but didn't" gray text) + event 5-column grid (Time 44px | Type 40px colored text: Damage--loss/
     Healing--win/CC--gold | Spell 1fr | Amount right-aligned | Source --mute), line spacing 5px.
     **No longer pushes the page down** (currently inserted into the document flow causing layout jumps).
4. **Burst Ledger**: Standalone card removed, its "Burst Alignment" data merged into the window list (outcome copy),
   "Interrupt Audit" merged into the expanded details of the stats mode table. If you want to be conservative, you can keep the ledger card first but change
   `.rpt-ledger-row` to a 4-column grid (Time 78px | Comp 220px | Target Result 1fr | Judgement 190px).

### 2. Match List (1e)
Involves: `MatchListRow.tsx`, `MatchListFilter.tsx`, `App.tsx` (list grouping), styles.css.

- **Row structure**: Remove WIN/LOSS text badges; win/loss = 2px color line on the left edge of the row (--win/--loss).
  First row: Map name 12.5px/500 + duration 11px --mute + rating 11px with rise/fall
  (`2145 ↑` rise = --accent-soft, `2139 ↓` fall = --mute).
  Second row: Both sides' spec glyphs (17px radius 4 squares, class color bg #10121c text, spacing 3px) +
  9px "vs" + right side time only shows `HH:MM` (tabular-nums). Row inner padding 9px 12px.
- **Date group header**: Today / Yesterday / M/D, 10px uppercase letter-spacing .1em --mute,
  right side daily summary `6 matches · 4-2` (#595d6c). Grouped by `startTime` local day.
- **Selected state**: Bright bg `#1e2130` + inner edge accent line
  (`box-shadow: inset 3px 0 0 -1px var(--accent)`), coexists with win/loss left edge line.
- **Filter bar**: Three controls unified 26px height, 7px border radius, same --hairline border; segmented control active =
  accent-fill; "Clear" is an accent text button, persistent on the right end (only shows when there are filters).
- Rating rise/fall needs the difference between adjacent matches: calculate during meta derivation (compare with previous match in the same bracket),
  if not available, do not show the arrow.

### 3. Replay (1f)
Involves: `ReplayView.tsx`, `GcdSwimlane.tsx`, styles.css.

- **Frames stick to both sides of the arena**: Arena column changed to grid `96px 1fr 96px` (left friendly frames column, middle SVG,
  right enemy frames column), frame card: 2px left edge (friendly --win / enemy --loss), name 11px, 4px health bar,
  10px percentage (color = 3 health tiers: >60% --win / 30–60% --gold / <30% --loss);
  Dead frames opacity .55 showing "✝ Dead + time"; bursting unit names have a 9px --loss "Burst"
  badge appended. Original `.rpt-replay-frames-row` below the arena is removed.
- **Control bar grouping** (inside one card, left to right):
  `⏸ Pause` (accent outline primary button) | Time `2:20.1 / 4:52` (right next to play button) |
  Progress bar (track 6px, played = accent 40% fill, thumb 3px bright bar; kill/vulnerability color band opacity
  increased to .4/.35) | Dampening capsule (--loss text+border) | 1px divider | Zoom +/− | Speed segmented control.
  Below, one line 11px #595d6c shortcut hint:
  `Space Play/Pause · ← → ±5s · Shift ±1s · ⌘+Scroll Zoom · Double-click Reset`.
- **GCD Swimlane**:
  - Background gets horizontal 5s dividing bands (`repeating-linear-gradient`, one 1px --surface line every 5s),
    ticks densified from 15s to 5s;
  - Time cursor 1.5px accent line + right end time badge (accent bg, --bg text, 9px, radius 3);
  - Ultimate chip: accent-fill bg + --accent-line border + 2px accent left edge +
    right end 9px "CD" (--accent-text); "Most recent GCD" border changed to gold (--gold),
    no longer conflicts with ultimate styles;
  - Swimlane header legend: `▮ Ultimate` persistent (11px).

### 4. AI 分析(1g)
涉及:`StructuredAnalysisPanel.tsx`、`KeyMomentAxis.tsx`、`FindingsList.tsx`、
`ProComparisonVerified.tsx`、`CohortDimsTable.tsx`、`MatchHero.tsx`(删除)。

- **操作区置顶**:`重新分析`(accent 描边主按钮)+ 中文/EN 段控 + 状态文字
  「已缓存 · 3 条 findings · 最高严重度 high」+ 右端「导出 ▾」。
  `MatchHero` 的信息并入这行状态文字。
- **本场目标**条:accent 淡底(`--accent-fill` 20% 透明)+ --accent-line 边框卡,
  目标为胶囊(--accent-text 字 + --accent-line 边)。
- **时刻轴改单侧左轨**:grid `52px 1fr`;时间列右对齐 11px --mute;轨道 = 2px
  竖线(--hairline,底部 48px 渐隐),每条目一个 8px 节点圆
  (--bg 底 + 2px 事件色描边:击杀窗口 --gold / 死亡敌方 --win 己方 --loss /
  finding 按严重度)。**取消左右交错**(删 `.rpt-axis-row.left/.right` 逻辑)。
- **finding 卡**:max-width 64ch;严重度 = 色底标签
  `HIGH · 目标选择`(10px/600 大写,HIGH: --loss 字 + `#e0858518` 底;MED: --gold;
  LOW: --mute);标题 13.5px/500 同行;正文 12.5px/1.65 --ink-2;
  操作行:Evidence + `⏱ 1:20` 证据 chips(11px 边框按钮)+ `▶ 回放此刻`(accent 文字);
  **跟进标记(✓/↻)移到卡右上角**。
- **空窗折叠**:>30s 间隔显示一行 10.5px `⏱ 63s 无关键事件 — 折叠`,不打断轨道。
- **cohort 表**:每维度三列 grid `150px 1fr 120px`:名称 | 分布条 | 判定。
  分布条:14px 高,轨道 --surface-2,p10–p90 = --hairline 圆角条,p50 = 1.5px 刻度,
  你的值 = 3px 游标(好 --win / 差 --loss / 持平 --ink-2);判定列
  `p64 · 高于中位`(同游标色,tabular-nums)。

### 5. 战绩(1h)
涉及:`StatsDashboard.tsx`、styles.css。

- **标题行**:`战绩` 14px/500 + 角色 chips(激活 accent-fill 胶囊,带场次小字)+
  右端时间段控(今天/7 天/全部)。
- **总览数字带**(替换三个 `.dash-stat` 小卡):全宽圆角 10 卡,
  底 `linear-gradient(135deg, #262a60, #353b80)`(全页唯一饱和色块),
  四格数字(34px/600 tabular-nums)+ 1px `#ffffff22` 竖分线:
  场次 | 胜率(`58% · 39-28`,胜 ≥50% 用 `#a8e6c4`)| 当前评分 + 7 天变化
  (`2145 ↑63`)| 时长中位。**「当前评分与变化」是新增数据**:取该 bracket
  最近一场本人评分,与时间范围起点前最近一场相减。
- **评分曲线**:补 x 轴日期刻度与 y 轴三档评分;每条 bracket 线端点加圆点 +
  当前分标注;系列色:3v3 = --accent,Solo Shuffle = --win,其余用
  `SERIES_COLORS` 顺延;图例移到卡头(12px 色线 + 名称)。
- **对阵敌方阵容表**:每行三列 grid:专精 glyph 组 | 8px 胜率横条
  (≥55% --win / ≤45% --loss / 其间 #9397ab)| `71% · 7场`(同条色 + 场次 #595d6c)。
  按场次排序;底部说明「点击行回列表筛选该阵容」。旧数据提示移到卡底 11px。
- **最常犯的问题**:行 = 标题 12.5px/500 + `×9` 计数 + ↻/✓ 色字(不用边框 chip)+
  行尾 `最近一场 →`(accent 文字链接)。

### 6. 设置(1i)
涉及:`SettingsPanel.tsx`、styles.css。

- 每分组卡内 **三列 grid**:`130px 1fr auto`(标签 | 值/输入 | 操作),gap 12px 16px,
  替换 `.settings-row` flex-wrap。
- 输入框统一:底 --surface-2、1px --hairline-soft 边、7px 圆角、padding 5px 10px、
  12px 字。
- **API key 行**:输入框前置「已设置」胶囊(--win 字 + 33% 透明 --win 边);
  「保存」普通边框按钮,「清除」= 红色纯文字按钮(--loss,无边框)。
- **保存反馈就地**:✓ 提示(11px --win)显示在对应分组标题行内,2s 消失
  (替换页顶 `.settings-saved`)。
- 「后端」下拉下方加 11px #595d6c 说明行:
  `调试可切 Claude CLI / agy(本地),不走网络`。
- WoW 目录路径 12px --mute 单行省略;「历史日志」行说明:`重复导入按场次自动去重`。

## Interactions & Behavior
- 所有既有交互保留:点名过滤曲线、点色带/证据/账本 ▶ 跳回放(`handleSeekEvent`
  管线不变)、统计表行展开、shuffle 回合 tab、键盘操控。
- 新增:战报窗口列表行点击 = 跳回放该窗口起点;死亡回顾从「浮层」变「右栏常驻位」
  (state 不变,渲染位置变);回放当前时刻在战报曲线投影(需把回放时钟 t 以低频
  同步到 MatchReport,或只在从回放切回战报时显示最后位置)。
- hover:按钮/行 hover 用 accent 淡色(`color-mix(in srgb, var(--accent) 12%, transparent)`
  底或 --accent 描边),不再用金色。
- 段控/tab 切换无动画;卡片无 transition 要求。

## State Management
无新增全局 state。改动点:
- `MatchReport`:`recap` 渲染进右栏而非浮层;可选新增 `lastReplayT`(投影光标)。
- `App`:列表按日分组是纯派生(`useMemo`),分组小结同。
- `StatsDashboard`:新增「当前评分/变化」派生函数(基于现有 metas)。

## Design Tokens 速查(mockup 用到的具体值)
- 底色:页 `#161826` / 卡 `#1b1e2c` / 输入与轨道 `#12141f` / 选中行 `#1e2130`
- 边线:卡框与行分隔 `#292b31` / 控件描边 `#3f424d`
- 文字:`#e9e9ed` / 次 `#b2b6ca` / 说明 `#9397ab` / 弱 `#75798c` / 最弱 `#595d6c`
- accent:`#9184d9`,字 `#d2cefd`,亮 `#b5abfc`,底 `#2b2741`,边 `#5d5294`
- 胜 `#7ac9a3` / 负 `#e08585` / 数据金 `#d9a842` / 战绩带 `#262a60→#353b80`
- 圆角:卡 8px / 控件 7px / chip 5px / 胶囊 999px;字体 Inter(数字 tabular-nums)
- 职业色不变:见 `report/data/gameConstants.ts`

## Assets
无新增图片资产。专精/职业标识用现有 glyph 回退方案(`classGlyph` 2 字母 + 类色方块,
改为圆角 4、字色 `#10121c`);spec 图标 CDN(`specIconUrl`)可继续用,加载成功时
替换 glyph 方块,失败回退不变。Inter 字体需在 `index.html` 或 CSS 引入
(Google Fonts,weights 400/500/600/700)。

## Files
- `模块优化设计稿.dc.html` — 设计参考稿(浏览器直接打开;含各模块现状复刻与
  改进稿并排、每稿「问题 → 改法」注释)。战报采纳其中 **1c**;其余模块采纳
  1e / 1f / 1g / 1h / 1i。1a(战报现状复刻)与 1b/1d 仅作对照,不实现。

## 建议实施顺序
1. Tokens + 全局规则(半天,全 App 变色但布局不动)
2. 设置 1i、对局列表 1e(小,先验证新语言)
3. 战绩 1h、AI 分析 1g
4. 回放 1f
5. 战报 1c(最大,最后做;可先落「窗口列表 + 死亡回顾右栏」,再删账本卡)
