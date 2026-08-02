import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { isExempt } from "../axe-allowlist";
import { isolateExternalRequests } from "../support/stubExternal";

// Import from the dependency-free leaf modules, not from appShell — the latter
// would drag fixtureBridge's JSON imports into Playwright's Node process and
// fail outright with an import-attribute error.
import { FIXED_NOW } from "../../dev/fixtures/fixedNow";
import { SCENE_NAMES, type SceneName } from "../../dev/scenes";

/** Per-scene "render complete" anchor: wait for it before screenshotting so we
 * never capture a half-rendered frame. */
// report-heavy is an oversized payload used solely for first-paint timing; it
// has no pixel baseline (see firstPaint.spec.ts)
const SNAPSHOT_SCENES = SCENE_NAMES.filter((s) => s !== "report-heavy");

const ANCHOR: Partial<Record<SceneName, string>> = {
  "report-battle": "[data-testid=rpt-timeline]",
  "report-replay": "[data-testid=rpt-replay-field]",
  // Use the deep-dive block rather than .rpt-match: the latter is the report
  // root shared by all three views and is satisfied the moment it mounts,
  // while the finding cards come from the asynchronous analysis.getState —
  // anchoring on the root would mean not waiting at all.
  "report-ai": "[data-testid=finding-deepdive]",
  "report-synth": "[data-testid=rpt-timeline]",
  // Anchor the selected state on the window chip: the chip appearing means the
  // window state has been applied and the aggregate panels recomputed for it
  "report-window": "[data-testid=time-range-chip]",
  "report-events": "[data-testid=events-panel]",
  // Recording scene: the timeline card is the deterministic anchor rendered
  // from log data (the video surface itself is always black)
  video: "[data-testid=video-battle-timeline]",
  dashboard: "[data-testid=stats-dashboard]",
  settings: "[data-testid=settings-panel]",
  matchlist: "[data-testid=match-list]",
  // 开发者工作台:锚点用检查器三栏的左栏 —— 它要等 matches.list() 回来才挂,
  // 拿 dev-rail 当锚点等于不等(rail 挂载即满足)
  dev: "[data-testid=dev-match-list]",
};

/**
 * First-paint readiness timeout.
 *
 * Measured at ~2-3s per scene (after the 2026-07-19 switch of the big JSON to
 * JSON.parse; before that it was ~24s — see the comment in
 * electron.vite.config.ts for why). 15s leaves plenty of headroom for slow CI
 * runners without making a genuinely broken scene hang for a full minute
 * before failing.
 */
const BOOT_TIMEOUT_MS = 15_000;

for (const scene of SNAPSHOT_SCENES) {
  test(`场景 ${scene} 与基线一致`, async ({ page }) => {
    // External-network isolation must come before goto: baselines must not
    // depend on public-internet reachability (see stubExternal.ts)
    const leaked = await isolateExternalRequests(page);
    // Pin only Date.now()/new Date(); do not take over the timers — the app's
    // background backfill uses setTimeout, and fake timers would freeze it.
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    await page.goto(`/?scene=${scene}`);
    await expect(page.locator(`[data-scene-ready=${scene}]`)).toBeAttached({
      timeout: BOOT_TIMEOUT_MS,
    });
    await expect(page.locator(ANCHOR[scene]!)).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    // soft: on a screenshot mismatch, **keep going** and still run axe —
    // otherwise a visual regression masks an accessibility regression, one run
    // reports only half the problems, and a human has to run it twice to see
    // everything.
    // Multi-tier baselines (4K redesign): the default `visual` project carries
    // no suffix (old baseline names stay put), while visual-1440/visual-1920
    // append -1440/-1920 — all three tiers coexist in the same directory.
    const proj = test.info().project.name;
    const suffix = proj === "visual" ? "" : proj.replace("visual", "");
    await expect.soft(page).toHaveScreenshot(`${scene}${suffix}.png`, {
      fullPage: true,
    });

    // Accessibility: the standard is WCAG 2.1 A+AA, and the set of violations
    // must be ⊆ the explicit exemption list. All four tags are required: axe
    // attaches the rules new in 2.1 (autocomplete-valid, avoid-inline-spacing,
    // css-orientation-lock, label-content-name-mismatch) only to the wcag21*
    // tags, so dropping them means "claiming 2.1 while actually running 2.0".
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const unexpected = axe.violations.flatMap((v) =>
      v.nodes
        .map((n) => ({ rule: v.id, target: n.target.join(" ") }))
        .filter((x) => !isExempt(x.rule, x.target)),
    );
    expect(
      unexpected,
      `场景 ${scene} 出现未豁免的无障碍违规;修掉它,或写进 qa/axe-allowlist.ts 并说明理由`,
    ).toEqual([]);

    // Leak ledger: a baseline that drifts with public-internet reachability is
    // a hidden flaky red, and must be blocked the moment it is introduced.
    // Either make the resource local, or give it a fixed stub in
    // stubExternal.ts.
    expect(
      leaked,
      `场景 ${scene} 请求了未打桩的外部资源 —— 基线会随网络抖动;见 qa/support/stubExternal.ts`,
    ).toEqual([]);
  });
}
