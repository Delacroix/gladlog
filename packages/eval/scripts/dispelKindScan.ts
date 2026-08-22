/**
 * dispelKindScan.ts — Curated-List completeness check for
 * `MOVEMENT_ROOT_BREAK_DISPEL_IDS` and a before/after ledger for the
 * `classifyDispel` predicate (UI review 2026-08-21 #3), both directions:
 *
 *  - FORWARD: dispelling spell ids NOT in the list with ≥30 events and a
 *    0 % deliberate rate — what the predicate calls "proc" without a list
 *    entry (expected: Cleanse the Weak, Fire Breath, Emergency Salve …);
 *  - MIXED: unlisted ids with 20–80 % deliberate — these would need either a
 *    list entry or a predicate fix (expected: empty);
 *  - REVERSE: list entries with zero corpus occurrences — stale ids that a
 *    patch renumbered (expected: empty).
 *
 * Runs over raw.txt of every match in the local library with the SAME
 * predicate the product uses: `classifyDispel` over a `CastMatchIndex` built
 * from SPELL_CAST_SUCCESS lines keyed by the raw source GUID. Raw-line
 * splitting / timestamp parsing go through `@gladlog/analysis`'s rawStreams
 * (BACKLOG #26's single source), same as uwcObserved.ts.
 *
 *   npx tsx packages/eval/scripts/dispelKindScan.ts [--limit N] [--store DIR]
 *
 * Full run is ~1100 files / ~4.5 GB streamed; run it in the foreground or
 * with an explicit long timeout, never as a parallel storm.
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import {
  addCastToIndex,
  classifyDispel,
  createCastMatchIndex,
  type DispelKind,
  MOVEMENT_ROOT_BREAK_DISPEL_IDS,
  parseRawTimestamp,
  splitRawLine,
} from "@gladlog/analysis";

import { DEFAULT_MATCH_DIR } from "../src/explore/storeAccess";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    store: { type: "string" },
  },
});
const LIMIT = values.limit ? Number(values.limit) : 0;
const STORE = values.store ?? DEFAULT_MATCH_DIR;

type Tally = Record<DispelKind, number> & { name: string; n: number };
const bySpell = new Map<string, Tally>();
let total = 0;
const totals: Record<DispelKind, number> = {
  deliberate: 0,
  proc: 0,
  rider: 0,
};
const perMatchPassiveShare: number[] = [];

// params after splitRawLine strip the event name: [0]=srcGUID, [1]=srcName,
// [2]=srcFlags, [3]=srcRaidFlags, [4]=destGUID, …, [8]=spellId, [9]=spellName.
async function scanMatch(path: string): Promise<void> {
  const idx = createCastMatchIndex();
  const dispels: Array<{
    srcUnitId: string;
    spellId: string;
    spellName: string;
    timestamp: number;
  }> = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
  });
  for await (const line of rl) {
    const split = splitRawLine(line);
    if (!split) continue;
    if (
      split.eventName !== "SPELL_CAST_SUCCESS" &&
      split.eventName !== "SPELL_DISPEL"
    )
      continue;
    const ts = parseRawTimestamp(split.datePart);
    if (ts == null) continue;
    const p = split.params;
    if (split.eventName === "SPELL_CAST_SUCCESS") {
      addCastToIndex(idx, p[0] ?? "", p[8], p[9], ts);
    } else {
      dispels.push({
        srcUnitId: p[0] ?? "",
        spellId: p[8] ?? "",
        spellName: p[9] ?? "",
        timestamp: ts,
      });
    }
  }
  let passive = 0;
  for (const d of dispels) {
    const kind = classifyDispel(idx, d);
    total++;
    totals[kind]++;
    if (kind !== "deliberate") passive++;
    const t = bySpell.get(d.spellId) ?? {
      name: d.spellName,
      n: 0,
      deliberate: 0,
      proc: 0,
      rider: 0,
    };
    t.n++;
    t[kind]++;
    bySpell.set(d.spellId, t);
  }
  if (dispels.length >= 20) perMatchPassiveShare.push(passive / dispels.length);
}

(async () => {
  const ids = readdirSync(STORE).filter((d) => !d.startsWith("_"));
  let files = 0;
  for (const id of LIMIT ? ids.slice(0, LIMIT) : ids) {
    const p = join(STORE, id, "raw.txt");
    if (!existsSync(p)) continue;
    files++;
    await scanMatch(p);
  }
  const pct = (n: number): string =>
    `${((100 * n) / Math.max(1, total)).toFixed(1)}%`;
  console.log(
    `files=${files} dispels=${total} deliberate=${totals.deliberate} (${pct(
      totals.deliberate,
    )}) proc=${totals.proc} (${pct(totals.proc)}) rider=${totals.rider} (${pct(
      totals.rider,
    )})`,
  );
  perMatchPassiveShare.sort((a, b) => a - b);
  const q = (f: number): string =>
    perMatchPassiveShare.length
      ? perMatchPassiveShare[
          Math.floor(f * (perMatchPassiveShare.length - 1))
        ]!.toFixed(2)
      : "n/a";
  console.log(
    `matches with >=20 dispels: ${perMatchPassiveShare.length}; passive share p50=${q(0.5)} p90=${q(0.9)}`,
  );
  const rows = [...bySpell.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(
    "\nFORWARD — unlisted spells, n>=30, 0% deliberate (procs without a list entry — expected):",
  );
  for (const [id, t] of rows)
    if (
      !MOVEMENT_ROOT_BREAK_DISPEL_IDS.has(id) &&
      t.n >= 30 &&
      t.deliberate === 0
    )
      console.log(`  ${id}\t${t.name}\t${t.n}`);
  console.log(
    "\nMIXED — unlisted spells, n>=30, 20%<deliberate<80% (need a list entry or a predicate fix — expected empty):",
  );
  for (const [id, t] of rows) {
    const r = t.deliberate / t.n;
    if (
      !MOVEMENT_ROOT_BREAK_DISPEL_IDS.has(id) &&
      t.n >= 30 &&
      r > 0.2 &&
      r < 0.8
    )
      console.log(`  ${id}\t${t.name}\t${t.n}\t${(100 * r).toFixed(0)}%`);
  }
  console.log(
    "\nREVERSE — listed ids with zero corpus occurrences (stale — expected empty):",
  );
  for (const id of MOVEMENT_ROOT_BREAK_DISPEL_IDS)
    if (!bySpell.has(id)) console.log(`  ${id}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
