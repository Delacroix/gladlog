/**
 * SpellImplicitTarget values that denote a FRIENDLY unit other than (or in
 * addition to) the caster. Each value is listed with the spells in the
 * defensive universe that use it — the evidence it was derived from
 * (2026-08-22 scan of build 12.1.0.69382, all 47 Defensive-tagged cooldowns in
 * classMetadata plus every `externalDefensiveSpellIds` entry).
 *
 * NOT included, deliberately: 1 (UNIT_CASTER — self), 22 (SRC_CASTER, a
 * location rather than a unit; only ever seen alongside a real ally target on
 * Divine Hymn / Tranquility), 6 (UNIT_TARGET_ENEMY — Touch of Karma), 0 (no
 * target).
 *
 * 18 and 87 were in this set for a few hours on 2026-08-22 and are NOT ally
 * markers: they are DESTINATION targets (a point/area), and whether that area
 * hits friends or enemies is decided by the OTHER slot. The evidence that
 * settled it — every one of these carries 16 (UNIT_DEST_AREA_ENEMY) next to it:
 * War Stomp `t0=18,t1=16` · Ring of Frost `t0=87,t1=16` · Chaos Nova
 * `t0=18,t1=16` · Death and Decay `t0=87,t1=16`. Including them marked 405 of
 * 965 "reaches others" ids true on nothing but a destination slot — enemy AoE
 * like Whirlwind / Rain of Fire / Consecration and even Heroic Leap.
 *
 * Why it shipped: the ground-truth check below only had two classes —
 * ally-castable externals (must be true) and personal defensives (must be
 * false). Neither can catch "an ENEMY spell was marked ally-reaching", because
 * no enemy spell was in either control set. That third class is now
 * MUST_NOT_REACH_ALLY, and it is the reason this file asserts three directions
 * rather than two. Genuinely friendly ground effects delivered by a SUMMON
 * (Spirit Link Totem: the aura lives on the totem, one EffectTriggerSpell hop
 * cannot reach it) are covered by the curated floor in spellTargeting.ts, and
 * the generator prints which ids depend on that floor instead of hiding them.
 */
export const ALLY_IMPLICIT_TARGETS = new Set<string>([
  "21", // UNIT_TARGET_ALLY — Pain Suppression, Ironbark, Life Cocoon, Guardian Spirit, Time Dilation
  "29", // DEST_DYNOBJ_ALLY — Tranquility
  "30", // UNIT_SRC_AREA_ALLY — Tranquility/Divine Hymn (via their triggered spells)
  "31", // UNIT_DEST_AREA_ALLY — Power Word: Barrier, Anti-Magic Zone, Zephyr
  "56", // UNIT_CASTER_AREA_RAID — Rallying Cry, Aura Mastery
  "57", // UNIT_TARGET_ALLY_PARTY — Blessing of Protection / Sacrifice / Spellwarding
  "62", // UNIT_CASTER_AREA_PARTY — Darkness
]);
