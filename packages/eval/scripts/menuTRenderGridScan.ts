/**
 * menuTRenderGridScan.ts — Shared-Predicate (render-grid) audit for
 * candidate-menu time facts.
 *
 * CLAUDE.md's Shared-Predicate Rule: a rendered fact and a rendered timeline
 * marker that describe the SAME instant must be "anchored to the rendered
 * value … floored to the rendering grid". A candidate menu's time fact is
 * rendered by `fmtFactNum` (rounds to one decimal, `toFixed(1)`); the
 * timeline's markers ([KICK], [DEATH], [UNCLEANSED DEBUFF], …) are rendered
 * by `fmtTime` (floors to the whole second). Those two rules silently
 * disagree whenever a raw value's fractional part lands in x.95–x.99:
 * `fmtFactNum(9.96)` -> `"10.0"` (rounds INTO the next second) while
 * `fmtTime(9.96)` -> `"0:09"` (floors, stays in the second still in
 * progress) — a reader sees `t=10.0s` right next to a `[KICK]` marker
 * timestamped `0:09`, a rendered contradiction over one real instant.
 *
 * Measured 2026-08-30 on the 309-prompt A/B corpus
 * (gladlog-eval-private/ab/2026-08-30-kick-eaten-ref/treatment/prompts,
 * BEFORE the fix): kick-eaten 20/209 (9.6%), death 23/375 (6.1%),
 * missed-cleanse 3/58 off-by-one + 8/58 no-marker (the no-marker 8 are late
 * cleanses — see below, NOT this bug), death-setup `deathT` 10/129 (7.8%).
 * Fixed by `fmtFactTime` (floors to one decimal instead of rounding) in
 * `packages/analysis/src/analysis/factFormat.ts`, used everywhere a `t` (or
 * `deathT`) fact must agree with a `fmtTime`-floored timeline marker
 * (kickEatenEvents in candidateFindings.ts; the death/missed-cleanse/
 * death-setup builders in candidates/death.ts and candidateFindings.ts).
 *
 * This script re-runs `scanMenuTRenderGrid` — the SAME function
 * `checkMenuTRenderGrid`'s hardFailure gate calls, no second implementation
 * to drift — over every prompt in a directory and reports per-(type,factKey)
 * before/after counts, so a future change to any decimal-time candidate fact
 * can be measured against this exact criterion rather than re-derived from
 * scratch.
 *
 * Only 4 (type, factKey) pairs have an unambiguous 1:1 timeline marker and
 * are checked (`MENU_T_RENDER_GRID_SPECS` in promptQualityCheck.ts):
 * kick-eaten.t -> [KICK], death.t -> [DEATH], missed-cleanse.t ->
 * [UNCLEANSED DEBUFF], death-setup.deathT -> [DEATH] (death-setup shares its
 * later death's own `t`, so it shares that marker). Explicitly SKIPPED, and
 * why:
 *   - death-setup's OWN `t` (the setup moment, not `deathT`): the matching
 *     marker varies by `facts.kind` (healer-locked -> a [CC ON TEAM] line on
 *     the healer; trinket-early -> a [TRINKET]/[CD] press; defensive-early ->
 *     a [YOU]/[TEAM] [CD] cast of that spell) — no single fixed marker
 *     format, unlike the four pairs above.
 *   - crisis-no-response's `t`: a derived HP-threshold moment (own HP fell to
 *     X% while under burst), not itself a printed timeline event — there is
 *     no marker line to check it against.
 * Extending the spec table to cover these would need a per-kind or
 * per-derivation lookup, not a straight (type, factKey) -> marker map; left
 * as a follow-up if a future audit finds evidence it's worth the complexity.
 *
 * "no-marker" (a fact whose floored second AND floored-second-minus-one both
 * have no matching marker) is reported separately from "off-by-one" and is
 * NOT counted as this bug — `Math.floor(t) - 1` matching is this bug's
 * specific fingerprint. missed-cleanse's 8 no-marker cases on the reference
 * corpus are all late-cleanse windows (`facts.latencyS` present): the
 * timeline correctly omits `[UNCLEANSED DEBUFF]` for those (the CC WAS
 * eventually cleansed, just late — matchTimeline.ts tags the `[CC ON TEAM]`
 * line `[CLEANSED]` instead) and prints no marker for the candidate to match
 * at all, by design, not by a rendering bug.
 *
 * Usage:
 *   npx tsx packages/eval/scripts/menuTRenderGridScan.ts --dir <prompts-dir>
 *
 *   --dir   directory of prompt .txt files (e.g. a corpus run's prompts/)
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";

import {
  MENU_T_RENDER_GRID_SPECS,
  type MenuTRenderGridResult,
  scanMenuTRenderGrid,
} from "../src/quality/promptQualityCheck";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const dir = arg("--dir");
  if (!dir) {
    console.error(
      "Usage: tsx packages/eval/scripts/menuTRenderGridScan.ts --dir <prompts-dir>",
    );
    process.exit(1);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  if (files.length === 0) {
    console.error(`No .txt prompt files found under ${dir}`);
    process.exit(1);
  }

  const keyOf = (type: string, factKey: string) => `${type}.${factKey}`;
  const perKey = new Map<
    string,
    { total: number; ok: number; offByOne: number; noMarker: number }
  >();
  for (const spec of MENU_T_RENDER_GRID_SPECS)
    perKey.set(keyOf(spec.type, spec.factKey), {
      total: 0,
      ok: 0,
      offByOne: 0,
      noMarker: 0,
    });

  const offByOneExamples: Record<
    string,
    { file: string; result: MenuTRenderGridResult }[]
  > = {};
  const noMarkerExamples: Record<
    string,
    { file: string; result: MenuTRenderGridResult }[]
  > = {};

  for (const file of files) {
    const text = readFileSync(path.join(dir, file), "utf-8");
    const lines = text.split("\n");
    const results = scanMenuTRenderGrid(lines);
    for (const r of results) {
      const key = keyOf(r.type, r.factKey);
      const bucket = perKey.get(key)!;
      bucket.total++;
      if (r.status === "ok") bucket.ok++;
      else if (r.status === "off-by-one") {
        bucket.offByOne++;
        offByOneExamples[key] ??= [];
        if (offByOneExamples[key].length < 5)
          offByOneExamples[key].push({ file, result: r });
      } else {
        bucket.noMarker++;
        noMarkerExamples[key] ??= [];
        if (noMarkerExamples[key].length < 5)
          noMarkerExamples[key].push({ file, result: r });
      }
    }
  }

  console.log(`Scanned ${files.length} prompt file(s) under ${dir}\n`);
  console.log(
    "type.factKey".padEnd(22) +
      "total".padStart(8) +
      "ok".padStart(8) +
      "off-by-one".padStart(14) +
      "no-marker".padStart(12),
  );
  for (const [key, c] of perKey) {
    console.log(
      key.padEnd(22) +
        String(c.total).padStart(8) +
        String(c.ok).padStart(8) +
        String(c.offByOne).padStart(14) +
        String(c.noMarker).padStart(12),
    );
  }

  console.log();
  for (const spec of MENU_T_RENDER_GRID_SPECS) {
    const key = keyOf(spec.type, spec.factKey);
    const c = perKey.get(key)!;
    if (c.offByOne === 0) continue;
    console.log(
      `${key}: ${c.offByOne}/${c.total} (${((c.offByOne / c.total) * 100).toFixed(1)}%) render one grid-second past their [${spec.marker.replace(/[[\]]/g, "")}] marker`,
    );
    for (const ex of offByOneExamples[key] ?? []) {
      console.log(
        `  ${ex.file}: line ${ex.result.lineIndex + 1} ${spec.factKey}=${ex.result.t} (floors to ${ex.result.flooredSecond}s, marker at ${ex.result.flooredSecond - 1}s)`,
      );
    }
  }

  console.log();
  for (const spec of MENU_T_RENDER_GRID_SPECS) {
    const key = keyOf(spec.type, spec.factKey);
    const c = perKey.get(key)!;
    if (c.noMarker === 0) continue;
    console.log(
      `${key}: ${c.noMarker}/${c.total} no [${spec.marker.replace(/[[\]]/g, "")}] marker at floor(${spec.factKey}) OR floor(${spec.factKey})-1 (NOT this bug — investigate separately; see script header for the missed-cleanse late-cleanse explanation)`,
    );
    for (const ex of noMarkerExamples[key] ?? []) {
      console.log(
        `  ${ex.file}: line ${ex.result.lineIndex + 1} ${spec.factKey}=${ex.result.t} (floors to ${ex.result.flooredSecond}s)`,
      );
    }
  }

  const grandOffByOne = [...perKey.values()].reduce(
    (s, c) => s + c.offByOne,
    0,
  );
  console.log();
  if (grandOffByOne === 0)
    console.log("No render-grid rounding failures found.");
  else console.log(`Total off-by-one (this bug): ${grandOffByOne}`);
}

main();
