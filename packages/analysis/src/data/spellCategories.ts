/**
 * Minimal PvP spell category dataset (a compliant replacement for
 * spells.json -- the original was an upstream file mixed with our own edits,
 * so it is not carried over).
 * Source: publicly known Blizzard game facts (a spell's control type and
 * duration are objective values).
 * Coverage strategy: the mainstream arena CC / root / disarm / immunity sets;
 * a missing entry means that spell simply never enters ccSpellIds and the
 * like, so analysis degrades gracefully; coverage is measured by benchmark
 * batch runs.
 * To be replaced by generated output once subproject 5's data pipeline is
 * built.
 */
export interface ISpellCategoryEntry {
  type:
    | "cc"
    | "roots"
    | "immunities"
    | "buffs_offensive"
    | "buffs_defensive"
    | "buffs_other"
    | "debuffs_offensive"
    | "debuffs_defensive"
    | "debuffs_other"
    | "buffs_speed_boost"
    | "interrupts"
    | "disarms";
  duration?: number;
  priority?: boolean;
  nounitFrames?: boolean;
  nonameplates?: boolean;
}

/**
 * Aura-type-level "cast blocking" predicate (single-source) -- decides
 * whether an aura sitting on a unit prevents it from casting: hard CC ("cc")
 * and silence/interrupt auras ("interrupts", covering Silence / Solar Beam /
 * Spell Lock and other entries that land on the target as
 * SPELL_AURA_APPLIED; pure kicks such as Pummel produce no aura event and so
 * are inherently never misjudged through this predicate). Disarms
 * ("disarms") do not block casting and are not in the set.
 *
 * Consumers: the "dispeller was locked out" exemption in dispelAnalysis, and
 * the free-cast duration of a healing gap in healingGaps.
 * The gate predicate is the spec: both sites must import this predicate and
 * must not each copy the set.
 */
const CAST_BLOCKING_AURA_TYPES: ReadonlySet<ISpellCategoryEntry["type"]> =
  new Set(["cc", "interrupts"]);

export function isCastBlockingAuraType(type: string): boolean {
  return CAST_BLOCKING_AURA_TYPES.has(type as ISpellCategoryEntry["type"]);
}

/**
 * Kick -> school lockout seconds (single-source predicate): SPELL_INTERRUPT
 * has only an event and no aura, so the lockout duration can only come from a
 * table; kicks not found here conservatively use 3s. The interruptInstances
 * in ccTrinketAnalysis and the "dispeller was locked out" gate in
 * dispelAnalysis share this one copy -- writing it twice is exactly the
 * breeding ground for accidents like gate-predicate divergence case 13
 * (negating SPELL_INTERRUPT).
 */
export function kickLockoutSeconds(kickSpellId: string): number {
  return SPELL_CATEGORIES[kickSpellId]?.duration ?? 3;
}

const cc = (duration?: number): ISpellCategoryEntry => ({
  type: "cc",
  duration,
});
const root = (duration?: number): ISpellCategoryEntry => ({
  type: "roots",
  duration,
});

export const SPELL_CATEGORIES: Record<string, ISpellCategoryEntry> = {
  // -- CC (stun / polymorph / fear / blind / imprison etc.) --
  "118": cc(8), // Polymorph
  "28271": cc(8), // Polymorph (Turtle)
  "28272": cc(8), // Polymorph (Pig)
  "51514": cc(8), // Hex
  "5782": cc(6), // Fear
  "5484": cc(6), // Howl of Terror
  "6789": cc(3), // Mortal Coil (DR: Incapacitate)
  "30283": cc(3), // Shadowfury
  "710": cc(6), // Banish
  "6358": cc(6), // Seduction
  "115268": cc(6), // Mesmerize
  "89766": cc(4), // Axe Toss
  "8122": cc(6), // Psychic Scream
  "605": cc(6), // Mind Control
  "9484": cc(6), // Shackle Undead
  "64044": cc(4), // Psychic Horror
  "226943": cc(4), // Mind Bomb
  "2094": cc(6), // Blind
  "6770": cc(6), // Sap
  "1833": cc(4), // Cheap Shot
  "408": cc(6), // Kidney Shot
  "1776": cc(4), // Gouge
  "5211": cc(4), // Mighty Bash
  "99": cc(3), // Incapacitating Roar
  "33786": cc(6), // Cyclone
  "2637": cc(6), // Hibernate
  "853": cc(6), // Hammer of Justice
  "20066": cc(6), // Repentance
  "105421": cc(6), // Blinding Light
  "31661": cc(4), // Dragon's Breath
  "82691": cc(6), // Ring of Frost
  "119381": cc(3), // Leg Sweep
  "115078": cc(4), // Paralysis
  "211881": cc(4), // Fel Eruption
  "217832": cc(6), // Imprison
  "179057": cc(2), // Chaos Nova
  "221562": cc(5), // Asphyxiate
  "108194": cc(4), // Asphyxiate (Unholy)
  "207167": cc(5), // Blinding Sleet
  "3355": cc(8), // Freezing Trap
  "24394": cc(4), // Intimidation
  "117526": cc(3), // Binding Shot
  "213691": cc(3), // Scatter Shot — 3s since its 12.1 PvP-talent return (corpus 2026-08-13: expiry cluster 2.99–3.02s, 50%-DR cluster 1.50s, n=18)
  "46968": cc(2), // Shockwave
  "107570": cc(4), // Storm Bolt
  // -- Cast-id / aura-id mismatch fill-ins (proven on the fuzz-1000
  // thousand-match corpus, 2026-07-19) --
  // The whitelist holds cast ids, but SPELL_AURA_APPLIED records aura ids --
  // the aura-side CC pipeline (ccWindows / DR / coverage manifest) was
  // entirely blind to these spells, and since the coverage gate and the
  // manifest share the same whitelist, this kind of rot can only be found by
  // mining the corpus.
  // Durations are measured from corpus applied->removed (p50-p90, DR
  // included).
  "132168": cc(2), // Shockwave stun aura (4102 hits / 1000 matches; cast id 46968)
  "132169": cc(4), // Storm Bolt stun aura (2895 hits; cast id 107570)
  "118699": cc(6), // Fear aura (1830 hits; cast id 5782)
  "5246": cc(6), // Intimidating Shout (2811 hits; previously absent entirely)
  "360806": cc(6), // Sleep Walk (2035 hits; Evoker main CC, previously absent entirely)
  "163505": cc(4), // Rake stealth stun (928 hits; present in the DR table, absent from cc)
  "372245": cc(3), // Terror of the Skies -- Evoker Deep Breath talent stun (2481 hits, p50=3.0s; found by agy cross-review)
  "20549": cc(2), // War Stomp
  "118905": cc(3), // Static Charge (debuff)
  "192058": cc(3), // Capacitor Totem
  "19386": cc(6), // Wyvern Sting
  "207685": cc(), // Sigil of Misery (disorient debuff aura id; duration is taken from measured log aura applied->removed. Found missing by the audit: DH fear was entirely outside CC coverage)
  // -- Roots --
  "122": root(6), // Frost Nova
  "33395": root(6), // Freeze (Water Elemental)
  "339": root(8), // Entangling Roots
  "102359": root(8), // Mass Entanglement
  "64695": root(6), // Earthgrab Totem
  "1234195": root(3), // Void Nova (Devourer DH -- AoE damage + dispellable magic root, proven on corpus 2026-07-14)
  // -- Disarms --
  "236077": { type: "disarms", duration: 5 }, // Disarm (Warrior)
  "207777": { type: "disarms", duration: 5 }, // Dismantle
  "233759": { type: "disarms", duration: 5 }, // Grapple Weapon
  // -- Immunities --
  "642": { type: "immunities", duration: 8 }, // Divine Shield
  "45438": { type: "immunities", duration: 10 }, // Ice Block
  "186265": { type: "immunities", duration: 8 }, // Aspect of the Turtle
  "196555": { type: "immunities", duration: 5 }, // Netherwalk
  "31224": { type: "immunities", duration: 5 }, // Cloak of Shadows
  "1022": { type: "immunities", duration: 10 }, // Blessing of Protection
  // Added 2026-07-21: of the three Paladin blessings in the missed-cleanse
  // whitelist, only BoP had a category entry; Freedom/Sacrifice were missing
  // -> getPriority fell to Low -> not emitted once across the whole 1245-match
  // corpus. Their dispelType=Magic comes from DB2 mining (authoritative); only
  // the category label was missing.
  "1044": { type: "buffs_defensive", duration: 8 }, // Blessing of Freedom
  "6940": { type: "buffs_defensive", duration: 12 }, // Blessing of Sacrifice
  // Absorb shields (2026-08-12, user ruling: "they really are dispellable, and
  // their priority is moderate"). Both are officially Magic-dispellable, so an
  // offensive purger can strip them; durations come from the official table
  // (spellEffectGenerated), not typed in. buffs_defensive maps to purge
  // priority High — deliberately below the Critical tier that immunities and
  // hard CC occupy, which is what "moderate" means here. They were previously
  // invisible to the missed-purge analysis entirely: Ice Barrier had no
  // category at all (→ priority Low, never a candidate) and Power Word: Shield
  // was not even in the effect table (→ no dispel type, filtered out earlier).
  "17": { type: "buffs_defensive", duration: 15 }, // Power Word: Shield
  "11426": { type: "buffs_defensive", duration: 60 }, // Ice Barrier
  // ── 2026-08-13 可驱散增益补登(官方 DispelType × 120 场语料) ──────────────
  // 背景:能否驱散走官方数据,但**优先级**只认这张表和减伤白名单 —— 两处都没有
  // 就是 Low,永远进不了漏驱散分析。审计发现 72 个「官方可驱散却判 Low」的增益,
  // 下面登记的是其中「敌方交了它、你的击杀窗口就被实质拖住」的一档,统一 High
  // (与护盾同档,低于免疫/硬控的 Critical)。时长取官方表,括号内为语料出现段数
  // (共 342 段)。
  "342246": { type: "buffs_defensive", duration: 10 }, // Alter Time(法师,128 段)——回溯血量,不驱掉等于白打
  "1253593": { type: "buffs_defensive", duration: 15 }, // Void Shield(155 段)——吸收盾
  "406220": { type: "buffs_defensive", duration: 10 }, // Chi Cocoon(武僧,66 段)——吸收盾
  "1260681": { type: "buffs_defensive", duration: 10 }, // Chi Cocoon(另一 id,58 段)
  "457387": { type: "buffs_defensive", duration: 30 }, // Wind Barrier(71 段)——吸收盾
  // Earth Shield:用户裁定「没那么高」(2026-08-13)。官方可驱散(Magic)且需逐个
  // 维持,所以不进常驻团队增益的 blocklist;但它随手就能重上,驱掉的收益远不如
  // 护盾/爆发类,故归 buffs_other(→Medium)—— 登记在案、可被其他消费方看到,
  // 但不进「漏驱散」结论,避免灌爆话题。
  "974": { type: "buffs_other", duration: 600 }, // Earth Shield(萨满,77 段)
  "383648": { type: "buffs_other", duration: 600 }, // Earth Shield(另一 id,56 段)
  "41635": { type: "buffs_defensive", duration: 30 }, // Prayer of Mending(牧师,180 段)——弹射治疗
  "81700": { type: "buffs_offensive", duration: 18 }, // Archangel(戒律,140 段)——治疗量爆发
  "204361": { type: "buffs_offensive", duration: 10 }, // Bloodlust(69 段)——急速爆发
  // Decided 2026-07-22: missed cleanse only takes "discrete active
  // cooldowns", not permanent HoTs/shields (opening it up to permanent auras
  // measured 103 -> 892 rows, 59% of which was Rejuvenation-class noise --
  // see 2026-07-21-evidence-gap-survey §6.5).
  // The 7 entries below are the same class as Power Infusion; ids were
  // reverse-extracted from SPELL_AURA_APPLIED in the EN corpus and reviewed by
  // id against the full zh corpus (83-862 hits / 70 logs); dispelType=Magic
  // comes from DB2.
  // Durations are p50 of applied->removed in the EN corpus; Tip the Scales /
  // Nature's Swiftness have a p50 of only 0.4s (consumed immediately by the
  // next cast), and the 3s "not cleansed" threshold naturally filters out the
  // instantly consumed instances.
  "210256": { type: "buffs_defensive", duration: 5 }, // Blessing of Sanctuary (509 hits)
  "29166": { type: "buffs_defensive", duration: 8 }, // Innervate (183 hits)
  "212295": { type: "buffs_defensive", duration: 3 }, // Nether Ward (607 hits)
  "378441": { type: "buffs_defensive", duration: 4 }, // Time Stop (48 hits)
  "370553": { type: "buffs_defensive", duration: 3 }, // Tip the Scales (969 hits; p90=3.3s)
  "132158": { type: "buffs_defensive", duration: 3 }, // Nature's Swiftness (1257 hits; p90=2.9s)
  "378081": { type: "buffs_defensive", duration: 3 }, // Nature's Swiftness variant id (621 hits -- dual-id rot lesson, take both)
  "79206": { type: "buffs_defensive", duration: 16 }, // Spiritwalker's Grace (705 hits)
  // -- Offensive buffs (consumed by spellDanger / isOffensiveSpell) --
  "12472": { type: "buffs_offensive", duration: 25 }, // Icy Veins
  "19574": { type: "buffs_offensive", duration: 15 }, // Bestial Wrath
  "1719": { type: "buffs_offensive", duration: 16 }, // Recklessness
  "13750": { type: "buffs_offensive", duration: 20 }, // Adrenaline Rush
  "121471": { type: "buffs_offensive", duration: 20 }, // Shadow Blades
  "190319": { type: "buffs_offensive", duration: 10 }, // Combustion
  "365350": { type: "buffs_offensive", duration: 15 }, // Arcane Surge
  "107574": { type: "buffs_offensive", duration: 20 }, // Avatar
  "10060": { type: "buffs_offensive", duration: 20 }, // Power Infusion
  "375087": { type: "buffs_offensive", duration: 18 }, // Dragonrage
  "51271": { type: "buffs_offensive", duration: 12 }, // Pillar of Frost
  "31884": { type: "buffs_offensive", duration: 20 }, // Avenging Wrath
  "288613": { type: "buffs_offensive", duration: 15 }, // Trueshot
  // Added by the 2026-07-14 full-corpus audit: 21% of the corpus had zero
  // [ENEMY CD] for the entire match -- the major burst cooldowns below had no
  // category, so isOffensiveSpell returned false and enemyCDs silently
  // dropped them (mostly DH / Rogue / Warlock / Elemental / Survival Hunter).
  "370965": { type: "debuffs_offensive", duration: 6 }, // The Hunt
  "258925": { type: "buffs_offensive", duration: 3 }, // Fel Barrage
  "185313": { type: "buffs_offensive", duration: 8 }, // Shadow Dance
  "360194": { type: "debuffs_offensive", duration: 16 }, // Deathmark
  "205180": { type: "buffs_offensive", duration: 20 }, // Summon Darkglare
  "386997": { type: "debuffs_offensive", duration: 8 }, // Soul Rot
  "191634": { type: "buffs_offensive", duration: 15 }, // Ascendance (Elemental)
  "360952": { type: "buffs_offensive", duration: 20 }, // Coordinated Assault
  // 2026-07-17 per-spec sweep: for specs with a 100% none-tracked rate (Frost
  // Mage 210/210, Windwalker 129/129) and other high-gap specs, the actual
  // 12.x burst buttons were filled in from corpus SPELL_CAST_SUCCESS evidence.
  // Frost Mage in 12.x no longer casts Icy Veins (reworked into a passive);
  // the two below are the real pressure cooldowns.
  // Most of Retribution's gap is Radiant Glory passively triggering Avenging
  // Wrath (no cast event), which a cast-based tracker cannot follow -- that is
  // expected.
  "84714": { type: "debuffs_offensive", duration: 15 }, // Frozen Orb (Frost Mage, 60s)
  "205021": { type: "debuffs_offensive", duration: 4 }, // Ray of Frost (Frost Mage, 60s charge)
  "392983": { type: "debuffs_offensive", duration: 6 }, // Strike of the Windlord (Windwalker, 35s)
  "1233448": { type: "buffs_offensive", duration: 15 }, // Dark Transformation (Unholy DK 12.x variant id, 45s)
  "42650": { type: "buffs_offensive", duration: 30 }, // Army of the Dead (Unholy DK, 90s)
  "102560": { type: "buffs_offensive", duration: 30 }, // Incarnation: Chosen of Elune (Balance Druid, 180s)
  "194223": { type: "buffs_offensive", duration: 20 }, // Celestial Alignment (Balance Druid, 180s)
  "102543": { type: "buffs_offensive", duration: 20 }, // Incarnation: Avatar of Ashamane (Feral Druid, 180s)
  "106951": { type: "buffs_offensive", duration: 20 }, // Berserk (Feral Druid, 180s)
  "274837": { type: "debuffs_offensive", duration: 6 }, // Feral Frenzy (Feral Druid, 45s)
  "114051": { type: "buffs_offensive", duration: 15 }, // Ascendance (Enhancement, 180s)
  // Note on Enhancement's Doom Winds: activating it in 12.x produces no
  // standalone SPELL_CAST_SUCCESS (469270 is the per-attack proc cast, median
  // interval 1s), so a cast-based tracker cannot follow it -- the remaining
  // none-tracked share is expected.
  "466772": { type: "buffs_offensive", duration: 8 }, // Doom Winds buff id (aura only, for spellDanger)
  "1122": { type: "buffs_offensive", duration: 30 }, // Summon Infernal (Destruction, 120s; cast id, 111685 is the aura id)
  "6353": { type: "debuffs_offensive", duration: 0 }, // Soul Fire (Destruction, 45s nuke)
  "442726": { type: "buffs_offensive", duration: 20 }, // Malevolence (Destruction hero talent, 60s -- measured on corpus)
  "1261193": { type: "debuffs_offensive", duration: 0 }, // Boomstick (Survival Hunter 12.x, 60s charge)
  "1250646": { type: "debuffs_offensive", duration: 0 }, // Takedown (Survival Hunter 12.x, 90s)
  // Devourer Demon Hunter (new 12.1 spec) -- extracted from audit corpus
  // evidence (2026-07-14): cast frequency and event behaviour come from 123
  // real matches; durations are taken from the DB2 mining layer.
  "1241937": { type: "buffs_offensive", duration: 5 }, // Soul Immolation (main burst, 60s charge)
  "1246167": { type: "debuffs_offensive", duration: 2 }, // The Hunt (Devourer variant id)
  // -- Interrupts --
  "1766": { type: "interrupts" },
  "2139": { type: "interrupts" },
  "6552": { type: "interrupts" },
  "47528": { type: "interrupts" },
  "57994": { type: "interrupts" },
  "96231": { type: "interrupts" },
  "106839": { type: "interrupts" },
  "116705": { type: "interrupts" },
  "147362": { type: "interrupts" },
  "187707": { type: "interrupts" },
  "183752": { type: "interrupts" },
  "119910": { type: "interrupts" },
  "132409": { type: "interrupts" },
  "351338": { type: "interrupts" },
  "15487": { type: "interrupts" },
  "78675": { type: "interrupts" },
  // Added 2026-07-17 from corpus evidence (present in SPELL_INTERRUPT events
  // but previously absent from the list):
  "19647": { type: "interrupts" }, // Spell Lock (Warlock Felhunter, 476 hits in the corpus!)
  "93985": { type: "interrupts" }, // Skull Bash (Druid, 346 hits)
  "97547": { type: "interrupts" }, // Solar Beam interrupt component id (78675 is the cast id)
  "347008": { type: "interrupts" }, // Axe Toss variant (46 hits)
  "91807": { type: "interrupts" }, // Shambling Rush (DK ghoul, 25 hits)
  "217824": { type: "interrupts" }, // Shield of Virtue (Protection Paladin PvP talent)
  "31935": { type: "interrupts" }, // Avenger's Shield
  // -- Speed boosts --
  "2983": { type: "buffs_speed_boost", duration: 8 }, // Sprint
  "1850": { type: "buffs_speed_boost", duration: 10 }, // Dash
  "116841": { type: "buffs_speed_boost", duration: 6 }, // Tiger's Lust
  // -- Offensive debuffs --
  "702": { type: "debuffs_offensive" }, // Curse of Weakness
  "1714": { type: "debuffs_offensive" }, // Curse of Tongues
  "12654": { type: "debuffs_offensive" }, // Ignite
};
