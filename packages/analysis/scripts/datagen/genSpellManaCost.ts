/**
 * Per-spell mana cost table (BACKLOG #26 Task 4, raw-streams plan): mines
 * DB2 `SpellPower` for the observed universe's mana-type (`PowerType`=0)
 * spells — consumed by `mana-efficiency`'s per-spell "mana spent vs
 * effective healing bought" aggregate (candidateFindings.ts's
 * `manaEfficiencyEvents`, feature-flagged off by default).
 *
 * Column semantics (verified 2026-08-15 against build 12.1.0.69273's live
 * `SpellPower` CSV — see task-4-report.md for the full derivation):
 * `PowerCostPct` is "% of the caster's base max mana per cast" (the
 * near-universal encoding for current-era abilities); `ManaCost` is a flat
 * absolute cost, mutually exclusive with `PowerCostPct` in every observed
 * row (only 4 of 295 observed mana-type spells use it, none healing-
 * relevant). Anchor cross-check (`spellManaCost.test.ts`): Holy Shock
 * (20473, unconditional row) reads `PowerCostPct=2`; the healer's own raw.txt
 * mana samples around a real Holy Shock cast in match 60ab1e8f show a
 * 5591/273000 = 2.05% drop across the 0.017s gap to the next logged
 * event for that unit — empirically confirms "% of manaMax", not literal
 * mana points or some other unit.
 *
 * **Spec-conditional cost** (the non-obvious part): some spells are shared
 * across a class's specs with a DIFFERENT `PowerCostPct` per spec (e.g.
 * Flash Heal costs 2.61% for a Holy Priest but 10% for a Shadow Priest) —
 * `SpellPower` encodes this as multiple rows for the same `SpellID`, each
 * gated behind a `RequiredAuraSpellID` that is one of a small, stable family
 * of "always-on spec-passive" auras (137007-137050, 212612, 356809/356810,
 * 396186 — one per class/spec combination in the current SpellPower table).
 * Naively picking "the first row" or "the unconditional default row" for a
 * spell like Flash Heal would silently misjudge a Holy Priest's efficiency
 * by ~4x (10% vs the true 2.61%) — confirmed by fetching wowhead's generic
 * Flash Heal page, which shows the class-default 10% with no spec
 * disambiguation, i.e. the exact wrong number this table exists to avoid.
 * `REQUIRED_AURA_TO_SPEC` below maps each such aura id to the
 * `CombatUnitSpec` id (packages/parser-compat/src/enumsGenerated.ts) it
 * gates, so a spell with spec-conditional rows is stored as
 * `{ bySpec: { [specId]: { pct } } }` instead of a single ambiguous value.
 * "Initial <Class>" auras (417191/417374/417382/417383/356816) are the
 * no-spec-chosen placeholder state (never true for an actual played
 * character) and are deliberately left unmapped — their rows are dropped,
 * never misattributed to a real spec.
 *
 * Scope: restricted to `observedSpellIdsGenerated.json` (spells this
 * library's corpus has actually seen cast), the same "keep it to the
 * observed universe" convention `genOffGcd.ts` uses — 295 of SpellPower's
 * ~5700 rows, no separate healing-spell whitelist needed (a spell nobody in
 * the corpus has cast cannot feed a real candidate anyway).
 */
import fs from "fs-extra";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  assertMinRows,
  resolveBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

export interface ISpellManaCostRaw {
  /** % of the caster's base max mana per cast (SpellPower.PowerCostPct). */
  pct?: number;
  /** Flat absolute mana cost (SpellPower.ManaCost) — mutually exclusive with
   * `pct` in every row observed so far; present only when `pct` is absent. */
  flat?: number;
}

export interface ISpellManaCostRow extends ISpellManaCostRaw {
  /** Present when this spell's SpellPower rows are gated behind a
   * spec-passive `RequiredAuraSpellID` (cost differs by casting spec) —
   * keyed by `CombatUnitSpec` id, see `REQUIRED_AURA_TO_SPEC` above. When
   * both this and the base `pct`/`flat` are present, the base fields are the
   * spell's one spec-agnostic (RequiredAuraSpellID=0) row; when only
   * `bySpec` is present (e.g. Flash Heal), the spell has no unconditional
   * row at all and an unknown/unmapped spec cannot resolve a cost. */
  bySpec?: Record<string, ISpellManaCostRaw>;
}

const REQUIRED_AURA_TO_SPEC: Record<string, string> = {
  "137007": "252", // Unholy Death Knight
  "137008": "250", // Blood Death Knight
  "137010": "104", // Guardian Druid
  "137011": "103", // Feral Druid
  "137012": "105", // Restoration Druid
  "137013": "102", // Balance Druid
  "137023": "268", // Brewmaster Monk
  "137024": "270", // Mistweaver Monk
  "137025": "269", // Windwalker Monk
  "137027": "70", // Retribution Paladin
  "137028": "66", // Protection Paladin
  "137029": "65", // Holy Paladin
  "137031": "257", // Holy Priest
  "137032": "256", // Discipline Priest
  "137033": "258", // Shadow Priest
  "137039": "264", // Restoration Shaman
  "137040": "262", // Elemental Shaman
  "137041": "263", // Enhancement Shaman
  "137049": "71", // Arms Warrior
  "137050": "72", // Fury Warrior
  "212612": "577", // Havoc Demon Hunter
  "356809": "1467", // Devastation Evoker
  "356810": "1468", // Preservation Evoker
  "396186": "1473", // Augmentation Evoker
};

function costEntry(row: Record<string, string>): ISpellManaCostRaw {
  const pct = Number(row.PowerCostPct);
  const flat = Number(row.ManaCost);
  const entry: ISpellManaCostRaw = {};
  if (Number.isFinite(pct) && pct > 0) entry.pct = pct;
  if (Number.isFinite(flat) && flat > 0) entry.flat = flat;
  return entry;
}

/**
 * The core transform, taking already-parsed rows (same reuse-the-parse
 * shape as `genMitigation.ts`'s `transformMitigationRows`).
 */
export function transformSpellManaCostRows(
  rows: Record<string, string>[],
  observedIds: ReadonlySet<string>,
): Record<string, ISpellManaCostRow> {
  const bySpell = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    if (row.PowerType !== "0") continue; // mana only
    const sid = row.SpellID;
    if (!sid || !observedIds.has(sid)) continue;
    const arr = bySpell.get(sid) ?? [];
    arr.push(row);
    bySpell.set(sid, arr);
  }

  const table: Record<string, ISpellManaCostRow> = {};
  for (const [sid, spellRows] of bySpell) {
    const unconditional = spellRows.filter(
      (r) => r.RequiredAuraSpellID === "0",
    );
    const conditional = spellRows.filter((r) => r.RequiredAuraSpellID !== "0");
    const entry: ISpellManaCostRow = {};
    if (unconditional.length > 0) {
      Object.assign(entry, costEntry(unconditional[0]!));
    }
    if (conditional.length > 0) {
      const bySpec: Record<string, ISpellManaCostRaw> = {};
      for (const row of conditional) {
        const specId = REQUIRED_AURA_TO_SPEC[row.RequiredAuraSpellID];
        if (!specId) continue; // unmapped aura (e.g. "Initial <Class>") — cannot attribute to a real spec
        bySpec[specId] = costEntry(row);
      }
      if (Object.keys(bySpec).length > 0) entry.bySpec = bySpec;
    }
    const hasAnything =
      entry.pct !== undefined || entry.flat !== undefined || entry.bySpec;
    if (!hasAnything) continue;
    table[sid] = entry;
  }
  return table;
}

export async function main(): Promise<void> {
  const build = await resolveBuild(process.argv[2]);
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;
  const observed = new Set(
    (
      JSON.parse(
        fs.readFileSync(
          new URL(
            "../../src/data/observedSpellIdsGenerated.json",
            import.meta.url,
          ).pathname,
          "utf8",
        ),
      ) as number[]
    ).map(String),
  );
  const parsed = parseCsv(await fetchTable("SpellPower", build, cacheDir));
  assertMinRows(parsed.rows, 1000, "SpellPower");
  assertColumns(
    parsed.header,
    ["SpellID", "PowerType", "PowerCostPct", "ManaCost", "RequiredAuraSpellID"],
    "SpellPower",
  );
  const table = transformSpellManaCostRows(parsed.rows, observed);
  const outPath = new URL(
    "../../src/data/spellManaCostGenerated.json",
    import.meta.url,
  ).pathname;
  // small table; pretty-printing keeps the diff human-reviewable
  writeArtifact(outPath, `${JSON.stringify({ entries: table }, null, 2)}\n`);
  console.log(
    `spellManaCostGenerated.json: ${Object.keys(table).length} spells (build ${build})`,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genSpellManaCost.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
