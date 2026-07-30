import {
  parseCsv,
  fetchLatestBuild,
  fetchTable,
  assertColumns,
} from "./lib/wagoCsv";
import { writeArtifact } from "./lib/emit";
import spellIdLists from "../../src/data/spellIdLists";

/** AURA_MOD_DAMAGE_PERCENT_TAKEN:EffectBasePointsF=负百分比,
 * EffectMiscValue_0=学派掩码(与日志 spellSchoolId 同位义)。 */
const MITIGATION_AURA = "87";

export interface IMitigationRaw {
  pct: number;
  schoolMask: number;
}

export function transformMitigation(
  csvText: string,
  whitelistIds: ReadonlySet<string>,
): {
  entries: Record<string, IMitigationRaw>;
  unresolved: Array<{ id: string; reason: string }>;
} {
  const { rows } = parseCsv(csvText);
  const seen = new Map<string, IMitigationRaw[]>();
  for (const row of rows) {
    if (row.DifficultyID !== "0") continue;
    if (row.EffectAura !== MITIGATION_AURA) continue;
    const id = row.SpellID;
    if (!whitelistIds.has(id)) continue;
    const points = Number(row.EffectBasePointsF);
    const mask = Number(row.EffectMiscValue_0);
    const arr = seen.get(id) ?? [];
    arr.push({ pct: points, schoolMask: mask }); // 暂存原始符号,收敛时判
    seen.set(id, arr);
  }
  const entries: Record<string, IMitigationRaw> = {};
  const unresolved: Array<{ id: string; reason: string }> = [];
  for (const [id, hits] of seen) {
    const uniq = [...new Set(hits.map((h) => `${h.pct}:${h.schoolMask}`))];
    if (uniq.length > 1) {
      unresolved.push({ id, reason: "multiple-conflicting-87-rows" });
      continue;
    }
    const h = hits[0]!;
    if (h.pct >= 0) {
      unresolved.push({ id, reason: "positive-points" });
      continue;
    }
    entries[id] = {
      pct: Math.abs(Math.round(h.pct)),
      schoolMask: h.schoolMask,
    };
  }
  return { entries, unresolved };
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const csv = await fetchTable("SpellEffect", build, process.env.DATAGEN_CACHE);
  assertColumns(
    parseCsv(csv).header,
    [
      "ID",
      "DifficultyID",
      "EffectAura",
      "EffectBasePointsF",
      "EffectMiscValue_0",
      "SpellID",
    ],
    "SpellEffect",
  );
  const wl = new Set([
    ...spellIdLists.bigDefensiveSpellIds,
    ...spellIdLists.externalDefensiveSpellIds,
  ]);
  const r = transformMitigation(csv, wl);
  const outPath = new URL(
    "../../src/data/mitigationGenerated.json",
    import.meta.url,
  ).pathname;
  writeArtifact(outPath, JSON.stringify(r, null, 2)); // 小表,pretty 便于人审 diff
  console.log(
    `entries=${Object.keys(r.entries).length} unresolved=${r.unresolved.length}`,
    build,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genMitigation.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
