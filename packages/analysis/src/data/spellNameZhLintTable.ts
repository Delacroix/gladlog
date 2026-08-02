/**
 * Official zh localized spell name -> EN spell name (the lookup table used by
 * spellNameZhLint.ts for detection/repair).
 *
 * Background: the DeepSeek production simulation (220 matches,
 * `ds-sim-2026-07-31/scan200.md`) found that AI coach text occasionally renders
 * spell names in their official Chinese localization (e.g. 肾击 instead of
 * "Kidney Shot"), violating the product contract stated in the system prompt
 * ("keep spell names in English") and breaking the #15 inline icon scanner
 * (which only recognizes English name tokens). After hardening the system
 * prompt (commit b824e72) the residue went 14/14 -> 3/14, proving this is
 * probabilistic model behavior rather than a deterministic bug a prompt can
 * eliminate -- it needs a deterministic gate.
 *
 * Inclusion criterion (REVIEWABLE): the candidate set is NOT "mechanically
 * filter the whole spellNamesZhGenerated table" but a **positive list verified
 * entry by entry against real production corpus** -- see "why not a mechanical
 * length filter" below. Every entry satisfies:
 *   (a) observed in bare Chinese form in real DeepSeek production corpus
 *       (ds-sim-2026-07-31 220 matches + agy-sim-2026-07-31 300 matches +
 *       win16-sim-2026-07-31 41 matches, 561 total), not immediately followed
 *       by the "EN（zh）" inline-annotation form the product allows -- see the
 *       isGlossed guard in spellNameZhLint.ts;
 *   (b) the context was read by hand, entry by entry, and confirmed to be a
 *       **spell reference** (usually sitting in the same sentence/paragraph as
 *       other spell names correctly kept in English, which is hard evidence of
 *       "inconsistency within one response"), not a generic verb/noun phrase;
 *   (c) the id falls inside spellNamesZhGenerated (the production zh table,
 *       universe = icon set intersected with real translations), i.e. a spell
 *       the product actually displays/references.
 *
 * Why not a mechanical length filter (>=4 characters + unique EN mapping +
 * restricted to observedSpellIdsGenerated): it was tried. The candidate
 * universe is 1720 entries, but running that mechanical table over the same 561
 * real matches produced 37 distinct zh names of which 13 (35%) were false
 * positives -- common tactical/colloquial phrases that happen to collide with
 * some obscure spell's official translation (集中火力 / 战斗分析 / PvP饰品 /
 * 危急时刻 / 快速治疗 / 驱散魔法 / 防御姿态 / 生死攸关 / 剑在人在 / 局势逆转 /
 * 致命一击 / 法术反射 / 解除诅咒; full list with reasons in
 * spellNameZhLintStopwords.ts). The 1683 entries the corpus never triggered are
 * entirely unverified, and we cannot assume they are free of the same problem.
 * The cost of a wrong inclusion is that auto-repair replaces an ordinary word
 * inside a perfectly normal Chinese coaching sentence with an English word,
 * which reads bizarrely -- precision beats recall here, so only entries
 * "actually observed" are admitted, not the full table of "things that could
 * theoretically be spell names". New entries may only come from new corpus
 * evidence, never from guessing by length/uniqueness.
 *
 * 2 exceptions (under 4 -- even under 3 -- characters, which the intuition
 * "only obscure spells get long names" would normally exclude, but they are the
 * most frequent and most clear-cut violations in the corpus and must be listed
 * explicitly):
 *   - 肾击 (the short form of Kidney Shot, 2 characters): the only spell name
 *     in the 561-match corpus that still occasionally slips back into Chinese
 *     after mitigation (recorded in commit b824e72); 7/220 matches in the
 *     ds-sim corpus hit it directly, every one of them a verb-style spell
 *     reference ("kidney-shot the target"), none a generic phrase.
 *   - 熊形态 (Bear Form, 3 characters): 4 hits across agy-sim + ds-sim, all in
 *     the same sentence as spell names correctly kept in English such as
 *     "Barkskin" / "Ironbark".
 */
export const SPELL_NAME_ZH_TO_EN: Readonly<Record<string, string>> = {
  肾击: "Kidney Shot",
  熊形态: "Bear Form",
  迅捷治愈: "Swiftmend",
  冰冻陷阱: "Freezing Trap",
  铁木树皮: "Ironbark",
  神圣震击: "Holy Shock",
  守护之魂: "Guardian Spirit",
  生存本能: "Survival Instincts",
  保护祝福: "Blessing of Protection",
  制裁之锤: "Hammer of Justice",
  精神鞭笞: "Mind Flay",
  焦油陷阱: "Tar Trap",
  野性成长: "Wild Growth",
  自然迅捷: "Nature's Swiftness",
  十字军打击: "Crusader Strike",
  凋零缠绕: "Death Coil",
  天灾打击: "Scourge Strike",
  自由祝福: "Blessing of Freedom",
  牺牲祝福: "Blessing of Sacrifice",
  牺牲咆哮: "Roar of Sacrifice",
  大地之盾: "Earth Shield",
  风领主之击: "Strike of the Windlord",
  终极苦修: "Ultimate Penitence",
  光环掌握: "Aura Mastery",
  能量灌注: "Power Infusion",
};
