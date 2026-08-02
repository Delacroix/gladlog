/** Performance budgets (measure-then-lock).
 *
 *  Strategy: at first only measure, never assert — every run prints
 *  `[budget] name=…ms`; once enough real CI numbers exist, take p95 × 1.5 and
 *  write it into this file, after which crossing the line turns CI red.
 *  null = not locked yet. Loosening any value requires the reason to go into
 *  the commit message.
 *
 *  Three consumers: parse      → packages/parser/test/parseBudget.test.ts
 *                   firstPaint → packages/desktop/qa/visual/firstPaint.spec.ts
 *                   coldStart  → packages/desktop/qa/e2e/import.spec.ts
 *
 *  Why all three budgets live in one place: they are one family of constants
 *  under one strategy, so the predicate is single-source — spread across their
 *  own packages, a strategy change would inevitably miss one. This file
 *  deliberately has zero imports so the parser's test process can consume it
 *  directly (see that test's relative-path import).
 */
export const BUDGET_MS: {
  parse: number | null;
  firstPaint: number | null;
  coldStart: number | null;
} = {
  // Basis for the lock: 3 CI samples taken on ubuntu-latest on 2026-07-19,
  // max × 1.5, rounded up. The ×1.5 headroom covers runner jitter.
  //   parse:      2742 / 3266 / 3174 → max 3266 × 1.5 → 4900
  //   firstPaint: 2190 / 2138 / 2119 → max 2190 × 1.5 → 3300
  //   coldStart:  1616 / 1717 / 1590 → max 1717 × 1.5 → 2600
  //
  // These three catch **order-of-magnitude regressions** (an accidental O(n²),
  // or someone dropping another big blob at module top level that V8 has to
  // parse as source), not 5% jitter. Loosening any value requires the reason to
  // go into the commit message.
  //
  // History: earlier on 2026-07-19 these three were locked at
  // 5100 / 41000 / 36000 — back then spellNames.json compiled into a JS object
  // literal with 410k keys and first paint alone took 22 seconds. After turning
  // on Vite's json.stringify, first render and cold start each got an order of
  // magnitude faster, and the budgets tightened accordingly. **That is what a
  // budget should look like: it follows real performance, not the other way
  // round.**
  parse: 4900,
  firstPaint: 3300,
  coldStart: 2600,
};

/** One shared measurement output format — the CI log IS the data source used
 *  when locking the budgets. */
export function reportBudget(name: string, ms: number, samples: number): void {
  // eslint-disable-next-line no-console
  console.log(`[budget] ${name}=${ms.toFixed(0)}ms n=${samples}`);
}
