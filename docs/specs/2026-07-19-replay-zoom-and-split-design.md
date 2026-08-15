# Replay View: Scroll Wheel Bindings, Zoom Hot Zone, Draggable Map/GCD Splitter

**Date:** 2026-07-19
**Status:** Approved, pending implementation
**Branch:** `worktree-replay-zoom-and-split`
**Impact Area:** `packages/desktop/src/renderer/src/report/components/ReplayView.tsx` and adjacent units

## Origin and a piece of history that needs clarification

Users have raised three complaints about the replay view. There was a design iteration earlier on 2026-07-19, but it mistakenly targeted an old fork
`~/code/wowarenalogs` (CC BY-NC-ND), analyzing the complaints against the upstream's pixi implementation. The conclusion was almost opposite to the actual code in gladlog
(e.g., claiming "gladlog has no zoom buttons"—it actually does; claiming "panel overlay swallows scroll
events"—gladlog's frames are side-by-side grid columns, not overlays). The patch produced in that iteration is not applicable to this repository and will not be ported.
This spec is a redesigned version after re-verifying against gladlog's own codebase.

## Problems (Item-by-item verification against gladlog's current state)

**1. Scroll wheel zooming feels like a "Mac-exclusive binding".** `ReplayView.tsx:147` is
`if (!e.ctrlKey && !e.metaKey) return;` — the scroll wheel only zooms when holding ⌘/Ctrl. Mac trackpad pinching
naturally fires a wheel event with `ctrlKey`, so on Mac it "just works with a pinch"; on Windows, scrolling the mouse wheel without holding Ctrl does nothing.
Zoom buttons do exist (`:869-893`, next to the speed settings), they are just far from the map.

There is an **intentional trade-off** in this line, with the comment saying "normal scroll wheel is reserved for page scrolling"—reports are long scrollable pages, and originally the bare scroll wheel
was dedicated to scrolling the page. This is the only decision in this iteration that comes with a real cost.

**2. The zoom hot zone is only the SVG body itself.** The listener is attached to the `<svg>` element (`:156`), and the SVG has
`aspectRatio` + `preserveAspectRatio="xMidYMid meet"`, so when the middle column is wider than the map, the empty space on both sides acts as dead zones.

**3. The widths of the map and the GCD swimlane are hardcoded.** `.rpt-replay-stage` has a hardcoded
`grid-template-columns: 1fr 2fr` (`styles.css:916`), with only two togglable modes: "Map + GCD" / "Map Only".
The ratio is not adjustable, and it lacks a "GCD Only" mode.

**4. The map SVG is hard-capped at 560px wide.** (Found this while writing the implementation plan; it wasn't in the initial three complaints, but it would make
the draggable splitter completely ineffective for the map side.) `.rpt-replay-field` in `styles.css:653-656` has
`max-width: 560px`, with no global override. The consequence is that dragging the splitter to give the map more width beyond 560px
has no visual effect; the extra space just becomes blank gutters.

Even more surprisingly, **the "Map Only" mode doesn't enlarge the map either**: `map-only` widens the arena-grid to 1100px
and the frames to 140px, but the middle SVG remains stuck at 560px — the actual effect of this mode is just "enlarged frames + centered".

This directly conflicts with the complaint that "clumped players are hard to see": currently, the only real way to enlarge things is by zooming (which uses viewBox and is independent of pixel
width, always effective), while the approach of "making the map larger" has always been blocked by this line of CSS.

## Three existing facts that keep the changes small

- `.rpt-gcd` is `flex: 1 1 0; min-width: 0`, SVG is `viewBox` + `preserveAspectRatio` +
  `aspectRatio` — **both sides are purely fluid**. Splitting only requires changing grid column widths, **no `ResizeObserver`
  or size measurement is needed**.
- The replay clock uses `requestAnimationFrame` (`:197-216`), not a pixi ticker. Hiding the map **will not**
  freeze the progress bar; the "GCD Only" mode can truly not render the map.
- The math for `applyZoom` runs in viewBox units (`dimsRef` stores VW/VH), **decoupled from pixel width** —
  dragging the splitter will not disrupt the zoom state.

## Design

### State Model: A single ratio, modes are its preset values

The splitter uses a single `ratio` (map proportion, 0–1). The three modes are preset values for `ratio`, not parallel states,
thus eliminating contradictions like "mode says map only, ratio says 0.4".

| Mode                 | ratio                                   | Rendering                      |
| -------------------- | --------------------------------------- | ------------------------------ |
| Map + GCD (`split`)  | User's last dragged value, default `1/3` (current 1:2) | Both sides + splitter          |
| Map Only (`map`)     | 1                                       | Do not render GcdSwimlane      |
| GCD Only (`gcd`)     | 0                                       | Do not render SVG / frame columns / zoom overlay |

Extreme modes **must actually not render** the other side; they cannot rely purely on CSS to crush it to 0: although `.rpt-gcd` has `min-width: 0`,
the internal chips will stretch it out, and `flex: 1 1 0` cannot contain them.

**Dragging is clamped to `[0.2, 0.8]`**, meaning it cannot reach the extremes. To make one side full-screen, the user must click the mode buttons—"dragging" is always for
fine-tuning, while "modes" are the only path to enter extreme states. The semantics of the two do not overlap, which also prevents users from accidentally dragging a side to oblivion and losing it.
The splitter **does not** support double-click to reset.

### Scroll Wheel Decision Table

The zoom focal point is still calculated using the SVG's `getBoundingClientRect()`. The hot zone **does not include** the 96px frame columns on the left and right.

The hot zone requires a currently non-existent DOM node: `<svg>` is now a direct grid child
of `.rpt-replay-arena-grid` (`styles.css:742-744` has `.rpt-replay-arena-grid > svg { grid-column: 2 }`).
The middle column lacks a container; the blank space belongs to the grid track itself, so listeners cannot be attached. **In the implementation, wrap the SVG in a wrapper div
occupying the 2nd column**, move `grid-column: 2` from `> svg` to this wrapper, and attach the scroll wheel listener (`hotZoneRef`) to
the wrapper. This is the only DOM structure change in this iteration.

```
⌘/Ctrl + Scroll           → Zoom, preventDefault()
Bare Scroll && view !== null  → Zoom, preventDefault()
Bare Scroll && view === null  → Do not intercept, pass to page scroll
```

The third line means **do not call `preventDefault()`**, rather than "call it but don't zoom"—the event must continue to bubble,
otherwise, the map will become a scrolling black hole in panoramic mode.

Entering zoomed state = a clear "I'm looking at the map" signal, so at this point, we take over the bare scroll wheel; after double-clicking or hitting reset to return to the panorama,
the scroll wheel is automatically handed back to page scrolling.

### Zoom Buttons Floating in Bottom-Right Corner of Map

Moved from the toolbar to a floating overlay in the bottom-right corner of the map. **Class names `.rpt-replay-zoom-btn` / `.rpt-replay-zoom-reset`
remain unchanged**—they are the contract for existing tests. The corresponding position in the toolbar is left empty.

### Zoom State Preservation Across Modes

Switching to "GCD Only" and back does not reset `view`, it returns to the original zoom position. Mode switching shouldn't lose the just-aligned perspective.

### Unit Breakdown

`ReplayView.tsx` is already 911 lines. This iteration extracts four units, and `ReplayView` is only responsible for assembly; we will not do unrelated
large refactors (SVG scene rendering is the bulk of the file, not touching it this time).

| Unit                     | Responsibility                                     | Dependency   |
| ------------------------ | -------------------------------------------------- | ------------ |
| `useReplayZoom.ts`       | `view` state, zoom/pan, scroll wheel rules         | None         |
| `useReplayLayout.ts`     | ratio + mode + persistence; exports pure function `clampSplitRatio` | localStorage |
| `ReplaySplitter.tsx`     | Draggable splitter (plain DOM pointer)             | None         |
| `ReplayZoomControls.tsx` | Zoom overlay (pure presentation, carries class name contracts) | None         |

```ts
// useReplayZoom.ts
export function useReplayZoom(): {
  view: ViewBox | null; // null = panorama
  zoomLevel: number | null; // Math.round((VW / view.w) * 10) / 10, for button label "2.4×"
  applyZoom(factor: number, fx: number, fy: number): void;
  panByPixels(dx: number, dy: number, rect: DOMRect): void;
  reset(): void;
  setDims(vw: number, vh: number): void; // called during render phase, see below
  svgRef: Ref<SVGSVGElement>;
  hotZoneRef: Ref<HTMLDivElement>;
};

// useReplayLayout.ts
export type ReplayLayoutMode = "split" | "map" | "gcd";
export function useReplayLayout(): {
  mode: ReplayLayoutMode;
  ratio: number; // split→user value, map→1, gcd→0
  setMode(m: ReplayLayoutMode): void;
  setRatio(r: number): void; // clamped internally
};
export function clampSplitRatio(desired: number): number;
```

`setDims` is an awkward interface intentionally kept: VW/VH has to wait for the `zoneMap` branch to finish calculating, which happens
**after** the early return of `tracks.length === 0`, so the existing code assigns to `dimsRef.current`
during the render phase (`:293`). When extracting the hook, we copy this approach verbatim instead of inventing a "cleaner" solution—that would change behavior.

### 布局落地

一行内联样式,不新增 CSS 规则:

```
split → gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr`
map   → `1fr`   (不渲染 GcdSwimlane)
gcd   → `1fr`   (不渲染 SVG / 框体列 / 缩放浮层)
```

现有 `.rpt-replay-stage.map-only`(`styles.css:2844-2851`)**只有列宽那条被取代**:
`.rpt-replay-stage.map-only { grid-template-columns: 1fr }` 删除(改由内联样式驱动),
但紧随其后的 `.rpt-replay-stage.map-only .rpt-replay-arena-grid`(框体列加宽到 140px、
`max-width: 1100px` 居中)是「纯地图」档的真实视觉行为,**必须保留**,选择器改为跟随
新的 `map` 档 class。整条规则块一起删会静默丢掉纯地图档的加宽与居中。

### 解除 560px 硬顶

删除 `.rpt-replay-field` 的 `max-width: 560px`,改由**容器**界定上限:

- `split` 档:SVG 填满中间列,上限即 grid 中间轨道的宽度(随 ratio 变化)
- `map` 档:沿用既有的 `max-width: 1100px`(减去两侧 140px 框体 → 最大约 820px 方图)

`aspect-ratio` 保证任何宽度下仍是方的,`width: 100%` 保留。这条是"拖宽 = 地图真的变大"
成立的前提,顺带修好「纯地图」档一直没放大地图的问题。

### 持久化

`localStorage["gladlog.replaySplit"] = { mode, ratio }`,沿用现有
`gladlog.replayLayout` 的 try/catch 写法(隐私模式下 localStorage 抛异常)。
旧键值 `"map"` 用 `??` 兜底映射成 `mode: "map"`,不写迁移代码。
读到的 `ratio` 一律过 `clampSplitRatio`,越界或 `NaN` 落回默认。

## 验证

### 自动化

| 目标                              | 断言                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `clampSplitRatio`                 | 低于 0.2、高于 0.8、`NaN`、localStorage 越界值                                  |
| 滚轮判定表                        | 全景态裸滚轮 `defaultPrevented === false`;缩放态裸滚轮改 viewBox;⌘ 滚轮两态都改 |
| 档位渲染                          | `gcd` 档 `[data-testid=rpt-replay-field]` 不在 DOM;`map` 档 GcdSwimlane 不在    |
| 缩放跨档保留                      | 缩放 → 切 `gcd` → 切回 → viewBox 不变                                           |
| 现有 `report.replayzoom.test.tsx` | 两个用例原样保持绿(走 `ctrlKey` 路径)                                           |

`defaultPrevented === false` 是这批里最要紧的一条:"没缩放"和"让页面滚起来了"是两件事。
只断言 viewBox 未变的话,一个"调了 `preventDefault()` 然后什么都不做"的实现也能通过,
而那正是把地图变成滚动黑洞的 bug。

### 测不了的,明说

**拖拽交互本身不写自动化测试。** jsdom 的 `getBoundingClientRect()` 一律返回全零,
像素→比例的换算没有真实 rect 可依。不 mock 假 rect 来制造"测过了"的错觉——那只会
测到 mock 自己。逻辑边界由 `clampSplitRatio` 单测覆盖,交互进手动清单。

### 手动清单(`/run-ui` 测试台)

- 拖分隔条,两侧都不变形,地图不拉伸
- 拖宽地图侧,**地图确实变大**(560px 硬顶已解除),不是留出空白 gutter
- 「纯地图」档下地图明显大于分栏档(此前两者一样大)
- 全景态在地图上滚轮 → 页面正常翻页
- 缩放态在地图上滚轮 → 缩放,页面不动
- SVG 两侧留白处滚轮生效;框体列上滚轮不生效(按设计)
- 三个档位切换,「纯 GCD」下进度条继续走
- 缩放后切「纯 GCD」再切回,视角还在原处

### push 前

`npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`

## 不做

- 分隔条双击复位(用户明确不要)
- 上下分栏、跨设备同步分栏位置
- 自定义 pinch 手势处理——浏览器已把捏合作为带 `ctrlKey` 的 wheel 送达,上面的规则已覆盖
- `ReplayView` 的整体拆分(SVG 场景绘制/框体/时间轴)——该做,但与本次三条抱怨无关
- 接入 C2 视觉回归(`docs/specs` 中的前端质检设计尚未实施)。本次的布局改动是 C2 落地后
  的天然回归目标,届时再补基线

## 设计决策

**档位是 ratio 的预设值,而非独立状态。** 两者并列会产生无法自洽的组合,且需要额外的
同步逻辑;单一状态让"当前布局"永远只有一个真相来源。

**拖拽够不到极端,极端只能点档位。** 让两种控制手段语义不重叠:拖拽=微调,档位=跳极端。
代价是拖到底也不会自动隐藏一侧,但换来的是手滑不会把一侧弄丢。

**缩放后才接管裸滚轮,而非永远接管。** 永远接管最直观、也和多数地图控件一致,但战报是
长滚动页、地图占中间一大块,光标扫过时翻页会卡住。用"是否已进入缩放态"作为意图信号,
两种需求都不牺牲。
