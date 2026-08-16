import { memoizeWhenReady } from "./memoize";

import { nodeMaps, talentDataReady } from "../data/talentStrings";

type HeroTalent = {
  id: number;
  type: string;
  name: string;
  traitSubTreeId: number;
  traitTreeId: number;
  atlasMemberName: string;
  nodes: number[];
};

// Loaded in the background rather than via top-level await (design note in
// data/spellEffectData.ts): it is the same talentIdMap.json, and the module
// cache guarantees it is read only once, shared with talentStrings.
let heroTalentMap: Record<number, HeroTalent> = {};
let heroReady = false;
const heroLoad = import("../data/talentIdMap.json").then((mod) => {
  heroTalentMap = ((mod.default ?? mod) as any[])
    .flatMap((a) => a.subTreeNodes)
    .flatMap((n) => n.entries)
    .reduce(
      (prev, cur) => {
        prev[cur.id] = cur;
        return prev;
      },
      {} as Record<number, HeroTalent>,
    );
  heroReady = true;
});
export const ensureHeroTalents = (): Promise<void> => heroLoad;

export const findHeroTalent = memoizeWhenReady(
  () => heroReady,
  (talents: ({ id2: number } | null)[]): HeroTalent | null => {
    const heroTalentId = talents.find(
      (e) => e && Object.keys(heroTalentMap).includes(`${e.id2}`),
    );
    return heroTalentId ? heroTalentMap[heroTalentId.id2] : null;
  },
);

/**
 * Returns a mapping of spell IDs the player actually has from their talent tree
 * to their entry type ('active' for buttons, 'passive' for modifications).
 * For choice nodes, only the chosen entry's spell is included.
 * Returns null if talent data is unavailable (no filtering should be applied).
 */
export function getPlayerTalentedSpellInfo(
  specId: number,
  talents: ({ id1: number; id2: number; count: number } | null)[],
): Map<string, { type: string; name: string }> | null {
  const specData = nodeMaps[specId];
  if (!specData) return null;

  const result = new Map<string, { type: string; name: string }>();

  for (const talent of talents) {
    if (!talent || talent.count === 0) continue;

    const node =
      specData.classNodeMap[talent.id1] ??
      specData.specNodeMap[talent.id1] ??
      specData.heroNodeMap[talent.id1];

    if (!node) continue;

    if ((node.type === "choice" || node.type === "subtree") && talent.id2 > 0) {
      // Choice node — only the chosen entry is active
      const entry = node.entries.find((e) => e.id === talent.id2);
      if (entry && "spellId" in entry && entry.spellId) {
        result.set(entry.spellId.toString(), {
          type: entry.type,
          name: entry.name,
        });
      }
    } else {
      // Single (or ranked) node — all entries are active
      for (const entry of node.entries) {
        if ("spellId" in entry && entry.spellId) {
          result.set(entry.spellId.toString(), {
            type: entry.type,
            name: entry.name,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Returns the set of spell IDs the player actually has from their talent tree.
 * @deprecated Use getPlayerTalentedSpellInfo for richer metadata.
 */
export function getPlayerTalentedSpellIds(
  specId: number,
  talents: ({ id1: number; id2: number; count: number } | null)[],
): Set<string> | null {
  const info = getPlayerTalentedSpellInfo(specId, talents);
  if (!info) return null;
  return new Set(info.keys());
}

/**
 * True when every purchased row (count > 0) of the player's COMBATANT_INFO
 * talents resolves to a node of the CURRENT build's tree data (class/spec/
 * hero/subtree maps). A loadout recorded on an older game build uses node ids
 * the current map no longer has, so tree-membership verdicts about it are
 * unreliable — measured on the live library (2026-08-11, 5195-unit sample):
 * current-build loadouts sit at exactly 1.00 resolvability, older-build ones
 * at 0.90–0.99, nothing below 0.90.
 */
export function isLoadoutFullyResolved(
  specId: number,
  talents: ({ id1: number; id2: number; count: number } | null)[],
): boolean {
  const specData = nodeMaps[specId];
  if (!specData) return false;
  for (const t of talents) {
    if (!t || t.count === 0) continue;
    if (!(
      specData.classNodeMap[t.id1] ??
      specData.specNodeMap[t.id1] ??
      specData.heroNodeMap[t.id1] ??
      specData.subtreeNodeMap[t.id1]
    ))
      return false;
  }
  return true;
}

/**
 * Spell IDs granted by tree nodes flagged `freeNode` or `entryNode` for this
 * spec. Auto-granted nodes are NOT reported in COMBATANT_INFO (measured
 * 2026-08-11: Enhancement's Chain Lightning entry node 103583 was absent from
 * every one of 214 loadouts whose owner cast the spell), so "node not in the
 * player's talents" must not be read as "player doesn't have it" for these.
 */
export const getSpecFreeOrEntrySpellIds = memoizeWhenReady(
  talentDataReady,
  (specId: number): Set<string> => {
    const specData = nodeMaps[specId];
    const result = new Set<string>();
    if (!specData) return result;
    const allNodes = [
      ...specData.classNodes,
      ...specData.specNodes,
      ...(specData.heroNodes ?? []),
    ];
    for (const node of allNodes) {
      const flags = node as { freeNode?: boolean; entryNode?: boolean };
      if (!flags.freeNode && !flags.entryNode) continue;
      for (const entry of node.entries) {
        if ("spellId" in entry && entry.spellId)
          result.add(entry.spellId.toString());
      }
    }
    return result;
  },
);

/**
 * Returns a mapping of all spell IDs that exist anywhere in the given spec's talent tree
 * to their entry type.
 * Used to distinguish talent-gated spells from baseline spells.
 */
export const getSpecTalentTreeSpellInfo = memoizeWhenReady(
  talentDataReady,
  (specId: number): Map<string, { type: string; name: string }> => {
    const specData = nodeMaps[specId];
    if (!specData) return new Map();

    const result = new Map<string, { type: string; name: string }>();
    const allNodes = [
      ...specData.classNodes,
      ...specData.specNodes,
      ...(specData.heroNodes ?? []),
    ];

    for (const node of allNodes) {
      for (const entry of node.entries) {
        if ("spellId" in entry && entry.spellId) {
          result.set(entry.spellId.toString(), {
            type: entry.type,
            name: entry.name,
          });
        }
      }
    }

    return result;
  },
);

/**
 * Returns the set of all spell IDs that exist anywhere in the given spec's talent tree.
 * @deprecated Use getSpecTalentTreeSpellInfo for richer metadata.
 */
export const getSpecTalentTreeSpellIds = memoizeWhenReady(
  talentDataReady,
  (specId: number): Set<string> => {
    const info = getSpecTalentTreeSpellInfo(specId);
    return new Set(info.keys());
  },
);
