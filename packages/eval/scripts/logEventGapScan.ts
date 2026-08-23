/**
 * Effect measurement for the five log-event classes the product used to discard
 * (BACKLOG #36 / HANDOFF-2026-08-23-healer-corpus §五 items 2,3,4,5,7).
 *
 * Reads `.txt.gz` straight out of the archive — the new-season corpus is 18k
 * files and decompressing enough of it for 1000+ rounds would cost ~15GB of
 * disk for nothing.
 *
 * Each section reports the BEFORE state as well, so "what did reading this
 * event actually buy" is answerable rather than asserted:
 *   #2 resource   — how many casts now carry a readable resource, and the
 *                   distribution of the caster's own resource at cast time
 *   #3 missType   — IMMUNE/REFLECT counts, and how much of it is CC (the class
 *                   of judgement that was impossible before); ABSORB is
 *                   reported separately because it duplicates SPELL_ABSORBED
 *   #4 DAMAGE_SPLIT — how much redirected damage was invisible, and how the
 *                   incoming-pressure totals move now that it lands on the unit
 *                   that actually ate it
 *   #5 empower    — release-level distribution per spell
 *   #7 heal absorb — how much healing is eaten, by which debuff, on whom
 *
 * Usage: npx tsx packages/eval/scripts/logEventGapScan.ts <archiveRoot> [maxRounds]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { CombatUnitReaction, toLegacyMatch } from "@gladlog/parser-compat";
import {
  ensureAnalysisData,
  getDRCategory,
  getEnglishSpellName,
  specToString,
} from "@gladlog/analysis";

// The official spell/DR tables load dynamically; every predicate that asserts a
// concrete value has to await this first or it answers off empty tables.
await ensureAnalysisData();

const root = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 1000);

/** 12.1 go-live is 2026-08-11 22:00 UTC, so 08/12 onward is unambiguously
 * post-patch; anything earlier is a different talent tree and must not be
 * pooled in (CLAUDE.md value-gate rule 5). */
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
let files = 0;

// #2 resource
let castsTotal = 0;
let castsWithPower = 0;
const resourcePctBySpec = new Map<string, number[]>();

// #3 missType
const missTypes = new Map<string, number>();
let immuneCc = 0;
let immuneTotal = 0;
const immuneCcSpells = new Map<string, number>();

// #4 DAMAGE_SPLIT
let splitEvents = 0;
let splitAmount = 0;
let dmgInTotalWithSplit = 0;
const splitBySpell = new Map<string, number>();
let unitsWithSplit = 0;
const splitShare: number[] = [];

// #5 empower
const empowerLevels = new Map<string, Map<number, number>>();

// #7 heal absorb
let healAbsEvents = 0;
let healAbsAmount = 0;
let healAbsTotal = 0;
const healAbsByDebuff = new Map<string, number>();
let healerAbsorbed = 0;
let healerHealTotal = 0;

const HEALER_SPECS = new Set([105, 270, 65, 256, 257, 264, 1468]);

const all = newSeasonFiles(root);
outer: for (const file of all) {
  files++;
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
    const units = Object.values(m.units);
    if (units.length === 0) continue;
    rounds++;

    const friendlyIds = new Set(
      Object.values(legacy.units)
        .filter((u) => u.info && u.reaction === CombatUnitReaction.Friendly)
        .map((u) => u.id),
    );

    for (const u of units) {
      const spec = specToString(String(u.specId) as never);

      // ── #2 resource ────────────────────────────────────────────────────
      castsTotal += u.casts.length;
      for (const s of u.advancedSamples) {
        if (!s.powers || s.powers.length === 0) continue;
        castsWithPower++;
        const primary = s.powers[0]!;
        if (primary.max > 0) {
          const list = resourcePctBySpec.get(spec) ?? [];
          list.push((primary.current / primary.max) * 100);
          resourcePctBySpec.set(spec, list);
        }
      }

      // ── #3 missType ────────────────────────────────────────────────────
      for (const miss of u.missesOut) {
        missTypes.set(miss.missType, (missTypes.get(miss.missType) ?? 0) + 1);
        if (miss.missType !== "IMMUNE") continue;
        immuneTotal++;
        // "is this CC" must be the official DR-backed predicate, not
        // "SPELL_CATEGORIES has an entry" — that table also carries
        // debuffs_offensive rows (Ignite, Curse of Tongues), which would score
        // a resisted DoT as a resisted crowd control.
        if (!getDRCategory(String(miss.spellId)).startsWith("spell:")) {
          immuneCc++;
          const key = String(miss.spellId);
          immuneCcSpells.set(key, (immuneCcSpells.get(key) ?? 0) + 1);
        }
      }

      // ── #4 DAMAGE_SPLIT ────────────────────────────────────────────────
      let unitSplit = 0;
      let unitDmgIn = 0;
      for (const d of u.damageIn) {
        const amt = Math.abs(d.effectiveAmount);
        if (!Number.isFinite(amt)) continue;
        unitDmgIn += amt;
        if (d.eventName === "DAMAGE_SPLIT") {
          splitEvents++;
          splitAmount += amt;
          unitSplit += amt;
          const key = String(d.spellId);
          splitBySpell.set(key, (splitBySpell.get(key) ?? 0) + amt);
        }
      }
      dmgInTotalWithSplit += unitDmgIn;
      if (unitSplit > 0) {
        unitsWithSplit++;
        if (unitDmgIn > 0) splitShare.push((unitSplit / unitDmgIn) * 100);
      }

      // ── #5 empower ─────────────────────────────────────────────────────
      for (const e of u.empowerEnds) {
        const key = String(e.spellId);
        const byLevel = empowerLevels.get(key) ?? new Map<number, number>();
        byLevel.set(e.level, (byLevel.get(e.level) ?? 0) + 1);
        empowerLevels.set(key, byLevel);
      }

      // ── #7 heal absorb ─────────────────────────────────────────────────
      for (const ha of u.healAbsorbsIn) {
        if (!Number.isFinite(ha.absorbedAmount)) continue;
        healAbsEvents++;
        healAbsAmount += ha.absorbedAmount;
        if (Number.isFinite(ha.totalAmount)) healAbsTotal += ha.totalAmount;
        const key = String(ha.absorbSpellId);
        healAbsByDebuff.set(
          key,
          (healAbsByDebuff.get(key) ?? 0) + ha.absorbedAmount,
        );
        const healer = m.units[ha.healerId];
        if (healer && HEALER_SPECS.has(healer.specId)) {
          healerAbsorbed += ha.absorbedAmount;
        }
      }
      if (HEALER_SPECS.has(u.specId) && friendlyIds.has(u.id)) {
        for (const h of u.healOut) {
          const amt = Math.abs(h.effectiveAmount);
          if (Number.isFinite(amt)) healerHealTotal += amt;
        }
      }
    }
  }
}

const n = (x: number) => Math.round(x).toLocaleString();
const pct = (a: number, b: number) =>
  b === 0 ? "n/a" : `${((a / b) * 100).toFixed(1)}%`;
const med = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

console.log(`rounds=${rounds}  files scanned=${files}\n`);

console.log("── #2 resource (powerType/currentPower/maxPower) ──");
console.log(
  `  advanced samples carrying a readable resource: ${n(castsWithPower)} (was 0 — the fields were never decoded); casts in sample=${n(castsTotal)}`,
);
console.log(`  resource % at sample time, by spec (median):`);
for (const [spec, list] of [...resourcePctBySpec.entries()]
  .filter(([, l]) => l.length >= 200)
  .sort((a, b) => med(a[1]) - med(b[1]))
  .slice(0, 12)) {
  console.log(
    `    ${spec.padEnd(24)} p50=${med(list).toFixed(0)}%  (n=${n(list.length)})`,
  );
}

console.log("\n── #3 SPELL_MISSED missType ──");
for (const [t, c] of [...missTypes.entries()].sort((a, b) => b[1] - a[1])) {
  const note =
    t === "ABSORB" ? "  ← duplicates SPELL_ABSORBED, do NOT add" : "";
  console.log(`  ${t.padEnd(12)} ${n(c)}${note}`);
}
console.log(
  `  IMMUNE that was a classified CC: ${n(immuneCc)}/${n(immuneTotal)} (${pct(immuneCc, immuneTotal)})`,
);
for (const [k, c] of [...immuneCcSpells.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)) {
  console.log(`    ${k} ${getEnglishSpellName(k) ?? "?"}: ${n(c)}`);
}

console.log("\n── #4 DAMAGE_SPLIT ──");
console.log(`  events=${n(splitEvents)}  redirected damage=${n(splitAmount)}`);
console.log(
  `  share of all incoming damage now visible: ${pct(splitAmount, dmgInTotalWithSplit)} (was 0 — event was dropped entirely)`,
);
console.log(
  `  units carrying redirected damage: ${n(unitsWithSplit)}; for them it is p50=${med(splitShare).toFixed(1)}% of their own intake`,
);
for (const [k, amt] of [...splitBySpell.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)) {
  console.log(`    ${k} ${getEnglishSpellName(k) ?? "?"}: ${n(amt)}`);
}

console.log("\n── #5 SPELL_EMPOWER_END release level ──");
for (const [k, byLevel] of [...empowerLevels.entries()]
  .sort(
    (a, b) =>
      [...b[1].values()].reduce((x, y) => x + y, 0) -
      [...a[1].values()].reduce((x, y) => x + y, 0),
  )
  .slice(0, 8)) {
  const parts = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lv, c]) => `L${lv}=${n(c)}`);
  console.log(`  ${k} ${getEnglishSpellName(k) ?? "?"}: ${parts.join("  ")}`);
}

console.log("\n── #7 SPELL_HEAL_ABSORBED ──");
console.log(
  `  events=${n(healAbsEvents)}  healing eaten=${n(healAbsAmount)} of ${n(healAbsTotal)} attempted (${pct(healAbsAmount, healAbsTotal)})`,
);
console.log(`  of that, eaten from a HEALER's casts: ${n(healerAbsorbed)}`);
console.log(
  `  friendly healer effective healing (denominator): ${n(healerHealTotal)} → eaten is ${pct(healerAbsorbed, healerHealTotal + healerAbsorbed)} of what they tried to land`,
);
for (const [k, amt] of [...healAbsByDebuff.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)) {
  console.log(`    ${k} ${getEnglishSpellName(k) ?? "?"}: ${n(amt)}`);
}
