# Frontend QA System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a layered QA tower for the gladlog frontend—visual regression, accessibility, E2E core flows, performance budgets—where "passing" at each layer is a machine-verifiable assertion.

**Architecture:** One Playwright dependency covers three layers: the `visual` project drives the existing `dev:ui` pure-browser testbed (screenshots + axe + first paint timing), the `e2e` project uses `_electron.launch()` to drive the `electron-vite build` artifact (three core flows + cold start). Parsing budgets are regular vitest tests in the parser package. Screenshot baselines only have one linux set, generated and evaluated by CI (no local container runtime, 2026-07-19 resolution).

**Tech Stack:** Playwright (`@playwright/test`), `@axe-core/playwright`, vitest, React 19, Electron 38, TypeScript (ESM, `moduleResolution: bundler`).

Design spec: `docs/superpowers/specs/2026-07-19-frontend-qa-design.md`

## Global Constraints

- Type checking strictly uses `npm run typecheck` (= `tsc --noEmit`). **Never `tsc -b`** — it spits `.js` into `src`, polluting the tree.
- Before committing each task's final step: `npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet`. CI's tsc covers test files and includes a standalone Lint step.
- **Predicates as specification**: Analysis code and verification gates must share the exact same predicates for identical facts — same constants, same functions, exported in one place and imported on both sides. In this plan, this specifically applies to `PROMPT_VERSION` (Task 11) and the three budget constants (Task 15).
- Screenshot baselines have **only one linux set**, generated and judged by CI (ubuntu-latest); local machines only run `test:visual:smoke` (with `--ignore-snapshots`, writing no baselines). The Playwright config **must NOT** add `{platform}` to `snapshotPathTemplate` — adding it allows secondary standards.
- All new QA code goes into `packages/desktop/qa/`, not mixed into vitest's `test/`. Vitest must explicitly exclude `qa/**` (default include absorbs `*.spec.ts`, handled in Task 4).
- Performance budgets follow **measure-then-lock**: first measure and log `[budget]` lines, locking constants only after collecting real CI numbers (Task 15). Never write arbitrary numbers at any step.
- New npm dependencies are installed only to the `packages/desktop` workspace (`npm i -D -w @gladlog/desktop ...`), keeping the root clean.

---

## File Structure

New files:

```
packages/desktop/
  dev/
    scenes.ts              # Scene name parsing (pure function, unit-testable)
    scenes.test.ts         # Unit tests for scenes.ts
    fixtures/appShell.ts   # Deterministic metas / notebook fixture for app-shell scenes
  qa/
    playwright.config.ts   # visual + e2e projects
    axe-allowlist.ts       # Accessibility exemption list (rule id + selector + justification)
    budgets.ts             # Three performance budget constants (locked in Task 15)
    support/seedAnalysis.ts# E2E: writes canned analysis results into cache files
    visual/scenes.spec.ts  # 7 scene screenshots + axe
    visual/firstPaint.spec.ts # Report first paint timing
    e2e/import.spec.ts     # Journey 1 import -> report + cold start timing
    e2e/evidence.spec.ts   # Journey 2 finding -> evidence chain
    e2e/coachLoop.spec.ts  # Journey 3 coach loop + restart persistence
    __screenshots__/       # Linux baselines (committed to repository)
packages/desktop/src/main/e2eEnv.ts       # GLADLOG_E2E userData redirection (pure function)
packages/desktop/src/main/e2eEnv.test.ts
packages/desktop/src/shared/promptVersion.ts # PROMPT_VERSION single source (Task 11)
packages/parser/src/testing/synthLog.ts   # Deterministic synthetic combat log generator
packages/parser/test/synthLog.test.ts
packages/parser/test/parseBudget.test.ts  # Parsing duration budget
```

Modified files:

```
packages/desktop/dev/main.tsx        # Scene routing branches
packages/desktop/dev/harness.css     # Hide toolbar in scene mode
packages/desktop/src/renderer/src/report/components/MatchReport.tsx  # initialView prop
packages/desktop/src/main/index.ts   # Wire e2eEnv at top
packages/desktop/src/main/ai.ts      # PROMPT_VERSION changed to re-export
packages/desktop/tsconfig.json       # include adds dev, qa
packages/desktop/vitest.config.ts    # exclude qa/**
packages/desktop/package.json        # test:visual / test:visual:update / test:e2e
.github/workflows/test.yml           # frontend-qa job
```

---

# Phase 1 — dev:ui Scenario Routing + Visual Regression + axe

## Task 1: MatchReport Supports initialView

The report's three views are component-internal state and cannot be directly reached externally. Add an optional prop so URLs like `?scene=report-replay` deterministically land on a specific view (also the foundation for future deep-linking).

**Files:**

- Modify: `packages/desktop/src/renderer/src/report/components/MatchReport.tsx:29-39`
- Test: `packages/desktop/src/renderer/src/report/components/MatchReport.initialView.test.tsx`

**Interfaces:**

- Consumes: None (first task)
- Produces: `MatchReport` adds optional prop `initialView?: "report" | "replay" | "ai"`, default `"report"`. Task 2 scene table relies on it.

- [ ] **Step 1: Write failing test**

Create `packages/desktop/src/renderer/src/report/components/MatchReport.initialView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import fixture from "../../../../../test/fixtures/report-match.json";
import type { ReportSource } from "../derive/types";
import { MatchReport } from "./MatchReport";

const source = fixture as unknown as ReportSource;

describe("MatchReport initialView", () => {
  it("defaults to opening report view", () => {
    render(<MatchReport source={source} matchId="m1" />);
    expect(
      screen.getByRole("button", { name: "Report" }).className.split(" "),
    ).toContain("active");
  });

  it("initialView=replay opens replay view directly", () => {
    render(<MatchReport source={source} matchId="m1" initialView="replay" />);
    expect(
      screen.getByRole("button", { name: "Replay" }).className.split(" "),
    ).toContain("active");
    expect(
      screen.getByRole("button", { name: "Report" }).className.split(" "),
    ).not.toContain("active");
  });

  it("initialView=ai opens AI view directly", () => {
    render(<MatchReport source={source} matchId="m1" initialView="ai" />);
    expect(
      screen.getByRole("button", { name: "AI Analysis" }).className.split(" "),
    ).toContain("active");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm test --workspace=packages/desktop -- MatchReport.initialView
```

Expected: FAIL — `initialView=replay` assertion fails (stays on "Report"), because prop does not exist yet.

- [ ] **Step 3: Minimal implementation**

Update signature and state initialization in `MatchReport.tsx`:

```tsx
export function MatchReport({
  source,
  roundLabel,
  matchId,
  initialView = "report",
}: {
  source: ReportSource;
  roundLabel?: string;
  matchId?: string;
  initialView?: View;
}) {
  const [mode, setMode] = useState<MeterMode>("damage");
  const [view, setView] = useState<View>(initialView);
```

- [ ] **Step 4: Run test to verify success**

```bash
npm test --workspace=packages/desktop -- MatchReport.initialView
```

Expected: PASS (3 passed)

- [ ] **Step 5: Full verification + Commit**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
git add packages/desktop/src/renderer/src/report/components/MatchReport.tsx packages/desktop/src/renderer/src/report/components/MatchReport.initialView.test.tsx
git commit -m "feat(report): MatchReport supports initialView — views reachable via URL"
```

---

## Task 2: dev:ui Scenario Routing (4 Report Scenarios)

Add `?scene=` parameter to the testbed: URLs navigate directly to deterministic states without clicking dropdowns/tabs. In scene mode, the toolbar is hidden so screenshots contain only the UI under test.

**Files:**

- Create: `packages/desktop/dev/scenes.ts`
- Create: `packages/desktop/dev/scenes.test.ts`
- Modify: `packages/desktop/dev/main.tsx`
- Modify: `packages/desktop/dev/harness.css`
- Modify: `packages/desktop/tsconfig.json`

**Interfaces:**

- Consumes: `MatchReport` prop `initialView` from Task 1
- Produces:
  - `export type SceneName` (this task contains 4 report scenes; Task 3 appends 3 app-shell scenes)
  - `export const SCENE_NAMES: readonly SceneName[]`
  - `export function resolveScene(search: string): SceneName | null`
  - DOM convention: in scene mode, the root container carries `data-scene-ready="<sceneName>"`, allowing Playwright to assert render readiness.

- [ ] **Step 1: Write failing test**

Create `packages/desktop/dev/scenes.test.ts`:

```ts
import { resolveScene, SCENE_NAMES } from "./scenes";

describe("resolveScene", () => {
  it("no scene parameter -> null (falls back to interactive testbed)", () => {
    expect(resolveScene("")).toBeNull();
    expect(resolveScene("?foo=1")).toBeNull();
  });

  it("valid scene name -> returned as-is", () => {
    expect(resolveScene("?scene=report-battle")).toBe("report-battle");
    expect(resolveScene("?scene=report-ai&other=x")).toBe("report-ai");
  });

  it("invalid scene name -> null", () => {
    expect(resolveScene("?scene=nope")).toBeNull();
  });

  it("scene names list is non-empty and unique", () => {
    expect(SCENE_NAMES.length).toBeGreaterThan(0);
    expect(new Set(SCENE_NAMES).size).toBe(SCENE_NAMES.length);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npm test --workspace=packages/desktop -- scenes
```

Expected: FAIL — `Failed to resolve import "./scenes"`.

- [ ] **Step 3: Implement scenes.ts**

Create `packages/desktop/dev/scenes.ts`:

```ts
/** Visual regression scenes: each scene is a deterministic URL-reachable state. */
export const SCENE_NAMES = [
  "report-battle",
  "report-replay",
  "report-ai",
  "report-synth",
] as const;

export type SceneName = (typeof SCENE_NAMES)[number];

export function resolveScene(search: string): SceneName | null {
  const raw = new URLSearchParams(search).get("scene");
  if (!raw) return null;
  return (SCENE_NAMES as readonly string[]).includes(raw)
    ? (raw as SceneName)
    : null;
}
```

- [ ] **Step 4: Run test to verify success**

```bash
npm test --workspace=packages/desktop -- scenes
```

Expected: PASS (4 passed)

- [ ] **Step 5: Wire into main.tsx**

In `packages/desktop/dev/main.tsx`, import `resolveScene` and `SceneName`, insert `Scene` component before `Harness`, and update `createRoot().render(...)`.

- [ ] **Step 6: Scene mode styles**

Append to `packages/desktop/dev/harness.css`:

```css
/* Scene mode: no toolbar, padding matches app main area */
.scene-root {
  padding: 16px;
}
```

- [ ] **Step 7: tsconfig covers dev/**

In `packages/desktop/tsconfig.json`, include `"dev"`. Verify with `npm run typecheck`.

- [ ] **Step 8: Visually verify scene in browser**

Run `npm run dev:ui --workspace=packages/desktop` and check `http://localhost:5199/?scene=report-replay`.

- [ ] **Step 9: Full verification + Commit**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
git add packages/desktop/dev packages/desktop/tsconfig.json
git commit -m "feat(dev-ui): ?scene= scenario routing — deterministic entrypoint for visual regression"
```

---

## Task 3: app-shell Scenarios (Dashboard / Settings / Match List)

Mount the entire `<App/>` with `installFixtureBridge()` and override list data with deterministic metas.

**Files:**

- Create: `packages/desktop/dev/fixtures/appShell.ts`
- Modify: `packages/desktop/dev/scenes.ts`
- Modify: `packages/desktop/dev/scenes.test.ts`
- Modify: `packages/desktop/dev/main.tsx`

**Interfaces:**

- Consumes: `SCENE_NAMES` / `resolveScene` from Task 2; `installFixtureBridge()` (`src/renderer/src/fixtureBridge.ts`)
- Produces:
  - `SCENE_NAMES` appends `"dashboard" | "settings" | "matchlist"`
  - `export const DEMO_METAS: StoredMatchMeta[]` (fixed timestamp, 12 items)
  - `export function installAppShellFixture(): void`

- [ ] **Step 1: Expand tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Add scene names in scenes.ts**
- [ ] **Step 4: Run tests to verify success**
- [ ] **Step 5: Write deterministic metas fixture in appShell.ts**
- [ ] **Step 6: Wire into main.tsx**
- [ ] **Step 7: Visually verify three pages**
- [ ] **Step 8: Full verification + Commit**

```bash
npm test --workspace=packages/desktop && npm run typecheck && npx eslint packages/desktop/src --quiet
git add packages/desktop/dev packages/desktop/src/renderer/src/App.tsx
git commit -m "feat(dev-ui): dashboard/settings/matchlist scenes — app-shell visual regression coverage"
```

---

## Task 4: Playwright Landing + 7 Scenario Screenshot Baselines

**Files:**

- Create: `packages/desktop/qa/playwright.config.ts`
- Create: `packages/desktop/qa/visual/scenes.spec.ts`
- Create: `packages/desktop/qa/__screenshots__/`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/vitest.config.ts`
- Modify: `packages/desktop/tsconfig.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install dependencies**

```bash
npm i -D -w @gladlog/desktop @playwright/test
npx playwright install --with-deps chromium
```

- [ ] **Step 2: Isolate vitest and Playwright**

In `vitest.config.ts`, exclude `"qa/**"`. Include `"qa"` in `tsconfig.json`. Add test results to `.gitignore`.

- [ ] **Step 3: Write Playwright configuration**
- [ ] **Step 4: Write scenario screenshot tests in scenes.spec.ts**
- [ ] **Step 5: Add npm scripts in package.json**
- [ ] **Step 6: Local smoke test (without generating baselines)**
- [ ] **Step 7: Confirm no accidental baseline writes**
- [ ] **Step 8: Commit**

```bash
git add packages/desktop/qa packages/desktop/package.json packages/desktop/vitest.config.ts packages/desktop/tsconfig.json .gitignore package-lock.json
git commit -m "test(visual): Playwright visual regression scaffolding — 7 scenes"
```

---

## Task 5: axe Accessibility Scanning + Exemption List

**Files:**

- Create: `packages/desktop/qa/axe-allowlist.ts`
- Modify: `packages/desktop/qa/visual/scenes.spec.ts`

- [ ] **Step 1: Install dependency**

```bash
npm i -D -w @gladlog/desktop @axe-core/playwright
```

- [ ] **Step 2: Write exemption allowlist scaffolding in axe-allowlist.ts**
- [ ] **Step 3: Wire axe into scenes.spec.ts**
- [ ] **Step 4: Run initial scan and collect violations**
- [ ] **Step 5: Address violations by fixing or documenting in allowlist**
- [ ] **Step 6: Commit**

```bash
git add packages/desktop/qa packages/desktop/package.json package-lock.json
git commit -m "test(a11y): axe WCAG 2.1 AA scanning + explicit exemption allowlist"
```

---

## Task 6: CI Integration (Visual + axe)

**Files:**

- Modify: `.github/workflows/test.yml`
- Create: `.github/workflows/visual-baseline.yml`

- [ ] **Step 1: Add frontend-qa job in test.yml**
- [ ] **Step 1b: Add visual-baseline.yml workflow for manual baseline generation**
- [ ] **Step 2: Validate workflow syntax**
- [ ] **Step 3: Commit**
- [ ] **Step 4: Push branch and generate baselines on CI**
- [ ] **Step 5: Download and review baselines visually**
- [ ] **Step 6: Commit and push baselines**
- [ ] **Step 7: Verify frontend-qa job passes in CI**

---

# Phase 2 — Parsing Speed Budget

## Task 7: Deterministic Synthetic Combat Log Generator

**Files:**

- Create: `packages/parser/src/testing/synthLog.ts`
- Create: `packages/parser/test/synthLog.test.ts`

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement synthArenaLog**
- [ ] **Step 4: Run tests to verify success**
- [ ] **Step 5: Commit**

```bash
git add packages/parser/src/testing packages/parser/test/synthLog.test.ts
git commit -m "test(parser): deterministic synthetic combat log generator — shared payload for E2E and budgets"
```

---

## Task 8: Parsing Speed Budget (measure mode)

**Files:**

- Create: `packages/parser/test/parseBudget.test.ts`
- Create: `packages/desktop/qa/budgets.ts`

- [ ] **Step 1: Write budget constants module**
- [ ] **Step 2: Write parsing budget test**
- [ ] **Step 3: Run and verify measurement output**
- [ ] **Step 4: Confirm execution during npm test**
- [ ] **Step 5: Commit**

```bash
git add packages/parser/test/parseBudget.test.ts packages/desktop/qa/budgets.ts
git commit -m "test(perf): parsing speed budget harness (measure mode)"
```

---

# Phase 3 — E2E Three Core Journeys + Cold Start

## Task 9: GLADLOG_E2E Environment Flag (userData redirection)

**Files:**

- Create: `packages/desktop/src/main/e2eEnv.ts`
- Create: `packages/desktop/src/main/e2eEnv.test.ts`
- Modify: `packages/desktop/src/main/index.ts:22`

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Run tests to verify failure**
- [ ] **Step 3: Implement e2eUserDataDir**
- [ ] **Step 4: Run tests to verify success**
- [ ] **Step 5: Integrate into index.ts before any getPath calls**
- [ ] **Step 6: Verify call ordering**
- [ ] **Step 7: Commit**

```bash
git add packages/desktop/src/main/e2eEnv.ts packages/desktop/src/main/e2eEnv.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(main): GLADLOG_E2E userData redirection — isolated temporary states for E2E"
```

---

## Task 10: E2E Journey 1 (Import -> Report) + Cold Start Timing

**Files:**

- Create: `packages/desktop/qa/e2e/import.spec.ts`
- Modify: `packages/desktop/package.json`

- [ ] **Step 1: Add test:e2e script in package.json**
- [ ] **Step 2: Write Journey 1 test in import.spec.ts**
- [ ] **Step 3: Run E2E test**
- [ ] **Step 4: Commit**

```bash
git add packages/desktop/qa/e2e packages/desktop/package.json
git commit -m "test(e2e): Journey 1 import -> report + cold start timing"
```

---

## Task 11: E2E Journey 2 (Finding -> Evidence Chain)

**Files:**

- Create: `packages/desktop/src/shared/promptVersion.ts`
- Modify: `packages/desktop/src/main/ai.ts:10`
- Create: `packages/desktop/qa/support/seedAnalysis.ts`
- Create: `packages/desktop/qa/e2e/evidence.spec.ts`

- [ ] **Step 1: Extract PROMPT_VERSION into shared single-source module**
- [ ] **Step 2: Verify existing code functionality**
- [ ] **Step 3: Write seedAnalysis helper**
- [ ] **Step 4: Write Journey 2 test in evidence.spec.ts**
- [ ] **Step 5: Run E2E test**
- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/shared/promptVersion.ts packages/desktop/src/main/ai.ts packages/desktop/qa
git commit -m "test(e2e): Journey 2 finding -> evidence chain; PROMPT_VERSION extracted to single source"
```

---

## Task 12: E2E Journey 3 (Coach Loop + Persistence on Restart)

**Files:**

- Create: `packages/desktop/qa/support/launch.ts`
- Create: `packages/desktop/qa/e2e/coachLoop.spec.ts`
- Modify: `packages/desktop/qa/e2e/import.spec.ts`
- Modify: `packages/desktop/qa/e2e/evidence.spec.ts`

- [ ] **Step 1: Extract common launch helper in launch.ts**
- [ ] **Step 2: Refactor previous specs to use launch helper**
- [ ] **Step 3: Write Journey 3 test in coachLoop.spec.ts**
- [ ] **Step 4: Run E2E tests**
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/qa
git commit -m "test(e2e): Journey 3 coach loop + restart persistence; extract launch helper"
```

---

## Task 13: CI Integration for E2E

**Files:**

- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Add E2E step with xvfb-run to frontend-qa job**
- [ ] **Step 2: Commit and push**
- [ ] **Step 3: Verify CI passes and collect budget numbers from logs**

```bash
git add .github/workflows/test.yml
git commit -m "ci: frontend-qa adds E2E three journeys (xvfb headless Electron)"
```

---

# Phase 4 — First Paint Budget + Budget Locking

## Task 14: Report First Paint Budget (measure mode)

**Files:**

- Create: `packages/desktop/qa/visual/firstPaint.spec.ts`
- Modify: `packages/desktop/dev/scenes.ts`
- Modify: `packages/desktop/dev/main.tsx`
- Modify: `packages/desktop/dev/fixtures/appShell.ts`

- [ ] **Step 1: Add report-heavy scene name in scenes.ts**
- [ ] **Step 2: Implement heavyMatch generator in appShell.ts**
- [ ] **Step 3: Write first paint timing test in firstPaint.spec.ts**
- [ ] **Step 4: Run visual test**
- [ ] **Step 5: Commit**

```bash
git add packages/desktop/dev packages/desktop/qa
git commit -m "test(perf): report first paint budget harness (heavy deterministic payload, measure mode)"
```

---

## Task 15: Lock Three Budgets with Real CI Numbers

**Files:**

- Modify: `packages/desktop/qa/budgets.ts`
- Modify: `docs/verifiability-roadmap.md`

- [ ] **Step 1: Trigger 5 CI runs**
- [ ] **Step 2: Collect budget sample logs**
- [ ] **Step 3: Calculate p95 x 1.5 and lock values in budgets.ts**
- [ ] **Step 4: Verify assertion failures trigger on violation**
- [ ] **Step 5: Update verifiability-roadmap.md to mark C2 complete**
- [ ] **Step 6: Full verification + Commit**
- [ ] **Step 7: Confirm green CI runs**

```bash
git add packages/desktop/qa/budgets.ts docs/verifiability-roadmap.md
git commit -m "test(perf): lock three performance budgets with CI sample numbers; roadmap C2 complete"
```

---

## Wrap-up Checklist

- [ ] `npm test` all green with three `[budget]` lines in output
- [ ] `npm -w @gladlog/desktop run test:visual:smoke` all green locally (7 scenes + 1 first paint); CI `frontend-qa` compares baselines cleanly
- [ ] `npm -w @gladlog/desktop run test:e2e` all green (3 journeys)
- [ ] `npm run typecheck` and `npm run lint` all green
- [ ] CI `test` and `frontend-qa` jobs both pass
- [ ] Intentional CSS color tweak triggers diff on CI `frontend-qa`
- [ ] 7 baseline png images in `qa/__screenshots__/` committed and reviewed
- [ ] All exemptions in `qa/axe-allowlist.ts` carry concrete justifications
