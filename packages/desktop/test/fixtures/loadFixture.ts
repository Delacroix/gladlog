import { readFileSync } from "fs";

import type {
  StoredMatch,
  StoredShuffle,
  StoredShuffleRound,
} from "../../src/renderer/src/report/derive/types";

export function loadMatchFixture(): StoredMatch {
  const base = import.meta.url;
  return JSON.parse(
    readFileSync(new URL("report-match.json", base).pathname, "utf-8"),
  ) as StoredMatch;
}

/**
 * A real 3v3 match (Nagrand Arena, a win) — trimmed to the first 90 seconds and
 * anonymized (character names/GUIDs → generic names), with the event arrays
 * rendering does not need (actionsIn/Out, healIn, absorbsIn) and the raw params
 * removed. Used to exercise rendering (meters / timeline / unit details /
 * replay) against real positioning and ability data.
 */
export function loadRealMatchFixture(): StoredMatch {
  const base = import.meta.url;
  return JSON.parse(
    readFileSync(new URL("real-match-sample.json", base).pathname, "utf-8"),
  ) as StoredMatch;
}

/**
 * The real fixture with the enemy buffs that blanket the sweep in missed-purge
 * findings removed (Power Word: Shield / Ice Barrier / Prayer of Mending), so
 * that at least one 20s sweep window still carries signal without carrying a
 * finding anchor.
 *
 * Why it exists (2026-08-13): PW:S and Ice Barrier became moderate-priority
 * purge targets, so the fixture's enemies now carry several genuinely
 * un-purged shield windows — real findings, verified in the log (a 15.5s PW:S
 * among them). Their anchors legitimately cover the whole sweep, which would
 * silently gut the tests that need an UNCOVERED window to exist at all (the
 * uncovered-highlight card would simply never render). Stripping them restores
 * the finding landscape those tests were written against, instead of weakening
 * their assertions or pinning "0 highlights", which would assert nothing.
 *
 * Second round (2026-08-17, commit e027c06c "驱散可用性的候选名单闭环"): the
 * same failure mode, one layer deeper. That commit wired
 * observedSpellIdsGenerated.json in as a 9th candidate source for
 * getDispelType, so 145 spells that previously had NO entry in
 * spellEffectGenerated.json at all — i.e. that the product wrongly believed to
 * be un-purgeable — gained their official dispelType. Two of them are on this
 * fixture's enemies: Prayer of Mending (41635) and Void Shield (1253593), both
 * `dispelType: "Magic"` now, absent from the generated data before. Prayer of
 * Mending alone produces four extra missed-purge-kill-window anchors at
 * 73.98 / 75.838 / 81.303 / 82.366s, which is exactly what buried the last
 * uncovered window: 9 of 9 sweep windows covered, deriveUncoveredHighlights →
 * [] (measured; the two test files below went 8/8 → 5/8 on that commit).
 * Removing 41635 restores the pre-e027c06c anchor landscape exactly — 80–90s
 * uncovered again, every other window still covered by a real finding.
 * Void Shield is deliberately NOT stripped: its anchors (66.3s) sit far from
 * the last window, and keeping them means the dedup assertion is still carried
 * by genuine purge findings rather than by leftovers of other classes.
 *
 * The production behaviour is correct in both rounds — more purgeable debuffs
 * is the intended result — so what gets adjusted is the fixture's premise, not
 * the assertions.
 */
export function loadRealMatchFixtureWithUncoveredWindow(): StoredMatch {
  const m = loadRealMatchFixture() as unknown as {
    units: Record<string, { auraEvents?: Array<{ spellId?: string }> }>;
  };
  // PW:S / Ice Barrier / Prayer of Mending — see the comment above for what
  // each one buries.
  const PURGE_ANCHOR_IDS = new Set(["17", "11426", "41635"]);
  for (const unit of Object.values(m.units ?? {})) {
    if (!Array.isArray(unit.auraEvents)) continue;
    unit.auraEvents = unit.auraEvents.filter(
      (a) => !PURGE_ANCHOR_IDS.has(String(a.spellId ?? "")),
    );
  }
  return m as unknown as StoredMatch;
}

export function buildSyntheticShuffle(base: StoredMatch): StoredShuffle {
  const rounds: StoredShuffleRound[] = [0, 1, 2].map((i) => ({
    ...base,
    kind: "shuffleRound" as const,
    sequenceNumber: i,
    // no shift: event timestamps are untouched, keeping everything consistent
    startTime: base.startTime,
    endTime: base.endTime,
    winningTeamId: i % 2,
  }));
  return {
    kind: "shuffle",
    rounds,
    startTime: rounds[0]!.startTime,
    endTime: rounds[2]!.endTime,
    result: base.result,
  };
}
