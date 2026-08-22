/**
 * Forward completeness check for dispels (update-wow-data.md Notes, as a tool):
 * every cross-unit DEBUFF dispel the corpus recorded, cross-referenced against
 * the official path getDispelType(). Input = the awk extraction from the
 * runbook, one line per (removed id, removed name, caster ability):
 *   <count> <removedId>|"<name>"|<byId>|"<byName>"
 * Residue to expect (not gaps): snares/roots stripped by Freedom-class
 * effects (Disentanglement, Jet Stream, Master's Call), Cyclone by Mass
 * Dispel. 2026-08-21 S2 archive: 294,282 events, 2.69% residue, all of it
 * that class.
 *
 * Usage: tsx packages/eval/scripts/dispelCompletenessScan.ts <dispel-counts.txt>
 */
import { readFileSync } from "fs";
import { getDispelType } from "@gladlog/analysis";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => {
  const m = l.trim().match(/^(\d+) (\d+)\|"?([^"|]*)"?\|(\d+)\|"?([^"|]*)"?$/);
  return m ? { n: +m[1], id: m[2], name: m[3], by: m[4], byName: m[5] } : null;
}).filter((x): x is NonNullable<typeof x> => !!x);
const byId = new Map<string, { n: number; name: string }>();
for (const r of rows) { const e = byId.get(r.id) ?? { n: 0, name: r.name }; e.n += r.n; byId.set(r.id, e); }
let total = 0, unexplained = 0; const bad: Array<[string, string, number]> = [];
for (const [id, e] of byId) { total += e.n; if (!getDispelType(id)) { unexplained += e.n; bad.push([id, e.name, e.n]); } }
bad.sort((a, b) => b[2] - a[2]);
console.log(`dispel events: ${total}, distinct removed ids: ${byId.size}, unexplained by getDispelType: ${bad.length} ids / ${unexplained} events (${(100*unexplained/total).toFixed(2)}%)`);
for (const [id, name, n] of bad.slice(0, 40)) console.log(`${n}\t${id}\t${name}`);
