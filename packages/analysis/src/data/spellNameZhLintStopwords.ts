/**
 * Explicit denylist for spellNameZhLint -- these are NOT "candidates awaiting
 * inclusion", they are **empirically confirmed false positives**, recorded so
 * nobody later sweeps them back into spellNameZhLintTable.ts with a mechanical
 * filter (length / unique EN mapping).
 *
 * Each entry happens to be the official Chinese translation of some obscure WoW
 * spell while ALSO being an ordinary tactical/colloquial phrase or idiom that
 * naturally appears in coaching narration. Criterion (REVIEWABLE): confirmed by
 * reading the hit context by hand in real DeepSeek production corpus
 * (ds-sim-2026-07-31 220 matches + agy-sim-2026-07-31 300 matches +
 * win16-sim-2026-07-31 41 matches, 561 total) -- the occurrence is a
 * descriptive Chinese phrase, not a reference to the colliding spell (i.e. the
 * spell's English name does not appear in the same sentence/paragraph as
 * corroboration).
 *
 * Case by case:
 *   - 集中火力 (-> Focus Fire, a hunter pet ability): used as the generic
 *     "focus damage on one target" tactical term, e.g. "never focused fire";
 *     any coach in any game says this.
 *   - 战斗分析 (-> Combat Analysis): appears in section headings like
 *     "## Combat analysis report"; a report-genre word, not a spell reference.
 *   - PvP饰品 (-> PvP Trinket): refers to the equipment slot generically
 *     ("your PvP trinket is on cooldown"), not to a spell of that name.
 *   - 危急时刻 (-> Time of Need, a hunter talent): the generic "critical
 *     moment" phrase ("it was not a critical moment" / "the read on the
 *     critical moment was right"); all 12 hits across 561 matches are this.
 *   - 快速治疗 (-> Flash Heal): describes the action "quickly heal"
 *     ("stabilize with XX plus a quick heal"), not the spell of that name.
 *   - 驱散魔法 (-> Dispel Magic): the generic verb phrase "can dispel the
 *     magic effect"; already recorded as a confusable case in scan200.md.
 *   - 防御姿态 (-> Defensive Stance, a warrior stance): the generic
 *     "defensive posture" description ("went defensive" / "never went
 *     defensive at all"); all 3 hits are this.
 *   - 生死攸关 (-> Life and Death, a monk ability): a Chinese idiom meaning
 *     "life-and-death critical moment", high frequency in everyday
 *     Chinese-language report prose.
 *   - 剑在人在 (-> Die by the Sword, a warrior ability): itself a Chinese
 *     idiom. Even if a few corpus hits really do reference the spell, the risk
 *     of admitting an idiom (it would fire in arbitrary unrelated contexts)
 *     outweighs the benefit of catching those.
 *   - 局势逆转 (-> Turn the Tables): used as a subheading describing a swing
 *     in the match, not a spell reference (the spell's English name appears
 *     nowhere in the hit file).
 *   - 致命一击 (-> Coup de Grace, a rogue ability): the generic combat term
 *     "finishing blow"; both hits are descriptive usage.
 *   - 法术反射 (-> Spell Reflection, a warrior ability): both hits describe
 *     the mechanical effect of a **different** spell (Nether Ward, called a
 *     "spell reflection shield"), not Spell Reflection itself.
 *   - 解除诅咒 (-> Remove Curse): both hits are section headings ("### Remove
 *     Curse and offensive dispels"), and one is immediately followed by the
 *     English gloss "(Remove Curse)" -- already the inline-annotation form the
 *     product allows, so it must not count as a violation.
 *
 * Before adding an exclusion, find a concrete counterexample in the real corpus
 * (file + line number); do not go on the intuition that something "sounds like
 * a common word" -- that kills real violations too (#15 icon matching depends
 * on this table's recall).
 */
export const SPELL_NAME_ZH_LINT_STOPWORDS: ReadonlySet<string> = new Set([
  "集中火力",
  "战斗分析",
  "PvP饰品",
  "危急时刻",
  "快速治疗",
  "驱散魔法",
  "防御姿态",
  "生死攸关",
  "剑在人在",
  "局势逆转",
  "致命一击",
  "法术反射",
  "解除诅咒",
]);
