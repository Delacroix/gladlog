import { expect, test } from "@playwright/test";

import { FIXED_NOW } from "../../dev/fixtures/fixedNow";
import { BUDGET_MS, reportBudget } from "../budgets";
import { isolateExternalRequests } from "../support/stubExternal";

/** First paint on the oversized payload is naturally slower than an ordinary
 * scene, so the test's overall timeout must accommodate every sample. */
test.setTimeout(180_000);

/** How many reloads to time. Five rather than three so the statistic below has
 * something to pick a floor from. */
const SAMPLES = 5;

test("大号对局的报表首渲在预算内(未锁定时只测量)", async ({ page }) => {
  // Isolate the network here too: the first-paint budget measures our code and
  // must not include public-internet RTT
  await isolateExternalRequests(page);
  await page.clock.setFixedTime(new Date(FIXED_NOW));

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = Date.now();
    // i exists only to bypass any caching, so each iteration really reloads
    await page.goto(`/?scene=report-heavy&i=${i}`);
    await expect(page.getByTestId("rpt-timeline")).toBeVisible({
      timeout: 30_000,
    });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);

  // ── Why the MINIMUM and not the median (2026-08-18) ──────────────────────
  //
  // The median was measuring the runner, not the code. Nine CI samples across
  // three commits, threshold 5200:
  //   02a4720d  4722 ✓ · 5154 ✓ · 5051 ✓      (the last one a same-evening
  //                                            control run of the SAME code)
  //   94eed173  5283 ✗ · 4708 ✓
  //   d5a66dce  5226 ✗ · 5349 ✗
  //   07222bcb  5291 ✗
  // Spread 4708–5349 = 641ms of noise around a line with under 500ms of
  // headroom, and the two populations overlap almost completely — the same
  // commit produced both the highest and the lowest reading of its group. A
  // gate like that cannot tell a real regression from a busy runner; it just
  // reds out roughly half the time.
  //
  // The change deliberately does NOT touch the 5200 threshold. Runner noise is
  // one-sided — contention can only ever make a sample slower, never faster —
  // so the floor of several reloads is the closest thing to "what this code
  // actually costs", while the median drags in whatever else the machine was
  // doing. Raising the number instead would have bought quiet by weakening the
  // very thing the budget exists to catch (see budgets.ts: these catch
  // order-of-magnitude regressions, and the historical 22s first paint must
  // still trip it four times over).
  //
  // Every sample is logged, not just the statistic: the next re-lock should be
  // done on a real minimum population, which no CI log until now recorded.
  const floor = samples[0]!;
  reportBudget("firstPaint", floor, samples.length);
  // eslint-disable-next-line no-console
  console.log(`[budget] firstPaint samples=${samples.join(",")}`);
  if (BUDGET_MS.firstPaint !== null) {
    expect(floor).toBeLessThan(BUDGET_MS.firstPaint);
  }
});
