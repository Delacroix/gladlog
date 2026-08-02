// The baselines are single-source on linux, generated and judged by CI (the
// frontend-qa job in .github/workflows/test.yml + the visual-baseline
// workflow). Locally, only run npm run test:visual:smoke — it passes
// --ignore-snapshots, so it neither compares nor writes baselines; running
// test:visual directly would write mac screenshots wherever a baseline is
// missing, polluting the single source.

import { defineConfig, devices } from "@playwright/test";

import { isE2EOnlyRun } from "./argv";
import { VISUAL_PORT as PORT } from "../dev/ports";

export default defineConfig({
  testDir: ".",
  // Total budget for a single test case. Must be substantially larger than
  // BOOT_TIMEOUT_MS in qa/visual/scenes.spec.ts — Playwright's default
  // per-test budget is only 30s, while the report page's first paint alone
  // takes ~24s (the 12MB spellNames.json top-level await; see that file's
  // comments). At the default, CI only has to be slightly slower than a local
  // machine for the case to be killed at 30s first, so the assertion-level
  // timeout never gets a chance to apply.
  timeout: 120_000,
  // Keep run artifacts inside qa/, matching the two .gitignore rules
  outputDir: "test-results",
  // Single-source baselines: the path deliberately contains NO {platform} —
  // the one linux baseline set is the only standard.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: false,
  // workers=1: when the two performance budgets (firstPaint / coldStart)
  // contend with other cases for the same machine, what you measure is
  // contention, not performance. The whole suite takes only tens of seconds,
  // so serial execution costs far less than "budget numbers you can't trust".
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"]
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  expect: {
    // The tolerance only absorbs anti-aliasing noise; it is not there to let
    // things slide.
    //
    // Both numbers were calibrated by measurement — do not tune them by feel:
    //
    // 1) threshold is the per-pixel YIQ color-distance tolerance. The default
    //    0.2 is far too loose — changing the theme color --win from #7ac9a3 to
    //    #22cc55 (recoloring the win/loss text and the rating curve) left the
    //    two colors close enough in luminance that no pixel's distance reached
    //    0.2, so "zero pixels counted as different" and no maxDiffPixels,
    //    however small, could catch it. Measured on CI: 0.2 passes green, 0.05
    //    goes red.
    // 2) maxDiffPixels is how many pixels may exceed that distance. Use an
    //    absolute count rather than maxDiffPixelRatio: full-page screenshots
    //    run 1280x1300 and up, so a ratio of 0.01 waves through 16000+ pixels
    //    and small-area real changes could never reach it.
    //
    // A gate that cannot hold is worse than no gate — it grants false
    // confidence. Before changing either value, verify with "deliberately
    // change one color and check that CI goes red".
    toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 100 },
  },
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "visual",
      testMatch: /visual\/.*\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        baseURL: `http://localhost:${PORT}`,
      },
    },
    // 4K redesign (2026-08-01): the two-column layout kicks in at >=1440px, so
    // the 1280 tier only covers the single-column fallback. 1920 = the real
    // CSS viewport of the user's 4K screen at its default scaling (the primary
    // tier), 1440 = the boundary tier where two columns first hold. Only the
    // scenes touched by the redesign are run — don't multiply all scenes
    // across all 3 tiers.
    // dev (the developer workbench, 3.7) joins the multi-tier set: one of its
    // acceptance conditions is "no double scrollbars and no overflow from 1280
    // all the way to 4K" — a single 1280 tier would verify nothing.
    {
      name: "visual-1440",
      testMatch: /visual\/scenes\.spec\.ts$/,
      grep: /(report-battle|dashboard|video|dev) /,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${PORT}`,
      },
    },
    {
      name: "visual-1920",
      testMatch: /visual\/scenes\.spec\.ts$/,
      grep: /(report-battle|dashboard|video|dev) /,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        baseURL: `http://localhost:${PORT}`,
      },
    },
    {
      name: "e2e",
      testMatch: /e2e\/.*\.spec\.ts$/,
    },
  ],
  // The e2e project drives the packaged Electron app and does not need this
  // test-bed server at all — starting it unconditionally wastes a full build
  // wait and collides on the port when a preview is already running locally.
  webServer: isE2EOnlyRun(process.argv)
    ? undefined
    : {
        // Build then preview, rather than a dev server: in dev mode every new
        // page re-fetches hundreds of unbundled ESM modules (measured ~24s per
        // page; a warm server-side cache doesn't help — the cost is the
        // browser-side request waterfall). Building once takes ~5s, after
        // which every page loads in <1s, and the screenshots contain no
        // dev-only artifacts like HMR / react-refresh.
        command: "npm run build:ui && npm run preview:ui",
        cwd: "..",
        url: `http://localhost:${PORT}`,
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
