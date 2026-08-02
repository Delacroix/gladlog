/**
 * The corpus-observed spell id set (permanent, companion to update-wow-data):
 * every spellId that appeared in casts / auraEvents / actionsOut across the full
 * corpus (ids only, safe to publish).
 * genSpellIcons uses it to shrink the icon universe from the whole SpellMisc
 * table (408k entries, 13.8MB, blowing the first-render budget) down to the set
 * actually seen in play, with no loss of coverage.
 * Usage: tsx observedSpellIds.ts --manifest <file> [--store <matches dir>]
 *   > .../observedSpellIdsGenerated.json
 * --store reads the stored match.json directly (covering matches from new game
 * patches, with no re-parsing).
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { GladLogParser, type GladMatch } from "@gladlog/parser";

const argv = process.argv.slice(2);
const mIdx = argv.indexOf("--manifest");
if (mIdx < 0) {
  console.error("Usage: observedSpellIds --manifest <file>");
  process.exit(1);
}
const ids = new Set<number>();
for (const f of readFileSync(argv[mIdx + 1]!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
  const parser = new GladLogParser();
  const items: GladMatch[] = [];
  parser.on("match", (m) => items.push(m));
  parser.on("shuffle", (s) => items.push(...(s.rounds as never[])));
  for (const line of readFileSync(f, "utf8").split("\n")) parser.push(line);
  parser.end();
  for (const m of items)
    for (const u of Object.values(m.units))
      for (const arr of [u.casts, u.castStarts, u.petCasts, u.auraEvents, u.actionsOut, u.damageOut, u.healOut] as const)
        for (const e of arr) if (e.spellId) ids.add(Number(e.spellId));
}
const sIdx = argv.indexOf("--store");
if (sIdx >= 0) {
  const dir = argv[sIdx + 1]!;
  for (const id of readdirSync(dir)) {
    const p2 = join(dir, id, "match.json");
    if (!existsSync(p2)) continue;
    try {
      const doc = JSON.parse(readFileSync(p2, "utf8"));
      const sources = doc.data?.rounds ?? [doc.data];
      for (const src of sources)
        for (const u of Object.values(src?.units ?? {}) as {
          [k: string]: { spellId?: number | string }[];
        }[])
          for (const arr of ["casts", "castStarts", "petCasts", "auraEvents", "actionsOut", "damageOut", "healOut"])
            for (const e of (u[arr] ?? []) as { spellId?: number | string }[])
              if (e.spellId) ids.add(Number(e.spellId));
    } catch {
      /* skip */
    }
  }
}
process.stdout.write(JSON.stringify([...ids].sort((a, b) => a - b)));
console.error(`observed spell ids: ${ids.size}`);
