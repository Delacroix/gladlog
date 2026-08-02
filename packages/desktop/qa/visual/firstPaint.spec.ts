import { expect, test } from "@playwright/test";

import { FIXED_NOW } from "../../dev/fixtures/fixedNow";
import { BUDGET_MS, reportBudget } from "../budgets";
import { isolateExternalRequests } from "../support/stubExternal";

/** First paint on the oversized payload is naturally slower than an ordinary
 * scene, so the test's overall timeout must accommodate three samples. */
test.setTimeout(120_000);

test("大号对局的报表首渲在预算内(未锁定时只测量)", async ({ page }) => {
  // Isolate the network here too: the first-paint budget measures our code and
  // must not include public-internet RTT
  await isolateExternalRequests(page);
  await page.clock.setFixedTime(new Date(FIXED_NOW));

  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    // i exists only to bypass any caching, so each iteration really reloads
    await page.goto(`/?scene=report-heavy&i=${i}`);
    await expect(page.getByTestId("rpt-timeline")).toBeVisible({
      timeout: 30_000,
    });
    samples.push(Date.now() - t0);
  }
  const median = samples.sort((a, b) => a - b)[1]!;
  reportBudget("firstPaint", median, samples.length);
  if (BUDGET_MS.firstPaint !== null) {
    expect(median).toBeLessThan(BUDGET_MS.firstPaint);
  }
});
