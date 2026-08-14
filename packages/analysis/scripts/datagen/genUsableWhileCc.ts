/**
 * "Usable while stunned" table (B1, task-3): a bit search over official DB2
 * SpellMisc.Attributes_0..16 (17 columns x 32 bits each), anchored against
 * UWC_ANCHORS (13 user-signed ground-truth spells, see
 * usableWhileCcAnchors.ts / task-2-report.md). Escalates in three stages:
 *
 *   1. Single-bit search: score every (column, bit) candidate against the
 *      dimension's non-null anchors; adopt iff exactly one candidate
 *      achieves 100% agreement (null anchor cells constrain nothing).
 *   2. If stage 1 finds zero or multiple candidates, escalate to a <=2-bit
 *      OR-union search: covered set = (bit A == 1) UNION (bit B == 1); a
 *      pair is consistent iff every true anchor is in the union and every
 *      false anchor is not. This exists because a single-bit near-miss can
 *      have two DIFFERENT error types: a false anchor wrongly INCLUDED
 *      (union can never fix this -- union only adds members) vs. a true
 *      anchor wrongly EXCLUDED (fixable by unioning in a second bit that
 *      covers exactly the missing member). Multiple tied 2-bit solutions
 *      are scored by "family consistency": how many of the OTHER two
 *      dimensions' own candidate pools reference either bit (the idea
 *      being Blizzard's flag design likely reuses bits across the three CC
 *      dimensions).
 *   3. If stage 2 still ties, escalate to a small set of unsigned "tie-break
 *      anchors" (see TIEBREAK_ANCHORS below) found by spot-checking wowhead
 *      tooltip text for spells in the SYMMETRIC DIFFERENCE of the tied
 *      candidates' full-table member sets -- i.e. spells where the tied
 *      candidates actually disagree, which is the only kind of spell that
 *      can break the tie. These are NOT part of the user-signed
 *      UWC_ANCHORS file (that file is final); they are auxiliary,
 *      2026-08-14, unsigned, and flagged in the generated header as
 *      pending Task 4 corpus corroboration.
 *
 * Only the "stunned" dimension is required to resolve for this task (scope
 * fixed 2026-08-14): "feared"/"confused" are searched for full diagnostic
 * transparency (their structural findings are written into the generated
 * header as a documented gap -- disposition: hand-written layer
 * (cooldowns.ts USABLE_WHILE_CC_SPELL_IDS) stays authoritative for those two
 * dimensions, pending Task 4's corpus-driven evidence line and the other
 * official-table candidates noted in docs/ability-fact-inventory.md's A2
 * section), but do NOT block emission of the stunned table and do NOT widen
 * this task's own search to tables other than SpellMisc.
 *
 * Prior under test (see usableWhileCcAnchors.ts file header): wowhead's "No
 * Client Fail While Stunned, Fleeing, Confused" flag -- shared by anchors
 * 642 (Divine Shield) and 45438 (Ice Block), both user-testified usable
 * while CC'd -- was hypothesized to BE the real "usable while CC'd" bit
 * family. Empirical result for stunned: Attributes_10#13 is the shared base
 * bit that gives 642/45438 (and 33206/48792, which the "classic" literature
 * bit Attributes_5#3-alone would have missed) all `true`; the prior is
 * partially confirmed (10#13 covers the "No Client Fail" family) but the
 * full stunned answer needed a second bit (5#3) to also cover 22812
 * Barkskin, which does NOT carry the "No Client Fail" flag.
 */
import fs from "fs-extra";

import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchTable,
  parseCsv,
  resolveBuild,
} from "./lib/wagoCsv";
import { UWC_ANCHORS, type UwcAnchor } from "./usableWhileCcAnchors";

const ATTR_COLUMNS = Array.from({ length: 17 }, (_, i) => `Attributes_${i}`);
const BITS_PER_COLUMN = 32;
const DIMENSIONS = ["stunned", "feared", "confused"] as const;
type Dimension = (typeof DIMENSIONS)[number];
/** Only this dimension's resolution is required to emit a table (2026-08-14
 * scope decision -- feared/confused become a documented gap, see file
 * header). */
const EMITTED_DIMENSIONS = ["stunned"] as const;

interface Candidate {
  column: string;
  bit: number;
}

function candidateKey(c: Candidate): string {
  return `${c.column}#${c.bit}`;
}

function comboKey(combo: Candidate[]): string {
  return combo.map(candidateKey).join(" ∪ ");
}

function bitAt(row: Record<string, string>, c: Candidate): boolean {
  const raw = row[c.column];
  if (raw === undefined || raw === "") return false;
  const val = Number(raw);
  if (Number.isNaN(val)) return false;
  // >>> does ToUint32 first, which folds a signed-int32 decimal (as wago CSV
  // renders a set high bit, e.g. bit 31) back to the same bit pattern a
  // straight unsigned reading would give -- safe here because
  // SpellMisc.Attributes_N is a 32-bit flag column and Number() has full
  // precision well within the int32 range.
  return ((val >>> c.bit) & 1) === 1;
}

/**
 * Set of SpellIDs where ANY candidate in `combo` has its bit set, over the
 * deduped rows -- the OR-union membership used for anchor scoring.
 *
 * `restrictTo`, when given, additionally requires membership in that set
 * (the observed corpus, see `main()`) for the FINAL emitted table only --
 * anchor scoring itself must run unrestricted (an anchor's spellId doesn't
 * need to already be observed for the bit search to be valid; 55233 Vampiric
 * Blood, one of the false anchors, isn't in the observed corpus, and
 * excluding it from the search rows would have silently changed nothing for
 * a false anchor but is exactly the kind of restriction that must not leak
 * into stage 1/2/3 scoring, only into what actually gets written to disk).
 */
function unionSet(
  rows: Record<string, string>[],
  combo: Candidate[],
  restrictTo?: ReadonlySet<string>,
): Set<string> {
  const s = new Set<string>();
  for (const row of rows) {
    if (restrictTo && !restrictTo.has(row.SpellID)) continue;
    if (combo.some((c) => bitAt(row, c))) s.add(row.SpellID);
  }
  return s;
}

const ALL_CANDIDATES: Candidate[] = [];
for (const column of ATTR_COLUMNS) {
  for (let bit = 0; bit < BITS_PER_COLUMN; bit++) {
    ALL_CANDIDATES.push({ column, bit });
  }
}

/**
 * Stage-3 tie-break anchors: unsigned, found 2026-08-14 by taking the
 * symmetric difference between the full-table member sets of the tied
 * "stunned" candidates (Attributes_10#13 ∪ Attributes_5#3 vs.
 * Attributes_10#13 ∪ Attributes_5#17 -- 6074 vs. 1562 spells respectively
 * that only ONE of the two unions contains), restricting to spells actually
 * cast in the real match corpus (observedSpellIdsGenerated.json) so the
 * spot-check is on real, played abilities rather than NPC/cosmetic/dev
 * spells (which dominate the low-spellId end of both difference sets), then
 * reading each candidate's wowhead "Flags" box directly (same methodology
 * as usableWhileCcAnchors.ts) for the literal "Can be used while stunned"
 * text. Result: all 3 checked members unique to the 5#3 union (Meteor,
 * Dark Simulacrum, Blade Flurry) DO carry that flag; both checked members
 * unique to the 5#17 union (Lichborne, Living Bomb) do NOT (Lichborne only
 * has "Usable while feared"; Living Bomb has "Allow While Stunned By Horror
 * Mechanic", a narrower fear-adjacent flag, not general "usable while
 * stunned") -- decisive evidence that Attributes_5#17 is a same-anchor-set
 * coincidental "twin" of 5#3, not the true bit. Pending Task 4 corpus
 * corroboration; NOT part of the user-signed UWC_ANCHORS.
 */
const TIEBREAK_ANCHORS: Partial<
  Record<
    Dimension,
    { spellId: string; name: string; expected: boolean; source: string }[]
  >
> = {
  stunned: [
    {
      spellId: "117588",
      name: "Meteor",
      expected: true,
      source:
        'wowhead.com/spell=117588 Flags box (2026-08-14): "Can be used while stunned" present',
    },
    {
      spellId: "77616",
      name: "Dark Simulacrum",
      expected: true,
      source:
        'wowhead.com/spell=77616 Flags box (2026-08-14): "Can be used while stunned" present',
    },
    {
      spellId: "426586",
      name: "Blade Flurry",
      expected: true,
      source:
        'wowhead.com/spell=426586 Flags box (2026-08-14): "Can be used while stunned" present',
    },
    {
      spellId: "50397",
      name: "Lichborne",
      expected: false,
      source:
        'wowhead.com/spell=50397 Flags box (2026-08-14): only "Usable while feared" -- no stunned flag',
    },
    {
      spellId: "44461",
      name: "Living Bomb",
      expected: false,
      source:
        'wowhead.com/spell=44461 Flags box (2026-08-14): "Allow While Stunned By Horror Mechanic" (fear-mechanic-scoped, not general "usable while stunned") -- no general stunned flag',
    },
  ],
};

interface AnchorRow {
  anchor: UwcAnchor;
  row: Record<string, string> | undefined;
}

/** anchors x candidates boolean matrix for one dimension, built once so the
 * O(C(544,2)) pair search only touches ~11 booleans per pair instead of
 * rescanning all ~400k SpellMisc rows. */
function buildBoolMatrix(
  anchorRows: AnchorRow[],
): boolean[][] /* [candidateIndex][anchorIndex] */ {
  return ALL_CANDIDATES.map((c) =>
    anchorRows.map(({ row }) => (row ? bitAt(row, c) : false)),
  );
}

interface SingleBitScored {
  candidate: Candidate;
  mismatches: UwcAnchor[];
}

function scoreSingleBits(
  anchorRows: AnchorRow[],
  boolMatrix: boolean[][],
  dimension: Dimension,
): SingleBitScored[] {
  return ALL_CANDIDATES.map((candidate, ci) => {
    const mismatches: UwcAnchor[] = [];
    anchorRows.forEach(({ anchor }, ai) => {
      const expected = anchor[dimension] as boolean;
      if (boolMatrix[ci]![ai] !== expected) mismatches.push(anchor);
    });
    return { candidate, mismatches };
  });
}

/** All (i,j) bit pairs whose OR-union matches every anchor exactly. */
function scorePairs(
  anchorRows: AnchorRow[],
  boolMatrix: boolean[][],
  dimension: Dimension,
): Candidate[][] {
  const expected = anchorRows.map(({ anchor }) => anchor[dimension] as boolean);
  const solutions: Candidate[][] = [];
  for (let i = 0; i < ALL_CANDIDATES.length; i++) {
    const bi = boolMatrix[i]!;
    for (let j = i + 1; j < ALL_CANDIDATES.length; j++) {
      const bj = boolMatrix[j]!;
      let ok = true;
      for (let k = 0; k < expected.length; k++) {
        if ((bi[k] || bj[k]) !== expected[k]) {
          ok = false;
          break;
        }
      }
      if (ok) solutions.push([ALL_CANDIDATES[i]!, ALL_CANDIDATES[j]!]);
    }
  }
  return solutions;
}

type DimensionOutcome =
  | { kind: "single"; combo: [Candidate]; note: string }
  | { kind: "pair"; combo: [Candidate, Candidate]; note: string }
  | { kind: "unresolved"; errorLines: string[] };

interface DimensionSearch {
  dimension: Dimension;
  anchorRows: AnchorRow[];
  singleConsistent: SingleBitScored[];
  singleScored: SingleBitScored[];
  pairSolutions: Candidate[][];
  /** Bits referenced by this dimension's own candidate solution space, used
   * by OTHER dimensions' tie-breaks. Empty iff this dimension has zero
   * 2-bit solutions (contributes nothing to cross-dimension sharing). */
  poolBits: Set<string>;
}

function searchDimension(
  dimension: Dimension,
  byId: Map<string, Record<string, string>>,
): DimensionSearch {
  const anchors = UWC_ANCHORS.filter((a) => a[dimension] !== null);
  const anchorRows: AnchorRow[] = anchors.map((anchor) => ({
    anchor,
    row: byId.get(anchor.spellId),
  }));
  const boolMatrix = buildBoolMatrix(anchorRows);
  const singleScored = scoreSingleBits(anchorRows, boolMatrix, dimension);
  const singleConsistent = singleScored.filter(
    (s) => s.mismatches.length === 0,
  );

  let pairSolutions: Candidate[][] = [];
  let poolBits = new Set<string>();
  if (singleConsistent.length === 1) {
    poolBits = new Set([candidateKey(singleConsistent[0]!.candidate)]);
  } else {
    pairSolutions = scorePairs(anchorRows, boolMatrix, dimension);
    for (const combo of pairSolutions) {
      for (const c of combo) poolBits.add(candidateKey(c));
    }
  }

  return {
    dimension,
    anchorRows,
    singleConsistent,
    singleScored,
    pairSolutions,
    poolBits,
  };
}

function singleBitDiagnostics(search: DimensionSearch): string[] {
  const lines: string[] = [];
  const ranked = [...search.singleScored]
    .sort((a, b) => a.mismatches.length - b.mismatches.length)
    .slice(0, 8);
  lines.push(
    `  Stage 1 (single bit): ${search.singleConsistent.length} consistent ` +
      `of ${search.singleScored.length} searched. Best candidates:`,
  );
  for (const s of ranked) {
    const detail = s.mismatches
      .map(
        (a) =>
          `${a.name}(${a.spellId}) expected ${String(a[search.dimension])}`,
      )
      .join("; ");
    lines.push(
      `    ${candidateKey(s.candidate)}: ${s.mismatches.length} mismatch(es)` +
        (detail ? ` -- ${detail}` : ""),
    );
  }
  return lines;
}

/**
 * Resolve one dimension's final (single- or dual-bit) combo, given every
 * dimension's raw search result (needed for the cross-dimension tie-break)
 * and the SpellMisc row lookup (needed for stage-3 tie-break anchors, which
 * are not part of UWC_ANCHORS's anchorRows).
 */
function resolveDimension(
  search: DimensionSearch,
  allSearches: Record<Dimension, DimensionSearch>,
  byId: Map<string, Record<string, string>>,
): DimensionOutcome {
  if (search.singleConsistent.length === 1) {
    const combo: [Candidate] = [search.singleConsistent[0]!.candidate];
    return {
      kind: "single",
      combo,
      note: `single-bit ${candidateKey(combo[0])}, unique 100% match against ${search.anchorRows.length} anchors`,
    };
  }

  const lines = [
    `[genUsableWhileCc] ${search.dimension}: expected exactly 1 consistent single-bit candidate ` +
      `against ${search.anchorRows.length} non-null anchors, found ${search.singleConsistent.length}.`,
    ...singleBitDiagnostics(search),
  ];

  if (search.pairSolutions.length === 0) {
    lines.push(
      `  Stage 2 (<=2-bit OR-union, ${ALL_CANDIDATES.length} choose 2 = ` +
        `${(ALL_CANDIDATES.length * (ALL_CANDIDATES.length - 1)) / 2} combinations): ` +
        `0 unions match all ${search.anchorRows.length} anchors. This is conclusive for pure` +
        ` OR-union search -- a base candidate that already wrongly INCLUDES a false anchor` +
        ` can never be fixed by unioning in a second bit (union only adds members). No` +
        ` (<=2-bit) SpellMisc union explains this dimension.`,
    );
    return { kind: "unresolved", errorLines: lines };
  }

  if (search.pairSolutions.length === 1) {
    const combo = search.pairSolutions[0]! as [Candidate, Candidate];
    return {
      kind: "pair",
      combo,
      note: `2-bit union ${comboKey(combo)}, unique 100% match at stage 2`,
    };
  }

  // Stage 2b: multiple tied 2-bit solutions -- family-consistency tie-break.
  // Score each pair by how many OTHER dimensions' own solution pools
  // reference either of its two bits (presence per dimension, not
  // occurrence count within a pool).
  const otherDims = DIMENSIONS.filter((d) => d !== search.dimension);
  const scored = search.pairSolutions.map((combo) => {
    const score = combo.reduce((sum, c) => {
      const key = candidateKey(c);
      const dimsSharing = otherDims.filter((d) =>
        allSearches[d].poolBits.has(key),
      ).length;
      return sum + dimsSharing;
    }, 0);
    return { combo, score };
  });
  const maxScore = Math.max(...scored.map((s) => s.score));
  let atMax = scored.filter((s) => s.score === maxScore);

  lines.push(
    `  Stage 2b: ${search.pairSolutions.length} tied 2-bit unions all 100% consistent.` +
      ` Family-consistency tie-break (score = count of OTHER dimensions whose own` +
      ` candidate pool references either bit):`,
  );
  for (const s of scored) {
    lines.push(`    ${comboKey(s.combo)}: score ${s.score}`);
  }

  if (atMax.length === 1) {
    const combo = atMax[0]!.combo as [Candidate, Candidate];
    return {
      kind: "pair",
      combo,
      note:
        `2-bit union ${comboKey(combo)}, chosen from ${search.pairSolutions.length}` +
        ` tied candidates by family-consistency tie-break (score ${maxScore})`,
    };
  }

  // Stage 3: tie-break anchors (unsigned spot-checks), if this dimension has
  // any defined.
  const tieAnchors = TIEBREAK_ANCHORS[search.dimension];
  if (tieAnchors && tieAnchors.length > 0) {
    lines.push(
      `  Stage 2b inconclusive (${atMax.length} tied at score ${maxScore}).` +
        ` Stage 3: applying ${tieAnchors.length} unsigned tie-break anchors` +
        ` (wowhead spot-checks, see TIEBREAK_ANCHORS doc comment):`,
    );
    const survivors = atMax.filter((s) => {
      const rowsFor = tieAnchors.map((a) => byId.get(a.spellId));
      return tieAnchors.every((a, ai) => {
        const row = rowsFor[ai];
        const actual = row ? s.combo.some((c) => bitAt(row, c)) : false;
        return actual === a.expected;
      });
    });
    for (const s of atMax) {
      const verdicts = tieAnchors.map((a) => {
        const row = byId.get(a.spellId);
        const actual = row ? s.combo.some((c) => bitAt(row, c)) : false;
        return `${a.name}=${actual === a.expected ? "OK" : "MISS"}`;
      });
      lines.push(`    ${comboKey(s.combo)}: ${verdicts.join(", ")}`);
    }
    if (survivors.length === 1) {
      const combo = survivors[0]!.combo as [Candidate, Candidate];
      return {
        kind: "pair",
        combo,
        note:
          `2-bit union ${comboKey(combo)}, chosen from ${atMax.length} stage-2b-tied` +
          ` candidates by stage-3 tie-break anchors (unsigned, wowhead-sourced,` +
          ` pending Task 4 corpus corroboration -- see TIEBREAK_ANCHORS)`,
      };
    }
    atMax = survivors;
    lines.push(
      `  Stage 3 result: ${survivors.length} candidates survive (need exactly 1).`,
    );
  }

  lines.push(
    `  Tie-break inconclusive: ${atMax.length} candidate(s) remain. No further` +
      ` disambiguation rule -- unresolved.`,
  );
  return { kind: "unresolved", errorLines: lines };
}

/** Sorted numeric-ascending string ids, for stable/reviewable output. */
function sortedIds(set: Set<string>): string[] {
  return [...set].sort((a, b) => Number(a) - Number(b));
}

function nameStats(
  ids: string[],
  spellNames: Record<string, string>,
): { named: number; missing: number; sample: string } {
  let named = 0;
  const samples: string[] = [];
  for (const id of ids) {
    const name = spellNames[id];
    if (name) {
      named++;
      if (samples.length < 12) samples.push(`${id} ${name}`);
    }
  }
  return {
    named,
    missing: ids.length - named,
    sample: samples.join(", "),
  };
}

/** Header lines documenting a dimension left out of the emitted table
 * (feared/confused, 2026-08-14 scope decision) -- structural evidence +
 * disposition, so a reader of the generated file understands the gap
 * without re-deriving it. */
function gapNoteLines(
  dimension: Dimension,
  outcome: DimensionOutcome,
): string[] {
  if (outcome.kind !== "unresolved") return [];
  const summary =
    dimension === "feared"
      ? "structurally impossible via <=2-bit OR-union (exhaustive 147,696-combo search, 0 solutions -- the best single-bit candidates already wrongly include a false anchor, which no union can remove)"
      : "35 tied 2-bit unions, family-consistency tie-break narrows only to 10 -- insufficient anchors to disambiguate further";
  return [
    ` * ${dimension}: NOT emitted (known gap, 2026-08-14 scope decision). ${summary}.`,
    ` *   Disposition: hand-written layer (cooldowns.ts USABLE_WHILE_CC_SPELL_IDS) stays`,
    ` *   authoritative for ${dimension}; see task-3-report.md for full diagnostics, Task 4`,
    ` *   (corpus-driven evidence) for further corroboration, and`,
    ` *   docs/ability-fact-inventory.md A2 for other official-table candidates.`,
  ];
}

export async function main(): Promise<void> {
  const build = await resolveBuild(process.argv[2]);
  const cacheDir = process.env.DATAGEN_CACHE ?? undefined;
  const parsed = parseCsv(await fetchTable("SpellMisc", build, cacheDir));
  assertColumns(
    parsed.header,
    [...ATTR_COLUMNS, "SpellID", "DifficultyID"],
    "SpellMisc",
  );

  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    if (row.DifficultyID !== "0" || !row.SpellID || seen.has(row.SpellID))
      continue;
    seen.add(row.SpellID);
    rows.push(row);
  }
  const byId = new Map(rows.map((r) => [r.SpellID, r]));

  const searches: Record<Dimension, DimensionSearch> = {
    stunned: searchDimension("stunned", byId),
    feared: searchDimension("feared", byId),
    confused: searchDimension("confused", byId),
  };

  const outcomes: Record<Dimension, DimensionOutcome> = {
    stunned: resolveDimension(searches.stunned, searches, byId),
    feared: resolveDimension(searches.feared, searches, byId),
    confused: resolveDimension(searches.confused, searches, byId),
  };

  for (const d of DIMENSIONS) {
    const o = outcomes[d]!;
    if (o.kind === "unresolved") {
      for (const line of o.errorLines) console.error(line);
    } else {
      console.log(`[genUsableWhileCc] ${d}: RESOLVED (${o.note})`);
    }
  }

  const requiredFailures = EMITTED_DIMENSIONS.filter(
    (d) => outcomes[d]!.kind === "unresolved",
  );
  if (requiredFailures.length > 0) {
    console.error(
      `[genUsableWhileCc] required dimension(s) unresolved: ${requiredFailures.join(", ")} -- no table emitted.`,
    );
    process.exit(1);
    return;
  }

  const spellNames = JSON.parse(
    fs.readFileSync(
      new URL("../../src/data/spellNames.json", import.meta.url).pathname,
      "utf8",
    ),
  ) as Record<string, string>;

  // SpellMisc's full domain is ~410k rows covering NPC/monster/quest/
  // environment spells, not just player abilities -- the raw stunned union
  // came out to 161,086 members (39% of the whole table) before this
  // restriction, which is not a search bug (verified: it really is that
  // broad a flag over the FULL table) but is useless bloat for this
  // consumer (cooldowns.ts only ever queries ids that actually appear in
  // PvP combat logs). Restrict to the observed corpus, same convention as
  // genOffGcd.ts ("Restricted to the observed universe ... so the table is
  // tiny"). This must only apply to the EMITTED table, not to anchor
  // scoring (see unionSet's doc comment).
  //
  // Reverse-direction error this introduces (official != verification-free,
  // both directions matter): a real player ability that IS mechanically
  // usable while stunned but hasn't yet appeared in this 3353-id snapshot of
  // observedSpellIdsGenerated (new patch, rare spec, or just not yet in the
  // corpus) will be a silent false negative here -- `.has()` returns false
  // even though the true SpellMisc bit is set. This self-heals automatically
  // the next time observedSpellIdsGenerated is refreshed and this generator
  // re-run (both are update-wow-data.md steps), but is a real gap between
  // refreshes; a consumer must not treat `.has() === false` as "confirmed
  // not usable while stunned" for an unobserved id.
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

  const dataDir = new URL("../../src/data/", import.meta.url).pathname;
  const perDim = {} as Record<
    (typeof EMITTED_DIMENSIONS)[number],
    {
      combo: Candidate[];
      note: string;
      ids: string[];
      named: number;
      missing: number;
      sample: string;
    }
  >;
  for (const d of EMITTED_DIMENSIONS) {
    const o = outcomes[d]!;
    if (o.kind === "unresolved") continue;
    const memberSet = unionSet(rows, o.combo, observed);
    const ids = sortedIds(memberSet);
    const stats = nameStats(ids, spellNames);
    perDim[d] = { combo: o.combo, note: o.note, ids, ...stats };
    if (stats.missing > 0) {
      console.warn(
        `[genUsableWhileCc] ${d}: ${stats.missing}/${ids.length} spellIds have no entry in spellNames.json`,
      );
    }
  }

  const winnersLine = EMITTED_DIMENSIONS.map(
    (d) => `${d}=${comboKey(perDim[d]!.combo)}`,
  ).join("  ");
  const countsLine = EMITTED_DIMENSIONS.map(
    (d) =>
      `${d}:${perDim[d]!.ids.length}(named:${perDim[d]!.named} missing:${perDim[d]!.missing})`,
  ).join(" ");
  const notesBlock = EMITTED_DIMENSIONS.map(
    (d) => ` * ${d}: ${perDim[d]!.note}`,
  ).join("\n");
  const samplesBlock = EMITTED_DIMENSIONS.map(
    (d) => ` * ${d} sample: ${perDim[d]!.sample || "(none named)"}`,
  ).join("\n");
  const gapBlock = DIMENSIONS.filter(
    (d) => !(EMITTED_DIMENSIONS as readonly string[]).includes(d),
  )
    .flatMap((d) => gapNoteLines(d, outcomes[d]!))
    .join("\n");

  const header =
    `/**\n` +
    ` * Generated at: ${new Date().toISOString()}\n` +
    ` * Build: ${build}\n` +
    ` * Source: DB2 SpellMisc.Attributes_0..16, <=2-bit OR-union search anchored\n` +
    ` *   against UWC_ANCHORS (${UWC_ANCHORS.length} user-signed anchors, see\n` +
    ` *   scripts/datagen/usableWhileCcAnchors.ts). Winning bit combo(s):\n` +
    ` *   ${winnersLine}\n` +
    ` * Restricted to the observed corpus (observedSpellIdsGenerated.json) --\n` +
    ` *   the raw full-table union was 161,086/410,502 SpellMisc rows (39%,\n` +
    ` *   overwhelmingly NPC/quest/environment spells no consumer here queries);\n` +
    ` *   same convention as offGcdGenerated.ts. Anchor scoring itself ran\n` +
    ` *   unrestricted (see unionSet() doc comment). CAVEAT (false negatives):\n` +
    ` *   a real ability that IS usable while stunned but hasn't appeared yet in\n` +
    ` *   this observed-corpus snapshot is silently ABSENT here -- do not read\n` +
    ` *   .has()===false as "confirmed not usable while stunned" for an\n` +
    ` *   unobserved id. Self-heals on the next observedSpellIdsGenerated +\n` +
    ` *   genUsableWhileCc regen (update-wow-data.md).\n` +
    `${notesBlock}\n` +
    ` * ${countsLine}\n` +
    `${samplesBlock}\n` +
    ` *\n` +
    `${gapBlock}\n` +
    ` */\n\n`;

  const body =
    `export interface UsableWhileCcGenerated {\n` +
    `  stunned: ReadonlySet<string>;\n` +
    `}\n\n` +
    `export const USABLE_WHILE_CC_GENERATED: UsableWhileCcGenerated = {\n` +
    EMITTED_DIMENSIONS.map(
      (d) => `  ${d}: new Set(\n    ${JSON.stringify(perDim[d]!.ids)},\n  ),`,
    ).join("\n") +
    `\n};\n`;

  writeArtifact(dataDir + "usableWhileCcGenerated.ts", header + body);
  console.log(
    `usableWhileCcGenerated.ts: ${countsLine} (build ${build}, winners ${winnersLine})`,
  );
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genUsableWhileCc.ts")
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
