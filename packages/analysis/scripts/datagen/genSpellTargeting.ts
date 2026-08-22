/**
 * Official targeting facts: does a spell's effect reach a FRIENDLY unit other
 * than the caster? Source: DB2 `SpellEffect.ImplicitTarget_0/_1`.
 *
 * Why this table exists (GH #28, 2026-08-22): the coach accused a Priest of
 * not pressing Desperate Prayer (19236) to save a dying teammate. Desperate
 * Prayer heals the caster and nobody else. No hand table was wrong — the
 * predicate simply had no "can this reach an ally at all" dimension, so every
 * Defensive-tagged cooldown in the owner's kit counted as an answer to a
 * teammate's crisis. The only list that expressed "castable on an ally"
 * (`externalDefensiveSpellIds`, 14 hand entries) is a curated list, and by
 * CLAUDE.md's Curated-List Completeness Rule it can only ever prove there are
 * no false positives — it silently missed Tranquility / Divine Hymn / Aura
 * Mastery, which DO reach allies.
 *
 * The rule (validated against both directions of ground truth, see the
 * assertions at the bottom of this script):
 *
 *  1. Take the spell's `DifficultyID == 0` effect rows.
 *  2. Prefer real effects: rows with `Effect != 3` (3 = DUMMY). Dummy rows
 *     count only when the spell has NO real rows at all. Trap this avoids:
 *     Obsidian Scales (363916) carries a leftover `Effect=3, ImplicitTarget=21
 *     (UNIT_TARGET_ALLY)` slot that would mark a self-only dragon defensive as
 *     ally-reaching. Trap the fallback preserves: Rallying Cry (97462) is
 *     implemented ENTIRELY as dummy rows (`Effect=3`, target 56 = caster-area
 *     party) and would otherwise read as self-only.
 *  3. Follow ONE `EffectTriggerSpell` hop. Trap this avoids: Divine Hymn
 *     (64843) and Tranquility (740) target only the caster themselves — the
 *     ally healing lives in the triggered spells 64844 / 157982. Measured
 *     safe on the other direction too: Cloak of Shadows (35729) and Unending
 *     Resolve (449587) trigger self-only spells, so the hop adds no false
 *     positives there.
 *  4. `reachesOthers = true` iff any considered target is in
 *     `ALLY_IMPLICIT_TARGETS`.
 *
 * `ALLY_IMPLICIT_TARGETS` is a decoding table for an official enum, not a
 * spell allowlist — but it is still a hand-maintained set, so the generator
 * ASSERTS both directions before writing (see `verify()`): every id in
 * `externalDefensiveSpellIds` (ground truth for "reaches an ally") must come
 * out true, and a control set of unambiguous personal defensives must come out
 * false. A patch that introduces a new friendly-target enum value turns this
 * script red on its next run instead of silently marking a real external
 * self-only.
 */
import fs from "fs-extra";

import { classMetadata } from "../../src/data/classSpells";
import spellIdLists from "../../src/data/spellIdLists";
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  assertMinRows,
  fetchTable,
  parseCsv,
  resolveBuild,
} from "./lib/wagoCsv";

/**
 * SpellImplicitTarget values that denote a FRIENDLY unit other than (or in
 * addition to) the caster. Each value is listed with the spells in the
 * defensive universe that use it — the evidence it was derived from
 * (2026-08-22 scan of build 12.1.0.69382, all 47 Defensive-tagged cooldowns in
 * classMetadata plus every `externalDefensiveSpellIds` entry).
 *
 * NOT included, deliberately: 1 (UNIT_CASTER — self), 22 (SRC_CASTER, a
 * location rather than a unit; only ever seen alongside a real ally target on
 * Divine Hymn / Tranquility), 6 (UNIT_TARGET_ENEMY — Touch of Karma), 0 (no
 * target).
 */
const ALLY_IMPLICIT_TARGETS = new Set<string>([
  "18", // DEST_AREA_ALLY — Zephyr
  "21", // UNIT_TARGET_ALLY — Pain Suppression, Ironbark, Life Cocoon, Guardian Spirit, Time Dilation
  "29", // DEST_DYNOBJ_ALLY — Tranquility
  "30", // UNIT_SRC_AREA_ALLY — Tranquility/Divine Hymn (via their triggered spells)
  "31", // UNIT_DEST_AREA_ALLY — Power Word: Barrier, Anti-Magic Zone, Zephyr
  "56", // UNIT_CASTER_AREA_RAID — Rallying Cry, Aura Mastery
  "57", // UNIT_TARGET_ALLY_PARTY — Blessing of Protection / Sacrifice / Spellwarding
  "62", // UNIT_CASTER_AREA_PARTY — Darkness
  "87", // UNIT_AREA_ALLY (totem/ground) — Spirit Link Totem
]);

/** Ground truth A — must all be `true`. Curated "castable on a teammate" list;
 *  this direction catches a friendly-target enum value we failed to decode. */
const MUST_REACH_ALLY = spellIdLists.externalDefensiveSpellIds as string[];

/** Ground truth B — must all be `false`. Unambiguous personal defensives (the
 *  ones the coach was wrongly demanding be spent on a teammate); this
 *  direction catches an over-broad decode. */
const MUST_BE_SELF_ONLY = [
  "19236", // Desperate Prayer (the GH #28 report)
  "642", // Divine Shield
  "45438", // Ice Block
  "871", // Shield Wall
  "48792", // Icebound Fortitude
  "104773", // Unending Resolve
  "115203", // Fortifying Brew
  "31224", // Cloak of Shadows
  "61336", // Survival Instincts
  "108271", // Astral Shift
  "363916", // Obsidian Scales (the dummy-effect trap)
  "22812", // Barkskin
  "5277", // Evasion
  "118038", // Die by the Sword
  "185311", // Crimson Vial
  "11426", // Ice Barrier
  "47585", // Dispersion
];

type EffectRow = {
  effect: string;
  trigger: string;
  targets: string[];
};

function considered(rows: EffectRow[]): EffectRow[] {
  const real = rows.filter((r) => r.effect !== "3");
  return real.length > 0 ? real : rows;
}

function reachesOthers(
  spellId: string,
  bySpell: Map<string, EffectRow[]>,
  hop = true,
): boolean {
  for (const row of considered(bySpell.get(spellId) ?? [])) {
    if (row.targets.some((t) => ALLY_IMPLICIT_TARGETS.has(t))) return true;
    if (hop && row.trigger && row.trigger !== "0") {
      if (reachesOthers(row.trigger, bySpell, false)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const build = await resolveBuild(process.argv[2]);
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

  // Universe: the mined spell set (the same one spellEffectGenerated.json
  // covers) plus every ability the class catalog and the defensive lists name.
  // Deliberately NOT "only the defensive ids we care about" — that would make
  // a hand list decide which ids the official lookup even runs on, the exact
  // shape CLAUDE.md's Curated-List Completeness Rule is about.
  const mined = JSON.parse(
    fs.readFileSync(
      new URL("../../src/data/spellEffectGenerated.json", import.meta.url)
        .pathname,
      "utf8",
    ),
  ) as Record<string, unknown>;
  const universe = new Set<string>([
    ...Object.keys(mined),
    ...classMetadata.flatMap((c) => c.abilities.map((a) => a.spellId)),
    ...(spellIdLists.externalDefensiveSpellIds as string[]),
    ...(spellIdLists.externalOrBigDefensiveSpellIds as string[]),
  ]);

  const parsed = parseCsv(await fetchTable("SpellEffect", build, cacheDir));
  assertColumns(
    parsed.header,
    [
      "SpellID",
      "DifficultyID",
      "Effect",
      "EffectTriggerSpell",
      "ImplicitTarget_0",
      "ImplicitTarget_1",
    ],
    "SpellEffect",
  );
  assertMinRows(parsed.rows, 500000, "SpellEffect");

  // Two passes: the universe first, then the spells its effects trigger (the
  // one hop). Rows outside both sets are dropped so the map stays small.
  const bySpell = new Map<string, EffectRow[]>();
  const add = (sid: string, row: EffectRow): void => {
    const list = bySpell.get(sid);
    if (list) list.push(row);
    else bySpell.set(sid, [row]);
  };
  const rowOf = (r: Record<string, string>): EffectRow => ({
    effect: r.Effect,
    trigger: r.EffectTriggerSpell,
    targets: [r.ImplicitTarget_0, r.ImplicitTarget_1].filter(
      (t) => t && t !== "0",
    ),
  });
  for (const r of parsed.rows) {
    if (r.DifficultyID !== "0") continue;
    if (!universe.has(r.SpellID)) continue;
    add(r.SpellID, rowOf(r));
  }
  const triggered = new Set<string>();
  for (const rows of bySpell.values())
    for (const r of rows)
      if (r.trigger && r.trigger !== "0" && !bySpell.has(r.trigger))
        triggered.add(r.trigger);
  for (const r of parsed.rows) {
    if (r.DifficultyID !== "0") continue;
    if (!triggered.has(r.SpellID)) continue;
    add(r.SpellID, rowOf(r));
  }

  const out: Record<string, boolean> = {};
  for (const id of [...universe].sort((a, b) => Number(a) - Number(b))) {
    if (!bySpell.has(id)) continue; // no official effect rows → unknown, absent
    out[id] = reachesOthers(id, bySpell);
  }

  // ── both directions of ground truth, before anything is written ──────────
  const missingAlly = MUST_REACH_ALLY.filter((id) => out[id] !== true);
  const missingSelf = MUST_BE_SELF_ONLY.filter((id) => out[id] !== false);
  if (missingAlly.length > 0 || missingSelf.length > 0) {
    throw new Error(
      `genSpellTargeting: ground-truth check failed — ` +
        `ally-castable ids not marked reachesOthers: [${missingAlly.join(", ")}]; ` +
        `personal defensives wrongly marked reachesOthers: [${missingSelf.join(", ")}]. ` +
        `A new SpellImplicitTarget value probably needs decoding in ALLY_IMPLICIT_TARGETS.`,
    );
  }

  const reaching = Object.values(out).filter(Boolean).length;
  const jsonPath = new URL(
    "../../src/data/spellTargetingGenerated.json",
    import.meta.url,
  ).pathname;
  const tsPath = new URL(
    "../../src/data/spellTargetingGenerated.ts",
    import.meta.url,
  ).pathname;
  writeArtifact(jsonPath, JSON.stringify(out) + "\n");
  writeArtifact(
    tsPath,
    `/**\n` +
      ` * Generated at: ${new Date().toISOString()}\n` +
      ` * Build: ${build}\n` +
      ` * Source: DB2 SpellEffect.ImplicitTarget_0/_1 (DifficultyID 0), dummy\n` +
      ` *   effects ignored unless they are all the spell has, one\n` +
      ` *   EffectTriggerSpell hop followed. See scripts/datagen/genSpellTargeting.ts\n` +
      ` *   for the rule, the traps it encodes and the two-directional\n` +
      ` *   ground-truth assertion.\n` +
      ` * true  = at least one effect reaches a FRIENDLY unit other than the caster\n` +
      ` * false = the spell only ever affects the caster (and/or enemies)\n` +
      ` * absent = no official effect row; consumers must fall back, never assume\n` +
      ` * ids: ${Object.keys(out).length} (${reaching} reach others)\n` +
      ` * The data lives in the .json of the same name (vite json.stringify ->\n` +
      ` * JSON.parse loading — the big-JSON lesson).\n` +
      ` */\n\n` +
      `import raw from "./spellTargetingGenerated.json";\n\n` +
      `export const SPELL_REACHES_OTHERS_GENERATED: Record<string, boolean> =\n` +
      `  raw as Record<string, boolean>;\n`,
  );
  console.log(
    `spellTargetingGenerated: ${Object.keys(out).length} ids, ${reaching} reach others (build ${build})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
