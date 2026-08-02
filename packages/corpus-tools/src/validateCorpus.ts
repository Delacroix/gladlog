import { COMP_CELL_N_FLOOR, type Corpus } from "./cellAggregator";

const ASCII = /^[\x00-\x7F]*$/;

export function validateCorpus(corpus: Corpus, nFloor: number): string[] {
  const v: string[] = [];
  if (!corpus.wowPatchVersion || corpus.wowPatchVersion === "unknown")
    v.push("corpus.wowPatchVersion missing/unknown");
  for (const c of corpus.cells) {
    const tag = `${c.spec}|${c.bracket}|${c.archetype}|${c.buildGroup}`;
    // N_floor consistency
    // P2 comp cells use COMP_CELL_N_FLOOR (the same constant as the aggregator)
    const floor = (c as { enemyComp?: string }).enemyComp
      ? COMP_CELL_N_FLOOR
      : nFloor;
    if (c.sampleN < floor && !c.insufficient)
      v.push(`${tag}: below floor (${c.sampleN}) but not insufficient`);
    if (c.sampleN >= floor && c.insufficient)
      v.push(`${tag}: at/above floor (${c.sampleN}) but marked insufficient`);
    // 1.5 latency sentinel regression: an old fork defaulted a missing
    // reactionLatency to 1.5s. If that comes back, the fake value enters the
    // distribution WITH a real record count (n>0) and the median lands exactly
    // on 1.5. A real queue's interpolated median can never be exactly 1.5, so
    // (n>0 && p50===1.5) is a reliable tripwire.
    // (The old implementation checked n===0 — but an empty distribution returns
    // 0 from percentile(), not 1.5, so it never fired and missed precisely the
    // real failure mode.)
    const rl = c.metrics.reactionLatency;
    if (rl && rl.n > 0 && rl.p50 === 1.5)
      v.push(
        `${tag}: reactionLatency 1.5 sentinel (median 1.5 with ${rl.n} records)`,
      );
    // crisis lines must be English/ASCII
    for (const crises of c.exemplarCrises)
      for (const line of crises)
        if (!ASCII.test(line))
          v.push(`${tag}: non-ASCII crisis line: ${line.slice(0, 40)}`);
    // build-group integrity: any non-"*" buildGroup cell's spec must be declared
    if (c.buildGroup !== "*" && !corpus.buildGroups?.[c.spec])
      v.push(
        `${tag}: undeclared buildGroup "${c.buildGroup}" (spec not in buildGroups)`,
      );
  }
  for (const [spec, d] of Object.entries(corpus.buildGroups ?? {})) {
    if (!d.keystoneNodeIds || d.keystoneNodeIds.length === 0)
      v.push(`buildGroups[${spec}]: empty keystoneNodeIds`);
    if (d.match !== "any" && d.match !== "all")
      v.push(`buildGroups[${spec}]: invalid match "${d.match}"`);
    if (d.groupPresent === d.groupAbsent)
      v.push(`buildGroups[${spec}]: groupPresent === groupAbsent`);
    // Post-hoc assertion on the guard: for every gate-activated buildGroup, the
    // build parent (spec×bracket×*×group) must genuinely meet the floor. If
    // aggregateCells' guard is broken and emits an under-floor group, this
    // catches it.
    for (const g of [d.groupPresent, d.groupAbsent]) {
      const buildParents = corpus.cells.filter(
        (c) => c.spec === spec && c.archetype === "*" && c.buildGroup === g,
      );
      for (const p of buildParents)
        if (p.sampleN < nFloor)
          v.push(
            `buildGroups[${spec}] group "${g}": build-parent ${p.bracket} below N_floor (${p.sampleN})`,
          );
    }
  }
  return v;
}
