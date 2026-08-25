/**
 * Dump real new-season prompts containing the remaining new tags ([MANA] /
 * [IMMUNE / [EMPOWER) so `smokeTags.ts` can run the real-model smoke on
 * exactly what the product would show — the placeholder-discipline lesson:
 * only a real completion shows whether the model consumes a tag. The
 * `[CC BROKEN]` prompts were already dumped by `followupExamples.ts`; this
 * covers the other three, which as of 2026-08-25 had only unit + corpus
 * validation.
 *
 * For each round we try each friendly player as owner (prompts are
 * owner-anchored; [MANA] renders for healers, [EMPOWER] for Evoker owners)
 * and save the first WANT prompts per tag.
 *
 * Usage: npx tsx packages/eval/scripts/tagPromptDump.ts <archiveRoot> <outDir> [wantPerTag]
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { buildMatchContext, ensureAnalysisData } from "@gladlog/analysis";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";

await ensureAnalysisData();

const root = process.argv[2];
const outDir = process.argv[3];
const WANT = Number(process.argv[4] ?? 3);
mkdirSync(outDir, { recursive: true });

const TAGS: Array<{ key: string; needle: string }> = [
  { key: "mana", needle: "[MANA]" },
  { key: "immune", needle: "[IMMUNE" },
  { key: "empower", needle: "[EMPOWER" },
];
const shown = new Map<string, number>(TAGS.map((t) => [t.key, 0]));
const done = () => TAGS.every((t) => (shown.get(t.key) ?? 0) >= WANT);

function newSeasonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        p.endsWith(".txt.gz") &&
        /\/2026\/08\/(1[2-9]|2\d|3\d)\//.test(p)
      )
        out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

let roundsSeen = 0;
outer: for (const file of newSeasonFiles(root)) {
  if (done()) break;
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
    roundsSeen++;
    if (roundsSeen > 800) break outer;
    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    const players = Object.values(legacy.units).filter((u) => u.info);
    const friends = players.filter(
      (u) => u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = players.filter(
      (u) => u.reaction === CombatUnitReaction.Hostile,
    );
    for (const owner of friends) {
      if (done()) break outer;
      let prompt: string;
      try {
        prompt = buildMatchContext(legacy, friends, enemies, { owner });
      } catch {
        continue;
      }
      for (const t of TAGS) {
        const n = shown.get(t.key) ?? 0;
        if (n >= WANT || !prompt.includes(t.needle)) continue;
        shown.set(t.key, n + 1);
        const dest = path.join(outDir, `prompt_${t.key}_${n + 1}.txt`);
        writeFileSync(dest, prompt);
        const hitCount = prompt
          .split("\n")
          .filter((l) => l.includes(t.needle)).length;
        console.log(
          `saved ${dest}  file=${path.basename(file)} owner=${owner.name} ${t.needle} lines=${hitCount}`,
        );
      }
    }
  }
}
console.log(
  `rounds scanned=${roundsSeen}  ` +
    TAGS.map((t) => `${t.key}=${shown.get(t.key)}/${WANT}`).join(" "),
);
