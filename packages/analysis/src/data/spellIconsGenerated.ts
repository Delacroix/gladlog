/**
 * Generated at: 2026-07-25T10:27:30.252Z
 * Build: 12.1.0.68629
 * Mined: 41707 (universe = corpus-attested u SpellCooldowns u candidates)
 * The data lives in the .json of the same name (vite json.stringify ->
 * JSON.parse loading — the big-JSON lesson).
 * That .json is dictionary-encoded {names, ids}: 41,707 entries share only
 * ~7,110 distinct icon names, so a flat Record would be 48% duplicated strings
 * (1.5MB -> 780KB). It is expanded back into a Record here; the consumer-facing
 * API is unchanged.
 */

import rawIcons from "./spellIconsGenerated.json";

const { names, ids } = rawIcons as unknown as {
  names: string[];
  ids: Record<string, number>;
};

const expanded: Record<string, string> = {};
for (const id in ids) expanded[id] = names[ids[id]!]!;

export const SPELL_ICONS_GENERATED: Record<string, string> = expanded;
