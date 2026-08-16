# Replay Zoom and Split-Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scroll wheel zoom in ReplayView intuitive on Windows mice, expand the zoom hit-target area to cover the entire map column, and allow draggable width distribution between the map and GCD swimlanes.

**Architecture:** Extract four units (two hooks, two components) from the 911-line `ReplayView.tsx`, leaving `ReplayView` for assembly only. Split pane uses a single `ratio` state with three mode presets. Zoom mathematics operates in viewBox units decoupled from pixel width, so dragging does not interfere with zoom. Both sides use fluid layout without requiring any `ResizeObserver`.

**Tech Stack:** React 19 + TypeScript, vitest + jsdom + @testing-library/react, vanilla CSS (`packages/desktop/src/renderer/src/styles.css`).

**Spec:** `docs/specs/2026-07-19-replay-zoom-and-split-design.md`

## Global Constraints

- Class names `.rpt-replay-zoom-btn` and `.rpt-replay-zoom-reset` **must not be renamed** — `packages/desktop/test/report.replayzoom.test.tsx` depends on them.
- `data-testid="rpt-replay-field"` **must not be renamed** — same as above.
- Drag range hard clamped to `[0.2, 0.8]`; default ratio `1/3`.
- Splitter **does not implement** double-click reset.
- Plain scroll wheel in panorama mode (`view === null`) **must not call** `preventDefault()`.
- Wrap all localStorage reads/writes in try/catch (throws in privacy mode), matching `ReplayView.tsx:101-105`.
- Run `npm test --workspace=packages/desktop` before concluding each task; after completing all tasks, run `npm run typecheck && npx eslint packages/desktop/src --quiet`.
- Never use `tsc -b` (emits .js into src).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/desktop/src/renderer/src/report/components/useReplayLayout.ts` | Created. ratio + modes + persistence; exports pure function `clampSplitRatio` |
| `packages/desktop/src/renderer/src/report/components/useReplayLayout.test.ts` | Created. `clampSplitRatio` unit tests |
| `packages/desktop/src/renderer/src/report/components/useReplayZoom.ts` | Created. `view` state, zoom/pan, wheel rules |
| `packages/desktop/src/renderer/src/report/components/ReplayZoomControls.tsx` | Created. Zoom overlay (pure presentation) |
| `packages/desktop/src/renderer/src/report/components/ReplaySplitter.tsx` | Created. Draggable splitter bar |
| `packages/desktop/src/renderer/src/report/components/ReplayView.tsx` | Modified. Assembles above units |
| `packages/desktop/src/renderer/src/styles.css` | Modified. Removes 560px cap, hit-zone wrapper, overlay and splitter styles |
| `packages/desktop/test/report.replaysplit.test.tsx` | Created. Mode rendering + cross-mode state retention |
| `packages/desktop/test/report.replayzoom.test.tsx` | Modified. Added wheel decision table tests |

---

### Task 1: `clampSplitRatio` and `useReplayLayout`

Pure logic + state hook, not yet wired to UI. No UI changes at conclusion of this task.

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/useReplayLayout.ts`
- Test: `packages/desktop/src/renderer/src/report/components/useReplayLayout.test.ts`

**Interfaces:**

- Consumes: None
- Produces:
  - `export type ReplayLayoutMode = "split" | "map" | "gcd"`
  - `export const SPLIT_MIN = 0.2`, `export const SPLIT_MAX = 0.8`, `export const SPLIT_DEFAULT = 1 / 3`
  - `export function clampSplitRatio(desired: number): number`
  - `export function useReplayLayout(): { mode: ReplayLayoutMode; ratio: number; setMode(m: ReplayLayoutMode): void; setRatio(r: number): void }`

- [ ] **Step 1: Write failing test**

Create `packages/desktop/src/renderer/src/report/components/useReplayLayout.test.ts`:

```ts
import {
  clampSplitRatio,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
} from "./useReplayLayout";

describe("clampSplitRatio", () => {
  it("clamps below lower bound to SPLIT_MIN", () => {
    expect(clampSplitRatio(0.05)).toBe(SPLIT_MIN);
    expect(clampSplitRatio(0)).toBe(SPLIT_MIN);
    expect(clampSplitRatio(-3)).toBe(SPLIT_MIN);
  });

  it("clamps above upper bound to SPLIT_MAX", () => {
    expect(clampSplitRatio(0.95)).toBe(SPLIT_MAX);
    expect(clampSplitRatio(1)).toBe(SPLIT_MAX);
    expect(clampSplitRatio(42)).toBe(SPLIT_MAX);
  });

  it("returns in-range values as-is", () => {
    expect(clampSplitRatio(0.5)).toBe(0.5);
    expect(clampSplitRatio(SPLIT_MIN)).toBe(SPLIT_MIN);
    expect(clampSplitRatio(SPLIT_MAX)).toBe(SPLIT_MAX);
  });

  it("falls back to default on non-finite values (corrupted localStorage data)", () => {
    expect(clampSplitRatio(NaN)).toBe(SPLIT_DEFAULT);
    expect(clampSplitRatio(Infinity)).toBe(SPLIT_DEFAULT);
    expect(clampSplitRatio(-Infinity)).toBe(SPLIT_DEFAULT);
    expect(clampSplitRatio(undefined as unknown as number)).toBe(SPLIT_DEFAULT);
  });
});
```

Note the last case: `NaN` takes the "fallback to default" path, not "clamped to lower bound". `Math.min/max` with `NaN` propagates `NaN`, so finiteness must be checked first — which is precisely what this test group locks down.

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/desktop -- src/renderer/src/report/components/useReplayLayout.test.ts`
Expected: FAIL, cannot find module `./useReplayLayout`

- [ ] **Step 3: Implement**

Create `packages/desktop/src/renderer/src/report/components/useReplayLayout.ts`:

```ts
import { useCallback, useState } from "react";

/** Split pane layout modes. ratio is their preset value, not a parallel state. */
export type ReplayLayoutMode = "split" | "map" | "gcd";

/** Draggable range for map ratio. Extreme edges cannot be reached via drag — only via mode buttons. */
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
/** Default 1/3, representing pre-refactor hardcoded 1fr 2fr. */
export const SPLIT_DEFAULT = 1 / 3;

const STORAGE_KEY = "gladlog.replaySplit";

/** Clamp to [SPLIT_MIN, SPLIT_MAX]; non-finite values (corrupted localStorage data) fall back to default. */
export function clampSplitRatio(desired: number): number {
  if (!Number.isFinite(desired)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, desired));
}

interface Persisted {
  mode: ReplayLayoutMode;
  ratio: number;
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      const mode =
        p.mode === "map" || p.mode === "gcd" || p.mode === "split"
          ? p.mode
          : "split";
      return { mode, ratio: clampSplitRatio(p.ratio as number) };
    }
    // Legacy key migration: gladlog.replayLayout previously stored "map" / "full"
    const legacy = localStorage.getItem("gladlog.replayLayout");
    return {
      mode: legacy === "map" ? "map" : "split",
      ratio: SPLIT_DEFAULT,
    };
  } catch {
    /* Privacy mode, etc. */
  }
  return { mode: "split", ratio: SPLIT_DEFAULT };
}

function persist(next: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Privacy mode, etc. */
  }
}

export function useReplayLayout(): {
  mode: ReplayLayoutMode;
  ratio: number;
  setMode(m: ReplayLayoutMode): void;
  setRatio(r: number): void;
} {
  const [state, setState] = useState<Persisted>(readPersisted);

  const setMode = useCallback((mode: ReplayLayoutMode) => {
    setState((prev) => {
      const next = { ...prev, mode };
      persist(next);
      return next;
    });
  }, []);

  const setRatio = useCallback((r: number) => {
    setState((prev) => {
      const next = { ...prev, ratio: clampSplitRatio(r) };
      persist(next);
      return next;
    });
  }, []);

  // Effective ratio: extreme modes ignore user-dragged value
  const ratio =
    state.mode === "map" ? 1 : state.mode === "gcd" ? 0 : state.ratio;

  return { mode: state.mode, ratio, setMode, setRatio };
}
```

`state.ratio` always retains "the intermediate value dragged by the user"; exposed `ratio` is overridden to 1/0 in extreme modes. Thus switching from "Map Only" back to "Map + GCD" preserves the user's previously dragged ratio.

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test --workspace=packages/desktop -- src/renderer/src/report/components/useReplayLayout.test.ts`
Expected: PASS, 4 cases

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/useReplayLayout.ts \
        packages/desktop/src/renderer/src/report/components/useReplayLayout.test.ts
git commit -m "feat(replay): split ratio state and clampSplitRatio"
```

---

### Task 2: Extract `useReplayZoom` and Hit-Zone Wrapper (Zero Behavioral Changes)

Move existing zoom logic as-is into hook, and introduce wrapper element for wheel event listener. **Evaluation rules remain identical** (still "must hold ⌘/Ctrl"); the two existing zoom tests must stay green throughout.

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/useReplayZoom.ts`
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx:117-158` (remove, call hook instead), `:293` (change to `zoom.setDims(VW, VH)`), `:317-350` (wrap with wrapper div, point ref and events to hook), `:701` (close `</div>`), `:869-893` (buttons invoke hook)
- Modify: `packages/desktop/src/renderer/src/styles.css:742-744` (move `grid-column` to wrapper)

**Interfaces:**

- Consumes: None
- Produces:

  ```ts
  export interface ReplayViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  export function useReplayZoom(): {
    view: ReplayViewBox | null;
    zoomLevel: number | null;
    applyZoom(factor: number, fx: number, fy: number): void;
    panByPixels(dx: number, dy: number, rect: DOMRect): void;
    reset(): void;
    setDims(vw: number, vh: number): void;
    svgRef: React.RefObject<SVGSVGElement | null>;
    /** Callback ref: attaches wheel listener when mounted, removes on unmount. Not RefObject. */
    hotZoneRef: (el: HTMLDivElement | null) => void;
  };
  ```

Wheel listener belongs to hook per spec (not kept in `ReplayView`), using **callback ref** rather than `RefObject` + `useEffect`. Two reasons:

1. Original implementation's `useEffect(..., [applyZoom, tracks.length])` dependency on `tracks.length` was a workaround — it only existed because empty `tracks` triggered early return keeping ref null, using the dependency to rerun once data arrived. Callback ref naturally fires on element mount/unmount without this hack.
2. Hook returns a new object on every render; placing `zoom` into dependency array would attach/detach listener on every render.

Evaluation table needs to read current `view`, but listener should not reattach on `view` changes, so hook uses `viewRef.current = view` during render phase (matching `dimsRef` and `ReplayView.tsx:109`'s `lastTRef.current = t` pattern).

- [ ] **Step 1: Run existing tests to verify green baseline**

Run: `npm test --workspace=packages/desktop -- test/report.replayzoom.test.tsx`
Expected: PASS, 2 cases.

- [ ] **Step 2: Write hook**

Create `packages/desktop/src/renderer/src/report/components/useReplayZoom.ts`:

```tsx
import { useCallback, useRef, useState } from "react";

export interface ReplayViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FALLBACK_VW = 520;
const FALLBACK_VH = 520;
/** Zoom in up to 1/5 of full view. */
const MAX_ZOOM_DIVISOR = 5;

/**
 * Replay map zoom/pan. All math operates in viewBox units, independent of pixel width —
 * so dragging split pane does not perturb zoom state.
 */
export function useReplayZoom() {
  const [view, setView] = useState<ReplayViewBox | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // VW/VH calculation completes after tracks.length === 0 early return;
  // consumer writes it during render phase matching original implementation.
  const dimsRef = useRef({ vw: FALLBACK_VW, vh: FALLBACK_VH });
  // Wheel evaluation reads current view, but listener should not reattach on view changes — sync into ref during render.
  const viewRef = useRef<ReplayViewBox | null>(null);
  viewRef.current = view;
  const detachRef = useRef<(() => void) | null>(null);

  const setDims = useCallback((vw: number, vh: number) => {
    dimsRef.current = { vw, vh };
  }, []);

  const applyZoom = useCallback((factor: number, fx: number, fy: number) => {
    const { vw, vh } = dimsRef.current;
    setView((cur0) => {
      const cur = cur0 ?? { x: 0, y: 0, w: vw, h: vh };
      const w = Math.min(vw, Math.max(vw / MAX_ZOOM_DIVISOR, cur.w * factor));
      const h = (w / vw) * vh;
      let x = cur.x + fx * (cur.w - w);
      let y = cur.y + fy * (cur.h - h);
      x = Math.min(Math.max(0, x), vw - w);
      y = Math.min(Math.max(0, y), vh - h);
      return w >= vw ? null : { x, y, w, h };
    });
  }, []);

  const panByPixels = useCallback((dx: number, dy: number, rect: DOMRect) => {
    const { vw, vh } = dimsRef.current;
    setView((cur) => {
      if (!cur) return cur;
      const mx = (dx / rect.width) * cur.w;
      const my = (dy / rect.height) * cur.h;
      return {
        ...cur,
        x: Math.min(Math.max(0, cur.x - mx), vw - cur.w),
        y: Math.min(Math.max(0, cur.y - my), vh - cur.h),
      };
    });
  }, []);

  const reset = useCallback(() => setView(null), []);

  // Callback ref: attaches listener on mount, removes on unmount.
  // Maintains original rule (requires ⌘/Ctrl); modified in Task 3.
  const hotZoneRef = useCallback(
    (el: HTMLDivElement | null) => {
      detachRef.current?.();
      detachRef.current = null;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        applyZoom(
          e.deltaY > 0 ? 1.25 : 0.8,
          (e.clientX - rect.left) / rect.width,
          (e.clientY - rect.top) / rect.height,
        );
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      detachRef.current = () => el.removeEventListener("wheel", onWheel);
    },
    [applyZoom],
  );

  const zoomLevel = view
    ? Math.round((dimsRef.current.vw / view.w) * 10) / 10
    : null;

  return {
    view,
    zoomLevel,
    applyZoom,
    panByPixels,
    reset,
    setDims,
    svgRef,
    hotZoneRef,
  };
}
```

- [ ] **Step 3: Wire into `ReplayView`**

Remove `ReplayView.tsx:117-158` (`view` state, `panRef`, `svgRef`, `dimsRef`, `applyZoom`, wheel `useEffect`), replace in place with:

```tsx
const zoom = useReplayZoom();
const { view } = zoom;
const panRef = useRef<{ px: number; py: number } | null>(null);
```

Add import at top:

```tsx
import { useReplayZoom } from "./useReplayZoom";
```

Change `:293` `dimsRef.current = { vw: VW, vh: VH };` to:

```tsx
zoom.setDims(VW, VH);
```

Remove entire wheel `useEffect` block.
Wrap `<svg>` (from `:317`) with div wrapper:

```tsx
<div className="rpt-replay-arena-grid">
  <div className="rpt-replay-map-cell" ref={zoom.hotZoneRef}>
    <svg ref={zoom.svgRef} ... >
```

Add closing `</div>` after `</svg>` (`:701`). **Side frames (`:703-781`) must remain outside wrapper**, staying direct children of arena-grid to occupy columns 1 and 3.

Move `grid-column` from svg to wrapper in `styles.css:742-744`:

```css
.rpt-replay-arena-grid > .rpt-replay-map-cell {
  grid-column: 2;
  min-width: 0;
}
```

(Remove legacy `.rpt-replay-arena-grid > svg { grid-column: 2; }`.)

On SVG element: change `ref={svgRef}` to `ref={zoom.svgRef}`; `onDoubleClick={() => setView(null)}` to `onDoubleClick={zoom.reset}`; update `onPointerMove`:

```tsx
onPointerMove={(e) => {
  if (!view || !panRef.current) return;
  const rect = e.currentTarget.getBoundingClientRect();
  zoom.panByPixels(
    e.clientX - panRef.current.px,
    e.clientY - panRef.current.py,
    rect,
  );
  panRef.current = { px: e.clientX, py: e.clientY };
}}
```

Update three buttons in `:869-893`: `onClick={() => applyZoom(...)}` to `zoom.applyZoom(...)`, `onClick={() => setView(null)}` to `zoom.reset`, and label calculation to use `zoom.zoomLevel`.

- [ ] **Step 4: Run tests to verify identical behavior with Step 1**

Run: `npm test --workspace=packages/desktop -- test/report.replayzoom.test.tsx`
Expected: PASS, 2 cases

Run full workspace tests:
Run: `npm test --workspace=packages/desktop`
Expected: 57 files / 264 tests all green

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/useReplayZoom.ts \
        packages/desktop/src/renderer/src/report/components/ReplayView.tsx
git commit -m "refactor(replay): extract zoom logic to useReplayZoom (zero behavioral changes)"
```

---

### Task 3: Wheel Evaluation Table

Wrapper and hit-zone are already mounted from Task 2. This task **only updates evaluation rules**.

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/useReplayZoom.ts` (guard in `hotZoneRef`)
- Modify: `packages/desktop/test/report.replayzoom.test.tsx` (append cases)

**Interfaces:**

- Consumes: Task 2 `useReplayZoom`
- Produces: No new exports (`hotZoneRef` signature unchanged)

- [ ] **Step 1: Write failing test**

Append to end of `packages/desktop/test/report.replayzoom.test.tsx`:

```tsx
describe("wheel evaluation table (accessible on Windows mouse)", () => {
  it("plain wheel in panorama mode is not intercepted, leaves page scrolling intact", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const before = svg.getAttribute("viewBox")!;
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    svg.dispatchEvent(ev);
    expect(svg.getAttribute("viewBox")).toBe(before);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("plain wheel in zoomed state takes over zooming", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const panorama = svg.getAttribute("viewBox")!;
    // Enter zoom mode with ⌘
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      metaKey: true,
    });
    const zoomed = svg.getAttribute("viewBox")!;
    expect(zoomed).not.toBe(panorama);
    // Plain wheel continues zooming and consumes event
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    svg.dispatchEvent(ev);
    expect(svg.getAttribute("viewBox")).not.toBe(zoomed);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("hit zone covers SVG side gutters (wheel on wrapper also takes effect)", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const cell = container.querySelector(".rpt-replay-map-cell")!;
    const before = svg.getAttribute("viewBox")!;
    fireEvent.wheel(cell, {
      deltaY: -100,
      clientX: 10,
      clientY: 10,
      metaKey: true,
    });
    expect(svg.getAttribute("viewBox")).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/desktop -- test/report.replayzoom.test.tsx`
Expected: First two new cases FAIL, third PASS (wrapper ready from Task 2)

- [ ] **Step 3: Update evaluation rules**

Modify guard line in `hotZoneRef` within `useReplayZoom.ts`:

```tsx
// Plain wheel in panorama mode is left to page scroll — must return as-is without touching preventDefault.
// Zoomed state = explicit "user is inspecting map", take over zooming.
if (!e.ctrlKey && !e.metaKey && !viewRef.current) return;
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test --workspace=packages/desktop -- test/report.replayzoom.test.tsx`
Expected: PASS, 5 cases (2 original + 3 new)

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/ReplayView.tsx \
        packages/desktop/src/renderer/src/styles.css \
        packages/desktop/test/report.replayzoom.test.tsx
git commit -m "feat(replay): take over plain wheel in zoomed state, expand hit-zone to map column"
```

---

### Task 4: Float Zoom Controls to Bottom-Right of Map

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/ReplayZoomControls.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx` (remove `:868-893`, mount overlay in `.rpt-replay-map-cell`)
- Modify: `packages/desktop/src/renderer/src/styles.css`

**Interfaces:**

- Consumes: Task 2 `useReplayZoom` (`zoomLevel`, `applyZoom`, `reset`)
- Produces: `export function ReplayZoomControls(props: { zoomLevel: number | null; onZoomIn(): void; onZoomOut(): void; onReset(): void }): JSX.Element`

- [ ] **Step 1: Write component**

Create `packages/desktop/src/renderer/src/report/components/ReplayZoomControls.tsx`:

```tsx
/**
 * Zoom controls overlay in bottom-right of map. Class names contract with report.replayzoom.test.tsx, do not rename.
 */
export function ReplayZoomControls(props: {
  zoomLevel: number | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <span className="rpt-replay-zoom-group">
      <button
        className="rpt-replay-zoom-btn"
        title="Zoom In (or ⌘/Ctrl+wheel; once zoomed, plain wheel continues zoom, drag to pan)"
        onClick={props.onZoomIn}
      >
        +
      </button>
      <button
        className="rpt-replay-zoom-btn"
        title="Zoom Out"
        onClick={props.onZoomOut}
      >
        −
      </button>
      {props.zoomLevel != null && (
        <button
          className="rpt-replay-zoom-reset"
          title="Reset Zoom (or double-click map)"
          onClick={props.onReset}
        >
          ⤢ {props.zoomLevel}× Reset
        </button>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Wire into ReplayView**

Import in `ReplayView.tsx`:

```tsx
import { ReplayZoomControls } from "./ReplayZoomControls";
```

Remove `:868-893` (`<span className="rpt-replay-divider" />` and `rpt-replay-zoom-group`). Place overlay inside `.rpt-replay-map-cell` after `</svg>`:

```tsx
    </svg>
    <ReplayZoomControls
      zoomLevel={zoom.zoomLevel}
      onZoomIn={() => zoom.applyZoom(0.8, 0.5, 0.5)}
      onZoomOut={() => zoom.applyZoom(1.25, 0.5, 0.5)}
      onReset={zoom.reset}
    />
  </div>
```

In `styles.css`:

```css
.rpt-replay-arena-grid > .rpt-replay-map-cell {
  grid-column: 2;
  min-width: 0;
  position: relative;
}
.rpt-replay-map-cell .rpt-replay-zoom-group {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border: 1px solid var(--hairline);
}
```

- [ ] **Step 3: Run tests**

Run: `npm test --workspace=packages/desktop`
Expected: All green.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/ReplayZoomControls.tsx \
        packages/desktop/src/renderer/src/report/components/ReplayView.tsx \
        packages/desktop/src/renderer/src/styles.css
git commit -m "feat(replay): float zoom controls to bottom-right of map"
```

---

### Task 5: Three Layout Modes and Removal of 560px Hard Cap

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx` (remove `:89-106` legacy layout state, `:299-314` modes and stage, `:785` GcdSwimlane gating)
- Modify: `packages/desktop/src/renderer/src/styles.css:653-656`, `:914-920`, `:2844-2851`
- Test: `packages/desktop/test/report.replaysplit.test.tsx` (create)

**Interfaces:**

- Consumes: Task 1 `useReplayLayout`, Task 2 `useReplayZoom`
- Produces: No new exports

- [ ] **Step 1: Write failing test**

Create `packages/desktop/test/report.replaysplit.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";

import { ReplayView } from "../src/renderer/src/report/components/ReplayView";
import { loadRealMatchFixture } from "./fixtures/loadFixture";

const m = loadRealMatchFixture();

function modeButton(container: HTMLElement, label: string): HTMLElement {
  const btn = Array.from(
    container.querySelectorAll(".rpt-replay-layout-seg button"),
  ).find((b) => b.textContent === label);
  if (!btn) throw new Error(`Mode button not found: ${label}`);
  return btn as HTMLElement;
}

describe("replay three layout modes", () => {
  it("GCD only mode does not render map or zoom overlay", () => {
    const { container } = render(<ReplayView source={m} />);
    expect(
      container.querySelector("[data-testid=rpt-replay-field]"),
    ).toBeTruthy();
    fireEvent.click(modeButton(container, "GCD Only"));
    expect(
      container.querySelector("[data-testid=rpt-replay-field]"),
    ).toBeNull();
    expect(container.querySelector(".rpt-replay-zoom-group")).toBeNull();
    expect(
      container.querySelector("[data-testid=rpt-frames-friendly]"),
    ).toBeNull();
  });

  it("map only mode does not render GCD swimlanes", () => {
    const { container } = render(<ReplayView source={m} />);
    fireEvent.click(modeButton(container, "Map Only"));
    expect(container.querySelector(".rpt-gcd")).toBeNull();
    expect(
      container.querySelector("[data-testid=rpt-replay-field]"),
    ).toBeTruthy();
  });

  it("zoom state preserved across modes — switching away and back retains viewport", () => {
    const { container } = render(<ReplayView source={m} />);
    const svg = container.querySelector("[data-testid=rpt-replay-field]")!;
    const panorama = svg.getAttribute("viewBox")!;
    fireEvent.wheel(svg, {
      deltaY: -100,
      clientX: 100,
      clientY: 100,
      metaKey: true,
    });
    const zoomed = svg.getAttribute("viewBox")!;
    expect(zoomed).not.toBe(panorama);

    fireEvent.click(modeButton(container, "GCD Only"));
    fireEvent.click(modeButton(container, "Map + GCD"));

    const svg2 = container.querySelector("[data-testid=rpt-replay-field]")!;
    expect(svg2.getAttribute("viewBox")).toBe(zoomed);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test --workspace=packages/desktop -- test/report.replaysplit.test.tsx`
Expected: FAIL, `Mode button not found: GCD Only`

- [ ] **Step 3: Modify `ReplayView`**

Remove `:89-106` (`layout` state and `switchLayout`), replace with:

```tsx
const { mode, ratio, setMode, setRatio } = useReplayLayout();
```

Add import:

```tsx
import { useReplayLayout, type ReplayLayoutMode } from "./useReplayLayout";
```

Define mode table at module top-level:

```tsx
const LAYOUT_MODES: readonly (readonly [ReplayLayoutMode, string])[] = [
  ["split", "Map + GCD"],
  ["map", "Map Only"],
  ["gcd", "GCD Only"],
];
```

Update mode buttons (`:299-309`):

```tsx
<div className="rpt-replay-layout-seg rpt-mode-seg">
  {LAYOUT_MODES.map(([value, label]) => (
    <button
      key={value}
      className={mode === value ? "active" : ""}
      onClick={() => setMode(value)}
    >
      {label}
    </button>
  ))}
</div>
```

Update stage (`:310-314`) to inline column widths:

```tsx
<div
  className={`rpt-replay-stage mode-${mode}`}
  ref={stageRef}
  style={{
    gridTemplateColumns:
      mode === "split" ? `${ratio}fr 6px ${1 - ratio}fr` : "1fr",
  }}
>
```

Declare `stageRef` at top of component:

```tsx
const stageRef = useRef<HTMLDivElement | null>(null);
```

Gate map column (`:315` `.rpt-replay-arena-col`) with `mode !== "gcd"`:

```tsx
{
  mode !== "gcd" && <div className="rpt-replay-arena-col">...</div>;
}
```

Update GcdSwimlane gate (`:785`) from `layout === "full"` to `mode !== "map"`.

- [ ] **Step 4: Update CSS**

In `styles.css:653-656`, remove `max-width`:

```css
.rpt-replay-field {
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 8px;
}
```

In `styles.css:914-920`, delegate column widths to inline style:

```css
.rpt-replay-stage {
  display: grid;
  gap: 8px;
  align-items: start;
  width: 100%;
}
```

In `styles.css:2844-2851`:

```css
/* Map Only mode: wider frame + centered layout (column widths defined by inline style) */
.rpt-replay-stage.mode-map .rpt-replay-arena-grid {
  grid-template-columns: 140px minmax(0, 1fr) 140px;
  max-width: 1100px;
  margin: 0 auto;
}
```

(Change `.map-only` selectors to `.mode-map`.)

- [ ] **Step 5: Run tests to confirm pass**

Run: `npm test --workspace=packages/desktop -- test/report.replaysplit.test.tsx`
Expected: PASS, 3 cases

Run full tests:
Run: `npm test --workspace=packages/desktop`
Expected: All green

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/ReplayView.tsx \
        packages/desktop/src/renderer/src/styles.css \
        packages/desktop/test/report.replaysplit.test.tsx
git commit -m "feat(replay): three layout modes (add GCD Only), remove 560px map cap"
```

---

### Task 6: Draggable Splitter Bar

**Files:**

- Create: `packages/desktop/src/renderer/src/report/components/ReplaySplitter.tsx`
- Modify: `packages/desktop/src/renderer/src/report/components/ReplayView.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css`

**Interfaces:**

- Consumes: Task 1 `setRatio`, Task 5 `stageRef`
- Produces: `export function ReplaySplitter(props: { onRatioChange(r: number): void; stageRef: React.RefObject<HTMLDivElement | null> }): JSX.Element`

- [ ] **Step 1: Write component**

Create `packages/desktop/src/renderer/src/report/components/ReplaySplitter.tsx`:

```tsx
import { useCallback, useRef } from "react";

/**
 * Draggable splitter bar between Map and GCD. Ratio calculated from actual stage width,
 * clamped inside useReplayLayout.
 */
export function ReplaySplitter(props: {
  onRatioChange: (r: number) => void;
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const draggingRef = useRef(false);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const stage = props.stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return;
      props.onRatioChange((e.clientX - rect.left) / rect.width);
    },
    [props],
  );

  return (
    <div
      className="rpt-replay-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Adjust width between Map and GCD swimlanes"
      onPointerDown={(e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    />
  );
}
```

- [ ] **Step 2: Wire into ReplayView**

Import in `ReplayView.tsx`:

```tsx
import { ReplaySplitter } from "./ReplaySplitter";
```

Insert between map column and GcdSwimlane inside stage (renders only in `split` mode):

```tsx
{
  mode === "split" && (
    <ReplaySplitter onRatioChange={setRatio} stageRef={stageRef} />
  );
}
```

Add in `styles.css`:

```css
.rpt-replay-splitter {
  cursor: col-resize;
  background: var(--hairline);
  border-radius: 3px;
  align-self: stretch;
  touch-action: none;
}
.rpt-replay-splitter:hover {
  background: var(--accent-line);
}
```

- [ ] **Step 3: Run tests**

Run: `npm test --workspace=packages/desktop`
Expected: All green

- [ ] **Step 4: Full Gate**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
```

Expected: Tests all green, typecheck clean, eslint clean

- [ ] **Step 5: Manual verification (`/run-ui` testbench)**

- Drag splitter bar: both sides resize smoothly without distortion or map stretching.
- Drag map wider: map genuinely expands (560px cap removed), without leaving blank gutters.
- In "Map Only" mode, map is noticeably larger than in split mode.
- Plain scroll on map in panorama mode scrolls page normally.
- Scroll on map in zoomed mode zooms map without moving page.
- Wheel on SVG side gutters triggers zoom; wheel on unit frames does not.
- Mode switching works smoothly, progress bar continues in "GCD Only".
- Zoom map, switch to "GCD Only" and back: viewport preserved.
- Clamping holds at [0.2, 0.8] without collapsing either side.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/src/report/components/ReplaySplitter.tsx \
        packages/desktop/src/renderer/src/report/components/ReplayView.tsx \
        packages/desktop/src/renderer/src/styles.css
git commit -m "feat(replay): draggable splitter bar between map and GCD swimlanes"
```
