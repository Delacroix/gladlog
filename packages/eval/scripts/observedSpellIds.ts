/**
 * 语料实证 spell id 全集(常驻,update-wow-data 配套):全量语料里
 * casts/auraEvents/actionsOut 出现过的 spellId(仅 id,公共安全)。
 * genSpellIcons 用它把图标宇宙从 SpellMisc 全表(40.8万,13.8MB,爆首渲
 * 预算)收敛到实战出现过的集合,覆盖率不损。
 * Usage: tsx observedSpellIds.ts --manifest <file> [--store <matches dir>]
 *   > .../observedSpellIdsGenerated.json
 * --store 直读入库 match.json(含新补丁对局,免重解析)。
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
