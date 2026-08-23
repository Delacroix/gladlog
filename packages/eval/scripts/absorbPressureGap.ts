/**
 * Incoming-pressure absorb gap (HANDOFF-2026-08-23-healer-corpus §四):
 * `damageOut` merges the attacker-keyed `absorbsIn` events, but `damageIn` is
 * built from `_DAMAGE` records only — a hit that a shield ate whole produces a
 * standalone `SPELL_ABSORBED` line with no damage record, so it is invisible to
 * every "how hard was I being hit" consumer (`computePressureWindows`, the
 * pressure-window prompt lines, the damage-spike dense-sampling ranges).
 * Two consequences measured here:
 *   A) `matchTimelineSections`'s `(X absorbed)` annotation filters `damageIn`
 *      for `SPELL_ABSORBED` — an event class that array cannot contain.
 *   B) the share of real incoming pressure that never reaches the windows, and
 *      how the top-5 spike windows move once absorbs are counted.
 *
 * Usage: npx tsx packages/eval/scripts/absorbPressureGap.ts <logDir> [maxRounds]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { GladLogParser, parseLine, type GladMatch } from "@gladlog/parser";
import {
  toLegacyMatch,
  CombatUnitReaction,
  LogEvent,
} from "@gladlog/parser-compat";
import {
  computePressureWindows,
  specToString,
  sumAbsorbedPressure,
  DMG_SPIKE_THRESHOLD,
} from "@gladlog/analysis";

const dir = process.argv[2];
const maxRounds = Number(process.argv[3] ?? 400);

/** Mirrors cooldowns.ts computePressureWindows: 10s sliding window, top-5
 * non-overlapping spikes per target. Kept local so the same algorithm can be
 * fed two different event sets; verified against the product function below. */
function windowsFrom(
  rows: Array<{
    timeSec: number;
    amount: number;
    targetName: string;
    targetSpec: string;
  }>,
  windowSeconds = 10,
  topN = 5,
) {
  const byTarget = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTarget.get(r.targetName) ?? [];
    list.push(r);
    byTarget.set(r.targetName, list);
  }
  const allSpikes: Array<{
    fromSeconds: number;
    toSeconds: number;
    totalDamage: number;
    targetName: string;
    targetSpec: string;
  }> = [];
  for (const [, list] of byTarget) {
    const ev = list
      .filter((e) => Number.isFinite(e.timeSec) && Number.isFinite(e.amount))
      .sort((a, b) => a.timeSec - b.timeSec);
    let j = 0;
    let windowDamage = 0;
    for (let i = 0; i < ev.length; i++) {
      while (
        j < ev.length &&
        ev[j]!.timeSec <= ev[i]!.timeSec + windowSeconds
      ) {
        windowDamage += ev[j]!.amount;
        j++;
      }
      allSpikes.push({
        fromSeconds: ev[i]!.timeSec,
        toSeconds: ev[i]!.timeSec + windowSeconds,
        totalDamage: windowDamage,
        targetName: ev[i]!.targetName,
        targetSpec: ev[i]!.targetSpec,
      });
      windowDamage -= ev[i]!.amount;
    }
  }
  allSpikes.sort((a, b) => b.totalDamage - a.totalDamage);
  const distinct: typeof allSpikes = [];
  for (const spike of allSpikes) {
    const overlaps = distinct.some(
      (s) =>
        s.targetName === spike.targetName &&
        Math.min(s.toSeconds, spike.toSeconds) -
          Math.max(s.fromSeconds, spike.fromSeconds) >
          0,
    );
    if (!overlaps) {
      distinct.push(spike);
      if (distinct.length >= topN) break;
    }
  }
  return distinct;
}

const files = readdirSync(dir)
  .map((f) => path.join(dir, f))
  .filter((f) => f.endsWith(".txt") && statSync(f).isFile())
  .sort();

let rounds = 0;
let absorbEventsInDamageIn = 0;
let windowsWithAbsorbAnnotation = 0;
let windowsWithAbsorbAnnotationNew = 0;
let totalWindows = 0;
let productMatchesAbsorbAware = 0;

let sumDmgIn = 0;
let sumAbsTaken = 0;
let sumAbsCompat = 0;
let unitsWithAbsorbShortfall = 0;
let unitsChecked = 0;
const bySpec = new Map<string, { dmg: number; abs: number; units: number }>();

let roundsTopSetChanged = 0;
let roundsTopTargetChanged = 0;
const maxWindowRatios: number[] = [];
let spikesOverThresholdBefore = 0;
let spikesOverThresholdAfter = 0;
let replicationMismatch = 0;
let replicationChecked = 0;

outer: for (const file of files) {
  const items: GladMatch[] = [];
  try {
    const p = new GladLogParser();
    p.on("match", (m: GladMatch) => items.push(m));
    p.on("shuffle", (sh) => {
      for (const r of sh.rounds) items.push(r as never);
    });
    for (const line of readFileSync(file, "utf8").split("\n")) p.push(line);
    p.end();
  } catch {
    continue;
  }

  for (const m of items) {
    if (rounds >= maxRounds) break outer;

    // Ground truth: victim-keyed absorbs, straight off the round's own lines.
    const absTaken = new Map<string, Array<{ t: number; amt: number }>>();
    for (const line of m.rawLines ?? []) {
      const pl = parseLine(line);
      if (!pl?.absorbed) continue;
      const amt = pl.absorbed.absorbedAmount;
      if (!Number.isFinite(amt)) continue;
      const list = absTaken.get(pl.absorbed.victimGuid) ?? [];
      list.push({ t: pl.timestamp, amt });
      absTaken.set(pl.absorbed.victimGuid, list);
    }

    let legacy;
    try {
      legacy = toLegacyMatch({ ...m, rawLines: [] } as GladMatch);
    } catch {
      continue;
    }
    const friends = Object.values(legacy.units).filter(
      (u) => u.info && u.reaction === CombatUnitReaction.Friendly,
    );
    if (friends.length === 0) continue;
    rounds++;

    const startMs = legacy.startTime;
    const dmgRows: Array<{
      timeSec: number;
      amount: number;
      targetName: string;
      targetSpec: string;
    }> = [];
    const absRows: typeof dmgRows = [];

    for (const u of friends) {
      const spec = specToString(u.spec);
      let dmg = 0;
      for (const d of u.damageIn) {
        if (d.logLine.event === LogEvent.SPELL_ABSORBED)
          absorbEventsInDamageIn++;
        const amount = Math.abs(d.effectiveAmount);
        dmg += Number.isFinite(amount) ? amount : 0;
        dmgRows.push({
          timeSec: (d.logLine.timestamp - startMs) / 1000,
          amount,
          targetName: u.name,
          targetSpec: spec,
        });
      }
      // Coverage: L3 groups absorbs by attacker and by shield owner only, so an
      // absorb whose attacker AND shield owner are both untracked units cannot
      // reach the victim index convert.ts rebuilds. Ground truth is the raw
      // line, so the difference is exactly what the compat path cannot see.
      const compatAbs = u.absorbsIn.reduce(
        (s, e) => s + (Number(e.absorbedAmount) || 0),
        0,
      );
      let abs = 0;
      for (const a of absTaken.get(u.id) ?? []) {
        abs += a.amt;
        // Match incomingPressureEvents: a 0-amount absorb is not pressure and
        // must not anchor a window (leaving it in makes this replica disagree
        // with the product on ~4% of rounds purely through window boundaries).
        if (a.amt <= 0) continue;
        absRows.push({
          timeSec: (a.t - startMs) / 1000,
          amount: a.amt,
          targetName: u.name,
          targetSpec: spec,
        });
      }
      sumDmgIn += dmg;
      sumAbsTaken += abs;
      sumAbsCompat += compatAbs;
      if (Math.abs(compatAbs - abs) > 1) unitsWithAbsorbShortfall++;
      unitsChecked++;
      const st = bySpec.get(spec) ?? { dmg: 0, abs: 0, units: 0 };
      st.dmg += dmg;
      st.abs += abs;
      st.units++;
      bySpec.set(spec, st);
    }

    // A) the [DMG SPIKE] absorb annotation, both predicates side by side
    const productWindows = computePressureWindows(friends, legacy as never);
    totalWindows += productWindows.length;
    for (const pw of productWindows) {
      const fromMs = startMs + pw.fromSeconds * 1000;
      const toMs = startMs + pw.toSeconds * 1000;
      const target = friends.find((u) => u.name === pw.targetName);
      if (!target) continue;
      // OLD: scan damageIn for SPELL_ABSORBED — a shape that array cannot hold
      const oldHit = target.damageIn.some(
        (d) =>
          d.logLine.event === LogEvent.SPELL_ABSORBED &&
          d.logLine.timestamp >= fromMs &&
          d.logLine.timestamp <= toMs,
      );
      if (oldHit) windowsWithAbsorbAnnotation++;
      // NEW: the shared predicate, with the >100k print threshold applied
      if (sumAbsorbedPressure(target, fromMs, toMs) > 100_000) {
        windowsWithAbsorbAnnotationNew++;
      }
    }

    // Replication check: which local variant does the product agree with?
    const localDamageOnly = windowsFrom(dmgRows);
    const localWithAbsorbs = windowsFrom([...dmgRows, ...absRows]);
    replicationChecked++;
    const key = (w: { targetName: string; fromSeconds: number }) =>
      `${w.targetName}@${w.fromSeconds.toFixed(3)}`;
    const agrees = (local: ReturnType<typeof windowsFrom>) =>
      local.length === productWindows.length &&
      local.every((w, i) => key(w) === key(productWindows[i]!));
    if (!agrees(localDamageOnly)) replicationMismatch++;
    if (agrees(localWithAbsorbs)) productMatchesAbsorbAware++;

    // How many windows clear DMG_SPIKE_THRESHOLD — the gate that decides both
    // the [DMG SPIKE] prompt lines and criticalWindows' dense-sampling ranges,
    // so this is the prompt-level size of the change.
    spikesOverThresholdBefore += localDamageOnly.filter(
      (w) => w.totalDamage >= DMG_SPIKE_THRESHOLD,
    ).length;
    spikesOverThresholdAfter += localWithAbsorbs.filter(
      (w) => w.totalDamage >= DMG_SPIKE_THRESHOLD,
    ).length;

    // B) how far the windows move once absorbs count
    const beforeSet = new Set(localDamageOnly.map(key));
    const afterSet = new Set(localWithAbsorbs.map(key));
    const same =
      beforeSet.size === afterSet.size &&
      [...beforeSet].every((k) => afterSet.has(k));
    if (!same) roundsTopSetChanged++;
    if (localDamageOnly[0]?.targetName !== localWithAbsorbs[0]?.targetName)
      roundsTopTargetChanged++;
    const b = localDamageOnly[0]?.totalDamage ?? 0;
    const a = localWithAbsorbs[0]?.totalDamage ?? 0;
    if (b > 0) maxWindowRatios.push(a / b);
  }
}

const pct = (x: number, y: number) =>
  y === 0 ? "n/a" : `${((x / y) * 100).toFixed(1)}%`;
maxWindowRatios.sort((x, y) => x - y);
const q = (f: number) =>
  maxWindowRatios.length === 0
    ? "n/a"
    : maxWindowRatios[
        Math.min(
          maxWindowRatios.length - 1,
          Math.floor(f * maxWindowRatios.length),
        )
      ]!.toFixed(3);

console.log(`rounds=${rounds}  files=${files.length}`);
console.log(
  `\nA) SPELL_ABSORBED events found inside damageIn: ${absorbEventsInDamageIn}`,
);
console.log(
  `   windows printing "(X absorbed)" — OLD damageIn scan:   ${windowsWithAbsorbAnnotation}/${totalWindows}`,
);
console.log(
  `   windows printing "(X absorbed)" — NEW shared predicate: ${windowsWithAbsorbAnnotationNew}/${totalWindows} (${pct(windowsWithAbsorbAnnotationNew, totalWindows)})`,
);
console.log(`\nB) incoming pressure seen vs real (friendly players)`);
console.log(`   damageIn sum       = ${Math.round(sumDmgIn).toLocaleString()}`);
console.log(
  `   absorbed-taken sum = ${Math.round(sumAbsTaken).toLocaleString()}  (${pct(sumAbsTaken, sumDmgIn + sumAbsTaken)} of real incoming)`,
);
console.log(
  `   of which the compat absorbsIn path reaches = ${Math.round(sumAbsCompat).toLocaleString()} (${pct(sumAbsCompat, sumAbsTaken)} of ground truth)`,
);
console.log(
  `   friendly units where the two disagree: ${unitsWithAbsorbShortfall}/${unitsChecked} (${pct(unitsWithAbsorbShortfall, unitsChecked)})`,
);
console.log(`\n   by spec (share of real incoming that is absorb-only):`);
for (const [spec, st] of [...bySpec.entries()].sort(
  (x, y) => y[1].abs / (y[1].abs + y[1].dmg) - x[1].abs / (x[1].abs + x[1].dmg),
)) {
  if (st.units < 20) continue;
  console.log(
    `     ${spec.padEnd(24)} ${pct(st.abs, st.abs + st.dmg).padStart(6)}   (n=${st.units})`,
  );
}
console.log(`\nC) top-5 spike windows, damage-only vs absorb-aware`);
console.log(
  `   computePressureWindows agrees with damage-only:  ${replicationChecked - replicationMismatch}/${replicationChecked}`,
);
console.log(
  `   computePressureWindows agrees with absorb-aware: ${productMatchesAbsorbAware}/${replicationChecked}`,
);
console.log(
  `   rounds whose top-5 window set changes: ${roundsTopSetChanged}/${rounds} (${pct(roundsTopSetChanged, rounds)})`,
);
console.log(
  `   rounds whose #1 window's target changes: ${roundsTopTargetChanged}/${rounds} (${pct(roundsTopTargetChanged, rounds)})`,
);
console.log(
  `   #1 window totalDamage ratio after/before: p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)}`,
);
console.log(
  `   windows clearing DMG_SPIKE_THRESHOLD: ${spikesOverThresholdBefore} -> ${spikesOverThresholdAfter}`,
);
