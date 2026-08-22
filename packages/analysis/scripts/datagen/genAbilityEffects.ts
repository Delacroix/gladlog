/**
 * Ability effect facts (GH #29 stage 2 foundation) — the官方 half of a
 * cooldown's functional profile that no existing generator covers yet:
 * absorb, healing (self vs others), healing-received amplification, and haste.
 *
 * Why these four: the stage-1 audit classified all 48 Defensive-tagged
 * cooldowns and found **11 of them (22.9%) have no damage reduction, absorb or
 * immunity at all** — Desperate Prayer and Exhilaration are pure self-heals,
 * Guardian Spirit and Vampiric Blood amplify healing RECEIVED, Divine Hymn and
 * Tranquility are team heals, Apotheosis and Avenging Crusader are throughput
 * empowers. One three-valued tag calls every one of them "Defensive", so every
 * judgement that means "did you have a WALL" (cd-waste, the low-pressure
 * exemption note, defensive timing labels, death-unused-defensive) is asking a
 * question the tag cannot answer.
 *
 * Together with the already-shipped generators this completes the official
 * side of that profile:
 *   · reaches an ally           → spellTargetingGenerated (GH #28)
 *   · school / immunity masks   → spellSchoolsGenerated   (GH #29 stage 1)
 *   · damage reduction %        → mitigationGenerated + curated overrides
 *   · **this file**             → absorb / heal / healing-received / haste
 * What stays human-signed is documented in `curatedAbilityFacts.ts`
 * (`throughput_role`): "this cooldown empowers your own output" has no DB2
 * field — only a dozen different modifier auras whose meaning hides in a
 * SpellModOp code.
 *
 * Extraction rules (each one has a positive AND a negative control asserted
 * before anything is written — the discipline that caught two shipped bugs on
 * 2026-08-22, both of which were "the control set was missing a whole class"):
 *   · absorb          — `EffectAura = 69` (SCHOOL_ABSORB). DB2 stores 0 points
 *                       (the amount is a spell-power coefficient), so this is
 *                       a boolean, never a number.
 *   · healsSelf       — a heal effect (`Effect` 10 HEAL / 136 HEAL_PCT, or
 *                       aura 8 PERIODIC_HEAL / 20 OBS_MOD_HEALTH) whose target
 *                       is the caster.
 *   · healsOthers     — the same effect families aimed at a friendly target
 *                       (ALLY_IMPLICIT_TARGETS, shared with genSpellTargeting
 *                       so the two generators cannot drift), one
 *                       EffectTriggerSpell hop — Divine Hymn/Tranquility carry
 *                       their ally healing in 64844/157982.
 *   · healingReceived — `EffectAura` 118 (MOD_HEALING_PCT received) or 259,
 *                       points > 0.
 *   · haste           — `EffectAura = 31`, points > 0. The `> 0` guard is load
 *                       bearing: Blessing of Freedom carries an aura-31 row
 *                       with 0 points (a dead slot) and would otherwise read
 *                       as a haste cooldown.
 */
import fs from "fs-extra";

import { classMetadata } from "../../src/data/classSpells";
import spellIdLists from "../../src/data/spellIdLists";
import { ALLY_IMPLICIT_TARGETS } from "./lib/allyTargets";
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  assertMinRows,
  fetchTable,
  parseCsv,
  resolveBuild,
} from "./lib/wagoCsv";

const EFFECT_DUMMY = "3";
/** Effect ids that heal outright. */
const HEAL_EFFECTS = new Set(["10", "136"]);
/** Auras that heal over time / keep health topped up. */
const HEAL_AURAS = new Set(["8", "20"]);
const AURA_ABSORB = "69";
const AURA_HEALING_RECEIVED = new Set(["118", "259"]);
const AURA_HASTE = "31";

export type AbilityEffectFacts = {
  absorbs?: true;
  healsSelf?: true;
  healsOthers?: true;
  /** % increase to healing RECEIVED (Guardian Spirit 60, Life Cocoon 50). */
  healingReceivedPct?: number;
  /** % haste (Dispersion 50, Zephyr 30). */
  hastePct?: number;
};

/** [spellId, field, expected, why] — asserted before writing. */
const CONTROLS: Array<[string, keyof AbilityEffectFacts, boolean, string]> = [
  ["17", "absorbs", true, "真言术:盾 —— 纯吸收"],
  ["11426", "absorbs", true, "寒冰护体 —— 吸收"],
  ["871", "absorbs", false, "盾墙 —— 百分比减伤,不是吸收"],
  ["19236", "healsSelf", true, "绝望祷言 —— 自愈(GH #28 那条)"],
  ["109304", "healsSelf", true, "振奋 —— 自愈"],
  ["22812", "healsSelf", false, "树皮 —— 减伤,不治疗"],
  ["740", "healsOthers", true, "宁静 —— 团队治疗(经一跳 157982)"],
  ["64843", "healsOthers", true, "神圣赞美诗 —— 团队治疗(经一跳 64844)"],
  ["19236", "healsOthers", false, "绝望祷言 —— 只治自己"],
  ["871", "healsOthers", false, "盾墙 —— 不治疗"],
];
const NUMERIC_CONTROLS: Array<
  [string, "healingReceivedPct" | "hastePct", number, string]
> = [
  ["47788", "healingReceivedPct", 60, "守护之魂 —— 受治疗 +60%"],
  ["55233", "healingReceivedPct", 30, "鲜血之力 —— 受治疗 +30%"],
  ["47585", "hastePct", 50, "消散 —— 加速 50%"],
];
/** 反向:这些**不许**有对应字段(1044 的 aura31 是 0 点死槽)。 */
const NEGATIVE_NUMERIC: Array<[string, keyof AbilityEffectFacts, string]> = [
  ["1044", "hastePct", "自由祝福 —— aura31 但 0 点,是死槽不是加速"],
  ["33206", "healingReceivedPct", "苦修 —— 减伤,不改受治疗量"],
];

async function main(): Promise<void> {
  const build = await resolveBuild(process.argv[2]);
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;

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
      "EffectAura",
      "EffectTriggerSpell",
      "EffectBasePointsF",
      "ImplicitTarget_0",
      "ImplicitTarget_1",
    ],
    "SpellEffect",
  );
  assertMinRows(parsed.rows, 500000, "SpellEffect");

  type Row = {
    effect: string;
    aura: string;
    trigger: string;
    points: number;
    targets: string[];
  };
  const bySpell = new Map<string, Row[]>();
  const rowOf = (r: Record<string, string>): Row => ({
    effect: r.Effect,
    aura: r.EffectAura,
    trigger: r.EffectTriggerSpell,
    points: Number(r.EffectBasePointsF),
    targets: [r.ImplicitTarget_0, r.ImplicitTarget_1].filter(
      (t) => t && t !== "0",
    ),
  });
  const keep = (sid: string, row: Row): void => {
    const list = bySpell.get(sid);
    if (list) list.push(row);
    else bySpell.set(sid, [row]);
  };
  for (const r of parsed.rows) {
    if (r.DifficultyID !== "0" || !universe.has(r.SpellID)) continue;
    keep(r.SpellID, rowOf(r));
  }
  const triggered = new Set<string>();
  for (const rows of bySpell.values())
    for (const r of rows)
      if (r.trigger && r.trigger !== "0" && !bySpell.has(r.trigger))
        triggered.add(r.trigger);
  for (const r of parsed.rows) {
    if (r.DifficultyID !== "0" || !triggered.has(r.SpellID)) continue;
    keep(r.SpellID, rowOf(r));
  }

  const considered = (rows: Row[]): Row[] => {
    const real = rows.filter((r) => r.effect !== EFFECT_DUMMY);
    return real.length > 0 ? real : rows;
  };
  const isHealRow = (r: Row): boolean =>
    HEAL_EFFECTS.has(r.effect) || HEAL_AURAS.has(r.aura);
  const hitsAlly = (r: Row): boolean =>
    r.targets.some((t) => ALLY_IMPLICIT_TARGETS.has(t));
  /** 1 = UNIT_CASTER;没有目标槽的效果也按「作用于自己」算(自身光环)。 */
  const hitsSelf = (r: Row): boolean =>
    r.targets.length === 0 || r.targets.includes("1");

  const factsFor = (id: string, hop = true): AbilityEffectFacts => {
    const facts: AbilityEffectFacts = {};
    for (const row of considered(bySpell.get(id) ?? [])) {
      if (row.aura === AURA_ABSORB) facts.absorbs = true;
      if (isHealRow(row)) {
        if (hitsAlly(row)) facts.healsOthers = true;
        else if (hitsSelf(row)) facts.healsSelf = true;
      }
      if (AURA_HEALING_RECEIVED.has(row.aura) && row.points > 0)
        facts.healingReceivedPct = Math.max(
          facts.healingReceivedPct ?? 0,
          Math.round(row.points),
        );
      if (row.aura === AURA_HASTE && row.points > 0)
        facts.hastePct = Math.max(facts.hastePct ?? 0, Math.round(row.points));
      if (hop && row.trigger && row.trigger !== "0") {
        const deep = factsFor(row.trigger, false);
        // 一跳只补「够得着别人」这一面:触发法术自身的目标才是真受众
        if (deep.healsOthers) facts.healsOthers = true;
        if (deep.absorbs) facts.absorbs = true;
        if (deep.healingReceivedPct !== undefined)
          facts.healingReceivedPct = Math.max(
            facts.healingReceivedPct ?? 0,
            deep.healingReceivedPct,
          );
      }
    }
    return facts;
  };

  const out: Record<string, AbilityEffectFacts> = {};
  for (const id of [...universe].sort((a, b) => Number(a) - Number(b))) {
    const f = factsFor(id);
    if (Object.keys(f).length > 0) out[id] = f;
  }

  // ── ground truth, both directions, before writing ────────────────────────
  const misses: string[] = [];
  for (const [id, field, expected, why] of CONTROLS) {
    const got = out[id]?.[field] === true;
    if (got !== expected)
      misses.push(`${id} ${field}: 期望 ${expected} 实得 ${got}(${why})`);
  }
  for (const [id, field, expected, why] of NUMERIC_CONTROLS) {
    const got = out[id]?.[field];
    if (got !== expected)
      misses.push(`${id} ${field}: 期望 ${expected} 实得 ${got}(${why})`);
  }
  for (const [id, field, why] of NEGATIVE_NUMERIC) {
    if (out[id]?.[field] !== undefined)
      misses.push(`${id} ${field}: 不该有值,实得 ${out[id]?.[field]}(${why})`);
  }
  if (misses.length > 0)
    throw new Error(
      `genAbilityEffects: ground-truth check failed —\n  ${misses.join("\n  ")}`,
    );

  const count = (pred: (f: AbilityEffectFacts) => boolean): number =>
    Object.values(out).filter(pred).length;
  const jsonPath = new URL(
    "../../src/data/abilityEffectsGenerated.json",
    import.meta.url,
  ).pathname;
  const tsPath = new URL(
    "../../src/data/abilityEffectsGenerated.ts",
    import.meta.url,
  ).pathname;
  writeArtifact(jsonPath, JSON.stringify(out) + "\n");
  writeArtifact(
    tsPath,
    `/**\n` +
      ` * Generated at: ${new Date().toISOString()}\n` +
      ` * Build: ${build}\n` +
      ` * Source: DB2 SpellEffect — aura 69 (absorb), Effect 10/136 + aura 8/20\n` +
      ` *   (healing, split self vs ally by ImplicitTarget), aura 118/259\n` +
      ` *   (healing received %), aura 31 (haste %). One EffectTriggerSpell hop,\n` +
      ` *   dummy rows ignored unless they are all the spell has.\n` +
      ` *   See scripts/datagen/genAbilityEffects.ts for the rules and controls.\n` +
      ` * Absent field = the official rows do not show that effect. Treat as\n` +
      ` *   "not known to do this", never as proof of absence for a spell whose\n` +
      ` *   implementation is a dummy row + server script.\n` +
      ` * ids: ${Object.keys(out).length} — absorb ${count((f) => !!f.absorbs)}, heals self ${count((f) => !!f.healsSelf)}, heals others ${count((f) => !!f.healsOthers)}, healing-received ${count((f) => f.healingReceivedPct !== undefined)}, haste ${count((f) => f.hastePct !== undefined)}\n` +
      ` * The data lives in the .json of the same name (vite json.stringify ->\n` +
      ` * JSON.parse loading — the big-JSON lesson).\n` +
      ` */\n\n` +
      `import raw from "./abilityEffectsGenerated.json";\n\n` +
      `export type AbilityEffectFacts = {\n` +
      `  absorbs?: true;\n` +
      `  healsSelf?: true;\n` +
      `  healsOthers?: true;\n` +
      `  healingReceivedPct?: number;\n` +
      `  hastePct?: number;\n` +
      `};\n\n` +
      `export const ABILITY_EFFECTS_GENERATED: Record<string, AbilityEffectFacts> =\n` +
      `  raw as Record<string, AbilityEffectFacts>;\n`,
  );
  console.log(
    `abilityEffectsGenerated: ${Object.keys(out).length} ids — absorb ${count((f) => !!f.absorbs)}, healsSelf ${count((f) => !!f.healsSelf)}, healsOthers ${count((f) => !!f.healsOthers)}, healingReceived ${count((f) => f.healingReceivedPct !== undefined)}, haste ${count((f) => f.hastePct !== undefined)} (build ${build})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
