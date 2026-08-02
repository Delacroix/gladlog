/**
 * Spell id lists (a compliance-safe replacement for spellIdLists.json — the
 * original file is upstream ND-period material and is not carried over).
 * Source: Blizzard's public game facts. Replaced by subproject 5's pipeline
 * output.
 */
const spellIdLists = {
  // Major personal defensive walls (excluding external damage reduction)
  bigDefensiveSpellIds: [
    "642", "45438", "871", "48792", "104773", "115203", "186265", "196555",
    "31224", "61336", "122470", "108271", "363916", "31850", "86659", "22812",
    "118038", "184364", "19236", "47585", "498",
  ],
  // External damage reduction (survival cooldowns cast on a teammate)
  externalDefensiveSpellIds: [
    "33206", // Pain Suppression
    "47788", // Guardian Spirit
    "102342", // Ironbark
    "6940", // Blessing of Sacrifice
    "1022", // Blessing of Protection
    "204018", // Blessing of Spellwarding
    "116849", // Life Cocoon
    "62618", // Power Word: Barrier
    "98008", // Spirit Link Totem
    "97462", // Rallying Cry
    "196718", // Darkness
    "51052", // Anti-Magic Zone
    "357170", // Time Dilation
    "374227", // Zephyr
  ],
  // External or major personal defensives (the list above + the main personal
  // walls)
  externalOrBigDefensiveSpellIds: [
    "33206", "47788", "102342", "6940", "1022", "204018", "116849",
    "62618", "98008", "97462", "196718", "51052", "357170", "374227",
    "642", "45438", "871", "48792", "104773", "115203", "186265",
    "196555", "31224", "61336", "122470", "108271", "363916", "31850", "86659",
    "22812", "5277", "118038", "184364", "19236", "47585", "498", "64843", "740", "200183",
  ],
};
export default spellIdLists;
