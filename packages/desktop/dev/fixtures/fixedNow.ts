/** Fixed reference instant for visual regression (2026-07-19T12:00:00Z).
 *
 *  Single-source predicate: the scene fixtures (browser side) and Playwright's
 *  clock.setFixedTime (Node side) must be pinned to the SAME instant, or the
 *  "today/yesterday" grouping and the dashboard periods drift with real time →
 *  flaky screenshots.
 *
 *  This file MUST stay import-free: Playwright's test process is Node ESM, and
 *  following the import chain into a JSON import (fixtureBridge →
 *  report-match.json) fails outright with `needs an import attribute of
 *  "type: json"`. Only a leaf module can be shared by both sides. */
export const FIXED_NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
