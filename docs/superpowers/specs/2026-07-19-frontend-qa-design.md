# Frontend QA Architecture Design (C2 Visual Regression + axe + E2E + Performance Budget)

Date: 2026-07-19
Status: Approved (brainstorm finalized)
Relations: Corresponds to C2 (Visual Regression) of `docs/verifiability-roadmap.md`, proactively covering the E2E foundation required for C3/trust-chain.

## Goals and Scope

Build a layered QA tower for the gladlog frontend, where "pass" at each layer is a machine-evaluable assertion:

| Layer | Standard Type | Standard | Status |
| --- | --- | --- | --- |
| Data Fidelity | Absolute (ground truth exists) | Rendered value == Computed value, zero tolerance | ✅ C1 `verify:vision`, untouched this phase |
| Visual Regression | Relative (human-approved baseline) | Screenshot == Baseline, tolerance only absorbs anti-aliasing | Newly built this phase |
| Accessibility | Absolute (industry standard) | WCAG 2.1 A+AA (axe ruleset), violations ⊆ explicit allowlist | Newly built this phase |
| Interaction Flows | Checklist (product decision) | All three core journeys pass | Newly built this phase |
| Performance Budget | Absolute (self-defined budget) | 3 metrics within limits, budget = measured p95 × 1.5 | Newly built this phase |

Principle: **Never use a relative standard where an absolute standard can be used.** Whether numbers are correct belongs to C1 data assertions; screenshot diffs are only responsible for layout / spacing / color scheme / typography "appearance" issues, and the two layers do not act as fallbacks for each other. The authority of the visual baseline always rests with humans—machines only guarantee that "without human approval, pixels must not change."

Non-goals: Replay dragging framerate budget (prone to flakiness, evaluated separately later); cloud visual services (Percy/Chromatic; local diffs under deterministic fixtures provide free equivalent value); Lighthouse/SEO metrics (meaningless for desktop applications).

## Overall Architecture

One Playwright dependency, three execution layers, all built on the existing foundation:

```
QA Layer                   Runner                         Where it runs
──────────────────────────────────────────────────────────────
Visual Regression + axe   Playwright browser project     dev:ui testbench (:5199)
Report First Paint Budget Same as above (timed in batch) dev:ui testbench
E2E 3 Flows + Cold Start  Playwright _electron project   electron-vite build artifact
Parser Speed Budget       vitest timed test              packages/parser
```

New files are concentrated in `packages/desktop/qa/`:

```
packages/desktop/qa/
  playwright.config.ts     # Two projects: visual (browser) / e2e (electron)
  visual/                  # Scene screenshots + axe + first paint timing
  e2e/                     # 3 flows + cold start
  __screenshots__/         # Linux baseline (single source, committed to repository)
  axe-allowlist.ts         # Explicit allowlist (rule id + selector + reason)
```

Not mixed into vitest's `test/`. New scripts (`packages/desktop/package.json`):

- `test:visual` — Visual + axe + first paint (runs in CI, compares against baseline)
- `test:visual:smoke` — Local smoke test with `--ignore-snapshots`: verifies scenes render, but **does not compare or write** baselines
- `test:e2e` — Runs Electron E2E after build (runnable locally)

### Single Source Baseline

Screenshot baselines **only have a single Linux set**, generated and evaluated by CI (ubuntu-latest)—`visual-baseline.yml` is manually triggered to run `--update-snapshots`, artifacts are downloaded and reviewed by humans, then committed; afterwards, the `frontend-qa` job compares against it every time. This is isomorphic to the project's "single source predicate" philosophy: one fact (page appearance) has only one evaluation predicate (Linux rendering + same tolerance).

The original plan was to generate baselines locally using Playwright's official Docker image, but this machine has no container runtime (verified 2026-07-19), so it was changed to CI generation. **Constraints are not relaxed, only the origin has changed**: CI was already the baseline authority; now it is also the producer. The cost is that updating the baseline on redesign requires a round of CI (manual trigger → download → review → commit), but updating baselines is inherently a low-frequency action that requires human review anyway.

Supporting hard requirement: Local machines **must never** run `test:visual` directly—when baselines are missing, Playwright writes the current screenshot as the baseline. If macOS font rendering gets committed, it breaks single-source truth. Therefore, the only local entry point is `test:visual:smoke`.

## Visual Regression (C2)

### Scene Checklist

The `dev:ui` testbench adds a `?scene=` URL parameter to directly reach deterministic states (without manually clicking dropdowns/tabs):

| Scene | Content | Fixture |
| --- | --- | --- |
| `report-battle` | Battle report view (Meters / stats table / timeline) | Anonymized real match (committed) |
| `report-replay` | Replay view (arena / swimlanes) | Anonymized real match |
| `report-ai` | AI analysis view (findings / comparison) | Anonymized real match + existing mock analysis |
| `report-synth` | Battle report (synthetic sample, alternative data shape) | Synthetic match (committed) |
| `dashboard` | Stats dashboard | Newly added synthetic metas fixture |
| `settings` | Settings page | fixtureBridge |
| `matchlist` | Match list (including filters) | Newly added synthetic metas fixture |

Dashboard, settings, and match list are not currently in the testbench; they are added as scenes in this phase (reusing the mock channel of `fixtureBridge.ts`). An independent benefit is that the `run-ui` workflow can inspect these pages directly in the future.

### Deterministic Measures

- Fixed viewport 1280×800; `toHaveScreenshot({ animations: "disabled" })`.
- Playwright clock API freezes `Date.now()` to a fixed timestamp; `TZ` and locale are pinned inside the container—ensuring relative times and `toLocaleString()` (`StatsDashboard.tsx`, `dashboard.ts`) on the dashboard remain stable.
- Tolerance `threshold: 0.05` (per-pixel YIQ distance, absorbs anti-aliasing) + `maxDiffPixels: 100` (how many pixels are allowed to exceed threshold). **These two numbers are calibrated by actual measurement**: default `threshold: 0.2` allows same-luminance color palette changes to slip through (measured by deliberately changing `--win` from `#7ac9a3` to `#22cc55`, CI still passed green), while `maxDiffPixelRatio: 0.01` allows 16000+ pixels on full-page screenshots. Before modifying these two values, verify with "intentionally modify one color and check if CI turns red".
- Icons have no remote requests (`SpellIcon` uses local dataUrls), no network stubbing needed.

### Baseline Update Workflow (Authority Rests with Humans)

CI fails red → Download diff artifacts (expected/actual/diff triplet image) for human visual judgment →

- Unintended breakage: Fix code;
- Intentional redesign: Manually trigger `visual-baseline.yml` to regenerate baselines, download artifacts for human review and commit, **baseline changes enter review in the same commit as code changes**.

## axe Accessibility

`@axe-core/playwright` hooks into the same page load as visual scenes (scans conveniently after screenshot), rulesets `wcag2a` + `wcag2aa` + `wcag21a` + `wcag21aa`—none of the four tags can be omitted; axe only attaches 2.1 added rules to `wcag21*`, and omitting them results in "claiming 2.1, actually running 2.0". Screenshot assertions use `expect.soft`, otherwise if a screenshot fails, axe in the same test case never executes, causing visual regressions to mask accessibility regressions.

Policy: **Fix or explicitly exempt, no silent ignores allowed**. Exemptions are written into `axe-allowlist.ts` (rule id + selector + one-line reason), and tests assert "violations set ⊆ allowlist set"; any newly introduced violation turns CI red. The initial scan is expected to report a batch (contrast issues typical of dark game-style UI), reviewed one by one: fix what can be fixed, accept what cannot into allowlist—the allowlist file itself is a visible technical debt inventory.

## E2E 3 Flows + Cold Start

Playwright `_electron.launch()` drives `electron-vite build` output (close to release distribution, not dev mode), running on `xvfb-run` in CI.

### Isolation and Stubbing

Production code **only adds a single flag**: when `GLADLOG_E2E=1`, `userData` is redirected to a temporary directory (clean state each time, persistence assertions also performed inside). Throws an error instead of falling back if enabled without a valid path—silently using real userData would pollute user data.

All other stubbing resides on the test side and does not enter production code branches:

- **AI Analysis**: Writes canned results directly into the cache file read by the main process (`<userData>/matches/<id>/analysis-v2.zh.json`), without hitting real APIs. The cache includes `promptVersion` validation, so this constant must be extracted to a single source (`src/shared/promptVersion.ts`), with both seeding helper and main process importing the same copy—hardcoded duplicates would silently invalidate on version changes and yield false greens.
- **File Dialog**: `app.evaluate` replaces `dialog.showOpenDialog` in the main process to return synthetic log paths (native dialogs cannot be automated, standard practice).

### Flow Checklist (Core Journeys, Finalized by Product Decisions)

1. **Import → Report**: Stub dialog points to synthetic log (running through real parser) → Match appears in match list → Click to open → Assert one content anchor in each of the three views (health curve present / replay arena present / AI panel present).
2. **Finding → Evidence Chain**: Click finding in AI view → Assert navigation to corresponding timestamp in replay/timeline (selected state + timestamp value).
3. **Coach Feedback Loop**: Mark finding as helpful/unhelpful → Dashboard aggregate updates → In-app restart (close window and reopen) → Marks remain intact.

Prerequisite: The import flow needs to consume **raw `.txt` logs**, whereas existing committed fixtures are parsed JSON (`real-match-sample.json`). The approach is to write a **deterministic synthetic log generator** (`packages/parser/src/testing/synthLog.ts`), rather than truncating/anonymizing a real log:

- Zero PII risk, generator code itself can be safely committed (output generated at runtime, not checked in);
- Byte-for-byte reproducible given the same parameters, eliminating a class of flakiness sources;
- Volume can be parametrically scaled up, and the same generator feeds parser speed budget testing.

The tradeoff is that it does not cover wild edge cases of real logs—but that was never E2E's responsibility: parser fidelity belongs to A1 (differential oracle) and A2 (invariants), while E2E only answers "is this flow still working".

### Cold Start Budget

**Separated into an independent spec** (`qa/e2e/coldStart.spec.ts`), taking the median of 3 `launch()` → first interactive screen timings. Not attached to Flow 1: Flow 1 is a functional test where a red light should only mean "flow is broken"; moreover, single samples on shared runners are too easily disturbed by neighbors and cause false reds.

## Performance Budget (Measure-Then-Lock)

No arbitrary numbers out of thin air. Unified policy across three metrics: test harness lands first with **measure only, no assertions**; sample 5 runs on CI, **budget = p95 × 1.5**, committed as constants, after which exceeding limits turns CI red.

| Metric | Measurement Method | Payload |
| --- | --- | --- |
| Parser Speed | Timed parser parsing inside vitest, assert median < budget | Large synthetic log generated by `synthLog` (~200k lines, generated at runtime) |
| Report First Paint | dev:ui scene load → critical selector visible duration (Playwright timed) | Large match deterministically scaled up by fixed factor from real sample (`report-heavy` scene, no screenshot baseline) |
| Cold Start | Independent spec, median of 3 `launch()` runs | Same as E2E |

The ×1.5 margin is reserved for CI machine fluctuations; budgets catch **order-of-magnitude regressions** (accidental O(n²)), not 5% jitter. Relaxing any budget requires justification documented in commit messages.

Actual values upon landing (2026-07-19, taking max × 1.5 from 3 CI samples): parse 4900 / firstPaint 3300 / coldStart 2600. This budget system paid off on day one: it measured ~22 seconds of first screen stall caused by `spellNames.json` being compiled as JS object literals (instead of `JSON.parse`). Changing one line of Vite config dropped cold start from 25s → 1.6s, first paint from 24s → 2.1s, and budgets tightened by an order of magnitude accordingly.

## CI Integration and Failure Handling

`test.yml` adds a `frontend-qa` job, running in **parallel** with the existing `test` job (avoiding slowing down fast feedback):

1. Install Playwright browser (with cache)
2. Launch dev:ui → Visual + axe + first paint
3. `electron-vite build` → `xvfb-run` E2E + cold start

Parser budget is a regular vitest test, naturally entering existing `npm test` without needing a new job.

**Failure yields artifacts**: Any Playwright failure automatically `upload-artifact`s the HTML report + diff triplet images—without diff images manual review is impossible, which is a critical link in the visual regression feedback loop.

**Graduated Semantics**:

- Visual diff red = Unapproved pixel change → Human review: fix code or update baseline;
- axe red = Newly introduced violation → Fix or add to allowlist;
- Budget red = Performance regression → In principle, fix only, no relaxation.

## Implementation Order (Phases Split According to This)

1. **dev:ui Scene Support + Visual Regression + axe** — Lowest foundation requirement, fastest payoff;
2. **Parser Budget** — Independent, pluggable anytime;
3. **E2E 3 Flows + Cold Start** — Requires `GLADLOG_E2E` switch and synthetic log generator, heaviest;
4. **First Paint Budget + All Budget Locking** — Once harnesses in ①③ are ready, perform unified measure-then-lock.

Each phase is independently mergeable, with CI progressively tightening.

## Risks and Mitigations

- **Screenshot Flakiness** (fonts / anti-aliasing / timing): Linux single-source baseline + frozen clock + disabled animations + small tolerance; if jitter persists, prioritize fixing determinism loopholes rather than loosening tolerance.
- **Electron Fails to Launch in CI Headless Environment**: `xvfb-run` is an established pattern; packaging pitfalls already have precedents to follow (see memory: packaging pitfalls).
- **Initial axe Scan Reports Too Many Violations**: Policy permits full allowlisting at the start; the allowlist is openly visible and can be addressed incrementally without blocking landing.
- **CI Duration Inflation**: Parallel jobs + browser caching; 7 visual scenes, 3 E2E flows, volume is well-controlled.
