/**
 * Talent-granted damage reduction (2026-08-18).
 *
 * Why this exists: `genMitigation.ts` reads the same official DB2 aura
 * (`AURA_MOD_DAMAGE_PERCENT_TAKEN` = 87) but gates its input on a **46-id hand
 * whitelist** (`bigDefensiveSpellIds` + `externalDefensiveSpellIds` +
 * `attributedMitigationSpellIds`). Every mitigation that a *talent* grants —
 * hero-talent passives, PvP talents, conditional DR hanging off a mobility
 * ability — is therefore invisible **by construction, not by data absence**:
 * DB2 has the rows, the generator never asks for those ids. The 2026-08-18
 * measurement that motivated this: 26.1% of enemy snapshots in a 1228-round
 * scan had *zero* tracked defensives, which is what made
 * `killWindowTargetSelection`'s softness score incomparable across enemies.
 *
 * What this generator does differently: same extraction predicate (it imports
 * `transformMitigation`, it does NOT re-implement it — shared-predicate rule),
 * different input universe = every spell id reachable from a talent:
 *   - raidbots `talentIdMap.json` class/spec/hero nodes (`entries[].spellId`,
 *     including `type: "passive"`), and
 *   - `PVP_TALENT_POOL_GENERATED` (DB2 PvpTalent), which the node tree does not
 *     contain. Ancient of Lore (473909) is the positive control for this half:
 *     it is a PvP talent, it carries `EffectAura=87 EffectBasePointsF=-30`, and
 *     a node-tree-only universe misses it (BACKLOG #24-9 recorded it as a
 *     missing table entry; it is actually 30%, not the 20% noted there).
 *
 * What it deliberately does NOT resolve — `pendingRuling`: a meaningful share
 * of talent DR is encoded as `EffectAura=4` (DUMMY / script-driven). The number
 * is present (e.g. 431873 Temporality, a Chronowarden hero talent, carries
 * `-20`) but **nothing in DB2 says that -20 is a damage-reduction percent**
 * rather than a cost, a cooldown, or a proc chance — the same shape lands on
 * entries that are plainly not mitigation (374277 Improved Death Strike -50).
 * Machine extraction cannot settle it, so those ids are emitted as an explicit
 * ruling queue instead of being guessed at or silently dropped: the queue is
 * regenerated on every data refresh, so a new talent cannot go missing quietly.
 * Resolved rulings belong in a signed override layer, same discipline as
 * `MITIGATION_OVERRIDES` / `mitigationVerdicts.ts` (`approved: "YYYY-MM-DD user"`).
 *
 * Absorb shields (`EffectAura=69`) are counted for visibility but not emitted
 * as mitigation: they are a flat absorbed amount, not a percentage, and mixing
 * the two units into one table is what a consumer would get wrong.
 *
 * Usage: `DATAGEN_BUILD=<build> DATAGEN_CACHE=<dir> npx tsx
 * packages/analysis/scripts/datagen/genTalentMitigation.ts`
 */
import { readFileSync } from "node:fs";

import { PVP_TALENT_POOL_GENERATED } from "../../src/data/pvpTalentPoolGenerated";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  assertMinRows,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";
import { transformMitigation } from "./genMitigation";

/** DUMMY aura: value present, meaning not machine-readable. See header. */
const DUMMY_AURA = "4";
/** Absorb shields — counted, not emitted (different unit). See header. */
const ABSORB_AURA = "69";
/** A DUMMY value only plausibly reads as a percentage inside this band. */
const DUMMY_PCT_FLOOR = -100;

interface TalentNodeEntry {
  spellId?: number;
  name?: string;
  type?: string;
}
interface TalentNode {
  id: number;
  name?: string;
  entries?: TalentNodeEntry[];
}
interface TalentSpec {
  specId: number;
  className: string;
  specName: string;
  classNodes?: TalentNode[];
  specNodes?: TalentNode[];
  heroNodes?: TalentNode[];
}

export interface ITalentMitigationProvenance {
  name: string;
  /** Which tree the id came from. */
  source: "class" | "spec" | "hero" | "pvp";
  /** Spec ids that can take it (raidbots specId / PvpTalent SpecID). */
  specIds: number[];
}

/** Builds the talent spell universe with provenance. Exported for tests. */
export function buildTalentUniverse(
  specs: TalentSpec[],
  pvpPool: Record<string, Record<string, string>>,
  spellNames: Record<string, string>,
): Map<string, ITalentMitigationProvenance> {
  const out = new Map<string, ITalentMitigationProvenance>();
  const add = (
    id: string,
    name: string,
    source: ITalentMitigationProvenance["source"],
    specId: number,
  ): void => {
    const prev = out.get(id);
    if (prev) {
      if (!prev.specIds.includes(specId)) prev.specIds.push(specId);
      return;
    }
    out.set(id, {
      name: name || spellNames[id] || "?",
      source,
      specIds: [specId],
    });
  };
  for (const spec of specs) {
    const groups: Array<[ITalentMitigationProvenance["source"], TalentNode[]]> =
      [
        ["class", spec.classNodes ?? []],
        ["spec", spec.specNodes ?? []],
        ["hero", spec.heroNodes ?? []],
      ];
    for (const [source, nodes] of groups) {
      for (const node of nodes) {
        for (const entry of node.entries ?? []) {
          if (!entry.spellId) continue;
          add(
            String(entry.spellId),
            entry.name ?? node.name ?? "",
            source,
            spec.specId,
          );
        }
      }
    }
  }
  // PvP talents are NOT in the node tree — without this half the positive
  // control (473909) is missed. See header.
  for (const [specId, granted] of Object.entries(pvpPool)) {
    for (const id of Object.keys(granted)) {
      add(id, spellNames[id] ?? "", "pvp", Number(specId));
    }
  }
  return out;
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const dataDir = new URL("../../src/data/", import.meta.url).pathname;
  const specs = JSON.parse(
    readFileSync(`${dataDir}talentIdMap.json`, "utf8"),
  ) as TalentSpec[];
  const spellNames = JSON.parse(
    readFileSync(`${dataDir}spellNames.json`, "utf8"),
  ) as Record<string, string>;

  const universe = buildTalentUniverse(
    specs,
    PVP_TALENT_POOL_GENERATED,
    spellNames,
  );

  const csv = await fetchTable("SpellEffect", build, process.env.DATAGEN_CACHE);
  const parsed = parseCsv(csv);
  // Same truncation guard as genMitigation: a partial download must blow up,
  // not silently produce a short table.
  assertMinRows(parsed.rows, 500000, "SpellEffect");
  assertColumns(
    parsed.header,
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

  // Official half: the shared predicate, different universe.
  const ids = new Set(universe.keys());
  const { entries: raw, unresolved } = transformMitigation(csv, ids);

  const entries: Record<
    string,
    { pct: number; schoolMask: number } & ITalentMitigationProvenance
  > = {};
  for (const [id, e] of Object.entries(raw)) {
    const p = universe.get(id)!;
    entries[id] = { ...e, ...p };
  }

  // Ruling queue + absorb census, from the same already-parsed rows.
  const pendingRuling: Array<
    { spellId: string; rawValue: number } & ITalentMitigationProvenance
  > = [];
  const absorbIds = new Set<string>();
  const seenDummy = new Set<string>();
  for (const row of parsed.rows) {
    if (row.DifficultyID !== "0") continue;
    const id = row.SpellID;
    if (!ids.has(id)) continue;
    if (row.EffectAura === ABSORB_AURA) absorbIds.add(id);
    if (row.EffectAura !== DUMMY_AURA) continue;
    const value = Number(row.EffectBasePointsF);
    if (!(value < 0 && value > DUMMY_PCT_FLOOR)) continue;
    // An id already resolved officially needs no ruling.
    if (entries[id] || seenDummy.has(id)) continue;
    seenDummy.add(id);
    pendingRuling.push({ spellId: id, rawValue: value, ...universe.get(id)! });
  }
  pendingRuling.sort((a, b) => a.rawValue - b.rawValue);

  const artifact = {
    _meta: {
      generatedAt: new Date().toISOString(),
      build,
      source:
        "DB2 SpellEffect EffectAura=87 over the talent spell universe " +
        "(talentIdMap class/spec/hero nodes ∪ PvpTalent pool)",
      universeSize: universe.size,
      absorbOnlyCount: absorbIds.size,
      positiveControl: {
        spellId: "473909",
        expect: "PvP talent Ancient of Lore, aura 87 = -30",
        resolved: Boolean(entries["473909"]),
      },
    },
    entries,
    unresolved,
    pendingRuling,
  };

  if (!artifact._meta.positiveControl.resolved) {
    throw new Error(
      "Positive control failed: 473909 (Ancient of Lore) did not resolve. " +
        "Either the PvP talent pool is stale or the aura-87 predicate moved — " +
        "do not ship a table that silently lost its control.",
    );
  }

  writeArtifact(
    `${dataDir}talentMitigationGenerated.json`,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(
    `universe=${universe.size} entries=${Object.keys(entries).length} ` +
      `unresolved=${unresolved.length} pendingRuling=${pendingRuling.length} ` +
      `absorbOnly=${absorbIds.size}`,
    build,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genTalentMitigation.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
