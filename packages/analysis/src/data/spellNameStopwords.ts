/**
 * Stopword list for the English spell-name inverted index (englishNameIndex()
 * in spellNameLookup.ts).
 *
 * Background: the DB2 spell-name universe is littered with single common
 * English words that collide with rare/placeholder spell ids never actually
 * observed in the corpus. The fallback chain in inlineRich.tsx:135-138 (used
 * in this match ?? observed in the corpus ?? lowest id) degrades to "the
 * numerically smallest id" once the first two levels miss — semantically
 * unrelated, and usually a placeholder icon (e.g. "Stun" → id 56 → the generic
 * hammer inv_mace_02). Such common words appear constantly in AI prose, so
 * ordinary English words were being wrapped in the wrong spell icon. Full audit
 * provenance is in the commit history (fix(analysis): inline-icon stopword list
 * landed, plus its review rounds); only the actionable criteria are kept here.
 *
 * Inclusion criteria (REVIEWABLE — "it's a common word" is not enough:
 * "Charge" is a common word too, but the corpus observes it daily, so it must
 * keep its icon and must not enter this list):
 *   (a) none of the candidate ids under that name are in OBSERVED_SPELL_IDS; or
 *   (b) an id IS in OBSERVED_SPELL_IDS, but the audit established it is a
 *       placeholder / fringe effect (e.g. "Death" = id 327095, a Shadowlands
 *       covenant fringe effect, not a coachable ability).
 *
 * Re-run the same script before adding entries; do not add words by feel.
 * Under-inclusion (fill it in later when the corpus reports it) is cheaper than
 * over-inclusion (which makes a real spell icon disappear and is much harder to
 * notice), so this batch is deliberately conservative.
 */
export const SPELL_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  // Collisions established by the audit (criterion b)
  "Stun",
  "Death",
  // Mechanical scan: zero observed ids + top 1000 by general word frequency
  // (google-10000-english) (criterion a)
  "Search",
  "Web",
  "Message",
  "Book",
  "Special",
  "Open",
  "Return",
  "Food",
  "Select",
  "Start",
  "Air",
  "Yes",
  "Test",
  "Play",
  "Memory",
  "Sell",
  "Experience",
  "Release",
  "Analysis",
  "Learning",
  "Run",
  "Net",
  "Radio",
  "Gold",
  "Land",
  "Style",
  "Document",
  "Reading",
  "Cover",
  "Submit",
  "Engineering",
  "Speed",
  // Zero observed ids + high frequency in arena-coaching prose specifically;
  // ranked low in the general frequency table, so judged in by hand
  // (criterion a)
  "Target",
  "Move",
  "Focus",
  "Break",
  "Jump",
  "Pet",
  "Block",
  "Shot",
  "Impact",
  // Added during a review round (criterion a): all 47 candidate ids for "Heal"
  // are unobserved, and in a healer-coaching product the bare word "Heal" is
  // one of the highest-frequency reproduction paths; Push/Pull have 1 candidate
  // id each, likewise unobserved.
  // Damage/Kill/Cast/Range were checked: no id in the current
  // SPELL_ICONS_GENERATED (the icon universe) carries those exact names — they
  // are not in the candidate set englishNameIndex walks, so they pose no risk
  // today and are not included. If a future datagen run brings them into the
  // icon universe, re-run the same script to decide; do not move them in on
  // assumption.
  "Heal",
  "Push",
  "Pull",
]);
