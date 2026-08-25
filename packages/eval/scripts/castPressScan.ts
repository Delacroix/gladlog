/**
 * BACKLOG #36(a) validation: how much of the raw SPELL_CAST_SUCCESS stream was
 * never a button press, per spec, and does the reduction reproduce the
 * research anchors (Preservation Evoker's count nearly halves once echo copies
 * go; Divine Hymn deflates ~5×)?
 *
 * Runs the PRODUCT predicate (`filterRealPresses`) — not a reimplementation.
 *
 * Usage: npx tsx packages/eval/scripts/castPressScan.ts <archiveRoot> [maxRounds]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { ensureAnalysisData, specToString } from "@gladlog/analysis";
import { filterRealPresses } from "@gladlog/analysis/src/utils/castPress";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 3300);

function newSeasonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".txt.gz")) out.push(p);
    }
  };
  walk(dir);
  return out
    .filter((p) => {
      const m = /\/2026\/08\/(\d{2})\//.exec(p);
      return m != null && Number(m[1]) >= 12;
    })
    .sort();
}

let rounds = 0;
const bySpec = new Map<string, { raw: number; real: number; units: number }>();
let hymnRaw = 0;
let hymnReal = 0;

outer: for (const file of newSeasonFiles(root)) {
  const items: GladMatch[] = [];
  try {
    const text = gunzipSync(readFileSync(file)).toString("utf8");
    const p = new GladLogParser();
    p.on("match", (m: GladMatch) => items.push(m));
    p.on("shuffle", (sh) => {
      for (const r of sh.rounds) items.push(r as never);
    });
    for (const line of text.split("\n")) p.push(line);
    p.end();
  } catch {
    continue;
  }
  for (const m of items) {
    if (rounds >= maxRounds) break outer;
    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    rounds++;
    for (const u of Object.values(legacy.units)) {
      if (!u.info) continue;
      const casts = u.spellCastEvents.filter(
        (e) => e.logLine.event === "SPELL_CAST_SUCCESS",
      );
      const real = filterRealPresses(casts);
      const spec = specToString(u.spec);
      const st = bySpec.get(spec) ?? { raw: 0, real: 0, units: 0 };
      st.raw += casts.length;
      st.real += real.length;
      st.units++;
      bySpec.set(spec, st);
      // Divine Hymn press 64843 vs tick 64844 — the research 5× anchor.
      hymnRaw += casts.filter(
        (e) => e.spellId === "64843" || e.spellId === "64844",
      ).length;
      hymnReal += real.filter(
        (e) => e.spellId === "64843" || e.spellId === "64844",
      ).length;
    }
  }
}

console.log(`rounds=${rounds}\n`);
console.log(
  "spec                        raw casts    real presses   removed   (anchor)",
);
for (const [spec, st] of [...bySpec.entries()]
  .filter(([, st]) => st.units >= 30)
  .sort((a, b) => 1 - a[1].real / a[1].raw - (1 - b[1].real / b[1].raw))
  .reverse()) {
  const removed = `${(((st.raw - st.real) / st.raw) * 100).toFixed(1)}%`;
  const anchor =
    spec === "Preservation Evoker"
      ? "research: casts nearly double without the cut"
      : "";
  console.log(
    `${spec.padEnd(26)}${String(st.raw).padStart(9)}${String(st.real).padStart(13)}${removed.padStart(10)}   ${anchor}`,
  );
}
console.log(
  `\nDivine Hymn (press 64843 + tick 64844): raw=${hymnRaw} real=${hymnReal} (research anchor: ~5× inflation)`,
);
