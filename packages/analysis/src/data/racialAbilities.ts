/**
 * Racial abilities (2026-08-12). The combat log carries NO race field —
 * `COMBATANT_INFO` has class, spec, talents and equipment, but nothing that
 * says "human" — so racial ownership can only ever be established **passively**:
 * a cast observed in the log proves the player has it, and the absence of a
 * cast proves nothing at all. Every consumer of this table must therefore be
 * evidence-driven (credit what was cast); nothing here may be used to assert
 * that a player *lacks* an ability, the way the talent trees allow
 * (`talentOwnershipOf`'s "no").
 *
 * How the list was validated (whitelist-rot rule — never hand-curated from
 * memory): a corpus sweep over 150 local matches collected every cast id that
 * is absent from `classMetadata` yet cast by ≥4 distinct classes — the
 * empirical signature of a race-granted button — and each surviving id was
 * named from the raw log text. That sweep confirmed the ids below and also
 * surfaced Spatial Rift's second id (257040, the follow-up teleport), which a
 * hand-written list would have missed. Ids the sweep attributed to items or
 * consumables (Gladiator's Medallion/Badge, Healthstone, …) are deliberately
 * absent. Racials for races nobody in the corpus played are still listed: with
 * a purely passive predicate an unused entry can never fire a false positive,
 * and it makes the table complete when such a player does show up.
 */

export type RacialKind =
  /** Removes loss-of-control / impairing effects — the PvP-trinket equivalent. */
  | "break"
  /** Offensive/throughput cooldown (burst windows). */
  | "offensive"
  /** Applies crowd control to the enemy (enters DR). */
  | "cc"
  /** Movement or escape. */
  | "mobility"
  /** Healing, mana, or other utility. */
  | "utility";

export interface RacialAbility {
  /** English name, the render form used everywhere in prompts. */
  name: string;
  kind: RacialKind;
  race: string;
}

export const RACIAL_ABILITIES: Record<string, RacialAbility> = {
  // --- break (trinket-equivalent) ---
  "59752": { name: "Will to Survive", kind: "break", race: "Human" },
  "7744": { name: "Will of the Forsaken", kind: "break", race: "Undead" },
  "20589": { name: "Escape Artist", kind: "break", race: "Gnome" },
  "265221": { name: "Fireblood", kind: "break", race: "Dark Iron Dwarf" },
  "20594": { name: "Stoneform", kind: "break", race: "Dwarf" },
  // --- offensive ---
  "20572": { name: "Blood Fury", kind: "offensive", race: "Orc" },
  "33697": { name: "Blood Fury", kind: "offensive", race: "Orc" },
  "33702": { name: "Blood Fury", kind: "offensive", race: "Orc" },
  "26297": { name: "Berserking", kind: "offensive", race: "Troll" },
  "274738": { name: "Ancestral Call", kind: "offensive", race: "Mag'har Orc" },
  "255647": {
    name: "Light's Judgment",
    kind: "offensive",
    race: "Lightforged Draenei",
  },
  "260364": { name: "Arcane Pulse", kind: "offensive", race: "Nightborne" },
  "312411": { name: "Bag of Tricks", kind: "offensive", race: "Vulpera" },
  // --- cc ---
  // DR membership is NOT assumed here: the official DB2 SpellCategories
  // DiminishType was probed for every id below (build 12.1.0.69273) and only
  // War Stomp (Stun), Quaking Palm (Incapacitate) and Haymaker (Stun) carry
  // one. Bull Rush, Wing Buffet and Tail Swipe have NO DiminishType, so they
  // must not be hand-added to the DR map — drAnalysis stays the single source
  // and takes its categories from that same official table.
  "20549": { name: "War Stomp", kind: "cc", race: "Tauren" },
  "107079": { name: "Quaking Palm", kind: "cc", race: "Pandaren" },
  "255654": { name: "Bull Rush", kind: "cc", race: "Highmountain Tauren" },
  "287712": { name: "Haymaker", kind: "cc", race: "Kul Tiran" },
  "368970": { name: "Tail Swipe", kind: "cc", race: "Dracthyr" },
  "357214": { name: "Wing Buffet", kind: "cc", race: "Dracthyr" },
  // --- mobility ---
  "58984": { name: "Shadowmeld", kind: "mobility", race: "Night Elf" },
  "68992": { name: "Darkflight", kind: "mobility", race: "Worgen" },
  "69070": { name: "Rocket Jump", kind: "mobility", race: "Goblin" },
  "256948": { name: "Spatial Rift", kind: "mobility", race: "Void Elf" },
  "257040": { name: "Spatial Rift", kind: "mobility", race: "Void Elf" },
  // --- utility ---
  "28730": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "25046": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "50613": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "69179": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "80483": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "129597": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "155145": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "202719": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "232633": { name: "Arcane Torrent", kind: "utility", race: "Blood Elf" },
  "59542": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "59543": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "59544": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "59545": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "59547": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "59548": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "121093": { name: "Gift of the Naaru", kind: "utility", race: "Draenei" },
  "291944": { name: "Regeneratin'", kind: "utility", race: "Zandalari Troll" },
};

const idsOfKind = (kind: RacialKind): Set<string> =>
  new Set(
    Object.entries(RACIAL_ABILITIES)
      .filter(([, v]) => v.kind === kind)
      .map(([id]) => id),
  );

/**
 * Single source for "this cast removed loss of control the way a PvP trinket
 * would". Consumed by ccTrinketAnalysis (crediting a CC as broken) — do not
 * re-derive a second list anywhere else.
 */
export const BREAK_RACIAL_SPELL_IDS: ReadonlySet<string> = idsOfKind("break");

/** Offensive racial cooldowns, for the burst/major-cooldown ledger. */
export const OFFENSIVE_RACIAL_SPELL_IDS: ReadonlySet<string> =
  idsOfKind("offensive");

/** English name of a racial spell id, or null when the id is not a racial. */
export function racialName(spellId: string): string | null {
  return RACIAL_ABILITIES[spellId]?.name ?? null;
}
