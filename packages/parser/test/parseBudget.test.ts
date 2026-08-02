// The budget constants are imported cross-package by relative path: budgets.ts
// deliberately has zero imports and is the single source for all three budgets.
// Going through the package name would make parser depend on desktop (a reverse
// dependency), hence the relative path.
import { BUDGET_MS, reportBudget } from "../../desktop/qa/budgets";
import { GladLogParser } from "../src/api";
import { synthArenaLog } from "../src/testing/synthLog";

function parseOnce(text: string): number {
  const t0 = performance.now();
  const p = new GladLogParser({ timezone: "UTC" });
  let matches = 0;
  p.on("match", () => matches++);
  for (const line of text.split("\n")) if (line.trim()) p.push(line);
  p.end();
  if (matches !== 1) throw new Error(`期望 1 场,实得 ${matches}`);
  return performance.now() - t0;
}

describe("解析速度预算", () => {
  it("大日志解析耗时在预算内(未锁定时只测量)", () => {
    // Generated inside the test body: at module top level, everyone running
    // npm test would pay the tens-of-MB generation cost even when this test is
    // filtered out by --grep.
    const bigLog = synthArenaLog({ eventsPerRound: 200_000 });
    const runs = [1, 2, 3].map(() => parseOnce(bigLog)).sort((a, b) => a - b);
    const median = runs[1]!;
    reportBudget("parse", median, runs.length);
    if (BUDGET_MS.parse !== null) {
      expect(median).toBeLessThan(BUDGET_MS.parse);
    }
  }, 120_000);
});
