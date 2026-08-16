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

### Layout Implementation

A single line of inline style, no new CSS rules:

```
split → gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr`
map   → `1fr`   (do not render GcdSwimlane)
gcd   → `1fr`   (do not render SVG / frame columns / zoom overlay)
```

For the existing `.rpt-replay-stage.map-only` (`styles.css:2844-2851`), **only the column width rule is replaced**:
`.rpt-replay-stage.map-only { grid-template-columns: 1fr }` is deleted (driven by inline styles instead),
but the subsequent `.rpt-replay-stage.map-only .rpt-replay-arena-grid` (frames widened to 140px,
`max-width: 1100px` centered) represents the true visual behavior of the "Map Only" mode and **must be preserved**; its selector will be updated to follow
the new `map` mode class. Deleting the whole rule block together would silently drop the widening and centering of the Map Only mode.

### Lifting the 560px Hard Cap

Delete `max-width: 560px` from `.rpt-replay-field`, and let the **container** define the upper limit instead:

- `split` mode: SVG fills the middle column, the upper limit is the width of the grid's middle track (varies with ratio)
- `map` mode: continue using the existing `max-width: 1100px` (minus 140px frames on both sides → max ~820px square map)

`aspect-ratio` ensures it remains square at any width; `width: 100%` is preserved. This is the prerequisite for "dragging wider = map actually gets larger"
to hold true, and incidentally fixes the issue where the "Map Only" mode never enlarged the map.

### Persistence

`localStorage["gladlog.replaySplit"] = { mode, ratio }`, continuing the existing
try/catch pattern from `gladlog.replayLayout` (localStorage throws exceptions in privacy mode).
The old key value `"map"` is mapped using `??` fallback to `mode: "map"`, without writing migration code.
The read `ratio` always passes through `clampSplitRatio`; if out-of-bounds or `NaN`, it falls back to default.

## Verification

### Automated Tests

| Target                            | Assertion                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `clampSplitRatio`                 | Below 0.2, above 0.8, `NaN`, out-of-bounds localStorage values                  |
| Scroll wheel decision table       | Bare scroll in panorama `defaultPrevented === false`; bare scroll in zoomed state changes viewBox; ⌘ scroll changes both |
| Mode rendering                    | `gcd` mode `[data-testid=rpt-replay-field]` is not in DOM; `map` mode GcdSwimlane is not present |
| Zoom preservation across modes    | Zoom → switch to `gcd` → switch back → viewBox remains unchanged                |
| Existing `report.replayzoom.test.tsx` | Two test cases stay green as-is (taking the `ctrlKey` path)                     |

`defaultPrevented === false` is the most critical item in this batch: "not zooming" and "letting the page scroll" are two different things.
If we only asserted that viewBox didn't change, an implementation that "called `preventDefault()` and did nothing" would pass,
which is exactly the bug that turns the map into a scrolling black hole.

### State explicitly what cannot be tested

**The dragging interaction itself will not have automated tests.** jsdom's `getBoundingClientRect()` always returns all zeros,
so pixel→ratio conversions have no real rect to rely on. We won't mock fake rects to create the illusion of "having tested it"—that would only
test the mock itself. Logical boundaries are covered by `clampSplitRatio` unit tests; interactions go into the manual checklist.

### Manual Checklist (`/run-ui` testbed)

- Drag the splitter: neither side deforms, map does not stretch
- Drag map side wider: **map actually gets larger** (560px hard cap lifted), doesn't just leave blank gutters
- "Map Only" mode: map is noticeably larger than in split mode (previously they were the same size)
- Panorama state, scroll on map → page scrolls normally
- Zoomed state, scroll on map → zoom, page doesn't move
- Scroll wheel works in empty space on both sides of the SVG; scroll wheel doesn't work on frame columns (by design)
- Switch between three modes: in "GCD Only", the progress bar continues to tick
- Zoom, switch to "GCD Only", switch back: the perspective is still at the original place

### Before push

`npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`

## What we will NOT do

- Splitter double-click to reset (user explicitly doesn't want it)
- Top/bottom splitting, cross-device sync of splitter position
- Custom pinch gesture handling — the browser already delivers pinches as wheel events with `ctrlKey`, covered by the rules above
- Complete teardown of `ReplayView` (SVG scene rendering/frames/timeline) — should be done, but unrelated to the three complaints this time
- Integration with C2 visual regression testing (frontend QA design in `docs/specs` not yet implemented). The layout changes this time will be a natural regression target
  after C2 lands; we'll backfill the baseline then

## Design Decisions

**Modes are preset values for ratio, not independent states.** Having both side-by-side creates inconsistent combinations and requires extra
sync logic; a single state ensures "current layout" always has a single source of truth.

**Dragging cannot reach extremes, extremes are only accessible via mode buttons.** Ensuring the semantics of the two control methods don't overlap: dragging = fine-tuning, mode buttons = jumping to extremes.
The trade-off is that dragging all the way won't automatically hide one side, but we gain the assurance that a slip of the hand won't make a side disappear.

**Take over bare scroll wheel only after zooming, not forever.** Taking over forever is most intuitive and consistent with most map controls, but reports are
long scrollable pages, and the map takes up a huge chunk in the middle; page scrolling would get stuck as the cursor sweeps across. Using "whether it has entered zoomed state" as an intent signal
sacrifices neither requirement.
